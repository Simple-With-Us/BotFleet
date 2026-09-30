// Codex model catalog — official ChatGPT rows stay in the main picker;
// everything the user already wired in ~/.codex (providers, profiles,
// cached catalogs, live /v1/models) is tagged `custom` so ModelPicker
// can hide it behind Custom. `codex app-server` thread/start takes
// `model` + `modelProvider` separately; picker ids encode both.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { isEffortLevel, type EffortLevel, type ModelCatalog } from "../contracts.ts";
import { killCliTree, spawnCli } from "../procs.ts";
import { mergeLocalInject } from "./local-inject.ts";

/** Chip shown on every row of the built-in fallback.  A list BotFleet wrote
 *  down is not a list Codex confirmed, so the picker says so instead of
 *  presenting the rows as current. */
const UNVERIFIED_BADGE = "Unverified";
const UNVERIFIED_BADGE_TITLE =
  "Codex could not confirm its model list just now.\u00A0 This row comes from BotFleet's built-in fallback, so the model may not be available on your account.";

const UNVERIFIED_LEVELS = ["low", "medium", "high", "xhigh"] as const;

function unverifiedRow(id: string, label: string): ModelCatalog["options"][number] {
  return {
    id,
    label,
    effortLevels: [...UNVERIFIED_LEVELS],
    supportsEffort: true,
    badge: UNVERIFIED_BADGE,
    badgeTitle: UNVERIFIED_BADGE_TITLE,
  };
}

/**
 * Compatibility rows used only when Codex cannot provide its catalog and no
 * earlier answer is on hand (neither a live probe this run nor the CLI's own
 * `models_cache.json`).  This list is a source fallback, not proof that every
 * row is available for the current account or transport, so every row carries
 * the "Unverified" chip.
 *
 * The ids are the ones the installed Codex reported as visible on
 * 2026-09-30 (CLI 0.154.0).  `gpt-6-sol`, `gpt-6-luna` and
 * `gpt-5.3-codex-spark` were listed here earlier but no Codex catalog
 * offered them, so a turn dispatched to one of them would be rejected.  When
 * a newer Codex serves them, the live catalog carries them without a BotFleet
 * release; do not add them back on a guess.
 */
export const STATIC_CODEX_MODELS: ModelCatalog = {
  default: "gpt-6-astra",
  options: [
    unverifiedRow("gpt-6-astra", "GPT-6 Astra"),
    unverifiedRow("gpt-5.6-sol", "GPT-5.6 Sol"),
    unverifiedRow("gpt-5.6-terra", "GPT-5.6 Terra"),
    unverifiedRow("gpt-5.6-luna", "GPT-5.6 Luna"),
    unverifiedRow("gpt-5.5", "GPT-5.5"),
  ],
};

/** Built-in ChatGPT / OpenAI provider id. Official picker rows force this
 *  so a user's local `model_provider = "omlx"` does not swallow GPT-5.6. */
export const OFFICIAL_CODEX_PROVIDER = "openai";

const SEP = "::";
const MODEL_ID = /^[\w][\w./:+-]*$/;
const PROVIDER_ID = /^[a-z][a-z0-9_-]*$/i;

export function encodeCodexSelection(provider: string, model: string): string {
  return `${provider}${SEP}${model}`;
}

export function decodeCodexSelection(id: string | null | undefined): {
  model: string | null;
  modelProvider: string | null;
} {
  if (!id) return { model: null, modelProvider: null };
  const sep = id.indexOf(SEP);
  if (sep > 0) {
    return { model: id.slice(sep + SEP.length), modelProvider: id.slice(0, sep) };
  }
  // Every official app-server picker row has a bare id. Custom providers are
  // always provider-qualified above, so a newly released cloud model must not
  // silently fall through to the user's configured local provider.
  return { model: id, modelProvider: MODEL_ID.test(id) ? OFFICIAL_CODEX_PROVIDER : null };
}

interface CodexAppServerModel {
  id?: unknown;
  displayName?: unknown;
  hidden?: unknown;
  isDefault?: unknown;
  supportedReasoningEfforts?: unknown;
}

/** Ask the installed Codex CLI for the ChatGPT model catalog it can actually
 * use. This is the authoritative subscription catalog and changes more often
 * than BotFleet releases, so consume every page instead of hard-coding the
 * current set forever. */
export type CodexProbeFailure = "timeout" | "rpc-error" | "write-failed" | "spawn-error" | "closed" | "empty";

export function readCodexAppServerModelCatalog(
  cli: string,
  env: Record<string, string | undefined>,
  timeoutMs = 8_000,
  /** Why the probe returned null.  The failure used to be silent, so a timeout
   *  under host load could not be told from a CLI that answered with nothing. */
  onFailure?: (reason: CodexProbeFailure) => void,
): Promise<ModelCatalog | null> {
  return new Promise((resolve) => {
    const child = spawnCli(cli, ["app-server"], {
      cwd: homedir(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let buffer = "";
    let nextId = 1;
    const models: CodexAppServerModel[] = [];
    const cursors = new Set<string>();
    const pending = new Map<number, "initialize" | "models">();

    const finish = (catalog: ModelCatalog | null, failure: CodexProbeFailure = "closed") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killCliTree(child);
      if (!catalog) {
        try {
          onFailure?.(failure);
        } catch {
          /* a diagnostics hook must never break the probe */
        }
      }
      resolve(catalog);
    };
    const request = (method: string, params: unknown, kind: "initialize" | "models") => {
      const id = nextId++;
      pending.set(id, kind);
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch {
        finish(null, "write-failed");
      }
    };
    const requestModels = (cursor: string | null) => {
      request("model/list", { cursor, limit: 100 }, "models");
    };
    const timer = setTimeout(() => finish(null, "timeout"), timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const kind = pending.get(message.id);
        if (!kind) continue;
        pending.delete(message.id);
        if (message.error) {
          finish(null, "rpc-error");
          return;
        }
        if (kind === "initialize") {
          try {
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
          } catch {
            finish(null, "write-failed");
            return;
          }
          requestModels(null);
          continue;
        }

        const page = message.result;
        if (Array.isArray(page?.data)) models.push(...page.data);
        const cursor = typeof page?.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
        if (cursor && !cursors.has(cursor)) {
          cursors.add(cursor);
          requestModels(cursor);
          continue;
        }

        const options: ModelCatalog["options"] = [];
        const seen = new Set<string>();
        let defaultModel: string | null = null;
        for (const row of models) {
          if (row.hidden === true || typeof row.id !== "string" || !MODEL_ID.test(row.id) || seen.has(row.id)) continue;
          seen.add(row.id);
          let effortLevels: EffortLevel[] | undefined;
          let supportsEffort: boolean | undefined;
          if (Array.isArray(row.supportedReasoningEfforts)) {
            const rawEfforts = row.supportedReasoningEfforts
              .map((e) =>
                typeof e === "string"
                  ? e
                  : typeof e === "object" && e
                    ? ((e as { reasoningEffort?: unknown }).reasoningEffort as string)
                    : null,
              )
              .filter(isEffortLevel);
            effortLevels = rawEfforts;
            supportsEffort = rawEfforts.length > 0;
          }
          options.push({
            id: row.id,
            label: typeof row.displayName === "string" && row.displayName.trim() ? row.displayName : row.id,
            ...(effortLevels !== undefined ? { effortLevels, supportsEffort } : {}),
          });
          if (row.isDefault === true) defaultModel = row.id;
        }
        if (!options.length) {
          finish(null, "empty");
          return;
        }
        finish({
          default: defaultModel && seen.has(defaultModel) ? defaultModel : options[0].id,
          options,
        });
      }
    });
    child.on("error", () => finish(null, "spawn-error"));
    child.on("close", () => finish(null, "closed"));
    request("initialize", { clientInfo: { name: "botfleet", version: "1" } }, "initialize");
  });
}

export function codexHome(env: Record<string, string | undefined>): string {
  if (env.CODEX_HOME) return env.CODEX_HOME;
  return join(env.HOME || env.USERPROFILE || homedir(), ".codex");
}

/** Where an official catalog came from, best first.  Only `static` is
 *  something BotFleet wrote down itself; the rest are answers Codex gave. */
export type CodexCatalogSource = "live" | "last-good" | "codex-cache" | "static";

/** Per-instance memory of the last catalog Codex itself answered with.  The
 *  caller owns it, so two instances (or two tests) never share a list. */
export interface CodexCatalogMemory {
  lastGood?: ModelCatalog;
}

/** Visible rows from Codex's own `models_cache.json`: slug, display name and
 *  reasoning efforts only, read-only.  The CLI refreshes this file itself
 *  whenever it talks to the server, so it survives a harness restart and
 *  answers when the app-server probe is too slow under host load.  Anything
 *  that is not an explicit `visibility: "list"` row is left out, which drops
 *  the hidden review and reserve rows. */
export function readCodexModelsCache(env: Record<string, string | undefined>): ModelCatalog | null {
  const raw = readText(join(codexHome(env), "models_cache.json"));
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const records = parsed && typeof parsed === "object" ? (parsed as { models?: unknown }).models : undefined;
  if (!Array.isArray(records)) return null;
  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  let defaultModel: string | null = null;
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const row = record as {
      slug?: unknown;
      display_name?: unknown;
      visibility?: unknown;
      supported_reasoning_levels?: unknown;
    };
    if (row.visibility !== "list" || typeof row.slug !== "string" || !MODEL_ID.test(row.slug) || seen.has(row.slug)) continue;
    seen.add(row.slug);
    let effortLevels: EffortLevel[] | undefined;
    if (Array.isArray(row.supported_reasoning_levels)) {
      effortLevels = row.supported_reasoning_levels
        .map((level) =>
          typeof level === "string"
            ? level
            : level && typeof level === "object"
              ? ((level as { effort?: unknown }).effort as string)
              : null,
        )
        .filter(isEffortLevel);
    }
    options.push({
      id: row.slug,
      label: typeof row.display_name === "string" && row.display_name.trim() ? row.display_name : row.slug,
      ...(effortLevels !== undefined ? { effortLevels, supportsEffort: effortLevels.length > 0 } : {}),
    });
    defaultModel ??= row.slug;
  }
  return options.length ? { default: defaultModel ?? options[0].id, options } : null;
}

function unquote(raw: string): string {
  let value = raw.trim();
  const hash = value.indexOf(" #");
  if (hash !== -1 && !(value.startsWith('"') || value.startsWith("'"))) {
    value = value.slice(0, hash).trim();
  }
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      return value.slice(1, -1).replace(/\\"/g, '"');
    }
  }
  return value;
}

interface CodexProvider {
  id: string;
  name?: string;
  baseUrl?: string;
  envKey?: string;
}

interface CodexToml {
  model?: string;
  modelProvider?: string;
  providers: CodexProvider[];
}

function parseCodexToml(text: string): CodexToml {
  const result: CodexToml = { providers: [] };
  const byId = new Map<string, CodexProvider>();
  let section: "root" | "other" | CodexProvider = "root";

  const providerFor = (id: string): CodexProvider => {
    let provider = byId.get(id);
    if (!provider) {
      provider = { id };
      byId.set(id, provider);
      result.providers.push(provider);
    }
    return provider;
  };

  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      const inner = stripped.slice(1, -1);
      const match = /^model_providers\.(.+)$/.exec(inner);
      if (match) {
        let id = match[1];
        if (id.startsWith('"') && id.endsWith('"')) id = id.slice(1, -1);
        section = PROVIDER_ID.test(id) ? providerFor(id) : "other";
      } else {
        section = "other";
      }
      continue;
    }
    const eq = stripped.indexOf("=");
    if (eq < 0) continue;
    const key = stripped.slice(0, eq).trim();
    const value = unquote(stripped.slice(eq + 1));
    if (!value) continue;
    if (section === "root") {
      if (key === "model") result.model = value;
      if (key === "model_provider") result.modelProvider = value;
      continue;
    }
    if (section === "other") continue;
    if (key === "name") section.name = value;
    if (key === "base_url") section.baseUrl = value;
    if (key === "env_key") section.envKey = value;
  }
  return result;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function providerName(provider: string, known: Map<string, CodexProvider>): string {
  return known.get(provider)?.name || provider;
}

function niceLabel(model: string, provider: string, known: Map<string, CodexProvider>, named: Map<string, string>): string {
  const encoded = encodeCodexSelection(provider, model);
  if (named.has(encoded)) return named.get(encoded)!;
  const host = providerName(provider, known);
  return host === provider ? model : `${model} (${host})`;
}

function collectCatalogNames(home: string): Map<string, string> {
  const named = new Map<string, string>();
  for (const file of listDir(join(home, "model-catalogs"))) {
    if (!file.endsWith(".json")) continue;
    const provider = basename(file, ".json").replace(/-models$/, "");
    if (!PROVIDER_ID.test(provider)) continue;
    const raw = readText(join(home, "model-catalogs", file));
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const records = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { models?: unknown }).models)
        ? (parsed as { models: unknown[] }).models
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { data?: unknown }).data)
          ? (parsed as { data: unknown[] }).data
          : [];
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      const row = record as { slug?: unknown; id?: unknown; display_name?: unknown; name?: unknown };
      const slug = typeof row.slug === "string" ? row.slug : typeof row.id === "string" ? row.id : "";
      if (!MODEL_ID.test(slug)) continue;
      const label = typeof row.display_name === "string" ? row.display_name : typeof row.name === "string" ? row.name : "";
      if (label) named.set(encodeCodexSelection(provider, slug), label);
    }
  }
  return named;
}

function idsFromModelsPayload(payload: unknown): string[] {
  const records = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : payload && typeof payload === "object" && Array.isArray((payload as { models?: unknown }).models)
        ? (payload as { models: unknown[] }).models
        : [];
  return records.flatMap((record) => {
    if (typeof record === "string") return MODEL_ID.test(record) ? [record] : [];
    if (!record || typeof record !== "object") return [];
    const id = (record as { id?: unknown; slug?: unknown }).id ?? (record as { slug?: unknown }).slug;
    return typeof id === "string" && MODEL_ID.test(id) ? [id] : [];
  });
}

async function probeProviderModels(
  provider: CodexProvider,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  if (!provider.baseUrl) return [];
  const url = `${provider.baseUrl.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = {};
  if (provider.envKey && env[provider.envKey]) {
    headers.Authorization = `Bearer ${env[provider.envKey]}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers });
    if (!response.ok) return [];
    return idsFromModelsPayload(await response.json());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export interface CodexCatalogRead {
  catalog: ModelCatalog;
  /** Where the OFFICIAL rows came from.  Local providers and injects are
   *  merged on top whatever this says. */
  source: CodexCatalogSource;
}

export interface CodexCatalogReadOptions {
  /** Last good answer to fall back on; updated on every live answer. */
  memory?: CodexCatalogMemory;
  probeTimeoutMs?: number;
  onProbeFailure?: (reason: CodexProbeFailure) => void;
}

/** Local slugs Codex already knows, plus the available official cloud rows.
 *
 *  The official rows come from the first of these that answers:
 *    1. the installed app-server's `model/list` (live),
 *    2. the last live answer this instance saw (`memory`),
 *    3. Codex's own `models_cache.json`,
 *    4. BotFleet's static rows, each marked Unverified.
 *  A probe that fails under host load therefore never swaps a list Codex
 *  confirmed for one BotFleet wrote down. */
export async function readCodexModelCatalogDetailed(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  cli?: string,
  opts: CodexCatalogReadOptions = {},
): Promise<CodexCatalogRead> {
  let official: ModelCatalog | null = cli
    ? await readCodexAppServerModelCatalog(cli, env, opts.probeTimeoutMs, opts.onProbeFailure)
    : null;
  let source: CodexCatalogSource = "live";
  if (official) {
    if (opts.memory) opts.memory.lastGood = official;
  } else if (opts.memory?.lastGood) {
    official = opts.memory.lastGood;
    source = "last-good";
  } else {
    official = readCodexModelsCache(env);
    source = "codex-cache";
  }
  if (!official) {
    official = STATIC_CODEX_MODELS;
    source = "static";
  }
  return { catalog: await mergeOfficialCatalog(official, env, fetchImpl), source };
}

export async function readCodexModelCatalog(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  cli?: string,
  opts: CodexCatalogReadOptions = {},
): Promise<ModelCatalog> {
  return (await readCodexModelCatalogDetailed(env, fetchImpl, cli, opts)).catalog;
}

async function mergeOfficialCatalog(
  official: ModelCatalog,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<ModelCatalog> {
  const home = codexHome(env);
  const mainText = readText(join(home, "config.toml"));
  if (!mainText) return mergeLocalInject(official, env, fetchImpl);

  const main = parseCodexToml(mainText);
  const known = new Map(main.providers.map((provider) => [provider.id, provider]));
  const named = collectCatalogNames(home);
  const extras: Array<{ provider: string; model: string }> = [];

  const remember = (provider: string | undefined, model: string | undefined) => {
    if (!provider || !model) return;
    if (!PROVIDER_ID.test(provider) || !MODEL_ID.test(model)) return;
    // A local provider may expose the same slug as an official OpenAI model.
    // Keep that provider-qualified row; otherwise selecting the configured
    // default would decode the bare slug back to the OpenAI provider.
    if (
      provider === OFFICIAL_CODEX_PROVIDER &&
      official.options.some((option) => option.id === model)
    ) return;
    extras.push({ provider, model });
  };

  const mainProvider = main.modelProvider ?? OFFICIAL_CODEX_PROVIDER;
  remember(mainProvider, main.model);

  for (const file of listDir(home)) {
    if (!file.endsWith(".config.toml")) continue;
    const profile = parseCodexToml(readText(join(home, file)) ?? "");
    for (const provider of profile.providers) {
      if (!known.has(provider.id)) known.set(provider.id, provider);
    }
    remember(profile.modelProvider ?? mainProvider, profile.model);
  }

  for (const [encoded, _label] of named) {
    const decoded = decodeCodexSelection(encoded);
    if (decoded.model && decoded.modelProvider) remember(decoded.modelProvider, decoded.model);
  }

  const live = await Promise.all(
    [...known.values()].map(async (provider) => {
      const ids = await probeProviderModels(provider, env, fetchImpl);
      return ids.map((model) => ({ provider: provider.id, model }));
    }),
  );
  for (const row of live.flat()) remember(row.provider, row.model);

  const options = official.options.map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    const id = encodeCodexSelection(extra.provider, extra.model);
    if (seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      label: niceLabel(extra.model, extra.provider, known, named),
      custom: true,
    });
  }

  const configured = main.model
    ? mainProvider === OFFICIAL_CODEX_PROVIDER &&
      official.options.some((option) => option.id === main.model)
      ? main.model
      : encodeCodexSelection(mainProvider, main.model)
    : null;

  return mergeLocalInject(
    {
      default: configured && seen.has(configured) ? configured : official.default,
      options,
    },
    env,
    fetchImpl,
  );
}
