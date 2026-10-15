# Slash Commands Verification

Probe-gated engine slash commands: reserved BotFleet commands plus allowlisted engine-native commands discovered at runtime or from on-disk command trees.

## Claude Code (`claudeAgent`)

Recorded with `scripts/probe-engine-commands.sh` under `server/drivers/__fixtures__/engine-commands/claude/2.1.287/`.

| Command   | Probe case        | Safe to forward |
| --------- | ----------------- | --------------- |
| `context` | `context`         | Yes (local)     |
| `compact` | `compact`         | Yes (session)   |

ZWSP shield cases (`zwsp-context`, `zwsp-advisor`) must keep `/context` and `/advisor` from mutating settings when typed as plain text.

## ACP agents

Shared fake-agent coverage: `server/drivers/acp/commands.test.ts` (`FAKE_ACP_COMMANDS`).

| Driver kind      | Allowlist source                                      |
| ---------------- | ----------------------------------------------------- |
| `grokAgent`      | `grokAgent/1.0.0/announced.json` + upstream `/compact` |
| `cursorAgent`    | fake-acp `compact`/`context`                          |
| `opencodeGo`     | fake-acp `compact`/`context`                          |
| `kimiAgent`      | fake-acp `compact`/`context`                          |
| `qwenAgent`      | fake-acp `compact`/`context`                          |
| `deepseekAgent`  | fake-acp `compact`/`context`                          |
| `droidAgent`     | fake-acp `compact`/`context`                          |
| `mcodeAgent`     | fake-acp `compact`/`context`                          |
| `dshAgent`       | fake-acp `compact`/`context`                          |
| `hermesAgent`    | fake-acp `compact`/`context`                          |
| `museAgent`      | fake-acp `compact`/`context`                          |

Live per-binary probes on macOS CI remain the authority before expanding allowlists.

## Static discovery (no spawn)

`server/drivers/engine-command-discovery.ts` scans:

| Driver kind          | Paths scanned                                      |
| -------------------- | -------------------------------------------------- |
| `claudeAgent`        | `.claude/commands`, `$CLAUDE_CONFIG_DIR/commands`  |
| `codex`              | `.codex/prompts`, `$CODEX_HOME/prompts`            |
| `antigravityAgent`   | `.gemini/commands`, `~/.gemini/commands`           |
| `cursorAgent`        | `.cursor/commands`, `~/.cursor/commands`           |
| `opencodeGo`         | same as Cursor tree                                |
| `grokAgent`          | `.grok/workflows`, `$GROK_HOME/workflows` (names)  |

Discovered names merge with cached runtime announcements; the allowlist still gates what the menu may offer.
