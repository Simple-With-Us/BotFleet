# BotFleet control plane — not used

This directory used to hold a hosted Cloudflare Worker for cloud account
identity, installation ownership, and per-installation managed companion
endpoints (one Cloudflare Tunnel + `c-<hex>.botfleet.com` CNAME per Mac).
It was removed on 2026-09-26.

## Why it was removed

The checked-in `wrangler.jsonc` pointed at Cloudflare resources that did
not belong to Jay:

- `account_id 0c92969a82eb9e173b013a7e7a02333d` and
  `zone_id bae08399bb6f96eb7266c65ac0057eee` were provisioned by an
  earlier agent against `botfleet.com`, a parked domain registered in
  2016 (Nameservers `damao.ns.giantpanda.com`,
  `yangguang.ns.giantpanda.com`; resolves to Linode parking IPs).  Jay
  does not own `botfleet.com`.  Upstream OpenMausBot is on
  `openmausbot.com` (Cloudflare), not `botfleet.com`.
- `route accounts.botfleet.com`, `COMPANION_HOST_SUFFIX=botfleet.com`,
  and `EMAIL_FROM noreply@botfleet.com` were all derived from
  `botfleet.app` by analogy — none of those hostnames work because the
  zone is parked on a different registrar.

Upstream OpenMausBot also does not own these IDs; the `milindsoni201`
Cloudflare account (which owns the `botfleet-composio` Worker + D1) is a
different account.  So the wiring was neither upstream-owned nor
fleet-owned — it was a confused-agent fabrication.  Removing the directory
was the only correct fix.

## Today: how BotFleet actually handles companion

BotFleet ships a local Companion (Electron-renderer web + iPhone
TestFlight app) that pairs over LAN or Tailscale.  There is no hosted
control plane in this build.  Remote-reach from outside the home network
uses one of:

- **Tailscale** between the Mac and the iPhone — simplest, no Cloudflare.
- **Manual `cloudflared tunnel`** on the Mac — the desktop build bundles
  `cloudflared` (`scripts/prepare-cloudflared.mjs`).  Run
  `cloudflared tunnel --url http://127.0.0.1:8787` (or your port) and
  point the iPhone at the `*.trycloudflare.com` URL it prints.
- **Future fleet-owned control plane** — if you want hosted account
  identity, per-installation tunnel provisioning, and a CNAME on your
  own domain, that is a future lane.  Start from the source in git
  history (it is preserved in `git log -- cloudflare/control-plane/`)
  and provision new D1 / tunnel-token resources on your own Cloudflare
  account.  Do not reuse any of the removed IDs.

## Files that referenced this directory

- `pnpm-workspace.yaml` no longer lists `cloudflare/control-plane` as a
  workspace package (removed at the same time).
- `electron/companion-account-service.mjs` still contains the helper
  `resolveCompanionControlPlaneURL(...)` for when a future fleet-owned
  control plane is configured.  Its default is empty and the
  `isFleetControlPlaneURL` check only accepts `*.botfleet.app` and
  loopback, so neither a packaged build nor a dev build will ever send
  user credentials to `accounts.botfleet.com` or any other third-party
  host.
