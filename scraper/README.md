# Scraper

## Inicializacao

```powershell
Copy-Item .env.example .env
npm install
node index.js
```

O scraper abre o Google Maps em navegador visivel usando Playwright. Antes de executar, confirme que a `cadence` esta rodando em `http://localhost:4000` e preencha `API_KEY` no `.env`.

## O que ele faz

- Executa uma lista fixa de 112 buscas por nicho e regiao em `index.js`.
- Percorre os resultados organicos do Google Maps.
- Ignora resultados patrocinados.
- Extrai e normaliza telefones brasileiros para o formato com codigo `55` quando o numero tem 10 ou 11 digitos.
- Evita processar o mesmo resultado e o mesmo telefone durante a execucao.
- Envia cada lead para `POST /contacts` da `cadence` com `name`, `phone` e `niche`. O bairro fica embutido na consulta usada como `niche`.

## Variaveis

- `API_KEY`: deve ser igual ao valor usado em `cadence/.env`.
- `ORCHESTRATOR_URL`: endpoint de destino, normalmente `http://localhost:4000/contacts`.

## Observacoes

- O navegador e iniciado com `headless: false`, portanto a janela do Playwright ficara visivel.
- O processo percorre todas as consultas configuradas e encerra ao terminar.
- O Google Maps pode alterar seletores ou limitar acessos; se a coleta parar de encontrar resultados, revise os seletores em `index.js`.
- Telefones ja existentes sao rejeitados pela `cadence`, que mantem a fonte de verdade em `cadence/contacts.json`.
- O scraper mantem caches apenas durante a execucao; rodar o processo novamente pode revisitar resultados, mas a `cadence` rejeita telefones ja cadastrados.