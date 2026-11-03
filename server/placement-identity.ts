import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import {
  HOST_ID_PATTERN,
  PLACEMENT_WIRE_VERSION,
  type ControllerEpoch,
  type HostId,
  type PlacementIdentity,
} from "../shared/placement.ts";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

const controllerEpochSchema = z.object({
  controllerId: z.string().regex(HOST_ID_PATTERN),
  epoch: z.number().int().nonnegative().safe(),
}).strict();

export interface ControllerEpochStore {
  read(): ControllerEpoch;
  compareAndSet(expected: ControllerEpoch, next: ControllerEpoch):
    { accepted: true } | { accepted: false; controller: ControllerEpoch };
}

function readControllerEpoch(path: string): ControllerEpoch {
  const raw = readFileSync(path, "utf8");
  const invalid = new Error("placement-controller is invalid; preserve it and restore the controller epoch before starting");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw invalid;
  }
  const parsed = controllerEpochSchema.safeParse(json);
  if (!parsed.success) throw invalid;
  // SAFETY: the schema matched controllerId against HOST_ID_PATTERN,
  // which is exactly the HostId shape TypeScript cannot narrow to.
  return { controllerId: parsed.data.controllerId as HostId, epoch: parsed.data.epoch };
}

/** Startup and live transitions share the private fence beside host-id.
 * Only opening the store initializes missing state; later loss fails closed. */
export function openControllerEpochStore(dataDir: string, hostId: HostId): ControllerEpochStore {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "placement-controller.json");
  const lock = join(dataDir, "placement-controller.lock");
  function locked<T>(operation: () => T): T {
    // Never steal a lock from another writer, including a crashed writer.
    mkdirSync(lock, { mode: 0o700 });
    try {
      return operation();
    } finally {
      rmdirSync(lock);
    }
  }
  function persist(controller: ControllerEpoch): void {
    writeFileAtomic(path, `${JSON.stringify(controller)}\n`, { mode: 0o600, exactMode: true });
    // Placement is unsupported on Windows, where directories cannot be fsynced.
    if (process.platform === "win32") return;
    // Flush the atomic rename before acknowledging the new fence.
    const fd = openSync(dataDir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  locked(() => {
    try {
      readControllerEpoch(path);
    } catch (error) {
      // SAFETY: only ENOENT permits first-start initialization.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      persist({ controllerId: hostId, epoch: 0 });
    }
  });
  return {
    read: () => readControllerEpoch(path),
    compareAndSet: (expected, next) => locked(() => {
      const current = readControllerEpoch(path);
      if (current.controllerId !== expected.controllerId || current.epoch !== expected.epoch) {
        return { accepted: false, controller: current };
      }
      if (!controllerEpochSchema.safeParse(next).success || next.epoch <= current.epoch) {
        throw new Error("controller epoch transition must advance a valid fence");
      }
      persist(next);
      return { accepted: true };
    }),
  };
}

export function loadControllerEpoch(dataDir: string, hostId: HostId): ControllerEpoch {
  return openControllerEpochStore(dataDir, hostId).read();
}

export interface PlacementIdentityDeps {
  hostId: HostId;
  controller: ControllerEpoch;
  platform: NodeJS.Platform;
}
export type PlacementIdentityResponse =
  | { status: 200; body: PlacementIdentity }
  | { status: 403 | 501; body: { error: string } };
interface PlacementIdentityCaller { localOwner: boolean; fromCompanion: boolean; viaNamedTunnel: boolean }

/** The companion Bearer is intentionally outside the host-owner boundary. */
export function placementIdentityResponse(
  caller: PlacementIdentityCaller,
  deps: PlacementIdentityDeps,
): PlacementIdentityResponse {
  if (!caller.localOwner || caller.fromCompanion || caller.viaNamedTunnel) {
    return { status: 403, body: { error: "Placement identity is available only through the local owner or authenticated server gate" } };
  }
  if (deps.platform !== "darwin" && deps.platform !== "linux") {
    return { status: 501, body: { error: "Placement identity is not available on this platform" } };
  }
  return {
    status: 200,
    body: {
      hostId: deps.hostId,
      controllerId: deps.controller.controllerId,
      epoch: deps.controller.epoch,
      // The placement wire version, never the product version health reports.
      version: PLACEMENT_WIRE_VERSION,
      platform: deps.platform,
      // The same derivation /api/host/resources reports, so the native
      // handshake's equality check between the two routes holds.
      capabilities: deps.platform === "darwin" ? ["shell", "macos", "desktop"] : ["shell"],
    },
  };
}
