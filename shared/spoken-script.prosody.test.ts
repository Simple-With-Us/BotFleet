import { describe, expect, it } from "vitest";
import { stripMiniMaxSoundTags, stripOnDeviceProsodyMarkup, stripPauseTags } from "./spoken-script.ts";

describe("on-device prosody markup", () => {
  it("strips MiniMax sound tags", () => {
    expect(stripMiniMaxSoundTags("Done (breath) and (chuckle) on.")).toBe("Done and on.");
    expect(stripMiniMaxSoundTags("Quiet (sighs) end.")).toBe("Quiet end.");
  });

  it("strips pause tags and sound tags together for Personal Voice", () => {
    expect(stripOnDeviceProsodyMarkup("Hi. <#0.3#> There (breath) now.")).toBe("Hi. There now.");
    expect(stripPauseTags("Hi. <#0.3#> There.")).toBe("Hi. There.");
  });
});
