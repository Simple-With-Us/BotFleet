import { createHash, timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { HOST_ID_PATTERN, type HostId } from "../shared/placement.ts";
import { classifyWorkerRequest } from "../shared/placement-worker-http.mjs";

const idSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const hostSchema = z.string().regex(HOST_ID_PATTERN).transform((value) => {
  // SAFETY: HOST_ID_PATTERN validates the HostId template at this boundary.
  return value as HostId;
});
export const WorkerAuthorizationSchema = z.object({
  format: z.literal("botfleet-placement-worker"), version: z.literal(1), credentialId: idSchema,
  revision: z.number().int().positive().safe(), hostId: hostSchema, audience: hostSchema,
  role: z.literal("execution-worker"), secretSha256: z.string().regex(/^[0-9a-f]{64}$/),
  revoked: z.boolean(), expiresAt: z.number().int().positive().safe().nullable(),
}).strict();
export type WorkerAuthorization = z.infer<typeof WorkerAuthorizationSchema>;
export interface WorkerPrincipal { credentialId: string; hostId: HostId; audience: HostId; role: "execution-worker" }
export interface WorkerAuthorizationSource { read(credentialId: string): WorkerAuthorization | Promise<WorkerAuthorization> }

/** Dynamic digest-only authorization state, not settings or secret custody.
 * Missing state never creates a directory, enrolls a worker or grants authority. */
export function privateWorkerAuthorizationSource(dataDir: string): WorkerAuthorizationSource {
  const directory = join(dataDir, "placement-worker-authorizations");
  let boundDirectory: Stats | undefined;
  const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
  const privateOwned = (stat: Stats, directory = false) => {
    if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
        stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) throw new Error("Worker authorization is unavailable");
  };
  return { async read(credentialId) {
    idSchema.parse(credentialId);
    const parent = await lstat(directory); privateOwned(parent, true);
    if (boundDirectory && !same(boundDirectory, parent)) throw new Error("Worker authorization is unavailable");
    const path = join(directory, `${credentialId}.json`);
    const visible = await lstat(path); privateOwned(visible);
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const file = await fd.stat(); privateOwned(file);
      // The metadata format is deliberately small and contains no raw credential.
      if (!same(file, visible) || file.size > 16_384) throw new Error("Worker authorization is unavailable");
      const buffer = Buffer.alloc(16_385);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await fd.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const after = await fd.stat(); privateOwned(after);
      const finalParent = await lstat(directory); privateOwned(finalParent, true);
      const finalFile = await lstat(path); privateOwned(finalFile);
      if (length > 16_384 || !same(finalParent, parent) || !same(finalFile, file) ||
          after.size !== file.size || after.mtimeMs !== file.mtimeMs || after.ctimeMs !== file.ctimeMs) throw new Error("Worker authorization is unavailable");
      if (boundDirectory && !same(boundDirectory, parent)) throw new Error("Worker authorization is unavailable");
      boundDirectory = parent;
      return WorkerAuthorizationSchema.parse(JSON.parse(buffer.subarray(0, length).toString("utf8")));
    } finally { await fd.close(); }
  } };
}

export function workerVerifier(source: WorkerAuthorizationSource, audience: HostId, now = Date.now) {
  const observed = new Map<string, WorkerAuthorization>();
  const refused = new Set<string>();
  return async (credentialId: string, secret: string): Promise<WorkerPrincipal | null> => {
    try {
      idSchema.parse(credentialId);
      const record = WorkerAuthorizationSchema.parse(await source.read(credentialId));
      if (refused.has(credentialId)) return null;
      const previous = observed.get(credentialId);
      if (previous && (record.credentialId !== credentialId || record.audience !== audience ||
          record.hostId !== previous.hostId || record.secretSha256 !== previous.secretSha256 || record.revision < previous.revision ||
          record.revision === previous.revision && JSON.stringify(record) !== JSON.stringify(previous))) {
        refused.add(credentialId);
        return null;
      }
      if (record.credentialId !== credentialId || record.audience !== audience) return null;
      // Trusted metadata observations do not depend on the presented secret.
      observed.set(credentialId, record);
      if (record.revoked) { refused.add(credentialId); return null; }
      if (record.expiresAt !== null && record.expiresAt <= now()) return null;
      const digest = createHash("sha256").update(secret, "utf8").digest();
      if (!timingSafeEqual(digest, Buffer.from(record.secretSha256, "hex"))) return null;
      return { credentialId, hostId: record.hostId, audience: record.audience, role: record.role };
    } catch { return null; }
  };
}

// This validates only the reserved authentication envelope, never an execution
// receipt protocol or an advertisement that such a protocol is implemented.
const WorkerEnvelopeSchema = z.object({
  authVersion: z.literal("1"), hostId: hostSchema, audience: hostSchema, role: z.literal("execution-worker"),
}).strict();
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- validation boundary: the JSON body is safeParse-checked before host/audience use
export function workerEnvelopeMatches(principal: WorkerPrincipal, body: unknown): boolean {
  const result = WorkerEnvelopeSchema.safeParse(body);
  return result.success && result.data.hostId === principal.hostId && result.data.audience === principal.audience;
}

export function createWorkerRequestBoundary(options: {
  audience: HostId; source: WorkerAuthorizationSource;
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- HTTP boundary: parse the untrusted JSON with WorkerEnvelopeSchema before granting any intent
  readBody: (req: IncomingMessage) => Promise<unknown>;
}) {
  const verify = workerVerifier(options.source, options.audience);
  const answer = (res: ServerResponse, status: number, error: string) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error }));
  };
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const request = classifyWorkerRequest(req);
    if (request.kind === "none") return false;
    if (request.kind !== "worker" || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")) {
      answer(res, 403, "Worker request refused"); return true;
    }
    const principal = await verify(request.credentialId, request.secret);
    if (!principal) { answer(res, 403, "Worker request refused"); return true; }
    let body: unknown;
    try { body = await options.readBody(req); }
    catch { answer(res, 400, "Worker request body is invalid"); return true; }
    const current = await verify(request.credentialId, request.secret);
    if (!current || !workerEnvelopeMatches(current, body)) { answer(res, 403, "Worker request refused"); return true; }
    // No transport operation, lease, payload or owner diagnostic is accessed.
    answer(res, 503, "Worker transport is not active");
    return true;
  };
}
