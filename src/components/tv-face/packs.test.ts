import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import {
  SHIPPED_ONE_FILE_PACKS,
  tvFaceOneFilePackUrl,
  tvFacePackPublicPath,
} from "./packs";

const PACK_DIR = join(process.cwd(), "public/tv-face/packs");

describe("tv-face one-file packs", () => {
  it("registers only files that exist under public/tv-face/packs", () => {
    const onDisk = new Set(readdirSync(PACK_DIR).filter((n) => n.endsWith(".webp")));
    for (const name of SHIPPED_ONE_FILE_PACKS) {
      expect(onDisk.has(name), `missing pack file ${name}`).toBe(true);
    }
  });

  it("maps orange and default to the default pack", () => {
    expect(tvFaceOneFilePackUrl("orange", "idle")).toBe(
      tvFacePackPublicPath("tvface-default.webp"),
    );
    expect(tvFaceOneFilePackUrl("default", "idle")).toBe(
      tvFacePackPublicPath("tvface-default.webp"),
    );
  });

  it("prefers the denser thinking pack only for pure thinking on orange", () => {
    expect(tvFaceOneFilePackUrl("orange", "thinking")).toBe(
      tvFacePackPublicPath("tvface-thinking.webp"),
    );
    // Working and expanded states use the expanded default pack.
    expect(tvFaceOneFilePackUrl("orange", "working")).toBe(
      tvFacePackPublicPath("tvface-default.webp"),
    );
    expect(tvFaceOneFilePackUrl("orange", "tools")).toBe(
      tvFacePackPublicPath("tvface-default.webp"),
    );
    expect(tvFaceOneFilePackUrl("orange", "computer")).toBe(
      tvFacePackPublicPath("tvface-default.webp"),
    );
    expect(tvFaceOneFilePackUrl("orange", "memory")).toBe(
      tvFacePackPublicPath("tvface-default.webp"),
    );
    expect(tvFaceOneFilePackUrl("orange", "listening")).toBe(
      tvFacePackPublicPath("tvface-default.webp"),
    );
  });

  it("keeps expanded and thinking states on the GIF tree for thin color shells", () => {
    for (const color of [
      "blue",
      "green",
      "purple",
      "pink",
      "red",
      "cyan",
      "yellow",
      "teal",
      "coral",
      "white",
      "black",
    ] as const) {
      expect(tvFaceOneFilePackUrl(color, "thinking")).toBeNull();
      expect(tvFaceOneFilePackUrl(color, "tools")).toBeNull();
      expect(tvFaceOneFilePackUrl(color, "computer")).toBeNull();
      expect(tvFaceOneFilePackUrl(color, "memory")).toBeNull();
      // Thin color packs still cover idle / working / speaking.
      expect(tvFaceOneFilePackUrl(color, "working")).toBe(
        tvFacePackPublicPath(`tvface-${color}.webp`),
      );
    }
    expect(tvFaceOneFilePackUrl("default", "thinking")).toBe(
      tvFacePackPublicPath("tvface-thinking.webp"),
    );
  });

  it("maps each shipped color to its color pack for idle", () => {
    for (const color of [
      "blue",
      "green",
      "purple",
      "pink",
      "red",
      "cyan",
      "yellow",
      "teal",
      "coral",
      "white",
      "black",
    ] as const) {
      expect(tvFaceOneFilePackUrl(color, "idle")).toBe(
        tvFacePackPublicPath(`tvface-${color}.webp`),
      );
    }
  });
});
