import { instanceKeyedDriver, WORKSPACE_CREDENTIALS } from "./workspace-credentials.mjs";

const FIELDS = [
  ...WORKSPACE_CREDENTIALS,
  { section: "composio", field: "apiKey", name: "composioApiKey", env: "COMPOSIO_API_KEY" },
];

/** Restore is hydration, never a settings edit.  Existing resolved values
 * (including Infisical) win over an older encrypted desktop copy. */
export function planCredentialRestore(values, config) {
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Invalid credential restore payload");
  const fields = new Map(FIELDS.map((field) => [field.name, field]));
  const env = {};
  const restored = [];
  const retained = [];
  for (const [name, value] of Object.entries(values)) {
    const field = fields.get(name);
    if (!field || typeof value !== "string" || !value.trim() || value.length > 16_384) {
      throw new Error("Invalid credential restore payload");
    }
    if (config?.[field.section]?.[field.field]) retained.push(name);
    else {
      env[field.env] = value;
      restored.push(name);
    }
  }
  return { env, restored, retained };
}

export function workspaceRestorePayload(credentials) {
  return Object.fromEntries(FIELDS.flatMap(({ name }) => {
    const value = credentials?.[name];
    return typeof value === "string" && value.trim() ? [[name, value]] : [];
  }));
}

/** Persist only the fact that an existing custom engine has a key in the
 * desktop's encrypted store.  The marker lets a standalone harness refuse a
 * keyless dispatch after restart; no credential value crosses this boundary. */
export function markExternalInstanceCredentials(config, instanceIds) {
  const next = structuredClone(config ?? {});
  const instances = next?.instances;
  if (!instances || typeof instances !== "object" || Array.isArray(instances)) {
    return { config: next, changed: false };
  }
  let changed = false;
  for (const id of instanceIds ?? []) {
    const entry = instances[id];
    // Every driver that keeps a per-instance key, not just the first one that
    // ever did: a MiniMax connection whose key lives in credentials.bin needs
    // the same durable marker, or a relaunch finds it keyless and unmarked —
    // which reads as an intentionally anonymous engine and dispatches turns.
    if (!instanceKeyedDriver(entry)) continue;
    const current = entry.config && typeof entry.config === "object" && !Array.isArray(entry.config)
      ? entry.config
      : {};
    if (current.credentialStorage === "external") continue;
    entry.config = { ...current, credentialStorage: "external" };
    changed = true;
  }
  return { config: next, changed };
}

/** The owner proof precedes every credential-bearing request.  Redirects
 * and response bodies can never leak credentials through diagnostics. */
export async function restoreWorkspaceCredentials({ port, owner, credentials, verifyOwner, fetchImpl = fetch }) {
  const values = workspaceRestorePayload(credentials);
  if (!Object.keys(values).length) return "empty";
  if (!owner || owner.port !== port || !(await verifyOwner(owner))) return "unavailable";
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/runtime/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.nonce}` },
      body: JSON.stringify(values),
      redirect: "error",
      signal: AbortSignal.timeout(65_000),
    });
    await response.arrayBuffer();
    return response.ok ? "restored" : response.status === 409 ? "busy" : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** Custom keys share the same restore-only contract.  Missing instances are
 * returned to the serialized credential transaction for encrypted cleanup. */
export async function restoreInstanceCredentials({ port, owner, credentials, verifyOwner, fetchImpl = fetch }) {
  const missing = [];
  for (const [id, key] of Object.entries(credentials?.instanceKeys ?? {})) {
    if (!/^[\w.-]+$/.test(id) || typeof key !== "string" || !key) continue;
    if (!owner || owner.port !== port || !(await verifyOwner(owner))) return { outcome: "unavailable", missing };
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/api/instances/${encodeURIComponent(id)}?secretStorage=external&restore=1`, {
        method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${owner.nonce}` },
        body: JSON.stringify({ key }), redirect: "error", signal: AbortSignal.timeout(30_000),
      });
      await response.arrayBuffer();
      if (response.status === 404) missing.push(id);
      else if (!response.ok) return { outcome: response.status === 409 ? "busy" : "unavailable", missing };
    } catch { return { outcome: "unavailable", missing }; }
  }
  return { outcome: "restored", missing };
}
