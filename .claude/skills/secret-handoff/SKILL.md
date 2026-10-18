---
name: secret-handoff
description: >-
  Fleet secret handling — fleet-secrets, Infisical, Coolify token split, grep trap, leak response. Load BEFORE any command that might touch a credential, before reading ~/.secrets, Infisical, .env, or vault output, and before debugging auth. Trigger even when the user does not say "secret."
---

# Secret handoff (MONET)

> **Shared `~/.claude/skills`.** Monet, Claude/Fable, and (when active) Renoir all load this directory.  Do not treat the word Monet in examples as proof of your seat.  Pin `AGENT_SEAT` / `AGENT_TAG` from the logged-in account before Slack or `board --by`:
> - Monet → `MONET`, Notes `Monet`, `monet/`, `~/apps/<app>-monet`
> - Claude / Fable → `CLAUDE`, Notes `Claude`, `claude/`, `~/apps/<app>-claude`
> - Renoir → `RENOIR`, Notes `Renoir`, `renoir/`, `~/apps/<app>-renoir`
> Cursor, Grok, Grok Bot, Codex, AG, DeepSeek, Kimi, and Fx have their own skill dirs and must not take identity from here.


Load `~/.claude/skills/secret-safety/SKILL.md` as well when that file exists.  This skill is the fleet overlay.

**Redact in the same command that touches the secret.**  If you are deciding whether output is safe to show, you are already too late — it is in the transcript.

## Reading fleet secrets on the Mac

Use `fleet-secrets` (reads Infisical Fleet-OPS `prod`).  Nothing may read the flat file `~/.secrets/global-api-keys` any more (OPS-818).

```bash
fleet-secrets names                 # key names only
fleet-secrets get NAME              # one value on stdout, no newline; exit 3 if absent
fleet-secrets run --only A,B -- CMD # exec CMD with just those keys as env vars
fleet-secrets doctor                # booleans and counts only
```

Cloud: `GET https://mac.jays.services/files/key-names` with the same Bearer as `/files` (`MAC_COLLAB_TOKEN`).  Use names-only lookup; runtime keys are managed via Infisical per app.

Infisical (the app's own project, prod) is the source of truth for **deployed app runtime** secrets.  Copy cross-app keys into the consuming Infisical project (store-to-store), do not teach the app to call `fleet-secrets`.

Owner drops a `chmod 600` file and gives you the path.  Never print the value.  Prefer scoped, revocable credentials.  Remind the owner they can revoke when the task is done.

## Grep trap (2026-08-14)

A tool result that contains even one `KEY=value` line has leaked.

Forbidden:

```bash
cat ~/.secrets/<any file>
grep '^[A-Z0-9_]+=' ~/.secrets/<any file>
rg TOKEN ~/.secrets/
fleet-secrets get NAME              # on a real key, just to look at it
# Read / open-file / less / bat on any ~/.secrets path
```

Allowed:

```bash
fleet-secrets names

TOKEN="$(fleet-secrets get SOME_KEY)" || exit $?
some-command 2>&1 | sed "s/${TOKEN}/[REDACTED]/g"
```

Your file-read tool is `cat` for this purpose.  Do not "just look" with Read because grep quoting confused you.

## Infisical

Never:

```bash
infisical secrets
infisical secrets --output json
infisical secrets get KEY --plain    # unless immediately reduced to length
```

Prefer `bash scripts/infisical-secrets-safe.sh {set|has|names} --projectId … --env prod`.  Verify writes by key presence and **length**, never by printing the value.

## Coolify

| Key | Allowed use |
|-----|-------------|
| `COOLIFY_SERVER_STATS` | Read-only metrics / server-stats UI |
| `COOLIFY_AGENTS` | Agent deploy/admin only |

Never put `COOLIFY_AGENTS` into Infisical as app `COOLIFY_API_TOKEN`.  Prefer env vars over `--token` flags (`ps` and debug loggers).

## Cloudflare "dead token" (2026-08-13)

Do not declare a Cloudflare credential dead without a real resource call.

1. `/user/tokens/verify` only understands **user-owned** tokens.  Account-owned tokens 401 there by design — use `/accounts/{id}/tokens/verify` or `GET /zones`.
2. Global API Key "9103 Unknown X-Auth-Key" can mean the **wrong email**, not a dead key.  This fleet has multiple Cloudflare logins.  Try the pairing in AGENT-SYNC / the CLOUDFLARE names from `fleet-secrets names` before concluding.

Empty `success:true` on a filtered Bearer call means "valid, not scoped to that filter," not dead.  Prefer `CLOUDFLARE_FLEET_API_TOKEN` for ordinary work.

## If it leaks

1. Stop.
2. Name exactly which credential (the owner already has it).
3. Tell the owner to rotate.
4. Delete scratch files / Slack / GitHub comments you can still edit.  Do **not** force-push git history.  You cannot edit a prior chat turn — say so.
5. Change the technique, not "be more careful."

## Canon

- `/Users/jay/apps/AGENT-SYNC.md` § Secret handoff, Infisical, Coolify, grep trap, leak response
- `~/.claude/skills/secret-safety/SKILL.md`
- Coordinator `docs/rollouts/2026-08-15-secret-file-grep-ban.md`
