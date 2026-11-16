// Muse Code driver.  The engine runs on a community ACP adapter in front of
// Meta's `muse serve`, so the things worth pinning here are the claims that
// shape what a user gets: which channels the engine mounts, which model the
// picker offers, and which effort rungs we advertise.  Each one is a place
// where an optimistic edit would overclaim a capability the engine does not
// actually have.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import {
  type AuthIndex,
  MUSE_EFFORT_LEVELS,
  MUSE_LOGIN_NOTE,
  MUSE_MODEL_CONFIG_ID,
  MuseAgentDriver,
  STATIC_MUSE_MODELS,
  authIndexSchema,
  museAdvertisedConfigOptionsSchema,
  museAuthenticated,
  museModelIdForValue,
  museModelOptionValue,
  parseMuseModelValue,
} from "./muse.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

/** The adapter's own wire value for one model choice:  `muse-model:` plus the
 *  URI-encoded `[providerId, profileId|null, modelId]` triple (`modelChoice`
 *  in the adapter's `dist/config-options.js`). */
function museWireValue(provider: string, profile: string | null, model: string): string {
  return `muse-model:${encodeURIComponent(JSON.stringify([provider, profile, model]))}`;
}

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "botfleet-muse-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Muse Code driver", () => {
  it("is registered as a built-in driver", () => {
    // A driver file nobody imports is a file that does nothing, and the
    // capability matrix would have a row for an engine that cannot start.
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "museAgent")).toBe(true);
  });

  it("mounts every MCP channel and takes images", () => {
    // The adapter forwards the MCP servers BotFleet hands `session/new` into
    // Muse through a private overlay, and takes PNG/JPEG/GIF/WebP image parts
    // on a turn.  Both are the reason this engine can have Connected Apps at
    // all, so they are pinned rather than inferred.
    expect(MuseAgentDriver.metadata.channelWiring).toEqual({
      agentsMcp: true,
      computerMcp: true,
      composioMcp: true,
      localComputerMcp: true,
      images: true,
    });
  });

  it("names itself Muse Code and the CLI it actually spawns", () => {
    expect(MuseAgentDriver.driverKind).toBe("museAgent");
    expect(MuseAgentDriver.metadata.displayName).toBe("Muse Code");
    // The spawned binary is the adapter, never `muse` itself: `muse` speaks
    // MSP, and the adapter is what speaks ACP to us.
    const decoded = MuseAgentDriver.defaultConfig();
    expect((decoded as { cli: string }).cli).toBe("muse-code-acp");
  });

  it("installs both halves — the muse binary and the adapter", () => {
    const install = MuseAgentDriver.install;
    expect(install?.needsNode, "npm install -g needs Node on PATH").toBe(true);
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const command = install?.command?.[platform] ?? "";
      expect(command, platform).toContain("muse-code-acp");
    }
    // The Windows chain is PowerShell's `;`, not `&&` — a shell mismatch here
    // would install the adapter and skip the binary (or the reverse) and the
    // user would only find out on their first turn.
    expect(install?.command?.win32).toContain("npm install -g @bex-co/muse-code-acp");
    expect(install?.signInCommand).toBe("muse auth set --provider meta --api-key-stdin");
  });

  it("offers the CLI's own default model, not the best model on the card", () => {
    // muse-spark-1.3 is "tuned for agentic workflows" and is the Model API
    // default, but the CLI defaults to 1.2 and this catalog is static while
    // the account's own catalog decides which ids the session advertises, so
    // listing 1.3 would put a row in the picker a user can select and cannot
    // get on an account that does not offer it.
    expect(STATIC_MUSE_MODELS.default).toBe("muse-spark-1.2");
    expect(STATIC_MUSE_MODELS.options.map((option) => option.id)).toEqual(["muse-spark-1.2"]);
    const only = STATIC_MUSE_MODELS.options[0];
    expect(only?.contextWindow).toBe(1_048_576);
    expect(only?.images).toBe(true);
  });

  it("advertises only the effort rungs it can actually send", () => {
    // `none` is excluded because the Meta provider rejects it (HTTP 400).
    // `max` is excluded because it is muse-spark-1.3 only and 1.3 is not a
    // model this driver offers.  `minimal` and `ultra` are absent because the
    // shared EFFORT_LEVELS union has no member for them, and widening that
    // union would put two rungs in pi's picker that pi does not take.  All
    // four omissions are deliberate, and each one is a rung the picker must
    // not offer rather than a rung that quietly fails on the first turn.
    expect(MUSE_EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh"]);
    expect(MUSE_EFFORT_LEVELS).not.toContain("none");
    expect(MUSE_EFFORT_LEVELS).not.toContain("max");
    // Guard the reason itself: if 1.3 ever enters the catalog, `max` becomes
    // reachable and this assertion is the reminder to put it back.
    expect(STATIC_MUSE_MODELS.options.map((option) => option.id)).not.toContain("muse-spark-1.3");
  });

  it("treats META_API_KEY as proof of a sign-in", () => {
    // The key wins over a stored browser session, so it is the one signal
    // worth trusting.  Its value is never read.
    expect(museAuthenticated({ META_API_KEY: "set" })).toBe(true);
    expect(museAuthenticated({ META_API_KEY: "   " })).toBe(false);
  });

  it("accepts a keychain session, because the CLI resolves it for the adapter", () => {
    // Every fixture goes where the REAL index lives — `$HOME/.config/muse/`,
    // not `dir/auth.json` — so these are genuine regression guards.  The first
    // version of this test wrote elsewhere and passed for the wrong reason:  an
    // implementation reading the file would not have found it.
    const keychainHome = scratch();
    const keychainDir = join(keychainHome, ".config", "muse");
    mkdirSync(keychainDir, { recursive: true });
    writeFileSync(
      join(keychainDir, "auth.json"),
      // The observed macOS shape:  an index with no credential in it, naming
      // the keychain as the place the token went.
      JSON.stringify({
        schema_version: 1,
        providers: {
          meta: {
            mechanism: "oauth",
            storage: "keychain",
            obtained_via: "device_code",
            api_base_url: "https://api.meta.ai/v1",
          },
        },
      }),
      "utf8",
    );

    // A keychain-backed browser session is a real credential.  This used to
    // assert `false`, on the theory that the adapter's bundled
    // `@muse-code/sdk@1.3.0` predates the keychain move.  Measured against the
    // real `muse-code-acp` on this exact account shape:  initialize, session/new
    // and session/prompt all succeed and the prompt returns `end_turn`.  The
    // adapter spawns `muse serve`; the installed CLI is what reads the token,
    // so the SDK version never mattered.  Answering `false` here stranded the
    // setup card and the failover chain for a user who was signed in and could
    // run a turn by hand.
    expect(museAuthenticated({ HOME: keychainHome })).toBe(true);
    expect(
      museAuthenticated({ HOME: keychainHome, MUSE_AUTH_PATH: join(keychainDir, "auth.json") }),
    ).toBe(true);

    // A file-backed credential is the NORMAL case on Linux and Windows, where
    // there is no macOS Keychain to put it in.  Treating that as "not signed
    // in" would strand every user on those platforms, so `storage` is the
    // discriminator and only `keychain` is unproven.
    const fileHome = scratch();
    const fileDir = join(fileHome, ".config", "muse");
    mkdirSync(fileDir, { recursive: true });
    writeFileSync(
      join(fileDir, "auth.json"),
      JSON.stringify({
        schema_version: 1,
        providers: {
          meta: { mechanism: "api_key", storage: "file", api_base_url: "https://api.meta.ai/v1" },
        },
      }),
      "utf8",
    );
    expect(museAuthenticated({ HOME: fileHome })).toBe(true);

    // No index at all is plainly not signed in.
    expect(museAuthenticated({ HOME: scratch() })).toBe(false);
    // And the env key outranks everything.
    expect(museAuthenticated({ META_API_KEY: "set", HOME: keychainHome })).toBe(true);
    // A malformed index must not throw out of a snapshot path.
    const brokenHome = scratch();
    const brokenDir = join(brokenHome, ".config", "muse");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "auth.json"), "{ not json", "utf8");
    expect(museAuthenticated({ HOME: brokenHome })).toBe(false);
  });

  it("only counts a credential under the provider this driver actually spends", () => {
    // The index is a map of *providers*.  The check used to return the first
    // provider carrying any `storage`, so an index holding only some other
    // provider reported the engine as signed in — and `turn-safety.ts` then
    // put that unauthenticated instance into the failover chain, where it
    // would fail every turn before the chain ever got a real shot.
    const otherHome = scratch();
    const otherDir = join(otherHome, ".config", "muse");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(
      join(otherDir, "auth.json"),
      JSON.stringify({
        schema_version: 1,
        providers: { someotherprovider: { mechanism: "api_key", storage: "keychain" } },
      }),
      "utf8",
    );
    expect(museAuthenticated({ HOME: otherHome })).toBe(false);

    // Both present: `meta` is the one that counts, and it satisfies the check
    // on its own.  `meta` must win even when the other provider sorts first.
    writeFileSync(
      join(otherDir, "auth.json"),
      JSON.stringify({
        schema_version: 1,
        providers: {
          aaaother: { mechanism: "api_key", storage: "keychain" },
          meta: { mechanism: "browser_session", storage: "keychain" },
        },
      }),
      "utf8",
    );
    expect(museAuthenticated({ HOME: otherHome })).toBe(true);

    // A `meta` entry with no storage is not a credential either.
    writeFileSync(
      join(otherDir, "auth.json"),
      JSON.stringify({ schema_version: 1, providers: { meta: { mechanism: "none" } } }),
      "utf8",
    );
    expect(museAuthenticated({ HOME: otherHome })).toBe(false);
  });

  it("exposes the schema and a type derived from it, so they cannot drift", () => {
    // The driver reads the index through `authIndexSchema`, and `AuthIndex` is
    // derived from that same schema.  Asserting a good fixture against both is
    // what makes "the type matches the runtime check" a checked fact rather
    // than a claim -- if the schema changes shape without the type following,
    // this stops compiling or stops passing.
    const good = {
      schema_version: 1,
      providers: {
        somefutureprovider: { storage: "file" },
        meta: { storage: "keychain", mechanism: "browser_session" },
      },
    };
    const parsed = authIndexSchema.safeParse(good);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const index: AuthIndex = parsed.data;
    expect(index.providers?.meta?.storage).toBe("keychain");
    // Unmodelled keys survive, because a provider we do not know about must
    // not invalidate the whole file.
    expect(index.providers?.somefutureprovider).toEqual({ storage: "file" });
  });

  it("survives an index whose shape is not what the schema expects", () => {
    // The index is a file another program writes, so its shape is not ours to
    // assume.  Every one of these is valid JSON that would have indexed into
    // nonsense before the schema, and each must read as "not signed in"
    // rather than throwing out of a snapshot path or, worse, reporting a
    // credential that is not there.
    const home = scratch();
    const dir = join(home, ".config", "muse");
    mkdirSync(dir, { recursive: true });
    const cases = [
      '"just a string"',
      "42",
      "null",
      "[]",
      JSON.stringify({ providers: "not-an-object" }),
      JSON.stringify({ providers: { meta: "not-an-object" } }),
      JSON.stringify({ providers: { meta: { storage: 42 } } }),
      JSON.stringify({ providers: { meta: { storage: "" } } }),
      JSON.stringify({ providers: { meta: { storage: null } } }),
    ];
    for (const body of cases) {
      writeFileSync(join(dir, "auth.json"), body, "utf8");
      expect(museAuthenticated({ HOME: home }), `index ${body.slice(0, 40)}`).toBe(false);
    }

    // An unmodelled provider alongside a good `meta` one still signs in —
    // `.passthrough()` exists so a future provider cannot invalidate the file.
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({
        providers: {
          futureprovider: { storage: "file", somethingNew: 1 },
          meta: { storage: "keychain" },
        },
      }),
      "utf8",
    );
    expect(museAuthenticated({ HOME: home })).toBe(true);
  });

  it("names the same sign-in path the auth check can actually see", () => {
    // The bug this guards:  `loginNote` and `signInCommand` pointed at
    // `muse-code-acp --cli login`, which completes a device-code session into
    // the keychain — a credential this engine cannot read.  A user who followed
    // the card exactly stayed `authenticated: false` forever, the setup card
    // never cleared, and `turn-safety.ts` kept the instance out of the failover
    // chain.  If the two ever drift apart again, the card stops working.
    const signIn = MuseAgentDriver.install?.signInCommand ?? "";
    expect(signIn).toBe("muse auth set --provider meta --api-key-stdin");
    expect(signIn).not.toContain("--cli login");
    expect(MUSE_LOGIN_NOTE).toContain("API key");
    // The command reads the key from stdin, so it BLOCKS.  Without the key and
    // the EOF named in the note, a user following the setup card sits in a
    // terminal that looks hung and the card never clears.
    expect(MUSE_LOGIN_NOTE).toContain("--api-key-stdin");
    expect(MUSE_LOGIN_NOTE).toMatch(/paste the key/i);
    expect(MUSE_LOGIN_NOTE).toMatch(/ctrl-d/i);
  });
});

describe("Muse Code model selection", () => {
  // The adapter's wire value for a provider-qualified choice, exactly as
  // `modelChoice` in its `dist/config-options.js` builds it.
  const SPARK_12 = museWireValue("meta", null, "muse-spark-1.2");
  const SPARK_13 = museWireValue("meta", null, "muse-spark-1.3");
  const OTHER_PROVIDER = museWireValue("other", null, "muse-spark-1.2");
  const NAMED_PROFILE = museWireValue("meta", "contributor", "muse-spark-1.2");

  const advertised = (options: Array<{ value: string; name?: string }>) =>
    museAdvertisedConfigOptionsSchema.parse([
      { id: MUSE_MODEL_CONFIG_ID, currentValue: SPARK_13, options },
    ]);

  it("matches the picked id against the advertised option and sends that value back unchanged", () => {
    // The value is never constructed here:  the provider inside it belongs to
    // the user's own account, so the only safe thing to send is the exact
    // string the session advertised.
    expect(museModelOptionValue("muse-spark-1.2", advertised([{ value: SPARK_12, name: "Muse Spark 1.2" }]))).toBe(SPARK_12);
    // A session that advertises a plain id (the adapter's legacy exec
    // backend) is matched on that id and sent back as it stands.
    expect(museModelOptionValue("muse-spark-1.2", advertised([{ value: "muse-spark-1.2" }]))).toBe("muse-spark-1.2");
  });

  it("skips the switch when the session advertises no model option", () => {
    // An adapter older than the one that added the config options cannot
    // switch.  That is not a failure:  the session keeps the model it already
    // runs, which is what every turn did before this switch existed, and a
    // turn that cannot run is the worse outcome.
    expect(museModelOptionValue("muse-spark-1.2", [])).toBe(null);
    expect(museModelOptionValue("muse-spark-1.2", undefined)).toBe(null);
    // A session that advertises the option but no choice for it is the same
    // answer.
    expect(museModelOptionValue("muse-spark-1.2", advertised([]))).toBe(null);
  });

  it("refuses a model the session does not offer, and names what it does offer", () => {
    expect(() =>
      museModelOptionValue(
        "muse-spark-1.3",
        advertised([{ value: SPARK_12, name: "Muse Spark 1.2" }]),
      ),
    ).toThrow(/does not offer muse-spark-1\.3 for this session/);
    expect(() =>
      museModelOptionValue(
        "muse-spark-1.3",
        advertised([{ value: SPARK_12, name: "Muse Spark 1.2" }]),
      ),
    ).toThrow(/available: Muse Spark 1\.2/);
  });

  it("refuses an ambiguous model and a profile-routed one", () => {
    // Two providers offering the same id:  picking one would be guessing, and
    // the iOS path refuses the same shape for the same reason.
    expect(() =>
      museModelOptionValue(
        "muse-spark-1.2",
        advertised([{ value: SPARK_12, name: "Muse Spark 1.2" }, { value: OTHER_PROVIDER }]),
      ),
    ).toThrow(/more than once/);
    // The adapter refuses named-profile routing itself, so this says it here
    // instead of letting the switch come back as an invalid-params error.
    expect(() =>
      museModelOptionValue("muse-spark-1.2", advertised([{ value: NAMED_PROFILE }])),
    ).toThrow(/named profile/);
  });

  it("keeps the unprofiled choice when a profile-routed one names the same model", () => {
    // A profile-routed choice is not a candidate to switch to, so it must not
    // count toward the ambiguity check either.
    expect(
      museModelOptionValue(
        "muse-spark-1.2",
        advertised([{ value: SPARK_12, name: "Muse Spark 1.2" }, { value: NAMED_PROFILE }]),
      ),
    ).toBe(SPARK_12);
  });

  it("treats the same value advertised twice as one choice", () => {
    // The same wire value twice is one choice, not an ambiguous one.
    expect(
      museModelOptionValue(
        "muse-spark-1.2",
        advertised([{ value: SPARK_12, name: "Muse Spark 1.2" }, { value: SPARK_12 }]),
      ),
    ).toBe(SPARK_12);
  });

  it("keeps the good entries when one advertised entry is malformed", () => {
    // The list is agent output, so one unreadable entry drops itself and the
    // rest of the list survives.  A session that offers the model must not
    // lose it because something else in the list was malformed.
    const parsed = museAdvertisedConfigOptionsSchema.parse([
      "garbage",
      { id: MUSE_MODEL_CONFIG_ID, currentValue: SPARK_13, options: [{ value: SPARK_12, name: "Muse Spark 1.2" }] },
    ]);
    expect(museModelOptionValue("muse-spark-1.2", parsed)).toBe(SPARK_12);
  });

  it("reads the picker id back out of an advertised value", () => {
    expect(museModelIdForValue(SPARK_12)).toBe("muse-spark-1.2");
    expect(museModelIdForValue("muse-spark-1.2")).toBe("muse-spark-1.2");
    expect(museModelIdForValue("   ")).toBe(null);
    // A value that carries the wire prefix but does not decode is not a model
    // id:  reporting it as one would persist the wire format as the session's
    // model identity.
    expect(museModelIdForValue("muse-model:not-json")).toBe(null);
    expect(museModelIdForValue("muse-model:%7B%22bad%22%3A1%7D")).toBe(null);
    expect(parseMuseModelValue(SPARK_12)).toEqual({
      providerId: "meta",
      profileId: null,
      modelId: "muse-spark-1.2",
    });
    expect(parseMuseModelValue("muse-spark-1.2")).toBe(null);
    expect(parseMuseModelValue("muse-model:not-json")).toBe(null);
  });
});

describe("Muse Code model selection over ACP", () => {
  const ENV_KEYS = [
    "FAKE_ACP_DUMP",
    "FAKE_ACP_RPC_DUMP",
    "FAKE_ACP_MODELS_JSON",
    "FAKE_ACP_SESSION_MODELS",
    "FAKE_ACP_OMIT_INIT_MODEL_STATE",
  ];
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
  });

  const create = async () => {
    instance = await MuseAgentDriver.create({
      instanceId: "muse-model-test",
      displayName: "Muse Code",
      // A throwaway HOME, so the driver's own credential check reads nothing
      // from the machine this suite runs on.
      environment: { HOME: scratch() },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };

  // The dump is written by a child process, so it is validated before it is
  // read:  a malformed record fails the test instead of reaching the
  // assertion as trusted data.
  const configCallSchema = z
    .object({
      method: z.string(),
      params: z
        .object({
          sessionId: z.string(),
          configId: z.string(),
          value: z.string(),
        })
        .strict(),
    })
    .strict();
  type ConfigCall = z.infer<typeof configCallSchema>;

  const configCalls = (dump: string): ConfigCall[] => {
    const file = `${dump}.config.json`;
    if (!existsSync(file)) return [];
    return z.array(configCallSchema).parse(JSON.parse(readFileSync(file, "utf8")));
  };

  const rpcMethods = (dump: string): string[] => {
    if (!existsSync(dump)) return [];
    return z.array(z.string()).parse(JSON.parse(readFileSync(dump, "utf8")));
  };

  const runTurn = async (threadId: string, model?: string) => {
    await instance!.adapter.sendTurn({ threadId, text: "hello", model });
    return recorder!.until(
      (event) => event.type === "turn.completed" && event.threadId === threadId,
    );
  };

  it("sends the switch when the session advertises the model option", async () => {
    const SPARK_12 = museWireValue("meta", null, "muse-spark-1.2");
    const STARTUP = museWireValue("meta", null, "muse-spark-1.3-contributor");
    // The session sits on the account's startup model and offers 1.2, so the
    // pick has to travel.
    process.env.FAKE_ACP_MODELS_JSON = JSON.stringify([STARTUP, SPARK_12]);
    const dump = join(scratch(), "model.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create();

    const done = await runTurn("muse-model-switch", "muse-spark-1.2");

    expect(done).toMatchObject({ ok: true });
    expect(configCalls(dump)).toEqual([
      {
        method: "session/set_config_option",
        params: { sessionId: "fake-acp-session", configId: "model", value: SPARK_12 },
      },
    ]);
  });

  it("runs the turn on the session's own model when the session advertises no model option", async () => {
    // No advertised model option at all:  the adapter is older than the one
    // that added the config options.  The switch must never reach it, because
    // a request it cannot answer is a generic `-32602` nobody can act on, and
    // the turn runs on the model the session already has.
    //
    // The session advertises its own model, and the CLI reports no model
    // state of its own, so the only way the turn can be reported as running
    // the session's model is the new resolution:  the CLI default would be a
    // different model, and the assertion below would fail without it.
    const rpcDump = join(scratch(), "rpc-refused.json");
    process.env.FAKE_ACP_RPC_DUMP = rpcDump;
    process.env.FAKE_ACP_SESSION_MODELS = "fake-session-model";
    process.env.FAKE_ACP_OMIT_INIT_MODEL_STATE = "1";
    await create();

    const done = await runTurn("muse-model-refused", "muse-spark-1.2");

    expect(done).toMatchObject({ ok: true });
    expect(rpcMethods(rpcDump)).toContain("session/prompt");
    expect(rpcMethods(rpcDump)).not.toContain("session/set_config_option");
    // The person is told the turn ran another model, so it is not read as
    // the model the picker named.
    const notice = recorder!.events.find((event) => event.type === "runtime.notice");
    expect(notice?.message).toMatch(/cannot switch models/);
    // And the turn is not reported as the model that was picked.
    const started = recorder!.events.find((event) => event.type === "session.started");
    expect(started?.model ?? null).not.toBe("muse-spark-1.2");
    // The session's own model is reported instead of nothing:  the turn ran
    // on it, so the turn identity and the cost estimate name the model that
    // actually answered.
    expect(started?.model).toBe("fake-session-model");
    expect(notice?.message).toContain("fake-session-model");
  });

  it("leaves an older adapter's session running when the turn picked no model", async () => {
    // Nothing was picked, so nothing has to be switched:  the session keeps
    // the account's startup model and the turn runs on it.
    const rpcDump = join(scratch(), "rpc-older.json");
    process.env.FAKE_ACP_RPC_DUMP = rpcDump;
    await create();

    const done = await runTurn("muse-model-older");

    expect(done).toMatchObject({ ok: true });
    expect(rpcMethods(rpcDump)).toContain("session/prompt");
    expect(rpcMethods(rpcDump)).not.toContain("session/set_config_option");
  });
});
