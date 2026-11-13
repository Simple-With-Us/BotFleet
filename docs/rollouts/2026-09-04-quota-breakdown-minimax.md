# 2026-09-04 — Quota breakdown, Cursor monthly cap, MiniMax CLI

**Why:** Owner: Antigravity Partial cap only showed ~30% on a few external
models; Cursor stayed Available after a monthly cap; MiniMax CLI was missing
from the Cloud rail.

**What landed**

- Settings → Usage quota rows expand on click and put the full remaining
  list on hover.  Antigravity lists every turn model, Gemini first, with
  omitted remaining shown as exhausted.
- Usage Monitor windows map onto `cursorAgent`.  A monthly / plan-limit skip
  records a wildcard cooldown so the engine is At Usage Cap, not Available.
- MiniMax CLI (`mmx` config + HTTP completions) is a default-fleet Cloud
  engine.  Existing product configs pick it up via `PRODUCT_FLEET_ADDITIONS`.

**Board:** `d4d3343b`.  **Issue:** #216.  **Branch:** `grok/quota-breakdown-minimax`.
