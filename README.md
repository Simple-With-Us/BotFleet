
<div align="center">

# BotFleet

**Choose an Engine for Each Bot.**<br>
**Bring the Accounts and Tools You Configure.**

<sub>A friendly fork of <a href="https://github.com/milind-soni/OpenMausBot">OpenMausBot</a> — run a coordinated team of bots on your own computer, with an iPhone companion.  Every BotFleet-layer add-on is in testing.</sub>

<br>
<br>

<a href="https://botfleet.app"><b>botfleet.app</b></a> &nbsp;·&nbsp; <a href="https://testflight.apple.com/join/ER6sPNMh">iPhone companion on TestFlight (public beta)</a> &nbsp;·&nbsp; <a href="https://simplewithus.com/">From Simple With Us</a> &nbsp;·&nbsp; <a href="https://github.com/Simple-With-Us/BotFleet">source</a> &nbsp;·&nbsp; <a href="https://github.com/milind-soni/OpenMausBot"><b>upstream OpenMausBot</b></a>

</div>

## What BotFleet Adds

These are features this fork layered on after OpenMausBot.  **All of them are in testing** — some are used regularly on this fleet, and their behavior and setup may change.  Card-by-card provenance lives at **[botfleet.app](https://botfleet.app)**.

### Messaging, companion, and desktop

- **iMessage relay** — a Mac relay can connect bot group chats in Messages.app to BotFleet while its host service is running.
- **iOS companion (public TestFlight)** — pairs with a running Mac host to show conversations and approvals.  Notification behavior depends on the Mac sidecar and iOS permissions; iPad runs in compatibility mode.
- **Nested conversations under channels** — renameable task threads live under their channel, can be moved, searched, and collapsed, with a custom word for "room" if you want one.
- **Chat bubble and request-ID copy** — click a bubble to copy its text; hover and right-click also copy Request ID or Message ID.
- **macOS menu bar tray** — a menu-bar extra keeps BotFleet reachable while the window is hidden.
- **System Auto default** — first visit follows this computer's light or dark look (Studio in light, Midnight in dark).  User Auto follows the same computer look with the light and dark themes you pick.  Manual theme rows stay available.  Code fences follow the painted theme so they stay readable.
- **Always-on harness attach** — the desktop app attaches to an already-running BotFleet harness instead of forking a second one.

### Engines, failover, and telemetry

- **Native DeepSeek driver** — DeepSeek models join the engine list via a native driver plus the dsh bot, with in-app rates and token pricing.
- **Antigravity engine, including the Gemini models** — Antigravity is the engine; it serves Google's Gemini 3.7/3.8 Flash catalog alongside its own models.  There is no separate "Gemini engine" in the picker — see [Engines](#engines) below.
- **Multi-tier model fallbacks** — first, second, and third choice models per bot.  Quota, usage-cap, and session-limit chips fail over to the saved chain automatically, including after tools already ran and in rooms.  Other streamed error paths are still in review.
- **Elapsed turn timer** — a live timer on the in-progress turn, plus duration on completed activity runs.
- **Usage telemetry** — live token consumption (prompt, completion, cache hits) and model costs stream to a Usage Monitor instance you configure, with project and repo classification.  Working-directory classification uses the folder **basename only**, never the full path.
- **Provider marks and picker filtering** — official-style marks for Grok, Claude, DeepSeek, Gemini/Antigravity, and others; unconfigured models stay out of the picker.

### Fleet ops, memory, and automation

- **Fleet Recall** — bots search and contribute to a shared memory store instead of a private hash-proxy index.
- **Fleet MCP tools** — list and answer approvals, `open_app`, routines, webhooks, decision-log tools, and idempotent sends for external MCP clients.
- **Multi-repo channels and file links** — a channel can attach several repositories with automatic context injection.  Local file links open in the default Mac app, or reveal in Finder on Option-click.
- **Resource-threshold triggers** — sample local disk, RAM/swap, and optional CPU load and enqueue the same kind of task a routine would when a threshold is crossed.
- **TryCloudflare, Tailscale, and custom domains** — a free `*.trycloudflare.com` URL from Settings, Tailscale MagicDNS for phone linking, or a Cloudflare token for a custom domain.  Custom webhook ingress can sit on its own domain with token validation.
- **Mid-task crash and restart recovery** — interrupted turns and mid-flight tool executions are detected on boot so work can resume instead of sitting stuck.
- **One-command TestFlight ship** — signing, archive, and upload from the Mac build environment.

None of the items above are "done."  Treat them as a testing list.

## Engines

`server/drivers/builtIn.ts` currently registers **18 engines**.  The table below is the real list — it is generated from that registry, not from a hand-kept marketing list, so if you add a driver this section is the thing to update.

| Engine | Driver | Talks to |
|---|---|---|
| Claude Code | `drivers/claude.ts` | local `claude` CLI, your login |
| Codex | `drivers/codex.ts` | local `codex` CLI, your login |
| Grok CLI | `drivers/grok.ts` | xAI API or local CLI |
| Grok (ACP) | `drivers/acp/grok.ts` | Agent Client Protocol |
| DeepSeek | `drivers/acp/deepseek.ts` | Agent Client Protocol |
| DSH (DeepSeek Harness) | `drivers/acp/dsh.ts` | Agent Client Protocol |
| Kimi | `drivers/acp/kimi.ts` | Agent Client Protocol |
| MiniMax M Code | `drivers/acp/mcode.ts` | Agent Client Protocol |
| Factory Droid | `drivers/acp/droid.ts` | Agent Client Protocol |
| Cursor | `drivers/acp/cursor.ts` | Agent Client Protocol |
| OpenCode | `drivers/acp/opencode-go.ts` | Agent Client Protocol |
| Qwen | `drivers/acp/qwen.ts` | Agent Client Protocol |
| Hermes | `drivers/acp/hermes.ts` | Agent Client Protocol |
| pi | `drivers/pi.ts` | local agent runtime |
| Antigravity | `drivers/antigravity.ts` | Antigravity — **also serves the Gemini 3.7/3.8 Flash models** |
| MiniMax | `drivers/minimax.ts` | MiniMax API (`MINIMAX_API_KEY`) |
| OpenAI-compatible | `drivers/openai-compat.ts` | any endpoint you point it at |
| Box | `drivers/boxagent.ts` | ascii.dev cloud computer |

Two things worth knowing before you read a model picker:

- **Gemini is a model, not an engine here.**  The Gemini 3.7/3.8 Flash entries come from the Antigravity driver's catalog (`server/antigravity-models.ts`) and appear under Antigravity.  There is no separate Gemini engine in the registry.
- **Adding one is deliberately cheap.**  The driver SPI in `server/contracts.ts` is small on purpose: write `server/drivers/<name>.ts` and append one line to `BUILT_IN_DRIVERS`.

Some engines need a key (xAI, OpenAI-compatible, MiniMax, DeepSeek, Box, OpenCode) and the rest run against a CLI you have already logged into.  Composio is a separate tool integration, not an engine.  Unconfigured models stay out of the picker.

## From OpenMausBot

BotFleet is a friendly fork of **[OpenMausBot](https://github.com/milind-soni/OpenMausBot)** by Milind Soni and contributors.

**Upstream source (prominent on purpose):** [https://github.com/milind-soni/OpenMausBot](https://github.com/milind-soni/OpenMausBot)

When we forked, that project already shipped the core app this repo still runs on:

- **Bring-your-own engines** — bots run on `claude`, `codex`, and `grok` CLIs installed on your machine (your logins and subscriptions, no proxy in the middle), with a custom-binary override in Settings → Engines.  Cursor and OpenCode engines were already in the box.  This fork has since grown the engine list well past that — see [Engines](#engines) for what is registered today.
- **Local-first harness** — one small server on `127.0.0.1` owns every bot process.  Transcripts, keys, and events live on disk, not a vendor cloud.
- **Per-bot model picker** — a provider rail, defaults marked, unavailable providers dimmed with the reason.  Switch a bot's model mid-conversation.
- **A computer per bot** — cloud Linux desktop (Box), isolated Local VM, or this computer after explicit opt-in, with a live screen preview and browser takeover.
- **Approval cards** — shell commands, file edits, and questions surface as Allow / Deny / answer-in-chat.  A permission broker turns risky actions into decisions you make.
- **Connected apps** — a Composio marketplace (Gmail, Slack, GitHub, Notion, Linear, and hundreds more).  OAuth once, every bot can use them as tools.
- **Messaging-app roster** — pin, mark unread, edit profile, duplicate, copy conversation ID, hide, delete.  Bots behave like contacts.
- **Keys once** — paste credentials in App Settings; they persist locally and the provider fleet hot-reloads.  The UI only ever sees "configured" flags.
- **Channels** — Work, Personal, and each project in separate channels without cloning bots.  Each channel has its own transcript, shared instructions, working folder, responder rules, and roster.
- **Team import from one Markdown file** — browse outcome-driven teams (BotMRR), review, then create bots, Chief of Staff, channels, playbooks, connector checklist, and suggested routines.  File or GitHub URL import too.  Packages never carry credentials, conversations, permissions, memory, or computer access.
- **Voice** — ElevenLabs TTS on any reply, per-bot voices, and a macOS call mode that uses on-device dictation.
- **Streaming tool-run chips**, native macOS dictation from the composer mic, cursor mascots, and screenshots of the bot's work folded into the transcript.
- **MCP control plane** — a stdio MCP server for Claude Desktop / Cursor to inspect bots and channels, page transcripts, create work, wait, switch models, and interrupt.  It does not expose approval grants, deletion, arbitrary settings, credentials, or computer lifecycle.
- **Routines and webhooks** — one-shot or weekday schedules, plus a dedicated webhook receiver on `127.0.0.1:8800`.
- **Desktop shells** — packaged macOS, Windows, and Ubuntu 24.04 apps with an embedded harness.

See the [OpenMausBot repository](https://github.com/milind-soni/OpenMausBot) for the current upstream project, including later changes this fork has not pulled.

## Quick start

**Released builds ([latest](https://github.com/Simple-With-Us/BotFleet/releases/latest)):** the harness server is embedded, so no separate server setup is required.  Desktop numbering matches iOS (`1.0.x`).  This page always points at the latest packaged assets rather than a frozen tag, so it tracks whatever is actually published.

| | Download | Install |
|---|---|---|
| **macOS** (Apple silicon) | [BotFleet.dmg](https://github.com/Simple-With-Us/BotFleet/releases/latest/download/BotFleet.dmg) | Drag it to Applications, open it.  Signed with the BotFleet Developer ID. |
| **macOS** (Intel) | [BotFleet-intel.dmg](https://github.com/Simple-With-Us/BotFleet/releases/latest/download/BotFleet-intel.dmg) | Same app, built for Intel Macs. |
| **Windows** (x64) | Not published yet | The Windows installer is built by the release workflow but no Windows build has shipped.  Watch the [releases page](https://github.com/Simple-With-Us/BotFleet/releases) or build from source below. |
| **Ubuntu 24.04** (x64) | Not published yet | Ubuntu packages are built by the release workflow but no Ubuntu build has shipped.  See the [Ubuntu Desktop guide](docs/linux-desktop.md) to build one from source. |

In-app **Check for updates** reads `latest-mac.yml` from the GitHub release.

| | Value |
|---|---|
| Published release / tag | **v0.1.38** (the only tag) |
| Update feed | **shipped** — that release carries `latest-mac.yml` alongside four DMGs.  The feed lists the two versioned ones (`BotFleet-0.1.38-arm64.dmg`, `BotFleet-0.1.38-x64.dmg`); the stable `BotFleet.dmg` and `BotFleet-intel.dmg` the download links above point at are there too.  No zip payload is published, so in-app updates install the DMG. |
| `package.json` version on `main` | `1.0.31` |
| iOS companion `MARKETING_VERSION` | `1.0.30` |

`main` is ahead of the last cut, so **the build the download links above hand you is v0.1.38**, not `1.0.31`.  Desktop and iOS are numbered independently and currently differ by one patch.

See the [Ubuntu Desktop guide](docs/linux-desktop.md) for installation, capabilities, and troubleshooting.

**From source:**

```sh
git clone https://github.com/Simple-With-Us/BotFleet && cd BotFleet
pnpm install

pnpm dev:server    # harness server → 127.0.0.1:8799
pnpm dev           # app → http://127.0.0.1:5199
pnpm dev:desktop   # Electron shell; keep the two commands above running
```

Requirements: **macOS, Windows, or Ubuntu 24.04 x64**, **Node 24+**, **pnpm**, and at least one bot CLI — [`claude`](https://claude.com/claude-code),
[`codex`](https://github.com/openai/codex), or [`grok`](https://x.ai/cli) — installed and logged in.  They appear
in the model picker automatically.

Package the desktop application:

```sh
pnpm package:mac      # macOS: DMG + ZIP; requires Swift/Xcode tools
pnpm package:win      # Windows: installer + ZIP
pnpm package:linux    # Ubuntu x64: .deb + AppImage + verified CUA runtime
```

### Desktop capability status

| Capability | macOS | Ubuntu 24.04 Xorg | Ubuntu 24.04 Wayland |
|---|---|---|---|
| Packaged app, embedded harness, local bot CLIs | Supported | Beta | Beta |
| Composio and Box/cloud computers | Supported | Beta | Beta |
| Explicit preview-only local screen capture | Supported | Beta | Beta |
| Bot control of this computer | Supported | Beta, explicit opt-in | Disabled: Wayland safety gate |
| Native on-device dictation | Supported | Planned | Planned |

The Linux preview is user-initiated and never enables local bot control or Auto routing.  On Xorg, the reviewed Cua Driver 0.19.3 runtime starts only after explicit opt-in and without its full-screen cursor overlay.  On Wayland the app never starts it and clears legacy opt-ins while that real-seat safety gate remains unresolved.  Chat, preview, Cloud, and Local VM remain available on both sessions.  See the [Ubuntu Desktop guide](docs/linux-desktop.md) and tracking issues [#29](https://github.com/Simple-With-Us/BotFleet/issues/29) and [#113](https://github.com/Simple-With-Us/BotFleet/issues/113).

The Linux packager downloads only the tag-pinned upstream archive during the build, verifies its size, SHA-256, complete member allowlist, and inner executable hashes, then packages only the CLI and cursor-theme sidecar.  The installed app never downloads or self-updates native automation code.  Cua's MIT notice, Inter's SIL OFL, a generated third-party license report, and a CycloneDX inventory ship with the runtime.  See [`third_party/cua-driver/`](third_party/cua-driver/) for the reviewed provenance record.

These credentials are optional — local chat works without them.  Paste a key once in **App Settings** (gear in the sidebar footer) when you want to enable its integration:

| Credential | What it enables | Where to get it |
|---|---|---|
| Composio project key (`ak_…`) | Connect Gmail, GitHub, Slack, Notion, and other apps to your bots | [BotFleet Composio setup](docs/composio.md) |
| Box API key | Give bots an isolated remote Linux computer with a desktop and terminal | [Box API key guide](https://docs.ascii.dev/box/api-keys) |
| ElevenLabs key | Read replies aloud, and call your bots | [ElevenLabs API keys](https://elevenlabs.io/app/settings/api-keys) |

**"Box" here means [ascii.dev](https://ascii.dev)'s cloud computer product** — the dashboard is `box.ascii.dev`, the API is `https://ascii.dev/api/box/v1`, and its keys start with `box_`.  It is **not** Box Inc. (`box.com`), and the two keys are not interchangeable.

Composio is a third-party service with its own account and terms.  ascii.dev's Box needs a paid plan before it will create a computer, and using a cloud computer may incur charges from your provider.

```sh
pnpm typecheck     # app + server
pnpm test          # unit, driver, API, and desktop capability tests
pnpm build         # typecheck + production build
pnpm check:electron # syntax-check Electron main/preload files
pnpm package:win   # Windows installer + zip → release/
pnpm package:linux # Ubuntu x64 .deb + AppImage → release/
```

### Routines, webhooks, and resource triggers

Routines can run once or on selected weekdays, using either a bot's configured model/computer or the Cloud VM runner.  Webhook triggers are independent from schedules but reuse the same queued task executor and calendar receipts.  Resource triggers sample local disk, RAM/swap, and optional CPU load while BotFleet is running and enqueue the same kind of task when a threshold is crossed.

BotFleet starts a webhook-only receiver on `127.0.0.1:8800` by default (or one port above `OMB_PORT`).  Set `OMB_WEBHOOK_PORT` to choose another port.  A webhook secret is shown once when the trigger is created or rotated.  Bearer authentication is recommended so the secret stays out of request URLs and most access logs; a single capability URL remains available for senders that cannot configure headers.  The receiver exposes only `/health` and secret `/hooks/...` endpoints; it never exposes the app's broader API.  BotFleet must remain running to accept a delivery.  For public internet delivery and mobile app access, BotFleet offers **TryCloudflare (Free URL)** integration in Settings.

### Remote Access, Mobile App, and Webhooks

To connect the BotFleet iOS app or receive public internet webhooks while the app is running on your Mac, you have three options:

1. **TryCloudflare (Free URL)** (recommended for webhooks): BotFleet can spin up a Cloudflare Tunnel and give you a `*.trycloudflare.com` URL.  Toggle it on in Settings.  No Cloudflare account or custom domain is required.
2. **Tailscale**: for phone linking without public webhooks, Tailscale is supported out of the box via MagicDNS.
3. **Custom Domain**: bring your own Cloudflare API token to route traffic through a custom domain (Cloudflare Zero Trust plus DNS).

See [MCP server setup and tool reference](docs/mcp-server.md) for the stdio control plane.

## Status

Early but real — the loop works end to end: message → bot → streamed reply → tools → approvals → computer use.

- **macOS is the only released platform.**  The published build is **v0.1.38** (Apple Silicon and Intel DMGs).  Windows and Ubuntu packages are produced by CI but **no Windows or Ubuntu build has ever shipped** — see the download table above.
- **Ubuntu is beta**, with the capability limits in the table earlier in this file.
- **Hosted/mobile connectivity is still being built.**  The iOS companion is on public TestFlight.
- **Voice needs an ElevenLabs key**, and calls are macOS-only for now (they ride the same on-device dictation as the composer mic) — see [`docs/voice-mode.md`](docs/voice-mode.md).
- The engine list is much larger than the one the project started with — see [Engines](#engines).

Every BotFleet-layer add-on listed above is in testing.

Contributions welcome — the driver SPI in [`server/contracts.ts`](server/contracts.ts) is deliberately small; adding a provider is one file in [`server/drivers/`](server/drivers/) plus a one-line registration.

## License

[Apache License 2.0](LICENSE) © 2026 Milind Soni and BotFleet contributors.

Packaged Cua Driver components retain their upstream MIT, SIL OFL 1.1, MPL-2.0, and other dependency terms; the corresponding notices, license texts, source locations, and SBOM are in [`third_party/cua-driver/`](third_party/cua-driver/) and ship beside the native runtime.

BotFleet is an independent, open-source project inspired by Grok Bot.  It is not affiliated with, endorsed by, or associated with xAI; "Grok" is a trademark of its respective owner.
