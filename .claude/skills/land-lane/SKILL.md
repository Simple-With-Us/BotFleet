---
name: land-lane
description: Land a Monet feature branch to main across the fleet — seat worktree, docs, verification gate, PR, auto-merge, then closeout. Use when finishing a unit, opening a PR, merging, or when the owner says land/ship/commit/push. Never wait for the owner to ask. Covers apps with and without scripts/land.sh.
---

# Land a feature branch (MONET)

> **Shared `~/.claude/skills`.** Monet, Claude/Fable, and (when active) Renoir all load this directory.  Do not treat the word Monet in examples as proof of your seat.  Pin `AGENT_SEAT` / `AGENT_TAG` from the logged-in account before Slack or `board --by`:
> - Monet → `MONET`, Notes `Monet`, `monet/`, `~/apps/<app>-monet`
> - Claude / Fable → `CLAUDE`, Notes `Claude`, `claude/`, `~/apps/<app>-claude`
> - Renoir → `RENOIR`, Notes `Renoir`, `renoir/`, `~/apps/<app>-renoir`
> Cursor, Grok, Grok Bot, Codex, AG, DeepSeek, Kimi, and Fx have their own skill dirs and must not take identity from here.


Always-commit is standing policy.  After each coherent finished unit: commit → push → PR → merge when CI is green.  A remote branch with no PR is unfinished.  Pause only for force-push, prod data wipe, or live-key revoke.

Seat: **$AGENT_SEAT**.  Branch: `<monet|claude|renoir>/<slug>`.  Never land from `~/Code/<repo>` or from branch `main`.

## Preconditions

1. You are in your Monet worktree (`~/apps/<prefix>-monet` or `~/apps/<prefix>-monet-<lane>`).  See `session-start`.
2. `git status` is clean except `.env.local` / `.dev.vars` (never commit those).
3. `git config user.email` is `12656028+jaywedgeworth22@users.noreply.github.com`.

```bash
git config user.email "12656028+jaywedgeworth22@users.noreply.github.com"
```

## Docs before the PR

1. Live effort board → In Progress with honest status; mirror `docs/EFFORT-LOG.md` in the same commit (fleet-infra has no mirror).
2. `STATUS.md` stanza: what landed, next action.
3. `docs/rollouts/YYYY-MM-DD-slug.md` — summary, why, files, verification commands actually run, follow-ups.
4. Substantial owner-facing work: living Apple Note via the `apple-notes` skill, title `[APP, Monet] …`.

Prose: commit body, rollout docs and Notes source take two ASCII spaces between sentences.  PR titles, bodies and comments take a real U+00A0 plus a space (convert with the `perl` recipe in `sentence-gap`; never the `&nbsp;` entity there).  Chat replies to the owner use `&nbsp;` plus a space in a Markdown chat pane and two ASCII spaces in a terminal.  See `owner-copy`.

## Gate

### Socratic.Trade — `scripts/land.sh`

Homebrew default `node` may be v26.  ST `better-sqlite3` is Node 24 (MODULE_VERSION 137).  Confirm `node --version` is v24.x:

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
node --version
PATH=/opt/homebrew/opt/node@24/bin:$PATH bash scripts/land.sh
```

The script (idempotent) refuses the integration worktree and branch `main`, refuses a dirty tree, fetches, refuses auto-merge on stale file overlap with `origin/main`, merges `origin/main`, runs `npx tsc --noEmit` → `npm test` → `npm run build`, pushes, opens a PR.

ST `land.sh` may still mention a retired path (`~/Code/Agentic Trading`).  The binding keepout is **any** `~/Code/<repo>` checkout.

If it dies on missing `workflow` OAuth scope (branch touched `.github/workflows/*`):

```bash
gh auth refresh -h github.com -s workflow
bash scripts/land.sh
```

**ai-fleet-coordinator also has a `land.sh` — do not run it.**  It is an ST clone (Node 24 + tsc/test/build) and this repo has no `package.json`.  Docs-only: commit, push, `gh pr create`.

### Other apps — merge main, run *that* repo's verify, then PR

```bash
git fetch origin
git merge origin/main --no-edit
# then the gate below — do not invent npm test
git push -u origin HEAD
gh pr create --fill
```

| App | Verify (from current AGENTS.md / ci.yml) |
|-----|------------------------------------------|
| CT | `cd app && npm run typecheck && npm test` (Deno).  CI job `typecheck + test`. |
| UM | `npm run verify` (eslint, tsc, vitest, build).  Node from `.node-version` (24). |
| CTS | `npm run typecheck && npm test && npm run build` (plus lint:package / pack:dry if you cut a release).  CI Node 20, job `verify`. |
| DealDex | `npm run lint && npm run typecheck && npm test && npm run build`.  CI Node 22, job `verify`.  Do not use `dealdex.vercel.app` (different site). |
| Personal-Site | CI `verify` is file-existence + About-copy grep.  `site/` is the TanStack Start source (README).  `AGENTS.md` may still say "static snapshot" — believe README + the tree.  Preserve `Earlier work included` and the Doximity `/profiles/…/view` URL or the daily mirror reverts them. |
| AFL | No app test gate.  `python3 scripts/check-fleet-registry.py` if you touched registries. |

CTS "prod" is an annotated tag `vX.Y.Z` after merge — announce on `#agent-sync` then tag.  Consumers pin the exact tag.

`STATUS.md` / `PLAN.md` / `docs/EFFORT-LOG.md` often carry `merge=union` in `.gitattributes`.  Additive board edits usually combine.  Never delete another agent's row while resolving.  Up to 3 land attempts are fine.

## Arm auto-merge

```bash
gh pr merge <N> --squash --auto
```

Not `--admin`.  Branch protection is `enforce_admins: true` plus conversation resolution.  Unresolved review threads block forever.  Use `codex-triage` / `unstick-pr`.

If the box is gating several lanes, post `[$AGENT_SEAT] gating now` with `repo:` (not `->FLEET` unless every Grok Bot seat must spend time).  Coordinator/ops self-id is `AFL`.

## After merge

- Board row: **Completed** means merged to `main`, not "PR opened."
- **Deployed** only after the app's production target is verified (`deploy-verify`).
- Merge to `main` auto-deploys ST / CT / UM on Coolify and DealDex on Vercel.  Do not double-trigger.  Personal-Site live origin is Vercel behind Cloudflare and is **not** "merge = live" — do not mint a second Vercel project.
- Closeout: `closeout` skill.

## Do not

- `LAND_SKIP_VERIFY` / `LAND_FORCE_PUSH` as an agent.  Humans only.
- Force-push shared history.
- Park a finished green PR "just in case."
- Claim Completed while threads are unresolved.

## Canon

- `/Users/jay/apps/AGENT-SYNC.md` — Always commit + land; merge requirements; branch/worktree naming
- App `AGENTS.md` Pre-Commit / Handoff + Verify before claiming done
- `scripts/land.sh` when present
- Skills: `session-start`, `unstick-pr`, `codex-triage`, `deploy-verify`, `closeout`, `owner-copy`
