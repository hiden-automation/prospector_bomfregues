# WhatsApp

## Inicializacao

```powershell
Copy-Item .env.example .env
npm install
node index.js
```

Antes de iniciar, preencha o `.env` com `API_KEY`, `WA_PHONE_NUMBER_ID`, `WA_ACCESS_TOKEN` e `WA_WEBHOOK_VERIFY_TOKEN`. O servico escuta por padrao em `http://localhost:3000`.

Em outro terminal, ainda nesta pasta, crie o tunel publico:

```powershell
.\cloudflared.exe tunnel --url http://127.0.0.1:3000
```

Depois de copiar a URL HTTPS gerada, atualize:

- **OneSignal:** a URL publica/base do site ou painel deve usar a URL do tunel. O painel fica em `https://URL_DO_TUNEL/chat`.
- **Meta for Developers > WhatsApp > Configuration:** configure o callback URL como `https://URL_DO_TUNEL/webhook` e use o mesmo valor de `WA_WEBHOOK_VERIFY_TOKEN` no campo de verificacao.

Se o Cloudflare gerar uma nova URL, repita essas configuracoes. O `cloudflared.exe` desta pasta precisa continuar aberto enquanto o painel e o webhook estiverem em uso.

## Funcionalidades

- Envio de mensagens de texto e templates pela WhatsApp Cloud API.
- Recebimento de mensagens e status de entrega pelo webhook da Meta.
- Painel web protegido por `DASHBOARD_ACCESS_TOKEN` em `/chat`.
- Notificacoes de novas mensagens e falhas pelo OneSignal.
- Comunicacao em tempo real no painel via Socket.IO.

## Variaveis principais

Consulte `.env.example`. As mais importantes sao:

- `API_KEY`: autentica chamadas internas, incluindo o envio feito pela `cadence`.
- `ORCHESTRATOR_URL`: URL da cadencia, normalmente `http://localhost:4000`.
- `WA_PHONE_NUMBER_ID` e `WA_ACCESS_TOKEN`: credenciais da WhatsApp Cloud API.
- `WA_WEBHOOK_VERIFY_TOKEN`: token usado na verificacao do webhook da Meta.
- `WA_TEMPLATE_LANG`: idioma dos templates, por padrao `pt_BR`.
- `DASHBOARD_ACCESS_TOKEN`: chave de acesso ao painel.
- `ONESIGNAL_APP_ID` e `ONESIGNAL_REST_API_KEY`: credenciais das notificacoes.

## Rotas importantes

- `/login`: tela de autenticacao.
- `/chat`: painel protegido.
- `POST /send`: endpoint interno usado pela cadencia.
- `GET /webhook`: verificacao do callback da Meta.
- `POST /webhook`: mensagens recebidas e status de entrega.

## Persistencia

As conversas ficam em `conversations.json`. O arquivo e criado automaticamente se nao existir; faca backup antes de limpar ou substituir esse arquivo.