/** Observe the current fence without activating or mutating a migrated ledger. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { HOST_ID_PATTERN, type ControllerEpoch, type HostId } from "../shared/placement.ts";
import { openControllerEpochStore, type ControllerEpochStore } from "./placement-identity.ts";
import { PlacementStoreError } from "./placement-store.ts";

export const PLACEMENT_ROLLBACK_REFUSAL = "Placement execution is held by this read-only rollback build; preserve the placement ledger and use a verified compatible controller build";
const controllerSchema = z.object({ controllerId: z.string().regex(HOST_ID_PATTERN), epoch: z.number().safe().int().nonnegative() }).strict();
const markerSchema = z.object({ format: z.literal("botfleet-placement-sqlite"), version: z.literal(1), migrationId: z.uuid() }).strict();
const metaSchema = z.object({
  version: z.literal(1), storage: z.literal("normalized-v1"), migrationId: z.uuid(), phase: z.literal("active"), initialController: controllerSchema,
}).strict();
const headerSchema = z.object({ controller: controllerSchema, reconcile: z.boolean() }).strict();
function sameFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function privateFile(path: string): Stats {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600))) throw new PlacementStoreError();
  return stat;
}
function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    // SAFETY: only absence is allowed; all other filesystem errors fail closed.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function readMarker(path: string): z.infer<typeof markerSchema> | z.infer<typeof controllerSchema> {
  const before = privateFile(path);
  if (before.size > 4096) throw new PlacementStoreError();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameFile(before, fstatSync(fd))) throw new PlacementStoreError();
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!sameFile(before, privateFile(path))) throw new PlacementStoreError();
    return z.union([markerSchema, controllerSchema]).parse(value);
  } finally { closeSync(fd); }
}

export interface ReadonlyPlacementController {
  controller(): ControllerEpoch;
  close(): void;
}
export type RollbackPlacementAuthority =
  | { kind: "legacy"; controllerStore: ControllerEpochStore }
  | { kind: "readonly"; reader: ReadonlyPlacementController };

/** A UUID marker irrevocably selects passive execution for this process,
 * without a migration entrypoint or an override, even after unquiesce. */
export function openRollbackPlacementAuthority(dataDir: string, hostId: HostId, platform: NodeJS.Platform = process.platform): RollbackPlacementAuthority {
  try {
    const markerPath = join(dataDir, "placement-controller.json");
    const value = exists(markerPath) ? readMarker(markerPath) : undefined;
    if (!markerSchema.safeParse(value).success) {
      if (value !== undefined && !controllerSchema.safeParse(value).success) throw new PlacementStoreError();
      if (exists(join(dataDir, "placement.sqlite"))) throw new PlacementStoreError();
      return { kind: "legacy", controllerStore: openControllerEpochStore(dataDir, hostId) };
    }
    const marker = markerSchema.parse(value);
    // A passive reader must not silently reopen a normalized ledger on a
    // platform where the authoritative writer refuses SQLite activation.
    if ((process.platform !== "darwin" && process.platform !== "linux") ||
        (platform !== "darwin" && platform !== "linux")) throw new PlacementStoreError();
    const directoryPath = realpathSync(dataDir);
    const directory = lstatSync(directoryPath);
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o022) !== 0) throw new PlacementStoreError();
    const path = join(directoryPath, "placement.sqlite");
    const inode = privateFile(path);
    function checkFiles(): void {
      const currentDirectory = lstatSync(directoryPath);
      if (!currentDirectory.isDirectory() || !sameFile(directory, currentDirectory)
        || currentDirectory.uid !== process.getuid?.() || (currentDirectory.mode & 0o022) !== 0
        || !sameFile(inode, privateFile(path))) throw new PlacementStoreError();
      for (const suffix of ["-wal", "-shm"]) if (exists(`${path}${suffix}`)) privateFile(`${path}${suffix}`);
      if (markerSchema.parse(readMarker(markerPath)).migrationId !== marker.migrationId) throw new PlacementStoreError();
    }
    checkFiles();
    // SQLite owns WAL visibility and shared locking; never use immutable=1,
    // journal/checkpoint PRAGMAs, prepared activation, or a writable connection.
    const db = new DatabaseSync(path, { readOnly: true });
    let closed = false;
    let observed: ControllerEpoch | undefined;
    const reader: ReadonlyPlacementController = {
      controller() {
        try {
          if (closed) throw new PlacementStoreError();
          checkFiles();
          db.exec("BEGIN");
          try {
            if (db.prepare("PRAGMA user_version").get()?.user_version !== 1) throw new PlacementStoreError();
            const meta = metaSchema.parse(JSON.parse(String(db.prepare("SELECT json FROM placement_meta WHERE id=1").get()?.json)));
            const header = headerSchema.parse(JSON.parse(String(db.prepare("SELECT json FROM placement_state WHERE id=1").get()?.json)));
            if (meta.migrationId !== marker.migrationId || header.controller.epoch < meta.initialController.epoch
              || (header.controller.epoch === meta.initialController.epoch && header.controller.controllerId !== meta.initialController.controllerId)) throw new PlacementStoreError();
            // SAFETY: controllerSchema checked the complete HostId shape.
            const pair = header.controller as ControllerEpoch;
            if (observed && (pair.epoch < observed.epoch || (pair.epoch === observed.epoch && pair.controllerId !== observed.controllerId))) throw new PlacementStoreError();
            checkFiles();
            db.exec("COMMIT");
            observed = pair;
            return { ...pair };
          } catch (error) { db.exec("ROLLBACK"); throw error; }
        } catch { throw new PlacementStoreError(); }
      },
      close() { if (!closed) { closed = true; db.close(); } },
    };
    try { reader.controller(); } catch (error) { reader.close(); throw error; }
    return { kind: "readonly", reader };
  } catch { throw new PlacementStoreError(); }
}
