# TV-Face One-File Conversion

Target: 256×256 animated WebP with embedded manifest.  Preserve the shipped glossy orange TV-head and cyan neon visor glyphs; head stays still; transparent background.  Do not redesign.

## Already proven demos (main)

`tests/fixtures/avatar/`:

- `tvface-working-demo.webp` — resting loop only (`*` hold 0–35)
- `tvface-three-part-demo.webp` — enter/hold/return for working (152 frames after fold)
- `tvface-speaking-demo.webp` — resting + speaking holds (107 frames)

These were built from `public/tv-face/skins/default` GIFs via `scripts/avatar-build.ts` with source scaled 480→256.

## Packs produced for BF-2626 / PR #1547 (existing art only)

| File | Size | Frames | States |
|---|---|---|---|
| `public/tv-face/packs/tvface-default.webp` | ~611 KB | 107 | `*` rest hold, `speaking` hold |
| `public/tv-face/packs/tvface-thinking.webp` | ~604 KB | 152 (folded from 155) | `*` rest; `thinking`/`working` enter+hold+return |

Recipe (default skin):

```bash
# 1) Extract + scale GIF frames
magick public/tv-face/skins/default/gifs/resting_hold.gif -coalesce -resize 256x256 PNG32:frames/rest/%03d.png
magick public/tv-face/skins/default/gifs/speaking_hold.gif -coalesce -resize 256x256 PNG32:frames/speak/%03d.png
# concatenate into one sequence 000..N, write avatar.json with frame ranges

# 2) Build + embed manifest
node --experimental-strip-types scripts/avatar-build.ts ./frames \
  --manifest ./avatar.json --out ./tvface-default.webp

# Inspect
node --experimental-strip-types scripts/avatar-build.ts --inspect ./tvface-default.webp
```

Notes:

- Manifest `frame.width/height` are the **delivery** size (256).  Build scales source down; never up.
- Identical seam frames fold; build remaps ranges (see three-part demo / tvface-thinking).
- Wildcard `*` means other bot states need no re-cut art.
- UI still pending on this PR: remove `PICKABLE_STATES` expression picker, restore auto-color on TV-Face switch, add `recolorable` flag on upload.

## Full multi-expression pack (later)

Map each of the 13 transition expressions + non-transition holds into named states in one file, or ship several focused packs.  Prefer one default pack with `*`, `speaking`, and the deep-work three-part (thinking/working first.
