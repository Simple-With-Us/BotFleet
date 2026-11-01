import { mkdirSync, readFileSync } from "node:fs";
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
});

/**
 * The controller fence belongs to the data directory, beside `host-id`.
 * A host that has never handed control away is its own controller at epoch 0;
 * damaged state is preserved and blocks startup rather than silently
 * resetting the epoch every placement message is fenced by.
 */
export function loadControllerEpoch(dataDir: string, hostId: HostId): ControllerEpoch {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "placement-controller.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    // SAFETY: read failures from node:fs carry a string `code`; anything
    // without ENOENT here is rethrown untouched on the next line.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const initial: ControllerEpoch = { controllerId: hostId, epoch: 0 };
    writeFileAtomic(path, `${JSON.stringify(initial)}\n`, { mode: 0o600 });
    return initial;
  }
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
