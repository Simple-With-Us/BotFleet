/** Wire contracts only: these types do not enable placement or change admission. */
/** Placement compatibility is independent of health/resources product versions. */
export const PLACEMENT_WIRE_VERSION = "1";
export type HostId = `mac:${string}` | `server:${string}`;
export const HOST_ID_PATTERN = /^(mac|server):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type Capability = "shell" | "macos" | "desktop";
export type PlacementMode = "localOnly" | "serverFirst" | "macFirst";
export type HostPlatform = "darwin" | "linux";

export interface ControllerEpoch { controllerId: HostId; epoch: number }
export interface PlacementSettings extends ControllerEpoch {
  mode: PlacementMode;
  serverId?: HostId;
  allowOverflowToThisMac: boolean;
  pendingHandoff?: { toControllerId: HostId; epoch: number };
}
export interface Lease extends ControllerEpoch { leaseId: string; jobId: string; host: HostId }

/** Missing values mean Not set; the contract proposes no resource defaults. */
export interface HeadroomSettings {
  reservedCpuCores?: number;
  reservedRamBytes?: number;
  minFreeDiskBytes?: number;
  minFreeInodes?: number;
  minMemoryAvailablePercent?: number;
}
export type EnforcementState =
  | { kind: "kernelCap"; mechanism: string }
  | { kind: "stopWhenOver" }
  | { kind: "gateOnly" }
  | { kind: "priorityOnly" }
  | { kind: "unsupported"; reason: string }
  | { kind: "notApplied"; reason: string; restartRequired: boolean };

/** Null readings are unknown, never zero capacity or zero use. */
export interface CapacitySample {
  at: number;
  cores: number | null;
  loadPerCore: number | null;
  ramTotalBytes: number | null;
  ramAvailableBytes: number | null;
  memoryPressure: "normal" | "warning" | "critical" | null;
  memoryAvailablePercent: number | null;
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  inodesTotal: number | null;
  inodesFree: number | null;
  dataVolume: { device: string; mountPoint: string } | null;
  rootDiskFreeBytes: number | null;
}
export type HostResource = "cpu" | "memory" | "swap" | "disk" | "inodes" | "io";
export interface HostProfile {
  id: HostId;
  displayName: string;
  platform: HostPlatform;
  capabilities: Capability[];
  headroomSaved: HeadroomSettings;
  savedAt: number | null;
  headroomApplied: HeadroomSettings;
  appliedAt: number | null;
  enforcement: Record<HostResource, EnforcementState>;
  lastSample: CapacitySample | null;
  lastSeen: number | null;
}
export interface AdmissionVerdict { admit: boolean; reason?: string }
/** Versions are checked before epochs; every state-changing message is fenced. */
export interface PlacementMessage extends ControllerEpoch { version: string }
export interface PlacementIdentity extends PlacementMessage {
  hostId: HostId;
  platform: HostPlatform;
  capabilities: Capability[];
}
export interface RegisterMessage extends PlacementMessage {
  hostId: HostId;
  role: "controller" | "worker";
  capabilities: Capability[];
  sample: CapacitySample;
}
export type RegisterReply = ({ accepted: true } | { accepted: false; reason: string }) & ControllerEpoch;
export interface HeartbeatMessage extends PlacementMessage {
  hostId: HostId;
  leases: string[];
  admission: AdmissionVerdict;
  sample: CapacitySample;
}
export interface HeartbeatReply extends ControllerEpoch { pendingStops: string[] }
export interface ClaimMessage extends PlacementMessage { hostId: HostId; jobId: string }
export type ClaimReply = ({ accepted: true; lease: Lease } | { accepted: false; reason: string }) & ControllerEpoch;
export interface DispatchMessage extends PlacementMessage {
  lease: Lease;
  command: string;
  cwd: string;
  timeoutMs: number;
}
export interface DispatchReply extends ControllerEpoch { accepted: boolean; leaseId: string; reason?: string }
export interface StopMessage extends PlacementMessage { jobId: string; leaseId: string; reason: string }
export interface ReportMessage extends PlacementMessage {
  jobId: string;
  leaseId: string;
  hostId: HostId;
  status: "completed" | "failed" | "killed" | "lost";
  exitCode: number | null;
  signal: string | null;
  endedAt: number;
  reason?: string;
}
export interface ReportReply extends ControllerEpoch { accepted: boolean; reason?: string }
export interface TakeoverMessage extends PlacementMessage { reconcile: boolean }
export interface ReleaseMessage extends PlacementMessage { toControllerId: HostId }
