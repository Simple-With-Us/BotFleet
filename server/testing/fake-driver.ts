// In-memory ProviderDriver for registry/bus tests. Queue-free and
// deliberately tiny: tests reach into the returned handle to emit
// canonical events as if the provider produced them.
import type {
  DriverCreateInput,
  EffortLevel,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
} from "../contracts.ts";

export interface FakeDriverOptions {
  kind?: string;
  /** create() rejects with this message (shadow-downgrade path). */
  failCreate?: string;
  /** snapshot() rejects with this message (describe-downgrade path). */
  failSnapshot?: string;
  /** effort levels this fake driver declares, forwarded onto capabilities. */
  effortLevels?: readonly EffortLevel[];
  /** Catalog override — defaults to one model, `${kind}-1`. Set this to
   *  test per-model behavior (quota mapping, fallback ordering, …) across
   *  more than one catalog id. */
  models?: { default: string; options: Array<{ id: string; label: string }> };
  /** A quota verdict the DRIVER itself reports on its snapshot, the way a
   *  real driver does after its own probe comes back 402/429.  Exists so a
   *  test can prove the registry merges that verdict rather than replacing
   *  it with whatever a balance endpoint said. */
  quota?: ProviderSnapshot["quota"];
  /** Default config returned by driver.defaultConfig(). */
  defaultConfig?: Record<string, unknown> | (() => Record<string, unknown>);
}

export interface FakeDriverHandle {
  driver: ProviderDriver<Record<string, unknown>>;
  /** Live instances by instanceId, with their event-emit hook. */
  created: Map<string, { instance: ProviderInstance; emit: (e: RuntimeEvent) => void }>;
  decodedConfigs: unknown[];
  disposed: string[];
}

export function makeFakeDriver(opts: FakeDriverOptions = {}): FakeDriverHandle {
  const kind = opts.kind ?? "fake";
  const handle: FakeDriverHandle = {
    created: new Map(),
    decodedConfigs: [],
    disposed: [],
    driver: {
      driverKind: kind,
      metadata: { displayName: `Fake ${kind}` },
      models: opts.models ?? { default: `${kind}-1`, options: [{ id: `${kind}-1`, label: `${kind} one` }] },
      decodeConfig(raw: unknown) {
        if (raw && typeof raw === "object" && (raw as Record<string, unknown>).bad) {
          throw new Error(`${kind}: bad config`);
        }
        handle.decodedConfigs.push(raw);
        return (raw ?? {}) as Record<string, unknown>;
      },
      defaultConfig: () => {
        if (typeof opts.defaultConfig === "function") return { isDefault: true, ...opts.defaultConfig() };
        if (opts.defaultConfig) return { isDefault: true, ...opts.defaultConfig };
        return { isDefault: true };
      },
      async create(input: DriverCreateInput<Record<string, unknown>>): Promise<ProviderInstance> {
        if (opts.failCreate) throw new Error(opts.failCreate);
        const listeners = new Set<RuntimeEventListener>();
        // The interrupt sweep asks every instance `hasSession`.  A constant false
        // matches nothing, so a test driving the sweep through this fake would pass
        // vacuously; track the threads this fake actually started instead.
        const started = new Set<string>();
        const emit = (event: RuntimeEvent) => {
          for (const l of [...listeners]) l(event);
        };
        const instance: ProviderInstance = {
          instanceId: input.instanceId,
          driverKind: kind,
          displayName: input.displayName,
          enabled: input.enabled,
          models: handle.driver.models,
          snapshot: async (): Promise<ProviderSnapshot> => {
            if (opts.failSnapshot) throw new Error(opts.failSnapshot);
            // A fresh object per call: the registry mutates `snapshot.quota`
            // in place, and a shared literal would leak one describe()'s
            // merge into the next.
            const snapshot: ProviderSnapshot = { state: "available", version: "0.0.0-fake" };
            if (opts.quota) snapshot.quota = { ...opts.quota };
            return snapshot;
          },
          adapter: {
            provider: kind,
            capabilities: { sessionModelSwitch: "unsupported", effortLevels: opts.effortLevels },
            sendTurn: async (turn: { threadId?: string }) => {
              if (turn?.threadId) started.add(turn.threadId);
              return { turnId: "fake-turn" };
            },
            interruptTurn: async (threadId: string) => {
              started.delete(threadId);
            },
            respondToRequest: async () => "unavailable" as const, // this engine has no asks to answer
            hasSession: (threadId: string) => started.has(threadId),
            stopAll: async () => {},
            onEvent: (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          },
          dispose: async () => {
            handle.disposed.push(input.instanceId);
            listeners.clear();
          },
        };
        handle.created.set(input.instanceId, { instance, emit });
        return instance;
      },
    },
  };
  return handle;
}
