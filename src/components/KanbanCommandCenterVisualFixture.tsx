// Test harness for tests/e2e/kanban-command-center.visual.spec.ts.
//
// Mounts the real KanbanCommandCenter through a StoreContext.Provider with
// deterministic fake bots, groups, and routine runs covering four states:
//
//   state=populated   Cards in every column (attention, in_progress, ready,
//                     completed) so the operator can see the full 4-column
//                     layout at once.
//   state=empty       No bots, no runs, so every column renders its empty
//                     "all clear" / "no bots" / "queued" / "finished" copy.
//   state=filtered    A search query is pre-applied (via the input) so the
//                     filter row and the reduced card set both render.
//   state=flood       The owner's real case: a history with one routine that
//                     failed 38 times for the same cause, a routine whose
//                     failures were all acknowledged, 19 other broken
//                     routines, and 20 completed runs.  Used by
//                     tests/e2e/kanban-command-center.spec.ts, which checks
//                     behaviour rather than pixels.
//
// URL params read at mount:  ?state=populated|empty|filtered|flood
//
// Note: there is no top-level `visual-tests/` directory in this repo.  The
// update path is `pnpm exec playwright test <spec> --update-snapshots`
// against the existing `tests/e2e/` tree, not `cd visual-tests && npm ci`.
import { useMemo, type Dispatch } from "react";
import { z } from "zod";
import { StoreContext, initialState, type Action, type Bot, type Group } from "@/state/store";
import { KanbanCommandCenter } from "./KanbanCommandCenter";
import type { RoutineRun } from "@/lib/routines";

const noopDispatch: Dispatch<Action> = () => {};

// The URL query value crosses the application trust boundary, so validate
// it with zod at the boundary instead of casting.  z.infer keeps the type
// definition next to the runtime guard.
const fixtureStateSchema = z.enum(["populated", "empty", "filtered", "flood"]);

const PINNED_TS = 1_730_000_000_000; // 2024-10-27T16:53:20Z — deterministic stamp

function bot(
  id: string,
  name: string,
  activity: Bot["activity"],
  _appId: string,
  startedAt: number,
): Bot {
  return {
    id,
    threadId: `${id}-thread`,
    name,
    title: name,
    description: `${name} description for the kanban board fixture.`,
    notifications: false,
    color: "blue",
    unread: activity === "waiting-on-you",
    busy: activity === "working",
    activity,
    activityStartedAt: startedAt,
    modelSelection: { instanceId: "claude", model: "claude-sonnet" },
    messages: [],
  };
}

function group(id: string, name: string, memberIds: string[]): Group {
  return {
    id,
    threadId: `${id}-thread`,
    name,
    memberIds,
    defaultResponder: { kind: "everyone" },
    bulletin: "",
    unread: false,
    createdAt: PINNED_TS,
    messages: [],
  };
}

function buildRuns(): RoutineRun[] {
  return [
    {
      id: "run-failed-1",
      routineId: "routine-nightly",
      routineName: "Nightly Build Sync",
      prompt: "Sync release artifacts to staging bucket.",
      botId: "bot-dead",
      runOn: "bot",
      scheduledFor: PINNED_TS - 600_000,
      status: "failed",
      manual: false,
      startedAt: PINNED_TS - 590_000,
      finishedAt: PINNED_TS - 540_000,
      error: "Process died or disconnected without exit receipt.",
      createdAt: PINNED_TS - 600_000,
    },
    {
      id: "run-waiting-1",
      routineId: "routine-deploy",
      routineName: "Staging Deploy Approval",
      prompt: "Approve the staging roll-out of botfleet-ui.",
      botId: "bot-waiting",
      runOn: "bot",
      scheduledFor: PINNED_TS - 300_000,
      status: "waiting",
      manual: true,
      startedAt: PINNED_TS - 290_000,
      createdAt: PINNED_TS - 300_000,
    },
    {
      id: "run-running-1",
      routineId: "routine-rebuild",
      routineName: "Rebuild Companion Index",
      prompt: "Reindex companion messages and rebuild search ledger.",
      botId: "bot-working",
      runOn: "bot",
      scheduledFor: PINNED_TS - 120_000,
      status: "running",
      manual: false,
      startedAt: PINNED_TS - 110_000,
      createdAt: PINNED_TS - 120_000,
    },
    {
      id: "run-queued-1",
      routineId: "routine-cleanup",
      routineName: "Daily Voice Cache Cleanup",
      prompt: "Clear stale voice cache entries older than 30 days.",
      botId: "bot-idle",
      runOn: "bot",
      scheduledFor: PINNED_TS + 600_000,
      status: "queued",
      manual: false,
      createdAt: PINNED_TS,
    },
    {
      id: "run-completed-1",
      routineId: "routine-brief",
      routineName: "Daily Morning Brief",
      prompt: "Compose the morning brief digest for operators.",
      botId: "bot-idle",
      runOn: "bot",
      scheduledFor: PINNED_TS - 1_800_000,
      status: "completed",
      manual: false,
      startedAt: PINNED_TS - 1_790_000,
      finishedAt: PINNED_TS - 1_700_000,
      output: "Brief posted to #ops with 4 items, 0 errors.",
      createdAt: PINNED_TS - 1_800_000,
    },
  ];
}

const DAY_MS = 86_400_000;

/** A run on the idle bot, with every field a settled run carries. */
function floodRun(
  id: string,
  routineId: string,
  routineName: string,
  status: RoutineRun["status"],
  at: number,
  extra: Partial<RoutineRun> = {},
): RoutineRun {
  return {
    id,
    routineId,
    routineName,
    prompt: `${routineName} prompt.`,
    botId: "bot-idle",
    runOn: "bot",
    scheduledFor: at,
    status,
    manual: false,
    startedAt: at + 10_000,
    finishedAt: at + 20_000,
    createdAt: at,
    ...extra,
  };
}

function floodState() {
  const runs: RoutineRun[] = [];
  // The same routine, the same cause, once a day for 38 days:  one card.
  for (let i = 0; i < 38; i += 1) {
    runs.push(
      floodRun(`flood-gh-${i}`, "routine-github-ui", "GitHub UI Pass", "failed", PINNED_TS - (38 - i) * DAY_MS, {
        error: "Start docker first",
      }),
    );
  }
  // Failures already acknowledged on the Routines page:  no card at all.
  for (let i = 0; i < 12; i += 1) {
    runs.push(
      floodRun(`flood-ack-${i}`, "routine-acknowledged", "Acknowledged Nightly", "failed", PINNED_TS - (12 - i) * DAY_MS, {
        error: "Already dealt with",
        seenAt: PINNED_TS,
      }),
    );
  }
  // Nineteen other routines, each broken once:  with the one above, more than a page.
  for (let i = 0; i < 19; i += 1) {
    runs.push(
      floodRun(`flood-other-${i}`, `routine-other-${i}`, `Broken Routine ${i + 1}`, "failed", PINNED_TS - (i + 1) * 3_600_000, {
        error: `Broken routine ${i + 1} stopped.`,
      }),
    );
  }
  for (let i = 0; i < 20; i += 1) {
    runs.push(
      floodRun(`flood-done-${i}`, `routine-done-${i}`, `Finished Routine ${i + 1}`, "completed", PINNED_TS - (i + 1) * 60_000, {
        output: `Finished routine ${i + 1}.`,
      }),
    );
  }
  const tools = group("app-tools", "Tools Suite", ["bot-idle"]);
  const bots: Bot[] = [bot("bot-idle", "Sentinel", "idle", "app-tools", PINNED_TS - 5_000)];
  return { bots, groups: [tools], routineRuns: runs };
}

function populatedState() {
  const ops = group("app-ops", "Ops Console", ["bot-dead", "bot-waiting", "bot-working", "bot-idle"]);
  const tools = group("app-tools", "Tools Suite", ["bot-idle", "bot-working"]);
  const bots: Bot[] = [
    bot("bot-dead", "Crashy", "dead", "app-ops", PINNED_TS - 240_000),
    bot("bot-waiting", "Approver", "waiting-on-you", "app-ops", PINNED_TS - 180_000),
    bot("bot-working", "Builder", "working", "app-ops", PINNED_TS - 30_000),
    bot("bot-idle", "Sentinel", "idle", "app-tools", PINNED_TS - 5_000),
  ];
  return { bots, groups: [ops, tools], routineRuns: buildRuns() };
}

export default function KanbanCommandCenterVisualFixture() {
  const value = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const state = fixtureStateSchema.parse(params.get("state") ?? "populated");

    const base = {
      ...initialState,
      // Use a fixed hydrated time so formatWaitTime / column sorts stay
      // stable across hosts and runs.  KanbanCommandCenter calls Date.now()
      // inside its useMemo, which we accept — only the populated state
      // surfaces wait labels, and we mask those regions in the spec.
      connected: true,
      hydration: { status: "ready" as const, error: null, retryAt: null },
    };

    if (state === "empty") {
      return {
        state: { ...base, bots: [], groups: [], routineRuns: [] },
        dispatch: noopDispatch,
        flushBotPatches: async () => {},
        refreshInstances: async () => {},
      };
    }

    if (state === "flood") {
      return {
        state: { ...base, ...floodState() },
        dispatch: noopDispatch,
        flushBotPatches: async () => {},
        refreshInstances: async () => {},
      };
    }

    const populated = populatedState();
    return {
      state: { ...base, ...populated },
      dispatch: noopDispatch,
      flushBotPatches: async () => {},
      refreshInstances: async () => {},
    };
  }, []);

  return (
    <StoreContext.Provider value={value}>
      <div
        data-testid="kanban-board"
        data-fixture-state={
          new URLSearchParams(window.location.search).get("state") ?? "populated"
        }
        style={{
          height: 960,
          width: 1440,
          padding: 24,
          background: "#f4f4f5",
          boxSizing: "border-box",
        }}
      >
        <KanbanCommandCenter
          onSelectApp={() => {}}
          onSelectBot={() => {}}
          onOpenAppRoom={() => {}}
        />
      </div>
    </StoreContext.Provider>
  );
}
