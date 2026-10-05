# BotFleet computer VM CLI manifest

`manifest.json` is the single source of truth for CLIs on BotFleet's **cloud agent VM** (Cursor `environment.json` install) and **local VM / VPS** desktop image (Dockerfile layer in `server/container-computer.ts`).  Box cloud desktops consume the same cloud-target install via `server/remote-computer.ts` bootstrap.

## Surfaces

| Surface | Environment key | Install path |
|---|---|---|
| Cursor cloud agent | `cloud` | `scripts/computer-vm-cli/run-install.sh cloud` (from `scripts/cursor-cloud-install.sh`) |
| Local VM + BYO VPS image | `local-vm` | `managedImageDockerfile()` layer `BOTFLEET_VM_CLI_INSTALL` |
| Box cloud computer | `cloud` | `remoteComputerBootstrapCommand()` idempotent fragment |

## Verify inside a VM

```bash
botfleet-vm-cli-verify          # local VM / VPS image (on PATH)
/opt/ogb/botfleet-vm-cli-verify # Box after bootstrap
node scripts/computer-vm-cli/verify.mjs cloud   # cloud agent checkout
```

## Rebuild the Local VM image on a Mac

1. Pull the pinned base: `docker pull trycua/xfce-cua@sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b`
2. In BotFleet: **App Settings → Local VM → Prepare** (or let a bot create flow build it).
3. Or manually from a temp dir: write `managedImageDockerfile()` to `Dockerfile` (Node one-liner or copy from a running harness prepare step) and run:

   `docker build -t localhost/botfleet/cua-local-vm:driver-0.20.0-v6 .`

4. Recreate any existing Local VM container so labels match layer `v6`.

Credentials are never baked into the image; enable **Share CLI credentials** on the Local VM to mount host config read-only.
