# Antigravity Gemini + Third-Party quotas; Bot Profile avatar drop

**Date:** Mon, Sep 8, 2026  
**Seat:** BF-FIXER  
**Board:** `2bf6c493`  
**Branch:** `fixer/quota-gemini-avatar-drop`  
**Worktree:** `~/apps/botfleet-fixer-quota-avatar`

## Why

Antigravity remaining-percent is two numbers (Gemini vs everything else), not a per-model list.  Bot Profile avatars could be picked from a file dialog but not dropped onto the avatar box, and HEIC/BMP/SVG were refused after upload.

## What landed

- Settings → Usage Antigravity rows show only **Gemini** and **Third-Party**, including the expanded panel and hover text.
- Bot Profile avatar box is a drop target (and click-to-pick).  GIF, HEIC, BMP, SVG, plus PNG/JPEG/WebP/AVIF.  SVG is served with nosniff and a sandbox CSP.

No TestFlight.  No DMG.  Live Mac app needs `update-botfleet.sh` after merge.

## Verify

```bash
cd ~/apps/botfleet-fixer-quota-avatar
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm exec vitest run src/lib/quota-display.test.ts src/lib/composer-attachments.test.ts server/attachments.test.ts server/bot-avatar.test.ts
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm exec tsc -b
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm exec tsc -p tsconfig.server.json
cd ios && swift test --filter ChatAttachmentTests
```
