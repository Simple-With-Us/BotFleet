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

  it("prefers the thinking pack for thinking/working on orange", () => {
    expect(tvFaceOneFilePackUrl("orange", "thinking")).toBe(
      tvFacePackPublicPath("tvface-thinking.webp"),
    );
    expect(tvFaceOneFilePackUrl("orange", "working")).toBe(
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
