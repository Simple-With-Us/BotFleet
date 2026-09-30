// Local model host ids and the `host::model` id shape, shared by the harness
// (server/drivers/local-inject.ts owns the URLs and keys behind each host) and
// by the desktop picker (src/lib/local-models.ts), which has to recognise an
// injected local model without importing any Node-only code.
//
// The host ids here and the LOCAL_HOSTS table in local-inject.ts are pinned to
// each other by server/drivers/local-inject.test.ts, so adding a host in one
// place and forgetting the other fails the build instead of shipping a picker
// that cannot see the new host's models.

export const INJECT_SEP = "::";

export const LOCAL_HOST_IDS = [
  "omlx",
  "ollama",
  "local_ollama",
  "exo",
  "lmstudio",
  "unsloth",
  "unsloth_api",
] as const;

/** What a local host may call one of its models. */
export const INJECT_MODEL_ID = /^[\w][\w./:+-]*$/;

const HOST_IDS: ReadonlySet<string> = new Set(LOCAL_HOST_IDS);

/** Split a `host::model` id into its parts, or null when `id` is anything else
 * (an official catalog id, a settings leftover, a host this build does not
 * know). */
export function decodeInjectId(id: string | null | undefined): { host: string; model: string } | null {
  if (!id) return null;
  const sep = id.indexOf(INJECT_SEP);
  if (sep <= 0) return null;
  const host = id.slice(0, sep);
  const model = id.slice(sep + INJECT_SEP.length);
  if (!HOST_IDS.has(host) || !INJECT_MODEL_ID.test(model)) return null;
  return { host, model };
}
