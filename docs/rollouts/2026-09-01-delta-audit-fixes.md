# Rollout — 2026-09-01 delta audit Batch 4 + 6

**Why:** Owner delta audit (docx, baseline `b34ac909`) asked six short batches to close the honesty gap.  This unit is Batch 4 (copy, version, Download CTA) and Batch 6 (hygiene, SECURITY.md, effort-log) plus the Composio broker rows this fileset owns (C1, C2).

**Seat:** GROK.  **Worktree:** `~/apps/botfleet-grok-delta`.  **Branch:** `grok/delta-audit-fixes`.  **Do not push `main`.**

**HEAD while implementing:** `10bfbf6` (#89 fallback streamed errors already on main).  Newer than the docx review.

## What landed

- **C7** Site Download CTA and previous-builds link now go to `Simple-With-Us/botfleet-releases`.  Mac button prefers `BotFleet.dmg` via GitHub `latest/download`.
- **C8** `--ink-muted` is defined on the site stylesheet (`#6b7280`).
- **C6** README relationship paragraph: this distribution is `Simple-With-Us/BotFleet`, a friendly fork of `milind-soni/OpenMausBot`.  Releases live in `Simple-With-Us/botfleet-releases`.  Quick start points at latest assets, not frozen `v0.1.37`.
- **Site honesty:** example fleet is Builder / Reviewer / Scout (no Director ladder).  iPhone companion, iPad compatibility mode.  Studio (light) is the first-visit theme; System Auto is a picker row.  Fallback card is Beta / in review, not "degrades automatically."  Closed-app copy says SSE + local notifications while open.  Provenance cites verified PRs only (`#89`, `#12`, `#26`) or host/main notes.
- **C1** Prod `wrangler.jsonc` `REGISTRATION_MODE` is `closed`.
- **C2** Session upgrade attempts persist on the existing D1 `installations` table (`session_upgrade_attempted`, migration `0002_session_upgrade.sql`).  Cold isolates no longer recreate Sessions forever.  Concurrent create uses a compare-and-swap `UPDATE`.
- **SEC** SECURITY.md documents packaged `safeStorage` migration and GitHub private vulnerability reporting on `Simple-With-Us/BotFleet`.  Upstream mailbox removed.
- **LOG** Resource-triggers (#65/#80) and iOS Sentry Cocoa (#55) moved to Completed with a GROK correction note.  Delta-audit implementation row is In Progress.

Audit register: `docs/audits/2026-09-01-delta-audit.md`.

## C2 D1 status

D1 was already bound (`botfleet-composio`, `database_id` 435bcde1-…).  This pass did **not** invent a new database.  It added one integer column on `installations`.  Remote `wrangler d1 migrations apply` + `pnpm broker:deploy` are still required before prod Workers pick up closed registration and the new column.

## Follow-up (not this PR)

- **Inspector / Computer / Settings overlay layout** from the 31 Aug audit.  Dedicated PR.  Do not mix with copy or broker work.
- Batch 1 fallbacks (`server/index.ts`), Batch 2 ATS (`ios/project.yml`), Batch 3 Electron trust (`electron/main.mjs`), CSS `@theme` (`src/styles.css`), `telemetry.ts` handoff-file read, DeepSeek prices, deleteBot / avatarCrop / VM stall.
- Cut a `v0.1.38` GitHub release in `botfleet-releases` when packaging is ready.  This unit does not cut one.
- Apply broker migration 0002 remotely, then deploy the Worker so C1 is live on workers.dev.

## Verify

- `pnpm broker:test`
- `node apps/site/build.mjs` regenerates `index.html` from `template.html` + `features.json`
