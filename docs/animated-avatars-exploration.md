# Animated avatars: what exists, what is broken, what it costs

Exploration only, no code changed.  Board `90a39c0d`.

## Headline

Two of the three ways to have an animated bot avatar **already work today**, and
the one that does not work is iOS.  The real obstacle is not capability, it is
asset weight and the fact that nobody can turn the existing animation on by
default without lighting up a known CPU problem.

## What already works

### 1. State-driven animation (TV-Face) ships and is reachable

`avatarCrop: "tvface"` is one of five crops (`shared/bot-avatar.ts:4`) and
`BotAvatar` branches to the animated player on it (`src/components/Avatar.tsx:253-262`).
A user picks it in the avatar card (`src/components/BotProfileAvatarCard.tsx:176-191`,
label `tvface: "TV-Face"`).  No feature flag, no experiment.

The plumbing is end to end: `TVFACE_MANIFEST` maps 50 bot states onto 40
expressions (`src/components/tv-face/manifest.ts:13`), callers already pass live
state (`Avatar.tsx:255-261`), and `planFrame()` runs `enter → hold → return` for
the 13 transition expressions (`manifest.ts:75-78`).  A real bot drives a real
animation now.

The player is deliberately cheap: a keyed `<img>` with `src` swapped by a
`useEffect` (`src/components/tv-face/TVFaceAvatar.tsx:310-396`).  No canvas, no
`requestAnimationFrame`, no CSS keyframes.  The GIF animates natively because a
plain `<img>` has no reason not to.  Missing assets fall back GIF → still →
`resting` still (`TVFaceAvatar.tsx:397-406`).

### 2. An uploaded animated GIF or WebP already animates

Nothing on the server decodes or re-encodes it.  `image/gif` and `image/webp` are
allowlisted (`server/attachments.ts:28-29`), stored byte-for-byte, and the only
transcode branch is `sips` → JPEG for heic/heif/tiff/bmp/avif
(`server/attachments.ts:83`), which GIF and WebP never enter.  They are served
with their true type and `immutable` caching (`server/index.ts:13729-13731`).

The client accepts them too: `.gif` and `.webp` are both in the avatar URL schema
(`shared/bot-avatar.ts:32`), and the upload inputs already list them
(`src/components/BotProfileAvatarCard.tsx:145`).  Every render site is a plain
`<img>`.  No canvas touches any avatar path — the two `canvas` uses in the repo
are the screen recorder and chat-attachment downsizing.

One conflict to know about: uploading an image **forces you off TV-Face**, because
`avatarCropAfterUpload` flips `mascot`/`tvface` to `circle` so the new image
actually displays (`shared/bot-avatar.ts:18-20`).  Custom and animated are
mutually exclusive per bot today.

## What does not work

### iOS shows the first frame only

Every display path decodes through one helper, `UIImage(data:)`
(`ios/App/BotAvatarView.swift:80`), which keeps frame 1, and renders with
`Image(uiImage:)`, which never advances frames even for a multi-frame image.
`UIImage(animatedImage:)` appears zero times in `ios/`.

There is already a 30fps animation engine on iOS, but it is a different thing:
`BotMascot` is a `TimelineView` + `Canvas` vector mascot
(`ios/Sources/CompanionCore/BotMascot.swift:227-229`), opt-in via `animated: true`
at only two call sites, and it is dropped entirely whenever a custom avatar
image loads (`BotAvatarView.swift:44-51`).  Its own header records that it is a
partial port of the desktop engine and deliberately omits the desktop's
expressions, blinking and gaze (`BotMascot.swift:14-18`).

Minimal fix: decode with `UIImage(animatedImage:)` into the existing avatar
`NSCache`, and render through a small `UIViewRepresentable` over
`UIImageView.animatedImage`.  No server change, no model change.

### Notifications cannot animate, on either platform

Desktop passes the avatar as the OS notification icon (`src/lib/notify.ts:29`),
which renders a single frame.  The iOS sidecar does not read it at all — the
comment at `companion/src/apns.ts:526` says `server/notify.ts` already sends
`avatarUrl`, which nothing here reads.  Animated avatars are an in-app surface
only.  Accept this rather than chase it.

## What it costs

The avatar art on disk is the real problem, and the packaging doc does not
mention it.

| Skin | Files | Real size | Storage |
|---|---|---|---|
| `default` | 54 GIF + 46 still | 94 MB | raw git blobs, no LFS filter |
| 9 colour skins | 891 files | 730 MB | Git LFS, not pulled locally |

824 MB for ten skins, of which the one that is *not* in LFS is the one you
actually have checked out.  Largest single hold GIF is ~2.9-3.3 MB.  The stills
are 1408×1408 RGBA even though the spec mandates 480×480
(`docs/AVATAR-PACKAGING-GUIDELINES.md:80`), which is most of why the GIFs are
megabytes.  `git-lfs` is 3.8.0 on the box and the objects are referenced, so a
pull materialises them; the sizes above come from pointer metadata.

Perf is the other cost, and it is already a known scar.  `Sidebar.tsx:1869-1875`
records that idle avatar animation "was most of the app's visible-idle CPU",
which is why sidebar rows pass `animated={isWorking}` rather than always
(`Sidebar.tsx:393,413`).  A GIF cannot be paused by CSS, so N animating avatars
in a long list is N compositor decodes with no off switch.  `BotMascot` is
`memo`'d but `BotAvatar` is not (`src/components/Avatar.tsx:231`).

## Gaps worth closing regardless of direction

- **No `prefers-reduced-motion` on TV-Face.** The SVG mascot honours it
  (`CursorAvatar.tsx:1317`); `TVFaceAvatar` does not, and its only opt-in is the
  `animated` prop.  Accessibility gap in shipped UI.
- **Visual tests cannot freeze a GIF.** `playwright.config.ts:17-24` sets
  `animations: 'disabled'`, which stops CSS and WAAPI but not a GIF decoding in
  an `<img>`.  At risk: `bot-off.visual.spec.ts:52-68`,
  `routine-hold.visual.spec.ts:61`, `kanban-command-center.visual.spec.ts:89-148`.
  Asserting `src` patterns instead of pixels is the existing robust pattern
  (`tv-face-avatar.visual.spec.ts:43-66`).
- **Three state maps have drifted.** `tv-face/docs/BOTFLEET-CURSOR-STATE-MAP.md`
  and `tv-face/framework/manifest.json` collapse many states to one; live
  `src/components/tv-face/manifest.ts` is near-identity and diverges on morphs.
  `manifest.ts` is authoritative.  iOS `BotState` also lacks the 11 Grok-action
  states the manifest covers.
- **The load migration is destructive.** `server/store.ts:1071-1073` deletes any
  `avatarUrl` that fails `botAvatarUrlSchema`, permanently.  Harmless today
  because `.gif`/`.webp` are already in the regex — but it means adding a new
  avatar format silently drops every previously stored avatar of that type on
  next load.  Relevant if animated WebP or APNG is ever proposed.

## Options, ranked

**A — Make the existing animation the default (cheapest, highest value).**
Flip new bots to `tvface`, or add a one-time prompt.  Add the
`prefers-reduced-motion` gate and `memo` `BotAvatar` at the same time, because
turning animation on by default without them is what makes a list of 40 bots
expensive.  No new machinery, no new assets, no server change.

**B — Fix the asset weight before adding any more packs.**  Re-encode the GIFs
(animated WebP or `gifsicle` at the spec'd 480×480 / 12fps), rescale the
1408×1408 stills, and move the `default` skin under the same LFS rules as the
other nine.  Expect a large reduction from 824 MB.  This unblocks every other
option and is worth doing regardless.

**C — Extend animation to iOS.**  Real work, bounded, no server or model change.
Gated on the same reduced-motion and cost reasoning as A, since the roster cost
is already documented in `BotMascot.swift:211-215`.

**D — Let a bot have both a custom image and animation.**  Small change to
`avatarCropAfterUpload`.  Only worth it if uploaded GIF avatars are wanted at
all, since that path already works without it.

## Recommendation

A then B.  The capability question is already answered by the code — an
animated avatar works today in the desktop app, from either the shipped
TV-Face packs or a plain uploaded GIF.  The two things standing between that
and "BotFleet has animated avatars" as a default are accessibility and a
third of a gigabyte of GIFs, and neither needs a new renderer.