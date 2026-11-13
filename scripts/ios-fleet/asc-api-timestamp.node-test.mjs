import assert from "node:assert/strict";
import test from "node:test";

import { centralTimestamp } from "./asc-api.mjs";

test("centralTimestamp uses spaced uppercase AM/PM, preserves the date, and never names the zone", () => {
  const summerMorning = centralTimestamp(new Date("2026-08-12T06:15:00.000Z"));
  assert.equal(summerMorning, "Wed, Aug 12, 2026 at 1:15 AM");

  const winterAfternoon = centralTimestamp(new Date("2026-01-17T20:05:00.000Z"));
  assert.equal(winterAfternoon, "Sat, Jan 17, 2026 at 2:05 PM");

  for (const line of [summerMorning, winterAfternoon]) {
    assert.match(line, /\b(?:AM|PM)\b/);
    assert.doesNotMatch(line, /\b(?:am|pm)\b/);
    assert.doesNotMatch(line, /\b(?:CT|CDT|CST)\b/);
  }
});
