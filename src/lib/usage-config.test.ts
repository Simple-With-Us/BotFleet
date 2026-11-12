import { describe, expect, it } from "vitest";

import { buildUsageConfigPatch, isAbsoluteHttpUrl } from "./usage-config";

describe("isAbsoluteHttpUrl", () => {
  it("accepts http(s) origins and rejects scheme-less hosts", () => {
    expect(isAbsoluteHttpUrl("https://usage.example.com")).toBe(true);
    expect(isAbsoluteHttpUrl("http://127.0.0.1:3000/")).toBe(true);
    expect(isAbsoluteHttpUrl("usage.example.com")).toBe(false);
    expect(isAbsoluteHttpUrl("ftp://usage.example.com")).toBe(false);
    expect(isAbsoluteHttpUrl("https://user:pass@usage.example.com")).toBe(false);
    expect(isAbsoluteHttpUrl("")).toBe(false);
  });
});

describe("buildUsageConfigPatch", () => {
  it("omits blank tokens so a save cannot wipe a stored secret", () => {
    expect(
      buildUsageConfigPatch({
        ingestUrl: "https://usage.example.com/",
        ingestToken: "  ",
        readToken: "",
      }),
    ).toEqual({
      ok: true,
      patch: { ingestUrl: "https://usage.example.com/" },
    });
  });

  it("includes typed tokens and allows clearing the URL", () => {
    expect(
      buildUsageConfigPatch({
        ingestUrl: "",
        ingestToken: "tok_ingest",
        readToken: "tok_read",
      }),
    ).toEqual({
      ok: true,
      patch: { ingestUrl: "", ingestToken: "tok_ingest", readToken: "tok_read" },
    });
  });

  it("rejects a scheme-less URL before the request is sent", () => {
    expect(
      buildUsageConfigPatch({
        ingestUrl: "usage.example.com",
        ingestToken: "tok",
        readToken: "",
      }),
    ).toEqual({
      ok: false,
      error: "Usage Monitor URL must be an absolute http(s) URL.",
    });
  });
});
