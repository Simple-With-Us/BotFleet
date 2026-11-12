// The API Keys panel's rows for the engines that are configured with an
// endpoint and a key rather than a CLI login — the two drivers that declare
// `install.apiKeyOnly` today, OpenAI-compatible and MiniMax.
//
// Pure, and in src/lib for the same reason custom-engine.ts is: this repo has
// no component-render harness (no React Testing Library, and vitest's
// `include` does not even pick up `.tsx` test files), so the rules a bug
// actually lives in — which half of a save goes through the encrypted store,
// when a blank field means "clear" versus "leave it alone" — are pulled out
// where plain unit tests can exercise them.

/** The `window.ogb.setCredential` slot each engine's key occupies.  Must stay
 * in step with CREDENTIAL_PATCH in electron/main.mjs and WORKSPACE_CREDENTIALS
 * in electron/workspace-credentials.mjs; the test below pins the pair. */
export type EngineCredentialName = "openaiCompatApiKey" | "minimaxApiKey";

export type ApiKeyEngineId = "openaiCompat" | "minimax";

export interface ApiKeyEngineSpec {
  /** The `AppConfig` section, and the key of `ConfigStatus` that reports it. */
  id: ApiKeyEngineId;
  /** Title Case: this is a section heading. */
  label: string;
  credentialName: EngineCredentialName;
  /** `SECRET_FIELDS` ids, so each field can carry its own provenance badge. */
  keyFieldId: string;
  urlFieldId: string;
  keyPlaceholder: string;
  urlPlaceholder: string;
  /** Sentence case: what an empty endpoint field means for this engine. */
  defaultUrlNote: string;
  docsUrl: string;
}

export const API_KEY_ENGINES: readonly ApiKeyEngineSpec[] = [
  {
    id: "openaiCompat",
    label: "OpenAI-Compatible",
    credentialName: "openaiCompatApiKey",
    keyFieldId: "openaiCompat.key",
    urlFieldId: "openaiCompat.url",
    keyPlaceholder: "sk-or-v1-…",
    urlPlaceholder: "https://openrouter.ai/api/v1",
    defaultUrlNote: "Leave blank to use the driver's own default endpoint.",
    docsUrl: "https://openrouter.ai/keys",
  },
  {
    id: "minimax",
    label: "MiniMax",
    credentialName: "minimaxApiKey",
    keyFieldId: "minimax.key",
    urlFieldId: "minimax.url",
    keyPlaceholder: "Your MiniMax API key",
    urlPlaceholder: "https://api.minimax.io/v1",
    // NBSP, not two ASCII spaces — this renders into a plain <div>, where
    // white-space:normal collapses a run of ordinary spaces to one.
    defaultUrlNote:
      "Leave blank for MiniMax's global host.  Use https://api.minimaxi.com/v1 for the China host.",
    docsUrl: "https://platform.minimax.io",
  },
];

export function apiKeyEngineSpec(id: ApiKeyEngineId): ApiKeyEngineSpec {
  const found = API_KEY_ENGINES.find((engine) => engine.id === id);
  if (!found) throw new Error(`no API-key engine spec for ${id}`);
  return found;
}

/** What the row says about the key it holds.
 *
 * `pending` is its own state, not a flavour of "not set": in the packaged app
 * the encrypted store holds the key and its replay has not reached the
 * harness yet, so the key is saved and simply not in effect this second.
 * Reporting that as "Not set" invites the operator to paste it again. */
export interface EngineKeyStatus {
  label: "Saved" | "Waiting for this computer" | "Not set";
  tone: "ok" | "waiting" | "unset";
}

export function engineKeyStatus(
  status: { configured?: boolean; pending?: boolean } | undefined,
): EngineKeyStatus {
  if (status?.pending) return { label: "Waiting for this computer", tone: "waiting" };
  if (status?.configured) return { label: "Saved", tone: "ok" };
  return { label: "Not set", tone: "unset" };
}

/** One engine's own section of `AppConfig`, and nothing else — the row saves
 * the section it owns, never a whole config. */
export interface EngineKeySection {
  key?: string;
  url?: string;
}

export type EngineKeyPatch = Record<string, EngineKeySection>;

export interface EngineKeySave {
  /** The part that travels over `PUT /api/config`.  Null when this save has
   * nothing for it: the endpoint is unchanged, so only the key is moving. */
  configPatch: EngineKeyPatch | null;
  /** The key to hand to `window.ogb.setCredential`, with the slot name, or
   * null when there is no bridge or no key in this save. */
  bridgeSecret: { name: EngineCredentialName; value: string } | null;
}

/** Split one row's Save into the half that goes through plain HTTP and the
 * half that goes through the OS-encrypted store.
 *
 * Three rules, each of which has a reason the others do not:
 *
 * - The endpoint travels over PATCH, and ONLY when it actually changed.  It
 *   is configuration, not a credential — `/api/config` echoes it back, the
 *   Secrets card shows it, and `credential:set` carries one secret field
 *   anyway.  Re-sending an unchanged one is not merely wasteful: when the
 *   vault manages `<engine>.url` with Write Through off, `/api/config`
 *   refuses any save that names it, so a key-only save would 409 on an
 *   endpoint the operator never touched.
 * - A blank key field means "leave the saved key alone", never "clear it".
 *   `/api/config` never echoes a key back, so an untouched field is blank on
 *   every load; sending `""` would wipe a saved key the moment somebody
 *   changed the endpoint beside it.  Clearing is an explicit action
 *   (`clear: true`), exactly as the Secret Store card treats its client
 *   secret.
 * - An explicit clear goes through the bridge too when there is one, because
 *   the store is where the value actually lives; the bridge's own handler
 *   deletes the entry and writes the same empty tombstone to config.json. */
export function splitEngineKeySave(input: {
  engine: ApiKeyEngineSpec;
  key: string;
  url: string;
  /** The endpoint already in effect, from `GET /api/config`.  An unchanged
   * one is left out of the patch entirely. */
  savedUrl: string;
  hasBridge: boolean;
  /** True when this Save is the operator explicitly clearing the key. */
  clear?: boolean;
}): { ok: true; save: EngineKeySave } | { ok: false; error: string } {
  const url = input.url.trim();
  if (url && !isAbsoluteHttpUrl(url)) {
    return { ok: false, error: "Endpoint must be an absolute http:// or https:// URL." };
  }
  const key = input.key.trim();
  const sending = input.clear ? "" : key;
  const hasKeyHalf = input.clear || key.length > 0;
  const urlChanged = url !== input.savedUrl.trim();

  const section: EngineKeySection = {};
  if (urlChanged) section.url = url;
  if (hasKeyHalf && !input.hasBridge) section.key = sending;
  const configPatch = Object.keys(section).length
    ? ({ [input.engine.id]: section } satisfies EngineKeyPatch)
    : null;

  return {
    ok: true,
    save: {
      configPatch,
      bridgeSecret:
        hasKeyHalf && input.hasBridge ? { name: input.engine.credentialName, value: sending } : null,
    },
  };
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}


/** Apply one row's split save, in the order that fails safest.
 *
 * The two halves cannot travel together — `credential:set` carries exactly
 * one secret field — so one of them lands first, and which one matters.
 *
 * The KEY goes first.  Endpoint-first means that if the credential call then
 * fails, the instance is left pointing at the new endpoint while still
 * holding the OLD key, and the next turn sends that key somewhere the
 * operator has not yet authorised it for.  Key-first leaves the reverse
 * partial state — the new key against the endpoint that key already had —
 * which is where it was going to be sent anyway.
 *
 * There is no rollback for the key half, and deliberately so: undoing it
 * would mean re-sending the PREVIOUS key, which this row has never been
 * given (a key is never echoed back).  So a failure after the key landed is
 * REPORTED as exactly that, rather than silently leaving the operator to
 * guess which half took. */
export async function applyEngineKeySave(
  save: EngineKeySave,
  deps: {
    patchConfig: (patch: EngineKeyPatch) => Promise<unknown>;
    setCredential: (name: EngineCredentialName, value: string) => Promise<unknown>;
  },
): Promise<{ ok: true; status: unknown } | { ok: false; error: string; keySaved: boolean }> {
  let status: unknown = null;
  if (save.bridgeSecret) {
    try {
      status = await deps.setCredential(save.bridgeSecret.name, save.bridgeSecret.value);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), keySaved: false };
    }
  }
  if (save.configPatch) {
    try {
      status = await deps.patchConfig(save.configPatch);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // NBSP, not two ASCII spaces — this renders into a plain <div>, where
      // white-space:normal collapses a run of ordinary spaces to one.
      return save.bridgeSecret
        ? { ok: false, error: `The key was saved, but the endpoint was not.\u00A0 ${reason}`, keySaved: true }
        : { ok: false, error: reason, keySaved: false };
    }
  }
  return { ok: true, status };
}
