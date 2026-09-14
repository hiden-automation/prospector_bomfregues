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
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:4000';
const PORT = process.env.PORT || 3000;

// WhatsApp Cloud API
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const WA_WEBHOOK_VERIFY_TOKEN = process.env.WA_WEBHOOK_VERIFY_TOKEN;
const WA_TEMPLATE_LANG = process.env.WA_TEMPLATE_LANG || 'pt_BR';
const WA_TEMPLATE_THIRD_CONTACT = process.env.WA_TEMPLATE_THIRD_CONTACT || 'segundo_contato';
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

function loadConversations() {
  try {
    return JSON.parse(fs.readFileSync(CONVERSATIONS_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveConversations(data) {
  try {
    fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('❌ Falha ao gravar conversas:', e.message);
  }
}

function recordMessage(phone, { sender, text, messageId = null, title = null, status = 'sent', mediaUrl = null, mediaMime = null, mediaFileName = null }) {
  const cleanPhone = phone.replace(/\D/g, '');
  const data = loadConversations();

  if (!data[cleanPhone]) {
    data[cleanPhone] = {
      phone: cleanPhone,
      chatTitle: title || cleanPhone,
      stage: 'iniciado',
      unread: 0,
      updatedAt: new Date().toISOString(),
      messages: []
    };
  }

  if (title) {
    data[cleanPhone].chatTitle = title;
  }

  if (sender === 'user') {
    data[cleanPhone].stage = 'interagindo';
    data[cleanPhone].discarded = false;
    data[cleanPhone].closed = false;
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

  saveConversations(data);
  return { phone: cleanPhone, message: msgObj, conversation: data[cleanPhone] };
}

function updateMessageStatus(messageId, status, errorReason = null) {
  const data = loadConversations();
  for (const phone in data) {
    const msg = data[phone].messages.find(m => m.id === messageId);
    if (msg) {
      msg.status = status;
      if (errorReason) msg.error = errorReason;
      saveConversations(data);
      return { phone, message: msg };
    }
  }
  return null;
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
            text: String(val || ' ')
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

    const recorded = recordMessage(cleanPhone, {
      sender: 'agent',
      text: templateName ? `[Template: ${templateName}]` : text,
      messageId,
      status: 'sent'
    });

    if (io) {
      io.emit('new_message', recorded);
    }

    return { success: true, messageId, message: recorded.message };
  } catch (err) {
    const errData = err.response?.data?.error;
    const errorMsg = errData?.message || err.message;

    const recorded = recordMessage(cleanPhone, {
      sender: 'agent',
      text: templateName ? `[Template: ${templateName}]` : text,
      status: 'failed'
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

    const recorded = recordMessage(cleanPhone, {
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

    const recorded = recordMessage(cleanPhone, {
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

app.get('/api/chat/conversations/:phone', checkAuthCookie, (req, res) => {
  const cleanPhone = req.params.phone.replace(/\D/g, '');
  const data = loadConversations();
  const conv = data[cleanPhone];
  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });
  conv.unread = 0;
  saveConversations(data);
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

// Dispara Template do 3º Contato para Reabrir Janela sem alterar status nem pasta
app.post('/api/chat/send-third-template', checkAuthCookie, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });

  try {
    const result = await sendMessage({
      phone,
      templateName: WA_TEMPLATE_THIRD_CONTACT,
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

// 🔄 Alterar Estágio via Dropdown único
app.post('/api/chat/conversations/:phone/stage', checkAuthCookie, async (req, res) => {
  const cleanPhone = req.params.phone.replace(/\D/g, '');
  const { stage } = req.body;
  const data = loadConversations();
  const conv = data[cleanPhone];
  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });

  const normalizedStage = (stage || '').toLowerCase().trim();
  conv.stage = normalizedStage;
  conv.closed = (normalizedStage === 'ganho');
  conv.discarded = (normalizedStage === 'perdido' || normalizedStage === 'descartado' || normalizedStage === 'descartados');

  saveConversations(data);

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
    try {
      await axios.post(
        `${ORCHESTRATOR_URL}/contacts/status`,
        { phone: cleanPhone, status: orchestratorStatus },
        {
          headers: { 'x-api-key': API_KEY },
          timeout: 5000
        }
      );
      console.log(`📡 Sincronizado: ${cleanPhone} → status ${orchestratorStatus} (${normalizedStage})`);
    } catch (err) {
      console.warn(`⚠️ Falha ao sincronizar status do contato ${cleanPhone} com orquestrador:`, err.message);
    }
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

      const recorded = recordMessage(fromNumber, {
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

      try {
        await axios.post(
          `${ORCHESTRATOR_URL}/contacts/responded`,
          { phone: fromNumber },
          {
            headers: { 'x-api-key': API_KEY },
            timeout: 5000
          }
        );
      } catch (err) {
        console.warn('⚠️ Falha ao sincronizar resposta com orquestrador:', err.message);
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

        const updated = updateMessageStatus(msgId, 'failed', reason);
        if (updated && io) {
          io.emit('message_status_update', { 
            messageId: msgId, 
            phone: recipient, 
            status: 'failed', 
            error: reason 
          });
        }

        // Falha no disparo automático (1º ou 2º contato) envia para status 4 no orquestrador
        axios.post(`${ORCHESTRATOR_URL}/contacts/invalid`, { phone: recipient }, {
          headers: { 'x-api-key': API_KEY }
        }).catch(() => {});
      } else {
        const updated = updateMessageStatus(msgId, status);
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
});