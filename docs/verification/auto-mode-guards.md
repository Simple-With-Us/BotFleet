# Auto Mode Guards

Auto mode lets a bot answer its own permission requests.  Three guards stop a request anyway, and outrank any "Always allow" grant: the destructive guard, the sensitive guard, and the system guard.  This recipe verifies the rows that keep a single-stage command with no shell metacharacter, and a Write or Edit, from slipping past them.

## Setup

Everything runs against temporary data directories and free ports.  Nothing here touches a real `~/.botfleet` or the live server.

```sh
pnpm install --frozen-lockfile
```

## Steps

```sh
# 1. The command rows: git clean, git checkout ., git restore ., find -delete,
#    truncate, killall and pkill, launchctl and crontab, global installs
pnpm exec vitest run server/command-guard.test.ts

# 2. Where a Write or Edit really lands: symlinks, .. after a symlink,
#    dangling links, relative and ~ spellings, roots that are too wide
pnpm exec vitest run server/path-containment.test.ts

# 3. The verdicts: guards outrank grants, startup files are sensitive, a
#    file write is judged by its real path, the reviewer never sees a guard
pnpm exec vitest run server/auto-approve.test.ts server/auto-review.test.ts

# 4. The Claude driver carries a file-writing ask's raw path and the turn folder
pnpm exec vitest run server/drivers/claude.test.ts -t "carries the raw path"

# 5. End to end: a real server, the fake Claude CLI, the broker socket
pnpm exec vitest run server/auto-mode-guards-wiring.test.ts
```

## Expected Evidence

A passing run shows:

- **Command rows:** each destructive and system command stops under the rule that names it, however it is spelled (quoted, wrapped in `sudo`, `env`, `sh -c`, prefixed with `VAR=value`, behind `git -C`, chained).  Ordinary commands next to each row keep auto-approving: `git status`, `git checkout -b`, `git clean -n`, `npm install`, `npm run test -- -g slow`, `rm` of a file in the workspace, `crontab -l`, `launchctl list`, `brew list`.
- **Path containment:** a write through a symlink in the workspace, below a dangling symlink, past a `..` that follows a symlink, to a sibling folder that shares a name prefix, or to the home folder is refused.  A new file under folders that do not exist yet is judged by its nearest existing parent.
- **Verdicts:** a stopped request carries `destructive-guard`, `sensitive-guard` or `system-guard` with the rule that decided, even with the program or tool in the bot's always-allow list and even in an unattended turn.  The model reviewer only looks at undecided requests, so it never sees any of them.
- **Cards:** the approval card says why auto mode stopped to ask, and offers no "Always allow".
- **Decision log:** `GET /api/decisions` shows a `card-shown` row naming the source and rule.

## Key Behaviors Verified

- **The guards outrank grants.**  `Bash:git` allowed does not cover `git clean -fd`; `Write` allowed does not cover a write outside the bot's folders.
- **The path is judged where it lands.**  The driver carries the model's raw spelling; the server resolves it against the filesystem, so a symlink cannot move a write out of the bot's folders and `~/.zshrc` or a LaunchAgent plist cannot be written without a card.
- **Roots are the turn folder, the bot's own workspace and the temp folders.**  The home folder, an ancestor of it, and the filesystem root are never roots, so a bot with no folder set cannot write its own startup files.
- **Other tools are not judged by their text.**  A README edit that says "brew install jq" or "pkill node" is not a global install and is not stopped.

## Known Limits

- The rows read the command text.  A program run through a variable (`$TOOL clean`) or a script file is out of their sight, and so is a symlink swapped in between the check and the write.  This is a "you probably did not mean to hand this over unattended" backstop, not a sandbox.
- The verdict cannot see whether a Python virtualenv is active, so a bare `pip install` asks.  `pip install` through a virtualenv's own `bin/pip`, or with `VIRTUAL_ENV=` in the command, does not.
- Only Claude's Write, Edit, MultiEdit and NotebookEdit carry a path today.  Other engines' file tools are judged as before.
- The checks only see what reaches the permission broker.  The Claude CLI in `acceptEdits` mode accepts edits inside its own working folder without asking, so a legacy task that runs with no folder set (the CLI then starts in the home folder) never raises an ask for a file under home, and a `bypassPermissions` (full auto) instance has no broker at all.  Both come from the CLI's documented behavior and were not reproduced against a real CLI here.
- A command summary is read as the command text.  Codex's older approval shape and an ACP command sent as an array do not carry that text, so the rows have nothing to match there.

## Cleanup

The tests clean up their temporary folders and processes.  No manual cleanup is needed.
