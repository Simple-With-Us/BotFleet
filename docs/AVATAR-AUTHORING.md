# Authoring an animated avatar

One file.  That is the whole handoff: you hand BotFleet a single animated
WebP, and the avatar is live.

This document is the formula.  It says how many frames to draw, how long to
hold each one, how to mark which frames are the transition in, the loop, and
the transition out, and what to type to turn a folder of pictures into the
file.

## The idea

An animated avatar has three parts, and the part you are watching changes
depending on what the bot is doing:

- the **enter**, played once when the bot picks the avatar up and starts
  working;
- the **hold**, a loop that plays for as long as the bot keeps working;
- the **return**, played once when the bot settles back down.

The old TV-Face format wrote those three parts into three separate files per
expression, for forty expressions, in ten skins.  That is a hundred files and
about eight hundred megabytes, and it means an artist has to cut the same
transition once per skin.

The new format puts every frame of one avatar into ONE animated file, and
describes the frame ranges in a small manifest that travels INSIDE that file.
So:

- one file per avatar, not a hundred;
- the ranges are yours to choose, and a state you do not care about needs no
  frames at all;
- the same source frames can back ten skins, because the colour is a separate
  concern;
- adding an avatar to the product is an upload, with no server, storage or
  bot-record change behind it.

## The frame budget

There is no fixed number of frames.  These are the ranges that read well, and
why.

| Part | Frames | How long | Notes |
|---|---|---|---|
| enter | 20 to 40 | 0.6 s to 1.2 s | A transition the user watches once.  Longer than a second and the bot has usually finished before the animation does. |
| hold | 30 to 90 | 3 s to 7 s | A slow loop.  A two second loop looks frantic next to text someone is reading. |
| return | 20 to 40 | 0.6 s to 1.2 s | The mirror of the enter. |

The total is usually under 150 frames, and a file that size is well under a
megabyte.

Frame rate is 12 frames a second (`delayMs` 83).  Below 10 the motion looks
stuttery, above 15 the file grows faster than it looks better.  Every frame in
the file shares one delay, so the frame rate is a property of the file, not of
each range.

## The manifest

The manifest is JSON.  It is embedded in the file by the build, so you never
have to ship it separately, but you do write it.

```json
{
  "formatVersion": 1,
  "name": "my-bot",
  "version": "1.0.0",
  "author": "Your Name",
  "frame": { "width": 256, "height": 256, "count": 130, "delayMs": 83 },
  "restingFrame": 0,
  "states": {
    "*": { "hold": { "from": 0, "to": 29 } },
    "working": {
      "enter": { "from": 30, "to": 69 },
      "hold": { "from": 70, "to": 119 },
      "return": { "from": 120, "to": 129 }
    }
  }
}
```

### `frame`

`width` and `height` are the size the avatar is delivered at.  Use **256 x
256**.  Avatars render between 28 and 44 pixels in the interface, so 256 is
generous, and the build scales your source art down to it.  The old packs
shipped 1408 x 1408 art and that is most of why they weighed what they did.

`count` is how many frames the file holds.  `delayMs` is how long each frame
shows, so 83 ms is 12 frames a second.

### `restingFrame`

The frame that is the avatar's neutral pose.  It is what shows when reduced
motion is on, and it is the frame the player falls back to.

### `states`

Each key is a bot state, and each value says how that state looks.

- `hold` is the looping range for the state.  Every state wants one.
- `enter` plays once on the way in, then hands over to the hold.
- `return` plays once on the way out, then hands back to the previous state.

The key `"*"` is the fallback for every state the manifest does not name.
That is the trick that keeps the manifest short: name the states you care
about, put the resting loop under `"*"`, and the other forty-odd bot states
fall into it for free.

Bot state names are in `src/lib/mascot.ts` as `BotState`.  The ones worth
naming are `working`, `thinking`, `listening`, `searching`, `resting`,
`sleeping`, `happy`, `excited`, `sad`, `alerting`, `crash`, `error` and
`speaking`.

### A talking avatar

A bot that is speaking is drawn as speaking.  The app asks for the `speaking`
state while that bot's voice is playing, so an avatar that declares one talks
for exactly as long as it is talking, and every other bot carries on with what it
was doing.

```json
{
  "frame": { "width": 256, "height": 256, "count": 107, "delayMs": 80 },
  "restingFrame": 0,
  "states": {
    "*": { "hold": { "from": 0, "to": 35 } },
    "speaking": { "hold": { "from": 36, "to": 106 } }
  }
}
```

The `speaking` range is a talking loop, so it repeats until the voice stops.  The
wildcard entry is what the avatar shows at every other moment.

An avatar that declares no speaking state is unaffected.  The state the app
asks for falls back to the wildcard entry, and a file that names no wildcard
rests on its resting frame.  So no existing avatar needs re-cutting: only a
file that declares a speaking range changes what it shows while the voice
plays.

`tests/fixtures/avatar/tvface-speaking-demo.webp` is exactly that: thirty six
frames of the resting face and seventy one of the TV-Face talking loop, built
from the shipped art at 256 x 256.  The face in that art has its mouth drawn
into every frame, so the mouth moves because the frames are a different
picture, and not because the player draws a mouth of its own.

That is the limit of what the format carries today: the mouth moves with the
voice, and not with the words.  A file whose mouth has to follow each word
would need a mouth of its own, which the format does not carry yet.

### Ranges are inclusive on both ends

`{ "from": 30, "to": 69 }` is forty frames: 30, 31, and so on up to 69.  The last frame
of a file with `count` 130 is frame **129**, not 130.  Writing `"to": 130` is
the single most common mistake, and the build refuses it rather than quietly
playing nothing.

### Identical frames are stored once

Your manifest counts the frames in your folder.  The manifest inside the built file
counts the frames in the file, and those are not always the same number.

An animated WebP stores a frame that looks exactly like the one before it once,
holding it for twice as long, because two identical pictures are one picture held
for twice as long.  So a hold where you held one pose for twenty frames becomes
nineteen frames in the file, and every frame after the fold moves down by one.

This is ordinary rather than a mistake, and it happens at exactly the places you
would expect: the last frame of one segment and the first frame of the next are
often the same picture, because that is how a transition grows out of a pose.

The build tool reads the real frame structure back out of the file it just wrote
and maps your frame numbers onto it, so the manifest inside the file always points
at frames that are really there.  It tells you when it did this:

```
3 identical frame(s) were stored once with a longer duration, so the file holds
152 frames; the manifest's ranges were mapped onto them
folded source frames: 36, 60, 131
```

Your own manifest keeps your own numbers, so you never have to think about it.
The `.manifest.json` written beside a built file is the one from inside the file,
because that is the one that describes the file.

## Drawing the art

- **Transparent background.**  Every frame, no exceptions.  The avatar is
  composited over whatever the interface happens to be, in light and dark.
- **One size for every frame.**  The player draws one frame at a time, and a
  sequence that changes size jumps.
- **One format for every frame.**  The build reads the frames as one sequence,
  so a folder that mixes PNG with JPEG is refused rather than half read.  PNG is
  what the art pipeline gives you, and it is what the shipped examples were built
  from.
- **The first and last frames of the enter and the return should match the
  resting frame.**  That is what makes the transition look like it grows out
  of the resting pose instead of cutting to it.
- **Keep the subject in the same place in every frame.**  Only the parts that
  move should move.  A head that drifts two pixels per frame reads as a
  different avatar.
- **A GIF needs 255 colours or fewer.**  The WebP does not care, but the
  compatibility GIF does, and a gradient-heavy drawing will band in it.

## Building it

Put your frames in a folder, numbered in the order they play (`01.png`,
`02.png`, ...  or any names, as long as they sort correctly).  Write the
manifest next to them.  Then:

```bash
node --experimental-strip-types scripts/avatar-build.ts ./frames \
  --manifest ./avatar.json \
  --out ./my-bot.webp \
  --gif ./my-bot.gif \
  --proof ./my-bot-proof.png
```

- `--out` is the file BotFleet plays.  It is the animated WebP with the
  manifest embedded in it.
- `--gif` is optional.  A GIF cannot carry a manifest, so it is the
  compatibility copy: it loops as a whole and works anywhere a GIF works.
- `--proof` is optional.  It writes one sheet with every frame on it, so you
  can see the whole animation at once instead of scrubbing a folder.
- `--lossy` is optional.  The default is lossless, which is exactly what you
  drew.  Add `--lossy` when the file has to be smaller: the same frames come
  out roughly a third of the size, and at avatar size nobody can tell.

The build needs `ffmpeg` and `img2webp` on the path.  Both ship with the
fleet's toolchain; `brew install ffmpeg webp` if you are on a fresh machine.

The build refuses rather than guesses.  It tells you when the frame count
disagrees with the manifest, when a range points past the last frame, when
the frames are not all the same size, and when the manifest does not parse.
It also refuses to write a manifest that does not match the file it produced,
which is the one mistake that would otherwise ship quietly.

Art that is bigger than the size the manifest declares is scaled down, which is
how the shipped examples were made: the TV-Face art is 480 x 480 and the files
are 256 x 256.  The build will not scale art up, because that would invent
pixels, and it will not squash a drawing whose proportions do not match
the declared size, because that would change what you drew.  In both cases it
says what it found and what it would have had to do.

## Checking it

```bash
node --experimental-strip-types scripts/avatar-build.ts --inspect ./my-bot.webp
```

That prints the manifest back out of the built file, which is how you confirm
the handoff is a real one-file avatar and not just a looping image.  It also
counts the frames in the file and says whether that count matches the manifest,
because a mismatch is the one problem that stops the animation rather than
looking wrong.

There are two built examples in the repository, and they are the two shapes
an avatar can take.

`tests/fixtures/avatar/tvface-working-demo.webp` is the simple one: 36 frames
at 256 x 256, 195 KB, with the manifest inside the file and a single resting
loop under the wildcard.  A bot that just needs to look alive is this.

`tests/fixtures/avatar/tvface-three-part-demo.webp` is the one with all the
parts: 155 frames of art at 256 x 256, 1.4 MB, built from the shipped TV-Face
transition art.  The manifest it was built from says exactly what the doc above
says, in the author's own frame numbers:

```json
{
  "frame": { "width": 256, "height": 256, "count": 155, "delayMs": 83 },
  "restingFrame": 0,
  "states": {
    "*": { "hold": { "from": 0, "to": 35 } },
    "working": {
      "enter": { "from": 36, "to": 59 },
      "hold": { "from": 60, "to": 130 },
      "return": { "from": 131, "to": 154 }
    }
  }
}
```

Thirty six frames of resting face, twenty four of the transition into the
typing pose, seventy one of the typing loop, and twenty four of the
transition back.

The manifest inside the file is the same thing in the file's frame numbers.
The three seams between the four segments are frames that look exactly alike,
so the file stores each of them once and holds 152 frames instead of 155:

```json
{
  "frame": { "width": 256, "height": 256, "count": 152, "delayMs": 83 },
  "restingFrame": 0,
  "states": {
    "*": { "hold": { "from": 0, "to": 35 } },
    "working": {
      "enter": { "from": 35, "to": 58 },
      "hold": { "from": 58, "to": 128 },
      "return": { "from": 128, "to": 151 }
    }
  }
}
```

Copy the file, point `--inspect` at it, and you can see exactly what a finished
handoff looks like.  The manifest from inside each one sits next to it, with the
same name and a `.manifest.json` ending, so you can read the file's own numbers
without opening it.

## Adding it to a bot

Upload the WebP as the bot's avatar.  The client reads the manifest out of the
file it just uploaded and switches the bot to the animated avatar on its own.
Nothing else to do.

If the manifest is missing or unreadable, the file still works: it plays as
an ordinary looping image, exactly like any animated GIF you upload today.

## What is not animated, and will not be

- **Desktop notifications.**  The operating system draws one frame.
- **Push notifications and Live Activities on iOS.**  The iOS sidecar does not
  read the avatar at all.
- **iOS, for now.**  The iOS app decodes avatars as a single still.  A one
  file animated avatar will show its resting frame there until the iOS
  player is built.

## Why not just an animated GIF?

A GIF is a fine container and the build writes one, but it is a worse one:
it is 256 colours with a one-bit transparency hack, it is roughly four times
the size of the same frames as WebP, and it cannot carry the manifest, so it
can only ever be a whole-file loop.  The WebP is the real format; the GIF is
the compatibility copy.
