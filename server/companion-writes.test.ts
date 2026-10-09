import { describe, expect, it } from "vitest";

import {
  autoUpdateBodySchema,
  botOrganizeSchema,
  checkBotOrganizeBody,
  parseAutoUpdateBody,
  phoneBotOrganizeSchema,
} from "./companion-writes.ts";

// Both audiences share the six fields and their types; only the handling of
// every other key differs.
describe.each([
  ["the desktop", false],
  ["a paired phone", true],
])("bot organize body from %s", (_who, fromPhone) => {
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
      expect(checkBotOrganizeBody(body, fromPhone), JSON.stringify(body)).toEqual({ ok: true });
    }
  });

  it("names the field whose type is wrong, as a 400", () => {
    for (const field of ["hidden", "pinned", "unread", "chiefOfStaff"]) {
      for (const bad of ["true", 1, 0, null, {}, []]) {
        expect(checkBotOrganizeBody({ [field]: bad }, fromPhone), `${field}=${JSON.stringify(bad)}`).toEqual({
          ok: false,
          status: 400,
          error: `${field} must be true or false`,
        });
      }
    }
    expect(checkBotOrganizeBody({ section: 4 }, fromPhone)).toEqual({
      ok: false,
      status: 400,
      error: "section must be a string or null",
    });
    expect(checkBotOrganizeBody({ section: [] }, fromPhone)).toEqual({
      ok: false,
      status: 400,
      error: "section must be a string or null",
    });
    for (const bad of [1, true, {}, "../x", "a b", "x/y"]) {
      expect(checkBotOrganizeBody({ pinnedMessageId: bad }, fromPhone), JSON.stringify(bad)).toEqual({
        ok: false,
        status: 400,
        error: "pinnedMessageId must be a message id or null",
      });
    }
  });

  it("refuses a body that is not an object", () => {
    for (const bad of [null, "pinned", 4, [true], undefined]) {
      expect(checkBotOrganizeBody(bad, fromPhone), JSON.stringify(bad)).toEqual({
        ok: false,
        status: 400,
        error: "body must be a JSON object",
      });
    }
  });
});

describe("bot organize body: every other key", () => {
  const others = [
    "cloudBackend",
    "color",
    "mascotExpression",
    "name",
    "cwd",
    "autoApprove",
    "bypassPermissions",
    "alwaysAllow",
    "computers",
    "modelSelection",
    "futurePrivilege",
  ];

  it("is left to the desktop route's own validation, because the desktop uses them", () => {
    expect(checkBotOrganizeBody({ name: "Scout", cwd: "/tmp", autoApprove: true, pinned: true }, false)).toEqual({
      ok: true,
    });
    expect(botOrganizeSchema.safeParse({ pinned: true, cloudBackend: "vps" }).success).toBe(true);
  });

  it("is a 403 from a paired phone, alone or beside an organize field, never dropped", () => {
    for (const field of others) {
      for (const body of [{ [field]: "box" }, { pinned: true, [field]: true }, { [field]: { nested: ["x"] } }]) {
        expect(checkBotOrganizeBody(body, true), `${field}: ${JSON.stringify(body)}`).toEqual({
          ok: false,
          status: 403,
          error: `${field} can only be changed in BotFleet on your computer`,
        });
      }
    }
    expect(phoneBotOrganizeSchema.safeParse({ pinned: true, cloudBackend: "vps" }).success).toBe(false);
  });
});

describe("auto-update body", () => {
  it("reads one boolean", () => {
    expect(parseAutoUpdateBody({ enabled: true })).toEqual({ ok: true, enabled: true });
    expect(parseAutoUpdateBody({ enabled: false })).toEqual({ ok: true, enabled: false });
  });

  it("refuses anything else", () => {
    for (const bad of [{}, { enabled: "true" }, { enabled: 1 }, { enabled: null }, { autoUpdate: { enabled: true } }]) {
      expect(parseAutoUpdateBody(bad), JSON.stringify(bad)).toEqual({ ok: false, error: "enabled must be true or false" });
    }
    for (const bad of [null, "enabled", 4, [true], undefined]) {
      expect(parseAutoUpdateBody(bad), JSON.stringify(bad)).toEqual({ ok: false, error: "body must be a JSON object" });
    }
  });

  it("strips keys beside it at parse time, so they can never reach the config patch", () => {
    expect(parseAutoUpdateBody({ enabled: true, profile: { name: "x" }, ingress: { publicUrl: "https://x.example" } })).toEqual({
      ok: true,
      enabled: true,
    });
    expect(autoUpdateBodySchema.parse({ enabled: false, cloudBackend: "vps" })).toEqual({ enabled: false });
  });
});
