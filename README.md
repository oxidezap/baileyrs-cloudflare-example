# baileyrs on Cloudflare Workers

A small WhatsApp bot built with [baileyrs](https://github.com/oxidezap/baileyrs). It runs in a Durable Object, stores auth and Signal keys in SQLite-backed Durable Object storage, and replies `pong` to direct `ping` messages.

## Requirements

- A Cloudflare account on the Workers Free plan. SQLite-backed Durable Objects and their free allocation are required. Check the current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) before deployment.
- Node.js 22.3 or newer and npm.
- A WhatsApp account for pairing. Use this example only with an account you control.

The bot makes an outbound WebSocket connection to WhatsApp. Cloudflare and WhatsApp can change their runtime, account, and usage limits. This example does not promise uninterrupted connections. No Cloudflare deployment is needed to try it locally.

## Install and run

```sh
npm install
printf 'ADMIN_TOKEN="%s"\n' "$(openssl rand -hex 32)" > .dev.vars
npm run dev
```

Copy the generated token from `.dev.vars`. In another terminal, start the bot:

```sh
curl -X POST http://localhost:8787/start \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Poll `/status` until the response contains a `qr` string:

```sh
curl http://localhost:8787/status -H "Authorization: Bearer YOUR_TOKEN"
```

Render that string as a QR in your local terminal, then scan it with WhatsApp's linked-device scanner:

```sh
curl -fsS http://localhost:8787/status -H "Authorization: Bearer YOUR_TOKEN" \
  | node --input-type=module -e 'let body = ""; for await (const chunk of process.stdin) body += chunk; const { qr } = JSON.parse(body); if (!qr) throw new Error("No QR available. Check /status and retry."); process.stdout.write(qr)' \
  | npx --yes --package=qrcode@1.5.4 qrcode --small
```

The renderer runs locally. The QR is short-lived and must be kept private. Repeat the command if it expires. The response contains the QR only while pairing. Send `ping` from another WhatsApp account to receive `pong`. Group messages and messages sent by the bot are ignored.

After an object restart, the first request automatically attempts to reconnect with registered credentials already in Durable Object storage. A fresh, unpaired object remains `stopped` until you call `/start` to begin QR pairing. If a connected socket closes, later `/status` requests retry reconnection using stored credentials no more often than once every 30 seconds; `/start` remains available, with the same cooldown after non-logout disconnects.

Recovery is request-driven: no request means no new reconnect attempt. This does not guarantee an unattended, uninterrupted WhatsApp connection. If `/status` reports `logged_out`, the bot has cleared its stored credentials. Call `/start` and pair again.

The Durable Object stores credentials and Signal state. Treat its storage as a secret. Do not share status responses, QR codes, or backups.

## Deploy

Create or select a Cloudflare account with Workers Free plan access and confirm SQLite Durable Objects are available to it. Log in and set the secret, then deploy:

```sh
npx wrangler login
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

`wrangler.jsonc` creates the SQLite-backed Durable Object on migration `v1`. After deploy, replace `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev` in the commands below with the URL Wrangler prints:

```sh
curl -X POST https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/start \
  -H "Authorization: Bearer YOUR_TOKEN"
curl https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/status \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Use the same pairing and reconnection steps above with your deployed URL.

For delivery diagnostics, see the logging and tracing configuration in [wrangler.jsonc](wrangler.jsonc). The bot logs connection state, incoming event type and message count, message eligibility, reply attempts, and send outcomes. A `connected` status alone does not confirm delivery. A `sent` outcome means `sendMessage` resolved, not that the recipient received the reply. Reply failures log the error class without the error message or stack.

Keep `ADMIN_TOKEN` private. This example uses baileyrs from npm. See [package.json](package.json) for the version range and [package-lock.json](package-lock.json) for the resolved release. Test dependency updates before deployment.

## Checks

`npm run smoke:workerd` bundles the installed baileyrs `/host` entry and runs this Worker under Wrangler's local workerd runtime with `nodejs_compat` disabled. It checks the admin-token guard and Durable Object status route. It does not start a WhatsApp connection, require an account, or deploy to Cloudflare.

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm run smoke:workerd
```
