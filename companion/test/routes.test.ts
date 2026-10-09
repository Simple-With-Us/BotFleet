// The allowlist.
//
// The proxy tests prove the app's own calls reach a real harness. These prove
// the other half, which no end-to-end test can: that everything else does
// not. The case worth caring about is the last one — a route nobody here has
// heard of is denied, because that is the property the whole file exists for
// and the one that quietly stopped being true once before.
import { describe, expect, it } from "vitest";

import {
  COMPANION_BOT_ORGANIZE_FIELDS,
  COMPANION_PROFILE_PATCH_FIELDS,
  companionBodyCheck,
  companionBotOrganizeDenial,
  companionProfilePatchDenial,
  denyReason,
} from "../src/routes.ts";

const ask = (method: string, path: string, authenticated = true) =>
  denyReason({ method, path, authenticated });

const allowed = (method: string, path: string) => ask(method, path) === null;

describe("credentials", () => {
  it("lets an unpaired device pair, and do nothing else", () => {
    expect(ask("POST", "/api/pair", false)).toBeNull();
    expect(ask("GET", "/api/bots", false)).toEqual({
      status: 401,
      error: "pair this device from Phone settings in BotFleet on your computer",
    });
  });

  it("lets anyone curl liveness — it is the unauthenticated smoke test", () => {
    expect(ask("GET", "/api/health", false)).toBeNull();
    // the bypass is one method on one path, not a family
    expect(ask("POST", "/api/health", false)?.status).toBe(401);
    expect(ask("GET", "/api/healthz", false)?.status).toBe(401);
  });
});

describe("what the app may do", () => {
  // Every request in ios/Sources/CompanionCore/Client.swift. If one of these
  // fails, a screen on the phone is broken.
  const calls: Array<[string, string]> = [
    ["GET", "/api/health"],
    ["GET", "/api/config"],
    ["GET", "/api/events"],
    ["GET", "/api/instances"],
    ["GET", "/api/companion/endpoints"],
    ["POST", "/api/companion/push-token"],
    ["GET", "/api/bots"],
    ["POST", "/api/bots"],
    ["POST", "/api/bots/bot_123/messages"],
    ["DELETE", "/api/bots/bot_123/queue/q_1"],
    ["POST", "/api/bots/bot_123/interrupt"],
    ["POST", "/api/bots/bot_123/read"],
    ["POST", "/api/bots/bot_123/messages/msg_2/edit"],
    ["POST", "/api/bots/bot_123/active-branch"],
    ["POST", "/api/bots/bot_123/tasks"],
    ["POST", "/api/bots/bot_123/tasks/th_1"],
    ["PATCH", "/api/bots/bot_123/tasks/th_1"],
    ["DELETE", "/api/bots/bot_123/tasks/th_1"],
    ["PATCH", "/api/bots/bot_123/profile"],
    ["PATCH", "/api/bots/bot_123"],
    ["DELETE", "/api/bots/bot_123"],
    ["POST", "/api/bots/apply-model-defaults"],
    ["POST", "/api/bots/bot_123/avatar/generate"],
    ["POST", "/api/bots/bot_123/computer/join"],
    ["PATCH", "/api/groups/room-1"],
    ["DELETE", "/api/groups/room-1"],
    ["PATCH", "/api/auto-update"],
    ["POST", "/api/groups/room-1/messages"],
    ["POST", "/api/groups/room-1/interrupt"],
    ["POST", "/api/groups/room-1/read"],
    ["POST", "/api/groups/room-1/tasks"],
    ["POST", "/api/groups/room-1/tasks/th_1"],
    ["PATCH", "/api/groups/room-1/tasks/th_1"],
    ["DELETE", "/api/groups/room-1/tasks/th_1"],
    ["GET", "/api/threads/th_1/messages"],
    ["GET", "/api/threads/th_1/messages/msg_2/image"],
    ["POST", "/api/threads/th_1/messages/msg_2/reactions"],
    ["GET", "/api/threads/th_1/export"],
    ["POST", "/api/threads/th_1/respond"],
    ["GET", "/api/search"],
    ["POST", "/api/attachments"],
    ["GET", "/api/attachments/avatar-123.webp"],
    ["GET", "/api/tts/voices"],
    ["POST", "/api/tts/speak"],
    ["POST", "/api/threads/th_1/messages/msg_2/audio"],
    ["GET", "/api/threads/th_1/messages/msg_2/audio/0"],
    ["GET", "/api/routines"],
    ["POST", "/api/routines"],
    ["PATCH", "/api/routines/routine_1"],
    ["DELETE", "/api/routines/routine_1"],
    ["POST", "/api/routines/routine_1/run"],
    ["GET", "/api/connectors/catalog"],
    ["GET", "/api/connectors/connected"],
    ["GET", "/api/connectors"],
    ["POST", "/api/connectors/slack/authorize"],
    ["DELETE", "/api/connectors/slack/accounts/ca_123"],
  ];

  for (const [method, path] of calls) {
    it(`allows ${method} ${path}`, () => expect(ask(method, path)).toBeNull());
  }

  it("carries a thread snooze on the task patch the phone already had, not a new door", () => {
    // `CompanionClient.snoozeTask` adds a FIELD to an allowed route rather
    // than a route of its own, so the phone gains per-thread snooze without
    // widening what a lost phone can reach.  Nothing here validates that
    // field: the harness does, and refuses anything that is not a
    // timestamp, 0, or null.
    expect(allowed("PATCH", "/api/bots/bot_123/tasks/th_1")).toBe(true);
    // No snooze route was invented on either side; an invented one would be
    // closed until someone added it here on purpose, which is the point.
    expect(ask("PATCH", "/api/bots/bot_123/tasks/th_1/snooze")?.status).toBe(404);
    expect(ask("POST", "/api/bots/bot_123/tasks/th_1/snooze")?.status).toBe(404);
    // And it is still a paired-device route rather than an open one.
    expect(ask("PATCH", "/api/bots/bot_123/tasks/th_1", false)?.status).toBe(401);
  });

  it("lets the phone check for a newer BotFleet and install it", () => {
    expect(allowed("GET", "/api/update/status")).toBe(true);
    expect(allowed("POST", "/api/update/check")).toBe(true);
    expect(allowed("POST", "/api/update/run")).toBe(true);
    // Exactly those three.  The updater's own recovery action stays on the
    // Mac, and an unpaired device gets nothing.
    expect(ask("POST", "/api/update/unquiesce")?.status).toBe(404);
    expect(ask("POST", "/api/update/status")?.status).toBe(404);
    expect(ask("GET", "/api/update/status", false)?.status).toBe(401);
  });
});

describe("what it may not", () => {
  it("keeps always-allow on the computer, and lets the phone connect an app", () => {
    expect(ask("POST", "/api/bots/bot_123/always-allow")).toEqual({
      status: 404,
      error: "no route: POST /api/bots/bot_123/always-allow",
    });
    // The phone shipped a Connect button the companion refused, so the
    // option failed at the tap.  Owner's call: parity (see routes.ts).
    expect(ask("POST", "/api/connectors/slack/authorize")).toBeNull();
    expect(ask("DELETE", "/api/connectors/slack/accounts/ca_123")).toBeNull();
    // Profile subset and approval answers stay on the phone.  Privilege
    // fields on profile are still refused by the harness, not widened here.
    expect(ask("PATCH", "/api/bots/bot_123/profile")).toBeNull();
    expect(ask("POST", "/api/threads/th_1/respond")).toBeNull();
    expect(ask("POST", "/api/threads/th_1/approve-all")).toBeNull();
  });

  it("accepts every paired profile field and refuses host-control fields", () => {
    for (const field of COMPANION_PROFILE_PATCH_FIELDS) {
      expect(companionProfilePatchDenial({ [field]: "value" }), field).toBeNull();
    }
    for (const field of [
      "autoApprove",
      "autoReview",
      "bypassPermissions",
      "composio",
      "connectorTools",
      "computers",
      "cloudBackend",
      "autoStartVps",
      "cwd",
      "extraCwds",
      "userNotes",
      "chiefOfStaff",
      "approvePeerComms",
      "futurePrivilege",
    ]) {
      expect(companionProfilePatchDenial({ name: "Scout", [field]: true }), field).toEqual({
        status: 403,
        error: `${field} can only be changed in BotFleet on your computer`,
      });
    }
  });

  it("lets the phone turn a bot Off and back On, and only through the profile route", () => {
    // The phone's disabled composer has one button, Turn On, so a refusal here
    // would strand an Off bot on the phone.
    expect(COMPANION_PROFILE_PATCH_FIELDS).toContain("off");
    expect(companionProfilePatchDenial({ off: true })).toBeNull();
    expect(companionProfilePatchDenial({ off: false })).toBeNull();
    // Switching it is not a way to smuggle a host-control field along.
    expect(companionProfilePatchDenial({ off: false, autoApprove: true })).toEqual({
      status: 403,
      error: "autoApprove can only be changed in BotFleet on your computer",
    });
    // The general bot PATCH is on the route list only for roster
    // organization, behind a field allowlist (see the organize tests below).
    // Turning a bot Off is still a profile field and nothing else.
    expect(allowed("PATCH", "/api/bots/b_1")).toBe(true);
    expect(companionBotOrganizeDenial({ off: true })).toEqual({
      status: 403,
      error: "off can only be changed in BotFleet on your computer",
    });
    expect(allowed("PATCH", "/api/bots/b_1/profile")).toBe(true);
  });

  it("lets the phone write per-device voices", () => {
    expect(COMPANION_PROFILE_PATCH_FIELDS).toContain("voices");
    expect(companionProfilePatchDenial({ voices: { iphone: "English_Graceful_Lady" } })).toBeNull();
    expect(companionProfilePatchDenial({ voices: null, speechDevices: ["mac", "iphone"] })).toBeNull();
  });

  it("permits a device-qualified clip GET", () => {
    // The sidecar matches the path with the query removed and forwards the
    // query untouched, so `?device=` needs no allowlist entry of its own.
    expect(ask("GET", "/api/threads/th_1/messages/msg_1/audio/0")).toBeNull();
  });

  it("permits message-linked audio but not arbitrary attachment audio", () => {
    expect(ask("POST", "/api/threads/th_1/messages/msg_1/audio")).toBeNull();
    expect(ask("GET", "/api/threads/th_1/messages/msg_1/audio/0")).toBeNull();
    expect(allowed("GET", "/api/attachments/voice.mp3")).toBe(false);
    expect(allowed("GET", "/api/threads/th_1/messages/msg_1/audio/../../config")).toBe(false);
  });

  it("serves exactly the image formats the native client can render", () => {
    for (const extension of ["png", "jpg", "jpeg", "gif", "webp"]) {
      expect(allowed("GET", `/api/attachments/avatar-123.${extension}`), extension).toBe(true);
    }
    for (const extension of ["heic", "heif", "avif", "bmp", "svg"]) {
      expect(allowed("GET", `/api/attachments/avatar-123.${extension}`), extension).toBe(false);
    }
  });

  it("refuses host configuration, and says where it happens", () => {
    for (const [method, path] of [
      ["PUT", "/api/config"],
      ["PATCH", "/api/config"],
      ["GET", "/api/devices"],
      ["GET", "/api/companion"],
      ["POST", "/api/local-computer/start"],
      ["POST", "/api/webhooks"],
      ["POST", "/api/webhooks/wh_1/rotate"],
      ["POST", "/api/resource-triggers"],
      // one whole connected app, not one account of it
      ["DELETE", "/api/connectors/gmail"],
      ["POST", "/api/teams/import"],
    ] as Array<[string, string]>) {
      const denial = ask(method, path);
      expect(denial?.status, `${method} ${path}`).toBe(403);
      expect(denial?.error, `${method} ${path}`).toMatch(/on your computer/);
    }
    expect(ask("GET", "/api/devices")).toEqual({
      status: 403,
      error: "Phone settings are managed on your computer",
    });
    expect(ask("GET", "/api/companion")).toEqual({
      status: 403,
      error: "Phone settings are managed on your computer",
    });
  });

  it("keeps endpoint refresh authenticated and exact-method only", () => {
    expect(ask("GET", "/api/companion/endpoints", false)?.status).toBe(401);
    expect(ask("GET", "/api/companion/endpoints")).toBeNull();
    expect(ask("POST", "/api/companion/endpoints")?.status).toBe(403);
    expect(ask("GET", "/api/companion/endpoints/extra")?.status).toBe(403);
  });

  it("lets a paired phone register an APNs token on the sidecar", () => {
    expect(ask("POST", "/api/companion/push-token", false)?.status).toBe(401);
    expect(ask("POST", "/api/companion/push-token")).toBeNull();
    expect(ask("GET", "/api/companion/push-token")?.status).toBe(403);
  });

  it("describes only refused routine operations as computer-only", () => {
    for (const [method, path] of [
      ["GET", "/api/routines/routine_1"],
      ["PUT", "/api/routines/routine_1"],
      ["POST", "/api/routines/routine_1/cancel"],
    ] as Array<[string, string]>) {
      const denial = ask(method, path);
      expect(denial, `${method} ${path}`).toEqual({
        status: 403,
        error: "this routine operation is only available on your computer",
      });
    }
    expect(ask("GET", "/api/routines")).toBeNull();
    expect(ask("POST", "/api/routines/routine_1/run")).toBeNull();
  });

  it("denies the peer-agent endpoints exist at all", () => {
    expect(ask("GET", "/api/internal/peers")?.status).toBe(404);
    expect(ask("POST", "/api/internal/ask-bot")?.status).toBe(404);
  });

  it("does not serve the desktop UI", () => {
    expect(ask("GET", "/")?.status).toBe(404);
    expect(ask("GET", "/index.html")?.status).toBe(404);
  });

  it("opens only a fresh cloud viewer, not the cloud computer control API", () => {
    expect(allowed("POST", "/api/bots/bot_123/computer/join")).toBe(true);
    expect(allowed("GET", "/api/bots/bot_123/computer")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/computer/provision")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/computer/sleep")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/computer/exec")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/computer/screenshot")).toBe(false);
  });

  // The method is part of the allowance, not decoration: reading the fleet
  // and deleting a bot are the same path.
  it("allows a path only for the methods it was allowed for", () => {
    expect(allowed("GET", "/api/bots")).toBe(true);
    // a bot id is one path segment: the bare resource takes exactly the
    // verbs listed, and nothing nested under it by accident
    expect(allowed("DELETE", "/api/bots/bot_123")).toBe(true);
    expect(allowed("PUT", "/api/bots/bot_123")).toBe(false);
    expect(allowed("GET", "/api/bots/bot_123")).toBe(false);
    expect(allowed("DELETE", "/api/bots/bot_123/profile")).toBe(false);
    expect(allowed("DELETE", "/api/bots/bot_123/messages")).toBe(false);
    expect(allowed("POST", "/api/threads/th_1/messages")).toBe(false);
    expect(allowed("GET", "/api/groups/room-1")).toBe(false);
    expect(allowed("PUT", "/api/groups/room-1")).toBe(false);
    expect(allowed("PATCH", "/api/bots/bot_123/profile/execution-policy")).toBe(false);
    expect(allowed("PUT", "/api/config")).toBe(false);
    expect(allowed("GET", "/api/attachments/../config.json")).toBe(false);
    expect(allowed("POST", "/api/routine-runs/run_1/cancel")).toBe(false);
    expect(allowed("DELETE", "/api/connectors/slack")).toBe(false);
    expect(allowed("GET", "/api/connectors/connected/all")).toBe(false);
    // listing, authorizing and detaching ONE account are allowed; an account
    // id outside the harness's own charset still is not
    expect(allowed("POST", "/api/connectors/slack/authorize")).toBe(true);
    expect(allowed("DELETE", "/api/connectors/slack/accounts/ca_123")).toBe(true);
    expect(allowed("DELETE", "/api/connectors/slack/accounts/../../config")).toBe(false);
    expect(allowed("POST", "/api/connectors/slack/authorize/extra")).toBe(false);
    expect(allowed("DELETE", "/api/groups/room-1")).toBe(true);
    expect(allowed("DELETE", "/api/groups/room-1/messages")).toBe(false);
    expect(allowed("DELETE", "/api/groups/room-1/extra")).toBe(false);
  });

  // Patterns are anchored, so a path that merely starts right is still a
  // path nobody allowed.
  it("is not fooled by a prefix", () => {
    expect(allowed("GET", "/api/bots/bot_123/computer")).toBe(false);
    expect(allowed("GET", "/api/botsandthensome")).toBe(false);
    expect(allowed("GET", "/api/events/all")).toBe(false);
    expect(allowed("GET", "/api/threads/th_1/messages/msg_2/image/../../../config")).toBe(false);
    expect(allowed("GET", "/api/bots%2f..%2fwebhooks")).toBe(false);
  });

  // The one that matters. Upstream adds routes on its own schedule, and the
  // sidecar must not carry them to a phone because nobody wrote a rule
  // against a thing that did not exist yet.
  it("denies a route it has never heard of", () => {
    for (const path of [
      "/api/whatever-ships-next",
      "/api/bots/bot_123/some-new-verb",
      "/api/secrets",
    ]) {
      expect(allowed("GET", path), path).toBe(false);
      expect(allowed("POST", path), path).toBe(false);
      expect(allowed("DELETE", path), path).toBe(false);
    }
  });
});

describe("room terminology", () => {
  it("lets the phone rename rooms without opening the config route", () => {
    // A display word is not a credential, so it gets its own narrow route.
    expect(allowed("PATCH", "/api/terminology")).toBe(true);
    // The route that carries API keys stays shut in both write methods.
    expect(allowed("PATCH", "/api/config")).toBe(false);
    expect(allowed("PUT", "/api/config")).toBe(false);
    // And the narrow route is one method on one exact path, not a family.
    expect(allowed("POST", "/api/terminology")).toBe(false);
    expect(allowed("GET", "/api/terminology")).toBe(false);
    expect(allowed("PATCH", "/api/terminology/custom")).toBe(false);
  });

  it("still refuses an unpaired device", () => {
    expect(ask("PATCH", "/api/terminology", false)?.status).toBe(401);
  });
});

describe("conversation mode", () => {
  it("lets the phone switch Simple and Projects without opening the config route", () => {
    expect(allowed("PATCH", "/api/conversation-mode")).toBe(true);
    expect(allowed("POST", "/api/conversation-mode")).toBe(false);
    expect(allowed("GET", "/api/conversation-mode")).toBe(false);
    expect(allowed("PATCH", "/api/config")).toBe(false);
  });

  it("still refuses an unpaired device", () => {
    expect(ask("PATCH", "/api/conversation-mode", false)?.status).toBe(401);
  });
});

describe("settings display preferences", () => {
  it("lets the phone change features, channel turn timeout, and profile without opening config", () => {
    expect(allowed("PATCH", "/api/features")).toBe(true);
    expect(allowed("PATCH", "/api/room-turn-timeout")).toBe(true);
    expect(allowed("PATCH", "/api/profile")).toBe(true);
    expect(allowed("PUT", "/api/features")).toBe(false);
    expect(allowed("GET", "/api/profile")).toBe(false);
    expect(allowed("PATCH", "/api/config")).toBe(false);
    expect(allowed("PUT", "/api/config")).toBe(false);
  });

  it("still refuses an unpaired device", () => {
    expect(ask("PATCH", "/api/features", false)?.status).toBe(401);
    expect(ask("PATCH", "/api/room-turn-timeout", false)?.status).toBe(401);
    expect(ask("PATCH", "/api/profile", false)?.status).toBe(401);
  });
});

describe("roster organization", () => {
  it("opens the bot PATCH for the six organize fields and no others", () => {
    expect([...COMPANION_BOT_ORGANIZE_FIELDS].sort()).toEqual(
      ["chiefOfStaff", "hidden", "pinned", "pinnedMessageId", "section", "unread"].sort(),
    );
    expect(companionBotOrganizeDenial({ hidden: true })).toBeNull();
    expect(companionBotOrganizeDenial({ hidden: false })).toBeNull();
    expect(companionBotOrganizeDenial({ pinned: true })).toBeNull();
    expect(companionBotOrganizeDenial({ unread: true })).toBeNull();
    expect(companionBotOrganizeDenial({ chiefOfStaff: false })).toBeNull();
    expect(companionBotOrganizeDenial({ section: "Work" })).toBeNull();
    expect(companionBotOrganizeDenial({ section: null })).toBeNull();
    expect(companionBotOrganizeDenial({ pinnedMessageId: "msg_1-a" })).toBeNull();
    expect(companionBotOrganizeDenial({ pinnedMessageId: null })).toBeNull();
    expect(companionBotOrganizeDenial({ pinnedMessageId: "" })).toBeNull();
    // several at once is fine: the desktop archives and demotes in one save
    expect(companionBotOrganizeDenial({ hidden: true, chiefOfStaff: false })).toBeNull();
  });

  it("refuses every field the bot PATCH reads that is not an organize field", () => {
    // The keys the harness handler reads, plus a name nobody has invented
    // yet.  Each one alone, and each one riding along with a legitimate
    // organize field: the whole request fails either way.
    for (const field of [
      "autoApprove",
      "bypassPermissions",
      "alwaysAllow",
      "autoReview",
      "approvePeerComms",
      "acknowledgeLocalAuto",
      "computers",
      "computer",
      "composio",
      "cloudBackend",
      "autoStartVps",
      "gitWorktreeLeases",
      "cwd",
      "color",
      "mascotExpression",
      "name",
      "title",
      "modelSelection",
      "requireAvailableModel",
      "off",
      "playbooks",
      "futurePrivilege",
    ]) {
      const expected = {
        status: 403,
        error: `${field} can only be changed in BotFleet on your computer`,
      };
      expect(companionBotOrganizeDenial({ [field]: true }), field).toEqual(expected);
      expect(companionBotOrganizeDenial({ pinned: true, [field]: true }), `${field} beside pinned`).toEqual(expected);
    }
  });

  it("checks value types the harness would store as sent", () => {
    for (const field of ["hidden", "pinned", "unread", "chiefOfStaff"]) {
      for (const bad of ["true", 1, 0, null, {}, [], "false"]) {
        expect(companionBotOrganizeDenial({ [field]: bad }), `${field}=${JSON.stringify(bad)}`).toEqual({
          status: 400,
          error: `${field} must be true or false`,
        });
      }
    }
    for (const bad of [1, true, {}, []]) {
      expect(companionBotOrganizeDenial({ section: bad })?.status).toBe(400);
    }
    for (const bad of [1, true, {}, [], "../etc/passwd", "a b", "x/y"]) {
      expect(companionBotOrganizeDenial({ pinnedMessageId: bad })?.status, JSON.stringify(bad)).toBe(400);
    }
    expect(companionBotOrganizeDenial({})).toEqual({ status: 400, error: "nothing to save" });
  });

  it("picks the right body check for each filtered route, and none for the rest", () => {
    expect(companionBodyCheck("PATCH", "/api/bots/b_1/profile")).not.toBeNull();
    expect(companionBodyCheck("PATCH", "/api/bots/b_1")).toBe(companionBotOrganizeDenial);
    expect(companionBodyCheck("DELETE", "/api/bots/b_1")).toBeNull();
    expect(companionBodyCheck("PATCH", "/api/bots/b_1/tasks/t_1")).toBeNull();
    expect(companionBodyCheck("PATCH", "/api/groups/room-1")).toBeNull();
  });

  it("deletes a bot or a room only with the DELETE verb, on the bare resource", () => {
    expect(allowed("DELETE", "/api/bots/bot_123")).toBe(true);
    expect(allowed("DELETE", "/api/groups/room-1")).toBe(true);
    expect(ask("DELETE", "/api/bots/bot_123", false)?.status).toBe(401);
    expect(ask("DELETE", "/api/groups/room-1", false)?.status).toBe(401);
    // an encoded traversal fails to match and is denied
    expect(allowed("DELETE", "/api/bots/..%2Fgroups%2Froom-1")).toBe(false);
    expect(allowed("DELETE", "/api/bots/")).toBe(false);
    expect(allowed("DELETE", "/api/bots")).toBe(false);
    expect(allowed("DELETE", "/api/groups")).toBe(false);
  });

  it("covers Pin Message on a room through the room PATCH it already had", () => {
    expect(allowed("PATCH", "/api/groups/room-1")).toBe(true);
    expect(ask("PATCH", "/api/groups/room-1", false)?.status).toBe(401);
  });
});

describe("model defaults and automatic updates", () => {
  it("lets the phone apply model defaults, and keeps the computer defaults on the Mac", () => {
    expect(allowed("POST", "/api/bots/apply-model-defaults")).toBe(true);
    expect(allowed("GET", "/api/bots/apply-model-defaults")).toBe(false);
    expect(allowed("POST", "/api/bots/apply-model-defaults/extra")).toBe(false);
    expect(ask("POST", "/api/bots/apply-model-defaults", false)?.status).toBe(401);
    // Computer grants for every bot are not a phone decision, and the
    // refusal says so rather than reading as a bug in the companion.
    expect(ask("POST", "/api/bots/apply-defaults")).toEqual({
      status: 403,
      error: "computer defaults for every bot are set on your computer",
    });
  });

  it("opens one narrow route for the automatic update preference, not the config", () => {
    expect(allowed("PATCH", "/api/auto-update")).toBe(true);
    expect(allowed("PUT", "/api/auto-update")).toBe(false);
    expect(allowed("POST", "/api/auto-update")).toBe(false);
    expect(allowed("GET", "/api/auto-update")).toBe(false);
    expect(allowed("PATCH", "/api/auto-update/extra")).toBe(false);
    expect(ask("PATCH", "/api/auto-update", false)?.status).toBe(401);
    // the preference is still readable where it always was, as a boolean
    expect(allowed("GET", "/api/config")).toBe(true);
    expect(allowed("PATCH", "/api/config")).toBe(false);
    expect(allowed("PUT", "/api/config")).toBe(false);
  });
});
