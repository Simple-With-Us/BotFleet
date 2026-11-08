# TV-Face One-File Conversion

Target:  256×256 animated WebP with an embedded manifest.  Keep the shipped glossy TV head and cyan neon visor glyphs (red glyphs on green).  The head stays still on a transparent background.  Do not redesign.

## Status

The one-file player is wired.  `TVFaceAvatar` loads a pack from `public/tv-face/packs/` through `AnimatedFileAvatar` when `tvFaceOneFilePackUrl(color, state)` returns a URL.  Colors without a pack still use the multi-GIF skin tree.

## Packs On Main

| File | Role |
|---|---|
| `tvface-default.webp` | Orange / default: `*` hold, `working` enter/hold/return, `speaking` hold |
| `tvface-thinking.webp` | Orange thinking-focused three-part states |
| `tvface-blue.webp` … `tvface-black.webp` | Color shells of the default frame layout (same ranges) |

Orange and `default` share `tvface-default.webp`.  Thinking/working-class bot states on orange prefer `tvface-thinking.webp`.  Other colors use their color pack (wildcard covers unnamed states).

## Demos Already On Main

`tests/fixtures/avatar/`:

- `tvface-working-demo.webp`
- `tvface-three-part-demo.webp`
- `tvface-speaking-demo.webp`

## Building Color Packs From The Default Pack

1. Extract frames:  `magick public/tv-face/packs/tvface-default.webp -coalesce -scene 0 frames/f%03d.png`
2. Recolor shell pixels (same masks as `scripts/tv-face-build-color-skins.py`).
3. Encode with `img2webp -loop 0 -d 83 -lossless … -o raw.webp`
4. Embed the AVAT manifest (same frame ranges as default; `name` = `tvface-<color>`).

Multi-GIF color skins under `public/tv-face/skins/{color}/` remain for desktop bundles and as a fallback when a one-file pack is not registered in `SHIPPED_ONE_FILE_PACKS`.
