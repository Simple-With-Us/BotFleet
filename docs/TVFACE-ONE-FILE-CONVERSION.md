# TV-Face One-File Conversion Plan

Target: 256x256 animated WebP with embedded manifest.

Existing demos in tests/fixtures/avatar/:
- tvface-working-demo.webp (resting loop)
- tvface-three-part-demo.webp (enter/hold/return)
- tvface-speaking-demo.webp

Full pack requires converting source frames from public/tv-face/skins/ via scripts/avatar-build.ts.

UI changes needed:
- Remove PICKABLE_STATES expression picker
- Restore auto-color on TV-Face switch
- Add recolorable flag on upload
