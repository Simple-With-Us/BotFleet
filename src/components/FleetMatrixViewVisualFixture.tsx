// Test harness for tests/e2e/fleet-matrix-view.visual.spec.ts.
//
// Mounts the real FleetMatrixView through a StoreContext.Provider so both
// view modes (matrix grid and kanban board) get screenshot coverage.  The
// initial view mode is read from `?view=matrix|kanban` and persisted to
// localStorage so it survives re-mounts, mirroring how the real component
// remembers the operator's choice.
//
// URL params read at mount:  ?view=matrix|kanban
//
// Note: there is no top-level `visual-tests/` directory in this repo.  The
// update path is `pnpm exec playwright test <spec> --update-snapshots`
// against the existing `tests/e2e/` tree, not `cd visual-tests && npm ci`.
import { useMemo, type Dispatch } from "react";
import { z } from "zod";
import { StoreContext, initialState, type Action, type Bot, type Group } from "@/state/store";
import { FleetMatrixView } from "./FleetMatrixView";
import type { RoutineRun } from "@/lib/routines";

const viewModeSchema = z.enum(["matrix", "kanban"]);

const PINNED_TS = 1_730_000_000_000; // 2024-10-27T16:53:20Z

function bot(
  id: string,
  name: string,
  activity: Bot["activity"],
  startedAt: number,
): Bot {
  return {
    id,
    threadId: `${id}-thread`,
    name,
    title: name,
    description: `${name} description for the matrix fixture.`,
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
  ];
}

function matrixState() {
  const ops = group("app-ops", "Ops Console", [
    "bot-dead",
    "bot-waiting",
    "bot-working",
    "bot-idle",
    "bot-nosignal",
  ]);
  const tools = group("app-tools", "Tools Suite", ["bot-idle", "bot-working"]);
  const bots: Bot[] = [
    bot("bot-dead", "Crashy", "dead", PINNED_TS - 240_000),
    bot("bot-waiting", "Approver", "waiting-on-you", PINNED_TS - 180_000),
    bot("bot-working", "Builder", "working", PINNED_TS - 30_000),
    bot("bot-idle", "Sentinel", "idle", PINNED_TS - 5_000),
    bot("bot-nosignal", "Ghost", "no-signal", PINNED_TS - 600_000),
  ];
  return { bots, groups: [ops, tools], routineRuns: buildRuns() };
}

export default function FleetMatrixViewVisualFixture() {
  const value = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const view = viewModeSchema.parse(params.get("view") ?? "matrix");
    // Persist to localStorage so FleetMatrixView's persisted viewMode
    // initializer picks it up on the very first render.
    try {
      globalThis.localStorage?.setItem("botfleet.matrix_view_mode", view);
    } catch {
      // Ignore storage errors in restricted environments.
    }

    const base = {
      ...initialState,
      connected: true,
      hydration: { status: "ready" as const, error: null, retryAt: null },
    };

    const seeded = matrixState();
    return {
      state: { ...base, ...seeded },
      dispatch: (() => {}) as Dispatch<Action>,
      flushBotPatches: async () => {},
      refreshInstances: async () => {},
    };
  }, []);

  return (
    <StoreContext.Provider value={value}>
      <div
        data-testid="fleet-matrix-view"
        data-fixture-view={
          new URLSearchParams(window.location.search).get("view") ?? "matrix"
        }
        style={{
          height: 960,
          width: 1500,
          background: "#f4f4f5",
          boxSizing: "border-box",
        }}
      >
        <FleetMatrixView
          onSelectApp={() => {}}
          onSelectBot={() => {}}
          onSelectBotInApp={() => {}}
          onOpenAppRoom={() => {}}
        />
      </div>
    </StoreContext.Provider>
  );
}
