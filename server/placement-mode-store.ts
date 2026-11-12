/** The server's copy of the placement mode record, and the acknowledgement a
 *  client fetches to learn the controller holds it (native server mode plan
 *  slice T3 -- the server mode record and the applied acknowledgement).
 *
 *  The record is the design's shape:  `{ mode, controllerId, epoch, serverId,
 *  allowOverflowToThisMac }`, persisted beside `jobs.json` with
 *  `writeFileAtomic` at 0600 and fsynced before it is acknowledged.
 *
 *  One epoch, never two.  The store keeps no counter of its own:  every read
 *  and every write resolves the fence from the lease service's `controller()`,
 *  so the record's epoch IS the lease service's epoch and a second counter
 *  cannot drift from it.  A write whose fence is not the current one is
 *  refused with the current pair, the same fence every placement message
 *  crosses.
 *
 *  What this slice does not do:  read the record back.  The registry bridge
 *  (slice T4) is the reader, and it has landed, so a written mode changes
 *  behaviour now.  `acknowledged` is still a statement about the record alone,
 *  never about what this server runs.  All sixteen placement assertions stay
 *  false. */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { HOST_ID_PATTERN, type ControllerEpoch, type HostId, type PlacementMode } from "../shared/placement.ts";
import { writeFileAtomic } from "./atomic.ts";

/** The file beside `jobs.json` that holds the record. */
export const PLACEMENT_MODE_FILE = "placement-mode.json";

const hostId = z.string().max(64).regex(HOST_ID_PATTERN).transform((value) => {
  // SAFETY: the regex above matched the HOST_ID_PATTERN shape (a fixed
  // `mac:`/`server:` prefix plus a UUID), which is exactly the HostId type
  // TypeScript cannot narrow to.
  return value as HostId;
});
const mode = z.enum(["localOnly", "serverFirst", "macFirst"]);

/** The body of `PUT /api/placement/mode`, parsed strictly:  an unknown key
 *  fails closed so contract drift is visible instead of silently accepted. */
export const placementModeInputSchema = z.object({
  mode,
  controllerId: hostId,
  epoch: z.number().int().nonnegative().safe(),
  serverId: hostId.nullable().optional(),
  allowOverflowToThisMac: z.boolean(),
}).strict();

export type PlacementModeInput = z.infer<typeof placementModeInputSchema>;

const storedSchema = z.object({
  schema: z.literal(1),
  mode,
  controllerId: hostId,
  epoch: z.number().int().nonnegative().safe(),
  serverId: hostId.nullable(),
  allowOverflowToThisMac: z.boolean(),
  appliedAt: z.number().int().nonnegative(),
}).strict();

/** The record, in the design's shape.  `pendingHandoff` is the Mac's own field:
 *  the server records the mode it holds, not a handoff it awaits. */
export interface PlacementModeRecord {
  mode: PlacementMode;
  controllerId: HostId;
  epoch: number;
  serverId: HostId | null;
  allowOverflowToThisMac: boolean;
}

/** The record as the controller holds it, with the live fence beside it. */
export interface PlacementModeView {
  /** The record the controller holds, or the derived default. */
  record: PlacementModeRecord;
  /** The live fence.  The record's epoch is a copy of it. */
  controller: ControllerEpoch;
  /** True when a written record is held at the live fence. */
  acknowledged: boolean;
  /** When the record was written, or null when nothing is written. */
  appliedAt: number | null;
  /** Why the record is not acknowledged, when it is not. */
  reason: string | null;
}

/** What a refused write refused on.  A stale fence and an invalid mode are
 *  different answers:  the first is retried with the current controller pair,
 *  and the second never succeeds on a retry, so the two are told apart. */
export type PlacementModeWrite =
  | { ok: true; view: PlacementModeView }
  | { ok: false; kind: "stale-fence"; reason: string; controller: ControllerEpoch }
  | { ok: false; kind: "invalid-mode"; reason: string };

/** The mode record could not be read or written.  A failure never rewrites the
 *  record:  it is preserved for the owner to restore. */
export class PlacementModeStoreError extends Error {}

export interface PlacementModeStoreDeps {
  /** The lease service's fence.  The only epoch the record ever carries. */
  controller: () => ControllerEpoch;
  /** This host's id.  The server records itself as the one server in the
   *  system, so a record naming another server is refused. */
  hostId: HostId;
  now?: () => number;
  /** Where a post-commit failure is reported. */
  log?: (message: string) => void;
}

/** The durable mode record, fenced on the lease service's epoch. */
export class PlacementModeStore {
  private readonly dir: string;
  private readonly path: string;
  private readonly deps: PlacementModeStoreDeps;

  constructor(dir: string, deps: PlacementModeStoreDeps) {
    this.dir = dir;
    this.path = join(dir, PLACEMENT_MODE_FILE);
    this.deps = deps;
  }

  private fence(): ControllerEpoch {
    try {
      return this.deps.controller();
    } catch {
      throw new PlacementModeStoreError("The controller epoch could not be verified; the mode record is unavailable");
    }
  }

  private readStored(): { record: PlacementModeRecord; appliedAt: number } | null {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      // SAFETY: only absence permits the derived default; every other read
      // failure fails closed, because a mode nobody can read is not a mode
      // nobody may change.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new PlacementModeStoreError("The mode record could not be read; preserve it and restore it before starting");
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new PlacementModeStoreError("The mode record is invalid; preserve it and restore it before starting");
    }
    const parsed = storedSchema.safeParse(json);
    if (!parsed.success) throw new PlacementModeStoreError("The mode record is invalid; preserve it and restore it before starting");
    const { schema, appliedAt, ...record } = parsed.data;
    void schema;
    return { record, appliedAt };
  }

  /** Write the record.  The atomic rename is the commit:  after it the record
   *  is on disk and every later read sees it, so a failure after the rename
   *  must not report a failed write.  The directory flush that follows is
   *  post-commit, and it is the same shape as the lease book's post-commit
   *  cleanup:  a failure there is reported and the next write retries it. */
  private persist(record: PlacementModeRecord, appliedAt: number): void {
    const stored = { schema: 1 as const, ...record, appliedAt };
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileAtomic(this.path, `${JSON.stringify(stored)}\n`, { mode: 0o600, exactMode: true });
    } catch {
      throw new PlacementModeStoreError("The mode record could not be written; the write was refused");
    }
    // Placement is unsupported on Windows, where directories cannot be fsynced.
    if (process.platform === "win32") return;
    try {
      // Flush the atomic rename, so the record survives a crash.
      const fd = openSync(this.dir, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // The record is already written, so refusing here would report a failed
      // write for a write that happened.  It is logged instead, and the next
      // write to this path flushes the directory again.  A record that a crash
      // reverted reads as unacknowledged at the current fence, which is what a
      // stale record is for.
      this.deps.log?.("[placement] the mode record was written but its directory flush failed; the next write retries it");
    }
  }

  /** The record as the controller holds it, with the live fence beside it. */
  read(): PlacementModeView {
    const controller = this.fence();
    const stored = this.readStored();
    if (!stored) {
      return {
        record: { mode: "localOnly", controllerId: controller.controllerId, epoch: controller.epoch, serverId: null, allowOverflowToThisMac: false },
        controller,
        acknowledged: false,
        appliedAt: null,
        reason: "No mode record is written; This Mac Only is the default and no mode is acknowledged",
      };
    }
    const { record, appliedAt } = stored;
    if (record.epoch > controller.epoch || (record.epoch === controller.epoch && record.controllerId !== controller.controllerId)) {
      throw new PlacementModeStoreError("The mode record is ahead of the controller fence; preserve it and restore the controller epoch before starting");
    }
    if (record.epoch !== controller.epoch || record.controllerId !== controller.controllerId) {
      return {
        record,
        controller,
        acknowledged: false,
        appliedAt,
        reason: `The mode record was written at epoch ${record.epoch}; the controller is ${controller.controllerId} at epoch ${controller.epoch}`,
      };
    }
    return { record, controller, acknowledged: true, appliedAt, reason: null };
  }

  /** Record the mode the controller holds, fenced on the live epoch.  A fence
   *  that is not the current one is refused and the record is untouched. */
  apply(input: PlacementModeInput): PlacementModeWrite {
    const controller = this.fence();
    if (input.controllerId !== controller.controllerId || input.epoch !== controller.epoch) {
      return {
        ok: false,
        kind: "stale-fence",
        reason: `stale controller epoch ${input.epoch}; the controller is ${controller.controllerId} at epoch ${controller.epoch}`,
        controller,
      };
    }
    const serverId = input.serverId ?? null;
    const refusal = this.modeRefusal(input.mode, serverId);
    if (refusal) return { ok: false, kind: "invalid-mode", reason: refusal };
    const appliedAt = this.deps.now?.() ?? Date.now();
    this.persist(
      { mode: input.mode, controllerId: controller.controllerId, epoch: controller.epoch, serverId, allowOverflowToThisMac: input.allowOverflowToThisMac },
      appliedAt,
    );
    return {
      ok: true,
      view: {
        record: { mode: input.mode, controllerId: controller.controllerId, epoch: controller.epoch, serverId, allowOverflowToThisMac: input.allowOverflowToThisMac },
        controller,
        acknowledged: true,
        appliedAt,
        reason: null,
      },
    };
  }

  /** The mode's own fences:  This Mac Only names no server, and a server mode
   *  names this host, because the server records itself as the one server in
   *  the system. */
  private modeRefusal(mode: PlacementMode, serverId: HostId | null): string | null {
    if (mode === "localOnly") {
      if (serverId !== null) return "This Mac Only names no server; the serverId is refused";
      return null;
    }
    if (serverId === null) return `${mode} needs a server`;
    if (serverId !== this.deps.hostId) return `The mode record names server ${serverId}; this host is ${this.deps.hostId}`;
    return null;
  }
}

export interface PlacementModeCaller { localOwner: boolean; fromCompanion: boolean; viaNamedTunnel: boolean }

/** The wire answer:  the live fence with the record it holds. */
export interface PlacementModeBody {
  controllerId: string;
  epoch: number;
  mode: PlacementMode;
  serverId: string | null;
  allowOverflowToThisMac: boolean;
  /** The controller holds the record at the fence above.  It is not a claim
   *  about what this server runs:  it says the controller holds the record at
   *  the fence, and nothing more.  The registry bridge reads the record since
   *  T4, so the mode reaches the registry. */
  acknowledged: boolean;
  appliedAt: number | null;
  reason: string | null;
}

export type PlacementModeResponse =
  | { status: 200; body: PlacementModeBody }
  | { status: 400 | 403 | 503; body: { error: string } }
  | { status: 409; body: { error: string } & ControllerEpoch };

const OWNER_REFUSAL = "Placement routes are available only through the local owner or authenticated server gate";

function modeBody(view: PlacementModeView): PlacementModeBody {
  return {
    controllerId: view.controller.controllerId,
    epoch: view.controller.epoch,
    mode: view.record.mode,
    serverId: view.record.serverId,
    allowOverflowToThisMac: view.record.allowOverflowToThisMac,
    acknowledged: view.acknowledged,
    appliedAt: view.appliedAt,
    reason: view.reason,
  };
}

/** `GET /api/placement/mode`:  the applied acknowledgement. */
export function placementModeRead(caller: PlacementModeCaller, store: PlacementModeStore): PlacementModeResponse {
  if (!caller.localOwner || caller.fromCompanion || caller.viaNamedTunnel) {
    return { status: 403, body: { error: OWNER_REFUSAL } };
  }
  try {
    return { status: 200, body: modeBody(store.read()) };
  } catch {
    return { status: 503, body: { error: "The mode record could not be read; the placement mode is unavailable" } };
  }
}

/** `PUT /api/placement/mode`:  record the mode the controller holds. */
export function placementModeWrite(
  caller: PlacementModeCaller,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validation boundary: the wire body is untrusted and safeParse-checked before any field is read
  body: unknown,
  store: PlacementModeStore,
): PlacementModeResponse {
  if (!caller.localOwner || caller.fromCompanion || caller.viaNamedTunnel) {
    return { status: 403, body: { error: OWNER_REFUSAL } };
  }
  const parsed = placementModeInputSchema.safeParse(body);
  if (!parsed.success) return { status: 400, body: { error: "invalid placement mode message" } };
  let result: PlacementModeWrite;
  try {
    result = store.apply(parsed.data);
  } catch {
    return { status: 503, body: { error: "The mode record could not be written; the placement mode is unavailable" } };
  }
  if (!result.ok) {
    // A stale fence is retried with the current pair, so it carries that pair
    // back.  An invalid mode never succeeds on a retry, so it carries no
    // controller state:  the body is wrong, and the pair would not fix it.
    if (result.kind === "stale-fence") return { status: 409, body: { error: result.reason, ...result.controller } };
    return { status: 400, body: { error: result.reason } };
  }
  return { status: 200, body: modeBody(result.view) };
}
