# BotFleet On A Linux Server

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
├── logs/      server.log and owner-gate.log
├── tmp/       TMPDIR
├── config/    server.env and infisical-read-token
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
- The systemd sandbox (`ProtectSystem=strict`, `ProtectHome=read-only`, `ReadWritePaths=/mnt/fleet-extra`) makes every path read-only except the fleet volume, so a write outside `/mnt/fleet-extra` fails.
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

Reading the vault needs a key, so the host keeps exactly one local file:

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

### The Two Owner Credentials

The gate has two doors, and which one you use depends on the device you connect from.

| Credential | Header | For |
|---|---|---|
| Tailscale login | `Tailscale-User-Login` | A user-owned device, such as a phone.  `tailscale serve` adds the header, and the gate compares it with `BOTFLEET_OWNER_LOGINS`. |
| Desktop gate token | `x-botfleet-gate-token` | A tagged device, such as a `tag:prod` Mac.  `tailscale serve` adds no identity header for a tagged device, so the desktop app presents the shared token instead. |

Either one opens the gate.  Both still have to pass the Origin and `sec-fetch-site` checks, and both still have to come in over the loopback connection from `tailscale serve`.

### Rotating The Token

1. Change `BOTFLEET_SERVER_GATE_TOKEN` in Infisical (BotFleet, prod, `/botfleet-server`).
2. Restart the gate: `sudo systemctl restart botfleet-owner-gate`.  The configuration is read once at start, so this is the step that makes the new value live.
3. Copy the new value into the desktop app's server target file and restart the app.

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

In the app: **BotFleet menu > Server > Set Remote Server…** opens the server target file.  Fill in three fields:

```json
{
  "mode": "remote",
  "url": "https://<host>.<tailnet>.ts.net:8799",
  "token": "<the value of BOTFLEET_SERVER_GATE_TOKEN in Infisical>"
}
```

The `url` is the tailnet URL, the `token` is the value of `BOTFLEET_SERVER_GATE_TOKEN` in Infisical (BotFleet, prod, `/botfleet-server`), and the `mode` is `remote`.  Then restart BotFleet from the Server menu.

The Mac side of this lands in a following commit, which moves the same two settings into Infisical for the desktop app as well: `BOTFLEET_SERVER_MODE` (`local` or `remote`) and `BOTFLEET_SERVER_URL`.  The server target file stays as it is until then.

The app reaches the gate, the gate checks the credential the app presented, and the request continues to the harness on loopback.  The token is never written to a log and never leaves this Mac.

## Health Checks

```sh
curl -fsS http://127.0.0.1:8799/api/health
curl -fsS -H "Tailscale-User-Login: you@example.com" http://127.0.0.1:8798/__gate/health
# $BOTFLEET_SERVER_GATE_TOKEN holds the value from Infisical.
curl -fsS -H "x-botfleet-gate-token: $BOTFLEET_SERVER_GATE_TOKEN" http://127.0.0.1:8798/__gate/health
systemctl status botfleet-server botfleet-owner-gate
tail -f /mnt/fleet-extra/apps/botfleet-server/logs/server.log
```

The harness health route is loopback only.  The gate health route answers without touching the harness, but it still requires an owner credential.

## Limits

- No Mac desktop control, no USB phone bridge, no Electron voice helpers and no Personal Voice on the server.  Those stay on the Mac.
- This targets the current Node harness; the Node harness decommission plan is BF-2515, so follow that plan when it lands.
- One owner per server.  Multi-user accounts are out of scope for now.
- The engines run as the service user on the host, so a bot can reach anything that user can reach.
- The gate is the only supported front door.  Pointing anything else at `127.0.0.1:8799` from off-host would turn every caller into the owner.
