export interface HarnessOwner {
  version: number;
  pid: number;
  port: number;
  nonce: string;
}
export function readHarnessOwner(dataDir: string): HarnessOwner | null;
export function acquireHarnessOwnership(dataDir: string, port: number): HarnessOwner;
export function initializeHarnessOwnership(dataDir: string, port: number, prepareDataDir: () => void): HarnessOwner;
export function harnessOwnerProof(owner: HarnessOwner, challenge: unknown): string | undefined;
export function verifyHarnessOwnerProof(owner: HarnessOwner, challenge: string, proof: unknown): boolean;
