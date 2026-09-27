// Async orchestration for adding/removing a user-defined OpenAI-compatible
// engine, factored out of src/components/EnginesSettings.tsx so it can be
// unit-tested without dragging in that component's tree — EnginesSettings
// imports ProviderMark (./ProviderIcons), which pulls in root-relative image
// assets (e.g. "/codex-mark.png") that vitest's Node-environment asset
// resolution mishandles cross-platform (a bare "file:///codex-mark.png" is a
// valid-looking POSIX path but an invalid Windows file URL, so importing the
// component tree at all broke the Windows CI job). None of that belongs
// anywhere near this file: it is plain async control flow with no React, no
// DOM, and no icons.

/** Dependencies createCustomEngine/deleteCustomEngine need, injected rather
 * than reached for directly (`api`, `window.ogb`) — this repo has no
 * component-render test harness (no React Testing Library), so the async
 * orchestration a bug actually lives in — not a pure value transform — is
 * pulled out where plain `vi.fn()` mocks can exercise it, the same way
 * `server/harness/registry.test.ts` injects a fake driver instead of a real
 * one. */
export type EngineCredentialDeps = {
  createInstance: (
    body: {
      name: string;
      endpoint: string;
      /** `driverKind` of the engine this instance rides. Omitted entirely for
       * openai-compat, which is the route's own default — the body an older
       * client sends is byte-for-byte what it always sent. */
      driver?: string;
      key?: string;
      models: string[];
      iconUrl?: string;
    },
    /** `secretStorage: "external"` tells the route the key is not in the body
     * because it is about to be committed to the desktop's encrypted store.
     * The route refuses a keyless create without it — an engine with no key
     * from either source could only fail every turn. */
    options?: { secretStorage?: "external" },
  ) => Promise<{ instanceId: string }>;
  deleteInstance: (instanceId: string) => Promise<unknown>;
  /** Absent entirely outside the desktop shell — the dev/browser fallback
   * never routes a key through the encrypted store. */
  setInstanceCredential?: (instanceId: string, value: string) => Promise<void>;
  /** Purge the encrypted store's copy of an instance's key WITHOUT touching
   * the live harness — deleteCustomEngine's own concern, and deliberately a
   * different operation from setInstanceCredential(id, ""): that one PATCHes
   * the live instance (which no longer exists once the engine is deleted,
   * and reloads the provider if it still does — see deleteCustomEngine's own
   * comment on why that ordering was the bug). Absent outside the desktop
   * shell, same as setInstanceCredential — the dev fallback never wrote to
   * the encrypted store in the first place, so there is nothing to purge. */
  clearInstanceCredential?: (instanceId: string) => Promise<void>;
};

/** Create a custom engine, then — only when the encrypted-credential bridge
 * exists and a key was entered — hand that key to the encrypted store under
 * the id the server just minted. If that second step fails, the instance
 * that step one already created is deleted before the error propagates: a
 * half-created, keyless engine must not linger in the list (the normal path
 * never leaves one behind), and a retry must not mint a second "Engine-2"
 * alongside it. */
export async function createCustomEngine(
  deps: EngineCredentialDeps,
  input: { name: string; endpoint: string; driver?: string; key: string; models: string[]; iconUrl?: string },
): Promise<{ instanceId: string }> {
  const hasBridge = Boolean(deps.setInstanceCredential);
  const body: Parameters<EngineCredentialDeps["createInstance"]>[0] = {
    name: input.name,
    endpoint: input.endpoint,
    key: hasBridge ? undefined : input.key || undefined,
    models: input.models,
    iconUrl: input.iconUrl,
  };
  // Sent only when it is not the route's own default, so the body an older
  // client produced stays byte-for-byte what it always was.
  if (input.driver && input.driver !== "openai-compat") body.driver = input.driver;
  // Declared only when there is actually a key to commit.  Declaring it for a
  // deliberately anonymous engine (a local Ollama on the desktop, where the
  // bridge exists but no key was typed) would mark the instance as waiting
  // for a credential that is never coming, and refuse its every turn.
  const created = await deps.createInstance(
    body,
    hasBridge && input.key ? { secretStorage: "external" } : undefined,
  );
  if (hasBridge && input.key) {
    try {
      await deps.setInstanceCredential!(created.instanceId, input.key);
    } catch (credentialError) {
      await deps.deleteInstance(created.instanceId).catch(() => {});
      const reason = credentialError instanceof Error ? credentialError.message : String(credentialError);
      // NBSP, not two ASCII spaces — this renders straight into a plain
      // <div> in the modal, where white-space:normal collapses a run of
      // ordinary spaces to one (see server/secret-persistence.test.ts's
      // "renders its sentence gaps with NBSP" for the same rule elsewhere
      // in this app).
      throw new Error(`Could not save the encrypted key, so the new engine was removed.  ${reason}`);
    }
  }
  return created;
}

/** Delete a custom engine, THEN purge the encrypted store's copy of its key.
 *
 * Delete first, not purge first: an earlier version purged first, on the
 * theory that a later engine reusing the same name (same slug, same
 * instance id) must never have the deleted one's key replayed into it. That
 * is true, but purging first defeated a DIFFERENT safety check instead —
 * clearing a packaged instance's key PATCHes the live harness
 * (?secretStorage=external), which reloads that provider and settles any
 * bot currently mid-turn on it as no-longer-busy. The DELETE route's own
 * 409 guard ("cannot delete engine while a bot using it is working") reads
 * that same busy flag, so purging first silently defeated it — and if the
 * route then refused the delete anyway (no replacement engine available),
 * the instance was left configured with its key already gone.
 *
 * Deleting first lets the route's busy-bot and no-replacement guards see
 * accurate state and run first, exactly as if no credential existed.  Only
 * once the delete has actually succeeded does the key get purged — the
 * server's own delete handler already drops the live, in-memory override at
 * that point; this purges the encrypted store's copy so a same-named future
 * engine cannot inherit it, matching the same intent the earlier ordering
 * was reaching for. A failed purge is surfaced but does not undo the
 * delete — the visible engine is already gone either way. */
export async function deleteCustomEngine(
  deps: EngineCredentialDeps,
  instanceId: string,
): Promise<{ credentialClearError: string | null }> {
  await deps.deleteInstance(instanceId);
  let credentialClearError: string | null = null;
  if (deps.clearInstanceCredential) {
    try {
      await deps.clearInstanceCredential(instanceId);
    } catch (e) {
      credentialClearError = e instanceof Error ? e.message : String(e);
    }
  }
  return { credentialClearError };
}

// ── Which engine a new instance rides ─────────────────────────────────
// `POST /api/instances` accepts any registered driver that declares
// `supportsMultipleInstances`; these are the two the Add Engine form offers,
// because they are the two a person can finish configuring from a form — an
// endpoint and a key, no CLI to install and no interactive sign-in. The
// shapes below are the renderer's copy of what that route validates, kept
// deliberately small for the same reason src/lib/secret-source.ts keeps its
// own copy of the server's source union: the renderer cannot import a server
// module, and a test on each side is cheaper than a shared build step.

export interface AddEngineDriverOption {
  /** `driverKind` on the wire — what the POST body's `driver` field carries. */
  driver: string;
  /** Title Case: this is a button label. */
  label: string;
  /** Sentence case: the line under the picker. */
  blurb: string;
  endpointPlaceholder: string;
  /** Offered as the endpoint when the field is still empty. */
  suggestedEndpoint?: string;
  /** True when the operator has to name the models: the driver has no
   * catalog it can trust for an endpoint it has never seen. MiniMax ships
   * its own published catalog, so asking would only invite typos. */
  requiresModels: boolean;
  /** True when the driver reads a custom icon out of its config and exposes
   * it on the live instance.  Only openai-compat does; the route refuses an
   * icon for anything else rather than persisting one nothing renders. */
  supportsIcon: boolean;
  /** True when a keyless instance could only ever fail.  False only for
   * openai-compat, where an endpoint needing no auth at all — Ollama, LM
   * Studio, vLLM — is a first-class use; that is safe because the driver
   * refuses to fall back to the workspace key for a non-reserved instance. */
  requiresKey: boolean;
}

export const ADD_ENGINE_DRIVERS: readonly AddEngineDriverOption[] = [
  {
    driver: "openai-compat",
    label: "OpenAI-Compatible",
    blurb: "Any endpoint that speaks the OpenAI chat/completions shape — OpenRouter, Groq, Together, Ollama, vLLM, LM Studio.",
    endpointPlaceholder: "https://api.together.xyz/v1 or http://localhost:11434/v1",
    requiresModels: true,
    requiresKey: false,
    supportsIcon: true,
  },
  {
    driver: "minimax",
    label: "MiniMax",
    blurb: "A second MiniMax connection with its own key and endpoint — the China host, a gateway, or a separate billing account.",
    endpointPlaceholder: "https://api.minimax.io/v1 or https://api.minimaxi.com/v1",
    suggestedEndpoint: "https://api.minimaxi.com/v1",
    requiresModels: false,
    requiresKey: true,
    supportsIcon: false,
  },
];

export function addEngineDriverOption(driver: string): AddEngineDriverOption {
  return ADD_ENGINE_DRIVERS.find((option) => option.driver === driver) ?? ADD_ENGINE_DRIVERS[0];
}

/** Everything the Add Engine form refuses before it ever reaches the server,
 * as one pure function: the modal shows the string, the server re-checks it
 * all anyway. Returns null when the form is good to send. */
export function validateAddEngine(input: {
  driver: string;
  name: string;
  endpoint: string;
  key: string;
  models: string[];
}): string | null {
  if (!input.name.trim()) return "Engine name is required";
  if (!input.endpoint.trim()) return "Endpoint URL is required";
  const option = addEngineDriverOption(input.driver);
  // A paid hosted API is given no workspace credential for a connection the
  // operator added, so one without a key of its own could only fail every
  // turn.  The server refuses it too; this is the same rule said earlier.
  if (option.requiresKey && !input.key.trim()) return "An API key is required";
  if (option.requiresModels && input.models.length === 0) {
    return "At least one model ID is required (e.g. meta-llama/llama-3.3-70b-instruct)";
  }
  if (input.models.length > 15) return "At most 15 model IDs can be configured";
  return null;
}

/** The reserved instance id for each driver whose reserved id is not simply
 * its own kind. The renderer's copy of server/harness/registry.ts's own table
 * — the server already sets `isCustom` on every described instance, and this
 * is the fallback for a payload that predates it.
 *
 * A driver missing from BOTH tables falls through to "reserved id equals the
 * driver kind", which is how the default fleet names every other instance.
 * That is the safe answer: an unlisted driver's second instance reads as
 * operator-added and offers a delete button, rather than hiding one for an
 * engine the operator really did add. */
const RESERVED_INSTANCE_ID = new Map<string, string>([
  ["openai-compat", "openaiCompat"],
  ["claudeAgent", "claude"],
  ["grokAgent", "grok"],
  ["dshAgent", "dsh"],
  ["droidAgent", "droid"],
  ["cursorAgent", "cursor"],
  ["antigravityAgent", "antigravity"],
  ["boxAgent", "computer"],
  ["kimiAgent", "kimi"],
  ["qwenAgent", "qwen"],
  ["hermesAgent", "hermes"],
  ["piAgent", "pi"],
]);

export function isCustomEngineInstance(instance: {
  driverKind: string;
  instanceId: string;
  isCustom?: boolean;
}): boolean {
  if (instance.isCustom) return true;
  return instance.instanceId !== (RESERVED_INSTANCE_ID.get(instance.driverKind) ?? instance.driverKind);
}

/** What a driver calls itself, for copy that has to name the engine behind an
 * operator-added instance.  Mirrors each driver's own `metadata.displayName`
 * for the kinds this file already tracks above; anything else is humanized
 * from the kind itself (`fooAgent` → `Foo`), which is a plain, honest name
 * rather than a claim about what that endpoint speaks. */
const DRIVER_DISPLAY_NAME = new Map<string, string>([
  ["openai-compat", "OpenAI-Compatible"],
  ["minimax", "MiniMax"],
  ["claudeAgent", "Claude"],
  ["grokAgent", "Grok"],
  ["dshAgent", "DeepSeek"],
  ["deepseekAgent", "DeepSeek"],
  ["droidAgent", "Droid"],
  ["cursorAgent", "Cursor"],
  ["antigravityAgent", "Antigravity"],
  ["boxAgent", "Computer"],
  ["kimiAgent", "Kimi"],
  ["qwenAgent", "Qwen"],
  ["hermesAgent", "Hermes"],
  ["piAgent", "pi"],
]);

export function driverDisplayName(driverKind: string): string {
  const known = DRIVER_DISPLAY_NAME.get(driverKind);
  if (known) return known;
  const base = driverKind.replace(/Agent$/, "").trim();
  if (!base) return driverKind;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Heading for the "this one was added by you" callout on an engine row.
 * It used to say "OpenAI-Compatible" unconditionally, which is wrong copy on
 * a second MiniMax connection — and, since `isCustomEngineInstance` was
 * widened to answer true for ANY unlisted driver's non-reserved instance id,
 * wrong on every one of those too: a hand-declared second `claudeAgent`
 * instance is not an OpenAI-compatible engine and never speaks that shape.
 * Only `openai-compat` gets that heading; every other driver's extra instance
 * is named after the driver it actually rides. */
export function customEngineCalloutTitle(driverKind: string): string {
  if (driverKind === "openai-compat") return "Custom OpenAI-Compatible Engine.";
  return `Added ${driverDisplayName(driverKind)} Connection.`;
}
