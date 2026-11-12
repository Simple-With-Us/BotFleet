import type { RoutineOutcomeCode, RoutineFailurePhase } from "../../shared/routine-outcomes";
import type { RoutineRunOn } from "../../shared/run-on";
export type { RoutineRunOn } from "../../shared/run-on";

export type RoutineSchedule =
  | { type: "once"; at: number }
  | { type: "daily"; time: string; weekdays: number[]; timeZone?: string };

export type RoutineRunTrigger = "schedule" | "manual" | "webhook" | "resource" | "imessage";

export type RoutineRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "missed";

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  botId: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  schedule: RoutineSchedule;
  scheduleTimeZoneSource?: "stored" | "host";
  durationMinutes: number;
  oneShotWake?: boolean;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  routineName: string;
  prompt?: string;
  durationMinutes?: number;
  botId: string;
  runOn: RoutineRunOn;
  scheduledFor: number;
  status: RoutineRunStatus;
  manual: boolean;
  triggerSource?: RoutineRunTrigger;
  webhookId?: string;
  deliveryId?: string;
  threadId?: string;
  ownerThreadId?: string;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  error?: string;
  cost?: number | null;
  denials?: string[];
  createdAt: number;
  seenAt?: number;
  coalescedInto?: string;
  /** Why this run is sitting QUEUED instead of dispatching.  Absent when the run
   *  is simply not due, or when nothing is holding it — a queued run with no
   *  explanation is indistinguishable from a stuck scheduler. */
  holdReason?: string;
  outcomeCode?: RoutineOutcomeCode;
  failurePhase?: RoutineFailurePhase;
  engineId?: string;
  driver?: string;
  model?: string;
}

export interface RoutineInput {
  name: string;
  prompt: string;
  botId: string;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  schedule: RoutineSchedule;
  durationMinutes?: number;
}
