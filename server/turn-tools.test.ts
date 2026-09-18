import { describe, expect, it } from "vitest";
import { buildTurnTools } from "./turn-tools.ts";
import { httpToolDefinitions } from "./tools/registry.ts";

describe("buildTurnTools", () => {
  it("returns an empty array when no integrations are enabled", () => {
    expect(buildTurnTools({})).toEqual([]);
  });

  it("returns the agents tools when integrations.agents is set", () => {
    const tools = buildTurnTools({ agents: { section: "ops" } });
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_bots");
    expect(names).toContain("ask_bot");
  });

  it("marks ask_bot as requiring both bot_id and task", () => {
    const tools = buildTurnTools({ agents: {} });
    const askBot = tools.find((t) => t.name === "ask_bot");
    expect(askBot).toBeDefined();
    expect(askBot?.parameters?.required).toEqual(["bot_id", "task"]);
  });

  it("renders the registry rather than a second set of definitions", () => {
    // The catalog used to be written out longhand here, which is how the
    // HTTP lane's `list_bots` came to describe itself differently from the
    // MCP lane's.  This file is a shim now; the records live in the registry.
    expect(buildTurnTools({ agents: {} })).toEqual(
      httpToolDefinitions({
        agents: true,
        commsDepth: 0,
        maxCommsDepth: Number.POSITIVE_INFINITY,
        chiefOfStaff: false,
      }),
    );
  });

  it("offers the read-only list_routines alongside the peer-comms tools", () => {
    expect(buildTurnTools({ agents: {} }).map((t) => t.name)).toContain("list_routines");
  });

  it("applies the recursion ceiling when the caller passes real numbers", () => {
    const capped = buildTurnTools({ agents: {} }, { commsDepth: 1, maxCommsDepth: 1 });
    const names = capped.map((t) => t.name);
    // The peer-hop tools drop at the ceiling; the read/write tools that are
    // not a hop (list_routines, and PR 7's request_credential and the two
    // routine-proposal tools — create_bot excluded here since chiefOfStaff
    // is false) do not.
    expect(names).not.toContain("list_bots");
    expect(names).not.toContain("ask_bot");
    expect(names).not.toContain("delegate_bot");
    expect(names).toEqual(["request_credential", "list_routines", "propose_routine", "propose_routine_action"]);
  });

  it("does not expose Composio or computer-use tools on the HTTP lane", () => {
    const tools = buildTurnTools({ agents: {} });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("COMPOSIO_SEARCH_TOOLS");
    expect(names).not.toContain("COMPOSIO_GET_TOOL_SCHEMAS");
    expect(names).not.toContain("COMPOSIO_MULTI_EXECUTE_TOOL");
    expect(names).not.toContain("computer_screenshot");
    expect(names).not.toContain("computer_click");
    expect(names).not.toContain("computer_type");
  });

  it("exposes host computer tools (bash, read_file, write_file, edit_file) when localComputer is set", () => {
    const tools = buildTurnTools({ agents: {}, localComputer: true });
    const names = tools.map((t) => t.name);
    expect(names).toContain("bash");
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
  });

  it("exposes workspace file tools (read_file, write_file, edit_file) but not bash when workspace is set", () => {
    const tools = buildTurnTools({ agents: {}, workspace: true });
    const names = tools.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    expect(names).not.toContain("bash");
  });

  it("does not expose fleet recall, phone, or github tools by default", () => {
    const tools = buildTurnTools({ agents: {}, localComputer: true, workspace: true });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("recall_search");
    expect(names).not.toContain("phone_status");
  });

  it("exposes fleet recall tools when recall is set", () => {
    const tools = buildTurnTools({ agents: {}, recall: true });
    const names = tools.map((t) => t.name);
    expect(names).toContain("recall_search");
    expect(names).toContain("recall_contribute");
    expect(names).toContain("recall_stats");
  });

  it("exposes phone tools when phone is set", () => {
    const tools = buildTurnTools({ agents: {}, phone: true });
    const names = tools.map((t) => t.name);
    expect(names).toContain("phone_status");
    expect(names).toContain("phone_read_screen");
    expect(names).toContain("phone_tap");
    expect(names).not.toContain("phone_screenshot");
  });

  it("exposes github tools when localComputer is set, riding the same grant as bash", () => {
    const tools = buildTurnTools({ agents: {}, localComputer: true });
    const names = tools.map((t) => t.name);
    expect(names).toContain("github_clone");
    expect(names).toContain("github_pr_create");
  });

  it("does not expose github tools from workspace alone, without localComputer", () => {
    const tools = buildTurnTools({ agents: {}, workspace: true });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("github_clone");
  });
});
