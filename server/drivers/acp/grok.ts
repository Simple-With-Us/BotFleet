// Grok Build harness support — the official `grok` CLI over ACP stdio
// (`grok … agent stdio`), on the grok.com subscription login
// (~/.grok/auth.json), NOT the xAI API key (that driver is drivers/grok.ts).
// The generic protocol runtime lives in acp/core.ts; this file is only the
// per-harness quirks. Verified against grok 1.0.0.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { classifyError } from "../retry.ts";
import { AcpModelRejectedError, createAcpDriver, type AcpSupport } from "./core.ts";

/** Hover text for the "If offered" chip on the rows below.  The Grok Build
 *  CLI answers `session/set_model` only for the models its own account lists
 *  (`grok models`, or the `session/new` model list), so a row here can be
 *  picked on an account the CLI does not serve it to.  That turn fails with
 *  the "Grok rejected model" error in `configureSession`, which names what the
 *  account is offered.  Chip text stays under ~10 chars (contracts.ts). */
const ACCOUNT_GATED_BADGE = "If offered";
const ACCOUNT_GATED_TITLE =
  "The Grok Build CLI only offers this model on accounts that have it.  " +
  "Run \"grok models\" in a terminal to see what this account can use.";

export const STATIC_GROK_MODELS: ModelCatalog = {
  default: "grok-4.7",
  options: [
    { id: "grok-4.7", label: "Grok 4.7" },
    // Same underlying Grok 4.7 served on high-performance infrastructure:
    // ~2x output speed, 2x the per-token cost of the standard tier.
    // Surface that tradeoff in the picker so the operator does not pick it
    // by accident — the chip is short on purpose (fits a narrow chat head).
    {
      id: "grok-4.7-build-fast",
      label: "Grok 4.7 Build Fast",
      badge: "2× $",
      badgeTitle: "Same Grok 4.7 model on high-performance infrastructure — 2× the output speed at 2× the per-token price.",
    },
    // Composer 2.5 is Cursor's model, selectable inside the Grok Build CLI
    // via /model (https://x.ai/news/composer-2-5).  Same id the Cursor engine
    // uses (cursor.ts), so src/lib/engine-capabilities.tsx lists it under both
    // engines to keep model-id attribution ambiguous rather than Grok's.
    // composer-2.5-fast is not listed: xAI has not documented it.
    { id: "composer-2.5", label: "Composer 2.5", badge: ACCOUNT_GATED_BADGE, badgeTitle: ACCOUNT_GATED_TITLE },
    // xAI's own coding model, public beta since 2026-05-29 and the model that
    // powers the Grok Build CLI (https://x.ai/news/grok-build-0-1).  Also an
    // xAI API id: see MODELS in ../grok.ts.
    { id: "grok-build-0.1", label: "Grok Build 0.1", badge: ACCOUNT_GATED_BADGE, badgeTitle: ACCOUNT_GATED_TITLE },
    { id: "grok-4.6", label: "Grok 4.6" },
    { id: "grok-4.5", label: "Grok 4.5" },
  ],
};

const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

function grokHome(env: Record<string, string | undefined>): string {
  if (env.GROK_HOME) return env.GROK_HOME;
  return join(env.HOME || env.USERPROFILE || homedir(), ".grok");
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

/** Local slugs from ~/.grok/config.toml, plus the current cloud lineup.
 *  `grok -m <slug>` already accepts these; the picker just didn't list them. */
export function readGrokModelCatalog(env: Record<string, string | undefined> = process.env): ModelCatalog {
  const path = join(grokHome(env), "config.toml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return STATIC_GROK_MODELS;
  }

  const options = STATIC_GROK_MODELS.options.map((o) => ({ ...o }));
  const seen = new Set(options.map((o) => o.id));
  let configuredDefault: string | null = null;
  let current: { slug: string; name?: string } | null = null;
  let inModels = false;

  const flush = () => {
    if (!current || !SLUG.test(current.slug) || seen.has(current.slug)) {
      current = null;
      return;
    }
    seen.add(current.slug);
    options.push({ id: current.slug, label: current.name || current.slug, custom: true });
    current = null;
  };

  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped === "[models]") {
      flush();
      inModels = true;
      continue;
    }
    if (stripped.startsWith("[model.") && stripped.endsWith("]")) {
      flush();
      inModels = false;
      let inner = stripped.slice("[model.".length, -1);
      if (inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
      current = { slug: inner };
      continue;
    }
    if (stripped.startsWith("[")) {
      flush();
      inModels = false;
      continue;
    }
    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) continue;
    const eq = stripped.indexOf("=");
    const key = stripped.slice(0, eq).trim();
    const value = unquote(stripped.slice(eq + 1));
    if (current && key === "name" && value) current.name = value;
    if (!current && inModels && key === "default") configuredDefault = value;
  }
  flush();

  return {
    default: configuredDefault && seen.has(configuredDefault) ? configuredDefault : STATIC_GROK_MODELS.default,
    options,
  };
}

function suggestGrokSlug(host: string, model: string, taken: Set<string>): string {
  let base = `${host}-${model}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!base || !/^[a-z]/.test(base)) base = `m-${base || "model"}`;
  let slug = base;
  let n = 2;
  while (taken.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

function quoteToml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Write a [model.slug] block so `grok -m` can reach the injected host. */
export function ensureGrokInjectSlug(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const path = join(grokHome(env), "config.toml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }

  const taken = new Set<string>(STATIC_GROK_MODELS.options.map((option) => option.id));
  let current: { slug: string; model?: string; baseUrl?: string } | null = null;
  const flush = () => {
    if (!current) return;
    taken.add(current.slug);
    if (current.model === inject.model && current.baseUrl === host.baseUrl) {
      found = current.slug;
    }
    current = null;
  };
  let found: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped.startsWith("[model.") && stripped.endsWith("]")) {
      flush();
      let inner = stripped.slice("[model.".length, -1);
      if (inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
      current = { slug: inner };
      continue;
    }
    if (stripped.startsWith("[")) {
      flush();
      continue;
    }
    if (!current || !stripped.includes("=")) continue;
    const eq = stripped.indexOf("=");
    const key = stripped.slice(0, eq).trim();
    const value = unquote(stripped.slice(eq + 1));
    if (key === "model") current.model = value;
    if (key === "base_url") current.baseUrl = value;
  }
  flush();
  if (found) return found;

  const slug = suggestGrokSlug(inject.host, inject.model, taken);
  const heading = /[^a-z0-9_-]/i.test(slug) ? `[model."${slug}"]` : `[model.${slug}]`;
  const block = [
    heading,
    `model = ${quoteToml(inject.model)}`,
    `base_url = ${quoteToml(host.baseUrl)}`,
    `name = ${quoteToml(`${inject.model} (${host.label})`)}`,
    `api_backend = "chat_completions"`,
    `api_key = ${quoteToml(hostApiKey(host, env))}`,
    "",
  ].join("\n");
  const next = text && !text.endsWith("\n") ? `${text}\n\n${block}` : `${text}${text ? "\n" : ""}${block}`;
  writeFileSync(path, next);
  return slug;
}

/** At most this many offered ids are named in the rejected-model error. */
const OFFERED_IDS_IN_ERROR = 12;

/** The reason an RPC failed.  ACP carries the specific reason in the error's
 *  `data`, and acp/core.ts keeps it off `Error.message`: grok 1.0.46 answers a
 *  model it does not serve with -32602, message "Invalid params", data
 *  "unknown model id".  Without the data the text says only "Invalid params",
 *  and drivers/retry.ts cannot read the failure as an unknown model. */
export function grokRpcReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const data = (error as { data?: unknown } | null | undefined)?.data;
  const detail = typeof data === "string" ? data.trim().slice(0, 200) : "";
  return detail && !message.includes(detail) ? `${message}: ${detail}` : message;
}

/** The error a rejected `session/set_model` becomes.  Two rules:
 *   - It keeps the CLI's own wording (`cause`, see grokRpcReason) verbatim.
 *     The retry classifier (drivers/retry.ts) reads "unknown model id" out of
 *     it to mark the failure terminal `unknown_model` instead of `unknown`;
 *     nothing here may add a phrase that an earlier arm of that classifier
 *     (auth, quota) would claim.
 *   - It names what the signed-in account IS offered.  `sessionModels` is the
 *     `session/new` model list, verbatim, so the answer is the CLI's own and
 *     needs no second probe.  Some models in this picker (Composer 2.5, Grok
 *     Build 0.1) reach only the accounts the CLI serves them to. */
export function grokRejectedModelMessage(
  model: string,
  cause: string,
  sessionModels: ReadonlyArray<{ modelId?: string; name?: string }> = [],
): string {
  const offered = [
    ...new Set(
      sessionModels
        .map((m) => (typeof m?.modelId === "string" ? m.modelId.trim() : ""))
        .filter((id) => id && id.length <= 80 && SLUG.test(id)),
    ),
  ].slice(0, OFFERED_IDS_IN_ERROR);
  const offers = offered.length ? `This account's Grok CLI offers: ${offered.join(", ")}.  ` : "";
  return (
    `Grok rejected model "${model}" via session/set_model: ${cause}.  ${offers}` +
    `Run \`grok models\` in a terminal to see everything this account can use.  ` +
    `A slug from ~/.grok/config.toml is also accepted, and \`grok update\` installs the current CLI.`
  );
}

const support: AcpSupport = {
  driverKind: "grokAgent",
  displayName: "Grok",
  images: true,
  models: STATIC_GROK_MODELS,
  resolveModels: (env) => mergeLocalInject(readGrokModelCatalog(env), env),
  // Grok's accepted levels vary by model and the CLI validates lazily — a
  // rejected level only logs and falls back. Offer the intersection shared
  // by every model in this driver's picker; notably, grok-4.5 rejects xhigh.
  effortLevels: ["low", "medium", "high"],
  defaultCli: "grok",
  nativeSource: "grok.acp",
  loginNote: "Grok CLI is not signed in — run `grok login` in a terminal",

  // No Windows one-liner: the installer is a POSIX shell script, and offering
  // `curl … | bash` there would be advice that cannot run. Windows falls back
  // to docsUrl, which is honest rather than broken.
  install: {
    command: {
      darwin: "curl -fsSL https://x.ai/cli/install.sh | bash",
      linux: "curl -fsSL https://x.ai/cli/install.sh | bash",
    },
    docsUrl: "https://x.ai/cli",
    signInCommand: "grok login",
  },

  // Write the [model.slug] block with the instance HOME/GROK_HOME, then pass
  // the slug on argv. spawnArgs must not call ensureGrokInjectSlug itself —
  // that helper defaults to process.env and would miss the instance override.
  resolveTurnModel: (model, env) => (model ? ensureGrokInjectSlug(model, env) : model),

  // --permission-mode is a global grok flag. -m and --reasoning-effort are
  // agent flags: Grok 1.0.6 only applies them when they sit AFTER `agent`
  // and BEFORE `stdio` (`grok agent -m slug stdio`). Putting -m first is
  // accepted as a TUI option and then ignored, so ACP session/new keeps
  // [models].default (grok-4.7) and oMLX never sees a request.
  spawnArgs: (config, turn) => {
    const args = [
      "--permission-mode",
      config.fullAuto ? "bypassPermissions" : "default",
      "agent",
      ...(turn.model ? ["-m", turn.model] : []),
      ...(turn.effort ? ["--reasoning-effort", turn.effort] : []),
    ];
    args.push("stdio");
    return args;
  },

  // -m on argv is necessary but not sufficient: session/new still starts on
  // [models].default. Pin the slug over the wire, same as Hermes/Droid.
  async configureSession({ request, sessionId, turn, sessionModels }) {
    if (!turn.model) return;
    try {
      await request("session/set_model", { sessionId, modelId: turn.model });
    } catch (e) {
      const reason = grokRpcReason(e);
      const message = grokRejectedModelMessage(turn.model, reason, sessionModels);
      // Only the CLI's own refusal of the id settles the turn `unknown_model`,
      // which marks the model rejected for later turns and fail-overs.  A
      // timeout or a crash during set_model says nothing about the model, so
      // it must not hide a working one for hours.
      throw classifyError({ text: reason }).reason === "unknown_model"
        ? new AcpModelRejectedError(message)
        : new Error(message);
    }
  },

  // The CLI owns its own grok.com login; a leaked API key silently flips
  // billing from the subscription to pay-as-you-go.
  transformEnv: (env) => {
    delete env.XAI_API_KEY;
  },

  // Bind the grok.com subscription login. No API-key fallback by design —
  // an unauthenticated CLI is a user action, not something to paper over.
  // OIDC disk login (auth.json) is still signed in when initialize omits
  // cached_token; acp/core proceeds on ambient login in that case.
  pickAuthMethod: (methods) => (methods.some((m) => m.id === "cached_token") ? "cached_token" : null),
  authFailure: "fail",
  // this instance's HOME, not the server process's: an instance can carry
  // its own, and probing the wrong one reports another account's login
  isAuthenticated: (env) => existsSync(join(grokHome(env), "auth.json")),

  // `--append-system-prompt`/`--rules` are accepted by the CLI but do NOT
  // reach the agent-stdio system prompt (verified against 1.0.0), so the
  // persona is prepended codex-style.
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const GrokAgentDriver = createAcpDriver(support);
