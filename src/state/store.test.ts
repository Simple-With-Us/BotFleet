import { describe, expect, it, vi } from "vitest";

import {
  configStatusFromFrame,
  MessagePostResponseSchema,
  TaskSwitchResponseSchema,
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

describe("API response contracts", () => {
  const bot = {
    id: "bot-1",
    threadId: "thread-1",
    name: "Bot",
    title: "Bot",
    description: "A test bot",
    notifications: true,
    color: "blue",
    unread: false,
    modelSelection: { instanceId: "engine-1", model: "model-1" },
    messages: [],
  };

  it("keeps only the task-switch thread identity and rejects a bad envelope", () => {
    const parsed = TaskSwitchResponseSchema.safeParse({
      bot: {
        ...bot,
        messages: [{ id: "m1", role: "user", kind: "text", at: 1, injected: true }],
        unexpected: true,
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.bot).toEqual({ id: "bot-1", threadId: "thread-1" });
    expect(TaskSwitchResponseSchema.safeParse({ bot, extra: true }).success).toBe(false);
    expect(TaskSwitchResponseSchema.safeParse({ bot: { ...bot, threadId: 42 } }).success).toBe(false);
    expect(TaskSwitchResponseSchema.safeParse({ bot: { id: "bot-1" } }).success).toBe(false);
  });

  it("accepts each message post outcome and rejects unvalidated fields", () => {
    expect(MessagePostResponseSchema.safeParse({ ok: true }).success).toBe(true);
    expect(MessagePostResponseSchema.safeParse({ ok: true, steered: true }).success).toBe(true);
    expect(MessagePostResponseSchema.safeParse({ ok: true, ignored: "self_echo" }).success).toBe(true);
    expect(MessagePostResponseSchema.safeParse({ ok: true, replayed: true }).success).toBe(true);
    expect(MessagePostResponseSchema.safeParse({ ok: true, steered: true, replayed: true }).success).toBe(true);
    expect(
      MessagePostResponseSchema.safeParse({
        ok: true,
        ignored: "self_echo",
        replayed: true,
      }).success,
    ).toBe(true);
    expect(
      MessagePostResponseSchema.safeParse({
        ok: true,
        queued: true,
        queueId: "queue-1",
        threadId: "thread-1",
        replayed: true,
      }).success,
    ).toBe(true);
    expect(MessagePostResponseSchema.safeParse({ ok: true, queued: true, queueId: 7, threadId: "thread-1" }).success).toBe(false);
    expect(MessagePostResponseSchema.safeParse({ ok: true, extra: "unexpected" }).success).toBe(false);
    expect(MessagePostResponseSchema.safeParse({ ok: true, ignored: "other" }).success).toBe(false);
    expect(MessagePostResponseSchema.safeParse({ ok: true, replayed: false }).success).toBe(false);
  });
});

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

// BF-2424: the optimistic-patch reconcile re-reads a bot after a rejected
// PATCH. It asks for `?messages=0`, which answers with `messages: []`, and an
// incoming transcript sharing no ids with what is on screen is read as a full
// snapshot and replaces — vacuously true for an empty array. So the visible
// conversation would blank on every rejected save. The reconcile therefore
// carries the transcript already on screen instead of the empty one.
describe("reconcile frames must not blank the transcript", () => {
  const seedBot = {
    id: "bot-1",
    threadId: "t1",
    name: "Ada",
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "acp", model: "fake" },
  } satisfies Omit<Bot, "messages">;

  const seeded = reducer(initialState, {
    type: "botPatched",
    bot: { ...seedBot, messages: [] },
  });
  const withTranscript = reducer(seeded, {
    type: "messageAdded",
    threadId: "t1",
    message: { id: "m1", role: "user", kind: "text", text: "still here", at: 1 },
  });

  it("documents the hazard: a bare empty transcript from the same thread DOES replace", () => {
    // This is the existing, intended behaviour for a task-switch snapshot that
    // arrives empty (see "task switch transcript" below). It is exactly why the
    // reconcile must not hand an empty array back: the reducer cannot tell the
    // two apart, so the caller has to carry the real transcript.
    const blanked = reducer(withTranscript, {
      type: "botPatched",
      bot: { ...seedBot, messages: [] },
    });
    expect(blanked.bots[0]?.messages).toEqual([]);
  });

  it("keeps the transcript when the reconcile carries the messages already on screen", () => {
    const reconciled = reducer(withTranscript, {
      type: "botPatched",
      bot: { ...seedBot, messages: withTranscript.bots[0]!.messages },
    });
    expect(reconciled.bots[0]?.messages.map((m) => m.id)).toEqual(["m1"]);
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

describe("instances ordering guard", () => {
  const engine = (version: string) => ({
    instanceId: "claude",
    driverKind: "claudeAgent",
    displayName: "Claude",
    snapshot: { state: "available" as const, version },
    models: { default: "", options: [] },
  });

  it("drops an instances answer older than the one already shown", () => {
    // A slow GET that started before the `instances` push must not put the
    // older sweep back on screen.
    const pushed = reducer(initialState, { type: "instances", instances: [engine("new")], describedAt: 2_000 });
    const late = reducer(pushed, { type: "instances", instances: [engine("old")], describedAt: 1_000 });
    expect(late.instances[0].snapshot.version).toBe("new");
    expect(late.instancesDescribedAt).toBe(2_000);
  });

  it("applies a newer or equal answer, and one from a server that sends no stamp", () => {
    const first = reducer(initialState, { type: "instances", instances: [engine("a")], describedAt: 1_000 });
    const same = reducer(first, { type: "instances", instances: [engine("b")], describedAt: 1_000 });
    expect(same.instances[0].snapshot.version).toBe("b");
    const newer = reducer(same, { type: "instances", instances: [engine("c")], describedAt: 3_000 });
    expect(newer.instances[0].snapshot.version).toBe("c");
    const unstamped = reducer(newer, { type: "instances", instances: [engine("d")] });
    expect(unstamped.instances[0].snapshot.version).toBe("d");
    expect(unstamped.instancesDescribedAt).toBe(3_000);
  });
  it("forgets the ordering mark but keeps the engine list when the stream could not resume", () => {
    // A restarted harness stamps from its own clock, which can sit below the
    // last process's final stamp.  Its first answer must not be dropped as old.
    const held = reducer(initialState, { type: "instances", instances: [engine("held")], describedAt: 9_000 });
    const reset = reducer(held, { type: "instancesOrderReset" });
    expect(reset.instances[0].snapshot.version).toBe("held");
    expect(reset.instancesDescribedAt).toBe(0);
    const restarted = reducer(reset, { type: "instances", instances: [engine("restarted")], describedAt: 4_000 });
    expect(restarted.instances[0].snapshot.version).toBe("restarted");
    expect(restarted.instancesDescribedAt).toBe(4_000);
    // Ordering holds again from that stamp on.
    const late = reducer(restarted, { type: "instances", instances: [engine("late")], describedAt: 3_000 });
    expect(late.instances[0].snapshot.version).toBe("restarted");
  });
});

describe("viewed thread pin stays with its selection", () => {
  const bot = (id: string, threadId: string): Bot => ({
    id,
    threadId,
    name: id,
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "x", model: "y" },
    messages: [],
  });

  const pinned = {
    ...initialState,
    bots: [bot("a", "thread-a"), bot("b", "thread-b")],
    selectedId: "a",
    viewedThreadId: "app-thread",
  };

  it("drops the pin when botAdded selects the new bot", () => {
    const next = reducer(pinned, { type: "botAdded", bot: bot("c", "thread-c") });
    expect(next.selectedId).toBe("c");
    expect(next.viewedThreadId).toBeNull();
  });

  it("keeps the pin when botAdded folds the bot that is already selected", () => {
    const next = reducer(pinned, { type: "botAdded", bot: bot("a", "thread-a") });
    expect(next.selectedId).toBe("a");
    expect(next.viewedThreadId).toBe("app-thread");
  });

  it("drops the pin when the selected bot is deleted and keeps it otherwise", () => {
    const deleted = reducer(pinned, { type: "deleteBot", botId: "a" });
    expect(deleted.selectedId).not.toBe("a");
    expect(deleted.viewedThreadId).toBeNull();
    const other = reducer(pinned, { type: "deleteBot", botId: "b" });
    expect(other.selectedId).toBe("a");
    expect(other.viewedThreadId).toBe("app-thread");
  });

  it("drops the pin when hydrate has to move the selection, and keeps it when the bot remains", () => {
    const moved = reducer(pinned, {
      type: "hydrate",
      bots: [bot("b", "thread-b")],
      groups: [],
      computerControl: {},
    });
    expect(moved.selectedId).toBe("b");
    expect(moved.viewedThreadId).toBeNull();
    const kept = reducer(pinned, {
      type: "hydrate",
      bots: [bot("a", "thread-a"), bot("b", "thread-b")],
      groups: [],
      computerControl: {},
    });
    expect(kept.selectedId).toBe("a");
    expect(kept.viewedThreadId).toBe("app-thread");
  });
});

describe("task switch transcript", () => {
  const message = (id: string): Message => ({ id, role: "user", kind: "text", text: id, at: 1 });
  const bot = (threadId: string, messages: Message[]): Bot => ({
    id: "a",
    threadId,
    name: "a",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "x", model: "y" },
    messages,
  });

  it("keeps the transcript when a task switch ack omits messages", () => {
    const state = {
      ...initialState,
      bots: [bot("old-thread", [message("old")])],
      selectedId: "a",
      viewedThreadId: "new-thread",
    };
    const next = reducer(state, { type: "taskSwitched", bot: { id: "a", threadId: "new-thread" } });
    expect(next.bots[0]?.threadId).toBe("new-thread");
    expect(next.bots[0]?.messages.map((entry) => entry.id)).toEqual(["old"]);
    expect(next.viewedThreadId).toBeNull();
  });

  it("replaces the transcript when a later bot frame is a different thread's snapshot", () => {
    const state = {
      ...initialState,
      bots: [bot("new-thread", [message("old")])],
      selectedId: "a",
    };
    const next = reducer(state, {
      type: "botPatched",
      bot: { ...bot("new-thread", [message("fresh")]), messages: [message("fresh")] },
    });
    expect(next.bots[0]?.messages.map((entry) => entry.id)).toEqual(["fresh"]);
  });

  it("does not replace a same-thread snapshot that overlaps the current transcript", () => {
    const state = {
      ...initialState,
      bots: [bot("same", [message("keep"), message("local")])],
      selectedId: "a",
    };
    const next = reducer(state, {
      type: "botPatched",
      bot: { ...bot("same", [message("keep")]), messages: [message("keep")] },
    });
    expect(next.bots[0]?.messages.map((entry) => entry.id)).toEqual(["keep", "local"]);
  });

  it("replaces the retained transcript when the new thread snapshot is empty", () => {
    const held = reducer(
      {
        ...initialState,
        bots: [bot("old-thread", [message("old")])],
        selectedId: "a",
      },
      { type: "taskSwitched", bot: { id: "a", threadId: "new-thread" } },
    );
    expect(held.bots[0]?.threadId).toBe("new-thread");
    expect(held.bots[0]?.messages.map((entry) => entry.id)).toEqual(["old"]);
    const next = reducer(held, {
      type: "botPatched",
      bot: { ...bot("new-thread", []), messages: [] },
    });
    expect(next.bots[0]?.threadId).toBe("new-thread");
    expect(next.bots[0]?.messages).toEqual([]);
  });

  it("applies a non-empty snapshot when the client transcript is empty", () => {
    const state = {
      ...initialState,
      bots: [bot("thread", [])],
      selectedId: "a",
    };
    const next = reducer(state, {
      type: "botPatched",
      bot: { ...bot("thread", [message("fresh")]), messages: [message("fresh")] },
    });
    expect(next.bots[0]?.threadId).toBe("thread");
    expect(next.bots[0]?.messages.map((entry) => entry.id)).toEqual(["fresh"]);
  });
});

// The Fleet Matrix overview closes when the person picks a chat, and only then.
// `selectedId` cannot say that: a click on the open chat leaves it unchanged,
// and the store rewrites it by itself when a hydrate loses the selection or a
// delete falls back.  `selectionNonce` is the signal, so this pins which
// actions move it.
describe("selectionNonce", () => {
  const botNamed = (id: string) =>
    ({
      id,
      threadId: `${id}-thread`,
      name: id,
      title: "",
      description: "",
      notifications: true,
      color: "blue",
      unread: false,
      modelSelection: { instanceId: "x", model: "y" },
      messages: [],
    }) satisfies Bot;
  const roomNamed = (id: string) =>
    ({
      id,
      threadId: `${id}-thread`,
      name: id,
      memberIds: ["a"],
      defaultResponder: { kind: "everyone" },
      bulletin: "",
      unread: false,
      createdAt: 1,
      messages: [],
    }) satisfies Group;
  const open = {
    ...initialState,
    bots: [botNamed("a"), botNamed("b")],
    groups: [roomNamed("room")],
    selectedId: "a",
  };

  it("counts picking another bot or a room", () => {
    const toBot = reducer(open, { type: "select", id: "b" });
    expect(toBot.selectionNonce).toBe(open.selectionNonce + 1);
    const toRoom = reducer(toBot, { type: "select", id: "room" });
    expect(toRoom.selectionNonce).toBe(open.selectionNonce + 2);
  });

  it("counts a click on the chat that is already open, which selectedId cannot show", () => {
    const sameBot = reducer(open, { type: "select", id: "a" });
    expect(sameBot.selectedId).toBe(open.selectedId);
    expect(sameBot.selectionNonce).toBe(open.selectionNonce + 1);

    const inRoom = { ...open, selectedId: "room" };
    const sameRoom = reducer(inRoom, { type: "select", id: "room" });
    expect(sameRoom.selectedId).toBe("room");
    expect(sameRoom.selectionNonce).toBe(inRoom.selectionNonce + 1);
  });

  it("counts a new bot taking the selection, not a second fold of the bot already on screen", () => {
    const added = reducer(open, { type: "botAdded", bot: botNamed("c") });
    expect(added.selectedId).toBe("c");
    expect(added.selectionNonce).toBe(open.selectionNonce + 1);
    const refolded = reducer(added, { type: "botAdded", bot: botNamed("c") });
    expect(refolded.selectedId).toBe("c");
    expect(refolded.selectionNonce).toBe(added.selectionNonce);
  });

  it("does not move for a bot or room update streamed in the background", () => {
    const busy = reducer(open, { type: "botPatched", bot: { ...botNamed("a"), busy: true } });
    const arrived = reducer(busy, { type: "botPatched", bot: botNamed("elsewhere") });
    const room = reducer(arrived, { type: "groupPatched", group: { id: "room", unread: true } });
    const thread = reducer(room, { type: "taskSwitched", bot: { id: "a", threadId: "a-other" } });
    expect(thread.selectionNonce).toBe(open.selectionNonce);
  });

  it("does not move when hydrate picks the first bot at launch or after the selection vanished", () => {
    const launch = reducer(initialState, {
      type: "hydrate",
      bots: [botNamed("a"), botNamed("b")],
      groups: [roomNamed("room")],
      computerControl: {},
    });
    expect(launch.selectedId).toBe("a");
    expect(launch.selectionNonce).toBe(initialState.selectionNonce);

    const lost = reducer({ ...open, selectedId: "gone" }, {
      type: "hydrate",
      bots: [botNamed("b")],
      groups: [],
      computerControl: {},
    });
    expect(lost.selectedId).toBe("b");
    expect(lost.selectionNonce).toBe(open.selectionNonce);
  });

  it("does not move when a delete makes the store fall back to another chat", () => {
    const roomGone = reducer({ ...open, selectedId: "room" }, { type: "groupDeleted", groupId: "room" });
    expect(roomGone.selectedId).toBe("a");
    expect(roomGone.selectionNonce).toBe(open.selectionNonce);

    const botGone = reducer(open, { type: "deleteBot", botId: "a" });
    expect(botGone.selectedId).toBe("b");
    expect(botGone.selectionNonce).toBe(open.selectionNonce);
  });
});

describe("browsing a retained thread while the bot works", () => {
  const message = (id: string): Message => ({ id, role: "bot", kind: "text", text: id, at: 1 });
  const busyBot = {
    id: "worker",
    threadId: "thread-a",
    name: "Worker",
    title: "",
    description: "",
    notifications: true,
    color: "blue",
    unread: false,
    busy: true,
    modelSelection: { instanceId: "codex", model: "gpt" },
    messages: [message("a1")],
    tasks: [
      { threadId: "thread-a", title: "Active", createdAt: 1 },
      { threadId: "thread-b", title: "Retained", createdAt: 2 },
    ],
  } satisfies Bot;
  const open = { ...initialState, bots: [busyBot], selectedId: "worker" };

  it("views thread B without moving the execution target or its transcript", () => {
    const viewed = reducer(open, { type: "viewThread", botId: "worker", threadId: "thread-b" });
    expect(viewed.viewedThreadId).toBe("thread-b");
    expect(viewed.bots[0]?.threadId).toBe("thread-a");
    expect(viewed.bots[0]?.busy).toBe(true);
    expect(viewed.bots[0]?.messages.map((entry) => entry.id)).toEqual(["a1"]);
    // a first open needs its own page from the messages route
    expect(viewed.loadingThread["thread-b"]).toBe(true);
  });

  it("refuses to view a thread the bot does not own, and clears the pin for the active thread", () => {
    const viewed = reducer(open, { type: "viewThread", botId: "worker", threadId: "thread-b" });
    expect(reducer(viewed, { type: "viewThread", botId: "worker", threadId: "elsewhere" })).toBe(viewed);
    expect(reducer(viewed, { type: "viewThread", botId: "worker", threadId: "thread-a" }).viewedThreadId).toBeNull();
    expect(reducer(viewed, { type: "viewThread", botId: "worker", threadId: null }).viewedThreadId).toBeNull();
  });

  it("keeps A streaming into the bot while B fills and updates its own cache", () => {
    let state = reducer(open, { type: "viewThread", botId: "worker", threadId: "thread-b" });
    state = reducer(state, {
      type: "threadTranscriptLoaded",
      threadId: "thread-b",
      messages: [message("b1")],
      hasMore: false,
    });
    expect(state.loadingThread["thread-b"]).toBeUndefined();
    // A is still the execution target: its frames land on the bot
    state = reducer(state, { type: "messageAdded", threadId: "thread-a", message: message("a2") });
    expect(state.bots[0]?.messages.map((entry) => entry.id)).toEqual(["a1", "a2"]);
    // B keeps receiving frames by threadId without touching A's transcript
    state = reducer(state, { type: "messageAdded", threadId: "thread-b", message: message("b2") });
    state = reducer(state, {
      type: "messagePatched",
      threadId: "thread-b",
      message: { ...message("b2"), text: "edited" },
    });
    state = reducer(state, { type: "messagesAdded", threadId: "thread-b", messages: [message("b3")] });
    expect(state.threadTranscripts["thread-b"]?.map((entry) => entry.id)).toEqual(["b1", "b2", "b3"]);
    expect(state.threadTranscripts["thread-b"]?.[1]?.text).toBe("edited");
    expect(state.bots[0]?.messages.map((entry) => entry.id)).toEqual(["a1", "a2"]);
    expect(state.bots[0]?.threadId).toBe("thread-a");
    // duplicate frames are dropped, unopened threads stay uncached
    const dupes = reducer(state, { type: "messageAdded", threadId: "thread-b", message: message("b3") });
    expect(dupes.threadTranscripts["thread-b"]).toHaveLength(3);
    const unopened = reducer(open, { type: "messageAdded", threadId: "thread-b", message: message("b1") });
    expect(unopened.threadTranscripts["thread-b"]).toBeUndefined();
  });

  it("prepends scrollback into the cache and stashes the left thread on a real switch", () => {
    let state = reducer(open, { type: "viewThread", botId: "worker", threadId: "thread-b" });
    state = reducer(state, {
      type: "threadTranscriptLoaded",
      threadId: "thread-b",
      messages: [message("b2")],
      hasMore: true,
    });
    state = reducer(state, {
      type: "earlierLoaded",
      threadId: "thread-b",
      messages: [message("b1")],
      hasMore: false,
    });
    expect(state.threadTranscripts["thread-b"]?.map((entry) => entry.id)).toEqual(["b1", "b2"]);
    expect(state.hasMore["thread-b"]).toBe(false);

    const switched = reducer(open, {
      type: "taskSwitched",
      bot: { id: "worker", threadId: "thread-b", messages: [message("b1")] },
    });
    expect(switched.bots[0]?.threadId).toBe("thread-b");
    expect(switched.threadTranscripts["thread-a"]?.map((entry) => entry.id)).toEqual(["a1"]);
    expect(switched.viewedThreadId).toBeNull();

    // the same answer shape after a delete drops the deleted page
    const deleted = reducer(state, {
      type: "taskSwitched",
      bot: {
        id: "worker",
        threadId: "thread-a",
        messages: [message("a1")],
        tasks: [{ threadId: "thread-a", title: "Active", createdAt: 1 }],
      },
    });
    expect(deleted.threadTranscripts["thread-b"]).toBeUndefined();
  });

  it("drops cached pages on hydrate so a reconnect refetches instead of trusting them", () => {
    const cached = {
      ...open,
      threadTranscripts: { "thread-b": [message("b1")] },
      loadingThread: { "thread-b": true },
      threadTranscriptErrors: { "thread-b": "boom" },
    };
    const hydrated = reducer(cached, {
      type: "hydrate",
      bots: [busyBot],
      groups: [],
      computerControl: {},
    });
    expect(hydrated.threadTranscripts).toEqual({});
    expect(hydrated.loadingThread).toEqual({});
    expect(hydrated.threadTranscriptErrors).toEqual({});
  });

  it("records a failed page so the view stops refetching, and clears it on an explicit reopen", () => {
    let state = reducer(open, { type: "viewThread", botId: "worker", threadId: "thread-b" });
    // a failure for a thread that is not loading is ignored
    expect(reducer(state, { type: "threadTranscriptFailed", threadId: "thread-x" })).toBe(state);
    state = reducer(state, { type: "threadTranscriptFailed", threadId: "thread-b", error: "boom" });
    // no cache and no loading flag, but the error stays so the view
    // effect holds instead of redispatching viewThread in a loop
    expect(state.threadTranscripts["thread-b"]).toBeUndefined();
    expect(state.loadingThread["thread-b"]).toBeUndefined();
    expect(state.threadTranscriptErrors["thread-b"]).toBe("boom");
    // opening the same thread again is an explicit retry: the error
    // clears and the page is flagged for loading
    const retried = reducer(state, { type: "viewThread", botId: "worker", threadId: "thread-b" });
    expect(retried.threadTranscriptErrors["thread-b"]).toBeUndefined();
    expect(retried.loadingThread["thread-b"]).toBe(true);
  });

  it("drops the newly active thread's stale browsed cache on a real switch", () => {
    const browsed = {
      ...open,
      threadTranscripts: { "thread-b": [message("b-old")] },
    };
    const switched = reducer(browsed, {
      type: "taskSwitched",
      bot: { id: "worker", threadId: "thread-b", messages: [message("b1")] },
    });
    expect(switched.bots[0]?.threadId).toBe("thread-b");
    // the thread just left is stashed for browsing back ...
    expect(switched.threadTranscripts["thread-a"]?.map((entry) => entry.id)).toEqual(["a1"]);
    // ... while the newly active thread's older browsed page is dropped:
    // new frames land on the bot now, so the cache would lie by omission
    expect(switched.threadTranscripts["thread-b"]).toBeUndefined();
  });

  it("keeps the browsed cache when a switch answer carries no thread change", () => {
    const browsed = {
      ...open,
      threadTranscripts: { "thread-b": [message("b-old")] },
    };
    const same = reducer(browsed, {
      type: "taskSwitched",
      bot: { id: "worker", threadId: "thread-a", messages: [message("a1")] },
    });
    expect(same.threadTranscripts["thread-b"]?.map((entry) => entry.id)).toEqual(["b-old"]);
  });

  it("drops the newly active thread's stale browsed cache on a bot frame switch", () => {
    const browsed = {
      ...open,
      threadTranscripts: { "thread-b": [message("b-old")] },
    };
    const patched = reducer(browsed, {
      type: "botPatched",
      bot: { ...busyBot, threadId: "thread-b", messages: [message("b1")] },
    });
    expect(patched.bots[0]?.threadId).toBe("thread-b");
    expect(patched.bots[0]?.messages.map((entry) => entry.id)).toEqual(["b1"]);
    expect(patched.threadTranscripts["thread-b"]).toBeUndefined();
  });

  it("keeps the browsed cache on bot frames that carry no thread change", () => {
    const browsed = {
      ...open,
      threadTranscripts: { "thread-b": [message("b-old")] },
    };
    const patched = reducer(browsed, {
      type: "botPatched",
      bot: { ...busyBot, busy: false },
    });
    expect(patched.threadTranscripts["thread-b"]?.map((entry) => entry.id)).toEqual(["b-old"]);
  });
});

// Checked against upstream OpenMausBot #1387 ("an edited message not
// appearing until the server round trip" / "stable retry IDs and stale
// response isolation"). BotFleet edits by forking the message server-side
// (`POST .../edit` → `store.branchMessage`, see server/index.ts) and the
// fork reaches the client as an ordinary `messageAdded` SSE frame — there
// is no client-side optimistic echo to reconcile, and the server's
// synchronous `bot.busy` gate on that same route already refuses a second
// edit while the first fork's turn is still in flight, so two edits can
// never race each other. What upstream's fix and BotFleet's mechanism do
// share is the other half of #1387: the fork message itself can reach the
// client twice (the POST's own response plus the canonical SSE frame,
// or a reconnect replay), in either order, and a naive `messageAdded`
// used to treat any repeat as "make this the active leaf again" — which
// could revert onto a fork after its reply had already taken over as the
// active leaf.
describe("messageAdded (upstream OpenMausBot #1387)", () => {
  const root: Message = { id: "root", role: "bot", kind: "text", text: "Ready", at: 1 };
  const bot = {
    id: "echo",
    threadId: "t1",
    name: "Echo",
    title: "",
    description: "",
    notifications: true,
    color: "green" as const,
    unread: false,
    modelSelection: { instanceId: "x", model: "y" },
    messages: [root],
    activeLeafId: root.id,
  } satisfies Bot;
  const state = { ...initialState, bots: [bot], selectedId: bot.id };

  it("an edit's fork becomes the active leaf as soon as it arrives — no need to wait out the rest of the round trip", () => {
    const fork: Message = { id: "q2", role: "user", kind: "text", text: "second try", at: 2, parentId: root.id };
    const next = reducer(state, { type: "messageAdded", threadId: "t1", message: fork });
    expect(next.bots[0]?.messages.map((m) => m.id)).toEqual([root.id, fork.id]);
    expect(next.bots[0]?.activeLeafId).toBe(fork.id);
  });

  it("a stale repeat of a superseded edit's fork does not clobber the reply that already won the race", () => {
    const fork: Message = { id: "q2", role: "user", kind: "text", text: "second try", at: 2, parentId: root.id };
    const withFork = reducer(state, { type: "messageAdded", threadId: "t1", message: fork });
    const reply: Message = { id: "a2", role: "bot", kind: "text", text: "new answer", at: 3, parentId: fork.id };
    const answered = reducer(withFork, { type: "messageAdded", threadId: "t1", message: reply });
    expect(answered.bots[0]?.activeLeafId).toBe(reply.id);

    // the fork's own POST response lands last (or an SSE reconnect
    // redelivers it) — a plain repeat, not a new message
    const stale = reducer(answered, { type: "messageAdded", threadId: "t1", message: fork });
    expect(stale.bots[0]?.activeLeafId).toBe(reply.id);
    expect(stale.bots[0]?.messages.map((m) => m.id)).toEqual([root.id, fork.id, reply.id]);
  });
});
