# 2026-09-04 — Usage Monitor settings Save and Test Connection

**Why:** Owner: Settings → Usage Monitor URL and ingest token had no Save or
Test control, and the values did not stay saved.

**Cause:** `saveConfig()` merged a fixed list of config sections into
`~/.botfleet/config.json` and that list omitted `usage` (and `qdrant`).
`PATCH /api/config` with `{ usage }` therefore never wrote the file.  The
panel then reloaded empty fields from GET `/api/config`.  Token fields also
saved on blur, so an empty password box could have wiped a stored token once
persist actually worked.

**What landed**

- `saveConfig()` merges `usage` and `qdrant` like the other sections.  A
  URL-only patch keeps the stored ingest/read tokens.
- PATCH rejects a scheme-less Usage Monitor URL with a 400.
- Settings → Usage has Save and Test Connection.  Save writes the URL and any
  typed tokens.  Blank token fields keep the stored secret.  Test Connection
  saves first, then POSTs a one-token probe to `/api/ingest/usage` and shows
  whether Usage Monitor accepted it.
- GET `/api/config` still never echoes tokens (`hasToken` / `hasReadToken`
  only).

**Board:** `5c0ee072`.  **Issue:** #191.  **Branch:** `grok/usage-monitor-save`.
