# Remote CLI, Compute Offload, and Self-Hosted Harness Paths

Research for an owner question, 2026-10-07.  This is a read-only survey of `origin/main` at `2957a79e2`, plus vendor docs.  No code changed.

The question has three parts:

- Can BotFleet run a CLI on another computer over SSH, the way Codex drives the Coolify box?
- Can it offload compute or resource needs to other devices, nearby or far away?
- Can users host their own "cloud" chats on their own servers?

**Labels used below:**

- **Exists today:** it ships on `main`.
- **Zero code:** it works now with configuration only, but only well enough for a demo.
- **Proposed:** it needs new code.  File and function names are suggestions, not files that exist.
- **Upstream:** it exists in OpenMausBot but not in BotFleet.  OpenMausBot uses the same Apache-2.0 license and is credited in `NOTICE`.  The merge-base is `677538eb8`, and upstream is 2,080 commits ahead.
- Vendor claims carry a source tag: **[official]**, **[issue]**, **[3p]** (third party), or **[snippet]** (search summary only).

> **Check first: the existing tunnel.**  `docs/rollouts/2026-09-06-remote-access.md` says `https://botfleet.jays.services` reaches the harness on `:8799` behind Cloudflare Access, with `/api/health` public.  The loopback Host gate at `server/index.ts:9838-9849` runs at the top of the request handler, before every route including `/api/health`.  So if that URL answers at all, the tunnel must be presenting a loopback `Host`.  In that case, every caller that gets past Cloudflare Access passes the Host gate as the owner.  The Origin check (`server/index.ts:9413-9425`) still stops browser writes.  It does not stop a non-browser client that sends no `Origin` header.  This is an inference from the code and the rollout doc, not a tested result.  Verify it before building anything below.

## 1. Short Answer

**Remote CLI: yes, but only for demos today.**  The CLI Wrapper engine can already run `ssh host -- claude -p` and get text-only replies.  Full tools, approvals and stop need one new remote-execution seam in `server/procs.ts`.  Codex is the only engine that also has its own remote server mode, and it is experimental.

**Offload compute: yes, and half of it exists.**  The OpenAI-Compatible engine can point at a GPU box or an exo cluster today.  Box and BYO VPS computers already run shell and desktop work on other machines.

**Self-hosted cloud chats: yes in principle, but not safely today.**  The harness already runs on Linux.  It binds `127.0.0.1` with no user accounts, because it treats loopback as the owner, so it needs an auth seam first.  Upstream OpenMausBot has built one.

Three things never move on any path: desktop control of this Mac, the USB phone bridge, and the Mac voice helpers, including Personal Voice.

## 2. What BotFleet Already Has That Is Remote-Shaped

| Piece | What it does across machines | Where |
|---|---|---|
| Box cloud computers | ASCII.dev Box over REST, including a `computer_exec` shell tool.  A third party hosts it. | `server/box.ts`, `server/computer-proxy.ts:629` |
| Box engine (`boxAgent`) | The whole turn runs Claude Code or Codex on the box (`provider codex\|claude-code`).  There is no MCP channel and no approval channel back to this Mac. | `server/drivers/boxagent.ts:30-125`, `server/computer-capability.ts` |
| BYO VPS computer | Your Linux server becomes a bot's computer.  It uses `docker -H ssh://<alias>`, an `ssh -L` noVNC viewer, a credential tar pushed over SSH, and an MCP bridge with a liveness watchdog.  The engine stays on the Mac. | `server/vps-computer.ts:287-326, 1115-1185, 1292-1339`, `server/mcp-bridge.ts`, `docs/byo-vps.md` |
| Local VM | Docker, Podman or an Apple container on the same machine.  This is isolation, not offload. | `server/container-computer.ts:105` |
| Wrapper CLI strings | The per-instance Set CLI override accepts a command with fixed leading args, such as `"/usr/local/bin/ag claude agp"`.  Most engines allow several instances, so `~/.botfleet/config.json` can already hold a second "remote" instance of an engine. | `server/env-path.ts:308, 436-458`, `src/components/EnginesSettings.tsx`, `server/config.ts:3, 455` |
| CLI Wrapper engine | Any command's stdout becomes the reply.  There are no tools, approvals or resume. | `server/drivers/cli-wrapper.ts:34-38, 192-213` |
| OpenAI-Compatible engine | Takes a custom base URL.  Add Engine suggests Ollama, vLLM and LM Studio. | `server/drivers/openai-compat.ts:98-104`, `src/lib/custom-engine.ts:173-182` |
| Local model hosts | oMLX, Ollama, EXO, LM Studio and Unsloth, each at a fixed `127.0.0.1` port. | `server/drivers/local-inject.ts:24-31` |
| Companion sidecar | The phone reaches the loopback-only harness through an authenticated, allowlisted sidecar.  Hosted HTTPS goes through an Electron-managed `cloudflared`. | `companion/`, `companion/src/lan-policy.ts:46, 70`, `docs/ios-companion.md:78-109`, `electron/managed-companion-tunnel.mjs` |
| dweb proxy | Opt-in model runs on peer nodes, plus `opencode_run`, when `DWEB_URL` is set. | `server/drivers/dweb-proxy.ts:12-15`, `server/index.ts:5207-5210` |
| Linux harness | Plain Node: `pnpm dev:server` and `pnpm companion`.  CI runs the full suite on Ubuntu, macOS and Windows.  DEB and AppImage packages exist, and so does a Linux CUA runtime. | `package.json`, `.github/workflows/ci.yml:77`, `.github/workflows/package-linux.yml`, `electron/cua-linux-runtime.cjs` |
| Public self-hosting docs | These define "self-hosting" as running BotFleet on your own computer with the harness on loopback.  Other devices connect through the companion or Tailscale. | `apps/docs/content/docs/self-hosting/` |
| Remote Access setting | Shows the named tunnel URL in Settings.  See the callout above. | `docs/rollouts/2026-09-06-remote-access.md` |
| Removed | The hosted control plane was deleted on 2026-09-26 (#657).  `server/cloud-backend.ts` holds only two guard strings. | `cloudflare/control-plane/README.md` |

Three things are missing for all three questions:

- The harness has no bind or auth setting.
- The desktop app cannot attach to a harness on another machine.
- Every BotFleet tool is a local stdio proxy that calls `127.0.0.1:8799`.

## 3. The Paths

### Constraints Referenced Below

Every path runs into some of these limits, and the tables cite them by ID.  Paths without a top-level folder are under `server/`.

| ID | Constraint | Evidence |
|---|---|---|
| B1 | The harness binds `127.0.0.1` with no user auth.  Loopback is the owner, so a proxy that rewrites `Host` turns every remote caller into the owner. | `index.ts:576, 9359-9425, 9838-9849` |
| B2 | SSH joins the arguments into one string, and the remote shell parses it again.  JSON, quotes, newlines and empty strings get mangled. | `drivers/claude.ts:1119, 1132, 2114-2118`, `drivers/codex.ts:147-153` |
| B3 | SSH does not forward the child's environment.  BotFleet deliberately keeps credentials and switches in environment variables, so they stay off the command line and out of `ps`. | `drivers/codex.ts:145-152`, `drivers/claude.ts:1120-1122, 1227`, `drivers/acp/core.ts:282-293, 784-785`, `drivers/pi.ts:575` |
| B4 | Some arguments are local temp files or local install paths. | `drivers/claude.ts:1223-1226`, `drivers/acp/dsh-mcp.ts:24-38`, `drivers/pi.ts:543-575`, `drivers/antigravity.ts:36-39, 283` |
| B5 | Every BotFleet tool is `process.execPath` plus a local proxy file, and most proxies call back to `127.0.0.1:8799`. | `proxy-paths.ts:35-50`, `index.ts:1227-1249, 1259-1266, 1340-1345` |
| B6 | Claude approvals go through a local unix socket and fail closed.  A remote Claude therefore denies every tool that is not pre-approved. | `drivers/claude.ts:556, 1196-1212`, `permission-proxy.ts:26-31`, `procs.ts:525-531` |
| B7 | Stop kills only the local `ssh` process group.  The remote CLI and its children can outlive the turn and keep spending quota.  A pty (`-tt`) would corrupt the NDJSON stream. | `procs.ts:74-79, 399-424, 443-523` |
| B8 | The working directory, workspaces, worktree leases, attachments and checkpoints are all local filesystem objects.  Codex and ACP also send the working directory over the wire. | `drivers/claude.ts:1229`, `drivers/codex.ts:356, 847`, `drivers/acp/core.ts:709, 1545, 1557`, `worktree-leases.ts:221` |
| B9 | Readiness checks, model catalogs and CLI config writes use the local home folder, so status describes the wrong machine. | `drivers/acp/grok.ts:212, 339-342`, `drivers/acp/opencode-go.ts:253, 379`, `drivers/acp/hermes.ts:49, 105, 283`, `drivers/acp/kimi.ts:412, 551`, `drivers/pi.ts:291` |
| B10 | The desktop only attaches to a harness that has a local owner file and a live local process ID.  Its UI shim only proxies to loopback. | `electron/harness-ownership.mjs:9-55`, `electron/main.mjs:1027-1033`, `electron/attached-ui-shim.mjs:1-16` |
| B11 | Local-model hosts are hard-coded to loopback ports. | `drivers/local-inject.ts:24-31, 303-330` |
| B12 | HTTP engines run their tool loop inside the harness, so moving inference does not move shell or file work. | `drivers/minimax.ts:985-1000`, `drivers/openai-compat.ts:568-575` |
| B13 | The VM CLI layer installs 51 tools but no engine CLIs.  Credential sync carries no engine logins.  Claude on macOS keeps its OAuth login in the Keychain. | `scripts/computer-vm-cli/manifest.json`, `vm-cli-credentials.ts`, `drivers/claude.ts:187-193` |
| B14 | Native resume lives on whichever host ran the CLI, so a thread must stay pinned to one host and one working directory. | `drivers/claude.ts:1351-1352`, `drivers/codex.ts:786-847`, `drivers/acp/core.ts:1545` |
| B15 | Host desktop control, the USB phone bridge, and the Electron speech and Personal Voice helpers cannot move. | `drivers/phone-proxy.ts:1-2`, `local-computer.ts:1-30`, `computer-capability.ts:88-117` |

### Engine Rows

Every table uses the same rows, in the order `server/drivers/builtIn.ts` registers them.  Engines that behave the same are grouped.

1. **Claude Code** (`claude`)
2. **Codex** (`codex`)
3. **ACP group:** Kimi, DeepSeek, MiniMax Code, Droid, Cursor, Qwen, Muse (`drivers/acp/*`)
4. **Grok Build over ACP** (`grokAgent`, `drivers/acp/grok.ts`)
5. **DeepSeek Harness** (`dshAgent`)
6. **OpenCode Go** (`opencodeGo`)
7. **Hermes** (`hermesAgent`)
8. **Antigravity** (`antigravity`)
9. **Pi** (`pi`)
10. **CLI Wrapper** (`cli-wrapper`)
11. **Box engine** (`boxAgent`)
12. **HTTP engines:** Grok API (`drivers/grok.ts`), MiniMax (`drivers/minimax.ts`), OpenAI-Compatible
13. **Host-only features:** this Mac's desktop control, USB phone, voice helpers

---

### Path A: SSH-Wrapped CLI Spawn per Bot

This adds a "Remote Host" setting to an engine instance.  A bot or channel then picks that instance like any other.

**How it works.**

```
Mac harness ─ procs.ts spawnCli ─ ssh -T -o BatchMode=yes <alias> -- node ~/.botfleet-remote/<build>/remote-shim.js
   first stdin line: {argv, env, cwd}  →  shim execs the real CLI on the remote host
   NDJSON stdio flows back over the same SSH channel
   remote tool proxies call home:  remote 127.0.0.1:<rport>  ─ ssh -R ─  Mac 127.0.0.1:8799
   Claude approvals:              remote perm.sock          ─ ssh -R ─  Mac perm.sock
```

It comes in two stages.

**A0: zero code, works today.**  Good for trying the idea, not for shipping.

- A CLI Wrapper instance, text only:
  `{"driver":"cli-wrapper","config":{"command":"ssh","args":["-T","-o","BatchMode=yes","host","--","claude","-p"],"passPromptAs":"stdin"}}`
- A second instance of an ACP engine whose `cli` points at a wrapper script.  Turn the bot's integrations and computers off:

  ```bash
  #!/bin/bash
  # ~/bin/rgrok
  exec ssh -T -o BatchMode=yes host "cd $(printf %q "$PWD") && exec grok $(printf '%q ' "$@")"
  ```

  `printf %q` is a bash and zsh feature, not POSIX, so the script needs bash.  The quoting also assumes the remote login shell is bash or zsh.  The same wrapper gets Codex and Claude past B2, still without MCP.  Claude also needs `bypassPermissions` because of B6.

**A1: proposed, one remote-execution seam in `server/procs.ts`.**

- A proposed `server/remote-exec.ts` defines `RemoteTarget {sshAlias, remoteRoot, pathMap}`.  It is validated with the existing `isValidSshAlias` and stored in instance config as `remote: {...}`.
- `spawnCli` and `execCli` gain `opts.remote`.  The first NDJSON line on stdin carries `{argv, env, cwd}` as JSON and is never shell-joined.  That fixes B2 and B3.
- A proposed remote shim, modeled on `server/drivers/dsh-acp-bridge.ts`, runs the CLI with the exact arguments, environment and working directory:
  - It kills its own process group on stdin EOF or SIGHUP, which fixes B7.
  - It writes any `--mcp-config` or patch payloads into a remote temp folder with 0600 permissions and rewrites the paths, which fixes B4.
- A proposed `rewriteMountsForRemote(mounts, target)` is applied in one place per driver: `drivers/claude.ts:1137-1192`, `drivers/codex.ts:310-345`, `drivers/acp/core.ts:96-155`, and Pi's `buildMcpServers`.  It swaps `process.execPath` for `node` and local proxy paths for remote copies.  It leaves local-computer mounts out.
- Readiness, version, auth and catalog probes run through the remote `execCli`.  Local-inject writes are turned off for remote instances (B9).

**Engine coverage.**

| Engine | A0 today | A1 with shim | Why |
|---|---|---|---|
| Claude Code | Partial | Yes | Worst fit.  A0 needs the `%q` wrapper for the JSON `--settings` and the multi-line system prompt (B2).  It also needs `bypassPermissions`, because without a forwarded socket every tool that is not pre-approved is denied (B6).  No MCP (B4, B5). |
| Codex | Partial | Yes | Approvals travel inside the protocol, so there is no socket problem.  MCP server values live only in environment variables, which SSH drops (B3).  The working directory is also sent in `thread/start` and must exist on the remote host (B8). |
| ACP group | Partial | Yes | Best fit.  The arguments are plain tokens, and the prompt, working directory and approvals all travel over the protocol.  Turn integrations off in A0.  Readiness reads local auth files, so the status pill describes the Mac (B9). |
| Grok Build over ACP | Partial | Yes | Readiness reads the local auth file with `authFailure: "fail"`.  An A0 turn is refused unless the Mac is also signed in. |
| DeepSeek Harness | No | Partial | A wrapper string fails `isDshEngineCli`, so no bridge is inserted, and stock dsh rejects a non-empty `mcpServers` list.  A1 must recognize a remote dsh and ship the `--patch` overlay (B4).  dsh already shuts down cleanly on stdin EOF [official], which helps with B7. |
| OpenCode Go | Partial | Yes | It refuses to start when the Mac has no OpenCode login (`requireAuthenticationBeforeSpawn`).  A1 runs that check on the remote host. |
| Hermes | Partial | Yes | Turns work through the wrapper.  The catalog probe uses a raw `spawn(cli)` (`drivers/acp/hermes.ts:283`), so the model list breaks until the probe goes through `execCli`. |
| Antigravity | Partial | Partial | It runs one process per turn with no permission hook.  MCP is mounted by editing the global `~/.gemini/config/mcp_config.json`, so A1 would have to edit that file on the remote host.  `--add-dir` also passes a local path. |
| Pi | Partial | Yes | Works with integrations off.  MCP needs the `-e` extension and the `OMB_MCP_CONFIG` file shipped and rewritten (B4). |
| CLI Wrapper | Yes | Yes | Text only, works today with no code.  The probe appends `--version`, so the remote command must accept it. |
| Box engine | n/a | n/a | Already remote. |
| HTTP engines | n/a | n/a | No local CLI to move.  See Paths E and F. |
| Host-only features | Never | Never | B15. |

**Prerequisites.**

- **Auth on the remote host.**  Each CLI is installed and signed in there as the SSH user.  Do not copy `~/.claude` or `~/.codex` from the Mac; every vendor says to sign in on the host itself.  On a remote Mac, the Keychain may be locked for a non-interactive SSH session, which matters for Claude.  The headless fallback is `claude setup-token` with `CLAUDE_CODE_OAUTH_TOKEN`.
- **PATH.**  Non-interactive SSH can miss CLIs installed in the user's own folders (Codex #23102 [issue]).  Use a login shell or absolute paths.
- **Repo checkout and working directory:**
  - `pathMap` maps a local workspace to a remote path.  If a turn's working directory has no mapping, refuse the turn rather than falling back to the remote `$HOME` (B8).
  - Copy attachments into `remoteRoot/attachments`, or refuse them.
  - For v1, either declare worktree leases and checkpoints unsupported on remote instances, or run them as `git` over the same SSH connection.
  - Pin each thread to one host and one remote working directory (B14).
- **MCP servers.**  Ship the shim and the built proxies with `rsync` or `scp`, keyed by build identity.  `server/vps-computer.ts:1115-1185` already pushes a tar over SSH.  The proxies need `node` on the remote host.
- **Computer use.**  Box, VPS and VM computers keep working through the rewritten mounts.  A remote instance is never offered "This computer"; a proposed `remoteCli` flag in `server/computer-capability.ts` would enforce that.

**Security model.**

- Use SSH keys through an `~/.ssh/config` alias, `BatchMode=yes`, and a `known_hosts` file the user manages, as `docs/byo-vps.md` already requires.  Tailscale SSH is a good alternative: it uses tailnet identity, so no keys need distributing [official].
- Secrets never appear on the remote command line.  The environment travels inside the first stdin line (B3).
- Each reverse forward opens the harness API to every process on the remote host for as long as the turn lasts:
  - Bind the remote end to `127.0.0.1`.
  - Give proxies per-turn comms grants (`mintCommsGrant`, `server/index.ts:1227-1245`), never the boot token.
  - The Mac side still sees `127.0.0.1`, so the existing loopback, comms-grant and boot-token checks keep working unchanged.
- Nothing listens publicly anywhere, and `8799` is never exposed.

**Effort and risks.**  A0 is **S**: it only needs a runbook.  A1 is **L**.

- Stop and quota (B7) are the main safety risk until the shim owns its process group.
- An SSH drop ends the turn, because nothing on the remote host keeps it alive.  `ControlMaster`, `ControlPersist` and `ServerAliveInterval` help [official].  mosh does not help, because it cannot carry non-interactive stdio [3p].
- The harness, the shim and the remote CLI can drift to different versions.  Key the shim by build identity.
- Load: the ACP startup deadline already scales with host load (`server/drivers/acp/init-deadline.ts`).  Add the SSH round-trip time to it.
- **Owner decision:** `docs/byo-vps.md:3-7` promises BotFleet "never runs an agent remotely."  A1 reverses that for instances that opt in.
- Tests stay in fixtures.  A fake `ssh` on PATH runs the shim locally.  The tests should:
  - round-trip arguments containing JSON, spaces, newlines and `''`;
  - assert that no secret appears in the fake `ssh` arguments;
  - prove the shim's child process dies after `killCliTree`.

---

### Path B: Native Remote Protocols (Codex App Server, ACP over a Socket)

Use an engine's own server mode instead of carrying raw stdio.  The remote side can then survive an SSH drop.

**How it works (Codex).**

```
drivers/codex.ts (JSON-RPC over stdio)
   ─ ssh -T host -- codex app-server proxy --sock <path>
   ─ remote codex app-server daemon (started once with `app-server daemon bootstrap`)
   ─ threads keep running on the remote host while the SSH link is down
```

There is a second option.  Run `codex app-server --listen ws://127.0.0.1:P --ws-auth capability-token --ws-token-file <file>` on the remote host and forward it with `ssh -L`.  Then add a proposed WebSocket client to `drivers/codex.ts`.

All of these flags exist in codex-cli 0.159.2 (checked on this Mac on 2026-10-07), and all are marked [experimental].  The Codex desktop and mobile apps use the same daemon-plus-proxy shape over SSH [issue].  That is what the owner tried against the Coolify box.

**Other engines.**

- **ACP:** stdio is the only stable transport.  Streamable HTTP and WebSocket are still a draft proposal [official], so no CLI that BotFleet drives can listen on a port.
  - For now, remote ACP means Path A, with `session/list` and `session/resume` for reconnecting.  Both were stabilized in 2026 [official].
  - Once the HTTP transport ships, `drivers/acp/core.ts` would gain a second transport.
  - A community dsh fork adds HTTP and SSE [3p].
- **Claude Code:** it has no server mode you can host yourself.  `--remote-control` and `--teleport` are relays that Anthropic hosts [official].
  - Remote Control stores the transcript on Anthropic's servers while connected.
  - It needs a claude.ai subscription login.
  - It is unavailable with a non-Anthropic `ANTHROPIC_BASE_URL`, which BotFleet's local-model routing sets.
  - The Agent SDK's `spawnClaudeCodeProcess` option [official] shows the remote setup the vendor supports: spawn the CLI elsewhere and pipe stdio.  That is Path A.
- **Antigravity:** `agy remote-control start` is an always-on daemon with reverse tunnels to Google's browser UI [official, partial].  No protocol that BotFleet could drive is documented.
- **OpenCode:** `opencode serve` is a headless HTTP server with basic auth [3p].  BotFleet's driver speaks `opencode acp`, which is a different protocol.

**Engine coverage.**

| Engine | Covered | Why |
|---|---|---|
| Claude Code | No | Only vendor-hosted relays exist. |
| Codex | Yes (experimental) | Daemon plus `proxy --sock` over SSH, or WebSocket behind `ssh -L`. |
| ACP group | No | No listen mode until ACP's HTTP transport ships. |
| Grok Build over ACP | No | No first-party remote mode found [3p]. |
| DeepSeek Harness | No | The official build is stdio only.  The HTTP variant is a community plugin [3p]. |
| OpenCode Go | Partial | `opencode serve` exists [3p], but the driver would need a second protocol. |
| Hermes | No | Stdio ACP only. |
| Antigravity | No | Remote control is a vendor browser relay. |
| Pi | No | RPC over stdio only. |
| CLI Wrapper | n/a | It already wraps any command. |
| Box engine | n/a | Already remote. |
| HTTP engines | n/a | Already network-native. |
| Host-only features | Never | B15. |

**Prerequisites.**

- Codex is signed in on the remote host and on the login shell's PATH.
- The repo is checked out there, and the working directory is mapped for `thread/start` (`drivers/codex.ts:847`).
- MCP is an open question.  A long-lived daemon fixes `-c` overrides when the daemon starts.  BotFleet's per-turn `-c mcp_servers.*` mounts (`drivers/codex.ts:139-155`) therefore need a thread-level config path, or must keep spawning over stdio.
- The reverse forward and computer rules are the same as Path A.

**Security model.**  Never `--listen` on `0.0.0.0`; OpenAI's guidance is no unauthenticated public listeners [official].  Keep the listener on loopback behind `ssh -L` or Tailscale.  Keep the capability token file at 0600.  `/healthz` returns 403 when an `Origin` header is present [official].

**Effort and risks.**  **M** for the daemon-plus-proxy `cli` string.  **M-L** for a WebSocket client.  Pin the Codex version, because the flags are experimental.

Known failure modes [issue]:

- non-interactive PATH (#23102);
- a killed app-server respawning unmanaged (#24542);
- stale control sockets (#51345);
- Windows hosts failing on unix sockets (#22965).

A reported 128-message outbound queue can drop slow links on turns with heavy output [3p].  Overload returns `-32001` and should be retried with backoff [official].

---

### Path C: Whole Harness Headless on a Server (Self-Hosted Cloud Chat)

Run the entire BotFleet harness on the Coolify or Hetzner box, and point the Mac, browsers and the iPhone at it.  This is the answer to "host your own cloud chat."

**How it works.**

```
iPhone / browser / desktop
   ─ TLS edge: Tailscale Serve, Caddy on your own domain, or an SSH tunnel
   ─ auth seam for non-owner callers (proposed; upstream pairing sessions)
   ─ BotFleet harness on the server, still bound to 127.0.0.1 behind the edge
   ─ engines installed and signed in as the service user, next to the repos
```

The big advantage is that tools, approvals, worktrees, checkpoints and resume all stay local to the harness.  Constraints B2 through B9 and B14 do not apply.  Only B1, B10 and B15 do.

**Zero code, single owner, works today.**

```sh
OMB_DATA_DIR=/srv/botfleet/data OMB_STATIC_DIR=<built ui> node --experimental-strip-types server/index.ts
pnpm companion
```

Reach the harness only through `ssh -L 8799:127.0.0.1:8799 server` in a browser.  The desktop app cannot attach (B10).  Never put it behind a proxy that rewrites `Host` (B1).

The iPhone is harder than it looks on a headless box:

- The companion's device port binds `127.0.0.1:8810` unless `OMB_COMPANION_ALLOW_CLEARTEXT_LAN=1` is set (`companion/src/lan-policy.ts`).
- Its hosted HTTPS route is the Electron-managed `cloudflared` guardian, which does not exist without the desktop app.
- The likely route is `tailscale serve` in front of `127.0.0.1:8810`, with pairing done on the control page at `127.0.0.1:8811` reached by `ssh -L`.  That is untested.
- Do not set the cleartext flag on a public server, because it binds `0.0.0.0` on every interface.

**What it needs to become a product.**

1. **Auth seam for callers that are not on loopback.**  There are two options:
   - A minimal `OMB_ACCESS_TOKEN`, checked on a separate proxy listener.  This is upstream's plan phase 1 (`3415718e9`).
   - A port of upstream pairing sessions (`79b0ff556`, #693: upstream `server/sessions.ts` and `remote-sessions.test.ts`).  This adds a listener whose callers are never the owner, plus bearer or cookie sessions.
2. **Packaging.**  Port upstream `deploy/` (Docker, Caddy and a compose file; `6dd974c3e`, #677).  Coolify can run a compose file.  Add a systemd unit and a start script without macOS defaults: `scripts/botfleet-server-start.sh` hard-codes `/opt/homebrew/bin/node` and `~/Library/Logs`.
3. **Secrets from Infisical** (`INFISICAL.md`), not the desktop Keychain.
4. **Place rules for a server home.**  Never offer "This computer" or the Local VM (upstream `shared/cloud-home.ts`).
5. **Desktop Server menu** to pair with a server and switch to it (upstream `d3250783d`, `electron/environments.cjs`).
6. **Engine sign-in on the server.**  Upstream signs Codex in from the browser with `codex login --device-auth`.
7. **Optional, upstream:** "Let my Cloud use this Mac" (`81e65236b`, upstream `server/shared-computers.ts`).  The Mac dials out with a long poll and grants access to folders, the terminal and the screen.  That gives a server harness back some reach into the Mac.

Leave out upstream's managed tunnel and Cloud Pro pieces.  They depend on openmausbot.com infrastructure, and BotFleet deliberately deleted its own control plane (#657).

**Engine coverage (engines running on a Linux server harness).**

| Engine | Covered | Why |
|---|---|---|
| Claude Code | Yes | Signed in on the server, where Linux stores the login as a file.  Using a subscription on a server is an owner decision (see Section 4). |
| Codex | Yes | Device-auth sign-in. |
| ACP group | Yes | Provided each CLI ships a Linux build and is signed in on the server.  Not checked per CLI. |
| Grok Build over ACP | Yes | Same condition. |
| DeepSeek Harness | Yes | The bridge runs locally on the server harness. |
| OpenCode Go | Yes | Same condition. |
| Hermes | Yes | Same condition. |
| Antigravity | Partial | Sign-in prints a URL on SSH hosts [official].  The driver edits the server's global Gemini config, which is fine on a dedicated host. |
| Pi | Yes | Same condition. |
| CLI Wrapper | Yes | Any command on the server. |
| Box engine | Yes | HTTPS from anywhere. |
| HTTP engines | Yes | HTTPS from anywhere. |
| Host-only features | Never | A server has no Mac desktop, USB phone or Electron voice helpers.  Upstream's shared computers feature is a partial way back to the Mac's desktop. |

**Security model.**

- `8799` is never exposed publicly.  TLS ends at Caddy or Tailscale.
- Tailscale Serve adds identity headers such as `Tailscale-User-Login`.  Funnel is public and adds none [official], so do not use Funnel.
- Cloudflare Access is a good outer lock, but it cannot replace the auth seam because of B1 (see the callout at the top).
- Every bot's shell runs as the service user on the server.  Use a dedicated user, and assume the bots can reach anything that user can reach on the box.
- One owner per server.  Upstream also made its cloud home personal (`90ffde779`).  Multi-user accounts are out of scope.

**Effort and risks.**

- **M** for a minimal token, a Linux start script and a compose file.
- **L** for the full upstream port.  Upstream has diverged by 2,080 commits, so port one feature at a time rather than merging.
- The Coolify box shares resources with other apps.
- Reference designs from other self-hosted chat products: Open WebUI and LibreChat each run as one compose stack.  Each has a persistent volume, secrets in environment variables, a TLS reverse proxy, and either built-in accounts or identity at the edge.  Coolify lists both as one-click services [snippet].

---

### Path D: Harness-to-Harness Federation

A Mac harness hands a bot's turns to another BotFleet harness, nearby or far away.  The reply shows up as a normal bot message.

**How it works.**

```
Mac harness ─ proposed "Remote BotFleet" engine instance
   ─ HTTPS over Tailscale or an SSH tunnel, with a paired, non-owner credential
   ─ peer harness runs the turn on its own engines, tools, computers, and repos
   ─ events stream back and render in the Mac's thread
```

**Nothing exists yet.**  These existing pieces come closest:

- The Box engine already sends one prompt to a remote machine over HTTPS and streams the result back (`server/drivers/boxagent.ts:117-125`).  A federated engine would follow the same driver pattern.
- `ask_bot` and `agents-proxy` already call a harness's thread API with per-turn comms grants (`server/index.ts:1227-1249`).  They only do it at `127.0.0.1`.
- Upstream shared computers (`81e65236b`) works in the opposite direction: a cloud harness borrowing a Mac.

**Dependency.**  Federation needs Path C's auth seam on the peer.  B1 rejects every caller that is not on loopback today, and the calling harness must never become the peer's owner.

**Engine coverage.**  Every engine the peer runs, with everything working as it does locally on the peer.

| Engine | Covered | Why |
|---|---|---|
| Claude Code | Yes | It runs locally on the peer, so MCP, approvals and resume all work there.  Approval cards need relaying back to the Mac (proposed). |
| Codex | Yes | Same. |
| ACP group | Yes | Same. |
| Grok Build over ACP | Yes | Same. |
| DeepSeek Harness | Yes | Same. |
| OpenCode Go | Yes | Same. |
| Hermes | Yes | Same. |
| Antigravity | Yes | Same. |
| Pi | Yes | Same. |
| CLI Wrapper | Yes | Same. |
| Box engine | Yes | Same. |
| HTTP engines | Yes | Same. |
| Host-only features | Partial | The peer's own desktop, phone and voice become usable if the peer is a Mac running the desktop app.  This Mac's never are.  This is the only path that lets bots control a second Mac's desktop. |

**Prerequisites.**  The peer harness is reachable over Tailscale or an SSH tunnel.  Engines are signed in on the peer, and the repos live there.

**Security model.**  A paired credential for each harness, limited to running turns on named bots and never carrying owner rights.  Add Tailscale access rules on top.

**Effort and risks.**  **L.**  The risks:

- One thread has two homes, so someone has to decide which harness owns history, search and memory.
- Approvals have to cross harnesses.
- The two harnesses can drift to different versions.
- Quota use has to be attributed to the right side.

---

### Path E: Offload Model Inference and Heavy Jobs

Move the model, or a background job, to another machine while the bot stays where it is.

**How it works.**

```
bot turn on the Mac ─ engine's model endpoint ─ GPU box, second Mac, or exo cluster on the LAN or tailnet
   tokens stream back; tools still run wherever the engine runs (B12)
```

**Zero code, works today.**

- Point the OpenAI-Compatible engine's custom base URL at vLLM, Ollama, LM Studio or exo on another machine over Tailscale.
- Run `ssh -L 11434:127.0.0.1:11434 gpu-box`, and local-inject treats a remote Ollama as local.

**Proposed.**

- **Configurable local-model hosts.**  `LOCAL_HOSTS` is fixed at `127.0.0.1`: oMLX on 8080, Ollama on 11434, EXO on 52415, LM Studio on 1234, Unsloth on 8888.  Add a `localHosts: [{id, label, baseUrl}]` list to `config.json`, validated with zod.  A LAN GPU box or the head node of an exo cluster would then appear under Custom on every engine that uses local-inject.
- **Remote background jobs.**  `server/jobs/runner.ts` spawns `/bin/sh` locally with `nice` and `taskpolicy`, writes output to a file, and writes the exit status to a file atomically.  `server/jobs/admission.ts:114-118` already reads host load.  That is the natural trigger for running the same wrapper on another machine over SSH and streaming or syncing the output back.
- **dweb** already offers model runs on peer nodes when `DWEB_URL` is set.

**Model-host options** (from the research):

- **Ollama:** no auth.  Set `OLLAMA_HOST` to a Tailscale IP rather than `0.0.0.0` [official, 3p].
- **LM Studio:** headless `lms server start`, plus LM Link (in preview) for device-to-device access over Tailscale [snippet].
- **exo** [official repo]:
  - It forms a cluster of nearby devices with automatic discovery.
  - It serves OpenAI, Claude Messages and Ollama APIs on `:52415`.
  - RDMA over Thunderbolt 5 needs macOS 26.2 or later.
  - Its speed-up figures are the project's own claims.
- **MLX distributed:** needs passwordless SSH between nodes [official].
- **llama.cpp RPC:** its own docs call it "fragile and insecure."  Use it on a trusted LAN only [official].

**Engine coverage.**

| Engine | Covered | Why |
|---|---|---|
| Claude Code | Partial | Local-inject routes it to a local model, but only on loopback until hosts are configurable.  `ssh -L` works now. |
| Codex | Partial | Local-inject writes a `127.0.0.1` `base_url` (`drivers/local-inject.ts:122-136`).  Otherwise the same as Claude Code. |
| ACP group | Partial | Kimi, DeepSeek, Droid and Qwen import local-inject.  Cursor, MiniMax Code and Muse do not import it directly.  Whether they reach it through `drivers/acp/core.ts` is unverified. |
| Grok Build over ACP | Partial | Imports local-inject. |
| DeepSeek Harness | Unverified | `drivers/acp/dsh.ts` does not import local-inject directly. |
| OpenCode Go | Partial | Imports local-inject. |
| Hermes | Partial | Imports local-inject. |
| Antigravity | Partial | Imports local-inject. |
| Pi | Partial | Imports local-inject. |
| CLI Wrapper | n/a | Depends on what the wrapped command does. |
| Box engine | No | The model runs at the vendor, through the box. |
| HTTP engines | Partial | OpenAI-Compatible: yes, today.  Grok API and MiniMax: no.  They call vendor endpoints, so inference is already remote. |
| Host-only features | n/a | Not affected. |

**Prerequisites.**  Only a model server on the other machine.  MCP and computers do not change, because tools stay with the engine.

**Security model.**  Never bind a model server to `0.0.0.0` on an open network.  Keep it on the tailnet.

**Effort and risks.**  **S** for configurable hosts.  **M** for remote jobs.  Local models are weaker at tool calling, latency goes up, and exo and MLX have real hardware requirements.

---

### Path F: Offload Tool Execution Only (CLI Stays Local)

The engine and its model loop stay on the Mac, while shell, file and desktop actions run elsewhere.  This path fits the current product stance in `docs/byo-vps.md`.

**How it works.**

```
engine CLI on the Mac ─ BotFleet mounts a computer as an MCP server
   ─ Box cloud computer, BYO VPS container, or (Codex only, experimental) a remote exec-server
```

**Exists today.**

- Box computers with `computer_exec` (`server/computer-proxy.ts:629`).
- BYO VPS hardened CUA containers, through `docker -H ssh://` and the MCP bridge (`server/vps-computer.ts:1292-1339`, `server/mcp-bridge.ts`).
- `server/computer-capability.ts` decides, in one place, which computers each engine can reach:
  - Engines that are MCP clients reach Box, VPS and VM computers.
  - Engines that use the harness tool loop reach only host tools.
  - The Box engine reaches only its own box.

**Proposed.**

- Codex `exec-server --listen ws:// --remote <url>` keeps the model loop and BotFleet's integrations local while commands run on the remote host [3p, experimental; #24209 confirms the subcommand exists].  For Codex, this is the cleanest way to use another machine's CPU.
- Remote background jobs, as in Path E.
- Remote reach for HTTP engines.  The harness would need to proxy Box and VPS tools into its own tool loop.

Cursor's My Machines is the vendor version of the reverse setup: the loop runs in Cursor's cloud and the tools run on your machine [official].

**Engine coverage.**

| Engine | Covered | Why |
|---|---|---|
| Claude Code | Yes (exists) | Box, VPS and VM through MCP mounts. |
| Codex | Yes (exists) | Same, plus `exec-server` (experimental). |
| ACP group | Yes (exists) | When the engine mounts MCP servers (`drivers/acp/core.ts:569-571`). |
| Grok Build over ACP | Yes (exists) | Same. |
| DeepSeek Harness | Yes (exists) | Through the local dsh bridge. |
| OpenCode Go | Yes (exists) | Same as the ACP group. |
| Hermes | Yes (exists) | Same as the ACP group. |
| Antigravity | Yes (exists) | Mounted through its global MCP config. |
| Pi | Yes (exists) | Through its MCP extension. |
| CLI Wrapper | No | No tools. |
| Box engine | Partial | Its own box only. |
| HTTP engines | No | `computerMcp` is false, and the tool loop reaches only host tools (`drivers/grok.ts:85`, `drivers/minimax.ts:354`, `drivers/openai-compat.ts:120`). |
| Host-only features | n/a | They stay on this Mac by definition. |

**Security model.**  For the VPS, SSH is the only credential.  BotFleet opens no public port, never stores the key, and hardens the containers.  The credential-sync failures from the 2026-10-07 audit (R2 RUN-12, R3 CPU-8) are still open.

**Effort and risks.**  Nothing new for what already exists.  **S-M** for Codex `exec-server`.  **M** for HTTP engine reach.  Every tool call adds network latency.

---

### Path G: Box Cloud Computers, the Box Engine, BYO VPS, and Local VMs

**What exists.**

- **Box (ASCII.dev):** third-party cloud computers over REST, with Hetzner pooling (`server/box.ts:40, 102`).
- **Box engine:** the whole turn runs Claude Code or Codex on the box.  It has no MCP channel (`server/drivers/boxagent.ts:59-61`).  It reaches only its own box, because it has no approval channel back to this Mac.
- **BYO VPS:** your Linux server becomes a bot's computer while the engine stays on the Mac.
- **Local VM:** Docker, Podman or an Apple container on the same machine.  This is isolation, not offload.

**Proposed extension: run the engine inside the BYO VPS container.**

```
Mac harness ─ docker -H ssh://alias exec -i -u cua -w <cwd> <container> <cli> …
   ─ engine runs next to its computer in the hardened container, liveness through mcp-bridge.ts
```

- Add engine CLIs to `scripts/computer-vm-cli/manifest.json`, which lists 51 tools today and no engine CLIs.  For example, add `npm_global` entries for `@anthropic-ai/claude-code` and `@openai/codex`, plus install recipes for the rest.
- Sign-in:
  - One option is syncing `.codex/auth.json` and `~/.grok/auth.json` through `server/vm-cli-credentials.ts`.
  - Claude would need `claude setup-token` with `CLAUDE_CODE_OAUTH_TOKEN`, because Mac Keychain credentials are not files (B13).
  - Vendor guidance says to sign in on the host rather than copy credentials from the Mac.  Where a CLI supports it, prefer device-auth sign-in inside the container.
  - This is an owner decision.
- Benefits: the bot sits next to its computer, gets the container hardening (no open ports, dropped capabilities), and its state is disposable.
- Costs: it reverses the "never runs an agent remotely" stance, and the open credential-sync failures must be fixed first.
- You can try it today with zero code.  A CLI Wrapper instance whose command is `docker -H ssh://alias exec -i <container> <cli> …` works, text only, once a CLI is installed in the container.

**Engine coverage (engine inside the VPS container, proposed).**

| Engine | Covered | Why |
|---|---|---|
| Claude Code | Partial | Needs a token that does not live in the Keychain (B13), plus the subscription decision. |
| Codex | Yes | Device-auth or a synced `auth.json`. |
| ACP group | Partial | Each CLI needs an install recipe and its own sign-in. |
| Grok Build over ACP | Partial | Same, using `~/.grok/auth.json`. |
| DeepSeek Harness | Partial | Same. |
| OpenCode Go | Partial | Same. |
| Hermes | Partial | Same. |
| Antigravity | Partial | Same.  Editing the global config inside the container is harmless. |
| Pi | Partial | Same. |
| CLI Wrapper | Yes | Text only, zero code. |
| Box engine | n/a | It is the third-party-hosted version of this idea. |
| HTTP engines | n/a | No CLI. |
| Host-only features | Never | B15. |

**Effort and risks.**  **M-L.**  Needs owner decisions on the remote stance and on credentials.

---

### Path H: Satellite Runner (Long Term)

**How it works.**

```
small BotFleet node daemon on any device ─ dials OUT over an authenticated WebSocket ─ harness
   node hosts CLI processes and MCP proxies locally, multiplexes stdio streams, enforces kill and quota
   drivers see a ChildProcess-like duplex through the same procs.ts seam as Path A
```

Because each node dials out, there is no need for inbound SSH or holes in the NAT.  This mirrors upstream's shared-computer long poll.  The harness can then send each turn to the least-loaded node.  This path generalizes Path A and the container variant of Path G.

**Engine coverage.**  The same as Path A's "A1 with shim" column.  A node could also offer its own machine's host-only features, the way upstream shared computers offers a Mac's folders, terminal and screen.

**Effort and risks.**  **L.**  It adds a new always-on process on every device, and each one would need its own row in the Mac local-process inventory.

## 4. Recommended Sequence

The steps are ordered by what depends on what, not by preference.

0. **Now, no code.**
   - Answer the tunnel question from the callout.  If Cloudflare is rewriting `Host`, decide whether to keep that route until the auth seam lands.
   - Write a runbook of the zero-code demos, so the owner can try each path on the Coolify box:
     - CLI Wrapper over SSH;
     - an ACP wrapper using `%q`;
     - an OpenAI-Compatible URL pointing at a model server on the tailnet;
     - `ssh -L` for local-inject;
     - a single-owner Linux harness reached only through `ssh -L`.
1. **First: the auth seam.**  Either a minimal `OMB_ACCESS_TOKEN` on a separate listener, or a port of upstream pairing sessions.  **M.**  Paths C and D both depend on it, and it makes any tunnel to `8799` safe.  **In parallel, cheap and independent:** configurable local-model hosts (Path E, **S**).
2. **Second: the `procs.ts` remote shim (Path A1).**  **L.**
   - Start with the ACP engines because they fit best, then Codex, and Claude last because it fits worst (argument quoting, the approval socket, the Keychain).
   - One change answers "remote CLI" for almost every engine, and the satellite runner (Path H) would build on it.
   - **Optional fast lane:** Codex's native daemon (Path B) behind a flag.  Only Codex has one, and its flags are experimental.
3. **Third: the self-hosted harness on the Coolify box (Path C).**  **M-L.**  It needs step 1.  It is the biggest product change, and it is what turns BotFleet into "your own cloud chat."
4. **Later:**
   - Federation (Path D) or the satellite runner (Path H), once A and C exist.
   - The engine-in-container variant of Path G, after the credential-sync failures from the audit are fixed.

**Owner decisions.**

| Decision | Needed by | Options |
|---|---|---|
| Reverse "never runs an agent remotely" (`docs/byo-vps.md:3-7`) for instances that opt in | A1, G, H | Keep the stance, or allow it per instance with a visible "Remote" label. |
| Subscription logins on servers | A, B, C, G | See the note below the table. |
| Port upstream self-hosting, or build a minimal token | C, D | Port pairing sessions, `deploy/` and the Server menu.  Or ship `OMB_ACCESS_TOKEN` plus TLS at Caddy or Tailscale. |
| v1 policy for worktrees, checkpoints and attachments on remote instances | A, B | Sync them over SSH, or refuse with a clear message. |
| Credentials in VPS containers | G | Sync them from the Mac, or sign in inside the container. |

**About subscription logins:**

- Anthropic's terms let an end user sign in to the unmodified Claude Code binary with their own subscription, including where a platform hosts it.
- The terms forbid products that route requests through Free, Pro or Max credentials on behalf of users, or that collect or intermediate those tokens [official].
- A `claude -p` driven by BotFleet sits close to that line.  The cleanest reading is that the user signs in on their own host and BotFleet never touches the token.  This is not a legal opinion.
- The same question applies to ChatGPT logins for Codex.

## 5. Open Questions

1. **The named tunnel.**  Does `https://botfleet.jays.services` rewrite `Host`?  If it does, every caller authenticated by Cloudflare Access is the loopback owner.  If it does not, is the route read-only or broken?  See the callout.
2. **Is any BotFleet harness running on the Coolify or Hetzner box today?**  The sources disagree:
   - `docs/audits/2026-09-25-engine-audit-findings.md:92-94` puts the harness behind "Cloudflare Tunnel + Coolify."
   - `docs/audits/2026-09-25-engine-hardening-plan.md:242` and the LaunchAgent docs say it runs under launchd on the Mac.
   - `docs/audits/2026-10-07-review/R2-runtime.md:90-91` reports Sentry events from "the fleet VPS."
3. **Companion docs are out of date.**  `docs/ios-companion.md` and `apps/docs/content/docs/self-hosting/networking.mdx` say the companion device port binds `0.0.0.0:8810`.  The code defaults it to `127.0.0.1` unless `OMB_COMPANION_ALLOW_CLEARTEXT_LAN=1` is set (`companion/src/lan-policy.ts:46, 70`).
4. **Codex daemon and MCP.**  Can a long-lived `codex app-server` daemon accept MCP server config per thread?  Or do BotFleet's per-turn `-c mcp_servers.*` mounts force a fresh stdio spawn for every turn?
5. **Remote Claude auth.**  Should it use `claude login` on the server, or a long-lived `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`?  On a remote Mac, does the Keychain unlock for a non-interactive SSH session?
6. **v1 remote scope.**  Should worktree leases, checkpoints and phone attachments sync over SSH, or be refused?
7. **Upstream port or minimal token?**  Upstream's license is compatible, but it has diverged by 2,080 commits, and its managed tunnel depends on openmausbot.com.
8. **Linux builds and headless sign-in for each ACP CLI.**  Not checked engine by engine.
9. **iPhone to a headless harness.**  Does `tailscale serve` in front of the companion's loopback device port pair and stream correctly?  Can the control page issue a Tailscale pairing QR without the desktop app?
10. **Local-inject reach.**  Do Cursor, MiniMax Code, Muse and DeepSeek Harness reach local-inject through `drivers/acp/core.ts`, or are they left out?