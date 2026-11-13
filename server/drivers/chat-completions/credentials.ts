// Shared "where does the API key come from?" gate for chat-completions
// drivers.  Replaces the resolved MinIMax version in drivers/minimax.ts
// and the same shape openai-compat.ts:142-149 hand-rolls, so a future
// chat-completions driver (Anthropic-via-OpenAI-compat, Together, etc.)
// inherits the correctness rule instead of rederiving it.
//
// The rule is the same on every instance:
//
//   1. The instance's OWN environment first.  injectedEnvironment() in
//      server/config.ts is the only writer of that map; it fills the key
//      from that instance's own `config.key` when it has one, and from
//      the resolved `<ENGINE>_API_KEY` env var as a fallback.  An empty
//      value here is a hard miss; we never let it shadow lower-priority
//      sources the way `||` would.
//   2. PROCESS-WIDE sources (the explicit env var, the driver's own
//      local-config file like ~/.mmx/config.json) ONLY when this is the
//      reserved instance.  process.env is one map for the whole Node
//      process; syncCredentialEnv() in config.ts copies the workspace's
//      saved key into process.env at save time so the driver picks it up,
//      which is the right thing for the built-in reservation and the
//      wrong thing for every other instance — a second connection pointed
//      at a gateway or a reseller would otherwise send the workspace's
//      real key to that endpoint as a Bearer token.
//
// The first source is `envKeyEnv` (the explicit env-var name, e.g.
// "MINIMAX_API_KEY" or "OPENAI_COMPAT_API_KEY").  The second is
// `processEnvFallback` — read once at resolve-time, never cached.  The
// third is `localConfigKey` — only present when the driver has its own
// per-machine config file (MiniMax does, via `~/.mmx/config.json`;
// openai-compat does not).
//
// Operators get no extra plumbing from this: the workspace's saved key
// still arrives via the instance environment via injectedEnvironment()
// (server/config.ts:1248), and the per-instance `config.key` the operator
// pasted in the add-engine dialog lands the same way.  The only thing
// this gate prevents is the env-var / local-config file leakage that
// existed for the second MiniMax connection before #387 closed it.

export interface LocalCredentialSource {
  /** The key this driver read out of its own per-machine config file
   *  (e.g. `~/.mmx/config.json`'s `api_key` field), or "" when the
   *  file is absent or contains no key.  Drivers without an own file
   *  pass `{ apiKey: "" }` here. */
  apiKey: string;
}

export interface ResolveChatCompletionsCredentialsInput {
  /** Map injected for THIS instance by harness/registry.  The own-key
   *  check reads `<envKeyEnv>` from here, NOT `process.env`, so a key
   *  saved into the instance config reaches the driver without leaking
   *  into the next instance. */
  environment: Record<string, string>;
  /** Env-var name carrying the API key, uppercase.  The same name is
   *  read from `environment` first and from `process.env` second; the
   *  two reads are deliberate (see class doc above). */
  envKeyEnv: string;
  /** Reserved instance id — the SINGLE instanceId the driver ships in
   *  its default fleet.  Only this instance may fall back to process.env
   *  / localConfigKey.  `grok` -> "grokAgent"'s reserved id is "grok",
   *  `MiniMax` is "minimax", openai-compat is "openaiCompat"; pass what
   *  the driver's default-fleet config names. */
  reservedInstanceId: string;
  /** The instance id this driver is being asked to resolve for. */
  instanceId: string;
  /** Optional local-config-file key (e.g. `~/.mmx/config.json`'s
   *  `api_key`).  Empty string when the driver has no per-machine file. */
  localConfigKey?: LocalCredentialSource;
}

export interface ResolvedCredentials {
  apiKey: string;
  /** True when the resolved key came from one of the workspace-wide
   *  sources (process.env or `localConfigKey.apiKey`).  False when it
   *  came from the instance's own environment.  The driver surfaces this
   *  on the snapshot's provenance and the Settings provenance card so a
   *  second instance never silently inherits the workspace's key. */
  fromWorkspace: boolean;
}

export function resolveChatCompletionsCredentials(
  input: ResolveChatCompletionsCredentialsInput,
): ResolvedCredentials {
  const envName = input.envKeyEnv;
  // (1) Instance's own environment — the contract is "empty higher-priority
  // values are skipped, not passed through to the next priority", which
  // matches `resolveMinimaxCredentials`'s original behaviour and is what
  // openai-compat.ts:142-144 builds with three explicit `??`s against the
  // same key names.  Trim guards against `KEY=""` saving an empty value.
  const own = input.environment[envName]?.trim();
  if (own) return { apiKey: own, fromWorkspace: false };
  // (2) Reserved-instance-only fallbacks.  A non-reserved instance gets
  // an empty string here: the driver refuses with `no API key …` and the
  // operator's next action is to set a key for THIS connection, not the
  // workspace.
  if (input.instanceId !== input.reservedInstanceId) {
    return { apiKey: "", fromWorkspace: false };
  }
  const envFallback = process.env[envName]?.trim();
  if (envFallback) return { apiKey: envFallback, fromWorkspace: true };
  const localKey = input.localConfigKey?.apiKey.trim();
  if (localKey) return { apiKey: localKey, fromWorkspace: true };
  return { apiKey: "", fromWorkspace: false };
}
