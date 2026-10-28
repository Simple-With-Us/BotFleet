---
name: fleet-coordination
description: Comprehensive master skill for multi-agent fleet operations across all apps and platforms (Antigravity/Gemini, Monet, Claude, Cursor, Grok, Codex, DeepSeek). Use at session start, when claiming work on effort boards, managing pull requests, handling secrets safely, writing owner-facing Apple Notes, ensuring sentence gap compliance, and deploying to production.
---

# Fleet Coordination Protocol (Universal)

> **Shared `~/.claude/skills`.** Monet, Claude/Fable, and (when active) Renoir all load this directory.  Do not treat the word Monet in examples as proof of your seat.  Pin `AGENT_SEAT` / `AGENT_TAG` from the logged-in account before Zulip or `simple-board --by`:
> - Monet → `MONET`, Notes `Monet`, `monet/`, `~/apps/<app>-monet`
> - Claude / Fable → `CLAUDE`, Notes `Claude`, `claude/`, `~/apps/<app>-claude`
> - Renoir → `RENOIR`, Notes `Renoir`, `renoir/`, `~/apps/<app>-renoir`
> Cursor, Grok, Grok Bot, Codex, AG, DeepSeek, Kimi, and Fx have their own skill dirs and must not take identity from here.


Canonical reference: `/Users/jay/apps/FLEET-PROTOCOL.md` and `/Users/jay/apps/EFFORT-LOG-PROTOCOL.md`.  
Zulip Coordination Channel: `#Work-In-Progress`.

This skill governs how autonomous AI agents collaborate across the entire application fleet (Socratic.Trade, Congress.Trade, Usage-Monitor, congress-trading-shared, DealDex, Personal-Site, Autorotate, ContactLogo, and ai-fleet-coordinator).

---

## Canonical Fleet App Acronyms

Use these canonical acronyms in Apple Notes titles (`[APP, Agent] topic`), commit messages, PRs, and Slack `#Work-In-Progress` communications:

| Acronym | App / Scope | Repository |
| :--- | :--- | :--- |
| **`ST`** | Socratic.Trade | `Simple-With-Us/Socratic-Trade` |
| **`CT`** | Congress.Trade | `Simple-With-Us/Congress.Trade` |
| **`UM`** | Usage-Monitor | `Simple-With-Us/Usage-Monitor` |
| **`DD`** | DealDex | `Simple-With-Us/DealDex` |
| **`CL`** | ContactLogo | `Simple-With-Us/ContactLogo` |
| **`AR`** | Autorotate (formerly TopSpin) | `Simple-With-Us/Autorotate` |
| **`AFL`** | ai-fleet-coordinator (this repo / Mac collab / skill pack) | `Simple-With-Us/ai-fleet-coordinator` |
| **`OPS`** | fleet-ops (sibling identity; do not invent a checkout here) | `Simple-With-Us/fleet-ops` |
| **`PS`** | Personal-Site | `Simple-With-Us/Personal-Site` |
| **`CTS`** | congress-trading-shared | `Simple-With-Us/congress-trading-shared` |
| **`FLEET`** | Slack wake: every Grok Bot seat | Not a repo.  Not the coordinator.  `[SENDER->FLEET]` means every `[GB-<NAME>]` seat must spend time. |

**Self-id:** this coordinator/ops system signs as **`AFL`**.  Never `[FLEET]`.  Never `[GB-FLEET]`.  Former aliases `AFC` / `AIFC` / `FC` are retired.  Sibling infra identity is **`OPS`**.

---

## 1. Session Startup & Identity

Every agent session must start with systematic orientation before touching code:

1. **Establish Seat Identity:**
   - Antigravity / Gemini: `[AG]` (display `AG` or `Antigravity`, branch prefix `agent/` or `ag/`)
   - Monet: `[$AGENT_SEAT]` (display `Monet`, branch prefix `monet/`)
   - Claude: `[CLAUDE]` (display `Claude`, branch prefix `claude/`)
   - Grok / Grok Build: `[GROK]` / `[GROK-BUILD]` (display `Grok` / `Grok Build`, branch prefix `grok/` / `grok-build/`)
   - Cursor: `[CURSOR]` (display `Cursor`, branch prefix `cursor/`)
   - DeepSeek: `[DEEPSEEK]` (display `DeepSeek`, branch prefix `deepseek/`)
   - Codex: `[CODEX]` (display `Codex`, branch prefix `codex/`)
   - Grok Bot: `[GB-<NAME>]` (GB-CONDUCTOR, GB-MONITOR, GB-FIXER, GB-DEPLOYER, GB-COMPILER, GB-NURSE, GB-HOUSEKEEPER, GB-ACCOUNTANT, GB-ORACLE — not `[GROK-BOT]`, not `[CURSOR]`)
   - Fx: `[FX]` (display `Fx`, branch prefix `fx/`)
   - Renoir: `[RENOIR]` (display `Renoir`, branch prefix `renoir/`)
   *(Note: KIMI is permanently retired/unavailable per owner directive 2026-08-21).*

2. **Poll Coordination Channel:**
   ```bash
   AGENT_TAG=<YOUR_TAG> /usr/bin/python3 /Users/jay/apps/simple-chat
   ```
   Skim for your agent tag or repositories you plan to touch.  Grok Bot seats also full-read `[SENDER->FLEET]` (every GB seat must spend time).  Coordinator self-id is `AFL`, not `FLEET`.

3. **Check Linear & Work Items:**
   ```bash
   board stats
   board list --status open,in_progress --limit 25
   ```
   Effort logs are archived — use Linear (`simple-board` or agent-sync `linear_list` when mounted), not `~/apps/*EFFORT-LOG.md` or `docs/EFFORT-LOG.md`, for open work.

---

## 2. Worktree & Lane Isolation

**Strict Rule:** NEVER work directly in `/Users/jay/Code/<Repo>` root checkouts.  The root checkouts in `~/Code/` are shared review bases and must remain clean on `main`.

Always work in an isolated worktree under `~/apps/`:
```bash
git -C /Users/jay/Code/<Repo> worktree add -b <seat>/<feature-slug> ~/apps/<app>-<seat>-<feature-slug>
```

---

## 3. Claim & Task Lifecycle

Before starting substantial work, reserve your lane on Linear and Zulip:

1. **Linear (`board claim` / `board file`):**
   - Claim or file the issue In Progress with your tag, branch, worktree, and concise objective.
   - Do not edit archived effort logs (`~/apps/*-EFFORT-LOG.md` or repo `docs/EFFORT-LOG.md`).
2. **GitHub Issue (when applicable):**
   - Link your branch to the corresponding GitHub Issue or create one.
3. **Slack Channel `#Work-In-Progress`:**
   Post a standardized claim header:
   ```text
   [<YOUR_TAG>] sync-1
   repo: <RepositoryName>
   claim: <seat>/<feature-slug>
   state: WIP
   work: <One-line summary of task>
   ```

*(Reserve `[<TAG>->FLEET]` strictly for urgent wakes that every Grok Bot seat must spend time on.  Coordinator/ops posts as `[AFL]`, never as `[FLEET]`.)*

---

## 4. Secret Safety & The Grep Trap

**Mac reader:** `fleet-secrets` (`get NAME`, `run`, `names`), which reads Infisical Fleet-OPS.  Nothing may read the flat file `~/.secrets/global-api-keys` any more (OPS-818).  
**Sole Runtime Truth:** **Infisical** is the source of truth for all deployed app runtime secrets.

### Strict Grep Trap Ban (2026-08-14):
NEVER print a secret value, and never `cat`, `grep`, `rg`, or `view_file` anything under `~/.secrets/`.  Doing so dumps raw secrets into transcript logs.

- **Inspection (Names only):**
  ```bash
  fleet-secrets names
  ```
  *(Or via cloud API: `GET https://mac.jays.services/files/key-names` with Bearer auth).*
- **Extraction into single variable (Never echo):**
  ```bash
  SECRET_VAL="$(fleet-secrets get TARGET_KEY)" || exit $?
  # or hand a command only the keys it needs:  fleet-secrets run --only KEY_A,KEY_B -- CMD
  # Use $SECRET_VAL directly without echoing or printing
  ```
- **Infisical CLI:** Never run bare `infisical secrets` or `--output json`.  Use `bash scripts/infisical-secrets-safe.sh {set|has|names}`.

---

## 5. Sentence Gap Protocol (Monet Portable Standard)

Visibly wider gap (two visible spaces) after terminal punctuation (`.`, `!`, `?` when a new sentence follows) in all human-readable prose:

| Surface | Syntax | Why |
| :--- | :--- | :--- |
| **Every surface** (owner ruling 2026-10-23):  chat replies in any other pane, Zulip, GitHub PR and issue text, review comments, Linear, commit messages, repo docs, skills, agent instructions, rendered UI copy | A real U+00A0 plus a normal space, generated in the shell | One rule everywhere.  Two ASCII spaces collapse on rendered surfaces, and the `&nbsp;` entity shows literally in squash commits and plain text. |
| **Claude Code Code tab and the MiniMax Code chat pane: chat replies** | The `&nbsp;` entity plus a normal space, outside code spans | The one exception (owner ruling 2026-10-23):  those two panes normalize a raw U+00A0 away, so the entity is the form that renders a real gap there.  The entity is never the form anywhere else. |
| **HTML / JSX / Swift source for product copy** | Swift `"\u{00A0} "`, JS/TS strings `"\u00A0 "`, JSX text `{'\u00A0'}` plus a space or `&#160;`, HTML markup source `&#160;`, or a shared `SENTENCE_GAP` constant | Same rendered gap; never `&nbsp; ` |
| **Code, identifiers, machine-readable config** | No gap character | Never put U+00A0 into code |

*Do not apply after abbreviations (`e.g.`, `v1.2.3`) or in URLs/identifiers.*

---

## 6. Apple Notes Review Standard

All plans, design docs, rollouts, audits, and completion notes for owner review must be created in Apple Notes:

1. **Folder:** folder **`Coding`** (local folder on this Mac, intentionally non-iCloud).
2. **Title Format:** `[APP, Agent] Short topic` (e.g. `[ST, AG] Market data cascade`).  App acronyms FIRST, agent name in Title Case, NO date in title.
3. **Second Line:** Timestamp `Day, Mon D, h:mmam|pm · PR #<num>`.
4. **Helper Script:**
   ```bash
   /Users/jay/apps/apple-notes-coding.sh "Title" "HTML or markdown body"
   # To update in place:
   /Users/jay/apps/apple-notes-coding.sh --update "Title" "Updated body"
   ```

---

## 7. PR Landing & Verification Loop

Follow the "Always Commit + Land Finished Work" discipline:

1. **Merge `origin/main` & Verify Locally:**
   - Socratic.Trade: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run verify` / `bash scripts/land.sh`
   - Congress.Trade: `cd app && npm run typecheck && npm test`
   - Usage Monitor: `npm run verify`
   - congress-trading-shared: `npm run typecheck && npm test && npm run build`
   - DealDex: `npm run lint && npm run typecheck && npm test && npm run build`
2. **Push Branch & Open PR:**
   ```bash
   git push -u origin HEAD
   gh pr create --fill
   ```
3. **Arm Auto-Merge:**
   ```bash
   gh pr merge <PR_NUMBER> --squash --auto
   ```
4. **Unsticking Blocked PRs:**
   - Test mergeability: `git merge-tree --write-tree origin/main origin/<branch>`.
   - If exit 0 (Phantom conflict): Rebase/merge `origin/main` and push fresh head.
   - If bot threads blocking: Check GraphQL `reviewThreads`, address genuine issues, and resolve threads.

---

## 8. Deployment Verification & Closeout

Once PR merges to `main`:
1. **Verify Production Deploy:**
   - Check public health: `curl -s https://socratictrade.com/api/health`, `curl -s https://congress.trade/api/health`, `curl -s https://usage.jays.services/api/health`.
   - Confirm HTTP 200 and expected `build.sha`.
2. **Triple Closeout:**
   - Effort board: Update row to **Deployed** (or **Completed**) with live verification note.
   - GitHub Issue: Close issue.
   - Slack `#Work-In-Progress`: Post `[<YOUR_TAG>] closeout` with deployed status and health check results.
   - Apple Note: Add final verification stamp.

---

## 9. Mac Local Processes Registry

If you create, change, load, bootout, or retire a LaunchAgent, cron job, pm2 process, or shared helper script:
- Update `/Users/jay/apps/MAC-LOCAL-PROCESSES.md`.
- Update Apple Note: `apple-notes-coding.sh --update "⭐️ Background Jobs Master List"`.
