// The player that plays a one-file animated avatar.
//
// The player is the part that knows what an avatar does: read the file, find
// the manifest inside it, decode frames, follow the plan, and stop when there
// is nothing left to animate.  It is tested here with a clock and a decoder
// that are both fakes, because the rules worth checking are the ones about
// time and about when to stop, and both are easier to see against a clock
// the test controls.

import { describe, expect, it } from "vitest";

import { embedAvatarManifest, type AvatarManifest } from "../../../shared/avatar-manifest";
import { AvatarFilePlayer, type AvatarFrameDecoder, type AvatarFrameSink } from "./player";

/**
 * A file that carries a manifest.
 *
 * The manifest is embedded in a real extended WebP, so the player reads the
 * manifest the same way it reads one from an upload: through the shared
 * reader, over the file's own bytes.
 */
function webpWithManifest(manifest: AvatarManifest): Buffer {
  // A minimal extended WebP: RIFF/WEBP/VP8X.  The manifest reader only walks
  // the chunks, and the frame decoder is faked in these tests, so the file
  // does not have to hold a real image.
  const vp8x = Buffer.alloc(10);
  const payload = 4 + 8 + vp8x.length + (vp8x.length % 2);
  const file = Buffer.alloc(8 + payload);
  file.write("RIFF", 0, "latin1");
  file.writeUInt32LE(payload, 4);
  file.write("WEBP", 8, "latin1");
  file.write("VP8X", 12, "latin1");
  file.writeUInt32LE(vp8x.length, 16);
  vp8x.copy(file, 20);
  return embedAvatarManifest(file, manifest);
}

const MANIFEST: AvatarManifest = {
  formatVersion: 1,
  name: "test-bot",
  frame: { width: 32, height: 32, count: 8, delayMs: 100 },
  restingFrame: 7,
  states: {
    idle: { hold: { from: 0, to: 1 } },
    working: {
      enter: { from: 2, to: 3 },
      hold: { from: 4, to: 5 },
      return: { from: 6, to: 7 },
    },
  },
};

/** A clock the test moves by hand. */
class FakeClock {
  time = 0;
  private nextId = 1;
  private pending = new Map<number, (time: number) => void>();

  now = (): number => this.time;

  schedule = (tick: (time: number) => void): number => {
    const id = this.nextId++;
    this.pending.set(id, tick);
    return id;
  };

  cancel = (id: number): void => {
    this.pending.delete(id);
  };

  /** Move the clock on and run whatever was waiting for it. */
  advance(ms: number): void {
    this.time += ms;
    const due = [...this.pending.values()];
    this.pending.clear();
    for (const tick of due) tick(this.time);
  }

  /** How many ticks are waiting, which is how a running loop shows itself. */
  get waiting(): number {
    return this.pending.size;
  }
}

/** A decoder that records what it was asked for. */
function fakeDecoder(frameCount: number) {
  const decoded: number[] = [];
  const decoder: AvatarFrameDecoder = {
    frameCount,
    async decode(frameIndex: number) {
      decoded.push(frameIndex);
      return {
        index: frameIndex,
        draw() {},
        close() {},
      };
    },
    close() {},
  };
  return { decoder, decoded };
}

/** The surface the frames are drawn on.  It records what it was given. */
function fakeSink(painted: number[]): AvatarFrameSink {
  return {
    width: () => 44,
    height: () => 44,
    paint: (frame) => {
      painted.push(frame.index);
    },
  };
}

/** Let the queued decodes settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function makePlayer(options: {
  bytes?: Buffer;
  decoder?: AvatarFrameDecoder | null;
  clock: FakeClock;
  painted: number[];
  reducedMotion?: boolean;
  animated?: boolean;
}) {
  const modes: string[] = [];
  const player = new AvatarFilePlayer({
    loadBytes: async () => options.bytes ?? webpWithManifest(MANIFEST),
    createDecoder: async () => (options.decoder === undefined ? null : options.decoder),
    sink: fakeSink(options.painted),
    now: options.clock.now,
    schedule: options.clock.schedule,
    cancel: options.clock.cancel,
    onMode: (mode) => modes.push(mode),
    reducedMotion: options.reducedMotion ?? false,
    animated: options.animated ?? true,
  });
  return { player, modes };
}

describe("AvatarFilePlayer", () => {
  it("plays the plain image for a file with no manifest", async () => {
    const clock = new FakeClock();
    const { decoder } = fakeDecoder(8);
    const painted: number[] = [];
    const { player, modes } = makePlayer({
      // A file that is not an animated avatar at all: bytes with no manifest
      // in them.
      bytes: Buffer.from("RIFF....WEBPVP8 ", "latin1"),
      clock,
      decoder,
      painted,
    });
    await player.load("/api/attachments/a.webp");
    expect(player.currentMode).toBe("plain-image");
    expect(modes).toEqual([]);
    expect(painted).toEqual([]);
  });

  it("plays the plain image when the browser cannot decode single frames", async () => {
    const clock = new FakeClock();
    const painted: number[] = [];
    const { player } = makePlayer({ clock, decoder: null, painted });
    await player.load("/api/attachments/a.webp");
    expect(player.currentMode).toBe("plain-image");
  });

  it("plays the hold of the current state", async () => {
    const clock = new FakeClock();
    const { decoder, decoded } = fakeDecoder(8);
    const painted: number[] = [];
    const { player, modes } = makePlayer({ clock, decoder, painted });
    await player.load("/api/attachments/a.webp");
    player.setState("idle");
    expect(player.currentMode).toBe("animated");
    expect(modes).toEqual(["animated"]);

    clock.advance(0);
    await flush();
    expect(decoded).toEqual([0]);
    expect(painted).toEqual([0]);

    // The hold is two frames long, so it loops.
    clock.advance(100);
    await flush();
    expect(decoded).toEqual([0, 1]);
    clock.advance(100);
    await flush();
    expect(decoded).toEqual([0, 1, 0]);
  });

  it("plays the enter transition once and then the hold of the new state", async () => {
    const clock = new FakeClock();
    const { decoder, decoded } = fakeDecoder(8);
    const painted: number[] = [];
    const { player } = makePlayer({ clock, decoder, painted });
    await player.load("/api/attachments/a.webp");
    player.setState("idle");
    clock.advance(0);
    await flush();

    // The bot starts working: the enter plays once, then the hold loops.
    player.setState("working");
    clock.advance(0);
    await flush();
    expect(decoded.at(-1)).toBe(2);

    clock.advance(100);
    await flush();
    expect(decoded.at(-1)).toBe(3);

    clock.advance(100);
    await flush();
    expect(decoded.at(-1)).toBe(4);

    clock.advance(100);
    await flush();
    expect(decoded.at(-1)).toBe(5);
  });

  it("holds the resting frame when the user asked for less motion", async () => {
    const clock = new FakeClock();
    const { decoder, decoded } = fakeDecoder(8);
    const painted: number[] = [];
    const { player, modes } = makePlayer({ clock, decoder, reducedMotion: true, painted });
    await player.load("/api/attachments/a.webp");
    player.setState("working");
    clock.advance(0);
    await flush();
    expect(player.currentMode).toBe("still-frame");
    expect(modes).toEqual(["still-frame"]);
    // Only the resting frame is drawn, and nothing is scheduled.
    expect(decoded).toEqual([MANIFEST.restingFrame]);
    expect(painted).toEqual([MANIFEST.restingFrame]);
    expect(clock.waiting).toBe(0);
  });

  it("holds the resting frame when the caller does not want an animated avatar", async () => {
    const clock = new FakeClock();
    const { decoder, decoded } = fakeDecoder(8);
    const painted: number[] = [];
    const { player } = makePlayer({ clock, decoder, animated: false, painted });
    await player.load("/api/attachments/a.webp");
    clock.advance(0);
    await flush();
    expect(player.currentMode).toBe("still-frame");
    expect(decoded).toEqual([MANIFEST.restingFrame]);
  });

  it("stops asking for frames once the avatar is off screen", async () => {
    const clock = new FakeClock();
    const { decoder, decoded } = fakeDecoder(8);
    const painted: number[] = [];
    const { player } = makePlayer({ clock, decoder, painted });
    await player.load("/api/attachments/a.webp");
    player.setState("idle");
    clock.advance(0);
    await flush();
    const before = decoded.length;

    // The row scrolled out of the list.  The loop has to stop, not run on
    // with nothing to show: a list of rows that all animate at once is the
    // app's oldest performance scar.
    player.setVisible(false);
    expect(clock.waiting).toBe(0);
    clock.advance(1000);
    await flush();
    expect(decoded.length).toBe(before);
  });

  it("does not animate a state that has no frames of its own", async () => {
    const clock = new FakeClock();
    const { decoder, decoded } = fakeDecoder(8);
    const painted: number[] = [];
    const { player } = makePlayer({ clock, decoder, painted });
    await player.load("/api/attachments/a.webp");
    // A state the manifest does not name rests on the resting frame.
    player.setState("unknown-state");
    clock.advance(0);
    await flush();
    expect(decoded).toEqual([MANIFEST.restingFrame]);
    // Nothing is scheduled, because a single frame has nothing to animate.
    expect(clock.waiting).toBe(0);
  });

  it("never asks the decoder for a frame the file does not have", async () => {
    const clock = new FakeClock();
    // The manifest claims eight frames, and the decoder says the file holds
    // four.  The decoder is the authority: asking for frame 7 is refused, and
    // the avatar would sit on the last picture it managed to draw.
    const { decoder, decoded } = fakeDecoder(4);
    const painted: number[] = [];
    const { player } = makePlayer({ clock, decoder, painted });
    await player.load("/api/attachments/a.webp");
    player.setState("working");
    clock.advance(0);
    await flush();
    clock.advance(100);
    await flush();
    expect(decoded.every((index) => index >= 0 && index < 4)).toBe(true);
    expect(decoded.at(-1)).toBe(3);
  });
});
