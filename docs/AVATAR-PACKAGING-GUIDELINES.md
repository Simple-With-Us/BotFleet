# BotFleet Avatar Creation & Packaging Guidelines

This document provides the definitive framework, rules, and filesystem structure for creating animated bot avatars (like TV-Face) for BotFleet. It is designed to be handed to an AI (like Grok, Claude, or ChatGPT) or a human designer to build a completely new avatar pack or expand an existing one.

## 1. The State Machine (How it works)

BotFleet avatars are not just static images; they are reactive, state-driven animated characters. 
The avatar player uses a 3-part animation lifecycle to transition smoothly between actions - but only for the 13 transition expressions listed in section 2. The other 27 expressions render as transparent stills with no transition GIFs.

1. **Enter** (`[action]_enter.gif`): A smooth transition *from* the idle/resting state *into* the action.
2. **Hold** (`[action]_hold.gif`): A looping animation that plays continuously while the action is happening.
3. **Return** (`[action]_return.gif`): A smooth transition *from* the action *back* to the resting state.
4. **Still** (`[action].png`): A transparent PNG fallback for static renders.

*Flow:* `Resting` → (Trigger: Bot starts thinking) → `thinking_enter.gif` → `thinking_hold.gif` (loops) → (Trigger: Bot finishes) → `thinking_return.gif` → `Resting`.

## 2. Core Actions & Expressions (The 40-Expression Contract)

The runtime source of truth is `src/components/tv-face/manifest.ts`: `TVFACE_MANIFEST` maps 50 bot states onto **40 unique expressions**, and `TVFACE_HAS_ENTER_RETURN` names the **13 expressions that ship transition GIFs**. This doc reflects that manifest; verify against it before generating assets.

### The 13 transition expressions (enter + hold + return GIFs, plus a still)
`listening`, `thinking`, `typing`, `speaking`, `computer`, `fleet`, `crash`, `memory`, `tools`, `routine`, `screen`, `git`, `webhook`

Each of these requires `_enter.gif`, `_hold.gif`, and `_return.gif` plus a transparent still: **39 GIFs + 13 stills per skin**.

### The 27 stills-driven expressions (still PNG only)
`resting`, `sleeping`, `waking`, `searching`, `working`, `happy`, `excited`, `celebrate`, `confused`, `curious`, `sad`, `alerting`, `angry`, `scared`, `surprised`, `suspicious`, `shy`, `bored`, `drowsy`, `proud`, `playful`, `laughing`, `loading`, `sending`, `receiving`, `notifying`, `powering_down`

The player renders `[expression].png` directly for these - no `_enter`/`_hold`/`_return` GIFs exist, and shipping them changes nothing at runtime. Per skin: **27 stills**.

**Per-skin totals: 39 GIFs (13 expressions x enter/hold/return) + 40 stills (one per expression).**

If a specific state's asset isn't provided, BotFleet gracefully falls back to the `resting` face.

## 3. Filesystem Structure (The `.botface` / `.zip` format)

For future compatibility (allowing users to upload `.zip` or custom `.botface` files), the pack must follow this exact directory structure:

```text
AvatarName/
├── manifest.json
├── stills/
│   ├── resting.png
│   ├── thinking.png
│   └── ... (All transparent PNGs)
└── gifs/
    ├── idle_loop.gif (Optional ambient idle)
    ├── thinking_enter.gif
    ├── thinking_hold.gif
    ├── thinking_return.gif
    └── ... (All transparent GIFs)
```

### The `manifest.json`
Every pack must include a `manifest.json` that maps BotFleet's internal states to the filenames in your `gifs/` and `stills/` folders.  Only list skins whose art actually ships: `SHIPPED_SKINS` (`src/components/tv-face/TVFaceAvatar.tsx`) is currently **orange-only** — blue, green, purple, pink, red, and yellow are planned skins with no assets yet, and any color without shipped art renders the default skin rather than 404ing.  `orange` IS the default skin (`public/tv-face/skins/default`).

```json
{
  "packName": "TV-Face",
  "version": "1.0.0",
  "author": "BotFleet",
  "defaultSkin": "orange",
  "skins": ["orange"],
  "format": "gif",
  "resolution": "480x480",
  "mapping": {
    "idle": "resting",
    "thinking": "thinking",
    "working": "working",
    "typing": "typing"
  }
}
```

## 4. Design Rules & Constraints (For Grok / Designers)

When generating assets for a BotFleet avatar, strictly adhere to these constraints:

1. **Transparency**: All GIFs and PNGs MUST have fully transparent backgrounds (`rgba(0,0,0,0)`). They will be composited over various UI themes (Light/Dark mode, gradients).
2. **Dimensions**: Standardize at `480x480` square format. Do not crop tightly; leave padding for the avatar to move slightly if needed.
3. **Animation Timing & Length Specs**: 
   Because these avatars react to real-time events, timing is critical.
   - **Enter / Return Transitions**: 
     - *Must be:* Under 1.5 seconds.
     - *Recommended:* 0.5 to 0.8 seconds (6 to 10 frames at 12fps). 
     - *Why:* BotFleet state changes happen quickly. If an "enter" transition is too long, the bot might finish its task before the animation finishes playing. Keep it snappy and responsive.
   - **Hold Loops**:
     - *Must be:* Seamlessly looping.
     - *Recommended:* 5 to 8 seconds per cycle.
     - *Why:* Fast 2-second loops look jittery and annoying if you have to watch them for 45 seconds while a build runs. Deep-work holds should be slow and ambient.
   - **Idle / Ambient Loops (Optional)**:
     - *Recommended:* 4 to 8 seconds. 
     - *Why:* The resting face is on screen 90% of the time. Occasional blinks or subtle floating should be spaced out so it doesn't distract the user.
   - **Frame Rate (FPS)**: 
     - *Recommended:* 12 to 15 frames per second. 
     - *Why:* GIFs are heavy. A 30fps animation will cause the pack size to balloon massively. 12fps offers a perfect balance of smooth motion and low file size.
4. **The "Resting" Anchor**: The very first frame of an `_enter` GIF and the very last frame of a `_return` GIF MUST perfectly match the `resting.png` still. This ensures no jarring visual "pops" during transitions.
5. **Holds are Ambient**: A `_hold` GIF loops continuously. Don't make it chaotic. Give it a subtle breathing or pulsing effect so it isn't distracting while the user reads text.

## 5. Tips for Expanding "TV-Face" Specifically

If handing this to an AI to generate *more* TV-Face assets:
- **Style Prompt**: "Flat cartoon orange TV-head robot, transparent background, cyan neon face icons, head completely still."
- **Consistency**: Keep the head box exactly in the same pixel position. Only the inner cyan neon face icons should morph/animate.
- **Skins**: Output everything in grayscale/white for the TV casing if you want to apply CSS-based recoloring later, or provide the exact Hue-shift batch scripts to generate the Blue/Green/Purple skins.
