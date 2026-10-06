# What Else The VM CLI Layer Should Carry

Companion to `2026-10-06-mcp-plugin-registry.md`, for board `6af489a6`.
Owner ask, 2026-10-06: land the 45, then make a list of what else to add,
including CLI for apps he currently uses as desktop GUI or web.

## Where The Layer Stands

`scripts/computer-vm-cli/manifest.json` already carries **51 tools**, installed
as an image layer and checked by a fail-closed `botfleet-vm-cli-verify` that
fails the build if any of them is missing.  Base apt tools (curl, jq, rsync,
vim, tmux, sqlite3, python3, openssl, gpg, zip, unzip, ssh, scp, sftp, awk,
sed, grep, tar, make, clang, gcc, java, ruby, gem, perl, psql, ffmpeg, fzf, fd)
plus node 24.11.0, pnpm, cf, vercel, kodus, aws, gcloud, gh, kubectl, docker,
turso, deno, cargo, rustc, and pbcopy/pbpaste shims, plus host-auth entries for
infisical, git, netrc, azure, and fly.

The Mac has 160 brew formulae, 8 casks, and 5 npm globals.  This is the gap
between the two.

## Add Next, Linux-Clean

Ordered by how much a bot actually reaches for them.

| Tool | Why | How |
| --- | --- | --- |
| `ripgrep` | Missing entirely, and `grep` is a poor substitute for an agent.  This is the single biggest omission. | apt |
| `wrangler` | Cloudflare Workers, Pages, Queues, R2.  The fleet runs Cloudflare heavily. | npm global |
| `cloudflared` | Cloudflare Tunnel; an always-on pm2 job on the Mac. | binary |
| `shellcheck` | Cheap in apt, and it is the tool that catches the bugs bots write. | apt |
| `tesseract` + `poppler` | OCR and `pdftotext`/`pdfimages`.  On a computer-use desktop, reading a screenshot or a PDF is a daily job. | apt |
| `actionlint` | Lints the workflows this repo ships. | binary |
| `gitleaks` | Secret scanning, and this repo already gates on it in CI. | binary |
| `pm2` | The Mac runs pm2 fleet-wide; the VM should not be the odd one out. | npm global |
| `protoc` | Many builds stop without it. | apt or binary |
| `gdu` | A `du` a human can read. | binary |
| `mosh` | Survives a network blip that would drop ssh. | apt |
| `git-filter-repo` | History surgery. | binary or pip |
| `mise` | Toolchain manager, so a bot can pin a runtime on demand instead of asking for an image rebuild. | binary |
| `uv` | Python environments without touching system Python. | binary |
| `ollama` | Local model serving, if a bot ever needs one.  Large; consider on-demand. | binary |

Two of these need a decision rather than a line in a file.  `tesseract` and
`poppler` are the highest-value adds for a *desktop* VM specifically, because
the desktop is where documents and screenshots live.  `ollama` is large enough
that it argues for a base-image change rather than a layer.

## Take The CLI Part Of A Cask

Only three casks have a Linux-viable CLI.

- `android-commandlinetools` — `sdkmanager`, `adb`, `fastboot` are
  cross-platform.  Worth it if Android work ever moves into the VM.
- `antigravity-cli` — npm, cross-platform, and BotFleet already has an
  `antigravity` driver, so this makes the VM match the host.
- `copilot-cli` — npm, cross-platform.

## Never Add: macOS Only

Naming these so a future pass does not try.  Each is in the Mac brew list and
cannot work in a Debian container.

- `xcodegen`, `xcbeautify` — need Xcode.  iOS builds belong on the Mac or a GH
  runner, never in this VM.
- `orbstack` — a macOS container runtime.  The VM already has Docker.
- `cleanmymac-cli`, `dockdoor`, `music-decoy`, `mas`, `pinentry-mac` — Mac
  system tools.
- `mlx`, `mlx-c` — Apple Silicon Metal.  No GPU in the VM.
- `git-gui` — Tcl/Tk desktop, no value over a terminal.

## GUI And Web Apps: Use MCP, Not A CLI

This is the part worth being deliberate about, because it is the question that
actually decides the registry's value.

For a desktop app with a real command line, the CLI belongs in the manifest.
For a **SaaS or web app there is no CLI worth having**, and pretending
otherwise produces a pile of thin wrappers.  The current best-practice
interface for those is an official MCP server, and the registry landed in
`2026-10-06-mcp-plugin-registry.md` is exactly the mechanism that delivers one.

| App | Use | Not |
| --- | --- | --- |
| GitHub | `gh` (in the manifest) + GitHub MCP for PR/issue nuance | — |
| Cloudflare | `wrangler` + Cloudflare MCP | — |
| Sentry | the `sentry-mcp.ts` BotFleet already ships | — |
| Linear, Notion, Figma, Slack, Stripe, 1Password | their official MCP servers as registry rows | a hand-rolled CLI |
| Docker Desktop | `docker` (in the manifest) | — |
| Chrome | already in the `trycua/xfce-cua` base | — |
| VS Code | `code-server` if a desktop IDE is ever wanted | — |

So the honest answer to "CLI for the apps I use in web format" is: **the ones
that have an official CLI get the CLI, and the rest get an MCP row.**  That
split is also why the two pieces of work belong together — the manifest is the
CLI lane and the registry is the SaaS lane.

## One Open Question

Should the VM carry **agent CLIs** — `claude`, `codex`, `cursor-agent`, `dsh`,
`opencode`, `antigravity-cli`, `copilot-cli`?

Today they are unnecessary, because BotFleet spawns its drivers on the host and
the VM is only a desktop.  They become interesting the moment you want a bot
inside the VM to launch a nested agent — which is the "link the platforms to
each other" idea taken literally.  It is a real capability, and it is also a
large one, because each CLI needs credentials of its own inside the container.
Worth deciding deliberately rather than by drift.

## Sequence

1. Land the current layer, recreate the VM, confirm the 51 work.  This is in
   flight.
2. Add the Linux-clean table as one manifest change plus recipe work.  Most are
   a line each; `wrangler` and `pm2` are npm globals.
3. Decide the agent-CLI question separately; it deserves its own row.
4. Fill the MCP registry and add SaaS rows there, not here.