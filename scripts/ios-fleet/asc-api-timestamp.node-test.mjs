import assert from "node:assert/strict";
import test from "node:test";

import { centralTimestamp } from "./asc-api.mjs";

test("centralTimestamp uses lowercase am/pm and never names the zone", () => {
  const stamp = new Date("2026-08-12T06:15:00.000Z");
  const line = centralTimestamp(stamp);
  assert.match(line, /1:15am/);
  assert.doesNotMatch(line, /\bCT\b/);
  assert.doesNotMatch(line, /\bCDT\b/);
  assert.doesNotMatch(line, /\bCST\b/);
  assert.equal(line, "Wed, Aug 12, 2026 at 1:15am");
});
