import { describe, expect, it } from "vitest";

import { checkBotOrganizeBody, parseAutoUpdateBody } from "./companion-writes.ts";

describe("bot organize body", () => {
  it("accepts each organize field with its own type", () => {
    for (const body of [
      { hidden: true },
      { hidden: false },
      { pinned: true },
      { unread: false },
      { chiefOfStaff: true },
      { section: "Work" },
      { section: null },
      { pinnedMessageId: "msg_1-a" },
      { pinnedMessageId: "" },
      { pinnedMessageId: null },
      { hidden: true, chiefOfStaff: false, section: null },
      {},
    ]) {
      expect(checkBotOrganizeBody(body), JSON.stringify(body)).toEqual({ ok: true });
    }
  });

  it("names the field whose type is wrong", () => {
    for (const field of ["hidden", "pinned", "unread", "chiefOfStaff"]) {
      for (const bad of ["true", 1, 0, null, {}, []]) {
        expect(checkBotOrganizeBody({ [field]: bad }), `${field}=${JSON.stringify(bad)}`).toEqual({
          ok: false,
          error: `${field} must be true or false`,
        });
      }
    }
    expect(checkBotOrganizeBody({ section: 4 })).toEqual({ ok: false, error: "section must be a string or null" });
    expect(checkBotOrganizeBody({ section: [] })).toEqual({ ok: false, error: "section must be a string or null" });
    for (const bad of [1, true, {}, "../x", "a b", "x/y"]) {
      expect(checkBotOrganizeBody({ pinnedMessageId: bad }), JSON.stringify(bad)).toEqual({
        ok: false,
        error: "pinnedMessageId must be a message id or null",
      });
    }
  });

  it("is not the place that refuses other fields, because the desktop uses them", () => {
    // `name`, `cwd`, `autoApprove` and the rest have their own validation in
    // the route; the sidecar is what keeps them off the phone.
    expect(checkBotOrganizeBody({ name: "Scout", cwd: "/tmp", autoApprove: true, pinned: true })).toEqual({ ok: true });
  });

  it("refuses a body that is not an object", () => {
    for (const bad of [null, "pinned", 4, [true], undefined]) {
      expect(checkBotOrganizeBody(bad), JSON.stringify(bad)).toEqual({ ok: false, error: "body must be a JSON object" });
    }
  });
});

describe("auto-update body", () => {
  it("reads one boolean", () => {
    expect(parseAutoUpdateBody({ enabled: true })).toEqual({ ok: true, enabled: true });
    expect(parseAutoUpdateBody({ enabled: false })).toEqual({ ok: true, enabled: false });
  });

  it("refuses anything else, and ignores keys beside it", () => {
    for (const bad of [{}, { enabled: "true" }, { enabled: 1 }, { enabled: null }, { autoUpdate: { enabled: true } }]) {
      expect(parseAutoUpdateBody(bad), JSON.stringify(bad)).toEqual({ ok: false, error: "enabled must be true or false" });
    }
    for (const bad of [null, "enabled", 4, [true], undefined]) {
      expect(parseAutoUpdateBody(bad), JSON.stringify(bad)).toEqual({ ok: false, error: "body must be a JSON object" });
    }
    // extra keys never reach the config patch: only `enabled` is returned
    expect(parseAutoUpdateBody({ enabled: true, profile: { name: "x" } })).toEqual({ ok: true, enabled: true });
  });
});
