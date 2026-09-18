// The registry exists to make one kind of bug impossible: a tool described
// differently on the MCP lane than on the HTTP lane.  That drift is not
// hypothetical — `list_bots` shipped offering a bot its own row on one lane
// and not the other, and hiding `busy` on one lane and not the other, within
// a single PR.  These tests are the guard rail that would have caught it.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CREDENTIAL_TARGETS } from "../../shared/credential-request.ts";
import {
  CREDENTIAL_TARGET_IDS,
  HARNESS_TOOLS,
  MAX_CREATED_BOTS_PER_TURN,
  descriptionFor,
  harnessTool,
  httpToolDefinitions,
  mcpToolDefinitions,
  schemaFor,
  toolsFor,
  type ToolGateContext,
} from "./registry.ts";
import { createPhoneTools } from "./phone.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const gate = (over: Partial<ToolGateContext> = {}): ToolGateContext => ({
  agents: true,
  commsDepth: 0,
  maxCommsDepth: 1,
  chiefOfStaff: true,
  ...over,
});

describe("every record is complete", () => {
  it("has a name, a description, a schema, a surface set and a side-effect class", () => {
    expect(HARNESS_TOOLS.length).toBeGreaterThan(0);
    for (const tool of HARNESS_TOOLS) {
      expect(tool.name, "name").toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(20);
      expect(tool.schema.type, `${tool.name} schema`).toBe("object");
      expect(typeof tool.surfaces.mcp, `${tool.name} surfaces.mcp`).toBe("boolean");
      expect(typeof tool.surfaces.http, `${tool.name} surfaces.http`).toBe("boolean");
      expect(tool.surfaces.mcp || tool.surfaces.http, `${tool.name} is on no lane`).toBe(true);
      expect(["read", "write"], `${tool.name} sideEffect`).toContain(tool.sideEffect);
      expect(["immediate", "suspend"], `${tool.name} settles`).toContain(tool.settles);
      expect(typeof tool.gate, `${tool.name} gate`).toBe("function");
    }
  });

  it("names are unique and resolvable", () => {
    const names = HARNESS_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(harnessTool(name)?.name).toBe(name);
    expect(harnessTool("delete_everything")).toBeUndefined();
  });

  it("publishes no JSON-Schema composition keywords, which agent CLIs drop", () => {
    // A model that never saw the branches guesses shapes forever.
    for (const tool of HARNESS_TOOLS) {
      for (const surface of ["mcp", "http"] as const) {
        expect(JSON.stringify(schemaFor(tool, surface))).not.toMatch(
          /"oneOf"|"anyOf"|"allOf"|"const"/,
        );
      }
    }
  });

  it("keeps read tools free of an approval ask — only a write tool needs a card", () => {
    for (const tool of HARNESS_TOOLS) {
      if (tool.sideEffect === "read") {
        expect(tool.approval?.policy ?? "never", `${tool.name}`).toBe("never");
        expect(tool.settles, `${tool.name}`).toBe("immediate");
      }
    }
  });

  it("marks list_routines read-only", () => {
    const tool = harnessTool("list_routines");
    expect(tool).toBeDefined();
    expect(tool!.sideEffect).toBe("read");
    expect(tool!.settles).toBe("immediate");
    expect(tool!.approval).toBeUndefined();
  });
});

describe("both lanes derive from the same records", () => {
  it("describes explicit routine timezones consistently on both lanes", () => {
    const expected = "On update, omit it to preserve the routine's existing timezone";
    const schemas = [
      mcpToolDefinitions(gate()).find((tool) => tool.name === "propose_routine")!.inputSchema,
      httpToolDefinitions(gate()).find((tool) => tool.name === "propose_routine")!.parameters,
    ];
    for (const schema of schemas) {
      const timeZone = (schema.properties as any).schedule.properties.timeZone;
      expect(timeZone.description).toContain("IANA timezone");
      expect(timeZone.description).toContain(expected);
      expect(timeZone.description).toContain("interpret both time and weekdays");
      expect((schema.properties as any).schedule.properties.time.description).toContain("schedule.timeZone");
      expect((schema.properties as any).schedule.properties.weekdays.description).toContain("schedule.timeZone");
    }
  });

  it("cover the same name set for the same gate", () => {
    // THE drift test.  A tool added to one renderer and not the other fails
    // here rather than in a user's transcript six weeks later.
    for (const ctx of [gate(), gate({ chiefOfStaff: false }), gate({ commsDepth: 1 })]) {
      const mcp = mcpToolDefinitions(ctx).map((t) => t.name);
      const http = httpToolDefinitions(ctx).map((t) => t.name);
      expect(http).toEqual(mcp);
    }
  });

  it("render the SAME record, so the two lanes cannot describe a tool differently", () => {
    const mcp = new Map(mcpToolDefinitions(gate()).map((t) => [t.name, t]));
    const http = new Map(httpToolDefinitions(gate()).map((t) => [t.name, t]));
    for (const [name, def] of mcp) {
      const peer = http.get(name)!;
      const tool = harnessTool(name)!;
      // Any difference has to be a DECLARED deviation carrying a reason.
      // Undeclared drift is what this assertion makes impossible.
      if (!tool.wire?.mcp?.description && !tool.wire?.http?.description) {
        expect(peer.description, `${name} description`).toBe(def.description);
      }
      if (!tool.wire?.mcp?.schema && !tool.wire?.http?.schema) {
        expect(peer.parameters, `${name} schema`).toEqual(def.inputSchema);
      }
    }
  });

  it("requires a reason on every declared wire deviation", () => {
    for (const tool of HARNESS_TOOLS) {
      for (const surface of ["mcp", "http"] as const) {
        const deviation = tool.wire?.[surface];
        if (!deviation) continue;
        expect(deviation.reason.length, `${tool.name}/${surface} reason`).toBeGreaterThan(40);
        expect(deviation.description ?? deviation.schema, `${tool.name}/${surface}`).toBeDefined();
      }
    }
  });

  it("keeps ask_bot's two argument spellings in step — same required arity, one alias", () => {
    const tool = harnessTool("ask_bot")!;
    expect(schemaFor(tool, "mcp").required).toEqual(["bot_id", "message"]);
    expect(schemaFor(tool, "http").required).toEqual(["bot_id", "task"]);
    expect(schemaFor(tool, "http").required!.length).toBe(schemaFor(tool, "mcp").required!.length);
    expect(descriptionFor(tool, "mcp")).not.toBe(descriptionFor(tool, "http"));
  });

  it("declares no wire deviation for any of the five PR 7 tools — one schema, both lanes", () => {
    for (const name of [
      "delegate_bot",
      "create_bot",
      "request_credential",
      "propose_routine",
      "propose_routine_action",
    ]) {
      const tool = harnessTool(name)!;
      expect(tool.wire, name).toBeUndefined();
    }
  });
});

describe("request_credential's allowlist cannot drift from the real one", () => {
  // registry.ts cannot import `shared/credential-request.ts` (it must stay
  // import-free — see the last describe block), so it keeps its own copy of
  // the id list.  This is what keeps the copy honest.
  it("matches CREDENTIAL_TARGETS exactly", () => {
    expect([...CREDENTIAL_TARGET_IDS].sort()).toEqual(Object.keys(CREDENTIAL_TARGETS).sort());
  });

  it("is exactly the enum request_credential advertises on both lanes", () => {
    const tool = harnessTool("request_credential")!;
    const mcpEnum = (schemaFor(tool, "mcp").properties as any).credential_id.enum;
    const httpEnum = (schemaFor(tool, "http").properties as any).credential_id.enum;
    expect(mcpEnum).toEqual([...CREDENTIAL_TARGET_IDS]);
    expect(httpEnum).toEqual([...CREDENTIAL_TARGET_IDS]);
  });
});

describe("create_bot's per-turn cap", () => {
  it("is a small positive number both lanes can share", () => {
    expect(MAX_CREATED_BOTS_PER_TURN).toBeGreaterThan(0);
    expect(MAX_CREATED_BOTS_PER_TURN).toBeLessThanOrEqual(10);
  });
});

describe("gating", () => {
  it("offers nothing when the agents integration is absent", () => {
    const ctx = gate({ agents: false });
    expect(mcpToolDefinitions(ctx)).toEqual([]);
    expect(httpToolDefinitions(ctx)).toEqual([]);
  });

  it("drops the peer-comms tools at the recursion cap but keeps the rest", () => {
    const ctx = gate({ commsDepth: 1, maxCommsDepth: 1 });
    const names = mcpToolDefinitions(ctx).map((t) => t.name);
    expect(names).not.toContain("list_bots");
    expect(names).not.toContain("ask_bot");
    expect(names).not.toContain("delegate_bot");
    // None of these are a hop, so the ceiling does not apply to them.
    expect(names).toContain("list_routines");
    expect(names).toContain("create_bot");
    expect(names).toContain("request_credential");
    expect(names).toContain("propose_routine");
    expect(names).toContain("propose_routine_action");
  });

  it("gates only create_bot on chiefOfStaff", () => {
    // PR 7's deliberate edit: create_bot is the one tool a non-chief must
    // never see, and every other tool must be unaffected by the flag.
    const withChief = toolsFor("mcp", gate({ chiefOfStaff: true })).map((t) => t.name);
    const without = toolsFor("mcp", gate({ chiefOfStaff: false })).map((t) => t.name);
    expect(withChief.filter((name) => !without.includes(name))).toEqual(["create_bot"]);
    expect(without.filter((name) => !withChief.includes(name))).toEqual([]);
  });

  it("offers the full set to a depth-0 chief bot with comms on", () => {
    expect(mcpToolDefinitions(gate()).map((t) => t.name)).toEqual([
      "list_bots",
      "ask_bot",
      "delegate_bot",
      "create_bot",
      "request_credential",
      "list_routines",
      "propose_routine",
      "propose_routine_action",
    ]);
  });

  it("offers everything but create_bot to a depth-0 non-chief bot with comms on", () => {
    expect(mcpToolDefinitions(gate({ chiefOfStaff: false })).map((t) => t.name)).toEqual([
      "list_bots",
      "ask_bot",
      "delegate_bot",
      "request_credential",
      "list_routines",
      "propose_routine",
      "propose_routine_action",
    ]);
  });

  it("offers computer tools on HTTP lane when localComputer is enabled", () => {
    const withoutComputer = httpToolDefinitions(gate({ localComputer: false })).map((t) => t.name);
    expect(withoutComputer).not.toContain("bash");
    expect(withoutComputer).not.toContain("read_file");
    expect(withoutComputer).not.toContain("write_file");
    expect(withoutComputer).not.toContain("edit_file");

    const withComputer = httpToolDefinitions(gate({ localComputer: true })).map((t) => t.name);
    expect(withComputer).toContain("bash");
    expect(withComputer).toContain("read_file");
    expect(withComputer).toContain("write_file");
    expect(withComputer).toContain("edit_file");

    // Computer tools are on the HTTP surface only (CLI engines bring their own)
    const mcpWithComputer = mcpToolDefinitions(gate({ localComputer: true })).map((t) => t.name);
    expect(mcpWithComputer).not.toContain("bash");

    const withWorkspace = httpToolDefinitions(gate({ localComputer: false, workspace: true })).map((t) => t.name);
    expect(withWorkspace).not.toContain("bash");
    expect(withWorkspace).toContain("read_file");
    expect(withWorkspace).toContain("write_file");
    expect(withWorkspace).toContain("edit_file");
  });

  it("offers fleet recall tools on the HTTP surface only, gated on `recall`", () => {
    const without = httpToolDefinitions(gate({ recall: false })).map((t) => t.name);
    expect(without).not.toContain("recall_search");
    expect(without).not.toContain("recall_contribute");
    expect(without).not.toContain("recall_stats");

    const withRecall = httpToolDefinitions(gate({ recall: true })).map((t) => t.name);
    expect(withRecall).toContain("recall_search");
    expect(withRecall).toContain("recall_contribute");
    expect(withRecall).toContain("recall_stats");

    const mcpWithRecall = mcpToolDefinitions(gate({ recall: true })).map((t) => t.name);
    expect(mcpWithRecall).not.toContain("recall_search");
  });

  it("gates recall_contribute (a write to the shared corpus) behind an approval ask", () => {
    const tool = harnessTool("recall_contribute")!;
    expect(tool.approval?.policy).toBe("ask");
    expect(harnessTool("recall_search")!.approval).toBeUndefined();
    expect(harnessTool("recall_stats")!.approval).toBeUndefined();
  });

  it("offers phone tools on the HTTP surface only, gated on `phone`, without screenshot", () => {
    const without = httpToolDefinitions(gate({ phone: false })).map((t) => t.name);
    expect(without).not.toContain("phone_status");

    const withPhone = httpToolDefinitions(gate({ phone: true })).map((t) => t.name);
    expect(withPhone).toContain("phone_status");
    expect(withPhone).toContain("phone_read_screen");
    expect(withPhone).toContain("phone_tap");
    expect(withPhone).not.toContain("phone_screenshot");

    const mcpWithPhone = mcpToolDefinitions(gate({ phone: true })).map((t) => t.name);
    expect(mcpWithPhone).not.toContain("phone_status");
  });

  it("gates every phone action tool behind an approval ask, but not the three read tools", () => {
    const reads = ["phone_status", "phone_read_screen", "phone_list_apps"];
    const writes = ["phone_open_app", "phone_tap_text", "phone_tap", "phone_swipe", "phone_type_text", "phone_press"];
    for (const name of reads) expect(harnessTool(name)!.approval, name).toBeUndefined();
    for (const name of writes) expect(harnessTool(name)!.approval?.policy, name).toBe("ask");
  });

  it("keeps phone.ts's executors and the registry's phone_* records naming the exact same tool set", () => {
    // Two independently hand-maintained lists of the same names (tools/phone.ts's
    // ACTIONS, and the PHONE_* records below) with nothing else tying them
    // together — a name added to one and not the other is either a silent
    // capability gap (registry advertises a tool the host can't run) or a
    // dead advertisement (executor exists, nothing ever offers it).
    const executorNames = Object.keys(createPhoneTools()).sort();
    const registryNames = httpToolDefinitions(gate({ phone: true }))
      .map((t) => t.name)
      .filter((name) => name.startsWith("phone_"))
      .sort();
    expect(executorNames).toEqual(registryNames);
  });

  it("offers github tools on the HTTP surface only, riding the same grant as bash", () => {
    // `github` is its own ToolGateContext field (see registry.ts's
    // githubEnabled), not a bare alias of `localComputer` — every real
    // caller (turn-tools.ts, tools/host.ts) sets the two equal, which is
    // what these gate() calls reproduce here.
    const without = httpToolDefinitions(gate({ localComputer: false, github: false })).map((t) => t.name);
    expect(without).not.toContain("github_clone");

    const withGithub = httpToolDefinitions(gate({ localComputer: true, github: true })).map((t) => t.name);
    expect(withGithub).toContain("github_clone");
    expect(withGithub).toContain("github_pr_create");

    // workspace alone (no localComputer/github) must not be enough — github
    // rides the "This Computer" grant specifically, not the weaker file-tools gate.
    const withWorkspaceOnly = httpToolDefinitions(gate({ localComputer: false, github: false, workspace: true })).map(
      (t) => t.name,
    );
    expect(withWorkspaceOnly).not.toContain("github_clone");

    const mcpWithGithub = mcpToolDefinitions(gate({ localComputer: true, github: true })).map((t) => t.name);
    expect(mcpWithGithub).not.toContain("github_clone");
  });

  it("gates every mutating github tool behind an approval ask, but not the read tools", () => {
    const reads = ["github_status", "github_pr_view", "github_pr_list", "github_issue_view", "github_issue_list"];
    const writes = [
      "github_clone",
      "github_commit",
      "github_push",
      "github_pr_create",
      "github_pr_checkout",
      "github_issue_create",
    ];
    for (const name of reads) expect(harnessTool(name)!.approval, name).toBeUndefined();
    for (const name of writes) expect(harnessTool(name)!.approval?.policy, name).toBe("ask");
  });
});

describe("the import cycle stays broken", () => {
  // `tool-executor.ts` imported `bus`, `store` and `executeAskBotRequest`
  // from `index.ts`, and `index.ts` imported the executor.  That cycle is
  // how the second copy of the `list_bots` filter came to exist.  Nothing
  // under `server/tools/` may reach `index.ts` again.
  const files = readdirSync(HERE).filter((f) => f.endsWith(".ts"));

  it("finds files to check", () => {
    expect(files).toContain("registry.ts");
    expect(files).toContain("agents.ts");
    expect(files).toContain("host.ts");
  });

  it("has no file under server/tools/ importing server/index.ts", () => {
    for (const file of files) {
      const source = readFileSync(join(HERE, file), "utf8");
      for (const line of source.split("\n")) {
        // Only real import/export specifiers; a prose mention of index.ts in
        // a comment is documentation, not a cycle.
        const specifier = line.match(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/)?.[1];
        if (!specifier) continue;
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(/(^|\/)\.\.?\/index(\.ts)?$/);
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(/(^|\/)index\.ts$/);
      }
    }
  });

  it("keeps registry.ts importable with no dependencies at all", () => {
    // agents-proxy.ts is spawned as a bare node child inside a bot's agent
    // process; it renders its MCP catalog from the registry, so the registry
    // must not drag the harness in behind it.
    const source = readFileSync(join(HERE, "registry.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
