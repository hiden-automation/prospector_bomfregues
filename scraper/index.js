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
  // ─── Rodada 1 ────────────────────────────────────────────────────────
  'Corretora de Seguros em Vila Yara Osasco',
  'Consultora de Engenharia em Campesina Osasco',
  'Escritório de Contabilidade no Centro de Osasco',
  'Clínica de Odontologia no Bonfiglioli',
  'Clínica de Estética em Santana',
  'Despachantes Imobiliários no Centro de Osasco',
  'Avaliadores de Imóveis na Saúde',

  // ─── Rodada 2 ────────────────────────────────────────────────────────
  'Corretora de Seguros na Lapa',
  'Consultora de Engenharia na Lapa',
  'Escritório de Contabilidade na Lapa',
  'Clínica de Odontologia na Saúde',
  'Clínica de Estética na Saúde',
  'Despachantes Imobiliários na Lapa',
  'Avaliadores de Imóveis em Santana',

  // ─── Rodada 3 ────────────────────────────────────────────────────────
  'Corretora de Seguros em Campesina Osasco',
  'Consultora de Engenharia no Centro de Osasco',
  'Escritório de Contabilidade na Mooca',
  'Clínica de Odontologia em Bela Vista Osasco',
  'Clínica de Estética no Bonfiglioli',
  'Despachantes Imobiliários em Santo Amaro',
  'Avaliadores de Imóveis na Lapa',

  // ─── Rodada 4 ────────────────────────────────────────────────────────
  'Corretora de Seguros no Butantã',
  'Consultora de Engenharia em Vila Yara Osasco',
  'Escritório de Contabilidade em Santo Amaro',
  'Clínica de Odontologia em Vila Yara Osasco',
  'Clínica de Estética em Vila Yara Osasco',
  'Despachantes Imobiliários na Mooca',
  'Avaliadores de Imóveis no Centro de Osasco',

  // ─── Rodada 5 ────────────────────────────────────────────────────────
  'Corretora de Seguros no Centro de Osasco',
  'Consultora de Engenharia no Centro de Barueri',
  'Escritório de Contabilidade em Santana',
  'Clínica de Odontologia em Santana',
  'Clínica de Estética em Campesina Osasco',
  'Despachantes Imobiliários em Santana',
  'Avaliadores de Imóveis em Vila Yara Osasco',

  // ─── Rodada 6 ────────────────────────────────────────────────────────
  'Corretora de Seguros na Saúde',
  'Consultora de Engenharia na Vila Leopoldina',
  'Escritório de Contabilidade em Vila Yara Osasco',
  'Clínica de Odontologia no Butantã',
  'Clínica de Estética no Tucuruvi',
  'Despachantes Imobiliários na Saúde',
  'Avaliadores de Imóveis em Campesina Osasco',

  // ─── Rodada 7 ────────────────────────────────────────────────────────
  'Corretora de Seguros em Santana',
  'Consultora de Engenharia em Santo Amaro',
  'Escritório de Contabilidade no Butantã',
  'Clínica de Odontologia no Tucuruvi',
  'Clínica de Estética no Butantã',
  'Despachantes Imobiliários no Centro de Barueri',
  'Avaliadores de Imóveis no Butantã',

  // ─── Rodada 8 ────────────────────────────────────────────────────────
  'Corretora de Seguros no Bonfiglioli',
  'Consultora de Engenharia na Mooca',
  'Escritório de Contabilidade na Saúde',
  'Clínica de Odontologia em Campesina Osasco',
  'Clínica de Estética em Bela Vista Osasco',
  'Despachantes Imobiliários em Vila Yara Osasco',
  'Avaliadores de Imóveis na Mooca',

  // ─── Rodada 9 ────────────────────────────────────────────────────────
  'Corretora de Seguros na Mooca',
  'Consultora de Engenharia no Butantã',
  'Escritório de Contabilidade em Campesina Osasco',
  'Clínica de Odontologia na Lapa',
  'Clínica de Estética na Mooca',
  'Despachantes Imobiliários no Butantã',
  'Avaliadores de Imóveis em Santo Amaro',

  // ─── Rodada 10 ───────────────────────────────────────────────────────
  'Corretora de Seguros em Bela Vista Osasco',
  'Consultora de Engenharia em Santana',
  'Escritório de Contabilidade em Bela Vista Osasco',
  'Clínica de Odontologia na Mooca',
  'Clínica de Estética na Lapa',
  'Despachantes Imobiliários em Bela Vista Osasco',
  'Avaliadores de Imóveis no Centro de Barueri',

  // ─── Rodada 11 ───────────────────────────────────────────────────────
  'Corretora de Seguros no Centro de Barueri',
  'Consultora de Engenharia em Bela Vista Osasco',
  'Escritório de Contabilidade no Centro de Barueri',
  'Clínica de Odontologia no Centro de Barueri',
  'Clínica de Estética no Tatuapé',
  'Despachantes Imobiliários no Tucuruvi',
  'Avaliadores de Imóveis em Bela Vista Osasco',

  // ─── Rodada 12 ───────────────────────────────────────────────────────
  'Corretora de Seguros em Santo Amaro',
  'Consultora de Engenharia na Saúde',
  'Escritório de Contabilidade no Bonfiglioli',
  'Clínica de Odontologia no Centro de Osasco',
  'Clínica de Estética na Vila Leopoldina',
  'Despachantes Imobiliários em Campesina Osasco',
  'Avaliadores de Imóveis no Bonfiglioli',

  // ─── Rodada 13 ───────────────────────────────────────────────────────
  'Corretora de Seguros na Vila Leopoldina',
  'Consultora de Engenharia no Tatuapé',
  'Escritório de Contabilidade no Tucuruvi',
  'Clínica de Odontologia em Santo Amaro',
  'Clínica de Estética no Centro de Barueri',
  'Despachantes Imobiliários no Bonfiglioli',
  'Avaliadores de Imóveis no Tatuapé',

  // ─── Rodada 14 ───────────────────────────────────────────────────────
  'Corretora de Seguros no Tatuapé',
  'Consultora de Engenharia em Pinheiros',
  'Escritório de Contabilidade no Tatuapé',
  'Clínica de Odontologia na Vila Leopoldina',
  'Clínica de Estética no Centro de Osasco',
  'Despachantes Imobiliários no Tatuapé',
  'Avaliadores de Imóveis na Vila Leopoldina',

  // ─── Rodada 15 ───────────────────────────────────────────────────────
  'Corretora de Seguros no Tucuruvi',
  'Consultora de Engenharia no Bonfiglioli',
  'Escritório de Contabilidade na Vila Leopoldina',
  'Clínica de Odontologia no Tatuapé',
  'Clínica de Estética em Santo Amaro',
  'Despachantes Imobiliários na Vila Leopoldina',
  'Avaliadores de Imóveis no Tucuruvi',

  // ─── Rodada 16 ───────────────────────────────────────────────────────
  'Corretora de Seguros em Pinheiros',
  'Consultora de Engenharia no Tucuruvi',
  'Escritório de Contabilidade em Pinheiros',
  'Clínica de Odontologia em Pinheiros',
  'Clínica de Estética em Pinheiros',
  'Despachantes Imobiliários em Pinheiros',
  'Avaliadores de Imóveis em Pinheiros'
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