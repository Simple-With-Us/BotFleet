import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import {
  classifyOpenCodeError,
  canListOpenCodeModels,
  createOpenCodeDriver,
  discoverOpenCodeModels,
  normalizeLegacyOpenCodeModel,
  openCodeModelProbeDeadline,
  openCodeModelProbeProblem,
  parseOpenCodeModelsOutput,
  resetOpenCodeModelCache,
} from "./opencode-go.ts";
import type { ModelCatalog } from "../../contracts.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

const catalog = (...ids: string[]): ModelCatalog => ({
  default: ids[0]!,
  options: ids.map((id) => ({ id, label: id })),
});

describe("OpenCode catalog", () => {
  it("parses Zen, Go, third-party, and local models using exact CLI slugs", () => {
    const models = parseOpenCodeModelsOutput([
      "openrouter/vendor/model-v2",
      JSON.stringify({ name: "Vendor Model", status: "active" }, null, 2),
      "opencode/x-preview-f-free",
      JSON.stringify({ name: "Ox Alpha Free", status: "active", limit: { context: 1_000_000 } }, null, 2),
      "opencode-go/minimax-m3",
      JSON.stringify({ name: "MiniMax M3", status: "active" }, null, 2),
      "ollama/qwen3",
      JSON.stringify({ name: "Qwen 3", api: { url: "http://127.0.0.1:11434/v1" } }, null, 2),
      "lmstudio/qwen3-ipv6",
      JSON.stringify({ name: "Qwen 3 IPv6", api: { url: "http://[::1]:1234/v1" } }, null, 2),
      "opencode/retired",
      JSON.stringify({ name: "Retired", status: "deprecated" }, null, 2),
    ].join("\n"));

    // Deprecated Zen slugs stay out of the catalog even when the CLI still lists them.
    expect(models?.default).toBe("opencode-go/minimax-m3");
    expect(models?.options).toEqual([
      expect.objectContaining({ id: "openrouter/vendor/model-v2", label: "OpenRouter · Vendor Model" }),
      expect.objectContaining({ id: "opencode-go/minimax-m3", label: "Go · MiniMax M3" }),
      expect.objectContaining({ id: "ollama/qwen3", custom: true, loaded: true }),
      expect.objectContaining({ id: "lmstudio/qwen3-ipv6", custom: true, loaded: true }),
    ]);
  });

  it("defaults to a first-party Zen model rather than the first listed", () => {
    // The catalog used to resolve its default through a hardcoded id that the
    // CLI has since deprecated, so a bot with no saved model inherited a model
    // that failed every turn.  The default is now chosen by rule: prefer a
    // first-party Zen model (the route that needs no stored credential), and
    // only then the first live entry.
    const models = parseOpenCodeModelsOutput([
      "openrouter/vendor/model-v2",
      JSON.stringify({ name: "Vendor Model", status: "active" }, null, 2),
      "opencode/some-live-free",
      JSON.stringify({ name: "Live Free", status: "active" }, null, 2),
    ].join("\n"));
    expect(models?.default).toBe("opencode/some-live-free");

    // With no first-party model at all, still hand back something the CLI
    // listed rather than a blank or a stale id.
    const thirdPartyOnly = parseOpenCodeModelsOutput([
      "openrouter/vendor/model-v2",
      JSON.stringify({ name: "Vendor Model", status: "active" }, null, 2),
    ].join("\n"));
    expect(thirdPartyOnly?.default).toBe("openrouter/vendor/model-v2");
  });


  it("caches the anonymous model probe across authentication checks", async () => {
    const runModels = vi.fn(async () => "opencode/x-preview-f-free\n");

    await expect(canListOpenCodeModels({}, "counting-opencode", runModels)).resolves.toBe(true);
    await expect(canListOpenCodeModels({}, "counting-opencode", runModels)).resolves.toBe(true);

    expect(runModels).toHaveBeenCalledOnce();
  });

  // A `#!/bin/sh` fixture with a mode bit:  Windows cannot execute one at
  // all, so the probe's flag handling is asserted on the platforms that run
  // this driver's real CLIs.  Same guard as the sibling ACP suites.
  it.skipIf(process.platform === "win32")(
    "asks a CLI that refuses --verbose anyway, instead of reporting nothing",
    async () => {
    // opencode v2.0.26 answers `Unrecognized flag: --verbose` and exits.  The
    // probe used to send only that form, so the rejection fell through to the
    // empty fallback catalog and the engine read as having no models at all —
    // for a CLI that lists them perfectly well without the flag.
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-noverbose-"));
    const cli = join(scratch, "opencode");
    writeFileSync(cli, [
      "#!/bin/sh",
      'for arg in "$@"; do',
      '  if [ "$arg" = "--verbose" ]; then',
      '    echo "ERROR  Unrecognized flag: --verbose in command opencode models" >&2',
      "    exit 1",
      "  fi",
      "done",
      'echo "anthropic/claude-sonnet-5"',
      'echo "minimax/minimax-m2"',
      "",
    ].join("\n"));
    chmodSync(cli, 0o755);
    resetOpenCodeModelCache();
    try {
      const found = await discoverOpenCodeModels({}, cli);
      expect(found.options.map((option) => option.id)).toContain("anthropic/claude-sonnet-5");
      expect(openCodeModelProbeProblem()).toBeNull();
    } finally {
      resetOpenCodeModelCache();
      await removeTempDir(scratch);
    }
  });

  it.skipIf(process.platform === "win32")(
    "keeps the two empty-list failures apart rather than collapsing them",
    async () => {
      // "Your CLI is broken" and "your CLI has no models" are the two things a
      // person here is trying to tell apart, so a plain command that ERRORED
      // must never be reported as a plain command that printed nothing — and a
      // verbose failure that is only about the flag must not be reported as the
      // cause of an empty catalog.
      const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-twofailures-"));
      const broken = join(scratch, "opencode-broken");
      // Exits non-zero for BOTH shapes: the CLI itself is unusable.
      writeFileSync(broken, ["#!/bin/sh", 'echo "ENOENT: no such binary" >&2', "exit 127", ""].join("\n"));
      const flagOnly = join(scratch, "opencode-flagonly");
      // Exits 0 with no output for plain, and refuses only the verbose form.
      writeFileSync(
        flagOnly,
        [
          "#!/bin/sh",
          'for arg in "$@"; do',
          '  if [ "$arg" = "--verbose" ]; then',
          '    echo "Unrecognized flag: --verbose in command opencode models" >&2',
          "    exit 1",
          "  fi",
          "done",
          "exit 0",
          "",
        ].join("\n"),
      );
      chmodSync(broken, 0o755);
      chmodSync(flagOnly, 0o755);
      resetOpenCodeModelCache();
      try {
        await discoverOpenCodeModels({}, broken);
        expect(openCodeModelProbeProblem()).toContain("no such binary");
        expect(openCodeModelProbeProblem()).not.toContain("listed nothing");

        await discoverOpenCodeModels({}, flagOnly);
        // The CLI answered correctly and had nothing to list; the flag refusal
        // is context, not the cause.
        expect(openCodeModelProbeProblem()).toContain("listed nothing");
        expect(openCodeModelProbeProblem()).toContain("Unrecognized flag");
      } finally {
        resetOpenCodeModelCache();
        await removeTempDir(scratch);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "records why the catalog is empty when the CLI lists nothing",
    async () => {
    // An engine with no models and no reason reads as broken.  It is not: the
    // CLI answered and had nothing to list, and the person needs that sentence.
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-emptymodels-"));
    const cli = join(scratch, "opencode");
    writeFileSync(cli, ["#!/bin/sh", "exit 0", ""].join("\n"));
    chmodSync(cli, 0o755);
    resetOpenCodeModelCache();
    try {
      const found = await discoverOpenCodeModels({}, cli);
      expect(found.options).toEqual([]);
      expect(openCodeModelProbeProblem()).toBeTruthy();
    } finally {
      resetOpenCodeModelCache();
      await removeTempDir(scratch);
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not resurrect a deprecated slug when the plain models list only has retired ids",
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-deprecated-only-"));
      const cli = join(scratch, "opencode");
      writeFileSync(cli, [
        "#!/bin/sh",
        'echo "opencode/x-preview-f-free"',
        'echo "opencode-go/exo-free"',
        "",
      ].join("\n"));
      chmodSync(cli, 0o755);
      resetOpenCodeModelCache();
      const driver = createOpenCodeDriver(async () => ({ default: "", options: [] }));
      try {
        const instance = await driver.create({
          instanceId: "opencode-deprecated-fallback",
          displayName: "OpenCode",
          environment: {},
          enabled: true,
          config: { cli, fullAuto: false },
        });
        expect(instance.models.options).toEqual([]);
        expect(instance.models.default).toBe("");
        await instance.dispose();
      } finally {
        resetOpenCodeModelCache();
        await removeTempDir(scratch);
      }
    },
  );

  it("accepts header-only output from older CLIs and rejects malformed lines", () => {
    const models = parseOpenCodeModelsOutput([
      "Available models",
      "opencode/x-preview-f-free",
      "bad model/with space",
      "openrouter/anthropic/claude-sonnet-5",
    ].join("\n"));

    expect(models?.options.map((option) => option.id)).toEqual([
      "openrouter/anthropic/claude-sonnet-5",
    ]);
  });

  it("refreshes the same instance catalog on each explicit refresh", async () => {
    let calls = 0;
    const driver = createOpenCodeDriver(async () => {
      calls += 1;
      const id = calls === 1
        ? "opencode/some-live-free"
        : calls === 2
          ? "opencode-go/extra-two"
          : "openrouter/vendor/extra-three";
      return catalog(id);
    });
    const instance = await driver.create({
      instanceId: "opencode-refresh",
      displayName: "OpenCode",
      environment: {},
      enabled: true,
      config: driver.defaultConfig(),
    });

    expect(instance.models.default).toBe("opencode/some-live-free");
    expect(instance.models.options.some((option) => option.custom)).toBe(false);
    await instance.refreshModels?.();
    expect(instance.models.options.some((option) => option.id === "opencode-go/extra-two" && !option.custom)).toBe(true);
    await instance.refreshModels?.();
    expect(instance.models.options.some((option) => option.id === "openrouter/vendor/extra-three" && !option.custom)).toBe(true);
    await instance.dispose();
  });

  it("keeps the driver optional and declares the OpenCode CLI setup", () => {
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    expect(driver.driverKind).toBe("opencodeGo");
    expect(driver.metadata.displayName).toBe("OpenCode");
    expect(driver.decodeConfig(undefined)).toEqual({ cli: "opencode", fullAuto: false, workspace: undefined });
    expect(driver.install?.docsUrl).toContain("opencode.ai");
    expect(driver.install?.signInCommand).toBe("opencode auth login");
  });

  it("migrates the retired Ox preview id without changing current ids", () => {
    expect(normalizeLegacyOpenCodeModel("opencode-go/ox-alpha-free", {})).toBe(
      "opencode/x-preview-f-free",
    );
    expect(normalizeLegacyOpenCodeModel("opencode-go/ox-alpha-free", { OPENCODE_API_KEY: "configured" })).toBe(
      "opencode-go/x-preview-f-free",
    );
    expect(normalizeLegacyOpenCodeModel("opencode/gpt-5.6-sol", {})).toBe("opencode/gpt-5.6-sol");
  });

  it("recognizes an OpenCode Go login stored by the CLI", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-auth-"));
    const authDir = join(scratch, "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      "opencode-go": { type: "api", key: "stored-secret" },
    }));
    const driver = createOpenCodeDriver(async () => catalog("opencode-go/minimax-m3"));
    const instance = await driver.create({
      instanceId: "opencode-auth",
      displayName: "OpenCode",
      environment: { XDG_DATA_HOME: scratch, OPENCODE_API_KEY: "" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("finds the CLI's login at ~/.local/share on every platform, macOS included", async () => {
    // `opencode auth list` prints ~/.local/share/opencode/auth.json on macOS —
    // the CLI is xdg-flavoured everywhere. Looking only in Library/Application
    // Support is the bug that told signed-in users to sign in. No XDG override
    // here on purpose: this is the exact real-world shape.
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-home-"));
    const authDir = join(scratch, ".local", "share", "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      "opencode-go": { type: "api", key: "stored-secret" },
    }));
    const driver = createOpenCodeDriver(async () => catalog("opencode-go/minimax-m3"));
    const instance = await driver.create({
      instanceId: "opencode-home-auth",
      displayName: "OpenCode",
      environment: { HOME: scratch, USERPROFILE: scratch, XDG_DATA_HOME: "", OPENCODE_API_KEY: "" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("recognizes an existing OpenCode Zen login", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-oauth-"));
    const authDir = join(scratch, "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      opencode: { type: "oauth", access: "acc-token", refresh: "ref-token" },
    }));
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    const instance = await driver.create({
      instanceId: "opencode-oauth-auth",
      displayName: "OpenCode",
      environment: { XDG_DATA_HOME: scratch, OPENCODE_API_KEY: "" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("treats OpenCode's anonymous free catalog as runnable without a saved key", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-free-"));
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    const instance = await driver.create({
      instanceId: "opencode-free",
      displayName: "OpenCode",
      environment: {
        HOME: scratch,
        USERPROFILE: scratch,
        XDG_DATA_HOME: join(scratch, "data"),
        FAKE_ACP_MODELS: "opencode/x-preview-f-free",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("runs a Zen model through ACP using the exact discovered id", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-zen-only-"));
    const authDir = join(scratch, "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      opencode: { type: "api", key: "zen-only-secret" },
    }));
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    const instance = await driver.create({
      instanceId: "opencode-zen-only",
      displayName: "OpenCode",
      environment: {
        XDG_DATA_HOME: scratch,
        OPENCODE_API_KEY: "",
        FAKE_ACP_MODELS: "opencode/x-preview-f-free",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({
        threadId: "t-opencode-zen-only",
        text: "hello",
        model: "opencode/x-preview-f-free",
      });
      const done = await recorder.until((event) => event.type === "turn.completed");
      expect(done).toMatchObject({ ok: true });
      expect(recorder.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "session.started", model: "opencode/x-preview-f-free" }),
      ]));
    } finally {
      recorder.stop();
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("classifies ACP's standard authentication error", () => {
    expect(classifyOpenCodeError({ code: -32000 })).toBe("invalid_credentials");
  });

  it("strips the OpenCode key from probes but keeps it in the turn child", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-go-"));
    try {
      const dump = join(scratch, "env.json");
      const driver = createOpenCodeDriver(async () => catalog("opencode-go/minimax-m3"));
      const instance = await driver.create({
        instanceId: "opencode-go",
        displayName: "OpenCode",
        environment: {
          OPENCODE_API_KEY: "secret-value",
          OPENAI_API_KEY: "wrong-provider-secret",
          ANTHROPIC_API_KEY: "wrong-provider-secret",
          FAKE_ACP_DUMP: dump,
        },
        enabled: true,
        config: { cli: FAKE_CLI, fullAuto: false },
      });
      await instance.snapshot();
      const probe = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> };
      expect(probe.env.OPENCODE_API_KEY).toBeUndefined();
      expect(probe.env.OPENAI_API_KEY).toBeUndefined();
      expect(probe.env.ANTHROPIC_API_KEY).toBeUndefined();

      const recorder = recordEvents(instance.adapter);
      await instance.adapter.sendTurn({ threadId: "opencode-env", text: "hello" });
      await recorder.until((event) => event.type === "turn.completed");
      recorder.stop();
      const child = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> };
      expect(child.env.OPENCODE_API_KEY).toBe("secret-value");
      expect(child.env.OPENAI_API_KEY).toBeUndefined();
      expect(child.env.ANTHROPIC_API_KEY).toBeUndefined();
      await instance.dispose();
    } finally {
      await removeTempDir(scratch);
    }
  });
});

// The sign-in gate is `opencode models`, and the host that runs it is often at a
// load many times its core count.  A probe that ran out of time there said
// nothing about sign-in;  reading it as "no usable models" refused turns for a
// CLI that works (BF-2469).
describe("OpenCode sign-in probe on a busy host", () => {
  // What execFile, then execCli on top of it, hand back when a deadline kills
  // the child.
  const execFileKill = () =>
    Object.assign(new Error("Command failed: opencode models\n"), { killed: true, signal: "SIGTERM", code: null });
  const execCliDeadline = () => Object.assign(execFileKill(), { timedOut: true });
  // Three run-queue entries per core:  the stretched ceiling, 60 s.
  const busyHost = openCodeModelProbeDeadline({ load1: 24, cores: 8 });

  type Runner = (
    cli: string,
    env: Record<string, string | undefined>,
    verbose: boolean,
    timeoutMs?: number,
  ) => Promise<string>;
  const failing = (make: () => Error) =>
    vi.fn<Runner>(async () => {
      throw make();
    });
  const printing = (stdout: string) => vi.fn<Runner>(async () => stdout);

  beforeEach(() => {
    resetOpenCodeModelCache();
  });
  afterEach(() => {
    resetOpenCodeModelCache();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("stretches the probe's budget with host load, from a 20 s floor", () => {
    expect(openCodeModelProbeDeadline({ load1: 2, cores: 10 }).timeoutMs).toBe(20_000);
    expect(openCodeModelProbeDeadline({ load1: 20, cores: 10 }).timeoutMs).toBe(40_000);
    expect(openCodeModelProbeDeadline({ load1: 300, cores: 10 }).timeoutMs).toBe(60_000);
    expect(openCodeModelProbeDeadline(null).timeoutMs).toBe(20_000);
  });

  it("hands the probe its budget, sized from the live load average when none is given", async () => {
    const runModels = printing("opencode/x-preview-f-free\n");
    await canListOpenCodeModels({}, "loaded-opencode", runModels, busyHost);
    expect(runModels).toHaveBeenLastCalledWith("loaded-opencode", {}, false, 60_000);

    await canListOpenCodeModels({ HOME: "/home/live" }, "live-opencode", runModels);
    const budget = runModels.mock.lastCall?.[3];
    expect(budget).toBeGreaterThanOrEqual(20_000);
    expect(budget).toBeLessThanOrEqual(60_000);
  });

  it.each([
    ["an execFile kill", execFileKill],
    ["execCli's deadline", execCliDeadline],
    ["execCli's hard deadline", () => Object.assign(new Error("`opencode` did not exit within 20000ms"), { killed: true })],
    ["the error runOpenCodeModels wraps it in", () => new Error("", { cause: execCliDeadline() })],
    ["a signal from outside", () => Object.assign(new Error("Command failed: opencode models\n"), { signal: "SIGKILL", code: null })],
  ])("reads %s as unknown, never as not signed in", async (_name, make) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(canListOpenCodeModels({}, "slow-opencode", failing(make))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("still reads a CLI that answered without a list as not signed in", async () => {
    await expect(canListOpenCodeModels({}, "empty-opencode", printing(""))).resolves.toBe(false);
    const exited = failing(() => Object.assign(new Error("ENOENT: no such binary"), { code: 127 }));
    await expect(canListOpenCodeModels({}, "broken-opencode", exited)).resolves.toBe(false);
    const missing = failing(() => Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" }));
    await expect(canListOpenCodeModels({}, "missing-opencode", missing)).resolves.toBe(false);
  });

  it("never remembers a timeout, so the next look asks again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let healthy = false;
    const runModels = vi.fn<Runner>(async () => {
      if (!healthy) throw execCliDeadline();
      return "opencode/x-preview-f-free\n";
    });

    // Callers that arrive while the probe is running share its one process.
    const together = await Promise.all([
      canListOpenCodeModels({}, "recovering-opencode", runModels),
      canListOpenCodeModels({}, "recovering-opencode", runModels),
    ]);
    expect(together).toEqual([undefined, undefined]);
    expect(runModels).toHaveBeenCalledTimes(1);

    // Once it has settled, nothing was kept:  the next look runs it again.
    await expect(canListOpenCodeModels({}, "recovering-opencode", runModels)).resolves.toBeUndefined();
    expect(runModels).toHaveBeenCalledTimes(2);

    healthy = true;
    await expect(canListOpenCodeModels({}, "recovering-opencode", runModels)).resolves.toBe(true);
    expect(runModels).toHaveBeenCalledTimes(3);
    await expect(canListOpenCodeModels({}, "recovering-opencode", runModels)).resolves.toBe(true);
    expect(runModels).toHaveBeenCalledTimes(3);
  });

  it("remembers a list for ten minutes but an empty answer for thirty seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.UTC(2026, 9, 18, 12, 0, 0);
    vi.setSystemTime(start);

    const listed = printing("opencode/x-preview-f-free\n");
    await canListOpenCodeModels({}, "listed-opencode", listed);
    vi.setSystemTime(start + 9 * 60_000 + 59_000);
    await canListOpenCodeModels({}, "listed-opencode", listed);
    expect(listed).toHaveBeenCalledTimes(1);
    vi.setSystemTime(start + 10 * 60_000 + 1_000);
    await canListOpenCodeModels({}, "listed-opencode", listed);
    expect(listed).toHaveBeenCalledTimes(2);

    vi.setSystemTime(start);
    const empty = printing("");
    await expect(canListOpenCodeModels({}, "empty-opencode", empty)).resolves.toBe(false);
    vi.setSystemTime(start + 29_000);
    await canListOpenCodeModels({}, "empty-opencode", empty);
    expect(empty).toHaveBeenCalledTimes(1);
    vi.setSystemTime(start + 31_000);
    await canListOpenCodeModels({}, "empty-opencode", empty);
    expect(empty).toHaveBeenCalledTimes(2);
  });

  it("does not share an answer between instances that read different logins", async () => {
    const signedIn = printing("opencode/x-preview-f-free\n");
    const signedOut = printing("");
    await expect(canListOpenCodeModels({ HOME: "/home/a" }, "opencode", signedIn)).resolves.toBe(true);
    await expect(canListOpenCodeModels({ HOME: "/home/b" }, "opencode", signedOut)).resolves.toBe(false);
    expect(signedOut).toHaveBeenCalledOnce();
  });

  // One driver, one fake CLI for `--version` and `acp`, and `opencode models`
  // answering however the test says:  the same gate a real turn goes through.
  const busyInstance = async (scratch: string, runModels: Runner) => {
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"), runModels);
    return driver.create({
      instanceId: "opencode-busy",
      displayName: "OpenCode",
      environment: {
        HOME: scratch,
        USERPROFILE: scratch,
        XDG_DATA_HOME: join(scratch, "data"),
        OPENCODE_API_KEY: "",
        FAKE_ACP_MODELS: "opencode/x-preview-f-free",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
  };

  it("does not refuse a turn when the sign-in probe runs out of time", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runModels = failing(execCliDeadline);
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-busy-"));
    const instance = await busyInstance(scratch, runModels);
    const recorder = recordEvents(instance.adapter);
    try {
      // Inconclusive, which the engine row reads as "not known to be signed out".
      expect((await instance.snapshot()).authenticated).toBeUndefined();

      await instance.adapter.sendTurn({
        threadId: "t-opencode-busy",
        text: "hello",
        model: "opencode/x-preview-f-free",
      });
      const done = await recorder.until((event) => event.type === "turn.completed");
      expect(done).toMatchObject({ ok: true });
      expect(recorder.events.map((event) => event.type)).not.toContain("runtime.error");

      // Every probe was given a load-sized budget, and said why it gave no answer.
      const budgets = runModels.mock.calls.map((call) => call[3]);
      expect(budgets.length).toBeGreaterThan(0);
      for (const budget of budgets) {
        expect(budget).toBeGreaterThanOrEqual(20_000);
        expect(budget).toBeLessThanOrEqual(60_000);
      }
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/model probe timed out after \d+ s/));
    } finally {
      recorder.stop();
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("still refuses a turn when the CLI answered with no models", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-signedout-"));
    const instance = await busyInstance(scratch, printing(""));
    const recorder = recordEvents(instance.adapter);
    try {
      expect((await instance.snapshot()).authenticated).toBe(false);

      await instance.adapter.sendTurn({
        threadId: "t-opencode-signedout",
        text: "hello",
        model: "opencode/x-preview-f-free",
      });
      const done = await recorder.until((event) => event.type === "turn.completed");
      expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    } finally {
      recorder.stop();
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  // Real children, so the error shapes are execFile's and execCli's own rather
  // than ones this file made up.  `#!/bin/sh` fixtures, which Windows cannot run
  // (same guard as the sibling suites above).
  it.skipIf(process.platform === "win32")(
    "times out a CLI that hangs, and says so apart from a CLI that lists nothing",
    async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-hang-"));
      const calls = join(scratch, "calls.log");
      const hangs = join(scratch, "opencode-hangs");
      writeFileSync(hangs, ["#!/bin/sh", `echo "$@" >> "${calls}"`, "exec sleep 30", ""].join("\n"));
      const empty = join(scratch, "opencode-empty");
      writeFileSync(empty, ["#!/bin/sh", "exit 0", ""].join("\n"));
      chmodSync(hangs, 0o755);
      chmodSync(empty, 0o755);
      // The budget's own floor, so the hang is cut after 1 s instead of waiting out 20 s or more.
      const quick = { ...busyHost, timeoutMs: 1_000 };
      try {
        await expect(canListOpenCodeModels({}, hangs, undefined, quick)).resolves.toBeUndefined();

        const found = await discoverOpenCodeModels({}, hangs, quick);
        expect(found.options).toEqual([]);
        expect(openCodeModelProbeProblem()).toBe("OpenCode's model probe timed out after 1 s (host load 3.0 per core)");
        // A timeout says nothing about the flag, so no second ask that would only double the wait.
        expect(existsSync(calls) ? readFileSync(calls, "utf8") : "").not.toContain("--verbose");

        await discoverOpenCodeModels({}, empty, quick);
        expect(openCodeModelProbeProblem()).toContain("answered nothing");
        expect(openCodeModelProbeProblem()).not.toContain("timed out");
      } finally {
        resetOpenCodeModelCache();
        await removeTempDir(scratch);
      }
    },
    // Two real one-second deadlines, on a host this suite is meant to survive
    // being loaded.
    30_000,
  );

  it.skipIf(process.platform === "win32")("reads a CLI that was stopped before it answered as unknown", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-stopped-"));
    const cli = join(scratch, "opencode-stopped");
    writeFileSync(cli, ["#!/bin/sh", "kill -TERM $$", ""].join("\n"));
    chmodSync(cli, 0o755);
    try {
      await expect(canListOpenCodeModels({}, cli)).resolves.toBeUndefined();
      await discoverOpenCodeModels({}, cli);
      expect(openCodeModelProbeProblem()).toBe("OpenCode's model probe was stopped by SIGTERM before it answered");
    } finally {
      resetOpenCodeModelCache();
      await removeTempDir(scratch);
    }
  });
});
