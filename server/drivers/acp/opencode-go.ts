// The maintained OpenCode CLI through its ACP stdio interface. OpenCode is
// the harness; Zen, Go, OpenRouter, and user-configured/local providers are
// models discovered from that harness rather than separate BotFleet drivers.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import {
  describeInitDeadline,
  readHostLoad,
  resolveInitDeadline,
  type HostLoad,
  type InitDeadline,
} from "./init-deadline.ts";
import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { execCli, isProbeTimeout, type ProbeTimeoutError } from "../../procs.ts";

/** Fallback catalog for a bot that has no saved model yet.
 *
 *  The id here used to be a hardcoded `opencode/x-preview-f-free`, and that
 *  model is gone:  OpenCode answers `Model exo-free has been deprecated` for
 *  it, so a new bot inherited a default that failed every turn.  Worse, the
 *  CLI's own default was the equally-dead `exo-free`, so an unset model hit
 *  the same wall from the other side.
 *
 *  A hardcoded id cannot be right for long — the free catalog rotates.  So the
 *  fallback is deliberately the *first model the installed CLI lists*, resolved
 *  per instance, with this entry only used when the probe yields nothing (a
 *  CLI too old to answer, or one mid-upgrade).  `resolveModels` merges the
 *  live catalog over this, and `resolveTurnModel` follows the bot's saved id
 *  when it has one. */
/** Slugs the CLI may still list even though the engine no longer honours them.
 *  The verbose catalog path drops `status: "deprecated"` records; the plain
 *  `models` fallback must apply the same denylist or it hands a poisoned id
 *  back as the only choice. */
const DEPRECATED_OPENCODE_MODEL_SLUGS = new Set([
  "opencode/x-preview-f-free",
  "opencode-go/exo-free",
  "opencode-go/x-preview-f-free",
]);

const STATIC_MODELS: ModelCatalog = {
  // Left empty on purpose: an empty `options` list cannot present a
  // deprecated id to a user as if it were a choice.  A bot with no saved
  // model and no live catalog surfaces as "no models available" rather than
  // as one broken entry.
  default: "",
  options: [],
};

/** The first model the installed CLI will actually run, or null.
 *
 *  Read from the CLI's own `models` output — the same source of truth
 *  `canListOpenCodeModels` trusts — so the default is whatever the user's
 *  installed version currently serves rather than a string this file froze
 *  when it was written. */
async function firstLiveModel(
  cli: string,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  try {
    const stdout = await runOpenCodeModels(cli, env, false);
    for (const line of stdout.split(/\r?\n/u)) {
      const candidate = line.trim();
      if (validModelSlug(candidate) && !DEPRECATED_OPENCODE_MODEL_SLUGS.has(candidate)) return candidate;
    }
  } catch {
    // An unreadable catalog is not an error here: the caller falls back to
    // reporting no models rather than inventing one.
  }
  return null;
}

let lastSuccessfulCatalog: ModelCatalog | null = null;
/** How long a "no" stands:  the CLI answered and listed nothing, or failed on
 *  its own.  Short, so a fresh `opencode auth login` is noticed within the
 *  half minute. */
const MODEL_PROBE_TTL_MS = 30_000;
/** How long a "yes" stands.  A CLI that listed models a minute ago does not stop
 *  being usable between two turns, and every re-ask is a cold boot of the CLI on
 *  a host that is often too busy to give one cheaply. */
const MODEL_PROBE_LISTED_TTL_MS = 10 * 60_000;
/** The `opencode models` budget on a host with a core to spare, and its floor
 *  under load (see `openCodeModelProbeDeadline`). */
const MODEL_PROBE_BASE_TIMEOUT_MS = 20_000;
const modelProbeCache = new Map<string, { expiresAt: number; result: Promise<boolean | undefined> }>();

export type OpenCodeCatalogLoader = (
  environment: Record<string, string | undefined>,
  cli: string,
) => Promise<ModelCatalog>;

function labelForModel(id: string): string {
  return id
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function providerLabel(id: string): string {
  if (id === "opencode") return "Zen";
  if (id === "opencode-go") return "Go";
  if (id === "openrouter") return "OpenRouter";
  return labelForModel(id);
}

function validModelSlug(value: string): boolean {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator >= value.length - 1 || /\s/u.test(value)) return false;
  return [...value].every((character) => (character.codePointAt(0) ?? 0) > 0x1f);
}

function localModelRecord(record: Record<string, unknown>): boolean {
  const api = record.api && typeof record.api === "object" && !Array.isArray(record.api)
    ? record.api as Record<string, unknown>
    : {};
  if (typeof api.url !== "string") return false;
  try {
    const host = new URL(api.url).hostname.replace(/^\[|\]$/gu, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** Parse the authoritative inventory printed by the installed OpenCode CLI.
 *
 * `models --verbose` is a sequence of `provider/model` header lines followed
 * by one JSON object. Model IDs can themselves contain `/` (OpenRouter), so
 * only the first separator identifies the provider. Older CLIs may print just
 * the headers; those still produce a usable catalog without metadata. */
export function parseOpenCodeModelsOutput(stdout: string): ModelCatalog | null {
  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  let slug: string | null = null;
  let jsonLines: string[] = [];

  const flush = () => {
    if (!slug || seen.has(slug)) return;
    const separator = slug.indexOf("/");
    const provider = slug.slice(0, separator);
    const model = slug.slice(separator + 1);
    let record: Record<string, unknown> = {};
    const raw = jsonLines.join("\n").trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          record = parsed as Record<string, unknown>;
        }
      } catch {
        // A header-only/older CLI remains useful; fall back to the model id.
      }
    }
    if (record.status === "deprecated" || DEPRECATED_OPENCODE_MODEL_SLUGS.has(slug)) return;
    const name = typeof record.name === "string" && record.name.trim()
      ? record.name.trim()
      : labelForModel(model);
    const limit = record.limit && typeof record.limit === "object" && !Array.isArray(record.limit)
      ? record.limit as Record<string, unknown>
      : {};
    const contextWindow = typeof limit.context === "number" && Number.isFinite(limit.context) && limit.context > 0
      ? Math.floor(limit.context)
      : undefined;
    seen.add(slug);
    const option: ModelCatalog["options"][number] = {
      id: slug,
      label: `${providerLabel(provider)} · ${name}`,
    };
    if (localModelRecord(record)) {
      option.custom = true;
      option.loaded = true;
    }
    if (contextWindow) option.contextWindow = contextWindow;
    options.push(option);
  };

  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (line === trimmed && validModelSlug(trimmed)) {
      flush();
      slug = trimmed;
      jsonLines = [];
      continue;
    }
    if (slug) jsonLines.push(line);
  }
  flush();

  if (!options.length) return null;
  // Prefer a first-party Zen model when the CLI offers one, because Zen is the
  // route that works with no stored credential at all — a new bot should land
  // on a model it can actually run rather than on whatever happens to be
  // listed first (a third-party provider's model, for instance, which needs a
  // key the user may never have configured).  Falls back to the first live
  // entry, which is always a model this CLI just listed.
  const preferred = options.find((option) => option.id.startsWith("opencode/"))
    ?? options.find((option) => option.id.startsWith("opencode-go/"))
    ?? options[0]!;
  return { default: preferred.id, options };
}

/** The exec budget for `opencode models`:  20 s, stretched up to three times as
 *  the host's run queue passes its core count.  It is the ACP `initialize` rule
 *  (init-deadline.ts) because it is the same cost:  the CLI's cold boot is CPU
 *  work, and this Mac routinely runs at a load average many times its core count
 *  while the fleet builds and tests, where a probe that answers in 0.4 s at rest
 *  can still miss a fixed 20 s.  Read once per probe, not re-judged while it
 *  runs. */
export function openCodeModelProbeDeadline(load: HostLoad | null = readHostLoad()): InitDeadline {
  return resolveInitDeadline({ engineBaseMs: MODEL_PROBE_BASE_TIMEOUT_MS, load });
}

/** How `opencode models` ended WITHOUT answering, or null when it answered.
 *
 *  A probe that ran out of time, or was killed or signalled before it could exit
 *  on its own, never said whether anything is signed in;  on a saturated host
 *  that is the usual failure, with the CLI itself fine.  `runOpenCodeModels`
 *  wraps execCli's error, so its flags live on `cause`;  a double that rejects
 *  with a bare execFile-shaped error (`killed`, `SIGTERM`) is read the same way.
 *  A CLI that exited by itself, even non-zero, has answered. */
function unansweredProbe(error: ProbeTimeoutError): { ranOutOfTime: boolean; signal: string | null } | null {
  const candidates: Array<ProbeTimeoutError | null> = [error, error.cause instanceof Error ? error.cause : null];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const stoppedBy = candidate.signal || null;
    if (isProbeTimeout(candidate) || candidate.killed === true) return { ranOutOfTime: true, signal: stoppedBy };
    if (stoppedBy) return { ranOutOfTime: false, signal: stoppedBy };
  }
  return null;
}

/** The engine row's sentence for a probe that never answered, kept apart from
 *  "the CLI listed no models":  the first is a busy host and the second is a CLI
 *  with nothing to offer, and they send a person to different places. */
function describeUnansweredProbe(
  how: { ranOutOfTime: boolean; signal: string | null },
  deadline: InitDeadline,
): string {
  return how.ranOutOfTime
    ? `OpenCode's model probe timed out ${describeInitDeadline(deadline)}`
    : `OpenCode's model probe was stopped by ${how.signal} before it answered`;
}

function runOpenCodeModels(
  cli: string,
  environment: Record<string, string | undefined>,
  verbose: boolean,
  timeoutMs: number = openCodeModelProbeDeadline().timeoutMs,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execCli(
      cli,
      ["models", ...(verbose ? ["--verbose"] : [])],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: environment },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message, { cause: error }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Why the last catalog probe came back empty, in words the engine row can
 *  show.  `null` once a probe has succeeded.  A probe that ran out of time says
 *  so, and at what host load, apart from a CLI that answered and listed
 *  nothing. */
let lastProbeProblem: string | null = null;

export function openCodeModelProbeProblem(): string | null {
  return lastProbeProblem;
}

/** Ask the CLI for its catalog, without assuming a flag it still has.
 *
 *  `--verbose` is what turns a bare id list into `provider/model` header lines
 *  with metadata, so the parser wants it — but it is not part of that command's
 *  contract.  opencode v2.0.26 answers `Unrecognized flag: --verbose` and exits,
 *  and that rejection used to fall through to the empty fallback catalog with
 *  nothing to say why.  A CLI that refuses the flag still answers the plain
 *  command, so ask plainly first and add the flag only if the plain answer was
 *  useless. */
async function probeOpenCodeModels(
  cli: string,
  environment: Record<string, string | undefined>,
  deadline: InitDeadline,
): Promise<string> {
  let plainProblem: string | null = null;
  const plain = await runOpenCodeModels(cli, environment, false, deadline.timeoutMs).catch((error: Error) => {
    // A plain command that never answered says nothing about the flag, so there
    // is no second form worth trying:  the retry would only double the wait on a
    // host that cannot answer in time.  Say so, rather than "listed nothing".
    const unanswered = unansweredProbe(error);
    if (unanswered) throw new Error(describeUnansweredProbe(unanswered, deadline), { cause: error });
    plainProblem = error?.message ?? String(error);
    return "";
  });
  if (plain.trim()) return plain;
  let verboseProblem: string | null = null;
  const verbose = await runOpenCodeModels(cli, environment, true, deadline.timeoutMs).catch((error: Error) => {
    verboseProblem = error?.message ?? String(error);
    return "";
  });
  if (verbose.trim()) return verbose;

  // Neither shape produced a list, and the two failures mean different things.
  // A plain command that ERRORED means the CLI itself is unusable, so its
  // message is the answer.  A plain command that RAN and printed nothing means
  // the CLI answered correctly and simply has nothing to list — and the verbose
  // failure beside it is only ever about the flag, so it is reported as context
  // rather than as the cause.  Collapsing both into one fallback string loses
  // the difference between "your CLI is broken" and "your CLI has no models",
  // which are the two things a person here is trying to tell apart.
  if (plainProblem) throw new Error(plainProblem);
  if (verboseProblem) throw new Error(`opencode models listed nothing (${verboseProblem})`);
  throw new Error("opencode models answered nothing");
}

/** Ask the same OpenCode binary that will run ACP for its effective catalog.
 * This automatically includes Zen, Go, other connected providers, custom
 * config, and anonymous free models with the exact IDs the session accepts. */
export async function discoverOpenCodeModels(
  environment: Record<string, string | undefined>,
  cli = "opencode",
  // One budget for both asks (plain, then --verbose), fixed when discovery starts.
  deadline: InitDeadline = openCodeModelProbeDeadline(),
): Promise<ModelCatalog> {
  try {
    const catalog = parseOpenCodeModelsOutput(await probeOpenCodeModels(cli, environment, deadline));
    if (!catalog) throw new Error("OpenCode returned no usable models");
    lastSuccessfulCatalog = catalog;
    lastProbeProblem = null;
    return catalog;
  } catch (error) {
    // An engine with no models and no reason reads as broken.  It is not: the
    // CLI answered and had nothing to list, and the person needs the sentence
    // that says which of the two it was.
    lastProbeProblem = error instanceof Error ? error.message : String(error);
    return lastSuccessfulCatalog ?? STATIC_MODELS;
  }
}

export function resetOpenCodeModelCache() {
  lastSuccessfulCatalog = null;
  lastProbeProblem = null;
  modelProbeCache.clear();
}

/** Compatibility export for older tests/imports while the product migrates
 * from the Go-only name. */
export const resetOpenCodeGoModelCache = resetOpenCodeModelCache;

const stripForeignProviderKeys = (env: Record<string, string | undefined>) => {
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "XAI_API_KEY",
    "KIMI_API_KEY",
    "MOONSHOT_API_KEY",
  ]) delete env[key];
};

function opencodeConfigDir(env: Record<string, string | undefined>): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
}

/** Upsert an openai-compatible provider so OpenCode can select host/model. */
export function ensureOpenCodeInjectModel(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const native = `${inject.host}/${inject.model}`;
  const dir = opencodeConfigDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "opencode.json");
  let config: Record<string, unknown> = { $schema: "https://opencode.ai/config.json" };
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      // Malformed user config — inject into a fresh object rather than fail the turn.
    }
  }
  const providers =
    config.provider && typeof config.provider === "object" && !Array.isArray(config.provider)
      ? { ...(config.provider as Record<string, unknown>) }
      : {};
  const previous = providers[inject.host];
  const existing =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? { ...(previous as Record<string, unknown>) }
      : {
          npm: "@ai-sdk/openai-compatible",
          name: host.label,
          options: {},
          models: {},
        };
  const options =
    existing.options && typeof existing.options === "object" && !Array.isArray(existing.options)
      ? { ...(existing.options as Record<string, unknown>) }
      : {};
  options.baseURL = host.baseUrl;
  if (!options.apiKey) options.apiKey = hostApiKey(host, env);
  const models =
    existing.models && typeof existing.models === "object" && !Array.isArray(existing.models)
      ? { ...(existing.models as Record<string, unknown>) }
      : {};
  if (!models[inject.model]) {
    models[inject.model] = { name: `${inject.model} (${host.label})` };
  }
  providers[inject.host] = {
    ...existing,
    npm: existing.npm || "@ai-sdk/openai-compatible",
    name: existing.name || host.label,
    options,
    models,
  };
  config.provider = providers;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return native;
}

/** Every path the OpenCode CLI may keep auth.json at.
 *
 * The CLI is xdg-flavoured on EVERY platform — `opencode auth list` on macOS
 * prints `~/.local/share/opencode/auth.json`, and that is where real logins
 * land. The platform-conventional locations are kept as fallbacks in case a
 * future CLI moves there, but the xdg path must come first: checking only
 * Library/Application Support on macOS is exactly the bug that made the app
 * demand a sign-in from users who were already signed in. */
function storedAuthPaths(env: Record<string, string | undefined>): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const roots = [
    env.XDG_DATA_HOME || join(home, ".local", "share"),
    process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : process.platform === "win32"
        ? env.LOCALAPPDATA || join(home, "AppData", "Local")
        : "",
  ].filter(Boolean);
  return [...new Set(roots)].map((root) => join(root, "opencode", "auth.json"));
}

/** True when auth.json contains any usable provider login managed by
 * OpenCode. The generic harness can run all of them, including `opencode`
 * (Zen), `opencode-go`, and third-party providers such as OpenRouter. */
function usableAuthEntry(parsed: Record<string, unknown>): boolean {
  return Object.values(parsed).some((auth) => {
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) return false;
    const entry = auth as { key?: unknown; access?: unknown; refresh?: unknown };
    return Boolean(entry.key || entry.access || entry.refresh);
  });
}

function hasStoredOpenCodeAuth(env: Record<string, string | undefined>) {
  const candidates: string[] = [];
  if (env.OPENCODE_AUTH_CONTENT) candidates.push(env.OPENCODE_AUTH_CONTENT);
  for (const path of storedAuthPaths(env)) {
    try {
      candidates.push(readFileSync(path, "utf8"));
    } catch {
      // A missing or unreadable file simply means there is no ambient login.
    }
  }
  return candidates.some((raw) => {
    try {
      return usableAuthEntry(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      return false;
    }
  });
}

/** What a remembered answer is for:  this CLI reading this login.  A yes now
 *  stands for ten minutes, so two instances that differ only in HOME or the XDG
 *  directories must not share one (the Cursor driver keys its probes the same
 *  way). */
function modelProbeCacheKey(cli: string, env: Record<string, string | undefined>): string {
  return [cli, env.HOME ?? "", env.USERPROFILE ?? "", env.XDG_DATA_HOME ?? "", env.XDG_CONFIG_HOME ?? ""].join("::");
}

/** Whether `opencode models` lists anything this harness could run:  true,
 *  false, or undefined when the probe never answered.
 *
 *  Only an answer is remembered:  a list for ten minutes, an empty list or a CLI
 *  that failed on its own for thirty seconds.  A probe that ran out of time or
 *  was killed (see `unansweredProbe`) said nothing about sign-in, so it is
 *  neither false nor cached, and the next look asks again;  the same rule as the
 *  Cursor driver's sign-in probe.  Callers that arrive while it is still running
 *  share its one process. */
export async function canListOpenCodeModels(
  env: Record<string, string | undefined>,
  cli: string,
  runModels: typeof runOpenCodeModels = runOpenCodeModels,
  deadline: InitDeadline = openCodeModelProbeDeadline(),
): Promise<boolean | undefined> {
  const cacheKey = modelProbeCacheKey(cli, env);
  const cached = modelProbeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const entry = {
    expiresAt: Number.POSITIVE_INFINITY,
    result: Promise.resolve<boolean | undefined>(undefined),
  };
  entry.result = runModels(cli, env, false, deadline.timeoutMs)
    .then((stdout): boolean | undefined => stdout
      .split(/\r?\n/u)
      .some((line) => validModelSlug(line.trim())))
    .catch((error: Error): boolean | undefined => {
      const unanswered = unansweredProbe(error);
      if (!unanswered) return false;
      console.warn(
        `[acp] opencodeGo: ${describeUnansweredProbe(unanswered, deadline)}, so sign-in is unknown and the CLI is left to judge it`,
      );
      return undefined;
    })
    .then((answer) => {
      if (answer === undefined) {
        if (modelProbeCache.get(cacheKey) === entry) modelProbeCache.delete(cacheKey);
      } else {
        entry.expiresAt = Date.now() + (answer ? MODEL_PROBE_LISTED_TTL_MS : MODEL_PROBE_TTL_MS);
      }
      return answer;
    });
  modelProbeCache.set(cacheKey, entry);
  return entry.result;
}

/** Migrate the model name published during Ox Alpha's first preview. The
 * current CLI calls the same model `x-preview-f-free`; prefer Go for an old
 * Go bot with an explicit key, otherwise use Zen's anonymous/free route. */
export function normalizeLegacyOpenCodeModel(
  model: string,
  env: Record<string, string | undefined>,
): string {
  if (model !== "opencode-go/ox-alpha-free") return model;
  return env.OPENCODE_API_KEY
    ? "opencode-go/x-preview-f-free"
    : "opencode/x-preview-f-free";
}

const support = (
  loadCatalog: OpenCodeCatalogLoader,
  runModels: typeof runOpenCodeModels,
): AcpSupport => ({
  driverKind: "opencodeGo",
  // Keep the historical driver kind so existing bots and instance config do
  // not break; only the product name/catalog expand from Go to OpenCode.
  displayName: "OpenCode",
  models: STATIC_MODELS,
  defaultCli: "opencode",
  nativeSource: "opencode.acp",
  loginNote:
    "OpenCode has no usable models — run `opencode auth login` or connect a provider in the OpenCode app",
  install: {
    command: {
      darwin: "npm install -g opencode-ai",
      linux: "npm install -g opencode-ai",
      win32: "npm install -g opencode-ai",
    },
    docsUrl: "https://opencode.ai/docs/",
    signInCommand: "opencode auth login",
    needsNode: true,
  },
  spawnArgs: () => ["acp"],
  credentialEnv: ["OPENCODE_API_KEY"],
  selectModel: { configId: "model" },
  resolveTurnModel: (model, env) => model
    ? ensureOpenCodeInjectModel(normalizeLegacyOpenCodeModel(model, env), env)
    : model,
  transformEnv: stripForeignProviderKeys,
  pickAuthMethod: () => null,
  authFailure: "continue",
  // Three answers, not two.  A key, a stored login, or a model list says yes.
  // A CLI that ANSWERED with no models (or failed on its own) says no, and the
  // pre-spawn gate refuses with `loginNote`.  A probe that ran out of time or
  // was killed said nothing at all, typically a Mac at a load many times its
  // core count with the CLI itself fine, so it is `undefined`:  the gate reads
  // that as "let the CLI itself answer" and the snapshot reports sign-in as
  // inconclusive.  That is what `authFailure: "continue"` already means for this
  // driver (it works off the CLI's ambient login and lets `opencode acp` judge
  // it), so a probe that could not judge must not refuse a turn the CLI would
  // have run;  a CLI that really is signed out still fails, with its own error.
  // A missing binary never reaches here as a timeout:  it fails to spawn at once.
  isAuthenticated: async (env, config) => {
    if (env.OPENCODE_API_KEY || hasStoredOpenCodeAuth(env)) return true;
    return canListOpenCodeModels(env, config.cli, runModels);
  },
  requireAuthenticationBeforeSpawn: true,
  classifyError: classifyOpenCodeError,
  resolveModels: async (environment, config) => {
    const catalog = await loadCatalog(environment, config.cli);
    // Prefer the catalog's own default; if it is empty or points at a model the
    // CLI no longer serves, fall back to whatever the CLI lists first.  This is
    // what keeps a bot from being handed a deprecated id it cannot run.
    const live = catalog.options.length > 0 ? catalog : null;
    const fallback = live ? null : await firstLiveModel(config.cli, environment);
    const merged = await mergeLocalInject(
      live ?? {
        default: fallback ?? "",
        options: fallback
          ? [{
            id: fallback,
            label: (() => {
              const separator = fallback.indexOf("/");
              const provider = fallback.slice(0, separator);
              const model = fallback.slice(separator + 1);
              return `${providerLabel(provider)} · ${labelForModel(model)}`;
            })(),
          }]
          : [],
      },
      environment,
    );
    if (merged.options.length > 0 && !merged.default) {
      merged.default = merged.options[0]!.id;
    }
    return merged;
  },
  buildPromptText: (turn) => turn.system ? `${turn.system}\n\n${turn.text}` : turn.text,
});

export function classifyOpenCodeError(error: unknown): ProviderErrorCode | undefined {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = value.code;
  if (code === -32000) return "invalid_credentials";
  if (code === "AUTH_REQUIRED" || code === "INVALID_API_KEY" || code === "UNAUTHORIZED") return "invalid_credentials";
  if (code === "SUBSCRIPTION_INACTIVE") return "inactive_subscription";
  if (code === "QUOTA_EXCEEDED" || code === "REGION_RESTRICTED") return "quota_or_region_restriction";
  if (code === "UPSTREAM_UNAVAILABLE" || code === "SERVICE_UNAVAILABLE") return "upstream_outage";
  if (code === "MODEL_CATALOG_UNAVAILABLE") return "model_catalog_outage";
  return undefined;
}

export const classifyOpenCodeGoError = classifyOpenCodeError;

export function createOpenCodeDriver(
  loadCatalog: OpenCodeCatalogLoader = discoverOpenCodeModels,
  runModels: typeof runOpenCodeModels = runOpenCodeModels,
) {
  return createAcpDriver(support(loadCatalog, runModels));
}

export const createOpenCodeGoDriver = createOpenCodeDriver;
export const OpenCodeDriver = createOpenCodeDriver();
export const OpenCodeGoDriver = OpenCodeDriver;
