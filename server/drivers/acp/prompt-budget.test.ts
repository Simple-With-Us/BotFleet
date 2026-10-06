import { describe, expect, it } from "vitest";

import { buildTurnContext, ROOM_REPLY_PREFIX, TURN_REPLY_CUE } from "../../turn-context.ts";
import {
  ACP_PROMPT_SECTION_OMITTED,
  applyAcpPromptBudget,
  decodeAcpPromptBudgetBytes,
  DEFAULT_ACP_PROMPT_BUDGET_BYTES,
  MAX_ACP_PROMPT_BUDGET_BYTES,
  resolveAcpPromptBudgetBytes,
  type AcpPromptSection,
} from "./prompt-budget.ts";

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function compose(system: string, userText: string): string {
  return system ? `${system}\n\n${userText}` : userText;
}

const stable = "STABLE-BLOCK ";
const volOld = `VOLATILE-OLD ${"alpha ".repeat(40)}`;
const volNew = `VOLATILE-NEW ${"beta ".repeat(40)}`;
const historyOld = `User: ${"ancient ".repeat(40)}`;
const historyNew = `Assistant: ${"recent ".repeat(40)}`;
const current = "CURRENT USER MESSAGE";

function sections(): AcpPromptSection[] {
  return [
    { id: "persona", text: stable, volatile: false },
    { id: "memory", text: volOld, volatile: true },
    { id: "skills", text: "SKILLS-INDEX ", volatile: false },
    { id: "mentions", text: volNew, volatile: true },
  ];
}

function userText(): string {
  return `${historyOld}\n${historyNew}\n\n${TURN_REPLY_CUE}\n\n${current}`;
}

function prompt(): { composed: string; userText: string; sections: AcpPromptSection[] } {
  const listed = sections();
  const user = userText();
  return {
    composed: compose(listed.map((section) => section.text).join(""), user),
    userText: user,
    sections: listed,
  };
}

describe("applyAcpPromptBudget", () => {
  it("leaves an under-budget prompt unchanged", () => {
    const input = prompt();
    const result = applyAcpPromptBudget({ ...input, budgetBytes: bytes(input.composed) });
    expect(result.text).toBe(input.composed);
    expect(result.trimmed).toBe(false);
    expect(result.before).toEqual(result.after);
    expect(result.before.stable).toBe(bytes(stable + "SKILLS-INDEX "));
    expect(result.before.volatile).toBeGreaterThan(bytes(volOld + volNew));
  });

  it("is a no-op for a real replay that fits, including the reply cue", () => {
    const listed = sections();
    const system = listed.map((section) => section.text).join("");
    const { turnText } = buildTurnContext({
      text: "what is my dog called?",
      transcript: [
        { role: "user", text: "my dog is named Biscuit" },
        { role: "assistant", text: "Noted — Biscuit." },
      ],
      rewound: false,
      fresh: true,
      replaysNatively: false,
    });
    const composed = compose(system, turnText);
    const result = applyAcpPromptBudget({
      composed,
      sections: listed,
      userText: turnText,
      budgetBytes: DEFAULT_ACP_PROMPT_BUDGET_BYTES,
    });
    expect(result.text).toBe(composed);
    expect(result.trimmed).toBe(false);
    expect(result.text).toContain(TURN_REPLY_CUE);
    expect(result.text.endsWith("what is my dog called?")).toBe(true);
  });

  it("drops the oldest history section before a newer one, and history before volatile sections", () => {
    const input = prompt();
    const system = stable + volOld + "SKILLS-INDEX " + volNew;
    const droppedOldest = compose(system, `${ACP_PROMPT_SECTION_OMITTED}\n${historyNew}\n\n${TURN_REPLY_CUE}\n\n${current}`);

    const oldestOnly = applyAcpPromptBudget({ ...input, budgetBytes: bytes(droppedOldest) });
    expect(oldestOnly.text).toBe(droppedOldest);
    expect(oldestOnly.trimmed).toBe(true);
    expect(oldestOnly.text).not.toContain("ancient");
    expect(oldestOnly.text).toContain("recent");
    expect(oldestOnly.text).toContain("VOLATILE-OLD");
    expect(oldestOnly.text).toContain("VOLATILE-NEW");
    expect(oldestOnly.before.stable).toBe(oldestOnly.after.stable);

    const droppedBothHistory = compose(
      system,
      `${ACP_PROMPT_SECTION_OMITTED}\n${ACP_PROMPT_SECTION_OMITTED}\n\n${TURN_REPLY_CUE}\n\n${current}`,
    );
    const bothHistory = applyAcpPromptBudget({ ...input, budgetBytes: bytes(droppedBothHistory) });
    expect(bothHistory.text).toBe(droppedBothHistory);
    expect(bothHistory.text).not.toContain("ancient");
    expect(bothHistory.text).not.toContain("recent");
    expect(bothHistory.text).toContain("VOLATILE-OLD");
    expect(bothHistory.text).toContain("VOLATILE-NEW");

    const droppedVolatileToo = compose(
      stable + ACP_PROMPT_SECTION_OMITTED + "SKILLS-INDEX " + volNew,
      `${ACP_PROMPT_SECTION_OMITTED}\n${ACP_PROMPT_SECTION_OMITTED}\n\n${TURN_REPLY_CUE}\n\n${current}`,
    );
    const volatileToo = applyAcpPromptBudget({ ...input, budgetBytes: bytes(droppedVolatileToo) });
    expect(volatileToo.text).toBe(droppedVolatileToo);
    expect(volatileToo.text).not.toContain("VOLATILE-OLD");
    expect(volatileToo.text).toContain("VOLATILE-NEW");
    expect(volatileToo.text.startsWith(stable)).toBe(true);
    expect(volatileToo.text.endsWith(current)).toBe(true);
  });

  it("replaces a trimmed section with one line and keeps the stable block and the current message", () => {
    const input = prompt();
    const result = applyAcpPromptBudget({ ...input, budgetBytes: 1 });
    expect(ACP_PROMPT_SECTION_OMITTED).not.toMatch(/\n/);
    expect(result.text.split("\n")).toContain(ACP_PROMPT_SECTION_OMITTED);
    expect(result.text).not.toContain("ancient");
    expect(result.text).not.toContain("recent");
    expect(result.text).not.toContain("VOLATILE-OLD");
    expect(result.text).not.toContain("VOLATILE-NEW");
    expect(result.text.startsWith(stable)).toBe(true);
    expect(result.text).toContain("SKILLS-INDEX ");
    expect(result.text.endsWith(current)).toBe(true);
    expect(result.text).toContain(TURN_REPLY_CUE);
    expect(result.trimmed).toBe(true);
    expect(result.after.volatile).toBeLessThan(result.before.volatile);
    expect(result.after.stable).toBe(result.before.stable);
  });

  it("does not trim a current user message that has no replay cue, however long it is", () => {
    const user = `please keep ${"x".repeat(8_000)}`;
    const listed: AcpPromptSection[] = [{ id: "persona", text: stable, volatile: false }];
    const composed = compose(stable, user);
    const result = applyAcpPromptBudget({
      composed,
      sections: listed,
      userText: user,
      budgetBytes: 32,
    });
    expect(result.text).toBe(composed);
    expect(result.trimmed).toBe(false);
  });

  it("counts UTF-8 bytes, so a multibyte volatile section over a char-sized budget is trimmed", () => {
    const volatile = "é".repeat(80);
    const listed: AcpPromptSection[] = [
      { id: "persona", text: "S", volatile: false },
      { id: "memory", text: volatile, volatile: true },
    ];
    const user = "hi";
    const composed = compose(`S${volatile}`, user);
    // 80 chars would fit a 100-char reading.  160 bytes do not fit a 100-byte ceiling
    // once the stable block, bridge, and user message are included.
    expect(volatile.length).toBe(80);
    expect(bytes(volatile)).toBe(160);
    const result = applyAcpPromptBudget({
      composed,
      sections: listed,
      userText: user,
      budgetBytes: 100,
    });
    expect(result.trimmed).toBe(true);
    expect(result.text).not.toContain("é");
    expect(result.text).toContain(ACP_PROMPT_SECTION_OMITTED);
    expect(result.text.startsWith("S")).toBe(true);
    expect(result.text.endsWith("hi")).toBe(true);
  });

  it("disables trimming when the budget is null or zero", () => {
    const input = prompt();
    for (const budgetBytes of [null, 0]) {
      const result = applyAcpPromptBudget({ ...input, budgetBytes });
      expect(result.text).toBe(input.composed);
      expect(result.trimmed).toBe(false);
      expect(result.before).toEqual(result.after);
    }
  });

  it("keeps an unsegmented system prefix whole and still trims replayed history", () => {
    const input = prompt();
    const result = applyAcpPromptBudget({
      composed: input.composed,
      sections: [{ id: "persona", text: "not the real system", volatile: true }],
      userText: input.userText,
      budgetBytes: 1,
    });
    // The system prefix is kept whole (it could not be segmented).  History
    // still has real boundaries, so the oldest history section can go.
    expect(result.text.startsWith(stable)).toBe(true);
    expect(result.text).toContain("VOLATILE-OLD");
    expect(result.text).not.toContain("ancient");
    expect(result.text).toContain(ACP_PROMPT_SECTION_OMITTED);
    expect(result.text.endsWith(current)).toBe(true);
  });

  it("uses the harness inline reply delimiter so a quoted cue in the current message stays protected", () => {
    const listed = sections();
    const system = listed.map((section) => section.text).join("");
    const userText = [
      "User: earlier turn",
      "",
      TURN_REPLY_CUE,
      "",
      `Please explain what ${TURN_REPLY_CUE} means`,
    ].join("\n");
    const composed = compose(system, userText);
    const result = applyAcpPromptBudget({
      composed,
      sections: listed,
      userText,
      budgetBytes: bytes(composed) - bytes("User: earlier turn\n"),
    });
    expect(result.trimmed).toBe(true);
    expect(result.text).toContain(`Please explain what ${TURN_REPLY_CUE} means`);
    expect(result.text).not.toMatch(/explain what.*omitted/s);
    expect(result.text.endsWith(`Please explain what ${TURN_REPLY_CUE} means`)).toBe(true);
  });

  it("uses the last inline reply cue so payload text cannot become trimmable history", () => {
    const listed = sections();
    const system = listed.map((section) => section.text).join("");
    const userText = [
      "User: earlier turn",
      `User: quoted ${TURN_REPLY_CUE} inside the message`,
      "",
      TURN_REPLY_CUE,
      "",
      "final question",
    ].join("\n");
    const composed = compose(system, userText);
    const result = applyAcpPromptBudget({
      composed,
      sections: listed,
      userText,
      budgetBytes: bytes(composed) - bytes("User: earlier turn\n"),
    });
    expect(result.trimmed).toBe(true);
    expect(result.text).toContain(`quoted ${TURN_REPLY_CUE} inside`);
    expect(result.text.endsWith("final question")).toBe(true);
    expect(result.text).toContain(TURN_REPLY_CUE);
  });

  it("uses the harness room reply line so cardContinuation cannot become trimmable history", () => {
    const listed: AcpPromptSection[] = [{ id: "persona", text: stable, volatile: false }];
    const oldLine = `Jay: ${"ancient ".repeat(80)}`;
    const recentLine = "Bot: recent";
    const harnessLine = `${ROOM_REPLY_PREFIX}Scout.)`;
    const continuation = `Card body quoting ${harnessLine} verbatim`;
    const userText = `${oldLine}\n${recentLine}\n\n${harnessLine}\n\n${continuation}`;
    const composed = compose(stable, userText);
    const result = applyAcpPromptBudget({
      composed,
      sections: listed,
      userText,
      budgetBytes: bytes(composed) - bytes(`${oldLine}\n`),
    });
    expect(result.trimmed).toBe(true);
    expect(result.text).toContain(continuation);
    expect(result.text.endsWith(continuation)).toBe(true);
    expect(result.text).toContain(harnessLine);
  });

  it("preserves blank lines in room context so render matches the composed prompt", () => {
    const listed: AcpPromptSection[] = [{ id: "persona", text: stable, volatile: false }];
    const userText = `Jay: first\n\nBot: second\n\n${ROOM_REPLY_PREFIX}Scout.)`;
    const composed = compose(stable, userText);
    const result = applyAcpPromptBudget({
      composed,
      sections: listed,
      userText,
      budgetBytes: DEFAULT_ACP_PROMPT_BUDGET_BYTES,
    });
    expect(result.text).toBe(composed);
    expect(result.trimmed).toBe(false);
  });

  it("does not trim harness preambles or OMITTED_HISTORY; only User and Assistant turns are history", () => {
    const listed = sections();
    const system = listed.map((section) => section.text).join("");
    const { turnText } = buildTurnContext({
      text: "what is my dog called?",
      transcript: [
        { role: "user", text: "my dog is named Biscuit" },
        { role: "assistant", text: "Noted — Biscuit." },
      ],
      rewound: false,
      fresh: true,
      replaysNatively: false,
    });
    const composed = compose(system, turnText);
    const dropOldestOnly = applyAcpPromptBudget({
      composed,
      sections: listed,
      userText: turnText,
      budgetBytes: bytes(composed) - bytes("User: my dog is named Biscuit\n"),
    });
    expect(dropOldestOnly.trimmed).toBe(true);
    expect(dropOldestOnly.text).toContain("joining this conversation mid-thread");
    expect(dropOldestOnly.text).not.toMatch(/joining.*omitted/s);
    expect(dropOldestOnly.text).not.toContain("my dog is named Biscuit");
    expect(dropOldestOnly.text).toContain("Noted — Biscuit");
    expect(dropOldestOnly.text.endsWith("what is my dog called?")).toBe(true);
  });

  it("keeps the newest room line in the protected current suffix, not trimmable history", () => {
    const listed: AcpPromptSection[] = [{ id: "persona", text: stable, volatile: false }];
    const oldLine = `Jay: ${"ancient ".repeat(300)}`;
    const recentLine = "Bot: recent";
    const userText = `${oldLine}\n${recentLine}\n\n${ROOM_REPLY_PREFIX}Scout.)`;
    const composed = compose(stable, userText);
    const result = applyAcpPromptBudget({
      composed,
      sections: listed,
      userText,
      budgetBytes: 1,
    });
    expect(result.trimmed).toBe(true);
    expect(result.text).toContain(recentLine);
    expect(result.text).not.toContain("ancient");
    expect(result.text).toContain(`${ROOM_REPLY_PREFIX}Scout.)`);
  });

  it("trims the oldest room context line before volatile sections", () => {
    const listed: AcpPromptSection[] = [{ id: "persona", text: stable, volatile: false }];
    const oldLine = `Jay: ${"ancient ".repeat(300)}`;
    const recentLine = "Bot: recent";
    const userText = `${oldLine}\n${recentLine}\n\n${ROOM_REPLY_PREFIX}Scout.)`;
    const composed = compose(stable, userText);
    const target = compose(
      stable,
      `${ACP_PROMPT_SECTION_OMITTED}\n${recentLine}\n\n${ROOM_REPLY_PREFIX}Scout.)`,
    );
    const result = applyAcpPromptBudget({
      composed,
      sections: listed,
      userText,
      budgetBytes: bytes(target),
    });
    expect(result.text).toBe(target);
    expect(result.trimmed).toBe(true);
    expect(result.text).not.toContain("ancient");
    expect(result.text).toContain("recent");
    expect(result.text).toContain(`${ROOM_REPLY_PREFIX}Scout.)`);
  });
});

describe("decodeAcpPromptBudgetBytes", () => {
  it("accepts zero as disabled and a positive ceiling, and ignores the rest", () => {
    expect(decodeAcpPromptBudgetBytes(0)).toBe(0);
    expect(decodeAcpPromptBudgetBytes(4096)).toBe(4096);
    expect(decodeAcpPromptBudgetBytes(MAX_ACP_PROMPT_BUDGET_BYTES)).toBe(MAX_ACP_PROMPT_BUDGET_BYTES);
    expect(decodeAcpPromptBudgetBytes(undefined)).toBeUndefined();
    expect(decodeAcpPromptBudgetBytes(1.5)).toBeUndefined();
    expect(decodeAcpPromptBudgetBytes(-1)).toBeUndefined();
    expect(decodeAcpPromptBudgetBytes(MAX_ACP_PROMPT_BUDGET_BYTES + 1)).toBeUndefined();
    expect(decodeAcpPromptBudgetBytes("4096")).toBeUndefined();
    expect(resolveAcpPromptBudgetBytes(undefined)).toBe(DEFAULT_ACP_PROMPT_BUDGET_BYTES);
    expect(resolveAcpPromptBudgetBytes(0)).toBeNull();
    expect(resolveAcpPromptBudgetBytes(2048)).toBe(2048);
  });
});
