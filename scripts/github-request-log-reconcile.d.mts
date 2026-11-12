/** Public interface of the dependency-free GET-only recovery CLI. */
export interface ReconcileOptions {
  org?: string;
  repo?: string;
  hook: string;
  log: string;
  cursor: string;
  get?: (path: string) => { data: unknown; next?: string };
  now?: () => Date;
  maxPages?: number;
}
export function reconcile(options: ReconcileOptions): {
  scanned: number;
  recovered: number;
  pending: number;
  ok: boolean;
};
export function loggedDeliveryIds(path: string): Set<string>;
/** Vendor-owned fields remain untrusted until the CLI text/integer guards. */
export interface GitHubRecoveryFields {
  action?: unknown;
  repository?: { full_name?: unknown } | null;
  sender?: { login?: unknown } | null;
  pull_request?: { number?: unknown } | null;
  issue?: { number?: unknown } | null;
  discussion?: { number?: unknown } | null;
  release?: { number?: unknown } | null;
  check_run?: { number?: unknown } | null;
  ref?: unknown;
  comment?: { html_url?: unknown } | null;
  review?: { html_url?: unknown } | null;
}
export type GitHubRecoveryPayload = GitHubRecoveryFields | string | number | boolean | null;
export function extractMetadata(payload: GitHubRecoveryPayload, eventName?: string): {
  action?: string;
  repository?: string;
  actor?: string;
  number?: number;
  sourceUrl?: string;
  ref?: string;
};
