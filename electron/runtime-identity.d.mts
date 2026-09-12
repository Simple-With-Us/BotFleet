export interface BuildIdentity {
  app: "botfleet";
  version: string;
  apiVersion: number;
  sourceCommit: string;
  sourceDirty: boolean;
  uiHash: string | null;
}
export const HARNESS_API_VERSION: number;
export function validBuildIdentity(value: unknown): value is BuildIdentity;
export function readPackagedBuildIdentity(directory: string): BuildIdentity;
export function readSourceBuildIdentity(root: string): BuildIdentity;
export function hashStaticUi(directory: string | null | undefined): string | null;
export function authorizedRuntime(owner: { nonce: string }, authorization: unknown): boolean;
export function buildCompatibility(expected: unknown, actual: unknown): "incompatible" | "matching" | "bundled-ui";
