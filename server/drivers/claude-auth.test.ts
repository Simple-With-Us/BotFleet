// Where "is Claude signed in?" is answered. These tests inject the CLI
// runner, so they never read or mutate the developer's real credentials.
import { describe, expect, it } from "vitest";

import {
  CLAUDE_AUTH_TIMEOUT_MS,
  CLAUDE_RENEW_ARGS,
  claudeSignedIn,
  parseClaudeRenewalSuccess,
  resetClaudeRenewalThrottleForTesting,
} from "./claude.ts";

describe("claudeSignedIn", () => {
  it("uses the CLI's machine-readable auth status, with the same budget as --version", async () => {
    const run = ((cli, args, options, callback) => {
      expect(cli).toBe("claude-custom");
      expect(args).toEqual(["auth", "status", "--json"]);
      expect(options).toMatchObject({ timeout: 20000, env: { PATH: "/custom/bin" } });
      callback(null, '{"loggedIn":true}');
    }) satisfies typeof import("../procs.ts").execCli;

    expect(CLAUDE_AUTH_TIMEOUT_MS).toBe(20000);
    expect(await claudeSignedIn("claude-custom", { PATH: "/custom/bin" }, run)).toBe(true);
  });

  it("uses loggedIn:false even though the real CLI exits with code 1", async () => {
    resetClaudeRenewalThrottleForTesting();
    const run = ((_cli, args, _options, callback) => {
      if (args[0] === "-p") {
        callback(new Error("exit code 1"), "Failed to authenticate: OAuth session expired");
        return;
      }
      callback(new Error("exit code 1"), '{"loggedIn":false,"authMethod":"none"}');
    }) satisfies typeof import("../procs.ts").execCli;

    expect(await claudeSignedIn("claude", {}, run)).toBe(false);
  });

  it("renews idle 8h access token via /usage when auth status returns loggedIn:false", async () => {
    resetClaudeRenewalThrottleForTesting();
    const calls: string[][] = [];
    const run = ((_cli, args, _options, callback) => {
      calls.push(args);
      if (args[0] === "auth") {
        if (calls.filter((c) => c[0] === "auth").length === 1) {
          // First auth status check: access token expired while idle
          callback(new Error("exit code 1"), '{"loggedIn":false,"authMethod":"none"}');
        } else {
          // Second check after renewal: now active
          callback(null, '{"loggedIn":true,"authMethod":"claudeai"}');
        }
        return;
      }
      if (args[0] === "-p") {
        expect(args).toEqual([...CLAUDE_RENEW_ARGS]);
        callback(null, '{"is_error":false,"subtype":"success","result":"Total cost: $0.00"}');
        return;
      }
      callback(new Error("unexpected args"), "");
    }) satisfies typeof import("../procs.ts").execCli;

    const result = await claudeSignedIn("claude", {}, run);
    expect(result).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(["auth", "status", "--json"]);
    expect(calls[1]).toEqual([...CLAUDE_RENEW_ARGS]);
    expect(calls[2]).toEqual(["auth", "status", "--json"]);
  });

  it("parses renewal success from /usage JSON", () => {
    expect(parseClaudeRenewalSuccess('{"is_error":false,"result":"Total cost: $0.00"}')).toBe(true);
    expect(parseClaudeRenewalSuccess('{"is_error":true,"result":"Failed"}')).toBe(false);
    expect(parseClaudeRenewalSuccess("not json")).toBe(false);
    expect(parseClaudeRenewalSuccess(undefined)).toBe(false);
  });

  it("cooldown stops repeated renewal storms after a failed attempt", async () => {
    resetClaudeRenewalThrottleForTesting();
    let renewalSpawns = 0;
    const run = ((_cli, args, _options, callback) => {
      if (args[0] === "-p") {
        renewalSpawns++;
        callback(new Error("exit code 1"), "Failed to authenticate");
        return;
      }
      callback(new Error("exit code 1"), '{"loggedIn":false,"authMethod":"none"}');
    }) satisfies typeof import("../procs.ts").execCli;

    expect(await claudeSignedIn("claude", {}, run)).toBe(false);
    expect(renewalSpawns).toBe(1);

    // Immediate second check within 10m cooldown: renewal not re-attempted
    expect(await claudeSignedIn("claude", {}, run)).toBe(false);
    expect(renewalSpawns).toBe(1);
  });

  it("trusts parsed JSON over a timeout flag: an answer is an answer", async () => {
    const run = ((_cli, _args, _options, callback) => {
      callback(Object.assign(new Error("killed"), { killed: true, timedOut: true }), '{"loggedIn":true}');
    }) satisfies typeof import("../procs.ts").execCli;

    expect(await claudeSignedIn("claude", {}, run)).toBe(true);
  });

  it("fails closed when the CLI answers quickly without a valid status", async () => {
    // An older CLI with no `auth` subcommand exits fast with stderr only;
    // malformed output is an answer too.  Neither is a timeout.
    const failed = ((_cli, _args, _options, callback) => {
      callback(new Error("auth status unavailable"), "");
    }) satisfies typeof import("../procs.ts").execCli;
    const malformed = ((_cli, _args, _options, callback) => {
      callback(null, "not json");
    }) satisfies typeof import("../procs.ts").execCli;

    expect(await claudeSignedIn("claude", {}, failed)).toBe(false);
    expect(await claudeSignedIn("claude", {}, malformed)).toBe(false);
  });

  it("reports unknown, not signed out, when the probe ran out of time", async () => {
    // execCli's soft deadline: the child is killed, stdout is empty.
    const killed = ((_cli, _args, _options, callback) => {
      callback(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", timedOut: true }), "");
    }) satisfies typeof import("../procs.ts").execCli;
    // execCli's hard deadline: a plain Error naming the budget.
    const hard = ((_cli, _args, _options, callback) => {
      callback(new Error("`claude` did not exit within 20000ms"), "");
    }) satisfies typeof import("../procs.ts").execCli;

    expect(await claudeSignedIn("claude", {}, killed)).toBeUndefined();
    expect(await claudeSignedIn("claude", {}, hard)).toBeUndefined();
  });

  it("reports unknown when empty output arrives only after the whole budget ran out", async () => {
    // What an event-loop stall used to produce: no error flag at all, empty
    // stdout, but the deadline had passed.
    const late = ((_cli, _args, _options, callback) => {
      setTimeout(() => callback(null, ""), 30);
    }) satisfies typeof import("../procs.ts").execCli;

    expect(await claudeSignedIn("claude", {}, late, 20)).toBeUndefined();
  });
});
