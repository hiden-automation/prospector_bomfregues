require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const API_KEY = process.env.API_KEY;
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:4000';
const PORT = process.env.PORT || 3000;

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

if (!fs.existsSync(CONVERSATIONS_FILE)) {
  fs.writeFileSync(CONVERSATIONS_FILE, '{}', 'utf8');
}

if (!API_KEY || !WA_PHONE_NUMBER_ID || !WA_ACCESS_TOKEN) {
  console.error('❌ Variáveis de ambiente obrigatórias não configuradas no .env');
  process.exit(1);
}

// ─── GERENCIADOR DE CONVERSAS (PERSISTÊNCIA LOCAL) ──────────────────────
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

function recordMessage(phone, { sender, text, messageId = null, title = null, status = 'sent' }) {
  const cleanPhone = phone.replace(/\D/g, '');
  const data = loadConversations();

  if (!data[cleanPhone]) {
    data[cleanPhone] = {
      phone: cleanPhone,
      chatTitle: title || cleanPhone,
      unread: 0,
      updatedAt: new Date().toISOString(),
      messages: []
    };
  }

  if (title) {
    data[cleanPhone].chatTitle = title;
  }

  const msgObj = {
    id: messageId || `local_${Date.now()}`,
    sender,
    text,
    status: status,
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

// ─── NOTIFICAÇÃO PUSH VIA ONESIGNAL ──────────────────────────────────────
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

// ─── DISPARO OFICIAL VIA GRAPH API ──────────────────────────────────────
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

    // Push de falha removido aqui (silencioso)
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

// ─── AUTENTICAÇÃO PERSISTENTE (COOKIE + HEADER X-AUTH-TOKEN) ────────────
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

// 🗑️ Descartar conversa manualmente
app.post('/api/chat/conversations/:phone/discard', checkAuthCookie, (req, res) => {
  const cleanPhone = req.params.phone.replace(/\D/g, '');
  const data = loadConversations();
  const conv = data[cleanPhone];
  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });

  conv.discarded = true;
  saveConversations(data);

  if (io) {
    io.emit('conversation_updated', conv);
  }

  res.json({ success: true, phone: cleanPhone });
});

// ↩️ Recuperar conversa descartada
app.post('/api/chat/conversations/:phone/restore', checkAuthCookie, (req, res) => {
  const cleanPhone = req.params.phone.replace(/\D/g, '');
  const data = loadConversations();
  const conv = data[cleanPhone];
  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });

  // Remove a marcação de descarte manual
  conv.discarded = false;

  // Se o cliente havia enviado "não tenho interesse", limpamos a flag para ele voltar ao funil normal
  if (conv.messages) {
    conv.messages.forEach(m => {
      if (m.sender === 'user' && m.text) {
        m.text = m.text.replace(/não tenho interesse|nao tenho interesse/gi, '[Interesse Reaberto]');
      }
    });
  }

  saveConversations(data);

  if (io) {
    io.emit('conversation_updated', conv);
  }

  res.json({ success: true, phone: cleanPhone });
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

  // Recebimento de mensagens (Respostas dos leads) -> PUSH ATIVO
  if (change?.messages && change.messages.length > 0) {
    for (const msg of change.messages) {
      const fromNumber = msg.from;
      const contactInfo = change.contacts?.find((c) => c.wa_id === fromNumber);
      const profileName = contactInfo?.profile?.name || null;

      let incomingText = '';
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
      } else {
        incomingText = `[Mensagem do tipo ${msg.type}]`;
      }

      const recorded = recordMessage(fromNumber, {
        sender: 'user',
        text: incomingText,
        messageId: msg.id,
        title: profileName
      });

      io.emit('new_message', recorded);

      // Único push disparado: quando o lead responde
      await sendPushNotification(`WhatsApp: ${profileName || fromNumber}`, incomingText);

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

  // Atualizações de status de entrega (Sent, Delivered, Read, Failed) -> PUSH SILENCIADO
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

        // Marca como inválido no orquestrador silenciosamente sem enviar push
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