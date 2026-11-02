// Settings → Resources: the read-only view over GET /api/host/resources.
//
// Display side only: this tab shows host readings plus the saved admission
// thresholds against the applied values.  Editing the unset-by-default
// headroom knobs is out of scope — numbers are owner-gated, so this module
// never builds a PUT/PATCH body; the component renders disabled controls
// with an "owner sets these" note instead.
//
// Copy rules (docs/plans/2026-10-29-native-server-mode.md, "Headroom
// Profiles And What The UI May Say" and docs/verification/headroom.md):
// units on every number; "Enforced by the system" only for kernelCap;
// "Not set" never reads as a number; the words "limit"/"cap" appear only on
// a kernelCap row; times in Central, 12-hour.
import { z } from "zod";
import { api } from "@/state/store";
import type {
  CapacitySample,
  EnforcementState,
  HostResourcesReport,
  StorageState,
} from "../../shared/placement.ts";

/** The three fetch states the tab renders.  Static-markup tests drive the
 *  pure `ResourcesSectionView` with one of these directly, so loading,
 *  error and mismatch output never depend on a live harness. */
export type HostResourcesState =
  | { status: "loading" }
  | { status: "refreshing"; report: HostResourcesReport }
  | { status: "error"; message: string }
  | { status: "ready"; report: HostResourcesReport };

/** The refresh transition: from ready (or an in-flight refresh) the last
 *  report stays on screen under a refreshing flag, so readings never vanish
 *  and the button spins; from loading or error there is no report to keep,
 *  so it loads clean. */
export function nextRefreshState(current: HostResourcesState): HostResourcesState {
  if (current.status === "ready") return { status: "refreshing", report: current.report };
  if (current.status === "refreshing") return current;
  return { status: "loading" };
}

/** GET /api/host/resources through the store's api() helper (not bare
 *  fetch): api() checks res.ok, so a 404 from a harness that predates the
 *  route and a 403 from the loopback owner gate arrive as thrown errors
 *  instead of a body that parses into an empty report. */
const storageSchema: z.ZodType<StorageState> = z.object({
  online: z.boolean(),
  dataDevice: z.string().nullable(),
  rootDevice: z.string().nullable(),
  reason: z.string().optional(),
});

const sampleSchema: z.ZodType<CapacitySample> = z.object({
  at: z.number(),
  cores: z.number().nullable(),
  loadPerCore: z.number().nullable(),
  ramTotalBytes: z.number().nullable(),
  ramAvailableBytes: z.number().nullable(),
  memoryPressure: z.enum(["normal", "warning", "critical"]).nullable(),
  memoryAvailablePercent: z.number().nullable(),
  swapTotalBytes: z.number().nullable(),
  swapUsedBytes: z.number().nullable(),
  diskTotalBytes: z.number().nullable(),
  diskFreeBytes: z.number().nullable(),
  inodesTotal: z.number().nullable(),
  inodesFree: z.number().nullable(),
  dataVolume: z.object({ device: z.string(), mountPoint: z.string() }).nullable(),
  rootDiskFreeBytes: z.number().nullable(),
  storage: storageSchema.nullable().optional(),
});

const admissionSchema: z.ZodType<HostResourcesReport["admission"]> = z.object({
  maxSwapPercent: z.number(),
  minFreeDiskBytes: z.number(),
  minFreeInodes: z.number().optional(),
  reservedCpuCores: z.number().optional(),
  reservedRamBytes: z.number().optional(),
  minMemoryAvailablePercent: z.number().optional(),
  unknownReading: z.literal("admit"),
});

const enforcementSchema: z.ZodType<EnforcementState> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("kernelCap"), mechanism: z.string() }),
  z.object({ kind: z.literal("stopWhenOver") }),
  z.object({ kind: z.literal("gateOnly") }),
  z.object({ kind: z.literal("priorityOnly") }),
  z.object({ kind: z.literal("unsupported"), reason: z.string() }),
  z.object({ kind: z.literal("notApplied"), reason: z.string(), restartRequired: z.boolean() }),
]);

/** The report contract, parsed at the I/O boundary below — an older
 *  harness, or a body that never parsed, fails here instead of rendering
 *  a half-filled card. */
export const hostResourcesReportSchema = z.object({
  hostId: z.string(),
  version: z.string().nullable(),
  platform: z.enum(["darwin", "linux"]),
  capabilities: z.array(z.string()),
  sample: sampleSchema,
  storage: storageSchema.nullable().optional(),
  admission: admissionSchema,
  enforcement: z.record(z.enum(["cpu", "memory", "swap", "disk", "inodes", "io"]), enforcementSchema),
  observedLimits: z.record(z.string(), z.string().nullable()),
  limitations: z.array(z.string()),
});

export async function fetchHostResources(): Promise<HostResourcesReport> {
  const parsed = hostResourcesReportSchema.safeParse(await api("/api/host/resources"));
  if (!parsed.success) {
    throw new Error("The host report was not a resource report.");
  }
  // SAFETY: the schema above checks every field the tab reads; hostId and
  // capabilities stay their wire strings because the tab only displays
  // them, never routes or admits on them.
  return parsed.data as HostResourcesReport;
}

/** "this Mac" on darwin, "the server" on linux — the nouns the refusal and
 *  no-capacity sentences use, so no host name of Jay's lands in a default. */
export function hostNoun(report: Pick<HostResourcesReport, "platform" | "hostId">): string {
  if (report.platform === "darwin" || report.hostId.startsWith("mac:")) return "this Mac";
  if (report.platform === "linux" || report.hostId.startsWith("server:")) return "the server";
  return "this host";
}

/** The one enforcement sentence per EnforcementState, and nothing else. */
export function enforcementSentence(state: EnforcementState, noun: string): string {
  const gap = "  ";
  switch (state.kind) {
    case "kernelCap":
      return `Enforced by the system (${state.mechanism})`;
    case "stopWhenOver":
      return "Watched: jobs are stopped if they exceed it";
    case "gateOnly":
      return "Checked before each job starts";
    case "priorityOnly":
      return `Full speed allowed.${gap}Jobs run at background priority.`;
    case "unsupported":
      return `Not enforced on ${noun}: ${state.reason}`;
    case "notApplied":
      return state.reason.startsWith("Not applied") ? state.reason : `Not applied: ${state.reason}`;
  }
}

/** Every byte count with its unit. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

export function formatCount(n: number, singular: string, plural?: string): string {
  const word = n === 1 ? singular : (plural ?? `${singular}s`);
  return `${n.toLocaleString("en-US")} ${word}`;
}

/** Central time, 12-hour — the copy rule for every timestamp on this tab. */
export function formatCentralTime(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(ms);
}

const unknown = "Unknown";

/** One admission threshold with its saved value against what is applied.
 *  Saved is the value in the store (absent means "Not set": no gate, and
 *  the built-in default is named, never a number).  Applied is what the
 *  runtime read back after applying — for a gate, the threshold the probe
 *  is using; it is never copied from saved, and a row whose enforcement
 *  reads notApplied or unsupported carries that sentence instead of the
 *  number.  `mismatch` is the saved-vs-applied sentence shown when the two
 *  differ in force. */
export interface SavedAppliedRow {
  key: string;
  label: string;
  /** The config knob, e.g. jobs.admission.maxSwapPercent. */
  knob: string;
  /** The Infisical name that overrides the file, where the value comes from. */
  source: string;
  saved: string;
  applied: string;
  mismatch: string | null;
  note?: string;
}

/** "This leaves BotFleet no capacity on <host>.  New jobs will wait here
 *  until you lower it" — a reservation at or above detected is allowed and
 *  honest, and no job is admitted on that host while it stands. */
export function noCapacitySentence(noun: string): string {
  return `This leaves BotFleet no capacity on ${noun}.  New jobs will wait here until you lower it`;
}

/** One threshold's applied cell: the sentence in force, plus the mismatch
 *  line when saved and applied differ. */
export interface AppliedCell {
  applied: string;
  mismatch: string | null;
}

function appliedFromEnforcement(
  value: string,
  enforcement: EnforcementState,
  noun: string,
): AppliedCell {
  if (enforcement.kind === "notApplied" || enforcement.kind === "unsupported") {
    const sentence = enforcementSentence(enforcement, noun);
    return { applied: sentence, mismatch: sentence };
  }
  return { applied: value, mismatch: null };
}

/** The memory enforcement the tab may claim.  server/host-resources.ts
 *  marks enforcement.memory unsupported on a swapless host, but
 *  server/jobs/admission.ts still refuses jobs on the owner-set
 *  available-memory headroom gates there: probe.headroomReadings() reads
 *  MemAvailable and needs no swap.  The swap gate is honestly unsupported
 *  on that host, yet a set headroom knob keeps a memory gate in force —
 *  never claim unenforced what the scheduler enforces. */
function effectiveMemoryEnforcement(report: HostResourcesReport): EnforcementState {
  const headroomSet =
    report.admission.reservedRamBytes !== undefined || report.admission.minMemoryAvailablePercent !== undefined;
  if (headroomSet && report.sample.swapTotalBytes === 0 && report.enforcement.memory.kind === "unsupported") {
    return { kind: "gateOnly" };
  }
  return report.enforcement.memory;
}

export function admissionRows(report: HostResourcesReport): SavedAppliedRow[] {
  const noun = hostNoun(report);
  const { admission, enforcement, sample } = report;
  const rows: SavedAppliedRow[] = [];

  // Swap gate.  The report always carries a number (the 98% built-in fills
  // an unset knob), so the note names the default instead of pretending a
  // saved-vs-unset distinction the route cannot see.
  {
    const value = `${admission.maxSwapPercent}%`;
    const { applied, mismatch } = appliedFromEnforcement(value, enforcement.swap, noun);
    rows.push({
      key: "maxSwapPercent",
      label: "Swap gate",
      knob: "jobs.admission.maxSwapPercent",
      source: "BOTFLEET_JOBS_MAX_SWAP_PERCENT",
      saved: value,
      applied,
      mismatch,
      note: "98% is the built-in default in force when the owner has set nothing — a current default, not a measured value.",
    });
  }

  // Disk floor on the data volume.
  {
    const value = formatBytes(admission.minFreeDiskBytes);
    const { applied, mismatch } = appliedFromEnforcement(value, enforcement.disk, noun);
    const overCapacity =
      sample.diskTotalBytes !== null && admission.minFreeDiskBytes >= sample.diskTotalBytes;
    rows.push({
      key: "minFreeDisk",
      label: "Minimum free disk",
      knob: "jobs.admission.minFreeDiskMb",
      source: "BOTFLEET_JOBS_MIN_FREE_DISK_MB",
      saved: value,
      applied,
      mismatch: mismatch === null && overCapacity ? noCapacitySentence(noun) : mismatch,
      note: "2 GB is the built-in default in force when the owner has set nothing — a current default, not a measured value.",
    });
  }

  // Inode floor.  Absent means no gate at all.
  {
    const saved = admission.minFreeInodes === undefined ? "Not set" : formatCount(admission.minFreeInodes, "inode");
    let applied = saved;
    let mismatch: string | null = null;
    if (admission.minFreeInodes === undefined) {
      applied = "Not set: no gate";
    } else {
      ({ applied, mismatch } = appliedFromEnforcement(saved, enforcement.inodes, noun));
    }
    rows.push({
      key: "minFreeInodes",
      label: "Minimum free inodes",
      knob: "jobs.admission.minFreeInodes",
      source: "BOTFLEET_JOBS_MIN_FREE_INODES",
      saved,
      applied,
      mismatch,
    });
  }

  // Reserved CPU cores.  Never an admission input on macOS (the owner
  // forbade a CPU cutoff on the Mac, not the setting): a saved value there
  // is shown against its not-applied sentence, never as a gate.
  {
    const saved = admission.reservedCpuCores === undefined ? "Not set" : formatCount(admission.reservedCpuCores, "core");
    let applied = saved;
    let mismatch: string | null = null;
    if (admission.reservedCpuCores !== undefined) {
      if (report.platform === "darwin") {
        applied = "Not applied on this Mac: reserved CPU never refuses a job on macOS; it sizes budgets instead";
        mismatch = applied;
      } else {
        // Fail closed like every other set knob: a notApplied or
        // unsupported cpu report is shown in force, never as applied.
        ({ applied, mismatch } = appliedFromEnforcement(saved, enforcement.cpu, noun));
        if (
          mismatch === null &&
          sample.cores !== null &&
          admission.reservedCpuCores >= sample.cores
        ) {
          mismatch = noCapacitySentence(noun);
        }
      }
    }
    rows.push({
      key: "reservedCpuCores",
      label: "Reserved CPU for other apps",
      knob: "jobs.admission.reservedCpuCores",
      source: "BOTFLEET_JOBS_RESERVED_CPU_CORES",
      saved,
      applied,
      mismatch,
      note: "Set by the owner — there is deliberately no default.  An unset knob leaves admission unchanged.",
    });
  }

  // Reserved RAM.
  {
    const saved = admission.reservedRamBytes === undefined ? "Not set" : formatBytes(admission.reservedRamBytes);
    let applied = saved;
    let mismatch: string | null = null;
    if (admission.reservedRamBytes !== undefined) {
      ({ applied, mismatch } = appliedFromEnforcement(saved, effectiveMemoryEnforcement(report), noun));
      if (
        mismatch === null &&
        sample.ramTotalBytes !== null &&
        admission.reservedRamBytes >= sample.ramTotalBytes
      ) {
        mismatch = noCapacitySentence(noun);
      }
    }
    rows.push({
      key: "reservedRam",
      label: "Reserved RAM for other apps",
      knob: "jobs.admission.reservedRamMb",
      source: "BOTFLEET_JOBS_RESERVED_RAM_MB",
      saved,
      applied,
      mismatch,
      note: "Set by the owner — there is deliberately no default.  An unset knob leaves admission unchanged.",
    });
  }

  // Minimum available-memory percent.
  {
    const saved = admission.minMemoryAvailablePercent === undefined ? "Not set" : `${admission.minMemoryAvailablePercent}%`;
    let applied = saved;
    let mismatch: string | null = null;
    if (admission.minMemoryAvailablePercent !== undefined) {
      ({ applied, mismatch } = appliedFromEnforcement(saved, effectiveMemoryEnforcement(report), noun));
    }
    rows.push({
      key: "minMemoryAvailablePercent",
      label: "Minimum available memory",
      knob: "jobs.admission.minMemoryAvailablePercent",
      source: "BOTFLEET_JOBS_MIN_MEMORY_AVAILABLE_PERCENT",
      saved,
      applied,
      mismatch,
      note: "Set by the owner — there is deliberately no default.  An unset knob leaves admission unchanged.",
    });
  }

  return rows;
}

/** One resource row: detected capacity, current use with its sample time,
 *  and the enforcement sentence from EnforcementState and nothing else. */
export interface ResourceRow {
  key: string;
  label: string;
  detected: string;
  use: string;
  enforcement: string;
  /** Red-row alert, e.g. the data volume unmounted mid-run. */
  alert?: string;
}

/** A gate whose reading is unknown admits (a broken probe must not switch
 *  jobs off), and says so where the person looks. */
function unknownReadingSentence(sampleAt: number): string {
  return `Reading unavailable as of ${formatCentralTime(sampleAt)}: not checked before jobs start`;
}

export function resourceRows(report: HostResourcesReport): ResourceRow[] {
  const noun = hostNoun(report);
  const { sample, enforcement } = report;
  const sampled = `Sampled ${formatCentralTime(sample.at)}`;
  const useWith = (text: string) => `${text} · ${sampled}`;

  const cpuUse =
    sample.loadPerCore === null ? unknown : `Load ${sample.loadPerCore.toFixed(2)} per core`;
  const memoryUse =
    sample.ramAvailableBytes === null
      ? unknown
      : sample.ramTotalBytes !== null && sample.memoryAvailablePercent !== null
        ? `${formatBytes(sample.ramAvailableBytes)} available (${Math.round(sample.memoryAvailablePercent)}% of total)`
        : `${formatBytes(sample.ramAvailableBytes)} available`;
  const swapUse =
    sample.swapUsedBytes === null
      ? unknown
      : sample.swapTotalBytes
        ? `${formatBytes(sample.swapUsedBytes)} used (${Math.round((sample.swapUsedBytes / sample.swapTotalBytes) * 100)}% of total)`
        : `${formatBytes(sample.swapUsedBytes)} used`;
  const diskUse = sample.diskFreeBytes === null ? unknown : `${formatBytes(sample.diskFreeBytes)} free`;
  const rootUse = sample.rootDiskFreeBytes === null ? unknown : `${formatBytes(sample.rootDiskFreeBytes)} free`;
  const inodeUse = sample.inodesFree === null ? unknown : `${formatCount(sample.inodesFree, "inode")} free`;

  const gateOrUnknown = (use: string, enforcementState: EnforcementState): string =>
    use === unknown && enforcementState.kind === "gateOnly"
      ? unknownReadingSentence(sample.at)
      : enforcementSentence(enforcementState, noun);

  const rows: ResourceRow[] = [
    {
      key: "cpu",
      label: "CPU",
      detected: sample.cores === null ? unknown : formatCount(sample.cores, "core"),
      use: useWith(cpuUse),
      enforcement: enforcementSentence(enforcement.cpu, noun),
    },
    {
      key: "memory",
      label: "Memory",
      detected: sample.ramTotalBytes === null ? unknown : formatBytes(sample.ramTotalBytes),
      use: useWith(
        sample.memoryPressure !== null && memoryUse !== unknown
          ? `${memoryUse} · Pressure ${sample.memoryPressure}`
          : memoryUse,
      ),
      enforcement: gateOrUnknown(memoryUse, effectiveMemoryEnforcement(report)),
    },
    {
      key: "swap",
      label: "Swap",
      detected:
        sample.swapTotalBytes === null ? unknown : sample.swapTotalBytes === 0 ? "None configured" : formatBytes(sample.swapTotalBytes),
      use: useWith(swapUse),
      enforcement: gateOrUnknown(swapUse, enforcement.swap),
    },
    {
      key: "disk",
      label: sample.dataVolume ? `Disk (${sample.dataVolume.mountPoint})` : "Disk (data volume)",
      detected: sample.diskTotalBytes === null ? unknown : formatBytes(sample.diskTotalBytes),
      use: useWith(diskUse),
      enforcement: gateOrUnknown(diskUse, enforcement.disk),
    },
    {
      key: "rootDisk",
      label: "Disk (root)",
      detected: unknown,
      use: useWith(rootUse),
      enforcement: enforcementSentence(enforcement.disk, noun),
    },
    {
      key: "inodes",
      label: "Inodes",
      detected: sample.inodesTotal === null ? unknown : formatCount(sample.inodesTotal, "inode"),
      use: useWith(inodeUse),
      enforcement: gateOrUnknown(inodeUse, enforcement.inodes),
    },
    {
      key: "io",
      label: "I/O",
      detected: sample.dataVolume ? `${sample.dataVolume.device} on ${sample.dataVolume.mountPoint}` : unknown,
      use: useWith("Not sampled"),
      enforcement: enforcementSentence(enforcement.io, noun),
    },
  ];

  if (sample.storage?.online === false) {
    const mount = sample.dataVolume?.mountPoint ?? "data volume";
    const disk = rows.find((row) => row.key === "disk");
    if (disk) {
      disk.alert = `Data volume ${mount} is not mounted.  BotFleet has stopped admitting jobs there and is not writing to the root disk.`;
    }
  }
  return rows;
}

/** Header line for the host card: platform, version and capabilities. */
export function hostSubtitle(report: HostResourcesReport): string {
  const platform = report.platform === "darwin" ? "macOS" : report.platform === "linux" ? "Linux" : report.platform;
  const version = report.version ?? "unknown version";
  const capabilities = report.capabilities.length > 0 ? report.capabilities.join(", ") : "no capabilities reported";
  return `${platform} · ${version} · ${capabilities}`;
}
