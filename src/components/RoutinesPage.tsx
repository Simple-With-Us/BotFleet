import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Cloud,
  ExternalLink,
  Gauge,
  Laptop,
  Loader2,
  Pause,
  Play,
  Plus,
  Trash2,
  Webhook,
  X,
} from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { MiniMonth } from "@/components/routines/MiniMonth";
import { stateForBot } from "@/lib/mascot";
import { WebhooksPanel } from "@/components/WebhooksPanel";
import { ResourceTriggersPanel } from "@/components/ResourceTriggersPanel";
import { cn } from "@/lib/cn";
import { BOT_COLORS, type BotState } from "@/lib/mascot";
import type { Routine, RoutineInput, RoutineRunOn, RoutineRunStatus, RoutineSchedule } from "@/lib/routines";
import {
  CENTRAL_TIME_ZONE,
  DAY_NAMES,
  calendarDayLabel,
  calendarMinuteOfDay,
  editedDailySchedule,
  niceCalendarDate,
  niceCalendarTime,
  projectedRoutineItems,
  routineScheduleLabel,
  timeZoneLabel,
  type CalendarItem,
} from "@/lib/routine-calendar";
import { api, useStore, type Bot } from "@/state/store";
import { routineOutcomeCode, routineOutcomeSummary, ROUTINE_OUTCOME_LABELS } from "../../shared/routine-outcomes";
import {
  addDaysInTimeZone,
  epochFromInputDateTime,
  inputDateTimeInTimeZone,
  nextWholeHourInTimeZone,
  shortTimeZoneName,
  startOfDayInTimeZone,
  startOfWeekInTimeZone,
} from "../../shared/time-zone";

const HOUR_HEIGHT = 68;

function startOfDay(at: number) {
  return startOfDayInTimeZone(at, CENTRAL_TIME_ZONE);
}

function addDays(at: number, days: number) {
  return addDaysInTimeZone(at, days, CENTRAL_TIME_ZONE);
}

function startOfWeek(at: number) {
  return startOfWeekInTimeZone(at, CENTRAL_TIME_ZONE);
}

function toInputDateTime(at: number) {
  return inputDateTimeInTimeZone(at, CENTRAL_TIME_ZONE);
}

function niceDate(at: number, includeWeekday = true) {
  return niceCalendarDate(at, includeWeekday);
}

function niceTime(at: number) {
  return niceCalendarTime(at);
}

function scheduleLabel(routine: Routine) {
  return routineScheduleLabel(routine);
}

function canToggleRoutine(routine: Routine) {
  return routine.schedule.type === "daily" || routine.schedule.at > Date.now();
}

function statusState(status: RoutineRunStatus): BotState {
  switch (status) {
    case "queued":
      return "drowsy";
    case "running":
      return "working";
    case "waiting":
      return "curious";
    case "completed":
      return "proud";
    case "failed":
    case "missed":
      return "sad";
    case "cancelled":
      return "sleeping";
  }
}

function statusTone(status: RoutineRunStatus) {
  switch (status) {
    case "running":
      return "text-accent";
    case "waiting":
      return "text-warning";
    case "completed":
      return "text-success";
    case "failed":
    case "missed":
      return "text-danger";
    default:
      return "text-ink-secondary";
  }
}

function nextHour() {
  return nextWholeHourInTimeZone(Date.now(), CENTRAL_TIME_ZONE);
}

function webhookPromptParts(prompt?: string) {
  if (!prompt) return null;
  const instructions = prompt.match(/\[USER-CONFIGURED WEBHOOK INSTRUCTIONS\]\n([\s\S]*?)\n\[\/USER-CONFIGURED WEBHOOK INSTRUCTIONS\]/)?.[1];
  const eventData = prompt.match(/\[UNTRUSTED WEBHOOK EVENT DATA\]\n([\s\S]*?)\n\[\/UNTRUSTED WEBHOOK EVENT DATA\]/)?.[1];
  return instructions && eventData ? { instructions, eventData } : null;
}

function RoutineCard({ item, bot, compact, onOpen }: { item: CalendarItem; bot: Bot; compact: boolean; onOpen: () => void }) {
  const status = item.run?.status;
  const color = BOT_COLORS[bot.color];
  const title = item.routine?.name ?? item.run?.routineName ?? "Routine";
  const animated = status === "running" || status === "waiting";
  return (
    <button
      onClick={onOpen}
      className={cn(
        "group absolute left-1.5 right-1.5 z-10 overflow-hidden rounded-xl border py-1.5 text-left shadow-lg shadow-black/15 transition hover:z-20 hover:-translate-y-0.5 hover:brightness-110",
        compact ? "px-1.5" : "px-2",
        status === "failed" || status === "missed" ? "border-danger/50" : "border-white/10",
        status === "cancelled" && "opacity-55",
      )}
      style={{
        top: `${(calendarMinuteOfDay(item.at) / 60) * HOUR_HEIGHT}px`,
        minHeight: item.run?.triggerSource === "webhook" || item.run?.triggerSource === "resource"
          ? "48px"
          : `${Math.max(48, ((item.routine?.durationMinutes ?? item.run?.durationMinutes ?? 30) / 60) * HOUR_HEIGHT)}px`,
        background: `linear-gradient(115deg, color-mix(in srgb, ${color} 48%, #181818), color-mix(in srgb, ${color} 20%, #111))`,
      }}
    >
      <div className={cn("flex min-w-0 items-center", compact ? "gap-1.5" : "gap-2")}>
        <BotAvatar
          bot={bot}
          state={status ? statusState(status) : "idle"}
          size={compact ? 32 : 38}
          animated={animated}
          trackPointer={animated}
          label={`${bot.name} — ${title}`}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold text-white" title={title}>{title}</div>
          <div className="mt-0.5 flex items-center gap-1.5 truncate text-[10.5px] text-white/70">
            {animated && <Loader2 size={10} className="animate-spin" />}
            <span>{niceTime(item.at)}</span>
            <span>·</span>
            {item.run?.triggerSource === "webhook" && <><Webhook size={10} /><span>Webhook</span><span>·</span></>}
            {item.run?.triggerSource === "resource" && <><Gauge size={10} /><span>Resource</span><span>·</span></>}
            <span className="truncate">
              {status ? status.replace("waiting", "needs you") : bot.name}
              {(item.routine?.runOn ?? item.run?.runOn) === "cloud" ? " · VM" : ""}
            </span>
          </div>
        </div>
        {status === "failed" && !item.run?.seenAt && <span className="size-2 shrink-0 rounded-full bg-danger" />}
      </div>
    </button>
  );
}

function CalendarGrid({
  anchor,
  days,
  items,
  bots,
  onOpen,
}: {
  anchor: number;
  days: number;
  items: CalendarItem[];
  bots: Bot[];
  onOpen: (item: CalendarItem) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const today = startOfDay(Date.now());
  const starts = Array.from({ length: days }, (_, index) => addDays(anchor, index));
  const minDayWidth = days === 7 ? 110 : days === 3 ? 180 : 300;
  const gridTemplateColumns = `58px repeat(${days}, minmax(${minDayWidth}px, 1fr))`;
  const minWidth = 58 + days * minDayWidth;
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: HOUR_HEIGHT * 7 - 24 });
  }, [days]);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto border-t border-hairline/40">
      <div className="sticky top-0 z-30 grid bg-app/95 backdrop-blur" style={{ gridTemplateColumns, minWidth }}>
        <div className="border-b border-r border-hairline/40" />
        {starts.map((start) => {
          const isToday = start === today;
          const label = calendarDayLabel(start);
          return (
            <div key={start} className="border-b border-r border-hairline/40 px-3 py-2.5 text-center last:border-r-0">
              <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-secondary">{label.weekday}</div>
              <div className={cn("mx-auto mt-1 flex size-7 items-center justify-center rounded-full text-[14px] font-semibold", isToday ? "bg-accent text-white" : "text-ink")}>{label.day}</div>
            </div>
          );
        })}
      </div>
      <div className="relative grid" style={{ height: HOUR_HEIGHT * 24, gridTemplateColumns, minWidth }}>
        <div className="relative border-r border-hairline/40">
          {Array.from({ length: 24 }, (_, hour) => (
            <div key={hour} className="absolute right-2 -translate-y-1/2 text-[10px] tabular-nums text-ink-secondary/65" style={{ top: hour * HOUR_HEIGHT }}>
              {hour === 0 ? "" : new Intl.DateTimeFormat(undefined, { hour: "numeric", timeZone: "UTC" }).format(Date.UTC(2000, 0, 1, hour))}
            </div>
          ))}
        </div>
        {starts.map((start) => {
          const dayItems = items.filter((item) => startOfDay(item.at) === start);
          const nowTop = (calendarMinuteOfDay(Date.now()) / 60) * HOUR_HEIGHT;
          return (
            <div key={start} className="relative border-r border-hairline/40 last:border-r-0">
              {Array.from({ length: 24 }, (_, hour) => (
                <div key={hour} className="absolute inset-x-0 border-t border-hairline/25" style={{ top: hour * HOUR_HEIGHT }} />
              ))}
              {start === today && (
                <div className="absolute inset-x-0 z-20 flex items-center" style={{ top: nowTop }}>
                  <span className="-ml-1 size-2 rounded-full bg-danger" />
                  <span className="h-px flex-1 bg-danger/80" />
                </div>
              )}
              {dayItems.map((item) => {
                const bot = bots.find((candidate) => candidate.id === (item.routine?.botId ?? item.run?.botId));
                return bot ? <RoutineCard key={item.id} item={item} bot={bot} compact={days === 7} onOpen={() => onOpen(item)} /> : null;
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function RoutineEditor({
  routine,
  bots,
  lockedBotId,
  defaultRunOn,
  onClose,
}: {
  routine?: Routine;
  bots: Bot[];
  lockedBotId?: string;
  defaultRunOn?: RoutineRunOn;
  onClose: () => void;
}) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [botId, setBotId] = useState(lockedBotId ?? routine?.botId ?? bots[0]?.id ?? "");
  const [runOn, setRunOn] = useState<RoutineRunOn>(routine?.runOn ?? defaultRunOn ?? "bot");
  const [kind, setKind] = useState<"once" | "daily">(routine?.schedule.type ?? "daily");
  const [at, setAt] = useState(
    toInputDateTime(routine?.schedule.type === "once" ? routine.schedule.at : nextHour()),
  );
  const [time, setTime] = useState(routine?.schedule.type === "daily" ? routine.schedule.time : "09:00");
  const [timeZone] = useState(
    routine?.schedule.type === "daily" ? routine.schedule.timeZone ?? CENTRAL_TIME_ZONE : CENTRAL_TIME_ZONE,
  );
  const [weekdays, setWeekdays] = useState(
    routine?.schedule.type === "daily" ? routine.schedule.weekdays : [1, 2, 3, 4, 5],
  );
  const [durationMinutes, setDurationMinutes] = useState(routine?.durationMinutes ?? 30);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const cloudInstance = state.instances.find((instance) => instance.driverKind === "boxAgent");
  const cloudReady = Boolean(state.config?.box.configured && cloudInstance?.snapshot.state === "available");
  // MiniMonth preview of the schedule being edited — null while the "once"
  // date/time field is mid-edit and momentarily unparseable, same guard
  // `save()` needs around `epochFromInputDateTime`.
  const schedulePreview = useMemo<RoutineSchedule | null>(() => {
    try {
      return kind === "once"
        ? { type: "once", at: epochFromInputDateTime(at, CENTRAL_TIME_ZONE) }
        : { type: "daily", time, weekdays, timeZone };
    } catch {
      return null;
    }
  }, [kind, at, time, weekdays, timeZone]);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const input: RoutineInput = {
        name,
        prompt,
        botId,
        runOn,
        enabled: routine ? undefined : true,
        durationMinutes,
        schedule:
          kind === "once"
            ? { type: "once", at: epochFromInputDateTime(at, CENTRAL_TIME_ZONE) }
            : editedDailySchedule(routine, time, weekdays, timeZone),
      };
      const response = await api(routine ? `/api/routines/${routine.id}` : "/api/routines", {
        method: routine ? "PATCH" : "POST",
        body: JSON.stringify(input),
      });
      dispatch({ type: "routinePatched", routine: response.routine });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="max-h-[90vh] w-full max-w-[620px] overflow-y-auto rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-hairline/40 bg-panel/95 px-5 py-4 backdrop-blur">
          <div>
            <div className="text-[17px] font-semibold text-ink">{routine ? "Edit Routine" : "New Routine"}</div>
            <div className="mt-0.5 text-[12px] text-ink-secondary">Later runs of the same routine continue the previous task.  No cron syntax required.</div>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"><X size={18} /></button>
        </div>
        <div className="space-y-5 p-5">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-ink-secondary">Routine Name</span>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Morning research brief" className="w-full rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70" />
          </label>
          <div>
            <div className="mb-2 text-[12px] font-medium text-ink-secondary">Where does it run?</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setRunOn("bot")}
                className={cn(
                  "rounded-xl border p-3 text-left transition",
                  runOn === "bot" ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised/60",
                )}
              >
                <div className="flex items-center gap-2 text-[13px] font-medium text-ink"><Laptop size={15} />This Computer</div>
                <div className="mt-1 text-[11px] leading-relaxed text-ink-secondary">Uses this bot's selected model and computer setting.</div>
              </button>
              <button
                type="button"
                disabled={!cloudReady && runOn !== "cloud"}
                onClick={() => setRunOn("cloud")}
                className={cn(
                  "rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-45",
                  runOn === "cloud" ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised/60",
                )}
              >
                <div className="flex items-center gap-2 text-[13px] font-medium text-ink"><Cloud size={15} />ASCII.dev Box</div>
                <div className="mt-1 text-[11px] leading-relaxed text-ink-secondary">Runs the bot and its tools inside its Box virtual machine.</div>
              </button>
            </div>
            {runOn === "cloud" && (
              <div className={cn("mt-2 rounded-lg px-3 py-2 text-[11.5px] leading-relaxed", cloudReady ? "bg-accent/10 text-ink-secondary" : "border border-warning/25 bg-warning/10 text-warning")}>
                {cloudReady
                  ? "The VM wakes automatically for each run. Keep BotFleet running so its scheduler can launch the job."
                  : "ASCII.dev Box needs a working Box API key in App Settings before this routine can run."}
              </div>
            )}
          </div>
          <div>
            <div className="mb-2 text-[12px] font-medium text-ink-secondary">Who does it?</div>
            <div className={cn("grid gap-2", lockedBotId ? "grid-cols-1" : "grid-cols-2 sm:grid-cols-3")}>
              {bots.map((bot) => (
                <button key={bot.id} type="button" disabled={Boolean(lockedBotId)} onClick={() => setBotId(bot.id)} className={cn("flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2 text-left", botId === bot.id ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised/60")}>
                  <BotAvatar bot={bot} state={botId === bot.id ? "happy" : stateForBot(bot)} size={38} animated={false} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink" title={bot.name}>{bot.name}</span>
                  {lockedBotId && <span className="text-[11px] text-ink-secondary">Assigned from Computer</span>}
                </button>
              ))}
            </div>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-ink-secondary">What should this bot do?</span>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={6} placeholder="Check the latest project activity, summarize what changed, and call out anything that needs my attention…" className="w-full resize-y rounded-xl border border-hairline/60 bg-inset px-3.5 py-3 text-[14px] leading-relaxed text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70" />
          </label>
          <div>
            <div className="mb-2 text-[12px] font-medium text-ink-secondary">When?</div>
            <div className="mb-3 inline-flex rounded-xl bg-inset p-1">
              {(["once", "daily"] as const).map((value) => (
                <button key={value} onClick={() => setKind(value)} className={cn("rounded-lg px-4 py-1.5 text-[13px] capitalize", kind === value ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink")}>{value === "daily" ? "Repeating" : "Once"}</button>
              ))}
            </div>
            {kind === "once" ? (
              <div className="space-y-2">
                <input type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} className="block rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-accent/70 [color-scheme:dark]" />
                <p className="text-[11.5px] text-ink-secondary">Date and time use {timeZoneLabel(CENTRAL_TIME_ZONE)}.</p>
              </div>
            ) : (
              <div className="space-y-3">
                <input type="time" value={time} onChange={(event) => setTime(event.target.value)} className="rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-accent/70 [color-scheme:dark]" />
                <div className="flex flex-wrap gap-1.5">
                  {DAY_NAMES.map((label, day) => (
                    <button key={label} type="button" onClick={() => setWeekdays((current) => current.includes(day) ? (current.length === 1 ? current : current.filter((value) => value !== day)) : [...current, day].sort())} className={cn("size-10 rounded-xl border text-[11px] font-medium", weekdays.includes(day) ? "border-accent bg-accent text-white" : "border-hairline/50 bg-inset text-ink-secondary hover:text-ink")}>{label.slice(0, 2)}</button>
                  ))}
                </div>
                <p className="text-[11.5px] text-ink-secondary">Time zone: {timeZoneLabel(timeZone, routine?.nextRunAt ?? Date.now())}.{'  '}Existing routines keep their saved zone.</p>
              </div>
            )}
            {schedulePreview && (
              <div className="mt-3 overflow-hidden rounded-xl border border-hairline/40 bg-inset">
                <MiniMonth
                  anchor={schedulePreview.type === "once" ? schedulePreview.at : Date.now()}
                  schedule={schedulePreview}
                  timeZone={timeZone}
                />
              </div>
            )}
          </div>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-ink-secondary">Calendar Block</span>
            <select value={durationMinutes} onChange={(event) => setDurationMinutes(Number(event.target.value))} className="rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-accent/70">
              {[15, 30, 45, 60, 90, 120].map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} minutes` : `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`}</option>)}
            </select>
          </label>
          {error && <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] text-danger"><CircleAlert size={16} className="mt-0.5 shrink-0" />{error}</div>}
        </div>
        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-hairline/40 bg-panel/95 px-5 py-4 backdrop-blur">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">Cancel</button>
          <button onClick={save} disabled={saving || !name.trim() || !prompt.trim() || !botId} className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40">
            {saving && <Loader2 size={14} className="animate-spin" />}{routine ? "Save Changes" : "Create Routine"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RoutineDetails({ item, bot, onClose, onEdit }: { item: CalendarItem; bot: Bot; onClose: () => void; onEdit: (routine: Routine) => void }) {
  const { state, dispatch } = useStore();
  const routine = item.routine;
  const run = item.run;
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const title = routine?.name ?? run?.routineName ?? "Routine";
  const webhookParts = run?.triggerSource === "webhook" ? webhookPromptParts(run.prompt) : null;
  const visibleInstructions = webhookParts?.instructions ?? routine?.prompt ?? run?.prompt;
  const outcome = run ? routineOutcomeCode(run) : undefined;
  const history = state.routineRuns.filter((candidate) => candidate.routineId === (routine?.id ?? run?.routineId));
  const summary = routineOutcomeSummary(history, Date.now());
  const outcomeTime = (at: number | null) => at === null ? "None recorded" : new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(at);

  const invoke = async (path: string, method = "POST") => {
    setWorking(true);
    setError("");
    try {
      const response = await api(path, { method });
      if (response.routine) dispatch({ type: "routinePatched", routine: response.routine });
      if (response.run) dispatch({ type: "routineRunPatched", run: response.run });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="relative overflow-hidden border-b border-hairline/40 px-5 py-5" style={{ background: `linear-gradient(135deg, color-mix(in srgb, ${BOT_COLORS[bot.color]} 28%, #111), #111)` }}>
          <button onClick={onClose} aria-label="Close Routine Details" className="absolute right-3 top-3 rounded-lg p-2 text-white/60 hover:bg-white/10 hover:text-white"><X size={18} /></button>
          <div className="flex items-center gap-4 pr-10">
            <BotAvatar bot={bot} state={run ? statusState(run.status) : stateForBot(bot)} size={72} animated={run?.status === "running" || run?.status === "waiting"} label={bot.name} />
            <div className="min-w-0">
              <div className="truncate text-[20px] font-semibold text-white" title={title}>{title}</div>
              <div className="mt-1 flex items-center gap-2 text-[13px] text-white/65"><span>{bot.name}</span><span>·</span><span>{niceDate(item.at)}, {niceTime(item.at)} {shortTimeZoneName(item.at, CENTRAL_TIME_ZONE)}</span></div>
              <div className={cn("mt-2 inline-flex items-center gap-1.5 rounded-full bg-black/25 px-2.5 py-1 text-[11px] font-medium capitalize", run ? statusTone(run.status) : "text-white/70")}>
                {run?.status === "running" && <Loader2 size={11} className="animate-spin" />}
                {run?.status === "completed" && <CheckCircle2 size={11} />}
                {run ? run.status.replace("waiting", "needs you") : "scheduled"}
              </div>
            </div>
          </div>
        </div>
        <div className="max-h-[55vh] space-y-4 overflow-y-auto p-5">
          {run?.coalescedInto && <p className="text-[12px] text-ink-secondary">Combined with another delivery in this turn.{'\u00a0 '}All combined deliveries share its final outcome and cancellation.</p>}
          {outcome && outcome !== "completed" && <p className="text-[12px] font-medium text-ink">{ROUTINE_OUTCOME_LABELS[outcome]}{run?.failurePhase ? ` · ${run.failurePhase}` : ""}</p>}
          {run?.engineId && <p className="text-[12px] text-ink-secondary">Engine: {run.engineId}{run.model ? ` · ${run.model}` : ""}</p>}
          {run?.error && <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[13px] text-danger"><CircleAlert size={16} className="mt-0.5 shrink-0" /><span>{run.error}</span></div>}
          {routine && (
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-inset p-3"><div className="text-[10px] uppercase tracking-wider text-ink-secondary">Schedule</div><div className="mt-1 text-[13px] text-ink">{scheduleLabel(routine)}</div></div>
              <div className="rounded-xl bg-inset p-3"><div className="text-[10px] uppercase tracking-wider text-ink-secondary">Runs on</div><div className="mt-1 flex items-center gap-1.5 text-[13px] text-ink">{routine.runOn === "cloud" ? <Cloud size={13} /> : <Laptop size={13} />}{routine.runOn === "cloud" ? "ASCII.dev Box" : "Local setup"}</div></div>
              <div className="rounded-xl bg-inset p-3"><div className="text-[10px] uppercase tracking-wider text-ink-secondary">Duration</div><div className="mt-1 text-[13px] text-ink">{routine.durationMinutes} minutes</div></div>
            </div>
          )}
          {run?.triggerSource === "webhook" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-inset p-3"><div className="text-[10px] uppercase tracking-wider text-ink-secondary">Triggered by</div><div className="mt-1 flex items-center gap-1.5 text-[13px] text-ink"><Webhook size={13} />Webhook</div></div>
              <div className="rounded-xl bg-inset p-3"><div className="text-[10px] uppercase tracking-wider text-ink-secondary">Runs on</div><div className="mt-1 flex items-center gap-1.5 text-[13px] text-ink">{run.runOn === "cloud" ? <Cloud size={13} /> : <Laptop size={13} />}{run.runOn === "cloud" ? "ASCII.dev Box" : "Local setup"}</div></div>
              {run.deliveryId && (
                <details className="col-span-2 rounded-xl bg-inset p-3">
                  <summary className="cursor-pointer text-[10px] font-medium uppercase tracking-wider text-ink-secondary">Technical Details</summary>
                  <div className="mt-2 text-[10px] uppercase tracking-wider text-ink-secondary">Delivery Reference</div>
                  <div className="mt-1 truncate font-mono text-[11.5px] text-ink" title={run.deliveryId}>{run.deliveryId}</div>
                </details>
              )}
            </div>
          )}
          {visibleInstructions && <div><div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-secondary">Brief</div><div className="whitespace-pre-wrap rounded-xl border border-hairline/40 bg-inset px-3.5 py-3 text-[13px] leading-relaxed text-ink">{visibleInstructions}</div></div>}
          {webhookParts?.eventData && <div><div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-secondary">Webhook event data</div><pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-xl border border-accent/15 bg-accent/5 px-3.5 py-3 font-mono text-[11.5px] leading-relaxed text-ink-secondary">{webhookParts.eventData}</pre></div>}
          {run?.output && <div><div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-secondary">Last output</div><div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-xl border border-success/20 bg-success/5 px-3.5 py-3 text-[13px] leading-relaxed text-ink">{run.output}</div></div>}
          <section aria-label="Routine outcomes" className="rounded-xl border border-hairline/40 bg-inset p-3.5 text-[12px] text-ink-secondary">
            <h3 className="mb-2 text-[13px] font-semibold text-ink">Last 7 Days</h3>
            <p>{summary.completed} completed · {summary.failed} failed · {summary.pending} pending</p>
            <p className="mt-1">{summary.successRate === null ? "No finished executions" : `${Math.round(summary.successRate * 1000) / 10}% completed executions`}</p>
            <p className="mt-1">{summary.cancelled} cancelled · {summary.denied} denied · {summary.missed} missed · {summary.combined} combined {summary.combined === 1 ? "delivery" : "deliveries"}</p>
            <dl className="mt-3 grid gap-1"><div><dt className="inline">Last Completed: </dt><dd className="inline text-ink">{outcomeTime(summary.lastSuccessAt)}</dd></div><div><dt className="inline">Last Failed: </dt><dd className="inline text-ink">{outcomeTime(summary.lastFailureAt)}</dd></div></dl>
            <p className="mt-2 text-[11px]">Based on retained history.{'\u00a0 '}Combined deliveries count once per execution; cancellations and denials are excluded from the completion rate.</p>
          </section>
          {error && <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[13px] text-danger"><CircleAlert size={16} className="mt-0.5 shrink-0" /><span>{error}</span></div>}
          {run?.status === "waiting" && <div className="rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-3 text-[13px] text-warning">This bot needs your answer. Open its task to continue the run.</div>}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-hairline/40 px-5 py-4">
          {routine && <button disabled={working} onClick={() => void invoke(`/api/routines/${routine.id}/run`)} className="flex items-center gap-2 rounded-xl bg-accent px-3.5 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40"><Play size={14} />Run Now</button>}
          {run?.threadId && <button onClick={() => { dispatch({ type: "select", id: bot.id }); dispatch({ type: "switchTask", botId: bot.id, threadId: run.threadId! }); onClose(); }} className="flex items-center gap-2 rounded-xl bg-raised px-3.5 py-2 text-[13px] text-ink hover:bg-raised-hover"><ExternalLink size={14} />Open Task</button>}
          {run && ["queued", "running", "waiting"].includes(run.status) && <button disabled={working} onClick={() => void invoke(`/api/routine-runs/${run.id}/cancel`)} className="flex items-center gap-2 rounded-xl bg-raised px-3.5 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40"><X size={14} />Cancel Run</button>}
          <div className="flex-1" />
          {routine && canToggleRoutine(routine) && <button disabled={working} onClick={async () => { setWorking(true); setError(""); try { const response = await api(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !routine.enabled }) }); dispatch({ type: "routinePatched", routine: response.routine }); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setWorking(false); } }} className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40">{routine.enabled ? <Pause size={14} /> : <Play size={14} />}{routine.enabled ? "Pause" : "Resume"}</button>}
          {routine && <button onClick={() => onEdit(routine)} className="rounded-xl px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">Edit</button>}
          {routine && <button onClick={() => setConfirmDelete(true)} className="rounded-xl p-2 text-ink-secondary hover:bg-danger/10 hover:text-danger" title="Delete Routine"><Trash2 size={16} /></button>}
        </div>
      </div>
      {routine && (
        <ConfirmDialog
          open={confirmDelete}
          title="Delete Routine?"
          body={`Delete “${routine.name}”?  Its past run receipts will stay in the calendar.`}
          confirmLabel="Delete Routine"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            dispatch({ type: "deleteRoutine", routineId: routine.id });
            onClose();
          }}
        />
      )}
    </div>
  );
}

function PausedRoutines({ routines, bots, onClose, onEdit }: { routines: Routine[]; bots: Bot[]; onClose: () => void; onEdit: (routine: Routine) => void }) {
  const { dispatch } = useStore();
  const [pendingDelete, setPendingDelete] = useState<Routine | null>(null);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="flex items-center justify-between border-b border-hairline/40 px-5 py-4">
          <div><div className="text-[17px] font-semibold text-ink">Paused Routines</div><div className="mt-0.5 text-[12px] text-ink-secondary">They keep their history and will not create new runs.</div></div>
          <button onClick={onClose} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"><X size={18} /></button>
        </div>
        <div className="max-h-[60vh] space-y-2 overflow-y-auto p-4">
          {routines.map((routine) => {
            const bot = bots.find((candidate) => candidate.id === routine.botId);
            return (
              <div key={routine.id} className="flex items-center gap-3 rounded-xl border border-hairline/40 bg-inset p-3">
                {bot ? <BotAvatar bot={bot} state="sleeping" size={44} animated={false} label={bot.name} /> : <div className="flex size-11 items-center justify-center rounded-xl bg-raised text-ink-secondary"><CalendarClock size={20} /></div>}
                <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-semibold text-ink" title={routine.name}>{routine.name}</div><div className="mt-0.5 truncate text-[11.5px] text-ink-secondary" title={`${bot?.name ?? "Deleted bot"} · ${scheduleLabel(routine)}`}>{bot?.name ?? "Deleted bot"} · {scheduleLabel(routine)}</div></div>
                {bot && <button onClick={() => dispatch({ type: "updateRoutine", routineId: routine.id, patch: { enabled: true } })} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110"><Play size={12} />Resume</button>}
                <button onClick={() => onEdit(routine)} className="rounded-lg px-2 py-1.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink">Edit</button>
                <button onClick={() => setPendingDelete(routine)} className="rounded-lg p-2 text-ink-secondary hover:bg-danger/10 hover:text-danger" title="Delete Routine"><Trash2 size={15} /></button>
              </div>
            );
          })}
        </div>
      </div>
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete Routine?"
        body={`Delete “${pendingDelete?.name ?? "this routine"}”?  Its past run receipts will stay in the calendar.`}
        confirmLabel="Delete Routine"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) dispatch({ type: "deleteRoutine", routineId: pendingDelete.id });
          setPendingDelete(null);
        }}
      />
    </div>
  );
}

export function RoutinesPage() {
  const { state, dispatch } = useStore();
  const [section, setSection] = useState<"calendar" | "webhooks" | "resources">("calendar");
  const [viewDays, setViewDays] = useState<1 | 3 | 7>(7);
  const [anchor, setAnchor] = useState(() => startOfWeek(Date.now()));
  const [botFilter, setBotFilter] = useState("all");
  const [editor, setEditor] = useState<Routine | "new" | null>(null);
  const [selected, setSelected] = useState<CalendarItem | null>(null);
  const [pausedOpen, setPausedOpen] = useState(false);
  const visibleBots = state.bots.filter((bot) => !bot.hidden);
  const rangeStart = viewDays === 7 ? startOfWeek(anchor) : startOfDay(anchor);
  const rangeEnd = addDays(rangeStart, viewDays);
  const items = useMemo(
    () => projectedRoutineItems(state.routines, state.routineRuns, rangeStart, rangeEnd).filter((item) => botFilter === "all" || (item.routine?.botId ?? item.run?.botId) === botFilter),
    [state.routines, state.routineRuns, rangeStart, rangeEnd, botFilter],
  );
  const liveSelected = selected
    ? {
        ...selected,
        routine: selected.routine ? state.routines.find((routine) => routine.id === selected.routine?.id) ?? null : null,
        run: selected.run ? state.routineRuns.find((run) => run.id === selected.run?.id) ?? selected.run : null,
      }
    : null;
  const selectedBot = liveSelected
    ? state.bots.find((bot) => bot.id === (liveSelected.routine?.botId ?? liveSelected.run?.botId))
    : undefined;
  const unseenFailures = state.routineRuns.filter((run) => ["failed", "missed"].includes(run.status) && !run.seenAt).length;
  const running = state.routineRuns.filter((run) => ["queued", "running", "waiting"].includes(run.status)).length;
  const paused = state.routines.filter((routine) => !routine.enabled && canToggleRoutine(routine));
  useEffect(() => {
    if (pausedOpen && paused.length === 0) setPausedOpen(false);
  }, [pausedOpen, paused.length]);

  useEffect(() => {
    if (!state.selectedRoutineId) return;
    const targetRoutine = state.routines.find((r) => r.id === state.selectedRoutineId);
    if (!targetRoutine) return;
    setBotFilter(targetRoutine.botId || "all");
    setSelected({
      id: `routine-${targetRoutine.id}`,
      at: targetRoutine.nextRunAt || Date.now(),
      routine: targetRoutine,
      run: state.routineRuns.find((run) => run.routineId === targetRoutine.id) ?? null,
    });
    dispatch({ type: "showRoutines" });
  }, [state.selectedRoutineId, state.routines, state.routineRuns, dispatch]);

  const move = (direction: number) => setAnchor((current) => addDays(current, direction * viewDays));
  const goToday = () => setAnchor(viewDays === 7 ? startOfWeek(Date.now()) : startOfDay(Date.now()));
  const openItem = (item: CalendarItem) => {
    setSelected(item);
    if (item.run && ["failed", "missed"].includes(item.run.status) && !item.run.seenAt) {
      dispatch({ type: "markRoutineRunSeen", runId: item.run.id });
    }
  };

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <header
        className={cn(
          "shrink-0 px-5 pb-4 pt-4",
          // Room for the drawer button, which overlays this corner below md.
          "pl-11 md:pl-5",
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">{section === "calendar" ? <CalendarDays size={21} className="text-accent" /> : section === "resources" ? <Gauge size={21} className="text-accent" /> : <Webhook size={21} className="text-accent" />}<h1 className="text-[20px] font-semibold tracking-tight text-ink">Tasks &amp; Routines</h1></div>
            <p className="mt-1 text-[12.5px] text-ink-secondary">{section === "calendar" ? "Routines start fresh bot tasks on a schedule." : section === "resources" ? "Resource triggers start a bot when disk, RAM, or CPU crosses a threshold." : "Webhooks start fresh bot tasks when an event arrives."}</p>
          </div>
          <div className="flex items-center gap-2">
            {running > 0 && <span className="flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent/10 px-2.5 py-1.5 text-[11px] text-accent"><Loader2 size={12} className="animate-spin" />{running} active</span>}
            {unseenFailures > 0 && <span className="flex items-center gap-1.5 rounded-full border border-danger/25 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger"><CircleAlert size={12} />{unseenFailures} need attention</span>}
            {paused.length > 0 && <button onClick={() => setPausedOpen(true)} className="flex items-center gap-1.5 rounded-full border border-hairline/50 bg-panel px-2.5 py-1.5 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink"><Pause size={12} />{paused.length} paused</button>}
            {section === "calendar" && <button onClick={() => setEditor("new")} disabled={visibleBots.length === 0} className="flex items-center gap-2 rounded-xl bg-accent px-3.5 py-2 text-[13px] font-medium text-white shadow-lg shadow-accent/10 hover:brightness-110 disabled:opacity-40"><Plus size={15} />New Routine</button>}
          </div>
        </div>
        <div className="mt-4 flex items-center gap-1 rounded-xl bg-panel p-1 sm:w-fit">
          <button onClick={() => setSection("calendar")} className={cn("flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium", section === "calendar" ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink")}><CalendarDays size={13} />Routines</button>
          <button onClick={() => setSection("webhooks")} className={cn("flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium", section === "webhooks" ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink")}><Webhook size={13} />Webhooks{state.webhooks.length > 0 && <span className="rounded-full bg-accent/15 px-1.5 text-[10px] text-accent">{state.webhooks.length}</span>}</button>
          <button onClick={() => setSection("resources")} className={cn("flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium", section === "resources" ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink")}><Gauge size={13} />Resources{state.resourceTriggers.length > 0 && <span className="rounded-full bg-accent/15 px-1.5 text-[10px] text-accent">{state.resourceTriggers.length}</span>}</button>
        </div>
        <div className="mt-3 rounded-xl border border-hairline/45 bg-panel/70 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-ink-secondary">
          {section === "calendar" ? (
            <><strong className="font-medium text-ink">Task</strong> = one conversation and result. <strong className="font-medium text-ink">Routine</strong> = a reusable schedule. Later runs of the same routine continue the previous task thread, using that bot's model, tools, permissions, computer, and connected apps.</>
          ) : section === "resources" ? (
            <><strong className="font-medium text-ink">Resource trigger</strong> = a local disk, RAM/swap, or CPU threshold that creates a fresh task. BotFleet must be running to sample this computer. A Mac launchd watch can also POST the Housekeeper webhook if you want coverage while the app is closed.</>
          ) : (
            <><strong className="font-medium text-ink">Webhook</strong> = an event endpoint that creates a fresh task. Connected services can call it when something happens; the receiving bot keeps its existing tools and permissions.</>
          )}
        </div>
        {section === "calendar" && <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-xl border border-hairline/50 bg-panel p-0.5">
            <button onClick={() => move(-1)} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink" aria-label="Previous Dates"><ChevronLeft size={16} /></button>
            <button onClick={goToday} className="px-2.5 py-1.5 text-[12px] font-medium text-ink hover:text-accent">Today</button>
            <button onClick={() => move(1)} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink" aria-label="Next Dates"><ChevronRight size={16} /></button>
          </div>
          <div className="min-w-[190px] px-2 text-[14px] font-semibold text-ink">
            {new Intl.DateTimeFormat(undefined, { timeZone: CENTRAL_TIME_ZONE, month: "long", year: "numeric" }).format(rangeStart)}
            <span className="ml-2 text-[10.5px] font-medium text-ink-secondary">Central Time</span>
          </div>
          <select value={botFilter} onChange={(event) => setBotFilter(event.target.value)} className="rounded-xl border border-hairline/50 bg-panel px-3 py-2 text-[12px] text-ink outline-none focus:border-accent/60">
            <option value="all">All bots</option>
            {visibleBots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
          </select>
          <div className="ml-auto flex rounded-xl bg-panel p-1">
            {([1, 3, 7] as const).map((days) => <button key={days} onClick={() => { setViewDays(days); setAnchor(days === 7 ? startOfWeek(anchor) : startOfDay(anchor)); }} className={cn("rounded-lg px-3 py-1.5 text-[11px] font-medium", viewDays === days ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink")}>{days === 1 ? "Day" : days === 3 ? "3 Days" : "Week"}</button>)}
          </div>
        </div>}
      </header>

      {section === "webhooks" ? (
        <WebhooksPanel bots={visibleBots} />
      ) : section === "resources" ? (
        <ResourceTriggersPanel bots={visibleBots} />
      ) : state.routines.length === 0 && state.routineRuns.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          <div className="max-w-[430px] text-center">
            <div className="relative mx-auto mb-5 flex h-28 w-44 items-end justify-center">
              {visibleBots.slice(0, 3).map((bot, index) => <div key={bot.id} className="-ml-3 first:ml-0" style={{ transform: `translateY(${Math.abs(index - 1) * 9}px) rotate(${(index - 1) * 5}deg)` }}><BotAvatar bot={bot} state={index === 1 ? "excited" : stateForBot(bot)} size={84} /></div>)}
              {visibleBots.length === 0 && <CalendarClock size={58} className="text-ink-secondary/40" />}
            </div>
            <h2 className="text-[18px] font-semibold text-ink">Put your bot fleet on a rhythm</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">Plan research briefs, daily check-ins, recurring reviews, or one-time work. Every run becomes a separate task with its own result.</p>
            <button onClick={() => setEditor("new")} disabled={visibleBots.length === 0} className="mt-5 inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40"><Plus size={15} />Create Your First Routine</button>
            {visibleBots.length === 0 && <p className="mt-3 text-[12px] text-warning">Create a bot first, then come back to schedule it.</p>}
          </div>
        </div>
      ) : (
        <CalendarGrid anchor={rangeStart} days={viewDays} items={items} bots={state.bots} onOpen={openItem} />
      )}

      {editor && <RoutineEditor routine={editor === "new" ? undefined : editor} bots={visibleBots} onClose={() => setEditor(null)} />}
      {liveSelected && selectedBot && <RoutineDetails item={liveSelected} bot={selectedBot} onClose={() => setSelected(null)} onEdit={(routine) => { setSelected(null); setEditor(routine); }} />}
      {pausedOpen && <PausedRoutines routines={paused} bots={state.bots} onClose={() => setPausedOpen(false)} onEdit={(routine) => { setPausedOpen(false); setEditor(routine); }} />}
    </main>
  );
}
