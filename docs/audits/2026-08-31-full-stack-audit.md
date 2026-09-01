# BotFleet Full-Stack Audit — 31 Aug 2026

**Seat:** GROK.  **Branch:** `grok/full-stack-audit`.  **Worktree:** `~/apps/botfleet-grok-audit`.  **HEAD audited:** `d70325c` (`origin/main`).  **Issue:** #22.  **Board:** `f5abf14d`.

**Method:** Twelve specialist reviewers (web desktop, responsive viewports, Electron, iOS, harness API, computer-use/permissions, security, Cloudflare/companion, a11y/theme/copy, errors/CI/site, drivers/models, client/server state) plus independent parent verification of the highest-severity claims.  This is a read-only audit.  No product code was changed.

**In-flight PRs (do not double-fix):** #18 composer paste / Grok crash; #12 iOS model parity + avatars; #9 TryCloudflare networking.

**New board rows from this audit:** `e556f063` (P0 fallbacks), `359e1d07` (light default), `6c38e297` (Electron open-file / window-open), `cd6bf0cd` (Auto-approve / fail-open hold), `94850736` (Composio open registration), `a9683ae2` (iOS image paths), `d9bd4316` (README/site downloads), `a5dabdea` (Local VM stall idle).  Comments left on existing `d261ef00`, `92a254df`, `02ca3c98`, `12ccfacd`, `80dd2680`.

---

## Executive summary

BotFleet is a large, local-first Electron + iOS companion + loopback harness product.  Core chat, pairing, loopback Host/Origin gates, and write-only API-key UI are in good shape.  The audit found **one confirmed P0 product bug** (configured model fallbacks almost never run) and a dense cluster of **P1s** across iOS save paths, desktop paste, theme default, Electron IPC, Auto-approve, Composio broker registration, and marketing download URLs.

Owner policy misses that show up on first launch: default skin is System Auto, so a dark Mac boots Midnight; CSS `@theme` and Electron `backgroundColor` are also Midnight.  Light is supposed to be the first-visit default.

Already on THE BOARD and still true: iOS model save (`d261ef00`, worse than claimed — silent no-op, not 400), error-to-recovery (`92a254df`), closed-app alerts (`02ca3c98`), Open-from-iOS (`12ccfacd`), iMessage relay ops (`80dd2680`).

Recommended next batches (do not start all at once):

1. **Unblock advertised features:** fallbacks + iOS model persist + composer paste (#18).
2. **First-run truth:** light default, README/site download URLs, telemetry “Active” lie.
3. **Trust boundaries:** Electron `open-file` / `setWindowOpenHandler`, Auto-approve pipe-to-shell, Composio broker registration closed.
4. **iOS companion:** image attachment filesystem paths, APNs / closed-app, entitlements vs `project.yml`.
5. **Layout:** overlay Inspector/Computer/Settings below ~1100px; Settings sheet on phone.

---

## Severity legend

- **P0** — advertised feature dead, crash, or unauthenticated internet abuse of a shared secret.
- **P1** — broken core flow, silent data loss, or a trust-boundary hole on the local desktop.
- **P2** — degraded UX, dishonest copy, missing recovery, or ops drift.
- **P3** — polish, test-gap, naming leftover.

Reviewers originally tagged some layout/theme items P0.  Those are restated here at P1 unless they crash or lose data.

---

## P0 — fix first

### 1. Configured model fallbacks almost never run

- **Where:** `server/index.ts` ~1365–1384 (`turn.completed` fallback gate).
- **Evidence:** On `runtime.error` the harness always `pushMessage`s a bot `kind: "activity"` error chip.  Fallback only starts when `!produced`, and `produced` is true if any later bot `text` **or** `activity` exists after the last user message.  The error chip itself sets `produced = true`.  Settings still offers “+ Add Fallback Model”.  No integration test covers the chain.
- **Impact:** First/second/third-choice failover (a BotFleet add-on advertised on botfleet.app) does not fire on 401/429/engine-down.  Primary fails once; the chain is dead.
- **Repro:** Bot with Grok primary + Claude fallback → force primary 401/429 → error activity appears → no second engine turn.
- **Fix:** Count only assistant `text` (or successful tool output) as produced.  Ignore error/retry activity.  Add a harness test that asserts the next `instanceId` runs.
- **Confidence:** high (parent re-read the gate).

---

## P1 — core flows, trust, first-run

### Web / Electron desktop

| ID | Title | Where | Notes |
|---|---|---|---|
| W1 | Composer textarea paste can throw on null `clipboardData` | `src/components/Composer.tsx` ~587–610 | Global paste optional-chains; textarea does not.  Matches in-flight **PR #18**. |
| W2 | Image paste into focused composer runs twice | Composer window + textarea paste | Textarea does not `stopPropagation`; both call `intakeFiles`. |
| W3 | Default skin is System Auto → Midnight on dark macOS | `src/lib/skins.ts` `getDefaultSkin()` | Owner rule: first visit is **light**.  System must be an explicit choice. |
| W4 | CSS `@theme` defaults are Midnight | `src/styles.css` ~31–54 | FOUC / failed-JS paint is dark.  Electron `backgroundColor: #070707` same. |
| W5 | Draft attachment listener registered with `useState` | `src/lib/drafts.ts` ~131–143 | Cleanup never runs; StrictMode leaks; sidebar-drop → composer chips flake. |
| W6 | Hydrate wipes in-flight bot patches | `src/state/store.tsx` hydrate | Overlay exists for live SSE `bot` frames, not REST hydrate. |
| W7 | `setModel` bypasses bot patch queue | `ModelPicker.tsx` + `store.tsx` | Concurrent profile PATCH can snap the model back. |
| W8 | Unread clear races profile PATCH | `store.tsx` select / mark-read | Fire-and-forget `.catch(() => {})`; badge can return. |
| W9 | `deleteBot` leaves ghost `memberIds` in rooms | `server/store.ts` `deleteBot` | Group roster drift. |
| W10 | Optimistic `patchGroup` has no rollback | `store.tsx` | 409 while room is working leaves a lying roster. |
| W11 | Electron `setWindowOpenHandler` opens any URL | `electron/main.mjs` ~1035 | No http(s) allowlist (unlike `desktop:open-external`). |
| W12 | `desktop:open-file` / `show-in-folder` skip path containment | `electron/main.mjs` ~1293 | `save-file` is confined to `~/.botfleet`; open/reveal are not.  Windows also decodes `file://` via `URL.pathname` instead of `fileURLToPath`. |
| W13 | Packaged static file handler strips `..` naively | `server/index.ts` ~6247 | No `realpath` containment.  Loopback-only today. |
| W14 | Control-client fails **open** when hold cannot be read | `server/control-client.ts` | Take-control screenshots can leak while the harness blips. |
| W15 | Auto mode + Always-allow `Bash:curl` covers `curl \| sh` | `server/auto-approve.ts` | Destructive regex misses pipe-to-shell.  Always-allow is program-scoped.  Comments admit this is not a security boundary; Auto + local computer makes it live host risk. |
| W16 | Local VM stall path never `releaseLocalVmThread` | `server/index.ts` `onStall` | Idle fence stays set; 4 GB VM can run forever after a wedged turn. |
| W17 | Computer-dispatch errors have no recovery cards | Chat `ErrorRow`; board `92a254df` | Retry-only; still Planned. |

### iOS companion

| ID | Title | Where | Notes |
|---|---|---|---|
| I1 | Model picker Save is a **silent no-op** | `AgentProfileView.swift` + `Models.swift` CodingKeys | Board `d261ef00` said 400.  Today iOS **never encodes** `modelSelection`.  Adding the key without a server `/profile` allowlist would flip this to 400.  In-flight **PR #12**. |
| I2 | Chat images embed `/api/attachments/…` instead of disk `path` | iOS `uploadAttachment` reuses avatar URL | Agents cannot open the file.  Web uses the filesystem path from upload. |
| I3 | Room `avatarCrop` ignored by `PATCH /api/groups/:id` | `server/index.ts` ~4599 | Store and iOS send it; HTTP never copies it. |
| I4 | Closed-app alerts not implemented | `Notifications.swift`, `pushType: nil` | Board `02ca3c98`.  SSE + local notifications only. |
| I5 | Soft-keyboard Return may still insert newline | `ChatView.swift` composer | Hardware Return handled; no `.submitLabel(.send)`. |
| I6 | App is iPhone-only (`TARGETED_DEVICE_FAMILY: "1"`) | `ios/project.yml` | iPad is phone-scaled.  Do not market native iPad. |
| I7 | iOS theme follows system dark | no `preferredColorScheme` | Same light-default miss as desktop. |
| I8 | Entitlements file richer than `project.yml` | `BotFleet.entitlements` vs XcodeGen | `xcodegen generate` can drop applinks / unused critical-alerts. |

### Cloudflare / companion / site

| ID | Title | Where | Notes |
|---|---|---|---|
| C1 | Composio broker `REGISTRATION_MODE=open` on `workers.dev` | `cloudflare/composio-broker` | Anyone can `POST /v1/installations` and drive the shared project key.  Desktop defaults to that Worker URL. |
| C2 | Broker Session upgrade state is isolate memory | `ensureSession` | Cold isolates can recreate Sessions forever.  Concurrent create when `session_id` is null races. |
| C3 | Pairing replay can return a revoked device token | `companion/src/devices.ts` | 201 with a dead token → “bricked pairing” UX. |
| C4 | Phone allowlist includes `always-allow` and connector authorize | `companion/src/routes.ts` | Stolen phone token can widen Auto and attach OAuth. |
| C5 | Phone config/SSE still includes `profile.email` and `ingress.publicUrl` | `companion/src/wire.ts` | Scrub only drops `resumeCursors` / `sshAlias`. |
| C6 | README Quick start still points at OpenMausBot.dmg / `~/.openmausbot` | `README.md` | Runtime is `~/.botfleet`; docs install page is already BotFleet. |
| C7 | botfleet.app Download CTA hits source-repo Releases | `apps/site/index.html` | Artifacts live in `milind-soni/botfleet-releases`.  Docs are correct; the site is not. |
| C8 | Marketing TestFlight CTA uses undefined CSS vars | `apps/site/index.html` | `--card` / `--hairline` / `--ink-muted` are not defined. |
| C9 | Docs “Build from source” clones `milind-soni/BotFleet` | `apps/docs/.../installation.mdx` | Canonical source is `jaywedgeworth22/BotFleet`. |

### Drivers / engines

| ID | Title | Where | Notes |
|---|---|---|---|
| D1 | ACP DeepSeek/Grok/Cursor harness omits phone + dweb MCP | `server/drivers/acp/core.ts` | Claude/Codex get them.  `DWEB_URL` is injected then dropped. |
| D2 | Grok/DSH `--mcp` argv duplicates ACP `mcpServers` | `acp/grok.ts`, `acp/dsh.ts` | Names wrong (`localComputer` vs `computer`); paths with spaces break. |
| D3 | DeepSeek API cost table is ~10× low; tests lock it in | `server/drivers/deepseek.ts` | Official peak Flash is $0.44/$1.32 per 1M, not $0.07/$0.14. |
| D4 | DeepSeek picker still offers retired `deepseek-chat` / `reasoner` | same | Retired after 2026-07-24. |
| D5 | Grok Agent `isAuthenticated` ignores instance `HOME` | `acp/grok.ts` | Engine rail can lie Ready vs Sign-in. |

---

## Viewport / native layout matrix

| Surface | 375 phone | 768 tablet | 900 Electron min | 1440 default |
|---|---|---|---|---|
| Vite shell | Drawer works (`max-md`).  Fixed 400–460px rails crush chat.  Hover-only copy/speak/reply.  ~30px tap targets. | At `md` sidebar is permanent; + Inspector ≈ unusable chat. | Legal min window.  Sidebar+Inspector ≈ 120px chat.  Drawer never runs (minWidth 900 > 768). | Design target.  One rail + chat is OK. |
| App Settings | Dual-pane 190+content, fixed `h-[560px]`. | Same. | 560+padding can clip at minHeight 600. | OK. |
| Marketing site | Feature grid `minmax(290px)` overflows ~320.  CTA token bug. | Flex-wrap OK. | OK. | OK. |
| Docs | Fumadocs handles it. | OK. | OK. | OK. |
| iOS | Primary target.  Model save no-op.  Soft Return residual.  Dynamic Type mostly ignored. | — | — | — |
| iPad | Phone compatibility only. | Same. | — | — |
| Windows Electron | — | — | Unsigned NSIS; no AUMID; “This computer” tooltip lies (CUA not on Windows). | Same. |
| Linux Electron | — | — | Updater UI overclaims for `.deb`; Wayland host control correctly blocked. | Same. |

`src/styles.css` has **no width breakpoints** (only `prefers-reduced-motion`).  Responsive behavior is sparse Tailwind (`max-md` drawer, chat-header container queries).

---

## P2 themes (do not lose these)

**Recovery and honesty**

- Hydrate / settings / photo upload / secret-dismiss empty `.catch`s.  No app-level toast (`92a254df`).
- Stall watchdog stops the turn with an activity chip and **no** OS notification or recovery actions.
- Usage Settings hardcodes green “Active Telemetry” while `/api/telemetry/status` tracks `lastError`.
- Linux local-control copy says every action asks first; Auto can skip cards.
- Per-bot Local VM header can show Ready before any desktop exists.
- Windows “This computer” disabled reason says CUA is “not ready” rather than unsupported.

**Companion / notifications**

- Open BotFleet from iOS missing (`12ccfacd`).
- Live Activities `pushType: nil` → island freezes after kill.  No home-screen widgets.
- iMessage relay LaunchAgent vs host-script drift (`80dd2680`).  Site lists the daemon as Established.
- Webhook secrets live in path URLs **and** renderer `localStorage`.
- Product server can load `~/.secrets/global-api-keys` into process env (`server/config.ts`) — fleet handoff secrets in a user app.

**A11y / copy**

- Code fences always `github-dark-default`.  Routines inputs force `[color-scheme:dark]`.
- Skin picker highlights resolved Midnight/Studio, not “System Auto”.
- Hover-only message actions; color-only “needs attention” on the model rail.
- Sentence-gap misses in skin taglines.  “Agent” leaks into Speak/Call/Voice/iOS hints (product word is bot).
- App icons bake `rx` rounded rects (`public/app-icon.svg`, `build/icon.svg`, tray PNG).  Policy is full-bleed square.
- Midnight contrast failures are **known and carried** in `check-contrast.mjs` (white on accent ~3.65:1).  Advisory so CI stays green.
- App shortcuts (⌘N) fire inside the composer.

**Drivers / data**

- Grok/OpenAI-compat abort replaces the 120s timeout instead of combining (`AbortSignal.any`).
- DeepSeek reasoning streamed as assistant text.
- SSE parsers drop a final unterminated `data:` line.
- OpenAI-compat has no 429 retry.
- ACP cancel reported `ok: true` to telemetry.
- SQLite `appendMessage` mutates memory **before** commit.
- Steer queue is memory-only (queued sends die on restart).
- Boot dismisses peer cards only; provider approval cards can lock the composer after crash.
- Transcript window grows without bound while following a long computer-use turn.

**CI / ops**

- No BotFleet Sentry project (org `jays-services` has ST/CT/UM/DD/fleet-infra only).  PostHog is product analytics, not crash telemetry.
- CI does not run `oxlint`, contrast, docs build, or site build.  Windows package is `workflow_dispatch` only.
- Test floor 1070 vs ~1091 current (~21-test silent shrink allowed).
- SECURITY.md still says keys live in plaintext `config.json`; packaged app migrates to `safeStorage`.

---

## Already solid (do not “fix”)

- Harness bind `127.0.0.1` + loopback Host/Origin gate (tests assert cross-host 403).
- API keys UI is write-only (`configured` flags).
- Device tokens hashed; pairing 32-byte QR + 6-digit fallback with attempt lockout.
- iOS Keychain `AfterFirstUnlockThisDeviceOnly`.
- `save-file` containment + `O_NOFOLLOW`.
- Desktop viewer sandbox + HTTPS/loopback URL check.
- Linux Wayland host control fail-closed (issue #345) with honest copy.
- UpdateBanner error + Try again.
- Sidebar archive button already uses `max-md:opacity-100` (pattern to copy).
- Paired `/profile` **deliberately** refuses `autoApprove` / `computer` / `alwaysAllow`.  Do not widen that to privilege fields; only add a validated `modelSelection` path.

---

## Recommended fix batches

Work these as separate PRs.  Land #18 and #12 rather than rewriting them.

1. **Fallbacks actually run** + harness test (P0).
2. **Light first:** `getDefaultSkin() => "studio"`; light `@theme`; Electron `backgroundColor`; iOS `preferredColorScheme(.light)` until a picker exists; stop marketing “theme auto-switches” as the default story.
3. **Composer paste** — finish/land PR #18; also stop double `intakeFiles` and optional-chain `clipboardData`.
4. **iOS model + images + group crop** — land PR #12 if it covers encode+server; otherwise dedicated `/profile` model field + filesystem attachment path + group `avatarCrop`.
5. **Electron trust:** allowlist `setWindowOpenHandler`; confine `open-file`/`show-in-folder`; `fileURLToPath` on Windows; `setAppUserModelId`.
6. **Auto-approve:** fail closed on pipe-to-interpreter; never Always-allow network fetch tools by program name alone; control-client fail **closed** while configured.
7. **Composio broker:** `REGISTRATION_MODE=closed` in prod; persist Session upgrade in D1; add disable/rotate.
8. **Download truth:** README + `apps/site` CTA → `milind-soni/botfleet-releases`; docs clone → `jaywedgeworth22/BotFleet`; fix site CSS vars; demote Established features that still have `state: "open"` PRs.
9. **Recovery UX** — board `92a254df` as specified (toast + computer-dispatch cards + Switch-model / Add-key).
10. **Layout:** overlay right rails below ~1100px; Settings as a sheet on `max-md`; 44px tap targets; show hover-only actions on coarse pointers.

---

## Team

| Reviewer | Scope |
|---|---|
| Web desktop UI | Chat, composer, sidebar, settings, store |
| Responsive web | 375–1440, marketing, docs, Electron min |
| Electron native | IPC, updater, credentials, tray, per-OS |
| iOS companion | Swift UI, pairing, widgets, board items |
| Harness API | `server/index.ts`, schema, store, webhooks |
| Computer-use / permissions | Auto, CUA, VPS, Local VM, Android |
| Security | Secrets, IPC, broker, pairing, redact |
| Cloudflare / companion | Control-plane, broker, sidecar, tunnels |
| A11y / theme / copy | Light default, contrast, icons, VoiceOver |
| Errors / CI / site | Toast gap, test floor, README/site drift |
| Drivers / models | Fallbacks, MCP, catalogs, cost |
| State / races | Patch queue, unread, drafts, SQLite |

Independent parent checks: fallback `produced` gate, composer `clipboardData`, `BOT_PROFILE_PATCH_FIELDS`, iOS `CodingKeys`, `getDefaultSkin()`, Sentry org (no BotFleet project), open PRs #18/#12/#9.
