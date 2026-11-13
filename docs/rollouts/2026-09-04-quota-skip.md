# 2026-09-04 — Skip exhausted models; remaining % in Settings

**Why:** Owner wants BotFleet to know when not to use a model, and to show
remaining-percent summaries in Settings.  Chip failover after a cap is too late.

**Sources**

- Antigravity: local `antigravity-usage quota --json` every minute.  Per-model
  remaining, `isExhausted`, `resetTime`.  Gemini rows often omit remaining
  (N/A means none remains — skip until reset).
- Other engines: poll Usage Monitor `GET /api/quota-windows` when a read token
  is set.  Do not sit in front of CLIs (EasyCLIProxyAPI).  LiteLLM is unused.

**What landed**

- Cooldown persist across harness restart.
- Per-model skip until `resetAt`.  Settings Usage card shows remaining %.
- Usage Monitor read token is optional; Antigravity does not need it.

**Board:** `087cd1b0`.  **Issue:** #186.
