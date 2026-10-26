// @vitest-environment happy-dom
// The canvas path of a one-file animated avatar.
//
// A file that carries a manifest is not an image any more: it is a set of
// frames the app draws one at a time, according to the manifest's own
// states.  This test drives the component with a real file (a real extended
// WebP with a real embedded manifest) and a fake frame decoder, so the
// switch from image to player is checked without a browser that can decode
// WebP.

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { embedAvatarManifest, type AvatarManifest } from "../../../shared/avatar-manifest";
import { AnimatedFileAvatar } from "./AnimatedFileAvatar";
import type { AvatarFrameDecoder } from "./player";

const MANIFEST: AvatarManifest = {
  formatVersion: 1,
  name: "test-bot",
  frame: { width: 32, height: 32, count: 8, delayMs: 100 },
  restingFrame: 7,
  states: {
    idle: { hold: { from: 0, to: 1 } },
    working: { enter: { from: 2, to: 3 }, hold: { from: 4, to: 5 } },
  },
};

/** An extended WebP with the manifest embedded in it. */
function webpWithManifest(manifest: AvatarManifest): Uint8Array {
  const vp8x = Buffer.alloc(10);
  const payload = 4 + 8 + vp8x.length + (vp8x.length % 2);
  const file = Buffer.alloc(8 + payload);
  file.write("RIFF", 0, "latin1");
  file.writeUInt32LE(payload, 4);
  file.write("WEBP", 8, "latin1");
  file.write("VP8X", 12, "latin1");
  file.writeUInt32LE(vp8x.length, 16);
  vp8x.copy(file, 20);
  return new Uint8Array(embedAvatarManifest(file, manifest));
}

function fakeDecoder() {
  const decoded: number[] = [];
  const decoder: AvatarFrameDecoder = {
    frameCount: 8,
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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Let the file be read and the frames be drawn. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

describe("the animated file path", () => {
  it("draws a canvas once the file proves it carries a manifest", async () => {
    const { decoder } = fakeDecoder();
    await act(async () => {
      root.render(
        createElement(AnimatedFileAvatar, {
          src: "/api/attachments/a.webp",
          alt: "Scout avatar",
          size: 44,
          state: "idle",
          loadBytes: async () => webpWithManifest(MANIFEST),
          createDecoder: async () => decoder,
        }),
      );
    });
    await settle();
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("keeps the plain image for a file with no manifest", async () => {
    const { decoder, decoded } = fakeDecoder();
    await act(async () => {
      root.render(
        createElement(AnimatedFileAvatar, {
          src: "/api/attachments/a.webp",
          alt: "Scout avatar",
          size: 44,
          state: "idle",
          // A plain image file: bytes with no manifest in them.
          loadBytes: async () => new Uint8Array(Buffer.from("RIFF....WEBPVP8 ", "latin1")),
          createDecoder: async () => decoder,
        }),
      );
    });
    await settle();
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
    expect(decoded).toEqual([]);
  });

  it("keeps the plain image when the browser cannot decode single frames", async () => {
    await act(async () => {
      root.render(
        createElement(AnimatedFileAvatar, {
          src: "/api/attachments/a.webp",
          alt: "Scout avatar",
          size: 44,
          state: "idle",
          loadBytes: async () => webpWithManifest(MANIFEST),
          createDecoder: async () => null,
        }),
      );
    });
    await settle();
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("holds the resting frame when the user asked for less motion", async () => {
    const { decoder, decoded } = fakeDecoder();
    await act(async () => {
      root.render(
        createElement(AnimatedFileAvatar, {
          src: "/api/attachments/a.webp",
          alt: "Scout avatar",
          size: 44,
          state: "working",
          loadBytes: async () => webpWithManifest(MANIFEST),
          createDecoder: async () => decoder,
          prefersReducedMotion: () => true,
        }),
      );
    });
    await settle();
    expect(container.querySelector("canvas")).not.toBeNull();
    // The resting frame and nothing else: a user who asked for less motion
    // gets a still avatar, not a slower one.
    expect(decoded.length).toBeGreaterThan(0);
    expect(new Set(decoded)).toEqual(new Set([MANIFEST.restingFrame]));
  });

  it("holds the resting frame when the caller does not want an animated avatar", async () => {
    const { decoder, decoded } = fakeDecoder();
    await act(async () => {
      root.render(
        createElement(AnimatedFileAvatar, {
          src: "/api/attachments/a.webp",
          alt: "Scout avatar",
          size: 44,
          state: "working",
          animated: false,
          loadBytes: async () => webpWithManifest(MANIFEST),
          createDecoder: async () => decoder,
        }),
      );
    });
    await settle();
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(decoded.length).toBeGreaterThan(0);
    expect(new Set(decoded)).toEqual(new Set([MANIFEST.restingFrame]));
  });
});
