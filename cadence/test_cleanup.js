const fs = require('fs');
const path = require('path');

const CONTACTS_FILE = path.join(__dirname, 'contacts.json');
const OUTPUT_FILE = path.join(__dirname, 'preview_mensagens.txt');

function formatBusinessName(rawName) {
  if (!rawName) return 'Equipe';

  // Divide o nome em palavras mantendo caracteres alfanuméricos
  const words = rawName.trim().split(/\s+/);
  if (words.length === 0) return 'Equipe';

  // Função auxiliar para remover acentuação, caracteres especiais e deixar em minúsculo
  const normalize = (str) =>
    (str || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\w]/g, '');

  // Lista consolidada de todas as palavras que devem ser puladas (não importa a posição)
  const bannedWords = new Set([
    // Segmentos
    'estetica',
    'automotiva',
    'automotivo',
    'lava',
    'rapido',
    'car',
    'estacionamento',
    
    // Possessivos
    'nosso',
    'nossa',
    'nossos',
    'nossas',

    // Preposições e contrações
    'de',
    'do',
    'da',
    'dos',
    'das',
    'no',
    'na',
    'nos',
    'nas',

    // Artigos e conjunções
    'o',
    'a',
    'os',
    'as',
    'e',
    '-'
  ]);

  let targetWord = null;

  // Itera palavra por palavra até achar a primeira que não seja termo banido
  for (const word of words) {
    const cleanToken = normalize(word);

    // Se for vazia, só pontuação ou fizer parte da lista proibida, pula
    if (!cleanToken || bannedWords.has(cleanToken) || /^[^a-zA-Z0-9]+$/.test(word)) {
      continue;
    }

    targetWord = word;
    break;
  }

  // Fallback caso todas as palavras caiam no filtro
  if (!targetWord) {
    targetWord = words[0] || 'Equipe';
  }

  // Remove caracteres ou pontuações residuais nas pontas
  const sanitizedWord = targetWord.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');

  if (!sanitizedWord) return 'Equipe';

  // Retorna com apenas a primeira letra maiúscula e o resto minúsculo
  return sanitizedWord.charAt(0).toUpperCase() + sanitizedWord.slice(1).toLowerCase();
}

function buildMessage(companyName) {
  return `Fala, pessoal da ${companyName}, tudo bem?

Eu desenvolvo aplicativos de fidelidade e agendamento personalizados para estúdios automotivos. O app sai com a marca e cores de vocês, pontuação de clientes, módulo de agendamento e envio de promoções, por R$ 79/mês.

Posso montar uma versão de demonstração com a identidade da ${companyName} para vocês testarem sem compromisso?`;
}

function runTest() {
  if (!fs.existsSync(CONTACTS_FILE)) {
    console.error(`❌ Arquivo não encontrado: ${CONTACTS_FILE}`);
    return;
  }

  const rawData = fs.readFileSync(CONTACTS_FILE, 'utf8');
  let contacts = [];

  try {
    contacts = JSON.parse(rawData);
  } catch (err) {
    console.error('❌ Erro ao analisar contacts.json:', err.message);
    return;
  }

  let fileContent = `====================================================\n`;
  fileContent += `PRÉ-VISUALIZAÇÃO DE DISPAROS - ${new Date().toLocaleString('pt-BR')}\n`;
  fileContent += `Total de contatos analisados: ${contacts.length}\n`;
  fileContent += `====================================================\n\n`;

  console.log(`\n🔍 Testando limpeza unificada em ${contacts.length} contatos...\n`);

  contacts.forEach((contact, index) => {
    const originalName = contact.name || 'Sem nome';
    const cleanName = formatBusinessName(contact.name);
    const message = buildMessage(cleanName);

    console.log(`[#${index + 1}] Original: "${originalName}"`);
    console.log(`      Resultado: "${cleanName}"\n`);

    fileContent += `----------------------------------------------------\n`;
    fileContent += `[CONTATO #${index + 1}]\n`;
    fileContent += `Telefone: ${contact.phone || 'N/A'}\n`;
    fileContent += `Original: ${originalName}\n`;
    fileContent += `Nome extraído: ${cleanName}\n\n`;
    fileContent += `MENSAGEM FINAL:\n${message}\n\n`;
  });

  fs.writeFileSync(OUTPUT_FILE, fileContent, 'utf8');
  console.log(`✅ Concluído! Arquivo gerado em: ${OUTPUT_FILE}`);
}

runTest();