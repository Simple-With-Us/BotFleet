# SVG craft notes (bloub inspiration)

## Source of craft

[bloub](https://bloub.vercel.app) by jeremy-prt recreates the x.ai bot avatar as pure SVG.  MIT license.  Not affiliated with x.ai.  We study the *animation craft*, not the blob silhouette.  Source: https://github.com/jeremy-prt/bloub

## Techniques we adopted for TV-Face v4

1. **`sample(t)` purity.**  Pose math is a pure function of absolute time plus the state machine.  Same `t` always yields the same pose fields.
2. **Per-state morph duration.**  Bloub uses `SHAPE_MORPH ≈ 0.45s` and per-state `morph` (0.3–0.6).  TV-Face declares `morph` on each hold state and eases with `easeOutQuint`.
3. **Ease-out, never overshoot.**  Primary body morph is `easeOutQuint`.  Secondary look catch-up uses `easeOutCubic` on a `LOOK_MORPH = 0.24s` window.
4. **Freeze mid-fade (`departFige`).**  Chaining a new state before the prior morph ends freezes the composite frame and blends from that freeze.  No pose jump.
5. **Rest = gaze + blink.**  Deterministic blink schedule (seeded rng) and seamless `loopNoise` gaze.  No big floating bob at rest.  Tiny breath only.
6. **`blinkIn` on entry.**  Selected states (thinking, waiting, celebrate) force a short lid pulse when entered — same idea as bloub `blinkIn: true`.
7. **Declared hold table.**  Hold motion is `pose(localT)` sampled every frame, not only CSS infinite keyframes.
8. **TV-Face silhouette stays.**  Shell + glass + neon glyphs.  We are not recreating the black metaball.

## What we deliberately skip

- Path-morphing a single black body through 14 silhouettes (that is bloub's product).
- Dot / arc / notify ornaments unique to the x.ai blob.
- Vue runtime and i18n chrome.

## How to try it

- Demo: https://fleetlink.online/TV-Face/code/tv-face/demo.html
- Runtime: https://fleetlink.online/TV-Face/code/tv-face/tv-face.js
- Hub: https://fleetlink.online/TV-Face/AVATARS.html

## Verify craft quickly

1. Open the demo and leave resting — gaze drifts and blinks without hard bob.
2. Hit **Chain mid-fade** — thinking starts, then working cuts in early; motion should continue from the frozen composite, not snap.
3. Enter sleeping — lids lock low; breath is slow.
4. Toggle talk — mouth open is a data channel, independent of bold karaoke text in the product UI.

## Sentence gap note for fleet prose

Fleet human-readable prose uses two ASCII spaces after sentence terminators.  On HTML pages that claim the rule, set `white-space: pre-wrap` on prose so the gap is *visible* (browsers otherwise collapse runs of spaces).
