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
- Mantem os contatos em `contacts.json` com status numerico.
- Executa um ciclo a cada 10 minutos.
- Opera de segunda a sexta, das 10h as 19h.
- Tenta enviar 70% de contatos novos e 30% de follow-ups.
- Considera o follow-up elegivel depois de 20 horas do primeiro envio.
- Envia templates para o servico `whatsapp` em `POST /send`.
- Usa o agrupamento `nicho + bairro` para alternar novos contatos e evitar repetir o mesmo grupo consecutivamente.

## Status dos contatos

| Status | Significado |
| ---: | --- |
| `1` | Novo contato, aguardando primeiro envio. |
| `2` | Primeiro contato enviado, aguardando follow-up. |
| `3` | Contato respondeu e saiu da cadencia. |
| `4` | Contato invalido ou envio com falha. Corresponde a aba `falha` no painel. |
| `5` | Cadencia concluida apos o follow-up. Corresponde a etapa `congelado`. |
| `6` | Negocio fechado, etapa `ganho`. |
| `7` | Negocio perdido, etapa `perdido`. |
| `8` | Contato descartado, etapa `descartado`. |
| `99` | Bloqueio temporario durante um envio; e revertido para o resultado do envio. |

## Endpoints

Todos exigem o header `x-api-key` com o valor de `API_KEY`.

- `POST /contacts`: adiciona um contato com `phone` e, opcionalmente, `name` e `niche`. Telefones sao normalizados e duplicados sao rejeitados.
- `POST /contacts/title`: atualiza o titulo de um contato.
- `POST /contacts/responded`: aceita `phone` ou `identifier` e marca todos os registros correspondentes como respondidos (`3`).
- `POST /contacts/status`: aceita `phone` e `status` numerico para atualizar a etapa sincronizada pelo painel.
- `POST /contacts/closed`: aceita `phone` ou `identifier` e marca o contato como ganho (`6`).
- `POST /contacts/invalid`: marca um contato como invalido.

## Variaveis

- `API_KEY`: chave para proteger os endpoints.
- `WEBHOOK_URL`: endpoint de envio do WhatsApp, por padrao `http://localhost:3000/send`.
- `WA_TEMPLATE_FIRST_CONTACT`: template do primeiro contato.
- `WA_TEMPLATE_FOLLOW_UP`: template do follow-up.

O corpo enviado para o WhatsApp usa `phone`, `templateName` e `templateParams`. O primeiro envio muda o contato para `2`; o follow-up muda para `5`. Falhas de envio mudam o contato para `4`.

Os templates precisam existir e estar aprovados na WhatsApp Cloud API antes do uso. O arquivo `.env.example` contem os valores esperados.