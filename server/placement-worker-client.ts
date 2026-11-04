/** The worker-side placement transport client (transport slice T1 of
 *  docs/plans/2026-11-03-placement-transport-slices.md).
 *
 *  Speaks the plan's six worker intents (register, heartbeat, assignment,
 *  payload, report, stop-receipt) over #1565's strict worker HTTP contract
 *  (shared/placement-worker-http.mjs): a POST of JSON on
 *  /api/placement/worker/<intent>, exactly one BotFleet-Worker credential
 *  header, and a body that starts with the reserved authentication envelope.
 *  Every body also carries the controller epoch fence, and every reply is
 *  expected to carry the controller pair back so the worker converges after
 *  a takeover or a controller restart.
 *
 *  The identity in the envelope and the Authorization header always comes
 *  from this client's own credential, never from caller-supplied fields, and
 *  the link is injected: nothing here reads configuration, spawns processes
 *  or wires a production caller, because slice T5 owns the worker runtime
 *  that will.  This file alone cannot move a live job.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { z } from "zod";
import {
  HOST_ID_PATTERN,
  PLACEMENT_WIRE_VERSION,
  type AdmissionVerdict,
  type CapacitySample,
  type Capability,
  type ClaimReply,
  type ControllerEpoch,
  type HeartbeatReply,
  type HostId,
  type RegisterReply,
  type ReportMessage,
  type ReportReply,
} from "../shared/placement.ts";

/** The worker route prefix shared with classifyWorkerRequest. */
const WORKER_ROUTE = "/api/placement/worker/";
const CREDENTIAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CREDENTIAL_SECRET_PATTERN = /^[0-9a-f]{64}$/;

/** A fetch-shaped link built on node:http and node:https, so a request carries exactly the
 *  headers the client names.  Node's fetch injects `sec-fetch-mode`, and the
 *  worker boundary refuses every `sec-*` header, so the standard fetch
 *  always draws a bare 403 before the credential is ever read.  This is
 *  the link slice T5 wires; tests inject it the same way. */
export function nodeHttpWorkerLink(): typeof fetch {
  return (url, init) => new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(String(url));
    } catch (error) {
      reject(error instanceof Error ? error : new TypeError("the worker link URL is invalid"));
      return;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      reject(new TypeError("the worker link speaks only http and https origins"));
      return;
    }
    // An off-host controller is https, as the client's constructor requires.
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    // The worker link's own contract: this client serializes its JSON body
    // itself, so the body reaches the link as the string it sent.
    const body = init?.body === undefined || init?.body === null ? undefined : String(init.body);
    const headers = new Headers(init?.headers);
    if (body !== undefined) headers.set("content-length", Buffer.byteLength(body).toString());
    const req = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init?.method ?? "GET",
        headers: Object.fromEntries(headers),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("error", reject);
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [name, values] of Object.entries(res.headers)) {
            for (const value of Array.isArray(values) ? values : [values]) {
              if (value !== undefined) responseHeaders.append(name, value);
            }
          }
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: responseHeaders }));
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

export interface WorkerCredential {
  credentialId: string;
  /** The raw worker secret; only ever serialized into the Authorization header. */
  secret: string;
}

/** The exact `BotFleet-Worker` header value classifyWorkerRequest accepts. */
export function workerAuthorizationHeader(credential: WorkerCredential): string {
  return `BotFleet-Worker bfw1.${credential.credentialId}.${credential.secret}`;
}

/** Per-intent outcome.  Only link failures prevent the controller from
 *  deciding; every other outcome carries the controller's own answer, so
 *  callers branch on outcomes instead of try/catch. */
export type WorkerCallOutcome<T> =
  | { outcome: "accepted"; reply: T }
  | { outcome: "refused"; status: number; reason: string }
  | { outcome: "inactive"; reason: string }
  | { outcome: "link-failed"; reason: string };

/** The plan's assignment reply is the existing claim compare-and-set reply:
 *  the same issuing lease replays after a restart, and the reply carries the
 *  lease and no command.  Slice T2's route ratifies the parse. */
export type AssignmentReply = ClaimReply;
/** The plan's payload reply: the command read through the controller's
 *  payload store, with the working directory and timeout the job needs, so
 *  the worker can run it without a second call.  The digest is not sent
 *  back, because the controller checks it against the immutable binding
 *  when it reads the spool.  A read never consumes the claim.  Slice T2's
 *  route ratifies the parse. */
export interface PayloadReply extends ControllerEpoch {
  accepted: boolean;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  reason?: string;
}
/** The plan's stop receipt records delivery only; the report still settles
 *  the lease.  Slice T2's route ratifies the parse. */
export interface StopReceiptReply extends ControllerEpoch {
  accepted: boolean;
  jobId?: string;
  leaseId?: string;
  reason?: string;
}

const hostField = z.string().min(1).max(64).regex(HOST_ID_PATTERN).transform((value) => {
  // SAFETY: HOST_ID_PATTERN validates the HostId template at this boundary.
  return value as HostId;
});
const pairFields = {
  controllerId: hostField,
  epoch: z.number().int().nonnegative(),
};
const replyPair = z.object(pairFields).strip();
const registerReply = z.object({
  ...pairFields,
  accepted: z.boolean(),
  reason: z.string().optional(),
}).strip().transform((value) => {
  // SAFETY: the parse above checked every field; this assertion only re-tags
  // the validated accepted flag into RegisterReply's literal variants.
  return value as RegisterReply;
});
const heartbeatReply = z.object({
  ...pairFields,
  pendingStops: z.array(z.string().min(1)),
}).strip();
const reportReply = z.object({
  ...pairFields,
  accepted: z.boolean(),
  reason: z.string().optional(),
}).strip().transform((value) => {
  // SAFETY: the parse above checked every field; this assertion only re-tags
  // the validated accepted flag into ReportReply's literal variants.
  return value as ReportReply;
});
const claimReply = z.object({
  ...pairFields,
  accepted: z.boolean(),
  reason: z.string().optional(),
  lease: z.object({
    controllerId: hostField,
    epoch: z.number().int().nonnegative(),
    leaseId: z.string().min(1),
    jobId: z.string().min(1),
    host: hostField,
  }).strip().optional(),
}).strip().transform((value) => {
  // SAFETY: the parse above checked every field; this assertion only re-tags
  // the validated accepted flag and lease presence into ClaimReply's variants.
  return value as AssignmentReply;
});
const payloadReply = z.object({
  ...pairFields,
  accepted: z.boolean(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().optional(),
  reason: z.string().optional(),
}).strip();
const stopReceiptReply = z.object({
  ...pairFields,
  accepted: z.boolean(),
  jobId: z.string().optional(),
  leaseId: z.string().optional(),
  reason: z.string().optional(),
}).strip();

/** The #1565 reserved envelope, exactly as workerEnvelopeMatches expects it. */
function authEnvelope(hostId: HostId, audience: HostId) {
  return { authVersion: "1", hostId, audience, role: "execution-worker" } as const;
}

function errorReason(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validation boundary: errorReason itself runs the reply-error schema over this untrusted JSON before anything reads it
  body: unknown,
  fallback: string,
): string {
  const parsed = z.object({ error: z.string().min(1) }).strip().safeParse(body);
  return parsed.success ? parsed.data.error : fallback;
}

export interface PlacementWorkerClientOptions {
  credential: WorkerCredential;
  /** This worker's own host id; the envelope's identity never comes from a
   *  caller-supplied field. */
  workerHostId: HostId;
  /** The controller this worker is registered with. */
  audience: HostId;
  /** The controller pair the worker currently believes in. */
  controller: ControllerEpoch;
  /** The controller origin the worker routes are resolved against. */
  baseUrl: string;
  /** Injected fetch-shaped link; no production caller is wired by this slice. */
  fetchImpl: typeof fetch;
}

const workerBodyFields = z.record(z.string(), z.unknown());

export class PlacementWorkerClient {
  private believed: ControllerEpoch;
  private readonly credential: WorkerCredential;
  private readonly workerHostId: HostId;
  private readonly audience: HostId;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PlacementWorkerClientOptions) {
    if (!CREDENTIAL_ID_PATTERN.test(options.credential.credentialId)) {
      throw new TypeError("worker credential id is not a placement credential id");
    }
    if (!CREDENTIAL_SECRET_PATTERN.test(options.credential.secret)) {
      throw new TypeError("worker credential secret is not a 64-hex digest");
    }
    if (!HOST_ID_PATTERN.test(options.workerHostId) || !HOST_ID_PATTERN.test(options.audience)) {
      throw new TypeError("worker and audience host ids must match the placement host id shape");
    }
    const base = new URL(options.baseUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      throw new TypeError("the worker base URL must be an http or https origin");
    }
    // The credential travels in a header, so cleartext http is allowed only
    // to a loopback controller, where #1565's gate confines callers to this
    // host anyway; anything off-host must use https.
    if (base.protocol === "http:") {
      const host = base.hostname;
      const loopback = host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "localhost";
      if (!loopback) {
        throw new TypeError("cleartext http is allowed only to a loopback controller; use https off-host");
      }
    }
    this.credential = options.credential;
    this.workerHostId = options.workerHostId;
    this.audience = options.audience;
    this.baseUrl = base.toString();
    this.believed = { ...options.controller };
    this.fetchImpl = options.fetchImpl;
  }

  /** The controller pair this worker currently believes in.  Replies are the
   *  authoritative source: a strictly newer epoch is adopted, so the worker
   *  converges after a takeover, and an older or equal-but-different pair is
   *  never adopted from a refusal. */
  controller(): ControllerEpoch {
    return { ...this.believed };
  }

  private adopt(reply: { controllerId: HostId; epoch: number }): void {
    if (reply.epoch > this.believed.epoch) {
      this.believed = { controllerId: reply.controllerId, epoch: reply.epoch };
    }
  }

  private fence(): ControllerEpoch & { version: string } {
    return { controllerId: this.believed.controllerId, epoch: this.believed.epoch, version: PLACEMENT_WIRE_VERSION };
  }

  private async call<Reply extends { controllerId: HostId; epoch: number; accepted?: boolean; reason?: string }>(
    intent: string,
    fields: z.infer<typeof workerBodyFields>,
    replySchema: z.ZodType<Reply>,
  ): Promise<WorkerCallOutcome<Reply>> {
    const body = {
      ...authEnvelope(this.workerHostId, this.audience),
      ...this.fence(),
      ...fields,
    };
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(`${WORKER_ROUTE}${intent}`, this.baseUrl), {
        method: "POST",
        headers: {
          "authorization": workerAuthorizationHeader(this.credential),
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      return { outcome: "link-failed", reason: error instanceof Error ? error.message : "the worker link failed" };
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { outcome: "link-failed", reason: `the worker reply on ${intent} is not JSON` };
    }
    if (response.status === 503) {
      return { outcome: "inactive", reason: errorReason(parsed, "the worker transport is not active") };
    }
    if (response.status !== 200) {
      // Conflict bodies carry the controller's current pair; adopt it when it
      // is newer so the worker converges, and refuse either way.
      const pair = replyPair.safeParse(parsed);
      if (pair.success) this.adopt(pair.data);
      return { outcome: "refused", status: response.status, reason: errorReason(parsed, `the controller refused ${intent}`) };
    }
    const checked = replySchema.safeParse(parsed);
    if (!checked.success) {
      return { outcome: "link-failed", reason: `the worker reply on ${intent} does not speak the placement wire shape` };
    }
    this.adopt(checked.data);
    if (checked.data.accepted === false) {
      return { outcome: "refused", status: response.status, reason: checked.data.reason ?? `the controller refused ${intent}` };
    }
    return { outcome: "accepted", reply: checked.data };
  }

  /** Announce capabilities and a sample.  The body carries no role field:
   *  the envelope's `execution-worker` role is the authentication answer,
   *  and the controller's worker route registers this principal as a worker
   *  from its verified credential class, never from a body field. */
  register(input: { capabilities: Capability[]; sample: CapacitySample }): Promise<WorkerCallOutcome<RegisterReply>> {
    return this.call("register", { capabilities: input.capabilities, sample: input.sample }, registerReply);
  }

  heartbeat(input: { leases: string[]; admission: AdmissionVerdict; sample: CapacitySample }): Promise<WorkerCallOutcome<HeartbeatReply>> {
    return this.call("heartbeat", { leases: input.leases, admission: input.admission, sample: input.sample }, heartbeatReply);
  }

  /** Ask for work.  The controller selects the oldest job eligible for this
   *  host and compare-and-sets its lease; the reply carries the lease and no
   *  command.  Slice T2 owns that selection on the controller side. */
  assignment(): Promise<WorkerCallOutcome<AssignmentReply>> {
    return this.call("assignment", {}, claimReply);
  }

  /** Fetch the command for a lease this host holds.  The read is checked
   *  against the payload's immutable digest and never consumes the claim. */
  payload(input: { jobId: string; leaseId: string }): Promise<WorkerCallOutcome<PayloadReply>> {
    return this.call("payload", { jobId: input.jobId, leaseId: input.leaseId }, payloadReply);
  }

  /** The worker's terminal word on a lease.  No intent field carries a host
   *  id: the controller's worker route builds the wire message from the
   *  verified credential, so a body field never chooses who reports. */
  report(message: Omit<ReportMessage, "version" | "controllerId" | "epoch" | "hostId">): Promise<WorkerCallOutcome<ReportReply>> {
    return this.call("report", { ...message }, reportReply);
  }

  /** Acknowledge a delivered stop.  This records delivery only; the report
   *  still settles the lease. */
  stopReceipt(input: { jobId: string; leaseId: string }): Promise<WorkerCallOutcome<StopReceiptReply>> {
    return this.call("stop-receipt", { jobId: input.jobId, leaseId: input.leaseId }, stopReceiptReply);
  }
}
