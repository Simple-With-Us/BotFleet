import { describe, expect, it } from "vitest";

import { boundNativeTranscript, boundRoomContextLines, buildTurnContext, engineIsFresh } from "./turn-context.ts";

const transcript = [
  { role: "user" as const, text: "my dog is named Biscuit" },
  { role: "assistant" as const, text: "Noted — Biscuit." },
];

describe("boundNativeTranscript", () => {
  it("keeps ordinary replay unchanged", () => {
    expect(boundNativeTranscript(transcript)).toBe(transcript);
  });

  it("keeps recent complete turns and marks older history as omitted", () => {
    const history = [
      { role: "user" as const, text: "old".repeat(50 * 1024) },
      { role: "assistant" as const, text: "recent assistant" },
      { role: "user" as const, text: "recent user" },
    ];
    const bounded = boundNativeTranscript(history);
    expect(bounded.map((entry) => entry.text)).toEqual([
      "[Earlier conversation omitted for length]",
      "recent assistant",
      "recent user",
    ]);
    expect(bounded[0].role).toBe("user");
  });

  it("clips one oversized newest turn at a UTF-8 boundary", () => {
    const bounded = boundNativeTranscript([{ role: "assistant", text: "é".repeat(100 * 1024) }]);
    expect(bounded).toHaveLength(2);
    expect(bounded[1].text).not.toContain("\uFFFD");
    expect(bounded[1].text.length).toBeLessThan(100 * 1024);
    expect(Buffer.byteLength(bounded.map((entry) => entry.text).join(""), "utf8")).toBeLessThanOrEqual(128 * 1024);
  });
});

describe("boundRoomContextLines", () => {
  it("preserves short room conversations", () => {
    expect(boundRoomContextLines(["User: hello", "Bot: hi"])).toBe("User: hello\nBot: hi");
  });

  it("omits a huge prior room message while retaining the newest request", () => {
    const current = "User: answer my latest question";
    const bounded = boundRoomContextLines(["Bot: " + "x".repeat(200 * 1024), current]);
    expect(bounded).toBe(`[Earlier conversation omitted for length]\n${current}`);
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThan(128 * 1024);
  });

  it("keeps a deliberately large current room request intact", () => {
    const current = "User: " + "z".repeat(200 * 1024);
    expect(boundRoomContextLines(["Bot: older", current])).toBe(`[Earlier conversation omitted for length]\n${current}`);
  });

  it("clips the newest stored line when a card continuation is the current prompt", () => {
    const prior = "Bot: " + "é".repeat(100 * 1024);
    const bounded = boundRoomContextLines(["User: older", prior], false);
    expect(bounded).toContain("[Earlier conversation omitted for length]");
    expect(bounded).not.toContain("User: older");
    expect(bounded).not.toContain("\uFFFD");
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(128 * 1024);
  });
});

describe("buildTurnContext", () => {
  it("passes text through untouched on a plain resumed turn", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: false, fresh: false, replaysNatively: false });
    expect(out).toEqual({ turnText: "hi", resume: true });
  });

  it("replays inline on rewind, exactly like the existing behaviour", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: true, fresh: false, replaysNatively: false });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("rewound this conversation");
    expect(out.turnText).toContain("User: my dog is named Biscuit");
    expect(out.turnText.endsWith("hi")).toBe(true);
  });

  it("replays inline for a fresh engine with prior history — the model-switch fix", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: false, fresh: true, replaysNatively: false });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("joining this conversation");
    expect(out.turnText).not.toContain("rewound"); // distinct marker, distinct preamble
    expect(out.turnText).toContain("Assistant: Noted — Biscuit.");
    expect(out.turnText.endsWith("hi")).toBe(true);
  });

  it("never wraps for native-replay drivers — they get history via SendTurnInput.transcript", () => {
    for (const flags of [{ rewound: true, fresh: false }, { rewound: false, fresh: true }]) {
      const out = buildTurnContext({ text: "hi", transcript, ...flags, replaysNatively: true });
      expect(out.turnText).toBe("hi");
    }
  });

  it("does not wrap a fresh engine on an empty thread — nothing to replay", () => {
    const out = buildTurnContext({ text: "hi", transcript: [], rewound: false, fresh: true, replaysNatively: false });
    expect(out).toEqual({ turnText: "hi", resume: false });
  });

  it("caps oversized transcripts to 128KB, keeping recent messages and marking omission", () => {
    const hugeTranscript = [
      { role: "user" as const, text: "A".repeat(80 * 1024) },
      { role: "assistant" as const, text: "B".repeat(80 * 1024) },
      { role: "user" as const, text: "most recent user turn" },
    ];
    const out = buildTurnContext({ text: "hi", transcript: hugeTranscript, rewound: false, fresh: true, replaysNatively: false });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("[Earlier conversation omitted for length]");
    expect(out.turnText).toContain("most recent user turn");
    expect(out.turnText).not.toContain("A".repeat(80 * 1024));
    expect(Buffer.byteLength(out.turnText, "utf8")).toBeLessThan(130 * 1024);
  });

  it("clips a single entry that alone exceeds the cap instead of replaying it whole", () => {
    const oneHugeEntry = [{ role: "user" as const, text: "A".repeat(200 * 1024) }];
    const out = buildTurnContext({ text: "hi", transcript: oneHugeEntry, rewound: false, fresh: true, replaysNatively: false });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("[Earlier conversation omitted for length]");
    expect(out.turnText).not.toContain("A".repeat(200 * 1024));
    expect(Buffer.byteLength(out.turnText, "utf8")).toBeLessThan(132 * 1024);
  });

  it("never splits a multi-byte character when clipping an oversized entry", () => {
    const oneHugeEntry = [{ role: "user" as const, text: "é".repeat(100 * 1024) }];
    const out = buildTurnContext({ text: "hi", transcript: oneHugeEntry, rewound: false, fresh: true, replaysNatively: false });
    expect(out.turnText).not.toContain("\uFFFD");
    expect(Buffer.byteLength(out.turnText, "utf8")).toBeLessThan(132 * 1024);
  });

  describe("the chat-completions capabilities.replaysTranscript contract", () => {
    // index.ts derives `replaysNatively` from
    // `instance.adapter.capabilities.replaysTranscript === true` rather than
    // from `driverKind === "grok"`. minimax, openai-compat and grok all
    // declare that capability because their driver already rebuilds the
    // message history from SendTurnInput.transcript every round — so
    // inlining the same history here as well would send it twice. A CLI
    // driver never declares it, so its path (inline replay on rewind/fresh)
    // must stay exactly as it is today.
    it("a chat-completions driver (replaysTranscript: true) never gets the transcript inlined", () => {
      for (const flags of [{ rewound: true, fresh: false }, { rewound: false, fresh: true }]) {
        const out = buildTurnContext({ text: "hi", transcript, ...flags, replaysNatively: true });
        expect(out.turnText).toBe("hi");
        expect(out.turnText).not.toContain("Biscuit");
      }
    });

    it("a CLI driver's path (no replaysTranscript capability) is unchanged: still inlined", () => {
      const rewoundOut = buildTurnContext({ text: "hi", transcript, rewound: true, fresh: false, replaysNatively: false });
      expect(rewoundOut.turnText).toContain("User: my dog is named Biscuit");
      const freshOut = buildTurnContext({ text: "hi", transcript, rewound: false, fresh: true, replaysNatively: false });
      expect(freshOut.turnText).toContain("Assistant: Noted — Biscuit.");
    });
  });
});

describe("engineIsFresh", () => {
  const withUser = transcript;
  const greetingOnly = [{ role: "assistant" as const, text: "Hey — I'm Wren. Nice to meet you." }];

  it("is false when the same instance ran the last turn and has a cursor", () => {
    expect(engineIsFresh({ instanceId: "claude", lastInstanceId: "claude", resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(false);
  });

  it("is true when the same instance ran last but there is no cursor to resume", () => {
    expect(engineIsFresh({ instanceId: "pi", lastInstanceId: "pi", resumeCursors: {}, transcript: withUser })).toBe(true);
  });

  it("is true when another instance ran the last turn — even if this one has an older cursor", () => {
    // the user's bug: claude had a session from days ago, antigravity took the
    // latest turn, switching back to claude must NOT resume the stale session
    expect(
      engineIsFresh({ instanceId: "claude", lastInstanceId: "antigravity", resumeCursors: { claude: "old", antigravity: "s2" }, transcript: withUser }),
    ).toBe(true);
  });

  it("is true for an instance that has never run this thread", () => {
    expect(engineIsFresh({ instanceId: "codex", lastInstanceId: "claude", resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(true);
  });

  it("is false on a brand-new bot: the seeded greeting alone is nothing to join", () => {
    expect(engineIsFresh({ instanceId: "claude", lastInstanceId: undefined, resumeCursors: {}, transcript: greetingOnly })).toBe(false);
    expect(engineIsFresh({ instanceId: "claude", lastInstanceId: undefined, resumeCursors: {}, transcript: [] })).toBe(false);
  });

  it("legacy task without lastInstanceId: trusts a lone cursor for this instance, replays otherwise", () => {
    // one cursor, ours — pre-upgrade single-engine thread, keep resuming
    expect(engineIsFresh({ instanceId: "claude", lastInstanceId: undefined, resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(false);
    // one cursor, someone else's — we never ran here
    expect(engineIsFresh({ instanceId: "codex", lastInstanceId: undefined, resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(true);
    // two cursors — can't tell who ran last; replaying is the safe side
    expect(
      engineIsFresh({ instanceId: "claude", lastInstanceId: undefined, resumeCursors: { claude: "s1", antigravity: "s2" }, transcript: withUser }),
    ).toBe(true);
  });
});
