// Which turns get the Zulip tools (server/zulip/mount.ts).
import { describe, expect, it } from "vitest";

import { zulipToolsMounted, type ZulipMountInput } from "./mount.ts";

const base: ZulipMountInput = {
  automationSource: undefined,
  commsDepth: 0,
  maxCommsDepth: 3,
  continuesZulipTurn: false,
  unattended: false,
  outboundReady: true,
};
const mounted = (over: Partial<ZulipMountInput>) => zulipToolsMounted({ ...base, ...over });

describe("the Zulip tool mount", () => {
  it("mounts on a Zulip turn, a continuation of one, and a turn the owner is attending", () => {
    expect(mounted({ automationSource: "zulip", unattended: true })).toBe(true);
    expect(mounted({ continuesZulipTurn: true, unattended: true })).toBe(true);
    expect(mounted({})).toBe(true);
  });

  it("never mounts on a peer's ask_bot turn, even when the bot is not marked unattended", () => {
    // askBotAndWait starts the target with no automation source and the
    // caller's depth plus one; an attended caller leaves no unattended mark.
    expect(mounted({ commsDepth: 1 })).toBe(false);
    expect(mounted({ commsDepth: 2, unattended: true })).toBe(false);
  });

  it("never mounts on a webhook, iMessage, routine or job turn, or on an unattended bot's plain turn", () => {
    for (const automationSource of ["webhook", "imessage", "resource", "schedule", "manual", "job", "delegation"]) {
      expect(mounted({ automationSource })).toBe(false);
    }
    expect(mounted({ unattended: true })).toBe(false);
  });

  it("mounts nothing while the session is down or in a dry run, or at the comms ceiling", () => {
    expect(mounted({ automationSource: "zulip", outboundReady: false })).toBe(false);
    expect(mounted({ outboundReady: false })).toBe(false);
    expect(mounted({ automationSource: "zulip", commsDepth: 3 })).toBe(false);
  });
});
