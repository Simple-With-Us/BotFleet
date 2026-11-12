# BotFleet connected-apps broker

A hosted Cloudflare Worker that keeps the shared Composio project API key off
the desktop.  Each installation receives a hashed bearer token in D1, the
Worker proxies MCP traffic, and Connect Links are returned on demand.

## Self-host without this Worker (recommended for solo owners)

The Worker exists for multi-tenant setups.  If you are a single owner and
already keep `~/.botfleet/config.json` or your server env private, you do
not need any Cloudflare resource:

1. Get a Composio project key (`ak_…`) from <https://app.composio.dev>.
2. Set it in `~/.botfleet/config.json`:

   ```json
   {
     "composio": {
       "apiKey": "ak_replace_me"
     }
   }
   ```

   or in the packaged-app plist (`OMB_COMPOSIO_API_KEY`) or a server env
   variable (`COMPOSIO_API_KEY`).
3. Restart the desktop app.  App Settings → Connections will let you link
   Gmail, Slack, GitHub, etc.  No Worker, no D1, no rate-limit namespaces.

If you want to share a Composio project key across multiple installs
without writing it to disk on any of them, that is the only case this
Worker is for.

## Running the Worker on your own Cloudflare account

The checked-in `wrangler.jsonc` is non-deployable scaffolding.  All real
D1 / rate-limit / Cloudflare-account identifiers were stripped (see the
file header) because the original values pointed at upstream OpenMausBot's
Cloudflare account (`milindsoni201`) and BotFleet does not have access to
that account.

To host the Worker on a fleet-owned Cloudflare account:

1. `pnpm broker:types`
2. `pnpm exec wrangler d1 create botfleet-composio` — paste the returned
   `database_id` into `wrangler.jsonc`.
3. `pnpm exec wrangler ratelimit namespace create REGISTRATION_LIMITER`
   and `pnpm exec wrangler ratelimit namespace create SESSION_LIMITER` —
   paste each `namespace_id` into `wrangler.jsonc`.
4. `pnpm exec wrangler secret put COMPOSIO_API_KEY --config cloudflare/composio-broker/wrangler.jsonc`
   (interactively paste the `ak_…` key when prompted).
5. `pnpm broker:deploy`.

The Worker name becomes `botfleet-composio.<your-account>.workers.dev`
(or a custom domain if you add a route).  Set `OMB_COMPOSIO_BROKER_URL`
in your packaged build to that origin.

## Operational notes

- `REGISTRATION_MODE=closed` is the default in the checked-in config.  New
  installs cannot self-register against a stranger's Worker.  Existing
  installations (those whose SHA-256 bearer hash is already in your D1)
  keep working.
- Session upgrade state persists on the existing D1 `installations` row
  (`session_upgrade_attempted`).  Apply migration `0002_session_upgrade.sql`
  before or with the next deploy.
- Do not reuse the IDs from any prior fork — they live in someone else's
  account.  Create fresh resources on your own.
