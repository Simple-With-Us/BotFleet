/** What a verified placement worker may do (slice T2 of
 *  docs/plans/2026-11-03-placement-transport-slices.md).
 *
 *  Each worker intent maps onto one `PlacementLeaseService` operation.  The
 *  boundary removes the envelope first, so these fields are the fence and the
 *  intent's own, and the host and worker role always come from the credential.
 *
 *  Nothing in production constructs this.  `server/index.ts` builds the worker
 *  boundary with no transport, so a valid envelope keeps answering 503 until a
 *  reviewed activation passes one.  A transport also needs the SQLite authority,
 *  because a lost acknowledgement can only replay a lease that was committed. */
import { z } from "zod";
import type { ControllerEpoch, HeartbeatMessage, HeartbeatReply, HostId, RegisterMessage, RegisterReply, ReportMessage, ReportReply, ClaimReply } from "../shared/placement.ts";
import type { WorkerIntent } from "../shared/placement-worker-http.mjs";
import type { LeaseResult, PlacementLeaseService, WorkerPayloadReply, WorkerStopReceiptReply } from "./placement-leases.ts";
import { placementFence, placementMessageSchemas } from "./placement-leases.ts";
import { PlacementStoreError } from "./placement-store.ts";

export type WorkerReply = RegisterReply | HeartbeatReply | ClaimReply | WorkerPayloadReply | ReportReply | WorkerStopReceiptReply;
export type WorkerTransportResponse =
  | { status: 200; body: WorkerReply }
  | { status: 400 | 403 | 503; body: { error: string } }
  | { status: 409; body: { error: string } & ControllerEpoch };

export interface WorkerTransport {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validation boundary: the message is untrusted and safeParse-checked per intent before any field is read
  handle(hostId: HostId, intent: WorkerIntent, message: unknown): WorkerTransportResponse;
}

const assignmentSchema = z.object({ ...placementFence }).strict();
const leaseSchema = z.object({ ...placementFence, jobId: z.string().min(1), leaseId: z.string().min(1) }).strict();
const fieldsSchema = z.object({}).loose();

function answer<T extends WorkerReply>(result: LeaseResult<T>): WorkerTransportResponse {
  if (!result.ok) return { status: 409, body: { error: result.reason, ...result.controller } };
  return { status: 200, body: result.reply };
}

export function createWorkerTransport(service: PlacementLeaseService): WorkerTransport {
  const invalid = (intent: WorkerIntent): WorkerTransportResponse => ({ status: 400, body: { error: `invalid ${intent} message` } });
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validation boundary: each case safeParses the message before reading any field
  const dispatch = (hostId: HostId, intent: WorkerIntent, message: unknown): WorkerTransportResponse => {
    const fields = fieldsSchema.safeParse(message);
    if (!fields.success) return invalid(intent);
    // Spread last, so nothing in the body can choose the host or the role.
    const asHost = { ...fields.data, hostId };
    switch (intent) {
      case "register": {
        const parsed = placementMessageSchemas.register.safeParse({ ...asHost, role: "worker" });
        if (!parsed.success) return invalid(intent);
        // SAFETY: the register schema above validated this message, including its capacity sample.
        return answer(service.register(parsed.data as RegisterMessage));
      }
      case "heartbeat": {
        const parsed = placementMessageSchemas.heartbeat.safeParse(asHost);
        if (!parsed.success) return invalid(intent);
        // SAFETY: the heartbeat schema above validated this message, including its capacity sample.
        return answer(service.heartbeat(parsed.data as HeartbeatMessage));
      }
      case "report": {
        const parsed = placementMessageSchemas.report.safeParse(asHost);
        if (!parsed.success) return invalid(intent);
        // SAFETY: the report schema above validated this message.
        return answer(service.report(parsed.data as ReportMessage));
      }
      case "assignment": {
        const parsed = assignmentSchema.safeParse(fields.data);
        return parsed.success ? answer(service.assign({ ...parsed.data, hostId })) : invalid(intent);
      }
      case "payload": {
        const parsed = leaseSchema.safeParse(fields.data);
        return parsed.success ? answer(service.leasePayload({ ...parsed.data, hostId })) : invalid(intent);
      }
      case "stop-receipt": {
        const parsed = leaseSchema.safeParse(fields.data);
        return parsed.success ? answer(service.stopReceipt({ ...parsed.data, hostId })) : invalid(intent);
      }
    }
  };
  return {
    handle(hostId, intent, message) {
      try {
        return dispatch(hostId, intent, message);
      } catch (error) {
        if (error instanceof PlacementStoreError) return { status: 503, body: { error: error.message } };
        throw error;
      }
    },
  };
}
