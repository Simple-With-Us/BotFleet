# TV-Face Color Skins and Playback

## Packs

| Skin dir | BotColor | Notes |
|----------|----------|-------|
| `public/tv-face/skins/default` | orange | Canonical pack |
| `public/tv-face/skins/blue` … | blue, green, purple, pink, red, cyan, yellow, teal, coral | Recolored from default |

Each pack has `stills/*.png` and `gifs/*_{enter,hold,return}.gif`.  Enter/return sum to **1000 ms** (`TVFACE_TRANSITION_MS`).  Hold GIFs loop forever (`loop=0`).

Bookend contract: first frame of every `*_enter.gif` and last frame of every `*_return.gif` match that color's resting face (after quantize).

Green uses **red** face glyphs so shell green does not collide with green chroma keying.

## Player Logic (`TVFaceAvatar.tsx`)

- Rest → expression: play enter, then hold (hold loops in the browser).
- Expression → rest: play return, then resting still.
- Expression → expression: cut to new hold (enter is resting-anchored; playing it would pop).
- **Urgent** expressions (`alerting`, `crash`, `angry`, `scared`, `notifying` — see `TVFACE_URGENT`): cut straight to hold from anywhere — no 1–4s enter wait.  Any in-flight enter/return is cancelled on state change.
- `transitionSpeed` shortens the *wait* before swapping enter→hold (does not re-encode).  For true faster/slower pixel animation, retime frame delays offline.

## GIF Speed (No Cloudinary Required)

GIF speed is the per-frame delay field.  Re-encode locally:

```bash
python3 scripts/tv-face-retime-gifs.py --target-ms 1000 public/tv-face/skins/default/gifs/*_enter.gif
python3 scripts/tv-face-retime-gifs.py --factor 2 path/to/clip.gif
```

Cloudinary `e_accelerate` works on hosted URLs, but BotFleet stays offline-first with assets in the repo.  No third-party service is required.

## Building Color Packs

```bash
python3 scripts/tv-face-build-color-skins.py public/tv-face/skins/default public/tv-face/skins blue green …
```

Skips truncated junk (`speaking_hold_preview.png`).

## Shipping Color Packs Without a 600 MB Git Push

1. Build packs locally:

   ```bash
   python3 scripts/tv-face-build-color-skins.py \
     public/tv-face/skins/default public/tv-face/skins \
     blue green purple pink red cyan yellow teal coral
   ```

2. Publish approved color packs through the standard BotFleet asset-delivery process (same channel used for other shipped TV-Face art).

3. On a machine that needs them:

   ```bash
   bash scripts/tv-face-fetch-skins.sh
   ```

4. Expand `SHIPPED_SKINS` in `TVFaceAvatar.tsx` to include each folder you fetched.

The player, urgent cuts, and `transitionSpeed` land in code without the binary packs.
