/// <reference types="vitest/config" />
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyLaunchIdentity,
  BOTFLEET_ROLES,
  codexShellPolicyArgs,
  fleetSeatPromptsEnabled,
  isLaunchIdentityName,
  launchEnvironment,
  launchIdentityFor,
  resolveBotfleetRole,
} from "./launch-identity.ts";
import { zulipTag } from "./zulip/format.ts";

describe("the ten role seats", () => {
  it("names exactly the ten BotFleet roles, each with an upper-case BF seat", () => {
    expect(BOTFLEET_ROLES.map((role) => role.seat)).toEqual([
      "BF-BUILDER",
      "BF-COMPILER",
      "BF-DEPLOYER",
      "BF-DESIGNER",
      "BF-FIXER",
      "BF-HOUSEKEEPER",
      "BF-MONITOR",
      "BF-ORACLE",
      "BF-PLUMBER",
      "BF-PUBLISHER",
    ]);
    for (const role of BOTFLEET_ROLES) {
      expect(role.seat).toBe(`BF-${role.id.toUpperCase()}`);
      expect(role.name.toLowerCase()).toBe(role.id);
    }
  });

  it("agrees with the tag the native Zulip posts carry", () => {
    // One rule for the casing: the seat in the environment and the tag on a post.
    for (const role of BOTFLEET_ROLES) {
      expect(zulipTag(`BF-${role.name}`)).toBe(`[${role.seat}]`);
    }
  });
});

describe("resolveBotfleetRole", () => {
  it("takes the role from the description, a BF- name, or a bare role name, in that order", () => {
    expect(resolveBotfleetRole({ name: "Anything", description: "Watches CI.  @fleet-seat: monitor" })?.seat).toBe("BF-MONITOR");
    expect(resolveBotfleetRole({ name: "Anything", description: "@fleet-seat: BF-Publisher" })?.seat).toBe("BF-PUBLISHER");
    expect(resolveBotfleetRole({ name: "BF-Compiler" })?.seat).toBe("BF-COMPILER");
    expect(resolveBotfleetRole({ name: "bf compiler" })?.seat).toBe("BF-COMPILER");
    expect(resolveBotfleetRole({ name: "BF_Designer" })?.seat).toBe("BF-DESIGNER");
    expect(resolveBotfleetRole({ name: "Plumber" })?.seat).toBe("BF-PLUMBER");
    expect(resolveBotfleetRole({ name: "  oracle  " })?.seat).toBe("BF-ORACLE");
    // A description that names no known role falls through to the name.
    expect(resolveBotfleetRole({ name: "Builder", description: "@fleet-seat: nobody" })?.seat).toBe("BF-BUILDER");
    // A description wins over a conflicting name.
    expect(resolveBotfleetRole({ name: "Builder", description: "@fleet-seat: fixer" })?.seat).toBe("BF-FIXER");
  });

  it("resolves all ten roles by their bare names", () => {
    for (const role of BOTFLEET_ROLES) {
      expect(resolveBotfleetRole({ name: role.name })?.seat, role.name).toBe(role.seat);
    }
  });

  it("gives a bot that names no role no seat", () => {
    for (const name of ["Kiwi", "Plumber 2", "The Plumber", "BF-Director", "Director", "BF-Claude", "Claude", "Codex", "", "BF-"]) {
      expect(resolveBotfleetRole({ name }), name).toBeNull();
    }
    expect(resolveBotfleetRole({ name: "Kiwi", description: "@fleet-seat: claude" })).toBeNull();
    expect(resolveBotfleetRole({ name: "Kiwi", description: null })).toBeNull();
  });
});

describe("launchIdentityFor", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.BOTFLEET_FLEET_SEAT_PROMPTS;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BOTFLEET_FLEET_SEAT_PROMPTS;
    else process.env.BOTFLEET_FLEET_SEAT_PROMPTS = saved;
  });

  it("assigns the role seat, and the thread as the session, when the operator fleet is on", () => {
    process.env.BOTFLEET_FLEET_SEAT_PROMPTS = "1";
    expect(fleetSeatPromptsEnabled()).toBe(true);
    expect(launchIdentityFor({ name: "Plumber" }, "thread-1")).toEqual({ seat: "BF-PLUMBER", session: "thread-1" });
    expect(launchIdentityFor({ name: "Kiwi" }, "thread-2")).toEqual({ seat: null, session: "thread-2" });
  });

  it("assigns no seat when the operator fleet is off, so the seat and the prompt line switch together", () => {
    delete process.env.BOTFLEET_FLEET_SEAT_PROMPTS;
    expect(fleetSeatPromptsEnabled()).toBe(false);
    expect(launchIdentityFor({ name: "Plumber" }, "thread-1")).toEqual({ seat: null, session: "thread-1" });
  });
});

describe("launchEnvironment", () => {
  it("carries the launcher contract for a bot with a seat", () => {
    expect(launchEnvironment({ seat: "BF-PLUMBER", session: "abc-123" })).toEqual({
      AGENT_LAUNCHER: "botfleet",
      AGENT_SYNC_ATTACH: "0",
      AGENT_LAUNCH_SEAT: "BF-PLUMBER",
      AGENT_SEAT: "BF-PLUMBER",
      AGENT_SESSION: "abc-123",
    });
  });

  it("carries the launcher and no seat for a bot with no role, and for no identity at all", () => {
    expect(launchEnvironment({ seat: null, session: "abc-123" })).toEqual({
      AGENT_LAUNCHER: "botfleet",
      AGENT_SYNC_ATTACH: "0",
      AGENT_SESSION: "abc-123",
    });
    expect(launchEnvironment(undefined)).toEqual({ AGENT_LAUNCHER: "botfleet", AGENT_SYNC_ATTACH: "0" });
  });

  it("never carries a Zulip variable: BF bots post natively", () => {
    for (const identity of [{ seat: "BF-FIXER", session: "s" }, { seat: null, session: "s" }, undefined]) {
      expect(Object.keys(launchEnvironment(identity)).filter((name) => name.startsWith("ZULIP_"))).toEqual([]);
    }
  });
});

describe("applyLaunchIdentity", () => {
  const harness = {
    PATH: "/usr/bin",
    HOME: "/home/test",
    OMB_ZULIP_REALM: "https://realm.example.invalid",
    AGENT_SEAT: "CLAUDE",
    AGENT_TAG: "CLAUDE",
    AGENT_SESSION: "old-session",
    AGENT_LAUNCH_SEAT: "BF-OLD",
    AGENT_LAUNCHER: "someone-else",
    AGENT_SYNC_ATTACH: "1",
    AGENT_SYNC_STATE_DIR: "/tmp/state",
    CLAUDE_CODE_SESSION_ID: "claude-session",
    ZULIP_RC: "/tmp/rc",
    ZULIP_EMAIL: "bot@example.invalid",
    ZULIP_API_KEY: "a-key",
    ZULIP_SITE: "https://realm.example.invalid",
    zulip_rc: "/tmp/lower-case-name",
    UNDEFINED_ONE: undefined,
  };

  it("removes every inherited identity and Zulip variable, then sets this turn's", () => {
    const out = applyLaunchIdentity(harness, { seat: "BF-ORACLE", session: "thread-9" });
    expect(out).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/test",
      OMB_ZULIP_REALM: "https://realm.example.invalid",
      UNDEFINED_ONE: undefined,
      AGENT_LAUNCHER: "botfleet",
      AGENT_SYNC_ATTACH: "0",
      AGENT_LAUNCH_SEAT: "BF-ORACLE",
      AGENT_SEAT: "BF-ORACLE",
      AGENT_SESSION: "thread-9",
    });
  });

  it("leaves a bot with no role with no seat, not the harness's", () => {
    const out = applyLaunchIdentity(harness, { seat: null, session: "thread-9" });
    expect(out.AGENT_LAUNCHER).toBe("botfleet");
    expect("AGENT_SEAT" in out).toBe(false);
    expect("AGENT_LAUNCH_SEAT" in out).toBe(false);
    expect("AGENT_TAG" in out).toBe(false);
    expect(out.AGENT_SESSION).toBe("thread-9");
  });

  it("does not mutate the environment it was given, which an engine instance shares across turns", () => {
    const shared = { ...harness };
    const first = applyLaunchIdentity(shared, { seat: "BF-ORACLE", session: "a" });
    const second = applyLaunchIdentity(shared, { seat: "BF-FIXER", session: "b" });
    expect(shared).toEqual(harness);
    expect(first.AGENT_LAUNCH_SEAT).toBe("BF-ORACLE");
    expect(second.AGENT_LAUNCH_SEAT).toBe("BF-FIXER");
    expect(first).not.toBe(second);
  });

  it("recognizes the names it scrubs, in any case, and nothing else", () => {
    for (const name of ["AGENT_SEAT", "agent_tag", "AGENT_SESSION", "AGENT_LAUNCH_SEAT", "AGENT_LAUNCHER", "AGENT_SYNC_HOME", "CLAUDE_CODE_SESSION_ID", "ZULIP_RC", "Zulip_Email", "ZULIP_API_KEY", "ZULIP_SITE"]) {
      expect(isLaunchIdentityName(name), name).toBe(true);
    }
    for (const name of ["PATH", "HOME", "OMB_ZULIP", "OMB_ZULIP_DISABLE", "AGENT", "AGENTS_MD", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_ENTRYPOINT"]) {
      expect(isLaunchIdentityName(name), name).toBe(false);
    }
  });
});

describe("codexShellPolicyArgs", () => {
  it("sets the launch variables in the policy Codex runs the model's shell under, values quoted", () => {
    expect(codexShellPolicyArgs({ seat: "BF-PLUMBER", session: "thread-1" })).toEqual([
      "-c", 'shell_environment_policy.set.AGENT_LAUNCHER="botfleet"',
      "-c", 'shell_environment_policy.set.AGENT_SYNC_ATTACH="0"',
      "-c", 'shell_environment_policy.set.AGENT_LAUNCH_SEAT="BF-PLUMBER"',
      "-c", 'shell_environment_policy.set.AGENT_SEAT="BF-PLUMBER"',
      "-c", 'shell_environment_policy.set.AGENT_SESSION="thread-1"',
    ]);
  });

  it("sets the launcher alone for a bot with no role", () => {
    const args = codexShellPolicyArgs({ seat: null, session: "thread-1" }).filter((arg) => arg !== "-c");
    expect(args.some((arg) => arg.includes("AGENT_SEAT") || arg.includes("AGENT_LAUNCH_SEAT"))).toBe(false);
    expect(args).toContain('shell_environment_policy.set.AGENT_LAUNCHER="botfleet"');
  });
});
