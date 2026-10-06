# BotFleet computer VM CLI manifest

`manifest.json` lists the CLIs BotFleet installs on cloud and container desktops, plus optional host credential paths for sync.

## Surfaces

| Surface | Environment key | How it is applied |
|---|---|---|
| Cursor cloud agent | `cloud` | Cloud agent install hook |
| Local VM and self-hosted VPS | `local-vm` | Managed desktop image layer |
| Box cloud computer | `cloud` | First-boot bootstrap on the remote desktop |

## Verify inside a VM

```bash
botfleet-vm-cli-verify
```

After Box bootstrap, the same verifier is also available in the managed desktop environment.

In a checkout, run `node scripts/computer-vm-cli/verify.mjs cloud` or `local-vm`.

## Rebuild the Local VM image

Use **App Settings → Local VM → Prepare**, or let a bot create flow build the image.  Recreate existing Local VM containers after the image layer version changes so labels match.

Credentials are never baked into the image.  Enable **Share Host CLI Credentials** in Host & CLI Integration to mount or sync host login files read-only.
