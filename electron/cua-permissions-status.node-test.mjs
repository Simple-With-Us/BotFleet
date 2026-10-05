import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCuaPermissionsStdout } from "./cua-permissions-status.mjs";

describe("parseCuaPermissionsStdout", () => {
  it("accepts documented permissions status JSON", () => {
    const parsed = parseCuaPermissionsStdout(
      JSON.stringify({
        accessibility: true,
        screen_recording: true,
        screen_recording_capturable: null,
        direct_capture_status: "not_checked",
        source: { attribution: "driver-daemon" },
      }),
    );
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.accessibility, true);
  });

  it("rejects unknown fields and malformed JSON", () => {
    assert.equal(parseCuaPermissionsStdout("{not json").ok, false);
    assert.equal(
      parseCuaPermissionsStdout(JSON.stringify({ accessibility: true, extra: true })).ok,
      false,
    );
  });
});
