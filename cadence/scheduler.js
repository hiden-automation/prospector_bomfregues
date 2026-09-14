const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CONTACTS_FILE = path.join(__dirname, 'contacts.json');
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:3000/send';
const API_KEY = process.env.API_KEY;

const WA_TEMPLATE_FIRST_CONTACT = process.env.WA_TEMPLATE_FIRST_CONTACT || 'primeiro_contato';
const WA_TEMPLATE_FOLLOW_UP = process.env.WA_TEMPLATE_FOLLOW_UP || 'segundo_contato';

// ⚙️ CONTROLE DE PROBABILIDADE
const NEW_CONTACT_RATIO = 1;

// Tempo mínimo após o 1º contato para se tornar elegível ao follow-up (20 horas em ms)
const MIN_FOLLOWUP_DELAY_MS = 20 * 60 * 60 * 1000;

// Armazena em memória o último agrupamento disparado para evitar repetição consecutiva
let lastDispatchedGroupKey = null;

function loadContacts() {
  try {
    return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveContacts(contacts) {
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2), 'utf8');
}

// 🔀 Busca o próximo novo contato intercalando Nicho e Bairro
function findNewContact(contacts) {
  const eligible = contacts.filter((c) => c.status === 1);
  if (eligible.length === 0) return null;

  const groups = new Map();

  for (const contact of eligible) {
    const niche = (contact.niche || 'geral').toLowerCase().trim();
    const neighborhood = (contact.neighborhood || contact.bairro || 'geral').toLowerCase().trim();
    const groupKey = `${niche}:::${neighborhood}`;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey).push(contact);
  }

  const availableKeys = Array.from(groups.keys());

  let candidateKeys = availableKeys.filter((k) => k !== lastDispatchedGroupKey);
  if (candidateKeys.length === 0) {
    candidateKeys = availableKeys;
  }

  const selectedKey = candidateKeys[Math.floor(Math.random() * candidateKeys.length)];
  lastDispatchedGroupKey = selectedKey;

  const selectedList = groups.get(selectedKey);
  return selectedList[0];
}

// Busca contato elegível para follow-up (Status 2 + ≥ 20 horas)
function findEligibleFollowUp(contacts) {
  const now = Date.now();
  return contacts.find((c) => {
    if (c.status !== 2 || !c.lastSent) return false;
    const sentTime = new Date(c.lastSent).getTime();
    return (now - sentTime) >= MIN_FOLLOWUP_DELAY_MS;
  });
}

async function dispatchMessage(contact, isFollowUp) {
  const templateName = isFollowUp ? WA_TEMPLATE_FOLLOW_UP : WA_TEMPLATE_FIRST_CONTACT;
  const nextStatus = isFollowUp ? 5 : 2; // 5: Congelado/Concluído follow-up | 2: Aguardando follow-up

  // Lock temporário de segurança (status 99)
  const contacts = loadContacts();
  const target = contacts.find((c) => c.phone === contact.phone);

  if (!target || (isFollowUp ? target.status !== 2 : target.status !== 1)) {
    return { success: false, reason: 'ALREADY_PROCESSED' };
  }

  target.status = 99;
  saveContacts(contacts);

  const niche = contact.niche || 'geral';
  const neighborhood = contact.neighborhood || contact.bairro || 'N/A';

  try {
    await axios.post(
      WEBHOOK_URL,
      {
        phone: contact.phone,
        templateName,
        templateParams: []
      },
      {
        headers: {
          'x-api-key': API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    const freshList = loadContacts();
    const doneContact = freshList.find((c) => c.phone === contact.phone);
    if (doneContact) {
      doneContact.status = nextStatus;
      doneContact.lastSent = new Date().toISOString();
      saveContacts(freshList);
    }

    console.log(`📤 [${isFollowUp ? 'FOLLOW-UP (segundo_contato)' : 'NOVO CONTATO'}] Enviado → ${contact.phone} [Nicho: ${niche} | Bairro: ${neighborhood}]`);
    return { success: true };
  } catch (err) {
    console.error(`❌ Falha no envio [${isFollowUp ? 'FOLLOW-UP' : 'NOVO'}] para ${contact.phone}:`, err.response?.data?.error || err.message);

    // Se falhar (tanto 1º quanto 2º contato), vai automaticamente para status 4
    const freshList = loadContacts();
    const failContact = freshList.find((c) => c.phone === contact.phone);
    if (failContact) {
      failContact.status = 4; // 4: Inválido / Falha
      saveContacts(freshList);
    }
    return { success: false, reason: 'FAILED' };
  }
}

async function processNextContact() {
  while (true) {
    const contacts = loadContacts();
    const roll = Math.random();
    const tryNewFirst = roll < NEW_CONTACT_RATIO;

    let targetContact = null;
    let isFollowUp = false;

    if (tryNewFirst) {
      targetContact = findNewContact(contacts);
      if (targetContact) {
        isFollowUp = false;
      } else {
        targetContact = findEligibleFollowUp(contacts);
        if (targetContact) isFollowUp = true;
      }
    } else {
      targetContact = findEligibleFollowUp(contacts);
      if (targetContact) {
        isFollowUp = true;
      } else {
        targetContact = findNewContact(contacts);
        if (targetContact) isFollowUp = false;
      }
    }

    if (!targetContact) {
      console.log('⏭️ Sem contatos elegíveis para envio no momento (nem novos, nem follow-ups com ≥ 20h).');
      return { success: false, reason: 'NO_CONTACTS' };
    }

    const result = await dispatchMessage(targetContact, isFollowUp);

    if (result.success) {
      return result;
    }

    console.log(`🔄 Tentando outro contato imediatamente após falha...`);
  }
}

module.exports = { processNextContact };