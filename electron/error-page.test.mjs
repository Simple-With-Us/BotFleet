import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");

describe("packaged error page (UX-022)", () => {
  it("keeps Try Again on the packaged server-boot error page", () => {
    expect(src).toContain('SERVER_RETRY_URL = "botfleet://retry-server"');
    expect(src).toMatch(/<a class="retry"[^>]*>Try Again<\/a>/);
    expect(src).toContain("Couldn't Start The Bot Server");
    // In remote mode nothing is started on this Mac, so the heading says so.
    expect(src).toContain("Couldn't Reach The Bot Server");
  });
});
