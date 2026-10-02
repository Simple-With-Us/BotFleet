// Type surface of config-file-lock.mjs for the server's TypeScript.  The
// implementation stays plain JavaScript so the packaged Electron process
// can load it without a build step; keep this file in step with it.

export const CONFIG_LOCK_STALE_MS: number;
export const CONFIG_LOCK_TIMEOUT_MS: number;

export interface ConfigLockOptions {
  /** Reclaim a lock older than this many milliseconds even if its pid is alive. */
  staleMs?: number;
  /** Give up (throw) after waiting this many milliseconds for the lock. */
  timeoutMs?: number;
}

export interface ConfigFileSetAside {
  /** The config file that could not be used. */
  path: string;
  /** Where it went, or null when another process had already moved it. */
  setAsidePath: string | null;
  /** Why it could not be used, safe to log: never a fragment of the file. */
  reason: string;
}

export interface UpdateConfigFileOptions extends ConfigLockOptions {
  /** Mode for the written file (default 0o600). */
  mode?: number;
  /** Epoch milliseconds used to name a set-aside file (default Date.now()). */
  now?: number;
  /** Told when an unusable file was renamed aside just before being replaced.
   * Default: one console.warn line. */
  onSetAside?: (info: ConfigFileSetAside) => void;
}

export type ConfigFileObject = Record<string, unknown>;

export interface ConfigFileLock {
  /** Release the lock; leaves it alone if the usable lease is over or a peer took it over. */
  release(): void;
  /** Throw unless this handle still owns the lock and its usable lease has not run out. */
  assertHeld(): void;
}

export function lockPathFor(configPath: string): string;
export function acquireConfigFileLock(configPath: string, options?: ConfigLockOptions): ConfigFileLock;
export function withConfigFileLock<T>(configPath: string, fn: (lock: ConfigFileLock) => T, options?: ConfigLockOptions): T;
export function readConfigFile(configPath: string): ConfigFileObject;
export function writeFileAtomic(
  path: string,
  data: string,
  options?: { mode?: number; beforeRename?: () => void },
): void;
export function updateConfigFile(
  configPath: string,
  mutate: (disk: ConfigFileObject) => ConfigFileObject | null | undefined,
  options?: UpdateConfigFileOptions,
): ConfigFileObject;
