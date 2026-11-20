# Tashkent Commercial AI

The Cloudflare Worker in `src/index.js` contains the Gemini and Reels integration. The repository also retains the Python polling bot and its `Procfile` because the active hosting setup has not been confirmed. Do not run polling and the Worker webhook simultaneously with the same Telegram token. Confirm the active host and Telegram webhook before retiring either entry point.

The Worker requires `TELEGRAM_TOKEN` for Telegram replies. Text analysis additionally requires `GEMINI_API_KEY`. Media storage and `/clear` require the `REELS_KV` binding. `/render` additionally requires `GITHUB_TOKEN` with permission to dispatch the repository workflow.

Webhook authentication is backward-compatible: while `TELEGRAM_WEBHOOK_SECRET` is unset, existing webhook requests continue to work. To enable verification, configure the same secret as the Worker secret and as Telegram's webhook `secret_token`; requests with a missing or incorrect `X-Telegram-Bot-Api-Secret-Token` header then receive HTTP 401. Configure both sides together to avoid interrupting delivery.

Run the local checks with `npm test` and `npm run check` (Node.js 20 or newer).
