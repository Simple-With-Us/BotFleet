# BotFleet On A Linux Server

The BF-2600 [storage and resource scaffold](../../docs/rollouts/2026-10-30-linux-storage-scaffold.md) adds mount/device guards, volume-backed temporary paths and explicit resource/log-rotation inputs.  It is not installed by a code-only update.  Its private namespace keeps the volume busy until the service stops; live isolation and placement evidence remain unasserted.

This directory deploys the BotFleet harness headless on a Linux host (the Hetzner box) as the `jay` user.  Every file the harness writes lives under one root on the `/mnt/fleet-extra` volume.  The only way in is a Tailscale serve URL that carries an owner credential.

## What Runs Where

| Piece | Where | Notes |
|---|---|---|
| Harness | `127.0.0.1:8799` | `node --experimental-strip-types server/index.ts`, plus the webhook listener on `8800`. |
| Owner gate | `127.0.0.1:8798` | `deploy/linux-server/owner-gate.mjs`, a reverse proxy in front of the harness. |
| Tailnet URL | `https://<host>.<tailnet>.ts.net:8799` | `tailscale serve` in front of the gate. |
| Units | `botfleet-server.service`, `botfleet-owner-gate.service` | System units, both run as `@BF_USER@` with `UMask=0007`. |

The runtime root (`BF_ROOT`) holds everything the service writes:

```
/mnt/fleet-extra/apps/botfleet-server/     BF_ROOT
├── home/      the service user's HOME: engine logins, caches, credentials
├── data/      OMB_DATA_DIR: harness state, workspaces, checkpoints
├── logs/      server.log and historical owner-gate.log (new gate logs use journal)
├── bin/       installed startup/preflight helpers retained through code rollback
├── tmp/       TMPDIR
├── config/    server.env, infisical-read-token and harness-infisical-token
├── workdir/   the systemd working directory
└── node/      the private Node install (v24)

/mnt/fleet-extra/Code/BotFleet-server/     BF_CODE, the detached checkout
```

## The Security Model

The harness binds loopback and treats every loopback caller as the owner.  That is why nothing may forward an unauthenticated remote caller to it, and why the gate exists.

- The gate accepts a request only when the caller is on loopback, the request carries an owner credential, the browser `Origin` (when present) equals the single allowed public origin, and `sec-fetch-site` is not `cross-site`.
- The gate rewrites `Host` to `127.0.0.1:8799` and strips the identity, forwarding, `sec-fetch-*` and Cloudflare edge headers, so the harness sees a plain loopback caller and nothing else.
- `tailscale serve` is tailnet only.  Never enable Funnel: Funnel is public and adds no identity header, which would leave the gate with no owner check at all.
- No port is exposed to the public internet, and nothing listens on a routable address.
- The unit templates configure ordinary root paths read-only and put application data and literal temporary paths on the volume.  `/run`, `/dev/shm` and live namespace behavior still need recipe 12's write attempts; configuration text alone proves no isolation.  Private volume propagation keeps the volume busy until both services stop.
- Any local process on the host can still reach `127.0.0.1:8799` directly, the same as on the Mac today.  Only trusted users should have shell access on the host, and every bot shell runs as the service user.

## Where The Configuration Lives

Infisical is the sole source of truth for every secret, setting and on/off switch, so the owner gate reads its whole configuration from the vault and reads no environment variable at all.  There is no fallback chain and no local copy: if the vault cannot be read, the gate says so and exits, and systemd restarts it.

The gate reads the **BotFleet** project (`836aebe2-c8f7-4e09-978e-7e3e82500bce`), environment **`prod`**, path **`/botfleet-server`**, once at start:

| Infisical name | Kind | What the gate does with it |
|---|---|---|
| `BOTFLEET_SERVER_GATE_TOKEN` | secret | The desktop gate token.  The gate hashes it in memory and keeps only the sha256, so a leaked configuration cannot be replayed as a credential. |
| `BOTFLEET_OWNER_LOGINS` | config | Comma-separated Tailscale logins on the owner allowlist. |
| `BOTFLEET_PUBLIC_ORIGIN` | config | The only browser `Origin` the gate accepts. |

At least one of `BOTFLEET_OWNER_LOGINS` and `BOTFLEET_SERVER_GATE_TOKEN` has to be there: without an owner credential the gate refuses to start rather than wave every request through to the harness.

### The One Local Item: config/infisical-read-token

Reading the vault needs a key, so the gate keeps one local file:

```
/mnt/fleet-extra/apps/botfleet-server/config/infisical-read-token
```

- A **read-only Infisical service token** (`st.…`), scoped to the BotFleet project, the `prod` environment and the `/botfleet-server` path.  It grants reading those secrets and nothing else.
- Mode `0600`, owned by the service user (`jay`), a regular file: the gate refuses a symlink, a wrong mode or a foreign owner.
- The installer refuses to run without it.  Create it with:

```sh
sudo install -m 600 -o jay -g fleet /dev/null /mnt/fleet-extra/apps/botfleet-server/config/infisical-read-token && sudo -u jay bash -c 'IFS= read -rs t && printf %s "$t" > '/mnt/fleet-extra/apps/botfleet-server'/config/infisical-read-token'
```

The token is read from the terminal without echo and written straight into the file, so it never reaches argv or the shell history.

### Harness vault token: config/harness-infisical-token

A second local file, distinct from the gate's token above: the key the harness itself reads its vault secrets with.

```
/mnt/fleet-extra/apps/botfleet-server/config/harness-infisical-token
```

- A **read-only Infisical service token** (`st.…`), scoped to the BotFleet project, the `prod` environment and the folders the harness reads: the root path, plus `/zulip` when Zulip credentials come from the vault (`zulip.credentialSource: "infisical"`).  It grants reading those secrets and nothing else.
- Mode `0600`, owned by the service user (`jay`), a regular file: `start.sh` refuses a symlink, a non-regular file, a foreign owner, or any group/other permission bits, prints one line naming the file and the reason, and starts the server without it.
- `start.sh` loads it into `INFISICAL_TOKEN` only when the environment does not already set one; an `INFISICAL_TOKEN` already in the environment always wins.  The project itself comes from `INFISICAL_PROJECT_ID` in `config/server.env` (or the stored Settings); the token file carries only the token.
- The file is optional and the installer never creates it: without it (and without `INFISICAL_TOKEN` in the environment) the harness simply has no vault to read.  Create it with:

```sh
sudo install -m 600 -o jay -g fleet /dev/null /mnt/fleet-extra/apps/botfleet-server/config/harness-infisical-token && sudo -u jay bash -c 'IFS= read -rs t && printf %s "$t" > '/mnt/fleet-extra/apps/botfleet-server'/config/harness-infisical-token'
```

The token is read from the terminal without echo and written straight into the file, so it never reaches argv or the shell history.

### The Two Owner Credentials

The gate has two doors, and which one you use depends on the device you connect from.

| Credential | Header | For |
|---|---|---|
| Tailscale login | `Tailscale-User-Login` | A user-owned device, such as a phone.  `tailscale serve` adds the header, and the gate compares it with `BOTFLEET_OWNER_LOGINS`. |
| Desktop gate token | `x-botfleet-gate-token` | A tagged device, such as a `tag:prod` Mac.  `tailscale serve` adds no identity header for a tagged device, so the desktop app presents the shared token instead. |

Either one opens the gate.  Both still have to pass the Origin and `sec-fetch-site` checks, and both still have to come in over the loopback connection from `tailscale serve`.

### Rotating The Token

1. Change `BOTFLEET_SERVER_GATE_TOKEN` in Infisical (BotFleet, prod, `/botfleet-server`).
2. Restart the gate: `sudo systemctl restart botfleet-owner-gate`.  The configuration is read once at start, so this is the step that makes the new value live.
3. Reload it on the Mac: **BotFleet menu > Server > Reload From Infisical**, and let the app restart into the new token.

Rotating the token does not touch `BOTFLEET_OWNER_LOGINS`, so a phone signed in as the owner keeps working while the desktop app is updated.

### The Tailscale ACL

The Mac has to be allowed to reach the server's HTTPS port (`8799`) in the tailnet ACL.  A tagged device is a device in the tailnet like any other, and it still has to be granted access: without an ACL rule that allows the `tag:prod` Mac to reach the server on port `8799`, the connection is dropped before it ever reaches `tailscale serve` and the gate never sees it.

## Still Outside Infisical

- `config/server.env`: the harness launch parameters (`OMB_*`).  These still live on the host and are tracked as a follow-up to move them into Infisical.
- The engine CLIs' own login files under the service user's home.  Those belong to the CLIs, not to BotFleet.

## Install, Update, Uninstall

```sh
# Preview every action first.
sudo deploy/linux-server/install.sh --dry-run

# Install.  The Infisical read token has to exist first; the installer says
# exactly how to create it when it does not.
sudo deploy/linux-server/install.sh

# Update to origin/main and restart both units.
sudo deploy/linux-server/update.sh

# Remove the units and the tailnet URL.  The data and the checkout are kept.
sudo deploy/linux-server/uninstall.sh
```

Every value is overridable from the environment: `BF_USER`, `BF_GROUP`, `BF_ROOT`, `BF_CODE`, `BF_REPO`, `BF_REF`, `NODE_VERSION`, `TS_HTTPS_PORT`.  The owner gate's own port is fixed at `8798` in code, because the gate is a loopback listener in front of a loopback harness and there is nothing about it to configure.  The installer refuses any root that is not under `/mnt/fleet-extra`, verifies the Node tarball against the published `SHASUMS256.txt`, refuses a dirty checkout, and installs Node 24.18.0 into `BF_ROOT/node`.

An install from before the move to Infisical still has `config/gate.env` and `config/desktop-token` on disk.  The gate does not read them any more.  Once `BOTFLEET_SERVER_GATE_TOKEN`, `BOTFLEET_OWNER_LOGINS` and `BOTFLEET_PUBLIC_ORIGIN` are in Infisical, delete both files by hand; the installer prints that note and never deletes them for you.

## Signing Engines In On The Server

Each engine CLI is signed in on the server itself, as the service user, with the server home.  Do not copy login files from the Mac.

```sh
sudo -u jay env HOME=/mnt/fleet-extra/apps/botfleet-server/home claude login
sudo -u jay env HOME=/mnt/fleet-extra/apps/botfleet-server/home codex login --device-auth
sudo -u jay env HOME=/mnt/fleet-extra/apps/botfleet-server/home <other-cli> login
```

The logins land under `BF_ROOT/home`, so they survive a restart and are visible to the harness, which runs with the same `HOME`.

## Connecting The Desktop App

The Mac app reads its server target from Infisical, from the **BotFleet** project, environment **`prod`**, path **`/botfleet-server`**:

| Infisical name | What the app does with it |
|---|---|
| `BOTFLEET_SERVER_MODE` | `local` or `remote`: which server this launch talks to. |
| `BOTFLEET_SERVER_URL` | The server, when the mode is `remote`: the tailnet URL of the gate, `https://<host>.<tailnet>.ts.net:8799`. |
| `BOTFLEET_SERVER_GATE_TOKEN` | The `x-botfleet-gate-token` the app presents to the gate: the same value the gate hashes. |

Set `BOTFLEET_SERVER_MODE` to `remote`, fill in the other two, then pick **BotFleet menu > Server > Reload From Infisical**.  The app reads the vault again and offers to restart into the new server.

There is no local copy and no environment variable to set: Infisical is the only source, so a value that is not in the vault is not a value the app has.

### The One Local Item: the Keychain token

Reading the vault needs a key, so the Mac keeps exactly one local item: a **read-only Infisical service token** (`st.…`), scoped to the BotFleet project, the `prod` environment and the `/botfleet-server` path.  It lives in the login Keychain as a generic password.  Add it with:

```sh
security add-generic-password -U -s "BotFleet Infisical read token" -a botfleet -w
```

The command prompts for the value, so the token never reaches argv or the shell history.  Without that item the app has no Infisical bootstrap at all: it runs against the server on this Mac, and the Server menu says "No Infisical Token In The Keychain".

The old `server-target.json` in the app's user-data directory is no longer read.  When it is still there the app says so once at launch and keeps going; delete it.

The app reaches the gate, the gate checks the credential the app presented, and the request continues to the harness on loopback.  The token is never written to a log and never leaves this Mac.

## Health Checks

```sh
curl -fsS http://127.0.0.1:8799/api/health
curl -fsS -H "Tailscale-User-Login: you@example.com" http://127.0.0.1:8798/__gate/health
# $BOTFLEET_SERVER_GATE_TOKEN holds the value from Infisical.
curl -fsS -H "x-botfleet-gate-token: $BOTFLEET_SERVER_GATE_TOKEN" http://127.0.0.1:8798/__gate/health
systemctl status botfleet-server botfleet-owner-gate
tail -f /mnt/fleet-extra/apps/botfleet-server/logs/server.log
journalctl -u botfleet-owner-gate.service -f
journalctl -u botfleet-server.service -n 100
```

The harness health route is loopback only.  The gate health route answers without touching the harness, but it still requires an owner credential.

New gate logs and startup preflight errors use the service journal; historical `owner-gate.log` files are kept.  Journald is host-managed and may consume root-disk space; no per-app journal quota or disk budget is established by this scaffold.

## Limits

- No Mac desktop control, no USB phone bridge, no Electron voice helpers and no Personal Voice on the server.  Those stay on the Mac.
- This targets the current Node harness; the Node harness decommission plan is BF-2515, so follow that plan when it lands.
- One owner per server.  Multi-user accounts are out of scope for now.
- The engines run as the service user on the host, so a bot can reach anything that user can reach.
- The gate is the only supported front door.  Pointing anything else at `127.0.0.1:8799` from off-host would turn every caller into the owner.
