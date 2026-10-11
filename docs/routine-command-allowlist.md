# Routine Command Allowlist

A routine can carry a `toolPolicy`:  the fixed commands its turns may run and the exact files they may write.  Every BotFleet bot runs with auto-approve, and a routine reads untrusted text (public pull requests, Linear issues, Zulip) while holding the owner's credentials.  A routine that only needs `agent-sync whoami` and one report command must not be talked into anything else.

Chat turns, webhook turns, resource turns and Zulip wakes are unchanged.  Only a routine's own scheduled or Run Now turns carry the allowlist, and every re-dispatch of that turn keeps it (a model fail-over, a credential card, a boot resume), because the allowlist is stored on the turn's prompt message.

## The Shape

```json
{
  "mode": "allowlist",
  "commands": [
    { "argv0": "/Users/jay/.local/bin/agent-sync", "sub": ["whoami"], "flags": { "--json": { "value": "none" } } },
    {
      "argv0": "/Users/jay/.local/bin/agent-sync",
      "sub": ["post"],
      "flags": {
        "--topic": { "value": "text", "required": true },
        "--body-file": { "value": "path", "paths": ["/Users/jay/apps/state/plumber/line.md"], "required": true }
      }
    },
    { "argv0": "/opt/homebrew/bin/python3", "sub": ["/Users/jay/apps/fleet-work-backup/fleet_work_backup.py", "health"], "flags": { "--json": { "value": "none" } } },
    {
      "argv0": "/usr/bin/tail",
      "sub": [],
      "flags": { "-n": { "value": "int", "min": 1, "max": 200 } },
      "args": [{ "value": "path", "paths": ["/Users/jay/Library/Logs/fleet-work-backup.log"] }]
    }
  ],
  "writePaths": ["/Users/jay/apps/state/plumber/line.md"],
  "readPaths": []
}
```

- `argv0` is an absolute path, compared as a string:  no PATH lookup, no `..`, no link resolution.
- `sub` is the fixed words that must follow, in order (a verb, or a script path then a verb).
- `flags` maps each allowed flag, spelled exactly, to its value:  `none` (a switch), `text`, `int` (with `min` and `max`), `oneOf` (with `values`), or `path` (with exact absolute `paths`).  `repeat` lets a flag appear more than once;  `required` makes it mandatory.
- `args` declares the positional words, in order, each with the same value kinds as a flag (minus the switch), and all of them required.  `positionals` is how many more free text words may follow (default 0).
- **Any word that names a file, a flag value or a positional, must be a `path`.**  A `text` word that names a file lets the model point the program at any file it can reach:  `tail` with a free positional reads `~/.secrets`.
- `writePaths` and `readPaths` are exact absolute files.  No directories, no globs, no dotfiles, and nothing under a credential or login directory (`.ssh`, `.secrets`, `.gnupg`, `.aws`, `.config/gh`, `Library/LaunchAgents`, `Library/LaunchDaemons`).  A write path's parent is created owner-only on first use, and the file is written owner-only (0600), as `agent-sync --body-file` requires.

`POST /api/routines` and `PATCH /api/routines/:id` take it as `toolPolicy`.  A PATCH that omits it keeps the stored one;  `null` removes it.  A routine with an allowlist must run on the bot (`runOn: "bot"`).  Bot-requested routine changes (routine cards) cannot set or clear it.

## How a Command Is Matched

The command is split into words the way a shell would for a narrow grammar:  single and double quotes group a word, so a topic name with spaces is one word.  Anything a shell would act on outside quotes is refused, not interpreted:  `;` `&` `|` `$` backtick `(` `)` `<` `>` newline, globs, `~`, `#`, `\`, `!` and braces.  Inside double quotes `$`, backtick, `\` and `!` are refused too.  An environment prefix (`PATH=... cmd`) is refused.

Then argv[0] must equal an entry's `argv0`, the entry's `sub` words must follow, and every other word must be an allowed flag with a value of its shape, or one of the entry's free positionals.  `--flag=value`, `--`, a repeated flag that is not `repeat`, a combined short flag (`-n50`), and a value or free word starting with `-` or `@` are all refused.

Some rules hold for every `agent-sync` call whatever the policy says, and a policy that tries to allow them is refused when it is saved:

- never `--as`, `--default-seat`, `--rc`, `--session`, `--no-tag`, `--fleet`, `--to` or `--to-owner`, nor any abbreviation of one (argparse expands `--fl` to `--fleet`);
- `dm` only with `--owner`.

A denial is logged with the program or tool name only, never an argument, and lands in the run's `denials`.

## Where It Is Enforced

In `server/drivers/acp/core.ts`, before the full-auto auto-allow, by `server/drivers/acp/allowlist.ts`.  Probes of the real engines on 2026-10-11 decided the design:

- Grok's `--permission-mode default` is not a guard by itself.  The owner's `~/.grok/config.toml` allows `Bash(*)` and `MCPTool(*)`, so a bare `touch PWNED` ran without any permission request, and MCP tools from that config (Composio among them) ran through `use_tool`.  In agent mode Grok ignores `--deny`, `--tools` and `--disallowed-tools`.
- MiniMax Code cannot be held.  In its Ask mode it ran a shell redirect, a bare `touch` and a file write without asking, and it ignores the client terminal.  Its `session/set_config_option permissionMode` also writes the owner's global `~/.minimax/config.yaml`, so the driver must never use it.

So an allowlist turn on Grok is held at four places:

1. **The pre-tool hook.**  BotFleet registers a client `pre_tool_use` hook (`_meta["x.ai/hooks"]` on `session/new` and `session/load`), and Grok asks it before every tool, MCP and subagents included, whatever its own allow rules say.  Only the shell, file write and file read tools are allowed, and only with an allowed command or file.  A Grok whose `initialize` advertises no blocking pre-tool hook is refused.
2. **Permission requests.**  Answered by the same policy, with an `allow_once` or `reject_once` option only, never an "always" option that would write a standing rule into Grok's own config.
3. **Execution.**  BotFleet tells Grok the client has a terminal and a file system, so a shell command arrives as `terminal/create` (`bash -lc '<command>'`) and a write as `fs/write_text_file`.  BotFleet checks it again and runs the argv itself with no shell, under the engine child's own environment (the bot's launch seat included), or writes the one allowed file with `O_NOFOLLOW`.
4. **A tripwire.**  A tool that starts or finishes without the hook having allowed it means the engine bypassed BotFleet:  the turn stops at once with `capability_denied`.

The turn is also spawned without bypass (`--permission-mode default`), with web search and subagents off and `--no-leader`, and BotFleet mounts no MCP servers for it.

Every other engine is refused:  the ACP core refuses an allowlist turn on an engine whose support declares no `allowlist` (MiniMax Code, DSH and the rest), and the harness refuses to send one to any driver whose capabilities lack `toolPolicy` (Claude, Codex, the HTTP engines, the Cloud VM runner).  The run fails and says why;  it never runs without the allowlist.

## Tests

- `server/tool-policy.test.ts`:  the tokeniser and matcher, including the attack cases (chaining, substitution, redirects, globs, path tricks, environment prefixes, long-option smuggling, `@file` words, a non-owner `dm`).
- `server/drivers/acp/allowlist-core.test.ts`:  the driver core against a scripted Grok-shaped engine, real child processes and a real file system.
- `server/routines-tool-policy.test.ts` and `server/routine-allowlist-wiring.test.ts`:  the routine API, the run snapshot, and the harness refusing MiniMax Code.
- `server/drivers/acp/allowlist-live.test.ts`:  the real `grok` CLI under the owner's own config.  Opt-in with `BOTFLEET_ALLOWLIST_LIVE=1`;  it spends real model turns and never runs in CI.
