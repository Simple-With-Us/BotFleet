// The profile patch parser is the boundary that keeps paired clients from
// writing anything but identity fields. The strict half is the one that
// matters: a privileged bot field arriving here must be refused by NAME,
// so a future field cannot silently become remotely writable.
import { describe, expect, it } from "vitest";

import { parseBotProfilePatch, resolveMaxToolRounds } from "./bot-profile.ts";

describe("parseBotProfilePatch (strict — the paired boundary)", () => {
  it("refuses unknown keys — strict means the allowlist IS the contract", () => {
    const result = parseBotProfilePatch({ color: "red" } as never, true);
    expect(result).toEqual({ ok: false, error: "unsupported profile field: color" });
    const result2 = parseBotProfilePatch({ unknownProperty: true } as never, true);
    expect(result2).toEqual({ ok: false, error: "unsupported profile field: unknownProperty" });
  });

  it("accepts the full identity and configuration surface", () => {
    const result = parseBotProfilePatch(
      {
        name: "Mira",
        title: "Lead",
        description: "plans",
        notifications: true,
        voice: "vx",
        speakReplies: false,
        chiefOfStaff: true,
        autoApprove: true,
        autoReview: "shadow",
        composio: true,
        cloudBackend: "box",
        cwd: "/Users/test/Code",
      },
      true,
    );
    expect(result).toEqual({
      ok: true,
      patch: {
        name: "Mira",
        title: "Lead",
        description: "plans",
        notifications: true,
        voice: "vx",
        speakReplies: false,
        chiefOfStaff: true,
        autoApprove: true,
        autoReview: "shadow",
        composio: true,
        cloudBackend: "box",
        cwd: "/Users/test/Code",
      },
    });
  });
});

describe("parseBotProfilePatch (both modes)", () => {
  it("lenient mode drops unknown keys instead of failing — the desktop PATCH mixes fields", () => {
    const result = parseBotProfilePatch({ name: "Mira", color: "red" } as never, false);
    expect(result).toEqual({ ok: true, patch: { name: "Mira" } });
  });

  it("rejects a blank or oversized name", () => {
    expect(parseBotProfilePatch({ name: "   " }, true).ok).toBe(false);
    expect(parseBotProfilePatch({ name: "x".repeat(101) }, true).ok).toBe(false);
  });

  it("only stored-attachment avatar URLs pass; clears normalize to undefined", () => {
    for (const bad of ["https://example.com/a.png", "data:image/png;base64,AAAA", "/api/attachments/../config.json", "/api/attachments/a.exe"]) {
      expect(parseBotProfilePatch({ avatarUrl: bad } as never, true).ok, bad).toBe(false);
    }
    expect(parseBotProfilePatch({ avatarUrl: "/api/attachments/a.svg" } as never, true).ok).toBe(true);
    const cleared = parseBotProfilePatch({ avatarUrl: "" }, true);
    expect(cleared).toEqual({ ok: true, patch: { avatarUrl: undefined } });
    const nulled = parseBotProfilePatch({ avatarUrl: null }, true);
    expect(nulled).toEqual({ ok: true, patch: { avatarUrl: undefined } });
  });

  it("maps an avatarCrop issue to the readable message", () => {
    expect(parseBotProfilePatch({ avatarCrop: "hexagon" } as never, true)).toEqual({
      ok: false,
      error: "avatarCrop must be mascot, circle, rounded, or square",
    });
  });
});

// connectorTools (Finding 1a/1d): per-bot Composio tool grants, validated at
// this same boundary so a malformed PATCH — from either surface — never
// reaches the store. See server/connector-verdict.ts for how it is enforced.
describe("parseBotProfilePatch (connectorTools)", () => {
  it("accepts a star grant, an explicit tool list, and multiple services", () => {
    const result = parseBotProfilePatch(
      { connectorTools: { gmail: { tools: "*" }, slack: { tools: ["SLACK_POST_MESSAGE"] } } },
      true,
    );
    expect(result).toEqual({
      ok: true,
      patch: { connectorTools: { gmail: { tools: "*" }, slack: { tools: ["SLACK_POST_MESSAGE"] } } },
    });
  });

  it("accepts the empty record — denies every connected-app tool without touching composio", () => {
    expect(parseBotProfilePatch({ connectorTools: {} }, true)).toEqual({ ok: true, patch: { connectorTools: {} } });
  });

  it("null clears a bot back to legacy all-tools, the same shape as avatarUrl/cwd", () => {
    expect(parseBotProfilePatch({ connectorTools: null }, true)).toEqual({ ok: true, patch: { connectorTools: undefined } });
  });

  it("omitting the field entirely leaves it out of the patch — existing grants are untouched", () => {
    const result = parseBotProfilePatch({ name: "Mira" }, true);
    expect(result.ok).toBe(true);
    expect(result.ok && "connectorTools" in result.patch).toBe(false);
  });

  it("rejects malformed grants", () => {
    for (const bad of [
      { connectorTools: "gmail" },
      { connectorTools: { Gmail: { tools: "*" } } }, // slug must be lowercase
      { connectorTools: { gmail: "*" } }, // must be a { tools } object
      { connectorTools: { gmail: { tools: "*", extra: 1 } } }, // no extra keys
      { connectorTools: { gmail: { tools: [] } } }, // empty list — omit the service instead
      { connectorTools: { gmail: { tools: ["gmail_send_email"] } } }, // must be upper-snake
      { connectorTools: { gmail: { tools: [42] } } },
      { connectorTools: { gmail: { tools: "everything" } } },
    ]) {
      const result = parseBotProfilePatch(bad as never, true);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("rejects more services or tools than the caps allow", () => {
    const tooManyServices: Record<string, { tools: "*" }> = {};
    for (let i = 0; i < 65; i++) tooManyServices[`svc${i}`] = { tools: "*" };
    expect(parseBotProfilePatch({ connectorTools: tooManyServices } as never, true).ok).toBe(false);

    const tooManyTools = Array.from({ length: 501 }, (_, i) => `GMAIL_TOOL_${i}`);
    expect(parseBotProfilePatch({ connectorTools: { gmail: { tools: tooManyTools } } } as never, true).ok).toBe(false);
  });

  it("validates identically in lenient mode — the desktop's broad PATCH shares this boundary", () => {
    expect(parseBotProfilePatch({ connectorTools: { gmail: "*" } } as never, false).ok).toBe(false);
    expect(parseBotProfilePatch({ connectorTools: { gmail: { tools: "*" } } }, false)).toEqual({
      ok: true,
      patch: { connectorTools: { gmail: { tools: "*" } } },
    });
  });
});

describe("parseBotProfilePatch (maxToolRounds)", () => {
  it("keeps an integer in 1..200", () => {
    expect(parseBotProfilePatch({ maxToolRounds: 2 }, true)).toEqual({
      ok: true,
      patch: { maxToolRounds: 2 },
    });
    expect(parseBotProfilePatch({ maxToolRounds: 200 }, true)).toEqual({
      ok: true,
      patch: { maxToolRounds: 200 },
    });
    expect(parseBotProfilePatch({ maxToolRounds: 1 }, false)).toEqual({
      ok: true,
      patch: { maxToolRounds: 1 },
    });
  });

  it("treats null, empty string, and invalid values as absent (clear)", () => {
    for (const bad of [null, "", 0, -1, 201, 1.5, "12", true, {}, []]) {
      expect(parseBotProfilePatch({ maxToolRounds: bad } as never, true), String(bad)).toEqual({
        ok: true,
        patch: { maxToolRounds: undefined },
      });
    }
  });

  it("omitting the field leaves it out of the patch — existing values stay", () => {
    const result = parseBotProfilePatch({ name: "Mira" }, true);
    expect(result.ok).toBe(true);
    expect(result.ok && "maxToolRounds" in result.patch).toBe(false);
  });
});

describe("resolveMaxToolRounds", () => {
  it("accepts 1..200 integers and rejects everything else", () => {
    expect(resolveMaxToolRounds(2)).toBe(2);
    expect(resolveMaxToolRounds(12)).toBe(12);
    expect(resolveMaxToolRounds(200)).toBe(200);
    for (const bad of [undefined, null, "", 0, -3, 201, 2.5, "2", NaN, Infinity]) {
      expect(resolveMaxToolRounds(bad), String(bad)).toBeUndefined();
    }
  });
});
