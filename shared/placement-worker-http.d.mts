import type { IncomingHttpHeaders } from "node:http";
export type WorkerIntent = "register" | "heartbeat" | "assignment" | "payload" | "report" | "stop-receipt";
export const WORKER_INTENTS: readonly WorkerIntent[];
export type WorkerRequestClass = { kind: "none" } | { kind: "denied" } | {
  kind: "worker"; intent: WorkerIntent; credentialId: string; secret: string;
};
export function classifyWorkerRequest(req: {
  rawHeaders?: string[]; headers?: IncomingHttpHeaders; method?: string; url?: string;
}): WorkerRequestClass;
