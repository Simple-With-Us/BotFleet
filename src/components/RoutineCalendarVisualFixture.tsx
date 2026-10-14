// Dense routine calendar fixture for tests/e2e/routine-calendar-density.visual.spec.ts.
// It reproduces the old failure shape: many overlapping Tuesday runs plus
// ordinary cards on the surrounding days.  The real CalendarGrid renders it.
import { CalendarGrid } from "./RoutinesPage";
import type { CalendarItem } from "@/lib/routine-calendar";
import type { Routine } from "@/lib/routines";
import type { Bot } from "@/state/store";

const ANCHOR = Date.parse("2026-10-12T05:00:00.000Z");
const colors = ["green", "blue", "purple", "orange", "pink"] as const;

const bots: Bot[] = colors.map((color, index) => ({
  id: `visual-bot-${index}`,
  threadId: `visual-thread-${index}`,
  name: ["Monitor", "Compiler", "Oracle", "Housekeeper", "Publisher"][index]!,
  title: "Bot",
  description: "",
  notifications: false,
  color,
  unread: false,
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  messages: [],
}));

function calendarItem(id: string, at: number, botIndex: number, name: string, durationMinutes = 30): CalendarItem {
  const routine: Routine = {
    id,
    name,
    prompt: `Run ${name}.`,
    botId: bots[botIndex]!.id,
    runOn: "bot",
    enabled: true,
    schedule: { type: "once", at },
    durationMinutes,
    nextRunAt: at,
    createdAt: ANCHOR - 86_400_000,
    updatedAt: ANCHOR - 86_400_000,
  };
  return { id, at, routine, run: null };
}

const tuesdayEight = Date.parse("2026-10-13T13:00:00.000Z");
const dense = Array.from({ length: 18 }, (_, index) => calendarItem(
  `dense-${index}`,
  tuesdayEight + index * 6 * 60_000,
  index % bots.length,
  ["Compile gates", "GitHub merge review", "Sentry watch", "Release audit", "Queue triage"][index % 5]!,
));
const ordinary = Array.from({ length: 7 }, (_, index) => calendarItem(
  `daily-${index}`,
  ANCHOR + index * 86_400_000 + 14 * 60 * 60_000,
  index % bots.length,
  "Daily project check",
  45,
));

export default function RoutineCalendarVisualFixture() {
  return (
    <div className="flex h-screen min-h-0 flex-col bg-app">
      <div className="border-b border-hairline/40 px-5 py-4">
        <h1 className="text-[20px] font-semibold text-ink">Tasks &amp; Routines</h1>
        <p className="mt-1 text-[12.5px] text-ink-secondary">Dense schedules collapse into one reviewable stack.</p>
      </div>
      <CalendarGrid anchor={ANCHOR} days={7} items={[...dense, ...ordinary]} bots={bots} onOpen={() => {}} />
    </div>
  );
}
