# Cadence

## Inicializacao

```powershell
Copy-Item .env.example .env
npm install
node index.js
```

Inicie este servico antes do `scraper` e do envio automatico. Por padrao, ele fica disponivel em `http://localhost:4000`. Preencha `API_KEY` no `.env` e use o mesmo valor no `scraper` e no `whatsapp`.

## O que ele faz

- Recebe novos leads do `scraper` em `POST /contacts`.
- Mantem os contatos em `contacts.json`.
- Executa um ciclo a cada 10 minutos.
- Opera de segunda a sexta, das 10h as 19h.
- Tenta enviar 70% de contatos novos e 30% de follow-ups.
- Considera o follow-up elegivel depois de 20 horas do primeiro envio.
- Envia templates para o servico `whatsapp` em `POST /send`.

## Status dos contatos

- `1`: novo contato, aguardando primeiro envio.
- `2`: primeiro contato enviado, aguardando follow-up.
- `3`: contato respondeu e saiu da cadencia.
- `4`: contato invalido ou envio com falha.
- `5`: cadencia concluida apos o follow-up.
- `99`: bloqueio temporario durante um envio.

## Endpoints

Todos exigem o header `x-api-key` com o valor de `API_KEY`.

- `POST /contacts`: adiciona um contato com `name`, `phone` e `niche`.
- `POST /contacts/title`: atualiza o titulo de um contato.
- `POST /contacts/responded`: marca um contato como respondido.
- `POST /contacts/invalid`: marca um contato como invalido.

## Variaveis

- `API_KEY`: chave para proteger os endpoints.
- `WEBHOOK_URL`: endpoint de envio do WhatsApp, por padrao `http://localhost:3000/send`.
- `WA_TEMPLATE_FIRST_CONTACT`: template do primeiro contato.
- `WA_TEMPLATE_FOLLOW_UP`: template do follow-up.

Os templates precisam existir e estar aprovados na WhatsApp Cloud API antes do uso. O arquivo `.env.example` contem os valores esperados.