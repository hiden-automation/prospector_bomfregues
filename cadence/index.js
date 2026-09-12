require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const { processNextContact } = require('./scheduler');

const CONTACTS_FILE = path.join(__dirname, 'contacts.json');
const API_KEY = process.env.API_KEY;
const PORT = process.env.PORT || 4000;

if (!fs.existsSync(CONTACTS_FILE)) {
  fs.writeFileSync(CONTACTS_FILE, '[]');
}

if (!API_KEY) {
  console.error('❌ API_KEY não definida no .env');
  process.exit(1);
}

const app = express();
app.use(express.json({ type: '*/*' }));

function authMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ➕ Adicionar novo contato
app.post('/contacts', authMiddleware, (req, res) => {
  const { name, phone, niche } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'phone é obrigatório' });
  }

  const contacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
  const cleanPhone = phone.replace(/\D/g, '');

  const exists = contacts.find((c) => c.phone.replace(/\D/g, '') === cleanPhone);
  if (exists) {
    return res.status(409).json({ error: 'Contato já existe' });
  }

  contacts.push({
    name: name || null,
    phone: cleanPhone,
    niche: niche || 'geral',
    status: 1, // Status 1: Novo contato
    lastSent: null
  });

  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2), 'utf8');
  console.log(`➕ Novo contato adicionado: ${cleanPhone} [Nicho: ${niche || 'geral'}]`);

  res.json({ status: 'added', phone: cleanPhone });
});

// 🏷️ Atualiza chatTitle recebido do webhook
app.post('/contacts/title', authMiddleware, (req, res) => {
  const { phone, title } = req.body;
  if (!phone || !title) {
    return res.status(400).json({ error: 'phone e title são obrigatórios' });
  }

  const contacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
  const cleanPhone = phone.replace(/\D/g, '');
  const contact = contacts.find((c) => {
    const cPhone = (c.phone || '').replace(/\D/g, '');
    return cPhone === cleanPhone || cPhone.endsWith(cleanPhone.slice(-8)) || cleanPhone.endsWith(cPhone.slice(-8));
  });

  if (!contact) {
    return res.status(404).json({ error: 'Contato não encontrado' });
  }

  contact.chatTitle = title.trim();
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2), 'utf8');
  console.log(`🏷️ Título atualizado para ${cleanPhone} → "${title.trim()}"`);
  res.json({ status: 'title_updated', phone: cleanPhone });
});

// 📩 Contato respondeu: Atualiza para Status 3 (Sai da cadência de follow-up)
app.post('/contacts/responded', authMiddleware, (req, res) => {
  const { phone, identifier } = req.body;
  const target = (identifier || phone || '').replace(/\D/g, '');

  if (!target) {
    return res.status(400).json({ error: 'phone ou identifier é obrigatório' });
  }

  const contacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
  const matching = contacts.filter((c) => {
    const cPhone = (c.phone || '').replace(/\D/g, '');
    return cPhone === target || cPhone.endsWith(target.slice(-8)) || target.endsWith(cPhone.slice(-8));
  });

  if (matching.length === 0) {
    return res.status(404).json({ error: 'Contato não encontrado' });
  }

  matching.forEach((c) => { c.status = 3; });
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2), 'utf8');

  console.log(`🛑 Contato respondeu: "${target}" → Marcado com status 3.`);
  res.json({ status: 'marked_as_responded', count: matching.length });
});

// 🔄 Atualização de status (2: Iniciado, 3: Interagindo, 5: Congelado, 6: Ganho, 7: Perdido, 8: Descartado)
app.post('/contacts/status', authMiddleware, (req, res) => {
  const { phone, status } = req.body;
  const target = (phone || '').replace(/\D/g, '');

  if (!target || status === undefined) {
    return res.status(400).json({ error: 'phone e status são obrigatórios' });
  }

  const newStatus = Number(status);
  const contacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
  
  // Busca flexível tolerando com ou sem DDI (55)
  const matching = contacts.filter((c) => {
    const cPhone = (c.phone || '').replace(/\D/g, '');
    return cPhone === target || cPhone.endsWith(target.slice(-8)) || target.endsWith(cPhone.slice(-8));
  });

  if (matching.length === 0) {
    console.warn(`⚠️ Tentativa de atualizar status para ${target} (status: ${newStatus}), mas contato não existe no contacts.json.`);
    return res.status(404).json({ error: 'Contato não encontrado' });
  }

  matching.forEach((c) => { 
    c.status = newStatus;
    if (newStatus === 2 && !c.lastSent) {
      c.lastSent = new Date().toISOString();
    }
  });

  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2), 'utf8');

  console.log(`🔄 Status do contato "${target}" atualizado para ${newStatus} em ${matching.length} registro(s).`);
  res.json({ status: 'status_updated', phone: target, newStatus, updated: matching.length });
});

// 🤝 Contato fechado / Ganho: Atualiza para Status 6
app.post('/contacts/closed', authMiddleware, (req, res) => {
  const { phone, identifier } = req.body;
  const target = (identifier || phone || '').replace(/\D/g, '');

  if (!target) {
    return res.status(400).json({ error: 'phone ou identifier é obrigatório' });
  }

  const contacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
  const matching = contacts.filter((c) => {
    const cPhone = (c.phone || '').replace(/\D/g, '');
    return cPhone === target || cPhone.endsWith(target.slice(-8)) || target.endsWith(cPhone.slice(-8));
  });

  if (matching.length === 0) {
    return res.status(404).json({ error: 'Contato não encontrado' });
  }

  matching.forEach((c) => { c.status = 6; });
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2), 'utf8');

  console.log(`🤝 Contato Ganho: "${target}" → Marcado com status 6.`);
  res.json({ status: 'marked_as_closed', count: matching.length });
});

// ❌ Contato inválido: Atualiza para Status 4
app.post('/contacts/invalid', authMiddleware, (req, res) => {
  const { phone } = req.body;
  const cleanPhone = (phone || '').replace(/\D/g, '');

  const contacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
  const contact = contacts.find((c) => {
    const cPhone = (c.phone || '').replace(/\D/g, '');
    return cPhone === cleanPhone || cPhone.endsWith(cleanPhone.slice(-8)) || cleanPhone.endsWith(cPhone.slice(-8));
  });

  if (!contact) return res.status(404).json({ error: 'Contato não encontrado' });

  contact.status = 4;
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2), 'utf8');
  res.json({ status: 'marked_as_invalid', phone: cleanPhone });
});

// ─── CRONOGRAMA DETERMINÍSTICO (10h às 19h / Seg-Sex) ───────────────────

function isWithinWorkingHours() {
  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours();

  if (day === 0 || day === 6) return false;
  if (hour < 10 || hour >= 19) return false;

  return true;
}

// Disparo a cada 10 minutos cravados
setInterval(async () => {
  if (!isWithinWorkingHours()) {
    console.log('⛔ Fora do horário comercial (10h às 19h, Seg–Sex). Envio suspenso.');
    return;
  }
  console.log('⏰ [Ciclo de 10 minutos] Avaliando próximo envio...');
  await processNextContact();
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`🚀 Orquestrador rodando em http://localhost:${PORT}`);
  console.log('📅 Horário de operação: 10h às 19h (Segunda a Sexta)');
  console.log('⚖️ Cadência: 1 envio a cada 10 min (70% Novos / 30% Follow-up)');

  setTimeout(async () => {
    if (isWithinWorkingHours()) {
      console.log('⚡ Disparo inicial de inicialização...');
      await processNextContact();
    } else {
      console.log('⏸️ Inicializado fora do expediente (10h às 19h). Aguardando próximo ciclo válido.');
    }
  }, 5000);
});