import { describe, expect, it } from "vitest";

import { chiefOfStaffSystemPrompt } from "./chief-of-staff.ts";

// A CLI-shaped bot's tool set: the registry's three plus the five
// `agents-proxy.ts` still splices in ahead of their PR 7 registry entries.
const CLI_AGENT_TOOLS = [
  "list_bots",
  "ask_bot",
  "list_routines",
  "create_bot",
  "delegate_bot",
  "request_credential",
  "propose_routine",
  "propose_routine_action",
];
// A MiniMax-shaped bot's tool set: the registry's HTTP-surface tools only —
// no create_bot / delegate_bot, because those are not registry entries yet.
const MINIMAX_AGENT_TOOLS = ["list_bots", "ask_bot", "list_routines"];

describe("chiefOfStaffSystemPrompt roster caps", () => {
  it("clips oversized persona fields instead of interpolating them whole", () => {
    const prompt = chiefOfStaffSystemPrompt(
      "chief",
      [
        { id: "chief", name: "Atlas" },
        {
          id: "big",
          name: "N".repeat(500),
          title: "T".repeat(500),
          description: "D".repeat(10_000),
        },
      ],
      CLI_AGENT_TOOLS,
    );
    // an imported 10KB description must not ride into the Chief's system
    // prompt — the roster line stays bounded
    const rosterLine = prompt.split("\n").find((line) => line.startsWith("- N"))!;
    expect(rosterLine.length).toBeLessThan(500);
    expect(rosterLine).toContain("…");
  });

  it("caps the roster length and says how many were left out", () => {
    const team = Array.from({ length: 60 }, (_, i) => ({ id: `bot${i}`, name: `Bot ${i}` }));
    const prompt = chiefOfStaffSystemPrompt("chief", [{ id: "chief", name: "Atlas" }, ...team], CLI_AGENT_TOOLS);
    expect(prompt).toContain("Bot 39");
    expect(prompt).not.toContain("Bot 40 —");
    expect(prompt).toContain("…and 20 more");
  });
});

describe("chiefOfStaffSystemPrompt", () => {
  const bots = [
    { id: "chief", name: "Atlas", title: "Operations", section: "Work" },
    { id: "writer", name: "Quill", title: "Writer", description: "Drafts concise copy", section: "Work" },
    { id: "coder", name: "Patch", title: "Engineer", busy: true, section: "Work" },
    { id: "hidden", name: "Secret", hidden: true, section: "Work" },
    { id: "personal", name: "Scout", title: "Travel planner", section: "Personal" },
  ];

  it("describes visible teammates and roles, and defers availability to list_bots", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, CLI_AGENT_TOOLS);

    expect(prompt).toContain("Chief of Staff for the Work section");
    expect(prompt).toContain("Quill — Writer: Drafts concise copy");
    expect(prompt).toContain("Patch — Engineer");
    // who is FREE is a live fact and belongs to list_bots, not to a string
    // that is part of the Claude driver's spawn fingerprint
    expect(prompt).not.toContain("working right now");
    expect(prompt).not.toContain("(available)");
    expect(prompt).toContain("Use list_bots to confirm the live roster, IDs, and who is busy right now");
    expect(prompt).not.toContain("Secret");
    expect(prompt).not.toContain("Scout");
    expect(prompt).not.toContain("Atlas —");
    expect(prompt).toContain("Use ask_bot");
    expect(prompt).toContain("use create_bot");
  });

  // DR1: `turn.system` is passed to the Claude CLI as --append-system-prompt
  // and hashed into `argsKey`, the spawn fingerprint that decides whether the
  // Chief's warm process survives to take the next turn.  A teammate merely
  // becoming busy must not move it; a teammate joining, leaving, or being
  // re-roled must.
  describe("spawn-fingerprint stability", () => {
    const withBusy = (busy: Record<string, boolean>) =>
      bots.map((bot) => ({ ...bot, busy: busy[bot.id] ?? false }));

    it("is byte-identical across a teammate's busy flip", () => {
      const idle = chiefOfStaffSystemPrompt("chief", withBusy({}), CLI_AGENT_TOOLS);
      const working = chiefOfStaffSystemPrompt("chief", withBusy({ coder: true }), CLI_AGENT_TOOLS);
      const allWorking = chiefOfStaffSystemPrompt(
        "chief",
        withBusy({ coder: true, writer: true }),
        CLI_AGENT_TOOLS,
      );

      expect(working).toBe(idle);
      expect(allWorking).toBe(idle);
    });

    it("changes when the team's membership or roles change", () => {
      const baseline = chiefOfStaffSystemPrompt("chief", bots, CLI_AGENT_TOOLS);

      const joined = chiefOfStaffSystemPrompt(
        "chief",
        [...bots, { id: "new", name: "Ledger", title: "Analyst", section: "Work" }],
        CLI_AGENT_TOOLS,
      );
      const left = chiefOfStaffSystemPrompt(
        "chief",
        bots.filter((bot) => bot.id !== "coder"),
        CLI_AGENT_TOOLS,
      );
      const rerolled = chiefOfStaffSystemPrompt(
        "chief",
        bots.map((bot) => (bot.id === "coder" ? { ...bot, title: "Principal Engineer" } : bot)),
        CLI_AGENT_TOOLS,
      );

      expect(joined).not.toBe(baseline);
      expect(left).not.toBe(baseline);
      expect(rerolled).not.toBe(baseline);
    });
  });

  it("does not promise delegation when the engine cannot mount agent tools", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, []);

    expect(prompt).toContain("cannot contact teammates");
    expect(prompt).not.toContain("Use ask_bot");
  });

  it("offers ask_bot but not create_bot/delegate_bot for a MiniMax-shaped tool set", () => {
    // MiniMax's HTTP catalog is the registry's three tools only —
    // create_bot and delegate_bot are still MCP-only splices (PR 7 gives
    // them registry entries). Telling a MiniMax Chief it can "use
    // create_bot" would name a tool its turn cannot call.
    const prompt = chiefOfStaffSystemPrompt("chief", bots, MINIMAX_AGENT_TOOLS);

    expect(prompt).toContain("Use ask_bot");
    expect(prompt).not.toContain("create_bot");
    expect(prompt).not.toContain("delegate_bot");
    expect(prompt).not.toContain("cannot contact teammates");
  });

  it("includes trusted BotFleet status only when the Chief caller supplies it", () => {
    const status = "TRUSTED BOTFLEET STATUS\nfreshness=fresh; runtime_state=degraded";

    const chiefPrompt = chiefOfStaffSystemPrompt("chief", bots, CLI_AGENT_TOOLS, status);
    const ordinaryPrompt = chiefOfStaffSystemPrompt("writer", bots, CLI_AGENT_TOOLS);

    expect(chiefPrompt).toContain(status);
    expect(ordinaryPrompt).not.toContain("TRUSTED BOTFLEET STATUS");
  });
});
