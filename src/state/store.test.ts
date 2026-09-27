import { describe, expect, it, vi } from "vitest";

import {
  configStatusFromFrame,
  getRoomTerminology,
  initialState,
  isHarnessUnreachableError,
  latestChatActivity,
  compareBotsByRecentActivity,
  compareGroupsByRecentActivity,
  mergeHydrateBots,
  mergeHydrateGroups,
  openNotificationTarget,
  reducer,
  runHydrationRequests,
  shouldHydrateAfterHello,
  type Bot,
  type Group,
  type Message,
} from "./store";

describe("renderer hydration recovery", () => {
  const retainedBot = {
    id: "retained",
    threadId: "retained-thread",
    name: "Retained",
    title: "",
    description: "",
    notifications: true,
    color: "blue",
    unread: false,
    modelSelection: { instanceId: "codex", model: "gpt" },
    messages: [],
  } satisfies Bot;

  it("keeps the last snapshot and reports hydration separately from a live transport", () => {
    const connected = reducer({ ...initialState, bots: [retainedBot] }, { type: "connected", value: true });
    const loading = reducer(connected, { type: "hydrationStarted" });
    const failed = reducer(loading, {
      type: "hydrationFailed",
      message: "Could not refresh engines.",
      retryAt: 2_000,
    });

    expect(failed.connected).toBe(true);
    expect(failed.bots).toEqual([retainedBot]);
    expect(failed.error).toBeNull();
    expect(failed.hydration).toEqual({
      status: "failed",
      error: "Could not refresh engines.",
      retryAt: 2_000,
    });
  });

  it("rehydrates after a resumable hello when the preceding REST snapshot failed", () => {
    expect(shouldHydrateAfterHello(true, true)).toBe(true);
    expect(shouldHydrateAfterHello(true, false)).toBe(false);
    expect(shouldHydrateAfterHello(false, false)).toBe(true);
  });

  it("applies successful snapshot slices while reporting a partial REST failure", async () => {
    const botsLanded = vi.fn();
    const botRequest = Promise.resolve().then(botsLanded);
    const enginesRequest = Promise.reject(new Error("503"));

    await expect(runHydrationRequests([
      { label: "bots", request: botRequest },
      { label: "engines", request: enginesRequest },
    ])).rejects.toThrow("Could not refresh engines.");
    expect(botsLanded).toHaveBeenCalledOnce();
  });
});

describe("harness unreachable banner", () => {
  const banner = "BotFleet harness on port 8799 is not reachable";

  it("recognizes the shim 502 and ignores unrelated errors", () => {
    expect(isHarnessUnreachableError(banner)).toBe(true);
    expect(isHarnessUnreachableError("Nothing was running to stop.")).toBe(false);
    expect(isHarnessUnreachableError(null)).toBe(false);
  });

  it("clears the banner when the event stream reconnects", () => {
    const errored = reducer(initialState, { type: "error", message: banner });
    expect(errored.error).toBe(banner);
    const live = reducer(errored, { type: "connected", value: true });
    expect(live.connected).toBe(true);
    expect(live.error).toBeNull();
  });

  it("keeps unrelated errors when the stream reconnects", () => {
    const errored = reducer(initialState, { type: "error", message: "Nothing was running to stop." });
    const live = reducer(errored, { type: "connected", value: true });
    expect(live.error).toBe("Nothing was running to stop.");
  });

  it("clears the banner on a successful hydrate", () => {
    const errored = reducer(initialState, { type: "error", message: banner });
    const live = reducer(errored, {
      type: "hydrate",
      bots: [],
      groups: [],
      computerControl: {},
    });
    expect(live.error).toBeNull();
  });
});

describe("latestChatActivity", () => {
  it("prefers a background task's lastActivity over the open thread's last message", () => {
    expect(
      latestChatActivity(
        [
          { createdAt: 10, lastActivity: 10 },
          { createdAt: 20, lastActivity: 90 },
        ],
        15,
        1,
      ),
    ).toBe(90);
  });

  it("falls back to createdAt when no messages have landed", () => {
    expect(latestChatActivity(undefined, undefined, 42)).toBe(42);
  });
});

describe("compareBotsByRecentActivity", () => {
  const bot = (
    overrides: Partial<Bot> & Pick<Bot, "id" | "name"> & { lastAt?: number; lastActivity?: number; pinned?: boolean },
  ): Bot =>
    ({
      id: overrides.id,
      threadId: `${overrides.id}-thread`,
      name: overrides.name,
      title: "",
      description: "",
      notifications: true,
      color: "blue",
      unread: false,
      modelSelection: { instanceId: "i", model: "m" },
      createdAt: 1,
      pinned: overrides.pinned,
      tasks: overrides.lastActivity
        ? [{ threadId: `${overrides.id}-thread`, title: "Chat", createdAt: 1, lastActivity: overrides.lastActivity }]
        : [{ threadId: `${overrides.id}-thread`, title: "Chat", createdAt: 1 }],
      messages: overrides.lastAt
        ? [{ id: `${overrides.id}-m`, role: "bot", kind: "text", at: overrides.lastAt, text: "hi" }]
        : [],
    }) as Bot;

  it("sorts newest activity first, ignoring unread", () => {
    const plumber = bot({ id: "plumber", name: "Plumber", lastAt: 1005, lastActivity: 1005 });
    const monitor = bot({ id: "monitor", name: "Monitor", lastAt: 801, lastActivity: 801 });
    const fixer = bot({ id: "fixer", name: "Fixer", lastAt: 10, lastActivity: 10 });
    plumber.unread = false;
    monitor.unread = true;
    fixer.unread = true;
    const ordered = [fixer, monitor, plumber].sort(compareBotsByRecentActivity).map((row) => row.name);
    expect(ordered).toEqual(["Plumber", "Monitor", "Fixer"]);
  });

  it("keeps pinned bots above newer unpinned activity", () => {
    const pinned = bot({ id: "pin", name: "Pinned", lastAt: 1, pinned: true });
    const fresh = bot({ id: "fresh", name: "Fresh", lastAt: 99 });
    expect([fresh, pinned].sort(compareBotsByRecentActivity).map((row) => row.name)).toEqual(["Pinned", "Fresh"]);
  });

  it("uses a live last message even when task lastActivity is stale", () => {
    const stale = bot({ id: "stale", name: "Stale", lastActivity: 10, lastAt: 500 });
    const older = bot({ id: "older", name: "Older", lastActivity: 20, lastAt: 20 });
    expect([older, stale].sort(compareBotsByRecentActivity).map((row) => row.name)).toEqual(["Stale", "Older"]);
  });
});

describe("compareGroupsByRecentActivity", () => {
  const group = (id: string, lastAt: number, taskActivity?: number): Group =>
    ({
      id,
      threadId: `${id}-thread`,
      name: id,
      memberIds: [],
      defaultResponder: { kind: "mentions" },
      bulletin: "",
      unread: false,
      createdAt: 1,
      messages: lastAt ? [{ id: `${id}-m`, role: "user", kind: "text", at: lastAt, text: "hi" }] : [],
      tasks: taskActivity
        ? [{ threadId: `${id}-extra`, title: "Extra", createdAt: 1, lastActivity: taskActivity }]
        : undefined,
    }) as Group;

  it("sorts channels by last message or nested task activity, descending", () => {
    const launch = group("launch", 50, 900);
    const older = group("older", 100);
    expect([older, launch].sort(compareGroupsByRecentActivity).map((row) => row.name)).toEqual(["launch", "older"]);
  });
});

describe("notification routing", () => {
  const bots = [{ id: "bot-1", threadId: "main-thread", tasks: [{ threadId: "detached-thread" }] }] as never;
  const groups = [{
    id: "room-1",
    threadId: "room-thread",
    tasks: [
      { threadId: "room-thread", title: "Current", createdAt: 1 },
      { threadId: "older-room-thread", title: "Older", createdAt: 0 },
    ],
  }] as never;

  it("selects the bot and switches to the notification's exact task", () => {
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "detached-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "bot-1" },
      { type: "switchTask", botId: "bot-1", threadId: "detached-thread" },
    ]);
  });

  it("opens the room when the thread is a group's — never a bot task switch that would 404", () => {
    // room approval/question notifications carry the asker bot with the
    // GROUP's thread id; the exact destination is the room itself
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "room-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "room-1" }]);
  });

  it("opens the room and restores the exact inactive channel task", () => {
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "older-room-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "room-1" },
      { type: "switchGroupTask", groupId: "room-1", threadId: "older-room-thread" },
    ]);
  });

  it("lands on a plain bot select for a thread it cannot place, not an error", () => {
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "deleted-task-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "bot-1" }]);
  });
});

describe("config status frames", () => {
  it("keeps the room turn timeout with the existing config fields", () => {
    expect(
      configStatusFromFrame({
        xai: { configured: true },
        composio: { configured: true, mode: "managed" },
        box: { configured: false },
        vps: { configured: true, sshAlias: "homelab" },
        rooms: { turnTimeoutMinutes: 20 },
        localVm: { mode: "per-bot", maxInstances: 3 },
        opencodeGo: { configured: true },
        tts: { configured: true, ready: true, voice: "Ada" },
        profile: { name: "Ian", email: "ian@example.test" },
        features: { skillRecorder: true },
      }),
    ).toEqual({
      xai: { configured: true },
      composio: { configured: true, mode: "managed" },
      box: { configured: false },
      vps: { configured: true, sshAlias: "homelab" },
      rooms: { turnTimeoutMinutes: 20 },
      localVm: { mode: "per-bot", maxInstances: 3 },
      opencodeGo: { configured: true },
      tts: { configured: true, ready: true, voice: "Ada" },
      profile: { name: "Ian", email: "ian@example.test" },
      features: { skillRecorder: true },
    });
  });

  it("round-trips imessageLinq, so a config broadcast does not wipe Linq status", () => {
    const imessageLinq = {
      configured: true,
      botNumber: "+15555550100",
      perBot: { "maus-1": "linq" as const },
      ignoredSenders: ["+15555550101"],
      allowedSenders: [],
      allowVoiceByDefault: true,
      webhookReady: true,
    };
    const frame = {
      xai: { configured: true },
      composio: { configured: true, mode: "managed" as const },
      box: { configured: false },
      vps: { configured: true, sshAlias: "homelab" },
      rooms: { turnTimeoutMinutes: 20 },
      localVm: { mode: "per-bot" as const, maxInstances: 3 },
      imessageLinq,
    };
    expect(configStatusFromFrame(frame).imessageLinq).toEqual(imessageLinq);
  });

  it("round-trips botDefaults, so an inheriting bot's resolved backend survives a broadcast", () => {
    // botDefaults was missing from the ConfigStatusFrame Pick, so every SSE
    // `config` frame silently dropped it via the reducer's full `config:
    // action.config` replace -- and every bot inheriting a workspace default
    // reverted to resolveCloudBackend()'s bare "box" fallback the moment any
    // config broadcast landed, including the apply-defaults broadcast that
    // sets botDefaults in the first place.
    // SAFETY: a literal test fixture, not parsed input — both assertions
    // below just pin the fixture's own values, not a claim about unparsed
    // data crossing an I/O boundary.
    const botDefaults = {
      computers: ["cloud", "vm"] as Array<"cloud" | "vm" | "local">,
      cloudBackend: "vps" as const,
      allowedComputers: null,
    };
    expect(
      configStatusFromFrame({
        composio: { configured: false },
        box: { configured: false },
        vps: { configured: false, sshAlias: "" },
        rooms: { turnTimeoutMinutes: 5 },
        localVm: { mode: "shared", maxInstances: 2 },
        botDefaults,
      }).botDefaults,
    ).toEqual(botDefaults);
  });
});

describe("task rename", () => {
  it("updates the task title in local state immediately", () => {
    const bot = {
      id: "echo",
      threadId: "t1",
      name: "Echo",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "x", model: "y" },
      messages: [],
      tasks: [
        { threadId: "t1", title: "New task", createdAt: 1 },
        { threadId: "t2", title: "Other", createdAt: 2 },
      ],
    } satisfies Bot;
    const next = reducer(
      { ...initialState, bots: [bot] },
      { type: "renameTask", botId: bot.id, threadId: "t1", title: "Renamed" },
    );
    expect(next.bots[0]?.tasks?.find((task) => task.threadId === "t1")?.title).toBe("Renamed");
    expect(next.bots[0]?.tasks?.find((task) => task.threadId === "t2")?.title).toBe("Other");
  });

  it("updates a channel task title in local state immediately", () => {
    const group = {
      id: "room",
      threadId: "room-task-1",
      name: "Launch",
      memberIds: [],
      defaultResponder: { kind: "everyone" },
      bulletin: "",
      unread: false,
      createdAt: 1,
      messages: [],
      tasks: [
        { threadId: "room-task-1", title: "New task", createdAt: 1 },
        { threadId: "room-task-2", title: "Other", createdAt: 2 },
      ],
    } satisfies Group;
    const next = reducer(
      { ...initialState, groups: [group] },
      { type: "renameGroupTask", groupId: group.id, threadId: "room-task-1", title: "Renamed" },
    );
    expect(next.groups[0]?.tasks?.find((task) => task.threadId === "room-task-1")?.title).toBe("Renamed");
    expect(next.groups[0]?.tasks?.find((task) => task.threadId === "room-task-2")?.title).toBe("Other");
  });
});

describe("Teach a skill feature flag", () => {
  const config = configStatusFromFrame({
    composio: { configured: false },
    box: { configured: false },
    vps: { configured: false, sshAlias: "" },
    rooms: { turnTimeoutMinutes: 5 },
    localVm: { mode: "shared", maxInstances: 2 },
    features: { skillRecorder: true },
  });

  it("does not open the recorder while the experiment is disabled", () => {
    expect(reducer(initialState, { type: "showSkillRecorder" }).activeView).toBe("chat");
  });

  it("opens after opt-in and returns to chat when disabled", () => {
    const enabled = reducer({ ...initialState, config }, { type: "showSkillRecorder" });
    expect(enabled.activeView).toBe("skill-recorder");

    const disabled = reducer(enabled, {
      type: "configStatus",
      config: { ...config, features: { skillRecorder: false } },
    });
    expect(disabled.activeView).toBe("chat");
  });
});

describe("onboarding quiz", () => {
  const quizCard = {
    title: "What do you mostly want help with?",
    subtitle: "Pick whatever's closest; we can always expand from there.",
    options: ["Work & projects"],
  };
  const bot = {
    id: "echo",
    threadId: "t1",
    name: "Echo",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "x", model: "y" },
    messages: [
      { id: "g", role: "bot", kind: "text", text: "Hey", at: 1 },
      { id: "q", role: "bot", kind: "options", card: quizCard, at: 2 },
    ],
    activeLeafId: "q",
  } satisfies Bot;

  it("hides the quiz as soon as the person sends a message", () => {
    const state = { ...initialState, bots: [bot], selectedId: bot.id };
    const next = reducer(state, { type: "send", botId: bot.id, text: "Hi bro" });
    expect(next.bots[0]?.messages.find((message) => message.id === "q")?.card?.dismissed).toBe(true);
  });

  it("hides the quiz when they pick an option", () => {
    const state = { ...initialState, bots: [bot], selectedId: bot.id };
    const next = reducer(state, { type: "answerCard", botId: bot.id, messageId: "q", answer: "Work & projects" });
    expect(next.bots[0]?.messages.find((message) => message.id === "q")?.card).toMatchObject({
      answered: "Work & projects",
      dismissed: true,
    });
  });

  it("leaves a live permission card in place", () => {
    const askBot: Bot = {
      ...bot,
      messages: [
        ...bot.messages,
        {
          id: "ask",
          role: "bot",
          kind: "options",
          card: {
            title: "Approval needed",
            subtitle: "rm",
            options: ["Allow", "Deny"],
            requestId: "r1",
            tool: "Bash",
          },
          at: 3,
        },
      ],
      activeLeafId: "ask",
    };
    const state = { ...initialState, bots: [askBot], selectedId: askBot.id };
    const next = reducer(state, { type: "send", botId: askBot.id, text: "ok" });
    expect(next.bots[0]?.messages.find((message) => message.id === "ask")?.card?.dismissed).toBeUndefined();
    expect(next.bots[0]?.messages.find((message) => message.id === "q")?.card?.dismissed).toBe(true);
  });
});

describe("cross-client bot creation", () => {
  it("adds an announced bot before its greeting frames arrive", () => {
    const announced = {
      id: "phone-bot",
      threadId: "phone-thread",
      name: "Scout",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "codex", model: "default" },
    } satisfies Omit<Bot, "messages">;

    const added = reducer(initialState, { type: "botPatched", bot: announced });

    expect(added.bots).toEqual([{ ...announced, messages: [] }]);

    const greeting = {
      id: "greeting",
      role: "bot",
      kind: "text",
      text: "Hey — I'm Scout. Nice to meet you.",
      at: 2,
    } satisfies Message;
    const greeted = reducer(added, {
      type: "messageAdded",
      threadId: announced.threadId,
      message: greeting,
    });

    expect(greeted.bots[0]?.messages).toEqual([greeting]);
  });
});

describe("section Chiefs", () => {
  const bot = (id: string, section: string, chiefOfStaff = false) => ({
    id,
    threadId: `thread-${id}`,
    name: id,
    title: "",
    description: "",
    notifications: true,
    color: "green" as const,
    unread: false,
    modelSelection: { instanceId: "codex", model: "default" },
    section,
    chiefOfStaff,
  });

  it("hands off only within the patched bot's section", () => {
    const workChief = bot("work-a", "Work", true);
    const workCandidate = bot("work-b", "Work");
    const personalChief = bot("personal", "Personal", true);
    const state = {
      ...initialState,
      bots: [workChief, workCandidate, personalChief].map((candidate) => ({ ...candidate, messages: [] })),
    };

    const next = reducer(state, {
      type: "botPatched",
      bot: { ...workCandidate, chiefOfStaff: true },
    });

    expect(next.bots.find((candidate) => candidate.id === workChief.id)?.chiefOfStaff).toBe(false);
    expect(next.bots.find((candidate) => candidate.id === workCandidate.id)?.chiefOfStaff).toBe(true);
    expect(next.bots.find((candidate) => candidate.id === personalChief.id)?.chiefOfStaff).toBe(true);
  });

  it("keeps other section Chiefs during an optimistic settings update", () => {
    const workChief = bot("work-a", "Work", true);
    const workCandidate = bot("work-b", "Work");
    const personalChief = bot("personal", "Personal", true);
    const state = {
      ...initialState,
      bots: [workChief, workCandidate, personalChief].map((candidate) => ({ ...candidate, messages: [] })),
    };

    const next = reducer(state, {
      type: "updateBot",
      botId: workCandidate.id,
      patch: { chiefOfStaff: true },
    });

    expect(next.bots.find((candidate) => candidate.id === workChief.id)?.chiefOfStaff).toBe(false);
    expect(next.bots.find((candidate) => candidate.id === workCandidate.id)?.chiefOfStaff).toBe(true);
    expect(next.bots.find((candidate) => candidate.id === personalChief.id)?.chiefOfStaff).toBe(true);
  });
});

describe("pending queued chip", () => {
  const bot = {
    id: "b1",
    threadId: "t1",
    name: "Ada",
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "acp", model: "fake" },
  } satisfies Omit<Bot, "messages">;

  it("records queue-fallback text and drops it when that user line lands", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q1",
      text: "later",
    });
    expect(queued.pendingQueued.t1).toEqual([
      expect.objectContaining({ queueId: "q1", text: "later", at: expect.any(Number) }),
    ]);
    const landed = reducer(queued, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q1",
    });
    expect(landed.pendingQueued).toEqual({});
  });

  it("keeps a Shift+Enter multiline message as one entry", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-ml",
      text: "line one\nline two",
    });
    expect(queued.pendingQueued.t1).toEqual([
      expect.objectContaining({ queueId: "q-ml", text: "line one\nline two", at: expect.any(Number) }),
    ]);
    const landed = reducer(queued, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q-ml",
    });
    expect(landed.pendingQueued).toEqual({});
  });

  it("leaves the chip on the old thread after a task switch", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-stay",
      text: "stay here",
    });
    const switched = reducer(queued, {
      type: "botPatched",
      bot: { ...bot, threadId: "t2", messages: [] },
    });
    expect(switched.pendingQueued.t1).toEqual([
      expect.objectContaining({ queueId: "q-stay", text: "stay here", at: expect.any(Number) }),
    ]);
    expect(switched.pendingQueued[switched.bots[0]!.threadId]).toBeUndefined();
    const drained = reducer(switched, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q-stay",
    });
    expect(drained.pendingQueued).toEqual({});
  });

  it("consumes only the matching queue id when two pending lines share text", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const first = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "qa",
      text: "same",
    });
    const both = reducer(first, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "qb",
      text: "same",
    });
    expect(both.pendingQueued.t1).toEqual([
      expect.objectContaining({ queueId: "qa", text: "same", at: expect.any(Number) }),
      expect.objectContaining({ queueId: "qb", text: "same", at: expect.any(Number) }),
    ]);
    const afterOther = reducer(both, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "qa",
    });
    expect(afterOther.pendingQueued.t1).toEqual([
      expect.objectContaining({ queueId: "qb", text: "same", at: expect.any(Number) }),
    ]);
  });

  it("does not add a chip when the drain frame arrives before the POST continuation", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const drained = reducer(withBot, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q1",
    });
    expect(drained.pendingQueued).toEqual({});
    const late = reducer(drained, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q1",
      text: "later",
    });
    expect(late.pendingQueued).toEqual({});
    expect(late.consumedQueueIds).toEqual({});
  });

  it("bounds unmatched queue tombstones from other clients", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    let state = withBot;
    for (let index = 0; index < 100; index += 1) {
      state = reducer(state, {
        type: "consumePendingQueued",
        threadId: "t1",
        queueId: `foreign-${index}`,
      });
    }

    expect(Object.keys(state.consumedQueueIds)).toHaveLength(64);
    expect(state.consumedQueueIds["foreign-0"]).toBeUndefined();
    expect(state.consumedQueueIds["foreign-99"]).toBe(true);

    const late = reducer(state, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "foreign-99",
      text: "already drained",
    });
    expect(late.pendingQueued).toEqual({});
    expect(late.consumedQueueIds["foreign-99"]).toBeUndefined();
  });

  it("drops a cancelled pending chip without waiting for drain", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-drop",
      text: "never mind",
    });
    const cancelled = reducer(queued, {
      type: "cancelQueued",
      botId: "b1",
      queueId: "q-drop",
    });
    expect(cancelled.pendingQueued).toEqual({});
  });

  it("stamps pending at once and keeps it stable across remember", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const first = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-stable",
      text: "hold",
      at: 1_700_000_000_000,
    });
    expect(first.pendingQueued.t1?.[0]?.at).toBe(1_700_000_000_000);
    // Re-dispatching the same queueId is a no-op — stamp must not remint.
    const again = reducer(first, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-stable",
      text: "hold",
      at: 1_800_000_000_000,
    });
    expect(again.pendingQueued.t1?.[0]?.at).toBe(1_700_000_000_000);
  });
});

describe("hydrate vs in-flight patches", () => {
  const bot = (overrides: Partial<Bot> = {}): Bot => ({
    id: "echo",
    threadId: "t1",
    name: "Echo",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "x", model: "y" },
    messages: [],
    ...overrides,
  });

  const group = (overrides: Partial<Group> = {}): Group => ({
    id: "room",
    threadId: "room-t",
    name: "Launch",
    memberIds: ["echo"],
    defaultResponder: { kind: "everyone" },
    bulletin: "",
    unread: false,
    createdAt: 1,
    messages: [],
    ...overrides,
  });

  it("overlays in-flight profile fields onto a stale REST snapshot", () => {
    const local = bot({ name: "Echo", title: "Old" });
    const server = bot({ name: "Echo", title: "Old" });
    const merged = mergeHydrateBots(
      [local],
      [server],
      { echo: { title: "Ops" } },
      {},
      {},
    );
    expect(merged[0]?.title).toBe("Ops");
  });

  it("keeps a locally newer bot when epoch advanced during the fetch", () => {
    const local = bot({ name: "Renamed" });
    const server = bot({ name: "Echo" });
    const merged = mergeHydrateBots([local], [server], {}, { echo: 2 }, { echo: 1 });
    expect(merged[0]?.name).toBe("Renamed");
  });

  it("takes the server snapshot when nothing changed during the fetch", () => {
    const local = bot({ name: "Echo" });
    const server = bot({ name: "FromServer", busy: true });
    const merged = mergeHydrateBots([local], [server], {}, { echo: 1 }, { echo: 1 });
    expect(merged[0]?.name).toBe("FromServer");
    expect(merged[0]?.busy).toBe(true);
  });

  it("keeps an optimistic room roster across a stale hydrate", () => {
    const local = group({ memberIds: ["echo", "ada"] });
    const server = group({ memberIds: ["echo"] });
    const merged = mergeHydrateGroups([local], [server], { room: 3 }, { room: 2 });
    expect(merged[0]?.memberIds).toEqual(["echo", "ada"]);
  });

  it("bumps bot epoch on updateBot and skips clobbering that bot on hydrate", () => {
    const seeded = reducer(initialState, { type: "botPatched", bot: bot() });
    const edited = reducer(seeded, { type: "updateBot", botId: "echo", patch: { name: "Renamed" } });
    expect(edited.botEpoch.echo).toBe(1);
    const hydrated = reducer(edited, {
      type: "hydrate",
      bots: [bot({ name: "Echo" })],
      groups: [],
      computerControl: {},
      botEpochAtFetch: seeded.botEpoch,
    });
    expect(hydrated.bots[0]?.name).toBe("Renamed");
  });

  it("routes setModel through epoch so a concurrent hydrate cannot snap the model back", () => {
    const seeded = reducer(initialState, { type: "botPatched", bot: bot() });
    const picked = reducer(seeded, {
      type: "setModel",
      botId: "echo",
      selection: { instanceId: "grok", model: "grok-4" },
    });
    const hydrated = reducer(picked, {
      type: "hydrate",
      bots: [bot()],
      groups: [],
      computerControl: {},
      botEpochAtFetch: seeded.botEpoch,
    });
    expect(hydrated.bots[0]?.modelSelection).toEqual({ instanceId: "grok", model: "grok-4" });
  });

  it("restores the previous room roster after an optimistic patch is rejected", () => {
    const seeded = reducer(initialState, {
      type: "groupPatched",
      group: group({ memberIds: ["echo"] }),
    });
    const optimistic = reducer(seeded, {
      type: "patchGroup",
      groupId: "room",
      patch: { memberIds: ["echo", "ada"] },
    });
    expect(optimistic.groups[0]?.memberIds).toEqual(["echo", "ada"]);
    const rolled = reducer(optimistic, {
      type: "groupPatched",
      group: group({ memberIds: ["echo"] }),
    });
    expect(rolled.groups[0]?.memberIds).toEqual(["echo"]);
  });
});


describe("room terminology", () => {
  it("defaults to Channels when nothing is configured", () => {
    expect(getRoomTerminology(null)).toEqual({
      key: "channels",
      singular: "Channel",
      plural: "Channels",
    });
  });

  it("prefers the words the harness resolved", () => {
    // The harness owns the pair so the Mac app and the phone cannot drift.
    expect(
      getRoomTerminology({
        terminology: "custom",
        roomLabels: { singular: "Person", plural: "People" },
      } as never),
    ).toEqual({ key: "custom", singular: "Person", plural: "People" });
  });

  it("resolves a preset locally when talking to an older harness", () => {
    // An older harness sends the key without roomLabels.
    expect(getRoomTerminology({ terminology: "repos" } as never)).toEqual({
      key: "repos",
      singular: "Repo",
      plural: "Repos",
    });
  });
});

describe("paginated scrollback", () => {
  const bot = (overrides: Partial<Bot> = {}): Bot => ({
    id: "echo",
    threadId: "t1",
    name: "Echo",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "x", model: "y" },
    messages: [],
    ...overrides,
  });

  const group = (overrides: Partial<Group> = {}): Group => ({
    id: "room",
    threadId: "room-t",
    name: "Launch",
    memberIds: ["echo"],
    defaultResponder: { kind: "everyone" },
    bulletin: "",
    unread: false,
    createdAt: 1,
    messages: [],
    ...overrides,
  });

  const say = (id: string, at: number): Message => ({ id, at, role: "bot", kind: "text", text: id });

  const hydrated = (bots: Bot[], groups: Group[] = []) =>
    reducer(initialState, {
      type: "hydrate",
      bots,
      groups,
      computerControl: {},
    });

  it("records what the server says is still older, per thread", () => {
    const state = hydrated(
      [bot({ hasMore: true })],
      [group({ hasMore: false })],
    );
    expect(state.hasMore).toEqual({ t1: true, "room-t": false });
  });

  it("treats a full, unpaginated response as nothing older to fetch", () => {
    expect(hydrated([bot()]).hasMore).toEqual({ t1: false });
  });

  it("prepends an earlier page in front of the tail and clears the spinner", () => {
    const start = hydrated([bot({ messages: [say("m3", 3)], hasMore: true })]);
    const loading = reducer(start, { type: "earlierLoading", threadId: "t1" });
    expect(loading.loadingEarlier.t1).toBe(true);

    const loaded = reducer(loading, {
      type: "earlierLoaded",
      threadId: "t1",
      messages: [say("m1", 1), say("m2", 2)],
      hasMore: false,
    });
    expect(loaded.bots[0].messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(loaded.hasMore.t1).toBe(false);
    expect(loaded.loadingEarlier.t1).toBeUndefined();
  });

  it("never duplicates a message the client already holds", () => {
    const start = hydrated([bot({ messages: [say("m2", 2), say("m3", 3)], hasMore: true })]);
    const loaded = reducer(start, {
      type: "earlierLoaded",
      threadId: "t1",
      // an edit can rewrite the tail, so a page CAN overlap what is loaded
      messages: [say("m1", 1), say("m2", 2)],
      hasMore: true,
    });
    expect(loaded.bots[0].messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("lands a room's page on the room, not on a bot that shares nothing but the request", () => {
    const start = hydrated([bot()], [group({ messages: [say("g2", 2)], hasMore: true })]);
    const loaded = reducer(start, {
      type: "earlierLoaded",
      threadId: "room-t",
      messages: [say("g1", 1)],
      hasMore: false,
    });
    expect(loaded.groups[0].messages.map((m) => m.id)).toEqual(["g1", "g2"]);
    expect(loaded.bots[0].messages).toEqual([]);
  });

  it("an empty page still settles the pill rather than leaving it spinning", () => {
    const start = reducer(hydrated([bot({ hasMore: true })]), {
      type: "earlierLoading",
      threadId: "t1",
    });
    const settled = reducer(start, { type: "earlierLoaded", threadId: "t1", messages: [], hasMore: false });
    expect(settled.loadingEarlier.t1).toBeUndefined();
    expect(settled.hasMore.t1).toBe(false);
  });

  it("a re-hydrate replaces the flags rather than leaving a stale promise", () => {
    const stale = reducer(hydrated([bot({ hasMore: true })]), {
      type: "earlierLoading",
      threadId: "t1",
    });
    const fresh = reducer(stale, { type: "hydrate", bots: [bot()], groups: [], computerControl: {} });
    expect(fresh.hasMore.t1).toBe(false);
    expect(fresh.loadingEarlier).toEqual({});
  });
});
