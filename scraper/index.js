require('dotenv').config();
const { chromium } = require('playwright');
const axios = require('axios');

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:4000/contacts';
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error('❌ API_KEY não definida no .env');
  process.exit(1);
}

const SEARCH_QUERIES = [
  // ─── Rodada 1: Osasco e Zona Oeste SP ─────────────────────────────
  'Estética Automotiva em Vila Yara Osasco',
  'Car Detail no Centro de Osasco',
  'Estúdio Automotivo em Campesina Osasco',
  'Lavagem Detalhada em Bela Vista Osasco',
  'Estética Automotiva no Bonfiglioli',
  'Car Detail no Butantã',
  'Lava Rápido na Lapa',

  // ─── Rodada 2: Zonas Oeste e Sul de SP (Público de Alto Ticket) ────
  'Estética Automotiva em Pinheiros',
  'Car Detail na Vila Madalena',
  'Estúdio Automotivo em Moema',
  'Lavagem Técnica no Itaim Bibi',
  'Estética Automotiva na Saúde',
  'Car Detail em Santo Amaro',
  'Lava Rápido no Morumbi',

  // ─── Rodada 3: Zonas Norte, Leste e Expansão Grande SP ────────────
  'Estética Automotiva em Santana',
  'Car Detail no Tatuapé',
  'Estúdio Automotivo na Mooca',
  'Lavagem Detalhada em Alphaville Barueri',
  'Estética Automotiva em Tamboré',
  'Car Detail no Jardim Anália Franco',
  'Lava Rápido em Perdizes',
];

const processedHrefs = new Set();
const addedPhonesCache = new Set();

function formatBRPhone(rawPhone) {
  if (!rawPhone) return '';

  let digits = rawPhone.replace(/\D/g, '');

  if (digits.startsWith('0')) {
    digits = digits.substring(1);
  }

  if (!digits.startsWith('55') && (digits.length === 10 || digits.length === 11)) {
    digits = `55${digits}`;
  }

  return digits;
}

async function scrapeGoogleMaps(context, query) {
  console.log(`\n🔍 Iniciando busca contínua por: "${query}"...`);

  const feedPage = await context.newPage();
  const detailPage = await context.newPage();

  await feedPage.bringToFront();

  await feedPage.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded' });

  const searchBox = feedPage.locator('input[name="q"]');
  await searchBox.waitFor({ state: 'visible', timeout: 10000 });
  await searchBox.fill(query);
  await feedPage.keyboard.press('Enter');

  const feedSelector = 'div[role="feed"]';
  try {
    await feedPage.waitForSelector(feedSelector, { timeout: 10000 });
  } catch {
    console.log(`⚠️ Nenhum resultado encontrado para: ${query}`);
    await feedPage.close();
    await detailPage.close();
    return;
  }

  let noNewItemsTries = 0;
  let totalProcessed = 0;

  while (true) {
    const items = feedPage.locator('a.hfpxzc');
    const count = await items.count();

    let processedAnyInThisLoop = false;

    for (let i = 0; i < count; i++) {
      const currentItem = items.nth(i);
      const href = await currentItem.getAttribute('href').catch(() => '');
      const name = (await currentItem.getAttribute('aria-label')) || 'Estabelecimento';

      // ─── 1. VERIFICAÇÃO DE PATROCINADO / ANÚNCIO ────────────────────────
      const isSponsored = await currentItem.evaluate((el) => {
        // Sobe até o card principal que contém o resultado
        const card = el.closest('div[jsaction*="mouseover"]') || el.closest('div.Nv2PK') || el.parentElement;
        if (!card) return false;

        const text = card.innerText || '';
        // Detecta 'Patrocinado', 'Anúncio' ou 'Sponsored'
        return /patrocinado|anúncio|sponsored/i.test(text);
      }).catch(() => false);

      if (isSponsored) {
        console.log(`⏩ [PULANDO PATROCINADO]: ${name}`);
        continue; // Pula direto para o próximo sem abrir o link
      }

      // ─── 2. PROCESSAMENTO NORMAL ─────────────────────────────────────────
      const itemKey = href ? href.split('?')[0] : '';

      if (itemKey && !processedHrefs.has(itemKey)) {
        processedHrefs.add(itemKey);
        processedAnyInThisLoop = true;
        totalProcessed++;

        console.log(`\n🖱️ [#${totalProcessed}] Extraindo orgânico: ${name}`);

        try {
          await detailPage.goto(href, { waitUntil: 'domcontentloaded', timeout: 15000 });

          await detailPage.waitForSelector('div.Io6YTe, button[data-item-id^="phone:"]', { state: 'attached', timeout: 8000 }).catch(() => {});

          let rawPhone = '';
          
          const phoneButton = detailPage.locator('button[data-item-id^="phone:"]');
          if (await phoneButton.count() > 0) {
            rawPhone = (await phoneButton.first().getAttribute('data-item-id')) || '';
          }

          if (!rawPhone) {
            const textElements = detailPage.locator('div.Io6YTe');
            const textCount = await textElements.count();
            for (let j = 0; j < textCount; j++) {
              const text = await textElements.nth(j).innerText();
              if (text && /\(?\d{2}\)?\s?\d{4,5}-?\d{4}/.test(text)) {
                rawPhone = text;
                break;
              }
            }
          }

          const phone = formatBRPhone(rawPhone);

          if (phone && !addedPhonesCache.has(phone)) {
            addedPhonesCache.add(phone);
            console.log(`📞 [${name}] → Telefone formatado: ${phone}`);

            try {
              await axios.post(
                ORCHESTRATOR_URL,
                { name, phone, niche: query },
                {
                  headers: {
                    'x-api-key': API_KEY,
                    'Content-Type': 'application/json',
                  },
                  timeout: 5000,
                }
              );
              console.log(`✅ Adicionado com sucesso na Cadência (Nicho: ${query})!`);
            } catch (webhookErr) {
              console.error(`❌ Erro ao enviar ${phone} para o orquestrador:`, webhookErr.message);
            }
          } else {
            console.log(`⚠️ [${name}] → Sem telefone público ou formato não reconhecido.`);
          }
        } catch (err) {
          console.log(`⚠️ Falha ao carregar detalhes de "${name}":`, err.message);
        }
      }
    }

    if (!processedAnyInThisLoop) {
      console.log(`\n⏳ Fim dos ${count} itens da tela. Rolando feed principal para carregar mais...`);

      await feedPage.bringToFront();

      await feedPage.evaluate((selector) => {
        const feed = document.querySelector(selector);
        if (feed) feed.scrollBy(0, 600);
      }, feedSelector);

      await feedPage.waitForTimeout(2500);

      const newCount = await items.count();
      if (newCount === count) {
        noNewItemsTries++;
        console.log(`⏳ Tentativa ${noNewItemsTries}/4: Nenhum novo comércio apareceu após rolar.`);
        if (noNewItemsTries >= 4) {
          console.log(`🏁 Fim dos resultados alcançados para esta busca.`);
          break;
        }
      } else {
        noNewItemsTries = 0;
      }
    } else {
      noNewItemsTries = 0;
    }
  }

  await feedPage.close();
  await detailPage.close();
}

(async () => {
  console.log('🌐 Iniciando navegador para prospecção contínua...');

  const browser = await chromium.launch({
    headless: false,
    slowMo: 30,
  });

  const context = await browser.newContext();

  for (const query of SEARCH_QUERIES) {
    await scrapeGoogleMaps(context, query);
  }

  console.log('\n🎉 Processo de captação de leads finalizado com sucesso!');
  await browser.close();
})();