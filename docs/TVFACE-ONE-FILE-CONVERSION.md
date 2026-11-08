# TV-Face One-File Conversion

Target:  256×256 animated WebP with an embedded manifest.  Keep the shipped glossy orange TV head and cyan neon visor glyphs.  The head stays still on a transparent background.  Do not redesign.

## Status

This conversion is not finished.  Nothing loads the two packs below yet, so the app still draws TV-Face from its existing skins.

## Demos Already On Main

`tests/fixtures/avatar/`:

- `tvface-working-demo.webp`:  resting loop only (`*` hold 0–35)
- `tvface-three-part-demo.webp`:  enter, hold and return for working (152 frames after folding)
- `tvface-speaking-demo.webp`:  resting and speaking holds (107 frames)

These were built from the `public/tv-face/skins/default` GIFs with `scripts/avatar-build.ts`, with the source scaled from 480 to 256.

## Packs From Existing Art

Sizes and states below come from `--inspect` on the committed files.

| File | Size | Frames | States |
|---|---|---|---|
| `public/tv-face/packs/tvface-default.webp` | 2.13 MB | 222 | `*` hold, `working` enter, hold and return, `speaking` hold |
| `public/tv-face/packs/tvface-thinking.webp` | 618 KB | 152 | `*` hold, `thinking` and `working` enter, hold and return |

BF-2627 asks for under 2 MB, so the default pack is slightly over.

Recipe for the default skin:

```bash
# 1) Extract and scale the GIF frames
magick public/tv-face/skins/default/gifs/resting_hold.gif -coalesce -resize 256x256 PNG32:frames/rest/%03d.png
magick public/tv-face/skins/default/gifs/speaking_hold.gif -coalesce -resize 256x256 PNG32:frames/speak/%03d.png
# Concatenate into one sequence 000..N, then write avatar.json with the frame ranges

# 2) Build and embed the manifest
node --experimental-strip-types scripts/avatar-build.ts ./frames \
  --manifest ./avatar.json --out ./tvface-default.webp

# Inspect
node --experimental-strip-types scripts/avatar-build.ts --inspect ./tvface-default.webp
```

Notes:

- The manifest's `frame.width` and `frame.height` are the delivery size, 256.  The build scales the source down and never up.
- Identical seam frames fold, and the build remaps the ranges.  See the three-part demo and `tvface-thinking`.
- The wildcard `*` means other bot states need no re-cut art.

## Full Multi-Expression Pack (Later)

Map each of the 13 transition expressions and the non-transition holds into named states in one file, or ship several focused packs.  Prefer one default pack with `*`, `speaking` and the deep-work three-part states, thinking and working first.
