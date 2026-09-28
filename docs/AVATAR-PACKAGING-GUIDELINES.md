# BotFleet Avatar Creation & Packaging Guidelines

This document provides the definitive framework, rules, and filesystem structure for creating animated bot avatars (like TV-Face) for BotFleet. It is designed to be handed to an AI (like Grok, Claude, or ChatGPT) or a human designer to build a completely new avatar pack or expand an existing one.

## 1. The State Machine (How it works)

BotFleet avatars are not just static images; they are reactive, state-driven animated characters. 
The avatar player uses a 3-part animation lifecycle to transition smoothly between actions:

1. **Enter** (`[action]_enter.gif`): A smooth transition *from* the idle/resting state *into* the action.
2. **Hold** (`[action]_hold.gif`): A looping animation that plays continuously while the action is happening.
3. **Return** (`[action]_return.gif`): A smooth transition *from* the action *back* to the resting state.
4. **Still** (`[action].png`): A transparent PNG fallback for static renders.

*Flow:* `Resting` → (Trigger: Bot starts thinking) → `thinking_enter.gif` → `thinking_hold.gif` (loops) → (Trigger: Bot finishes) → `thinking_return.gif` → `Resting`.

## 2. Common Bot Actions (The Vocabulary)

To be fully compatible with BotFleet, an avatar pack should cover as many of these core 39 states as possible. If a specific state isn't provided, BotFleet gracefully falls back to the `resting` face.

### Lifecycle & Core States
- `resting` (Default idle state)
- `sleeping` / `waking`
- `listening` (Waiting for user input)
- `thinking` (Processing / reasoning)
- `searching` (Looking up data / web browsing)
- `working` (General task execution)

### Product Cycle & I/O
- `loading`
- `typing` (Writing code or text)
- `speaking` (TTS / Dictating)
- `sending` / `receiving` / `uploading`
- `notifying` / `alerting`
- `powering_down`

### Tools & Integration
- `fleet` (Multi-agent coordination / orbit)
- `crash` (Error state / recovery)
- `memory` (Accessing storage/memory)
- `tools` (Using an MCP tool)
- `routine` (Running a background job/progress)
- `screen` (Focusing on UI/Desktop)
- `git` (Committing code)
- `webhook` (Sending data)
- `computer` (Using a computer terminal)

### Reactions & Emotions
- Positive: `happy`, `excited`, `celebrate`, `proud`, `playful`, `laughing`
- Neutral: `curious`, `surprised`, `shy`, `bored`, `drowsy`
- Negative: `confused`, `sad`, `angry`, `scared`, `suspicious`

## 3. Filesystem Structure (The `.botface` / `.zip` format)

For future compatibility (allowing users to upload `.zip` or custom `.botface` files), the pack must follow this exact directory structure:

```text
AvatarName/
├── manifest.json
├── stills/
│   ├── resting.png
│   ├── thinking.png
│   └── ... (All transparent PNGs)
├── speech/
│   ├── amp_0.png (Mouth closed / quiet)
│   ├── amp_1.png (Mouth slightly open / medium volume)
│   └── amp_2.png (Mouth wide open / loud volume)
└── gifs/
    ├── idle_loop.gif (Optional ambient idle)
    ├── thinking_enter.gif
    ├── thinking_hold.gif
    ├── thinking_return.gif
    └── ... (All transparent GIFs)
```

### The `manifest.json`
Every pack must include a `manifest.json` that maps BotFleet's internal states to the filenames in your `gifs/` and `stills/` folders.

```json
{
  "packName": "TV-Face",
  "version": "1.0.0",
  "author": "BotFleet",
  "defaultSkin": "orange",
  "skins": ["orange", "blue", "green", "purple", "pink", "red", "yellow"],
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

1. **Artistic Freedom & Subject**: Avatars can be *anything* (a bird, an orb, a 3D robot, a photorealistic face, pixel art). There is absolutely no strict "face template" or layout requirement, as long as the design fits inside the square canvas.
2. **Transparency**: All GIFs and PNGs MUST have fully transparent backgrounds (`rgba(0,0,0,0)`). They will be composited over various UI themes (Light/Dark mode, gradients).
3. **Dimensions**: Standardize at `480x480` square format (or a similar 1:1 aspect ratio). Center your character and do not crop too tightly; leave padding for the avatar to bounce/breathe if needed.
4. **Animation Timing & Length Specs**:
   Because these avatars react to real-time events, timing is critical.
   - **Enter / Return Transitions**: 
     - *Must be:* Under 1.5 seconds.
     - *Recommended:* 0.5 to 0.8 seconds (6 to 10 frames at 12fps). 
     - *Why:* BotFleet state changes happen quickly. If an "enter" transition is too long, the bot might finish its task before the animation finishes playing. Keep it snappy and responsive.
   - **Hold Loops**:
     - *Must be:* Seamlessly looping.
     - *Recommended:* 2 to 4 seconds per cycle.
     - *Why:* A hold animation plays continuously while a bot works. If the loop is too short (e.g., 0.5 seconds), the avatar will look jittery and frantic. If it is too long, the file size will become bloated.
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

## 6. Dynamic Lip-Sync (Audio Amplitude Extension)

BotFleet uses a lightweight, client-side volume mapping (Amplitude) approach for lip-syncing TTS engines (like MiniMax T2A) that do not output native visemes. 

The React engine reads the real-time audio volume (0-255 frequency data) via the Web Audio API and maps it to specific animation frames or PNGs dynamically. 

To support real-time speaking, an avatar designer must provide a **3-frame amplitude sequence** in a `speech/` folder:

1. **`amp_0.png` (Volume 0-10%):** The avatar's mouth is completely closed (silent / pauses).
2. **`amp_1.png` (Volume 11-50%):** The avatar's mouth is slightly open (quiet speaking / consonants).
3. **`amp_2.png` (Volume 51-100%):** The avatar's mouth is wide open (loud speaking / strong vowels).

*Alternative for complex animated bodies:* If static PNGs look unnatural on a heavily breathing/moving character, designers can instead provide three looping GIFs (`speaking_amp_0_hold.gif`, `speaking_amp_1_hold.gif`, `speaking_amp_2_hold.gif`). The engine will crossfade or hot-swap between these loops as the volume changes.
