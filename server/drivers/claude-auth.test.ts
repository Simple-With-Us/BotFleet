// Where "is Claude signed in?" is answered. These tests inject the CLI
// runner, so they never read or mutate the developer's real credentials.
import { describe, expect, it } from "vitest";

import { CLAUDE_AUTH_TIMEOUT_MS, claudeSignedIn } from "./claude.ts";

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
    const run = ((_cli, _args, _options, callback) => {
      callback(new Error("exit code 1"), '{"loggedIn":false,"authMethod":"none"}');
    }) satisfies typeof import("../procs.ts").execCli;

    expect(await claudeSignedIn("claude", {}, run)).toBe(false);
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
