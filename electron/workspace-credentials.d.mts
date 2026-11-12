export interface ExternalWorkspaceCredential {
  section: string;
  field: string;
  name: string;
  env: string;
}

export const WORKSPACE_CREDENTIALS: readonly ExternalWorkspaceCredential[];
export const EXTERNAL_WORKSPACE_CREDENTIALS: readonly ExternalWorkspaceCredential[];
export function assertExternalWorkspaceCredentialMarkers(
  config: unknown,
  credentials: Record<string, unknown> | undefined,
): string[];

export function migrateWorkspaceCredentials(
  config: Record<string, unknown>,
  credentials: Record<string, unknown>,
): {
  config: Record<string, unknown>;
  credentials: Record<string, unknown>;
  configChanged: boolean;
  credentialsChanged: boolean;
};
export function workspaceCredentialEnv(credentials: Record<string, unknown> | undefined): Record<string, string>;
export function markExternalWorkspaceCredentials(
  config: Record<string, unknown>,
  credentials: Record<string, unknown>,
): { config: Record<string, unknown>; changed: boolean };
export function workspaceCredentialPending(config: unknown, name: string): boolean;
export function setWorkspaceCredentialMarker(config: unknown, name: string, present: boolean): unknown;

/** Driver kind → the per-instance environment variable that driver reads its
 * API key from.  Declared in the .mjs so the desktop shell and the server
 * share one table. */
export const INSTANCE_API_KEY_ENV: ReadonlyMap<string, string>;
export function instanceKeyedDriver(entry: unknown): boolean;
