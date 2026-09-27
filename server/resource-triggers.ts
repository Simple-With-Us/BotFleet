import { normalizeRunOn, type RoutineRunOn } from "../shared/run-on.ts";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statfsSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { parseJson, schemaIssue, type JsonValue } from "./schema.ts";

export const RESOURCE_METRICS = [
  "disk_free_gb",
  "disk_used_pct",
  "ram_used_pct",
  "swap_used_pct",
  // macOS grows the swap store on demand, so used/total sits near 90% whether 2GB or
  // 20GB is paged out.  The absolute figure is the one that tracks real pressure -- and
  // real disk consumption, since swapfiles live on the data volume.
  "swap_used_gb",
  "load_1m",
] as const;

export type ResourceMetric = (typeof RESOURCE_METRICS)[number];
export type ResourceCmp = "below" | "above";

export interface HostSample {
  at: number;
  diskFreeGb: number;
  diskUsedPct: number;
  ramUsedPct: number;
  swapUsedPct: number | null;
  swapUsedGb: number | null;
  swapTotalGb: number | null;
  load1m: number;
}

export interface ResourceTrigger {
  id: string;
  name: string;
  prompt: string;
  botId: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  metric: ResourceMetric;
  cmp: ResourceCmp;
  threshold: number;
  cooldownMinutes: number;
  /** Consecutive breaching samples required before firing.  Guards against transient
   *  spikes -- a `du` sweep or a build can take 1m load from 12 to 120 and back inside
   *  one sample window, and waking a bot for that is pure noise. */
  sustainSamples: number;
  lastFiredAt?: number;
  lastSample?: HostSample;
  lastValue?: number;
  fireCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ResourceTriggerInput {
  name: string;
  prompt: string;
  botId: string;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  metric: ResourceMetric;
  cmp: ResourceCmp;
  threshold: number;
  cooldownMinutes?: number;
  sustainSamples?: number;
}

export interface ResourceTriggerFire {
  trigger: ResourceTrigger;
  sample: HostSample;
  value: number;
  deliveryId: string;
}

const triggerInputSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  botId: z.string(),
  runOn: z
    .enum(["bot", "cloud", "maus"])
    .transform((value): "bot" | "cloud" => (value === "maus" ? "bot" : value))
    .optional(),
  enabled: z.boolean().optional(),
  metric: z.enum(RESOURCE_METRICS),
  cmp: z.enum(["below", "above"]),
  threshold: z.number().finite(),
  cooldownMinutes: z.number().finite().optional(),
  sustainSamples: z.number().finite().optional(),
});

const triggerPatchSchema = triggerInputSchema.partial();

const storedSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  prompt: z.string(),
  botId: z.string(),
  runOn: z
    .enum(["bot", "cloud", "maus"])
    .transform((value): "bot" | "cloud" => (value === "maus" ? "bot" : value)),
  enabled: z.boolean(),
  metric: z.enum(RESOURCE_METRICS),
  cmp: z.enum(["below", "above"]),
  threshold: z.number(),
  cooldownMinutes: z.number(),
  sustainSamples: z.number().optional().default(1),
  lastFiredAt: z.number().optional(),
  lastSample: z
    .object({
      at: z.number(),
      diskFreeGb: z.number(),
      diskUsedPct: z.number(),
      ramUsedPct: z.number(),
      swapUsedPct: z.number().nullable(),
      swapUsedGb: z.number().nullable().optional().default(null),
      swapTotalGb: z.number().nullable(),
      load1m: z.number(),
    })
    .optional(),
  lastValue: z.number().optional(),
  fireCount: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const fileSchema = z.object({
  version: z.literal(1),
  triggers: z.array(storedSchema),
});

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

export function valueFor(metric: ResourceMetric, sample: HostSample): number | null {
  switch (metric) {
    case "disk_free_gb":
      return sample.diskFreeGb;
    case "disk_used_pct":
      return sample.diskUsedPct;
    case "ram_used_pct":
      return sample.ramUsedPct;
    case "swap_used_pct":
      return sample.swapUsedPct;
    case "swap_used_gb":
      return sample.swapUsedGb;
    case "load_1m":
      return sample.load1m;
  }
}

export function crossed(cmp: ResourceCmp, threshold: number, value: number): boolean {
  return cmp === "below" ? value <= threshold : value >= threshold;
}

function parseDfK(text: string): { freeGb: number; usedPct: number } | null {
  const line = text.trim().split("\n")[1];
  if (!line) return null;
  const parts = line.split(/\s+/);
  if (parts.length < 5) return null;
  const availK = Number(parts[3]);
  const cap = Number(String(parts[4]).replace("%", ""));
  if (!Number.isFinite(availK) || !Number.isFinite(cap) || cap < 0 || cap > 100) return null;
  return { freeGb: availK / (1024 * 1024), usedPct: cap };
}

function parseSwap(text: string): { usedPct: number; usedGb: number; totalGb: number } | null {
  const match = text.match(/total\s*=\s*([\d.]+)M.*?used\s*=\s*([\d.]+)M/i);
  if (!match) return null;
  const totalMb = Number(match[1]);
  const usedMb = Number(match[2]);
  if (!Number.isFinite(totalMb) || totalMb <= 0) return null;
  if (!Number.isFinite(usedMb)) return null;
  return { usedPct: (usedMb / totalMb) * 100, usedGb: usedMb / 1024, totalGb: totalMb / 1024 };
}

/**
 * Activity-Monitor-style "memory used" on macOS.
 *
 * node:os freemem() counts only genuinely free pages.  On a busy Mac that is a handful
 * of MB essentially always (this host reads ~172MB free of 16GB), so a ramUsedPct built
 * from it pins near 99% and carries no signal.  Real pressure is wired + active + what
 * the compressor is holding.
 */
function darwinRamUsedPct(): number | null {
  try {
    const out = execFileSync("vm_stat", [], { encoding: "utf8", timeout: 3000 });
    const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
    const pages = (label: string): number => {
      const m = out.match(new RegExp(`${label}:\\s+(\\d+)`));
      return m ? Number(m[1]) : 0;
    };
    const used =
      (pages("Pages wired down") + pages("Pages active") + pages("Pages occupied by compressor")) * pageSize;
    const total = totalmem();
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(used) || used <= 0) return null;
    return Math.min(100, (used / total) * 100);
  } catch {
    return null;
  }
}

export function sampleHost(now = Date.now()): HostSample {
  const total = totalmem();
  const free = freemem();
  const ramUsedPct =
    (process.platform === "darwin" ? darwinRamUsedPct() : null) ??
    (total > 0 ? ((total - free) / total) * 100 : 0);

  let diskFreeGb = 0;
  let diskUsedPct = 0;

  if (process.platform === "win32") {
    try {
      const rootPath = process.cwd().slice(0, 3);
      const stats = statfsSync(rootPath);
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bavail * stats.bsize;
      if (totalBytes > 0) {
        diskFreeGb = freeBytes / (1024 * 1024 * 1024);
        diskUsedPct = ((totalBytes - freeBytes) / totalBytes) * 100;
      }
    } catch {
      /* keep zeros */
    }
  } else {
    // On macOS `/` is the sealed read-only system snapshot.  It shares the APFS container
    // (so Avail is right) but its Capacity% describes the ~12GB system volume, not the
    // data volume: this host reported 13% on `/` while the data volume was 81% full.  A
    // disk_used_pct trigger read off `/` could never fire.
    const diskTargets = process.platform === "darwin" ? ["/System/Volumes/Data", "/"] : ["/"];
    for (const target of diskTargets) {
      try {
        const parsed = parseDfK(execFileSync("df", ["-k", target], { encoding: "utf8", timeout: 5000 }));
        if (parsed) {
          diskFreeGb = parsed.freeGb;
          diskUsedPct = parsed.usedPct;
          break;
        }
      } catch {
        /* try the next target */
      }
    }
    if (diskFreeGb === 0 && diskUsedPct === 0) {
      try {
        const stats = statfsSync("/");
        const totalBytes = stats.blocks * stats.bsize;
        const freeBytes = stats.bavail * stats.bsize;
        if (totalBytes > 0) {
          diskFreeGb = freeBytes / (1024 * 1024 * 1024);
          diskUsedPct = ((totalBytes - freeBytes) / totalBytes) * 100;
        }
      } catch {
        /* keep zeros */
      }
    }
  }
  let swapUsedPct: number | null = null;
  let swapUsedGb: number | null = null;
  let swapTotalGb: number | null = null;
  if (process.platform === "darwin") {
    try {
      const vm = execFileSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8", timeout: 3000 });
      const parsed = parseSwap(vm);
      if (parsed) {
        swapUsedPct = parsed.usedPct;
        swapUsedGb = parsed.usedGb;
        swapTotalGb = parsed.totalGb;
      }
    } catch {
      /* optional */
    }
  }
  return {
    at: now,
    diskFreeGb: Math.round(diskFreeGb * 100) / 100,
    diskUsedPct: Math.round(diskUsedPct * 10) / 10,
    ramUsedPct: Math.round(ramUsedPct * 10) / 10,
    swapUsedPct: swapUsedPct == null ? null : Math.round(swapUsedPct * 10) / 10,
    swapUsedGb: swapUsedGb == null ? null : Math.round(swapUsedGb * 100) / 100,
    swapTotalGb: swapTotalGb == null ? null : Math.round(swapTotalGb * 100) / 100,
    load1m: Math.round(loadavg()[0] * 100) / 100,
  };
}

function eventPrompt(trigger: ResourceTrigger, sample: HostSample, value: number, deliveryId: string): string {
  const nproc = Math.max(1, cpus().length);
  return [
    trigger.prompt.trim(),
    "",
    "Event: resource.pressure",
    `Delivery: ${deliveryId}`,
    `Metric: ${trigger.metric} ${trigger.cmp} ${trigger.threshold} (value ${value})`,
    "[UNTRUSTED RESOURCE SAMPLE]",
    JSON.stringify({ sample, cores: nproc }, null, 2),
    "[/UNTRUSTED RESOURCE SAMPLE]",
  ].join("\n");
}

export interface ResourceTriggerManagerOptions {
  file?: string;
  now?: () => number;
  sample?: () => HostSample;
  emit?: (event: ResourceTriggerManagerEvent) => void;
  botState: (botId: string) => "ready" | "busy" | "missing";
  /** Synchronous admission fence used during an update boundary. */
  admit?: () => boolean;
  enqueue: (input: {
    triggerId: string;
    triggerName: string;
    prompt: string;
    botId: string;
    runOn: RoutineRunOn;
    deliveryId: string;
    receivedAt: number;
  }) => { id: string };
  pendingRuns?: (triggerId: string) => number;
  intervalMs?: number;
}

export type ResourceTriggerManagerEvent =
  | { kind: "resource-trigger"; trigger: ResourceTrigger }
  | { kind: "resource-trigger.deleted"; triggerId: string }
  | { kind: "resource-trigger.fired"; fire: ResourceTriggerFire };

const MAX_PENDING = 2;
// tick() runs every 30s.  Rewriting the trigger file each time (atomic write = temp file
// + rename) purely to refresh lastSample is ~2,880 needless writes/day on the very disk
// this feature exists to protect.  Live values still stream to the UI via emit(); the
// file only needs a periodic durable checkpoint.
const SAMPLE_PERSIST_MS = 5 * 60_000;

export class ResourceTriggerManager {
  private triggers: ResourceTrigger[] = [];
  private readonly file: string;
  private readonly now: () => number;
  private readonly sampleFn: () => HostSample;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private lastSamplePersistAt = 0;
  /** triggerId -> consecutive breaching samples.  In-memory only; a restart re-arms. */
  private readonly streaks = new Map<string, number>();
  private readonly options: ResourceTriggerManagerOptions;

  constructor(options: ResourceTriggerManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "resource-triggers.json");
    this.now = options.now ?? Date.now;
    this.sampleFn = options.sample ?? (() => sampleHost(this.now()));
    mkdirSync(dirname(this.file), { recursive: true });
    if (existsSync(this.file)) {
      try {
        const rawText = readFileSync(this.file, "utf8");
        const parsed = fileSchema.safeParse(parseJson(rawText));
        if (parsed.success) {
          this.triggers = parsed.data.triggers;
          if (/"runOn"\s*:\s*"maus"/.test(rawText)) this.save();
        }
      } catch {
        this.triggers = [];
      }
    }
  }

  list(): ResourceTrigger[] {
    return this.triggers.map((trigger) => ({ ...trigger }));
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify({ version: 1, triggers: this.triggers }, null, 2) + "\n");
  }

  private emit(trigger: ResourceTrigger): void {
    this.options.emit?.({ kind: "resource-trigger", trigger: { ...trigger } });
  }

  create(raw: JsonValue): ResourceTrigger {
    const parsed = triggerInputSchema.safeParse(raw);
    if (!parsed.success) fail(400, schemaIssue(parsed.error, "Invalid resource trigger"));
    const name = parsed.data.name.trim().slice(0, 80);
    const prompt = parsed.data.prompt.trim().slice(0, 20_000);
    const botId = parsed.data.botId.trim();
    if (!name) fail(400, "Give the trigger a name");
    if (!botId) fail(400, "Choose a Bot");
    if (!prompt) fail(400, "Give the bot a prompt");
    const runOn = normalizeRunOn(parsed.data.runOn);
    const cooldownMinutes = Math.max(5, Math.min(24 * 60, Math.round(parsed.data.cooldownMinutes ?? 45)));
    const sustainSamples = Math.max(1, Math.min(20, Math.round(parsed.data.sustainSamples ?? 3)));
    const now = this.now();
    const trigger: ResourceTrigger = {
      id: randomUUID(),
      name,
      prompt,
      botId,
      runOn,
      enabled: parsed.data.enabled !== false,
      metric: parsed.data.metric,
      cmp: parsed.data.cmp,
      threshold: parsed.data.threshold,
      cooldownMinutes,
      sustainSamples,
      fireCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.triggers.unshift(trigger);
    this.save();
    this.emit(trigger);
    return { ...trigger };
  }

  update(id: string, raw: JsonValue): ResourceTrigger | null {
    const trigger = this.triggers.find((candidate) => candidate.id === id);
    if (!trigger) return null;
    const parsed = triggerPatchSchema.safeParse(raw);
    if (!parsed.success) fail(400, schemaIssue(parsed.error, "Invalid resource trigger"));
    const patch = parsed.data;
    if (patch.name != null) trigger.name = patch.name.trim().slice(0, 80) || trigger.name;
    if (patch.prompt != null) trigger.prompt = patch.prompt.trim().slice(0, 20_000) || trigger.prompt;
    if (patch.botId != null) trigger.botId = patch.botId.trim() || trigger.botId;
    if (patch.runOn != null) trigger.runOn = patch.runOn;
    if (patch.enabled != null) trigger.enabled = patch.enabled;
    if (patch.metric != null) trigger.metric = patch.metric;
    if (patch.cmp != null) trigger.cmp = patch.cmp;
    if (patch.threshold != null) trigger.threshold = patch.threshold;
    if (patch.cooldownMinutes != null) {
      trigger.cooldownMinutes = Math.max(5, Math.min(24 * 60, Math.round(patch.cooldownMinutes)));
    }
    if (patch.sustainSamples != null) {
      trigger.sustainSamples = Math.max(1, Math.min(20, Math.round(patch.sustainSamples)));
    }
    trigger.updatedAt = this.now();
    this.save();
    this.emit(trigger);
    return { ...trigger };
  }

  remove(id: string): boolean {
    const at = this.triggers.findIndex((candidate) => candidate.id === id);
    if (at < 0) return false;
    const [trigger] = this.triggers.splice(at, 1);
    this.save();
    this.options.emit?.({ kind: "resource-trigger.deleted", triggerId: trigger!.id });
    return true;
  }

  disableForBot(botId: string): void {
    let changed = false;
    for (const trigger of this.triggers) {
      if (trigger.botId !== botId || !trigger.enabled) continue;
      trigger.enabled = false;
      trigger.updatedAt = this.now();
      this.emit(trigger);
      changed = true;
    }
    if (changed) this.save();
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(): ResourceTriggerFire[] {
    if (this.options.admit?.() === false) return [];
    if (this.ticking) return [];
    this.ticking = true;
    const fired: ResourceTriggerFire[] = [];
    try {
      const sample = this.sampleFn();
      const now = this.now();
      let changed = false;
      for (const trigger of this.triggers) {
        trigger.lastSample = sample;
        const value = valueFor(trigger.metric, sample);
        if (value != null) trigger.lastValue = value;
        if (!trigger.enabled) continue;
        if (this.options.botState(trigger.botId) === "missing") continue;
        if (value == null) continue;
        if (!crossed(trigger.cmp, trigger.threshold, value)) {
          this.streaks.delete(trigger.id);
          continue;
        }
        const need = Math.max(1, trigger.sustainSamples ?? 1);
        const streak = (this.streaks.get(trigger.id) ?? 0) + 1;
        this.streaks.set(trigger.id, streak);
        if (streak < need) continue;
        const cooldownMs = trigger.cooldownMinutes * 60_000;
        if (trigger.lastFiredAt && now - trigger.lastFiredAt < cooldownMs) continue;
        if ((this.options.pendingRuns?.(trigger.id) ?? 0) >= MAX_PENDING) continue;
        const deliveryId = randomUUID();
        const prompt = eventPrompt(trigger, sample, value, deliveryId);
        this.options.enqueue({
          triggerId: trigger.id,
          triggerName: trigger.name,
          prompt,
          botId: trigger.botId,
          runOn: trigger.runOn,
          deliveryId,
          receivedAt: now,
        });
        this.streaks.delete(trigger.id);
        trigger.lastFiredAt = now;
        trigger.fireCount += 1;
        trigger.updatedAt = now;
        const fire: ResourceTriggerFire = { trigger: { ...trigger }, sample, value, deliveryId };
        fired.push(fire);
        this.options.emit?.({ kind: "resource-trigger.fired", fire });
        this.emit(trigger);
        changed = true;
      }
      if (changed) {
        this.save();
        this.lastSamplePersistAt = now;
      } else if (this.triggers.length && now - this.lastSamplePersistAt >= SAMPLE_PERSIST_MS) {
        // Checkpoint lastSample occasionally so a restart shows recent values.
        this.save();
        this.lastSamplePersistAt = now;
      }
    } finally {
      this.ticking = false;
    }
    return fired;
  }
}
