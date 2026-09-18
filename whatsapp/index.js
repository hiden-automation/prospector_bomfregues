require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegStatic);

const API_KEY = process.env.API_KEY;
const PORT = process.env.PORT || 3000;

// Configuração das duas instâncias de Orquestrador / Cadências
const ORCHESTRATOR_6000_URL = process.env.ORCHESTRATOR_6000_URL || 'http://localhost:6000';
const ORCHESTRATOR_4000_URL = process.env.ORCHESTRATOR_4000_URL || 'http://localhost:4000';

// WhatsApp Cloud API
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const WA_WEBHOOK_VERIFY_TOKEN = process.env.WA_WEBHOOK_VERIFY_TOKEN;
const WA_TEMPLATE_LANG = process.env.WA_TEMPLATE_LANG || 'pt_BR';
const pendingDispatches = new Map();

// Segurança do Painel & Notificações OneSignal
const DASHBOARD_ACCESS_TOKEN = process.env.DASHBOARD_ACCESS_TOKEN || 'admin_secreto_123';
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;

const CONVERSATIONS_FILE = path.join(__dirname, 'conversations.json');
const MEDIA_DIR = path.join(__dirname, 'public', 'media');

if (!fs.existsSync(CONVERSATIONS_FILE)) {
  fs.writeFileSync(CONVERSATIONS_FILE, '{}', 'utf8');
}

if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

if (!API_KEY || !WA_PHONE_NUMBER_ID || !WA_ACCESS_TOKEN) {
  console.error('❌ Variáveis de ambiente obrigatórias não configuradas no .env');
  process.exit(1);
}

// ─── ROTEAMENTO DINÂMICO DE CADÊNCIAS ──────────────────────────────────
const CADENCE_6000_TEMPLATES = ['fidelidade_m1', 'fidelidade_m2', 'lavacar_m1', 'lavacar_m2'];
const CADENCE_4000_TEMPLATES = ['primeiro_contato', 'segundo_contato'];

function resolveCadenceFromTemplate(templateName) {
  if (!templateName) return null;
  const name = templateName.trim().toLowerCase();
  if (CADENCE_6000_TEMPLATES.includes(name)) return '6000';
  if (CADENCE_4000_TEMPLATES.includes(name)) return '4000';
  return null;
}

function getOrchestratorUrlByCadence(cadence) {
  return cadence === '6000' ? ORCHESTRATOR_6000_URL : ORCHESTRATOR_4000_URL;
}

// ─── FILA ATÔMICA PARA ARQUIVO JSON (ANTI RACE-CONDITION) ──────────────
let fileQueue = Promise.resolve();

function loadConversations() {
  try {
    return JSON.parse(fs.readFileSync(CONVERSATIONS_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function safeAtomicUpdate(updaterFn) {
  return new Promise((resolve, reject) => {
    fileQueue = fileQueue.then(async () => {
      try {
        let currentData = {};
        try {
          const content = await fs.promises.readFile(CONVERSATIONS_FILE, 'utf8');
          currentData = JSON.parse(content);
        } catch (err) {
          currentData = {};
        }

        const result = updaterFn(currentData);
        await fs.promises.writeFile(CONVERSATIONS_FILE, JSON.stringify(currentData, null, 2), 'utf8');
        resolve(result);
      } catch (err) {
        console.error('❌ Erro na fila de escrita atômica do JSON:', err.message);
        reject(err);
      }
    });
  });
}

// 🔄 Sincronizador inteligente com fallback automático (4000 ➔ 6000)
async function syncWithOrchestrator(phone, endpoint, payload, knownCadence = null) {
  const cleanPhone = phone.replace(/\D/g, '');

  if (knownCadence) {
    const targetUrl = getOrchestratorUrlByCadence(knownCadence);
    try {
      const res = await axios.post(`${targetUrl}${endpoint}`, payload, {
        headers: { 'x-api-key': API_KEY },
        timeout: 5000
      });
      return { success: true, cadence: knownCadence, data: res.data };
    } catch (err) {
      console.warn(`⚠️ Falha ao sincronizar com ${targetUrl}${endpoint} (${cleanPhone}):`, err.response?.data?.error || err.message);
      return { success: false, error: err };
    }
  }

  // Se não tem cadence gravada, tenta 4000 primeiro
  try {
    const res4000 = await axios.post(`${ORCHESTRATOR_4000_URL}${endpoint}`, payload, {
      headers: { 'x-api-key': API_KEY },
      timeout: 5000
    });
    console.log(`📡 Sincronizado com fallback na 4000: ${cleanPhone} → ${endpoint}`);

    // Persiste que o contato pertence à 4000 para as próximas chamadas
    await safeAtomicUpdate((data) => {
      if (data[cleanPhone]) data[cleanPhone].cadence = '4000';
    });

    return { success: true, cadence: '4000', data: res4000.data };
  } catch (err4000) {
    const is404 = err4000.response?.status === 404;

    if (is404) {
      console.log(`⚠️ Contato ${cleanPhone} não encontrado na 4000 (404). Tentando fallback na porta 6000...`);
      try {
        const res6000 = await axios.post(`${ORCHESTRATOR_6000_URL}${endpoint}`, payload, {
          headers: { 'x-api-key': API_KEY },
          timeout: 5000
        });
        console.log(`✅ Sucesso na recuperação via fallback na 6000: ${cleanPhone} → ${endpoint}`);

        // Persiste que o contato pertence à 6000
        await safeAtomicUpdate((data) => {
          if (data[cleanPhone]) data[cleanPhone].cadence = '6000';
        });

        return { success: true, cadence: '6000', data: res6000.data };
      } catch (err6000) {
        console.warn(`❌ Falha dupla no sincronismo de ${cleanPhone} (nem 4000 nem 6000):`, err6000.response?.data?.error || err6000.message);
        return { success: false, error: err6000 };
      }
    }

    console.warn(`⚠️ Falha ao tentar 4000 para ${cleanPhone} (não foi 404):`, err4000.response?.data?.error || err4000.message);
    return { success: false, error: err4000 };
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MEDIA_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `upload_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

const MIME_MAP = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt'
};

function convertVideoForWhatsApp(inputPath) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(MEDIA_DIR, `converted_${Date.now()}.mp4`);
    console.log(`🔄 Transcodificando vídeo para H.264/AAC: ${path.basename(inputPath)}...`);

    ffmpeg(inputPath)
      .outputOptions([
        '-c:v libx264',
        '-profile:v main',
        '-level 3.1',
        '-pix_fmt yuv420p',
        '-c:a aac',
        '-b:a 128k',
        '-movflags +faststart'
      ])
      .toFormat('mp4')
      .on('end', () => {
        console.log(`✅ Vídeo transcodificado com sucesso: ${path.basename(outputPath)}`);
        try { fs.unlinkSync(inputPath); } catch (e) {}
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error('❌ Erro na transcodificação do vídeo:', err.message);
        reject(err);
      })
      .save(outputPath);
  });
}

async function downloadWhatsAppMedia(mediaId, originalFilename = null) {
  try {
    const metaRes = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` },
      timeout: 10000
    });

    const { url: mediaUrl, mime_type: mimeType } = metaRes.data;
    const cleanMime = (mimeType || '').split(';')[0].trim().toLowerCase();
    const ext = MIME_MAP[cleanMime] || cleanMime.split('/')[1] || 'bin';

    const fileRes = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` },
      responseType: 'arraybuffer',
      timeout: 30000
    });

    const fileName = `media_${mediaId}_${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(MEDIA_DIR, fileName), Buffer.from(fileRes.data));

    return {
      mediaUrl: `/media/${fileName}`,
      mediaMime: cleanMime,
      mediaFileName: originalFilename || fileName
    };
  } catch (err) {
    console.error(`❌ Falha no download da mídia ${mediaId}:`, err.message);
    return null;
  }
}

async function uploadMediaToMeta(filePath, mimeType, filename) {
  const fileData = fs.readFileSync(filePath);
  const ext = path.extname(filename || '').toLowerCase();
  const cleanMime = (mimeType || '').split(';')[0].trim().toLowerCase();

  let mediaType = 'document';
  let finalMime = 'application/pdf';

  if (cleanMime.startsWith('image/') || ['.jpg', '.jpeg', '.png'].includes(ext)) {
    mediaType = 'image';
    finalMime = (cleanMime === 'image/png' || ext === '.png') ? 'image/png' : 'image/jpeg';
  } else if (cleanMime.startsWith('video/') || ['.mp4', '.mov', '.avi', '.mkv', '.3gp'].includes(ext)) {
    mediaType = 'video';
    finalMime = 'video/mp4';
  } else {
    mediaType = 'document';
    finalMime = cleanMime || 'application/pdf';
  }

  const blob = new Blob([fileData], { type: finalMime });
  const formData = new FormData();
  formData.append('messaging_product', 'whatsapp');
  formData.append('file', blob, path.basename(filePath));
  formData.append('type', finalMime);

  const res = await axios.post(
    `https://graph.facebook.com/v21.0/${WA_PHONE_NUMBER_ID}/media`,
    formData,
    {
      headers: {
        Authorization: `Bearer ${WA_ACCESS_TOKEN}`
      },
      timeout: 60000
    }
  );

  return { 
    mediaId: res.data.id, 
    mediaType, 
    mimeType: finalMime 
  };
}

async function recordMessage(phone, { sender, text, messageId = null, title = null, status = 'sent', mediaUrl = null, mediaMime = null, mediaFileName = null, cadence = null }) {
  const cleanPhone = phone.replace(/\D/g, '');

  return await safeAtomicUpdate((data) => {
    if (!data[cleanPhone]) {
      data[cleanPhone] = {
        phone: cleanPhone,
        chatTitle: title || cleanPhone,
        stage: 'iniciado',
        cadence: cadence || null,
        unread: 0,
        updatedAt: new Date().toISOString(),
        messages: []
      };
    }

    if (cadence) {
      data[cleanPhone].cadence = cadence;
    }

    if (title) {
      data[cleanPhone].chatTitle = title;
    }

    if (sender === 'user') {
      const normalizedText = (text || '').trim().toLowerCase();
      const isLostTrigger = normalizedText === 'não tenho interesse' || normalizedText === 'nao tenho interesse' || normalizedText === 'pode encerrar';

      if (isLostTrigger) {
        data[cleanPhone].stage = 'perdido';
        data[cleanPhone].discarded = true;
        data[cleanPhone].closed = false;
      } else {
        data[cleanPhone].stage = 'interagindo';
        data[cleanPhone].discarded = false;
        data[cleanPhone].closed = false;
      }
    }

    const msgObj = {
      id: messageId || `local_${Date.now()}`,
      sender,
      text: text || '',
      status,
      mediaUrl,
      mediaMime,
      mediaFileName,
      timestamp: new Date().toISOString()
    };

    data[cleanPhone].messages.push(msgObj);
    data[cleanPhone].updatedAt = msgObj.timestamp;

    if (sender === 'user') {
      data[cleanPhone].unread = (data[cleanPhone].unread || 0) + 1;
    }

    return { phone: cleanPhone, message: msgObj, conversation: data[cleanPhone] };
  });
}

async function updateMessageStatus(messageId, status, errorReason = null) {
  return await safeAtomicUpdate((data) => {
    for (const phone in data) {
      const msg = data[phone].messages.find(m => m.id === messageId);
      if (msg) {
        msg.status = status;
        if (errorReason) msg.error = errorReason;
        return { phone, message: msg, cadence: data[phone].cadence || null };
      }
    }
    return null;
  });
}

async function sendPushNotification(title, message) {
  if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) return;

  try {
    await axios.post(
      'https://onesignal.com/api/v1/notifications',
      {
        app_id: ONESIGNAL_APP_ID,
        included_segments: ['All'],
        headings: { en: title, pt: title },
        contents: { en: message, pt: message },
        url: `/chat`
      },
      {
        headers: {
          Authorization: `Basic ${ONESIGNAL_REST_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 8000
      }
    );
  } catch (err) {
    console.error('❌ Falha ao disparar OneSignal Push:', err.response?.data || err.message);
  }
}

async function sendMessage({ phone, text, templateName, templateParams = [] }) {
  const cleanPhone = phone.replace(/\D/g, '');
  console.log(`📤 Enviando mensagem oficial para ${cleanPhone}...`);

  let payload;

  if (templateName) {
    payload = {
      messaging_product: 'whatsapp',
      to: cleanPhone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: WA_TEMPLATE_LANG }
      }
    };

    if (Array.isArray(templateParams) && templateParams.length > 0) {
      payload.template.components = [
        {
          type: 'body',
          parameters: templateParams.map((val) => ({
            type: 'text',
            text: String(val !== undefined && val !== null ? val : ' ')
          }))
        }
      ];
    }
  } else {
    payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'text',
      text: { body: text }
    };
  }

  const detectedCadence = resolveCadenceFromTemplate(templateName);

  try {
    const res = await axios.post(
      `https://graph.facebook.com/v21.0/${WA_PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const messageId = res.data.messages?.[0]?.id;
    console.log(`✅ Sucesso no envio para ${cleanPhone} (ID: ${messageId})`);

    const chatTitle = (Array.isArray(templateParams) && templateParams.length > 0) ? templateParams[0] : null;

    const recorded = await recordMessage(cleanPhone, {
      sender: 'agent',
      text: templateName ? `[Template: ${templateName}]` : text,
      title: chatTitle,
      messageId,
      status: 'sent',
      cadence: detectedCadence
    });

    if (io) {
      io.emit('new_message', recorded);
    }

    return { success: true, messageId, message: recorded.message };
  } catch (err) {
    const errData = err.response?.data?.error;
    const errorMsg = errData?.message || err.message;

    const chatTitle = (Array.isArray(templateParams) && templateParams.length > 0) ? templateParams[0] : null;

    const recorded = await recordMessage(cleanPhone, {
      sender: 'agent',
      text: templateName ? `[Template: ${templateName}]` : text,
      title: chatTitle,
      status: 'failed',
      cadence: detectedCadence
    });

    if (io) {
      io.emit('new_message', recorded);
    }

    throw new Error(errorMsg);
  }
}

async function sendMediaMessage({ phone, mediaId, mediaType, mimeType, filename, localUrl }) {
  const cleanPhone = phone.replace(/\D/g, '');
  const type = mediaType || 'document';

  const mediaPayload = { id: mediaId };
  if (type === 'document' && filename) {
    mediaPayload.filename = filename;
  }

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanPhone,
    type,
    [type]: mediaPayload
  };

  try {
    const res = await axios.post(
      `https://graph.facebook.com/v21.0/${WA_PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 25000
      }
    );

    const messageId = res.data.messages?.[0]?.id;
    console.log(`✅ Sucesso no envio de ${type} para ${cleanPhone} (ID: ${messageId})`);

    const recorded = await recordMessage(cleanPhone, {
      sender: 'agent',
      text: '',
      messageId,
      status: 'sent',
      mediaUrl: localUrl,
      mediaMime: mimeType,
      mediaFileName: filename
    });

    if (io) {
      io.emit('new_message', recorded);
    }

    return { success: true, messageId, message: recorded.message };
  } catch (err) {
    const errData = err.response?.data?.error;
    const errorMsg = errData?.message || err.message;
    console.error(`❌ Erro no envio de mídia para ${cleanPhone}:`, errorMsg);

    const recorded = await recordMessage(cleanPhone, {
      sender: 'agent',
      text: '',
      status: 'failed',
      mediaUrl: localUrl,
      mediaMime: mimeType,
      mediaFileName: filename
    });

    if (io) {
      io.emit('new_message', recorded);
    }

    throw new Error(errorMsg);
  }
}

// ─── SERVIDOR EXPRESS + COOKIES + SOCKET.IO ─────────────────────────────
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function checkAuthCookie(req, res, next) {
  const sessionToken = req.cookies?.auth_session || req.headers['x-auth-token'] || req.query.auth_token;
  if (sessionToken === DASHBOARD_ACCESS_TOKEN) {
    return next();
  }
  if (req.accepts('html')) {
    return res.redirect('/login');
  }
  return res.status(401).json({ error: 'Não autorizado.' });
}

app.post('/api/auth/login', (req, res) => {
  const { token } = req.body;
  if (token === DASHBOARD_ACCESS_TOKEN) {
    res.cookie('auth_session', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 365 * 24 * 60 * 60 * 1000
    });
    return res.json({ success: true, token });
  }
  return res.status(401).json({ error: 'Chave incorreta' });
});

app.get('/logout', (req, res) => {
  res.clearCookie('auth_session', { path: '/' });
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Login - Atendimento</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f2f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 90%; max-width: 360px; text-align: center; }
        h2 { margin-bottom: 20px; color: #111b21; }
        input { width: 100%; padding: 12px; margin-bottom: 15px; border: 1px solid #ddd; border-radius: 8px; box-sizing: border-box; font-size: 1rem; }
        button { width: 100%; padding: 12px; background: #00a884; color: white; border: none; border-radius: 8px; font-weight: bold; font-size: 1rem; cursor: pointer; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>🔒 Acesso ao Painel</h2>
        <form id="loginForm">
          <input type="password" id="pass" placeholder="Chave de acesso" required autofocus />
          <button type="submit">Entrar</button>
        </form>
      </div>
      <script>
        const savedToken = localStorage.getItem('pwa_auth_token');
        if (savedToken) {
          fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: savedToken })
          }).then(res => {
            if (res.ok) window.location.href = '/chat';
          });
        }

        document.getElementById('loginForm').onsubmit = async (e) => {
          e.preventDefault();
          const pass = document.getElementById('pass').value;
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: pass })
          });
          if (res.ok) {
            localStorage.setItem('pwa_auth_token', pass);
            window.location.href = '/chat';
          } else {
            alert('Chave incorreta');
          }
        };
      </script>
    </body>
    </html>
  `);
});

app.get('/chat', checkAuthCookie, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/chat/conversations', checkAuthCookie, (req, res) => {
  const data = loadConversations();
  const list = Object.values(data).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(list);
});

app.get('/api/chat/conversations/:phone', checkAuthCookie, async (req, res) => {
  const cleanPhone = req.params.phone.replace(/\D/g, '');

  const conv = await safeAtomicUpdate((data) => {
    const target = data[cleanPhone];
    if (target) {
      target.unread = 0;
    }
    return target || null;
  });

  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });
  res.json(conv);
});

app.post('/api/chat/send', checkAuthCookie, async (req, res) => {
  const { phone, text } = req.body;
  if (!phone || !text) return res.status(400).json({ error: 'Dados obrigatórios ausentes' });

  try {
    const result = await sendMessage({ phone, text });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reabertura respeitando a cadência atual (se indefinido, tenta deduzir ou usa segundo_contato)
app.post('/api/chat/send-third-template', checkAuthCookie, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });

  const cleanPhone = phone.replace(/\D/g, '');
  const data = loadConversations();
  const conv = data[cleanPhone];
  
  // Se não tem cadence, checa se há vestígios de template da 6000 no histórico
  let cadence = conv?.cadence;
  if (!cadence) {
    const has6000 = conv?.messages?.some(m => m.text && (m.text.includes('lavacar') || m.text.includes('fidelidade')));
    cadence = has6000 ? '6000' : '4000';
  }

  const chosenTemplate = cadence === '6000' ? 'lavacar_m2' : 'segundo_contato';

  try {
    const result = await sendMessage({
      phone: cleanPhone,
      templateName: chosenTemplate,
      templateParams: []
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat/send-media', checkAuthCookie, upload.single('file'), async (req, res) => {
  const { phone } = req.body;
  const file = req.file;

  if (!phone || !file) {
    return res.status(400).json({ error: 'Telefone e arquivo são obrigatórios' });
  }

  let finalFilePath = file.path;
  let finalMimeType = file.mimetype;
  let finalOriginalName = file.originalname;

  const ext = path.extname(file.originalname || '').toLowerCase();
  const isVideo = file.mimetype.startsWith('video/') || ['.mp4', '.mov', '.avi', '.mkv', '.3gp'].includes(ext);

  try {
    if (isVideo) {
      finalFilePath = await convertVideoForWhatsApp(file.path);
      finalMimeType = 'video/mp4';
      finalOriginalName = 'video.mp4';
    }

    const localUrl = `/media/${path.basename(finalFilePath)}`;
    const { mediaId, mediaType, mimeType } = await uploadMediaToMeta(finalFilePath, finalMimeType, finalOriginalName);

    const result = await sendMediaMessage({
      phone,
      mediaId,
      mediaType,
      mimeType,
      filename: finalOriginalName,
      localUrl
    });

    res.json(result);
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    console.error('❌ Erro no endpoint /api/chat/send-media:', errorMsg);
    res.status(500).json({ error: errorMsg });
  }
});

// 🔄 Alterar Estágio via Dropdown com Fallback Automático
app.post('/api/chat/conversations/:phone/stage', checkAuthCookie, async (req, res) => {
  const cleanPhone = req.params.phone.replace(/\D/g, '');
  const { stage } = req.body;
  const normalizedStage = (stage || '').toLowerCase().trim();

  const conv = await safeAtomicUpdate((data) => {
    const target = data[cleanPhone];
    if (!target) return null;

    target.stage = normalizedStage;
    target.closed = (normalizedStage === 'ganho');
    target.discarded = (normalizedStage === 'perdido' || normalizedStage === 'descartado' || normalizedStage === 'descartados');
    return target;
  });

  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });

  if (io) {
    io.emit('conversation_updated', conv);
  }

  let orchestratorStatus = null;
  if (normalizedStage === 'iniciado') {
    orchestratorStatus = 2;
  } else if (normalizedStage === 'interagindo') {
    orchestratorStatus = 3;
  } else if (normalizedStage === 'congelado' || normalizedStage === 'frio') {
    orchestratorStatus = 5;
  } else if (normalizedStage === 'ganho') {
    orchestratorStatus = 6;
  } else if (normalizedStage === 'perdido') {
    orchestratorStatus = 7;
  } else if (normalizedStage === 'descartado' || normalizedStage === 'descartados') {
    orchestratorStatus = 8;
  }

  if (orchestratorStatus !== null) {
    // Sincroniza via fallback (tenta cadência salva ou 4000 ➔ 6000)
    await syncWithOrchestrator(
      cleanPhone,
      '/contacts/status',
      { phone: cleanPhone, status: orchestratorStatus },
      conv.cadence
    );
  }

  res.json({ success: true, phone: cleanPhone, stage: normalizedStage, status: orchestratorStatus });
});

// ─── WEBHOOK DA META (RECEBIMENTO E STATUS) ─────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === WA_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  return res.sendStatus(403);
});

// Endpoint disparado pelos orquestradores (porta 4000 ou 6000)
app.post('/send', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { phone, templateName, templateParams, text } = req.body;
  if (!phone) {
    return res.status(400).json({ error: 'phone é obrigatório' });
  }

  try {
    const result = await sendMessage({ phone, text, templateName, templateParams });
    const messageId = result.messageId;

    const deliveryConfirmation = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingDispatches.delete(messageId);
        resolve({ delivered: true });
      }, 6000);

      pendingDispatches.set(messageId, (status, reason) => {
        clearTimeout(timer);
        pendingDispatches.delete(messageId);
        if (status === 'failed') {
          resolve({ delivered: false, reason });
        } else {
          resolve({ delivered: true });
        }
      });
    });

    if (!deliveryConfirmation.delivered) {
      return res.status(422).json({ 
        error: `Meta rejeitou o envio: ${deliveryConfirmation.reason}` 
      });
    }

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const entry = req.body?.entry?.[0];
  const change = entry?.changes?.[0]?.value;

  if (change?.messages && change.messages.length > 0) {
    for (const msg of change.messages) {
      const fromNumber = msg.from;
      const contactInfo = change.contacts?.find((c) => c.wa_id === fromNumber);
      const profileName = contactInfo?.profile?.name || null;

      let incomingText = '';
      let mediaData = null;

      if (msg.type === 'text') {
        incomingText = msg.text?.body || '';
      } else if (msg.type === 'button') {
        incomingText = msg.button?.text || '[Botão clicado]';
      } else if (msg.type === 'interactive') {
        if (msg.interactive?.type === 'button_reply') {
          incomingText = msg.interactive.button_reply?.title || '[Botão clicado]';
        } else if (msg.interactive?.type === 'list_reply') {
          incomingText = msg.interactive.list_reply?.title || '[Opção selecionada]';
        }
      } else if (['audio', 'image', 'video', 'document'].includes(msg.type)) {
        const mediaObj = msg[msg.type];
        const originalName = mediaObj.filename || null;
        incomingText = mediaObj.caption || '';
        
        mediaData = await downloadWhatsAppMedia(mediaObj.id, originalName);
      } else {
        incomingText = '';
      }

      const recorded = await recordMessage(fromNumber, {
        sender: 'user',
        text: incomingText,
        messageId: msg.id,
        title: profileName,
        mediaUrl: mediaData?.mediaUrl || null,
        mediaMime: mediaData?.mediaMime || null,
        mediaFileName: mediaData?.mediaFileName || null
      });

      io.emit('new_message', recorded);

      const pushBody = incomingText || (mediaData ? 'Novo arquivo recebido' : 'Nova mensagem');
      await sendPushNotification(`WhatsApp: ${profileName || fromNumber}`, pushBody);

      const knownCadence = recorded.conversation?.cadence || null;
      const normalizedIncoming = incomingText.trim().toLowerCase();
      const isLostTrigger = normalizedIncoming === 'não tenho interesse' || normalizedIncoming === 'nao tenho interesse' || normalizedIncoming === 'pode encerrar';

      if (isLostTrigger) {
        await syncWithOrchestrator(
          fromNumber,
          '/contacts/status',
          { phone: fromNumber, status: 7 },
          knownCadence
        );
      } else {
        await syncWithOrchestrator(
          fromNumber,
          '/contacts/responded',
          { phone: fromNumber, message: incomingText },
          knownCadence
        );
      }
    }
  }

  if (change?.statuses && change.statuses.length > 0) {
    for (const st of change.statuses) {
      const msgId = st.id;
      const status = st.status;
      const recipient = st.recipient_id;

      if (pendingDispatches.has(msgId)) {
        const notifyPending = pendingDispatches.get(msgId);
        const reason = st.errors?.[0]?.message || st.errors?.[0]?.title || null;
        notifyPending(status, reason);
      }

      if (status === 'failed') {
        const errDetails = st.errors?.[0];
        const reason = errDetails?.title || errDetails?.message || 'Erro desconhecido na entrega';
        console.warn(`❌ Mensagem ${msgId} para ${recipient} FALHOU: ${reason}`);

        const updated = await updateMessageStatus(msgId, 'failed', reason);
        if (updated && io) {
          io.emit('message_status_update', { 
            messageId: msgId, 
            phone: recipient, 
            status: 'failed', 
            error: reason 
          });
        }

        await syncWithOrchestrator(
          recipient,
          '/contacts/invalid',
          { phone: recipient },
          updated?.cadence || null
        );
      } else {
        const updated = await updateMessageStatus(msgId, status);
        if (updated && io) {
          io.emit('message_status_update', { 
            messageId: msgId, 
            phone: recipient, 
            status: status 
          });
        }
      }
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Servidor rodando na porta ${PORT}`);
  console.log(`🔒 Fila atômica ativada para ${path.basename(CONVERSATIONS_FILE)}`);
  console.log(`🔗 Roteamento 6000: ${ORCHESTRATOR_6000_URL} (fidelidade_m1, fidelidade_m2, lavacar_m1, lavacar_m2)`);
  console.log(`🔗 Roteamento 4000: ${ORCHESTRATOR_4000_URL} (primeiro_contato, segundo_contato)`);
  console.log(`🔄 Modo Fallback Ativo: tentará 4000 e, se retornar 404, sincronizará com a 6000 e salvará a cadência.`);
});