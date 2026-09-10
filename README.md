# Prospector

Sistema local de prospeccao e cadencia de contatos. O projeto coleta empresas no Google Maps, armazena os contatos encontrados, envia mensagens por WhatsApp e disponibiliza um painel para acompanhar as conversas.

## Inicializacao

Pre-requisitos:

- Node.js instalado.
- Credenciais da WhatsApp Cloud API, Meta e OneSignal.
- `cloudflared.exe` disponivel na pasta `whatsapp` para publicar o painel e o webhook.

Cada pasta e um servico independente. Em tres terminais, execute:

```powershell
cd cadence
Copy-Item .env.example .env
npm install
node index.js
```

```powershell
cd whatsapp
Copy-Item .env.example .env
npm install
node index.js
```

```powershell
cd scraper
Copy-Item .env.example .env
npm install
node index.js
```

Preencha os arquivos `.env` antes de iniciar. A ordem recomendada e `cadence`, `whatsapp` e depois `scraper`, para que as APIs que recebem os dados ja estejam disponiveis.

### Tunel do WhatsApp

Com o servico `whatsapp` rodando na porta 3000, abra outro terminal nessa pasta e execute:

```powershell
.\cloudflared.exe tunnel --url http://127.0.0.1:3000
```

Copie a URL HTTPS gerada pelo Cloudflare e atualize:

1. **OneSignal:** a URL publica/base do site ou do painel usado pelo app deve apontar para a URL do tunel. O painel do projeto fica em `https://URL_DO_TUNEL/chat`.
2. **Meta for Developers > WhatsApp > Configuration:** o callback URL deve ser `https://URL_DO_TUNEL/webhook`, usando como verify token o mesmo valor de `WA_WEBHOOK_VERIFY_TOKEN` do `whatsapp/.env`.

Cada nova execucao do tunel pode gerar outra URL. Quando isso acontecer, repita as duas atualizacoes.

## Como os servicos se conectam

```text
Google Maps
    |
    v
scraper -- POST /contacts --> cadence -- POST /send --> whatsapp
                                                        |
                                  Meta Cloud API <-------+
                                                        |
                                  OneSignal <------------+
```

- `scraper`: abre o Google Maps com Playwright, pesquisa os nichos configurados e envia nome, telefone e nicho para a cadencia.
- `cadence`: persiste contatos em `contacts.json`, controla status e dispara novos contatos ou follow-ups durante o horario comercial.
- `whatsapp`: envia mensagens pela Graph API, recebe webhooks da Meta, persiste conversas e serve o painel web.

## Dados e seguranca

- `contacts.json` guarda os contatos e o estado da cadencia.
- `whatsapp/conversations.json` guarda as conversas locais do painel.
- Nao versionar credenciais. Mantenha os valores reais somente nos arquivos `.env`.
- Os tres servicos usam o mesmo `API_KEY` para autenticar as chamadas internas.

## Horarios e cadencia

- A cadencia opera de segunda a sexta, das 10h as 19h.
- O ciclo de avaliacao ocorre a cada 10 minutos.
- A selecao tenta 70% de contatos novos e 30% de follow-ups.
- O follow-up fica elegivel apos pelo menos 20 horas do primeiro envio.

## Documentacao por servico

- [whatsapp/README.md](whatsapp/README.md)
- [scraper/README.md](scraper/README.md)
- [cadence/README.md](cadence/README.md)