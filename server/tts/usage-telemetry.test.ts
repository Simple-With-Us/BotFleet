// Every synthesized clip is also reported to Usage Monitor (BF-2435).  Voice
// is billed by characters and Usage Monitor's schema has no character unit,
// so the event counts one request and carries the characters in metadata.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { telemetry } from "../telemetry.ts";
import { recordSpeechUsage } from "./usage.ts";

describe("speech usage reaches telemetry", () => {
  let dir: string;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.OMB_DATA_DIR;
    dir = mkdtempSync(join(tmpdir(), "bf-tts-usage-"));
    process.env.OMB_DATA_DIR = dir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.OMB_DATA_DIR;
    else process.env.OMB_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reports each provider's clip with its characters and where the count came from", () => {
    const track = vi.spyOn(telemetry, "trackAux").mockImplementation(() => {});

    recordSpeechUsage("minimax", 412, "provider", { service: "speech-2.8-turbo" });
    recordSpeechUsage("xai", 90, "submitted", { service: "xai-tts" });
    recordSpeechUsage("azure", 12, "provider");

    expect(track.mock.calls.map(([params]) => [params.kind, params.provider, params.service, params.metadata])).toEqual([
      ["tts", "minimax", "speech-2.8-turbo", { characters: 412, characterSource: "provider" }],
      ["tts", "xai", "xai-tts", { characters: 90, characterSource: "submitted" }],
      ["tts", "azure", "tts", { characters: 12, characterSource: "provider" }],
    ]);
  });

  it("reports nothing for a count that is not a count", () => {
    const track = vi.spyOn(telemetry, "trackAux").mockImplementation(() => {});

    recordSpeechUsage("minimax", -1, "provider");
    recordSpeechUsage("minimax", 1.5, "provider");

    expect(track).not.toHaveBeenCalled();
  });
});
