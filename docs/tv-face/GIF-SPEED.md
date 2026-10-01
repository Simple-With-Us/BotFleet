# TV-Face GIF Speed (No Third Party Required)

You do **not** need Cloudinary, imgix, or another CDN to make transitions
faster or slower.

## Why GIF Speed Is Offline

A GIF's playback rate is the **per-frame delay** stored in the file.  The
browser's `<img src="face.gif">` always uses those delays.  CSS
`animation-duration` does not apply to GIFs.

BotFleet's player waits `TVFACE_TRANSITION_MS` (1000 ms by default) after
starting an enter or return, then swaps to the hold (or the resting still).
That constant must match the GIF total duration within ±20 ms
(`tvFaceSkins.test.ts`).

## Three Ways to Go Faster / Slower

### 1. Player wait only (runtime, free)

Pass `transitionSpeed` on `TVFaceAvatar` (e.g. `2` → wait 500 ms).  This
shortens the *timeout* before swapping to hold.  The GIF still draws at its
authored frame rate; if the wait is shorter than the GIF, the mid-animation
cut looks snappy (good for urgent cues).  Urgent expressions
(`TVFACE_URGENT`) already skip the wait entirely.

### 2. Re-encode frame delays (true pixel speed)

```bash
# Force enter/return packs to exactly 1000 ms (keeps all frames):
python3 scripts/tv-face-retime-gifs.py --target-ms 1000 \
  public/tv-face/skins/default/gifs/*_enter.gif \
  public/tv-face/skins/default/gifs/*_return.gif

# 2× faster (half the delays), any GIF:
python3 scripts/tv-face-retime-gifs.py --factor 2 path/to/clip.gif
```

After changing enter/return totals, update `TVFACE_TRANSITION_MS` to match.

### 3. Full pack retime + transparency (canonical pipeline)

```bash
python3 scripts/tv-face-gifs.py public/tv-face/skins/default/gifs
```

Resamples enter/return to 25 × 40 ms = 1000 ms, pins bookends, applies the
transparent border mask.

## Cloudinary?

Cloudinary's `e_accelerate` / delay transforms work on hosted URLs.  BotFleet
ships faces **in the app package** for offline Mac/Electron use, so baking
delays into the pack is the right default.  Use a CDN only if you later host
skins remotely and want on-the-fly variants without rebuilding.

## Contract Checklist

- Enter first frame and return last frame = resting bookend for that color
- Enter/return total ms = `TVFACE_TRANSITION_MS` ± 20
- Transparent border (not an opaque black box)
- Color skins live under `public/tv-face/skins/{color}/`
