import type { RoutineRunOn } from "@/lib/routines";

export const RESOURCE_METRICS = [
  "disk_free_gb",
  "disk_used_pct",
  "ram_used_pct",
  "swap_used_pct",
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

export const METRIC_LABEL: Record<ResourceMetric, string> = {
  disk_free_gb: "Disk free (GB)",
  disk_used_pct: "Disk used (%)",
  ram_used_pct: "Memory used (%)",
  swap_used_pct: "Swap used (%)",
  swap_used_gb: "Swap used (GB)",
  load_1m: "Processor load (1 min)",
};
