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

In a running Local VM, run it as the desktop user (`docker exec -u cua <container> botfleet-vm-cli-verify`), not root.  It runs every tool once, and pm2, wrangler and mise write state under `$HOME` on their first run, so a root run leaves root-owned directories in the desktop user's home.  The image build hands that state back to `cua` itself.

After Box bootstrap, the same verifier is also available in the managed desktop environment.

In a checkout, run `node scripts/computer-vm-cli/verify.mjs cloud` or `local-vm`.

## Rebuild the Local VM image

Use **App Settings → Local VM → Prepare**, or let a bot create flow build the image.  Recreate existing Local VM containers after the image layer version changes so labels match.

Credentials are never baked into the image.  Enable **Share Host CLI Credentials** in Host & CLI Integration to mount or sync host login files read-only.

## Adding a tool

Append one entry to the end of `manifest.json` (do not reorder existing ones).  `targets` is `both` for cloud and Local VM, or `local` for the Local VM image only.  Pick the shape that fits:

| Shape | Entry fields | Example |
|---|---|---|
| apt package | `apt: ["pkg"]` | `rg`, `shellcheck` |
| npm global | `recipe: "npm_global"`, `npmPackage`, an exact `version` | `wrangler`, `pm2`, `sentry-cli` |
| Pinned download | `recipe: "pinned_binary"`, `download` with `url` and `sha256` for both `x86_64` and `aarch64` | `cloudflared`, `uv`, `yq` |

An agent CLI such as `claude` or `codex` is a one-line `npm_global` entry.  A pinned download is verified against its sha256 before anything is unpacked, and tools that share one archive (`uv` and `uvx`) install it once.  Always give the entry a `verify` command; the image build fails if it does not pass.

## Check the image locally

```bash
node scripts/computer-vm-cli/render-dockerfile.mjs /tmp/vm-image-context
docker build --progress=plain -t botfleet-vm-test /tmp/vm-image-context
```

The `VM Image Build` workflow does the same on amd64 and arm64 for any change to the image files, and runs `smoke.sh` inside the result as `cua`, once the way a bot execs and once as a zsh login shell.  It is not a required check.
