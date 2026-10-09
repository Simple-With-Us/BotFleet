// Shared fixtures for the launcher-contract tests (server/launch-identity.ts):
// the identity variables a harness started from a seat's shell would hold,
// and one assertion for what an engine child must see instead.

import { readFileSync } from "node:fs";

import { expect } from "vitest";
import { z } from "zod";

/** What a harness launched from a seat's terminal, or from a Claude Code
 *  session, could carry.  Every one of these must be gone from an engine
 *  child, whatever the engine. */
export const INHERITED_IDENTITY_ENV = {
  AGENT_SEAT: "CLAUDE",
  AGENT_TAG: "CLAUDE",
  AGENT_SESSION: "inherited-session",
  AGENT_LAUNCH_SEAT: "BF-INHERITED",
  AGENT_LAUNCHER: "inherited-launcher",
  AGENT_SYNC_ATTACH: "1",
  AGENT_SYNC_STATE_DIR: "/tmp/inherited-state",
  CLAUDE_CODE_SESSION_ID: "inherited-claude-session",
  ZULIP_RC: "/tmp/inherited-rc",
  ZULIP_EMAIL: "inherited-bot@example.invalid",
  ZULIP_API_KEY: "inherited-api-key",
  ZULIP_SITE: "https://inherited.example.invalid",
} as const;

/** Put the inherited identity on the test process and return the restore. */
export function inheritHarnessIdentity(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(INHERITED_IDENTITY_ENV)) {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/** Assert an engine child's environment is the one the launcher contract
 *  gives a bot: this seat (or none) and this session, marked as launched,
 *  with no inherited identity and no Zulip variable of any kind. */
export function expectLaunchedAs(
  env: Record<string, string | undefined>,
  expected: { seat: string | null; session?: string },
): void {
  expect(env.AGENT_LAUNCHER).toBe("botfleet");
  expect(env.AGENT_SYNC_ATTACH).toBe("0");
  if (expected.seat) {
    expect(env.AGENT_LAUNCH_SEAT).toBe(expected.seat);
    expect(env.AGENT_SEAT).toBe(expected.seat);
  } else {
    expect(env.AGENT_LAUNCH_SEAT).toBeUndefined();
    expect(env.AGENT_SEAT).toBeUndefined();
  }
  expect(env.AGENT_SESSION).toBe(expected.session);
  expect(env.AGENT_TAG).toBeUndefined();
  expect(env.AGENT_SYNC_STATE_DIR).toBeUndefined();
  expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  expect(Object.keys(env).filter((name) => name.toUpperCase().startsWith("ZULIP_"))).toEqual([]);
  expect(JSON.stringify(env)).not.toContain("inherited");
}

const envSchema = z.record(z.string(), z.string().optional());
const dumpSchema = z.object({ pid: z.number().optional(), argv: z.array(z.string()).default([]), env: envSchema });

/** An environment printed as JSON by a test child. */
export const parseEnv = (text: string) => envSchema.parse(JSON.parse(text));

/** A fake engine's dump of the process it ran as:  `{argv, env}`, plus `{pid}`
 *  from the Claude fake.  The fakes write it themselves, in the test's own
 *  scratch folder. */
export const readEngineDump = (path: string) => dumpSchema.parse(JSON.parse(readFileSync(path, "utf8")));
