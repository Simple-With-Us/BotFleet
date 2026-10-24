# BotFleet On A Linux Server

This directory deploys the BotFleet harness headless on a Linux host (the Hetzner box) as the `jay` user.  Every file the harness writes lives under one root on the `/mnt/fleet-extra` volume.  The only way in is a Tailscale serve URL that carries an owner credential.

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
├── config/    server.env and gate.env
├── workdir/   the systemd working directory
└── node/      the private Node install (v24)

/mnt/fleet-extra/Code/BotFleet-server/     BF_CODE, the detached checkout
```

## The Security Model

The harness binds loopback and treats every loopback caller as the owner.  That is why nothing may forward an unauthenticated remote caller to it, and why the gate exists.

- The gate accepts a request only when the caller is on loopback, the request carries an owner credential, the browser `Origin` (when present) equals the single allowed public origin, and `sec-fetch-site` is not `cross-site`.
- The gate rewrites `Host` to `127.0.0.1:8799` and strips the identity, forwarding, `sec-fetch-*` and Cloudflare edge headers, so the harness sees a plain loopback caller and nothing else.
- `tailscale serve` is tailnet only.  Never enable Funnel: Funnel is public and adds no identity header, which would leave the gate with no owner check at all.
- No port is exposed to the public internet, and nothing listens on a routable address.
- The systemd sandbox (`ProtectSystem=strict`, `ProtectHome=read-only`, `ReadWritePaths=/mnt/fleet-extra`) makes every path read-only except the fleet volume, so a write outside `/mnt/fleet-extra` fails.
- Any local process on the host can still reach `127.0.0.1:8799` directly, the same as on the Mac today.  Only trusted users should have shell access on the host, and every bot shell runs as the service user.

## The Two Owner Credentials

The gate has two doors, and which one you use depends on the device you connect from.

| Credential | Header | For |
|---|---|---|
| Tailscale login | `Tailscale-User-Login` | A user-owned device, such as a phone. `tailscale serve` adds the header, and the gate compares it with the allowlist in `OWNER_LOGINS`. |
| Desktop gate token | `x-botfleet-gate-token` | A tagged device, such as a `tag:prod` Mac. `tailscale serve` adds no identity header for a tagged device, so the desktop app presents a shared token instead. |

Either one opens the gate.  Both still have to pass the Origin and `sec-fetch-site` checks, and both still have to come in over the loopback connection from `tailscale serve`.

### Where The Token Lives

- The token itself: `BF_ROOT/config/desktop-token` (`/mnt/fleet-extra/apps/botfleet-server/config/desktop-token`), mode `0600`, owned by the service user.
- The gate only ever stores the sha256 of the token: `BOTFLEET_GATE_TOKEN_SHA256` in `BF_ROOT/config/gate.env`.  A leaked `gate.env` cannot be replayed as a credential.

The installer generates the token the first time it runs and keeps it afterwards, so re-running the installer never locks the desktop app out.

Read the token with:

```sh
sudo cat /mnt/fleet-extra/apps/botfleet-server/config/desktop-token
```

The token is never printed by the installer and never appears in a log line.

### Rotating The Token

1. Delete the token file: `sudo rm /mnt/fleet-extra/apps/botfleet-server/config/desktop-token`.
2. Re-run the installer: `sudo deploy/linux-server/install.sh`.  It writes a new token and puts its new hash in `gate.env`.
3. Restart the gate: `sudo systemctl restart botfleet-owner-gate`.
4. Copy the new token into the desktop app's server target file and restart the app.

Rotating the token does not touch `OWNER_LOGINS`, so a phone signed in as the owner keeps working while the desktop app is updated.

### The Tailscale ACL

The Mac has to be allowed to reach the server's HTTPS port (`8799`) in the tailnet ACL.  A tagged device is a device in the tailnet like any other, and it still has to be granted access: without an ACL rule that allows the `tag:prod` Mac to reach the server on port `8799`, the connection is dropped before it ever reaches `tailscale serve` and the gate never sees it.

## Install, Update, Uninstall

```sh
# Preview every action first.
sudo deploy/linux-server/install.sh --dry-run

# Install.  OWNER_LOGINS is optional: the desktop gate token is generated
# either way, and the token alone is enough to open the gate.
sudo OWNER_LOGINS=you@example.com deploy/linux-server/install.sh

# Update to origin/main and restart both units.
sudo deploy/linux-server/update.sh

# Remove the units and the tailnet URL.  The data and the checkout are kept.
sudo deploy/linux-server/uninstall.sh
```

Every value is overridable from the environment: `BF_USER`, `BF_GROUP`, `BF_ROOT`, `BF_CODE`, `BF_REPO`, `BF_REF`, `NODE_VERSION`, `TS_HTTPS_PORT`, `GATE_PORT`, `OWNER_LOGINS`.  The installer refuses any root that is not under `/mnt/fleet-extra`, verifies the Node tarball against the published `SHASUMS256.txt`, refuses a dirty checkout, and installs Node 24.18.0 into `BF_ROOT/node`.

## Signing Engines In On The Server

Each engine CLI is signed in on the server itself, as the service user, with the server home.  Do not copy login files from the Mac.

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
  "token": "<the desktop gate token>"
}
```

The `url` is the tailnet URL, the `token` is what `sudo cat /mnt/fleet-extra/apps/botfleet-server/config/desktop-token` prints, and the `mode` is `remote`.  Then restart BotFleet from the Server menu.

The app reaches the gate, the gate checks the credential the app presented, and the request continues to the harness on loopback.  The token is never written to a log and never leaves this Mac.

## Health Checks

```sh
curl -fsS http://127.0.0.1:8799/api/health
curl -fsS -H "Tailscale-User-Login: you@example.com" http://127.0.0.1:8798/__gate/health
curl -fsS -H "x-botfleet-gate-token: $(sudo cat /mnt/fleet-extra/apps/botfleet-server/config/desktop-token)" http://127.0.0.1:8798/__gate/health
systemctl status botfleet-server botfleet-owner-gate
tail -f /mnt/fleet-extra/apps/botfleet-server/logs/server.log
```

The harness health route is loopback only.  The gate health route answers without touching the harness, but it still requires an owner credential.

## Limits

- No Mac desktop control, no USB phone bridge, no Electron voice helpers and no Personal Voice on the server.  Those stay on the Mac.
- This targets the current Node harness; the Node harness decommission plan is BF-2515, so follow that plan when it lands.
- One owner per server.  Multi-user accounts are out of scope for now.
- The engines run as the service user on the host, so a bot can reach anything that user can reach.
- The gate is the only supported front door.  Pointing anything else at `127.0.0.1:8799` from off-host would turn every caller into the owner.
