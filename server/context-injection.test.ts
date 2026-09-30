// What the harness injects into a turn, and how each injection becomes a
// record.  These pin WHICH parts of an assembled turn count, that each is cut
// from the real builders' output (not a copy of their wording), and that a
// preview can never carry a credential.
import { describe, expect, it, vi } from "vitest";

import {
  MemoryChangeGate,
  draftFromReplay,
  draftFromReply,
  draftsFromPromptSections,
  injectionPreview,
  recordContextInjections,
} from "./context-injection.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { promptWithReply } from "./replies.ts";
import type { Message } from "./store.ts";
import { buildTurnContext } from "./turn-context.ts";
import { MEMORY_CONTENT_HEADING } from "./workspace.ts";
import { CONTEXT_PREVIEW_LIMIT, MAX_CONTEXT_INJECTIONS_PER_TURN } from "../shared/context-injection.ts";

const SECRET = `sk-proj-${"c".repeat(24)}`;

describe("which prompt sections count", () => {
  it("records only what is chosen or changes per turn, in prompt order", () => {
    const drafts = draftsFromPromptSections([
      { id: "persona", text: "You are Ada." },
      { id: "recall", text: " Recall is available." },
      { id: "memory", text: `Guidance. \n\n${MEMORY_CONTENT_HEADING}likes tea` },
      { id: "owner-notes", text: "standing notes" },
      { id: "skill-instructions", text: " Use the phone skill." },
      { id: "playbooks", text: "Playbook: deploy" },
      { id: "automation", text: " Triggered by a webhook." },
      { id: "mentions", text: " The user tagged @Bo." },
    ]);
    expect(drafts.map((draft) => draft.source)).toEqual(["memory", "skill", "playbook", "automation", "mention"]);
    expect(drafts[0].text).toBe("likes tea");
  });

  it("skips empty sections", () => {
    expect(
      draftsFromPromptSections([
        { id: "skill-instructions", text: "" },
        { id: "mentions", text: "   " },
      ]),
    ).toEqual([]);
  });

  it("does not record the memory guidance when the bot has written no memory", () => {
    const guidanceOnly = draftsFromPromptSections([
      { id: "memory", text: ' Your private long-term memory file is "/x/MEMORY.md".' },
    ]);
    expect(guidanceOnly).toEqual([]);
  });
});

describe("replayed history", () => {
  const history = [
    { role: "user" as const, text: "my dog is named Biscuit" },
    { role: "assistant" as const, text: "Noted — Biscuit." },
  ];

  it("cuts the handoff out of the real builder's output", () => {
    const { turnText } = buildTurnContext({ text: "what is my dog called?", transcript: history, rewound: false, fresh: true, replaysNatively: false });
    const draft = draftFromReplay(turnText, "what is my dog called?", "handoff");
    expect(draft?.source).toBe("handoff");
    expect(draft?.text).toContain("joining this conversation mid-thread");
    expect(draft?.text).toContain("Biscuit");
    // what the person typed is not part of what was injected
    expect(draft?.text).not.toContain("what is my dog called?");
  });

  it("names a rewind as a rewind", () => {
    const { turnText } = buildTurnContext({ text: "again", transcript: history, rewound: true, fresh: false, replaysNatively: false });
    expect(draftFromReplay(turnText, "again", "rewind")?.source).toBe("rewind");
  });

  it("records nothing when the turn was sent as typed", () => {
    const { turnText } = buildTurnContext({ text: "hi", transcript: history, rewound: false, fresh: false, replaysNatively: false });
    expect(turnText).toBe("hi");
    expect(draftFromReplay(turnText, "hi", "handoff")).toBeNull();
    // a transcript-replaying engine gets its history another way: not an injection
    const native = buildTurnContext({ text: "hi", transcript: history, rewound: false, fresh: true, replaysNatively: true });
    expect(draftFromReplay(native.turnText, "hi", "handoff")).toBeNull();
  });
});

describe("quoted replies", () => {
  const target = { id: "m1", at: 1, role: "user", kind: "text", text: "the launch is on Friday" } as Message;

  it("cuts the quote out of the real builder's output", () => {
    const replied = promptWithReply("are you sure?", target, "Ada");
    const draft = draftFromReply(replied, "are you sure?");
    expect(draft?.source).toBe("reply");
    expect(draft?.text).toContain("the launch is on Friday");
    expect(draft?.text).not.toContain("are you sure?");
  });

  it("records nothing for a message that is not a reply", () => {
    expect(draftFromReply(promptWithReply("hello", undefined), "hello")).toBeNull();
  });
});

describe("previews", () => {
  it("is one flat line clipped to the preview limit", () => {
    const preview = injectionPreview(`line one\n\nline   two ${"w ".repeat(200)}`);
    expect(preview.length).toBeLessThanOrEqual(CONTEXT_PREVIEW_LIMIT);
    expect(preview).not.toContain("\n");
    expect(preview.startsWith("line one line two")).toBe(true);
  });

  it("redacts before it clips, so a credential is never half shown", () => {
    const preview = injectionPreview(`${"n".repeat(CONTEXT_PREVIEW_LIMIT - 12)} token ${SECRET} and more`);
    expect(preview).not.toContain("sk-proj-c");
    const plain = injectionPreview(`my key is ${SECRET}`);
    expect(plain).not.toContain(SECRET);
    expect(plain).toContain("redacted");
  });
});

describe("MemoryChangeGate", () => {
  it("records memory the first time and again only when it changes", () => {
    const gate = new MemoryChangeGate();
    expect(gate.changed("t", "likes tea")).toBe(true);
    expect(gate.changed("t", "likes tea")).toBe(false);
    expect(gate.changed("t", "likes coffee")).toBe(true);
    expect(gate.changed("other", "likes coffee")).toBe(true);
  });

  it("is bounded: an evicted thread just records once more", () => {
    const gate = new MemoryChangeGate(2);
    gate.changed("a", "x");
    gate.changed("b", "x");
    gate.changed("c", "x");
    expect(gate.changed("a", "x")).toBe(true);
    expect(gate.changed("c", "x")).toBe(false);
  });

  it("forgets a thread on request", () => {
    const gate = new MemoryChangeGate();
    gate.changed("t", "x");
    gate.forget("t");
    expect(gate.changed("t", "x")).toBe(true);
  });
});

describe("recordContextInjections", () => {
  const setup = () => {
    const events: RuntimeEvent[] = [];
    const attached: unknown[][] = [];
    let n = 0;
    return {
      events,
      attached,
      deps: {
        publish: (event: RuntimeEvent) => void events.push(event),
        attach: (refs: unknown[]) => void attached.push(refs),
        newId: () => `ctx-${++n}`,
        now: () => new Date("2026-09-30T20:00:00.000Z"),
      },
    };
  };

  it("publishes one event per draft and hands the short refs to the message", () => {
    const { events, attached, deps } = setup();
    const refs = recordContextInjections(deps, {
      threadId: "thread-1",
      provider: "claudeAgent",
      providerInstanceId: "claude",
      drafts: [
        { source: "memory", text: "likes tea\nand quiet" },
        { source: "skill", text: "Use the phone skill." },
      ],
    });
    expect(refs).toEqual([
      { id: "ctx-1", source: "memory", preview: "likes tea and quiet", bytes: 19 },
      { id: "ctx-2", source: "skill", preview: "Use the phone skill.", bytes: 20 },
    ]);
    expect(attached).toEqual([refs]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "context.injected",
      source: "memory",
      itemId: "ctx-1",
      threadId: "thread-1",
      provider: "claudeAgent",
      providerInstanceId: "claude",
      createdAt: "2026-09-30T20:00:00.000Z",
      preview: "likes tea and quiet",
      bytes: 19,
      io: { text: { text: "likes tea\nand quiet", truncated: false, length: 19 } },
    });
    // the turn it belongs to is not known yet, and the event never pretends
    expect(events[0]).not.toHaveProperty("turnId");
  });

  it("counts bytes, not characters", () => {
    const { deps } = setup();
    const [ref] = recordContextInjections(deps, { threadId: "t", provider: "p", drafts: [{ source: "reply", text: "é😀" }] });
    expect(ref.bytes).toBe(6);
  });

  it("records nothing, and attaches nothing, for no drafts or blank text", () => {
    const { events, attached, deps } = setup();
    expect(recordContextInjections(deps, { threadId: "t", provider: "p", drafts: [] })).toEqual([]);
    expect(recordContextInjections(deps, { threadId: "t", provider: "p", drafts: [{ source: "skill", text: "  \n " }] })).toEqual([]);
    expect(events).toEqual([]);
    expect(attached).toEqual([]);
  });

  it("caps how many one turn records", () => {
    const { events, deps } = setup();
    const drafts = Array.from({ length: MAX_CONTEXT_INJECTIONS_PER_TURN + 4 }, (_, i) => ({ source: "skill" as const, text: `skill ${i}` }));
    const refs = recordContextInjections(deps, { threadId: "t", provider: "p", drafts });
    expect(refs).toHaveLength(MAX_CONTEXT_INJECTIONS_PER_TURN);
    expect(events).toHaveLength(MAX_CONTEXT_INJECTIONS_PER_TURN);
  });

  it("never carries a credential in a preview", () => {
    const { events, deps } = setup();
    recordContextInjections(deps, { threadId: "t", provider: "p", drafts: [{ source: "memory", text: `api key ${SECRET}` }] });
    const event = events[0] as Extract<RuntimeEvent, { type: "context.injected" }>;
    expect(event.preview).not.toContain(SECRET);
  });

  it("can never fail a turn", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refs = recordContextInjections(
      {
        publish: () => {
          throw new Error("bus down");
        },
        attach: () => undefined,
      },
      { threadId: "t", provider: "p", drafts: [{ source: "memory", text: "x" }] },
    );
    expect(refs).toEqual([]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
