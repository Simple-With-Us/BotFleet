import type { Server } from "node:http";
export function createOwnerGate(options?: {
  owners?: Set<string> | string; publicOrigin?: string; tokenSha256?: string | null;
  harnessPort?: number | string; harnessHost?: string; log?: (message: string) => void;
}): Server;
