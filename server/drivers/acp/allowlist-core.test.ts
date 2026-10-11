// The routine command allowlist, end to end through the ACP driver core:  a
// scripted engine (server/testing/fake-acp-allowlist-cli.ts) that behaves the
// way Grok Build was observed to, against the real AllowlistGate, real child
// processes and a real file system in a throwaway directory.
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { sanitizeToolPolicy, type ToolPolicy } from "../../tool-policy.ts";
import { GrokAgentDriver, grokAllowlistProblem } from "./grok.ts";
import { McodeAgentDriver } from "./mcode.ts";

/** The event, narrowed to turn.completed by its discriminant. */
function asCompleted(event: RuntimeEvent): Extract<RuntimeEvent, { type: "turn.completed" }> {
  if (event.type !== "turn.completed") throw new Error(`expected turn.completed, saw ${event.type}`);
  return event;
}

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-allowlist-cli.ts");

let scratch: string;
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
/** A stand-in for agent-sync:  prints its argv and the seat it was launched as,
 *  and leaves a marker so a test can prove it ran. */
let tool: string;
let dmFile: string;

function allowlist(): ToolPolicy {
  return sanitizeToolPolicy({
    mode: "allowlist",
    commands: [
      { argv0: tool, sub: ["whoami"], flags: { "--json": { value: "none" } } },
      { argv0: tool, sub: ["post"], flags: { "--topic": { value: "text", required: true } } },
      { argv0: "/bin/pwd", sub: [] },
      { argv0: "/bin/cat", sub: [], args: [{ value: "path", paths: [join(scratch, "logs", "app.log")] }] },
    ],
    writePaths: [dmFile, join(scratch, "state", "nested", "deep.md")],
  })!;
}

async function grok(fullAuto = true): Promise<ProviderInstance> {
  instance = await GrokAgentDriver.create({
    instanceId: "grok-allowlist",
    displayName: "Grok",
    environment: { HOME: scratch, GROK_HOME: join(scratch, ".grok") },
    enabled: true,
    config: { cli: FAKE, fullAuto },
  });
  recorder = recordEvents(instance.adapter);
  return instance;
}

function dump(name: string): any {
  return JSON.parse(readFileSync(join(scratch, name), "utf8"));
}

interface FakeStep {
  type: string;
  command?: string;
  args?: string[];
  cwd?: string;
  path?: string;
  content?: string;
  name?: string;
  kind?: string;
  rawInput?: Record<string, string>;
  options?: Array<{ optionId: string; kind: string }>;
}

/** `policy`: omitted runs the test allowlist;  null runs an ordinary turn. */
async function runTurn(steps: FakeStep[], opts: { policy?: ToolPolicy | null; dumpName?: string; threadId?: string } = {}) {
  const dumpName = opts.dumpName ?? "dump.json";
  process.env.FAKE_AL_STEPS = JSON.stringify(steps);
  process.env.FAKE_AL_DUMP = join(scratch, dumpName);
  const threadId = opts.threadId ?? `t-${Math.random().toString(36).slice(2)}`;
  await instance!.adapter.sendTurn({
    threadId,
    text: "run the routine",
    cwd: scratch,
    launchIdentity: { seat: "BF-HOUSEKEEPER", session: threadId },
    integrations: { composio: { command: "/composio", args: [], env: {} } },
    toolPolicy: opts.policy === undefined ? allowlist() : (opts.policy ?? undefined),
  });
  const done = asCompleted(await recorder!.until((e) => e.type === "turn.completed" && e.threadId === threadId, 20_000));
  return { done, dump: existsSync(join(scratch, dumpName)) ? dump(dumpName) : null, threadId };
}

beforeAll(() => {
  chmodSync(FAKE, 0o755);
});

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "omb-allowlist-"));
  mkdirSync(join(scratch, ".grok"), { recursive: true });
  writeFileSync(join(scratch, ".grok", "auth.json"), "{}");
  tool = join(scratch, "fake-agent-sync");
  writeFileSync(tool, `#!/bin/sh\necho "ran:$*:seat=$AGENT_LAUNCH_SEAT"\ntouch "${join(scratch, "TOOL-RAN")}"\n`);
  chmodSync(tool, 0o755);
  dmFile = join(scratch, "state", "dm.md");
});

afterEach(async () => {
  recorder?.stop();
  await instance?.adapter.stopAll();
  instance = undefined;
  recorder = undefined;
  delete process.env.FAKE_AL_STEPS;
  delete process.env.FAKE_AL_DUMP;
  delete process.env.FAKE_AL_NO_HOOKS;
  removeTempDir(scratch);
});

// The turns below run a real fake agent-sync CLI:  a `#!/bin/sh` script, POSIX argv0 paths, and
// `/bin/cat` and `/bin/pwd`, which `isCleanAbsolutePath` rightly refuses on Windows, where mkdtemp
// hands back `C:\Users\...\fake-agent-sync`.  The suite is POSIX-only;  `grokAllowlistProblem` below
// is pure logic and runs everywhere.
const posix = describe.skipIf(process.platform === "win32");

posix("an allowlist turn on Grok", () => {
  it("spawns in an asking mode, offers a terminal and files, registers the hook, and mounts no MCP", async () => {
    await grok(true);
    const { done, dump: seen } = await runTurn([]);
    expect(done.ok).toBe(true);
    expect(seen.argv).not.toContain("bypassPermissions");
    expect(seen.argv.slice(0, 2)).toEqual(["--permission-mode", "default"]);
    expect(seen.argv).toEqual(expect.arrayContaining(["--disable-web-search", "--no-subagents", "--no-leader"]));
    expect(seen.clientCapabilities).toEqual({ fs: { readTextFile: true, writeTextFile: true }, terminal: true });
    expect(seen.sessionMeta).toEqual({ "x.ai/hooks": { pre_tool_use: [{ hookCallbackIds: ["botfleet-allowlist"] }] } });
    expect(seen.mcpServers).toEqual([]);
  });

  it("runs an allowed command itself, with no shell, as the bot's seat", async () => {
    await grok();
    const { done, dump: seen } = await runTurn([{ type: "shell", command: `${tool} whoami --json` }]);
    expect(done.ok).toBe(true);
    expect(seen.results[0]).toMatchObject({ hook: "allow", exit: { exitCode: 0 } });
    expect(seen.results[0].output).toBe("ran:whoami --json:seat=BF-HOUSEKEEPER\n");
    expect(done.denials).toBeUndefined();
  });

  it("keeps a quoted topic with spaces as one argument", async () => {
    await grok();
    const { dump: seen } = await runTurn([{ type: "shell", command: `${tool} post --topic "AFC 29c02bcb fleet-work-backup"` }]);
    expect(seen.results[0].output).toBe("ran:post --topic AFC 29c02bcb fleet-work-backup:seat=BF-HOUSEKEEPER\n");
  });

  it("denies `whoami; touch PWNED`, a bare touch, gh, and an unlisted program, and nothing runs", async () => {
    await grok();
    const pwned = join(scratch, "PWNED");
    const { done, dump: seen } = await runTurn([
      { type: "shell", command: `${tool} whoami --json; touch ${pwned}` },
      { type: "shell", command: "touch PWNED" },
      { type: "shell", command: "gh --version" },
      { type: "shell", command: `/usr/bin/touch ${pwned}` },
      { type: "shell", command: `${tool} whoami --json $(touch ${pwned})` },
    ]);
    expect(seen.results.map((r: any) => r.hook)).toEqual(["deny", "deny", "deny", "deny", "deny"]);
    expect(existsSync(pwned)).toBe(false);
    expect(existsSync(join(scratch, "PWNED"))).toBe(false);
    expect(existsSync(join(scratch, "TOOL-RAN"))).toBe(false);
    expect(done.denials).toEqual([
      "allowlist: fake-agent-sync",
      "allowlist: touch",
      "allowlist: gh",
      "allowlist: touch",
      "allowlist: fake-agent-sync",
    ]);
  });

  it("checks the terminal call itself, so a hook that let something through still runs nothing", async () => {
    await grok();
    const pwned = join(scratch, "PWNED");
    const { dump: seen } = await runTurn([
      { type: "raw-terminal", command: `/bin/bash -lc '${tool} whoami --json; touch ${pwned}'` },
      { type: "raw-terminal", command: "/bin/sh", args: ["-c", `touch ${pwned}`] },
      { type: "raw-terminal", command: `/bin/bash -lc "$(touch ${pwned})"` },
      { type: "raw-terminal", command: `/bin/bash -i -c '${tool} whoami --json'` },
      { type: "raw-terminal", command: `/bin/bash -lc '${tool} whoami --json'` },
    ]);
    expect(seen.results.map((r: any) => r.terminal)).toEqual(["refused", "refused", "refused", "refused", "ran"]);
    expect(existsSync(pwned)).toBe(false);
  });

  it("denies every MCP tool, Composio included, and a hook call it did not register", async () => {
    await grok();
    const { dump: seen } = await runTurn([
      { type: "mcp", name: "COMPOSIO_SEARCH_TOOLS" },
      { type: "mcp", name: "recall_stats" },
      { type: "mcp", name: "spawn_subagent" },
      { type: "hook-foreign" },
      // reading back a backgrounded allowed command's output stays allowed
      { type: "mcp", name: "get_command_or_subagent_output" },
    ]);
    expect(seen.results.map((r: any) => r.hook)).toEqual(["deny", "deny", "deny", "deny", "allow"]);
  });

  it("writes exactly the listed file, owner-only, and refuses any other", async () => {
    await grok();
    const elsewhere = join(scratch, "state", "other.md");
    const { dump: seen } = await runTurn([
      { type: "write", path: dmFile, content: "hello owner" },
      { type: "write", path: elsewhere, content: "nope" },
      { type: "raw-write", path: join(scratch, ".zshrc"), content: "nope" },
      { type: "read", path: dmFile },
      { type: "read", path: join(scratch, ".grok", "auth.json") },
    ]);
    expect(seen.results.map((r: any) => r.write ?? r.read ?? r.hook)).toEqual(["ok", "deny", "refused", "hello owner", "deny"]);
    expect(readFileSync(dmFile, "utf8")).toBe("hello owner");
    expect(statSync(dmFile).mode & 0o777).toBe(0o600);
    expect(existsSync(elsewhere)).toBe(false);
    expect(existsSync(join(scratch, ".zshrc"))).toBe(false);
  });

  it("runs every allowed command in the turn's own directory, whatever cwd the engine asks for", async () => {
    await grok();
    const { dump: seen } = await runTurn([{ type: "raw-terminal", command: "/bin/bash -lc '/bin/pwd'", cwd: "/" }]);
    expect(seen.results[0].terminal).toBe("ran");
    expect(realpathSync(seen.results[0].output.trim())).toBe(realpathSync(scratch));
  });

  it("refuses a write whose parent directory is a link into a credential or dot directory", async () => {
    await grok();
    const hidden = join(scratch, ".ssh");
    mkdirSync(hidden);
    symlinkSync(hidden, join(scratch, "state"));
    const { dump: seen } = await runTurn([{ type: "raw-write", path: dmFile, content: "ssh-ed25519 AAAA attacker" }]);
    expect(seen.results[0].write).toBe("refused");
    expect(existsSync(join(hidden, "dm.md"))).toBe(false);
  });

  it("refuses a command whose path word a link carries into a credential directory", async () => {
    await grok();
    const secrets = join(scratch, ".secrets");
    mkdirSync(secrets);
    writeFileSync(join(secrets, "app.log"), "SECRET-VALUE\n");
    symlinkSync(secrets, join(scratch, "logs"));
    const log = join(scratch, "logs", "app.log");
    const { dump: seen } = await runTurn([
      { type: "shell", command: `/bin/cat ${log}` },
      { type: "raw-terminal", command: `/bin/bash -lc '/bin/cat ${log}'` },
    ]);
    expect(seen.results[0].hook).toBe("deny");
    expect(seen.results[1].terminal).toBe("refused");
    expect(JSON.stringify(seen.results)).not.toContain("SECRET-VALUE");
  });

  it("runs the same command when the path word is a real file", async () => {
    await grok();
    mkdirSync(join(scratch, "logs"));
    writeFileSync(join(scratch, "logs", "app.log"), "backup ok\n");
    const { dump: seen } = await runTurn([{ type: "shell", command: `/bin/cat ${join(scratch, "logs", "app.log")}` }]);
    expect(seen.results[0]).toMatchObject({ hook: "allow", output: "backup ok\n" });
  });

  it("creates no directory under a link into a protected place before refusing the write", async () => {
    await grok();
    const hidden = join(scratch, ".ssh");
    mkdirSync(hidden);
    symlinkSync(hidden, join(scratch, "state"));
    const { dump: seen } = await runTurn([{ type: "raw-write", path: join(scratch, "state", "nested", "deep.md"), content: "x" }]);
    expect(seen.results[0].write).toBe("refused");
    expect(existsSync(join(hidden, "nested"))).toBe(false);
  });

  it("refuses to write through a link planted at the listed path", async () => {
    await grok();
    mkdirSync(dirname(dmFile), { recursive: true });
    const target = join(scratch, "victim.txt");
    writeFileSync(target, "original");
    symlinkSync(target, dmFile);
    const { dump: seen } = await runTurn([{ type: "raw-write", path: dmFile, content: "overwritten" }]);
    expect(seen.results[0].write).toBe("refused");
    expect(readFileSync(target, "utf8")).toBe("original");
  });

  it("refuses a path that names a protected place, even in a policy that skipped validation", async () => {
    await grok();
    const secretsDir = join(scratch, ".secrets");
    mkdirSync(secretsDir);
    const secret = join(secretsDir, "token");
    writeFileSync(secret, "SECRET-VALUE\n");
    // sanitizeToolPolicy refuses every one of these paths, so build the policy by hand:  the run-time
    // checks must hold on their own for a policy that reached the driver some other way.
    const unchecked: ToolPolicy = {
      mode: "allowlist",
      commands: [{ argv0: "/bin/cat", sub: [], flags: {}, args: [{ value: "path", paths: [secret] }], positionals: 0 }],
      writePaths: [join(secretsDir, "planted")],
      readPaths: [secret],
    };
    expect(() => sanitizeToolPolicy(unchecked)).toThrow(/Command allowlist/);
    const { dump: seen } = await runTurn(
      [
        { type: "shell", command: `/bin/cat ${secret}` },
        { type: "raw-terminal", command: `/bin/bash -lc '/bin/cat ${secret}'` },
        { type: "read", path: secret },
        { type: "raw-read", path: secret },
        { type: "write", path: join(secretsDir, "planted"), content: "x" },
        { type: "raw-write", path: join(secretsDir, "planted"), content: "x" },
      ],
      { policy: unchecked },
    );
    expect(seen.results.map((r: any) => r.terminal ?? r.write ?? r.read ?? r.hook)).toEqual([
      "deny",
      "refused",
      "deny",
      "refused",
      "deny",
      "refused",
    ]);
    expect(JSON.stringify(seen.results)).not.toContain("SECRET-VALUE");
    expect(existsSync(join(secretsDir, "planted"))).toBe(false);
  });

  it("refuses a read whose parent directory is a link into a credential directory", async () => {
    await grok();
    const secretsDir = join(scratch, ".secrets");
    mkdirSync(secretsDir);
    writeFileSync(join(secretsDir, "dm.md"), "SECRET-VALUE\n");
    symlinkSync(secretsDir, join(scratch, "state"));
    const { dump: seen } = await runTurn([
      { type: "read", path: dmFile },
      { type: "raw-read", path: dmFile },
    ]);
    expect(seen.results.map((r: any) => r.read ?? r.hook)).toEqual(["deny", "refused"]);
    expect(JSON.stringify(seen.results)).not.toContain("SECRET-VALUE");
  });

  it("refuses a path that runs through a dangling link, and creates nothing", async () => {
    await grok();
    // Both links point at protected places that do not exist yet:  where the path lands is unknown,
    // so it is refused rather than treated as an ordinary missing directory.
    symlinkSync(join(scratch, ".ssh"), join(scratch, "state"));
    symlinkSync(join(scratch, ".secrets"), join(scratch, "logs"));
    const { dump: seen } = await runTurn([
      { type: "write", path: join(scratch, "state", "nested", "deep.md"), content: "x" },
      { type: "raw-write", path: join(scratch, "state", "nested", "deep.md"), content: "x" },
      { type: "raw-write", path: dmFile, content: "x" },
      { type: "shell", command: `/bin/cat ${join(scratch, "logs", "app.log")}` },
      { type: "raw-terminal", command: `/bin/bash -lc '/bin/cat ${join(scratch, "logs", "app.log")}'` },
    ]);
    expect(seen.results.map((r: any) => r.terminal ?? r.write ?? r.hook)).toEqual(["deny", "refused", "refused", "deny", "refused"]);
    expect(existsSync(join(scratch, ".ssh"))).toBe(false);
    expect(existsSync(join(scratch, ".secrets"))).toBe(false);
  });

  it("follows no link it does not own, even one into an ordinary directory", async () => {
    await grok();
    // A link any user-level process could plant (a routine's own command, a checked-out repository)
    // turns the exact file the policy names into some other file.  Only links root owns are followed,
    // which the throwaway directory itself shows on macOS:  tmpdir() is under /var, root's link to
    // /private/var, and every allowed path below still works.
    const elsewhere = join(scratch, "documents");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "app.log"), "OTHER-FILE\n");
    symlinkSync(elsewhere, join(scratch, "state"));
    symlinkSync(elsewhere, join(scratch, "logs"));
    const { dump: seen } = await runTurn([
      { type: "write", path: dmFile, content: "overwritten" },
      { type: "raw-write", path: dmFile, content: "overwritten" },
      { type: "read", path: dmFile },
      { type: "raw-read", path: dmFile },
      { type: "shell", command: `/bin/cat ${join(scratch, "logs", "app.log")}` },
      { type: "raw-terminal", command: `/bin/bash -lc '/bin/cat ${join(scratch, "logs", "app.log")}'` },
    ]);
    expect(seen.results.map((r: any) => r.terminal ?? r.write ?? r.read ?? r.hook)).toEqual([
      "deny",
      "refused",
      "deny",
      "refused",
      "deny",
      "refused",
    ]);
    expect(existsSync(join(elsewhere, "dm.md"))).toBe(false);
    expect(JSON.stringify(seen.results)).not.toContain("OTHER-FILE");
  });

  it("refuses a listed file that is a hard link to another file", async () => {
    await grok();
    const other = join(scratch, "other.txt");
    writeFileSync(other, "OTHER-FILE\n");
    mkdirSync(join(scratch, "logs"));
    linkSync(other, join(scratch, "logs", "app.log"));
    mkdirSync(dirname(dmFile), { recursive: true });
    linkSync(other, dmFile);
    const { dump: seen } = await runTurn([
      { type: "raw-write", path: dmFile, content: "overwritten" },
      { type: "raw-read", path: dmFile },
      { type: "shell", command: `/bin/cat ${join(scratch, "logs", "app.log")}` },
    ]);
    expect(seen.results.map((r: any) => r.write ?? r.read ?? r.hook)).toEqual(["refused", "refused", "deny"]);
    expect(readFileSync(other, "utf8")).toBe("OTHER-FILE\n");
  });

  it("answers a permission ask from the policy with a once option only, never an always option", async () => {
    await grok();
    const { dump: seen } = await runTurn([
      { type: "permission", kind: "execute", rawInput: { command: `${tool} whoami --json` } },
      { type: "permission", kind: "execute", rawInput: { command: "touch PWNED" } },
      { type: "permission", kind: "edit", rawInput: { file_path: dmFile } },
      { type: "permission", kind: "other", rawInput: { tool_name: "COMPOSIO_SEARCH_TOOLS" } },
      {
        type: "permission",
        kind: "execute",
        rawInput: { command: `${tool} whoami --json` },
        options: [{ optionId: "allow-always", kind: "allow_always" }, { optionId: "reject-once", kind: "reject_once" }],
      },
    ]);
    expect(seen.results.map((r: any) => r.outcome?.optionId ?? r.outcome?.outcome)).toEqual([
      "allow-once",
      "reject-once",
      "allow-once",
      "reject-once",
      "reject-once",
    ]);
  });

  it("stops the turn when the engine runs a tool the hook never allowed", async () => {
    await grok();
    const { done } = await runTurn([{ type: "bypass", name: "use_tool" }, { type: "shell", command: `${tool} whoami --json` }]);
    expect(done).toMatchObject({ ok: false, stopReason: "capability_denied" });
    const error = recorder!.events.find((e) => e.type === "runtime.error");
    expect(error?.type === "runtime.error" ? error.message : "").toMatch(/use_tool/);
    expect(existsSync(join(scratch, "TOOL-RAN"))).toBe(false);
  });

  it("refuses to run when the engine offers no blocking pre-tool hook", async () => {
    await grok();
    process.env.FAKE_AL_NO_HOOKS = "1";
    const { done, dump: seen } = await runTurn([{ type: "shell", command: `${tool} whoami --json` }]);
    expect(done).toMatchObject({ ok: false, stopReason: "setup_required" });
    expect(seen.sessionMeta).toBeUndefined();
    expect(existsSync(join(scratch, "TOOL-RAN"))).toBe(false);
  });
});

posix("turns without an allowlist", () => {
  it("are unchanged:  full-auto Grok keeps bypassPermissions, no client terminal, no hook", async () => {
    await grok(true);
    const { done, dump: seen } = await runTurn([], { policy: null });
    expect(done.ok).toBe(true);
    expect(seen.argv.slice(0, 2)).toEqual(["--permission-mode", "bypassPermissions"]);
    expect(seen.argv).not.toContain("--no-leader");
    expect(seen.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false } });
    expect(seen.sessionMeta).toBeNull();
  });
});

posix("an engine that cannot be held", () => {
  it("refuses an allowlist turn on MiniMax Code before anything spawns", async () => {
    instance = await McodeAgentDriver.create({
      instanceId: "mcode-allowlist",
      displayName: "MiniMax Code",
      environment: { HOME: scratch },
      enabled: true,
      config: { cli: FAKE, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    expect(instance.adapter.capabilities.toolPolicy).toBe(false);
    const { done, dump: seen } = await runTurn([{ type: "shell", command: `${tool} whoami --json` }], { dumpName: "mcode.json" });
    expect(done).toMatchObject({ ok: false, stopReason: "setup_required" });
    expect(seen).toBeNull();
    const error = recorder.events.find((e) => e.type === "runtime.error");
    expect(error).toMatchObject({ setup: true });
    expect(error?.type === "runtime.error" ? error.message : "").toMatch(/cannot be held/);
  });

  it("says so in its capabilities, while Grok says it can", async () => {
    await grok();
    expect(instance!.adapter.capabilities.toolPolicy).toBe(true);
  });
});

describe("grokAllowlistProblem", () => {
  it("accepts an initialize answer with a blocking pre-tool hook that can deny, and nothing less", () => {
    expect(
      grokAllowlistProblem({ agentCapabilities: { _meta: { "x.ai/hooks": { blockingEvents: ["pre_tool_use"], decisions: ["deny", "block"] } } } }),
    ).toBeNull();
    expect(grokAllowlistProblem({ _meta: { "x.ai/hooks": { blockingEvents: ["pre_tool_use"], decisions: ["deny", "block"] } } })).toBeNull();
    expect(grokAllowlistProblem({ agentCapabilities: { _meta: {} } })).toMatch(/pre-tool hook/);
    expect(grokAllowlistProblem({ _meta: { "x.ai/hooks": { blockingEvents: ["stop"], decisions: ["deny"] } } })).toMatch(/pre-tool hook/);
    expect(grokAllowlistProblem({ _meta: { "x.ai/hooks": { blockingEvents: ["pre_tool_use"], decisions: ["block"] } } })).toMatch(/pre-tool hook/);
    expect(grokAllowlistProblem({})).toMatch(/pre-tool hook/);
    expect(grokAllowlistProblem(null)).toMatch(/pre-tool hook/);
  });
});
