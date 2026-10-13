# BotFleet Delta Audit — 1 September 2026

**Seat:** GROK.  **In-repo landing:** Batch 4 + 6 honesty/docs/ops on `grok/delta-audit-fixes`.  **Worktree:** `~/apps/botfleet-grok-delta`.  **Issue:** #22.  **Board:** `9e922f65`.

**Source:** owner-facing docx `BotFleet-Delta-Audit-2026-09-01.docx` (read-only review of `b34ac909` after PR #82).  This markdown is the compact register plus a HEAD note.  It does not replace `docs/audits/2026-08-31-full-stack-audit.md`.

**HEAD seen while landing this file:** `10bfbf6` (`fix(server): trigger model fallback on streamed error messages`, #89).  Newer than the docx baseline `b34ac909`.  #89 narrowed P0-1 further (streamed error text can fail over) but tool `activity` with `tool.ok !== false` still counts as produced.

**Standing product rules:** 3–5 peer bots, no hierarchy.  Light is the first-visit default.  iPhone companion (iPad is compatibility mode).  Two spaces between sentences.  Never push `main`.

---

## Executive snapshot

BotFleet is a real local-first product.  The honesty gap is between botfleet.app / README / SECURITY.md and what main actually does.  Roughly fifty PRs landed between the 31 Aug audit (`d70325c`) and the docx review (`b34ac909`).  Several advertised-dead features moved.  The Aug 31 P0 is narrower, not gone.

| Bucket | Count | What it is |
|---|---|---|
| P0 remaining | 1 | Model fallbacks.  Error chips and some streamed error text no longer block.  Other activity still does. |
| P1 new | 1 | iOS ATS.  PR #81 set `NSAllowsArbitraryLoads` and cleartext-excepted botfleet.app. |
| P1 still open | ~15 | Electron window-open / open-file, Composio open registration, avatarCrop drop, deleteBot ghosts, VM stall lease, Auto pipe-to-shell, CSS Midnight, closed-app push, iOS image paths, client races. |
| P2 cluster | Unchanged+ | Site / README / effort-log / SECURITY.md / pricing / telemetry / layout, plus circular self-fork README. |

Recommended posture from the owner docx: stop adding add-ons.  Close the honesty gap in six short batches.  This seat landed Batch 4 (copy/version/CTA) and Batch 6 (hygiene/SECURITY/effort-log) plus C1/C2 from Batch 5 that this fileset owns.

---

## Compact finding register

Status column is versus **HEAD `10bfbf6`**, with the docx `b34ac909` state in parentheses when it changed.

| ID | Sev | Status | One-line |
|---|---|---|---|
| P0-1 | P0 | PARTIAL | Fallbacks.  #89 streamed errors.  Tool activity and some room paths still block. |
| W1 | P1 | FIXED | Composer `clipboardData` null throw. |
| W2 | P1 | FIXED | Double image paste intake. |
| W3 | P1 | PARTIAL | `getDefaultSkin` = studio.  CSS `@theme` still Midnight.  iOS still system. |
| W4 | P1 | OPEN | CSS `@theme` Midnight FOUC.  Other seat owns `src/styles.css`. |
| W5 | P1 | OPEN | `drafts.ts` listener via `useState`. |
| W6 | P1 | OPEN | Hydrate wipes live bot patches. |
| W7 | P1 | OPEN | `setModel` bypasses patch queue. |
| W8 | P1 | OPEN | Unread / profile PATCH race. |
| W9 | P1 | OPEN | `deleteBot` ghost `memberIds`. |
| W10 | P1 | OPEN | Optimistic `patchGroup`, no rollback. |
| W11 | P1 | OPEN | Window-open any URL.  #31 missed it. |
| W12 | P1 | OPEN | `open-file` / reveal unconstrained. |
| W13 | P2 | OPEN | Static handler `..` strip, loopback-only. |
| W14 | P1 | OPEN | Control-client fail-open. |
| W15 | P1 | OPEN | Auto-approve misses pipe-to-shell. |
| W16 | P1 | OPEN | VM stall does not release lease. |
| W17 | P1 | OPEN | No computer-dispatch recovery cards. |
| I1 | P1 | FIXED | iOS `modelSelection` now encodes. |
| I2 | P1 | OPEN | iOS image attachment path shape. |
| I3 | P1 | OPEN | Group `avatarCrop` dropped on PATCH. |
| I4 | P1 | OPEN | Closed-app push.  `pushType` nil. |
| I5 | P2 | PARTIAL | Soft Return.  Not device-retested here. |
| I6 | P2 | OPEN at review | iPhone-only.  Site said iPad; Batch 4 copy fix in this PR. |
| I7 | P1 | OPEN | No iOS light default. |
| I8 | P2 | WATCH | Entitlements vs `project.yml`.  #81 made this worse. |
| NEW-ATS | P1 | NEW | `NSAllowsArbitraryLoads` true.  Other seat. |
| C1 | P1 | THIS PR | Composio `REGISTRATION_MODE=closed` in prod vars. |
| C2 | P1 | THIS PR | Session upgrade flag persisted on existing D1 `installations` row. |
| C6 | P2 | THIS PR | README is a fork of `milind-soni/OpenMausBot`.  Downloads point at the current release location. |
| C7 | P1 | THIS PR | Site Download CTA and previous-builds link point at the current release location. |
| C8 | P2 | THIS PR | `--ink-muted` defined. |
| D2 | P2 | OPEN | ACP `--mcp` argv spaces / name mismatch. |
| D3 | P1 | OPEN | DeepSeek UI vs billing 10× apart. |
| D4 | P2 | OPEN | dsh offers retired `deepseek-chat` / `reasoner`. |
| TEL | P2 | PARTIAL | Telemetry badge.  Error path only. |
| SEC | P2 | THIS PR | SECURITY.md documents `safeStorage` and GitHub private reporting. |
| HAND | P2 | OPEN | `telemetry.ts` reads `~/.secrets/global-api-keys`.  Other seat. |
| LOG | P2 | THIS PR | Effort-log #65/#80 and #55 moved to Completed. |

---

## Recommended batches (from the owner docx)

1. **Fallbacks actually run (P0).**  Other seat owns `server/index.ts`.  #89 landed streamed-error failover; remaining: ignore tool activity, room turns, harness tests.
2. **PR #81 ATS rollback and iOS truth.**  Other seat owns `ios/project.yml`.  Closed-app push stays a separate project.
3. **Electron trust, for real.**  Other seat owns `electron/main.mjs`.
4. **First-run light, copy, version.**  CSS `@theme` is another seat (`src/styles.css`).  Copy, CTA, roster, provenance, README fork paragraph are this PR.
5. **Data and permissions.**  `deleteBot`, `avatarCrop`, VM stall, Auto-approve are other seats.  Composio C1/C2 are this PR because this fileset owns the broker.
6. **Hygiene.**  Effort-log, SECURITY.md, this audit markdown.  Layout overlay is **follow-up**, not mixed into this unit.

---

## Already solid — do not "fix"

Loopback Host/Origin gate.  Write-only API-key UI.  Device tokens hashed.  iOS Keychain AfterFirstUnlockThisDeviceOnly.  Linux Wayland host control fail-closed.  Paired `/profile` refuses `autoApprove` / `computer` / `alwaysAllow`.  Sentry project `jays-services/botfleet` exists.

---

## Sources

- Owner docx: `/Users/jay/Desktop/BotFleet-Delta-Audit-2026-09-01.docx`
- Baseline: `docs/audits/2026-08-31-full-stack-audit.md` and issue #22
- Canonical source: maintained in the private operations record
- Upstream: `milind-soni/OpenMausBot`
- Releases: current release location (private operations record)
- TestFlight: `testflight.apple.com/join/ER6sPNMh`
