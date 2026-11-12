import type { BuildIdentity } from "../electron/runtime-identity.mjs";
export function readSourceBuildIdentity(root: string, options?: { requireGit?: boolean; version?: string | null; build?: string | null }): BuildIdentity;
