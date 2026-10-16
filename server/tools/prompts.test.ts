import { describe, expect, it } from "vitest";

import {
  availableAgentToolNames,
  credentialPromptFor,
  githubToolPromptFor,
  httpCatalogPromptFor,
  phoneToolPromptFor,
  signInPromptFor,
  hasFileTools,
  LEGACY_MCP_AGENT_TOOLS,
  promptFragmentsFor,
  routinePromptFor,
} from "./prompts.ts";
import { harnessTool, type HarnessTool } from "./registry.ts";

const tool = (overrides: Partial<HarnessTool> & { name: string }): HarnessTool => ({
  description: `${overrides.name} description`,
  schema: { type: "object", properties: {} },
  surfaces: { mcp: true, http: true },
  gate: () => true,
  sideEffect: "read",
  settles: "immediate",
  ...overrides,
});

describe("promptFragmentsFor", () => {
  it("joins only the fragments the catalog records carry, in order", () => {
    const tools = [
      tool({ name: "a", promptFragment: "Use a." }),
      tool({ name: "b", promptFragment: "Use b." }),
    ];
    expect(promptFragmentsFor(tools)).toBe(" Use a. Use b.");
  });

  it("contributes nothing for a tool with no promptFragment", () => {
    const tools = [tool({ name: "silent" })];
    expect(promptFragmentsFor(tools)).toBe("");
  });

  it("contributes nothing at all when the catalog passed in is empty", () => {
    // A tool absent from `tools` — because it failed its gate, or belongs to
    // a surface this bot does not use — cannot appear, by construction: the
    // function only ever reads what it is handed.
    expect(promptFragmentsFor([])).toBe("");
  });

  it("mixes fragment and no-fragment tools without gaps", () => {
    const tools = [
      tool({ name: "a", promptFragment: "Use a." }),
      tool({ name: "silent" }),
      tool({ name: "c", promptFragment: "Use c." }),
    ];
    expect(promptFragmentsFor(tools)).toBe(" Use a. Use c.");
  });
});

describe("availableAgentToolNames", () => {
  it("is empty when the turn has no agents integration", () => {
    expect(
      availableAgentToolNames({
        hasAgentsIntegration: false,
        mcpSurface: true,
        registryToolNames: ["list_bots", "ask_bot"],
      }),
    ).toEqual([]);
  });

  it("is the registry set alone for an HTTP-only (MiniMax-shaped) turn", () => {
    const names = availableAgentToolNames({
      hasAgentsIntegration: true,
      mcpSurface: false,
      registryToolNames: ["list_bots", "ask_bot", "list_routines"],
    });
    expect(names).toEqual(["list_bots", "ask_bot", "list_routines"]);
    for (const legacy of LEGACY_MCP_AGENT_TOOLS) expect(names).not.toContain(legacy);
  });

  it("adds the legacy MCP splice for an MCP-surfaced (Claude-shaped) turn", () => {
    const names = availableAgentToolNames({
      hasAgentsIntegration: true,
      mcpSurface: true,
      registryToolNames: ["list_bots", "ask_bot", "list_routines"],
    });
    for (const legacy of LEGACY_MCP_AGENT_TOOLS) expect(names).toContain(legacy);
  });
});

describe("credentialPromptFor", () => {
  it("is silent when request_credential is not in this turn's tool set", () => {
    expect(credentialPromptFor(["list_bots", "ask_bot", "list_routines"])).toBe("");
  });

  it("names request_credential only when it is actually available", () => {
    expect(credentialPromptFor(["request_credential"])).toContain("request_credential");
  });
});

describe("signInPromptFor", () => {
  it("is silent unless request_sign_in is available", () => {
    expect(signInPromptFor(["request_credential"])).toBe("");
    expect(signInPromptFor(["request_sign_in"])).toContain("request_sign_in");
    expect(signInPromptFor(["request_sign_in"])).toContain("password");
  });
});

describe("routinePromptFor", () => {
  it("is silent when neither routines tool is available", () => {
    expect(routinePromptFor(["list_bots", "ask_bot"])).toBe("");
  });

  it("offers only list_routines, truthfully, when propose_routine is absent", () => {
    const prompt = routinePromptFor(["list_routines"]);
    expect(prompt).toContain("list_routines");
    expect(prompt).not.toContain("propose_routine");
  });

  it("offers the full list-and-propose sentence when propose_routine is available", () => {
    const prompt = routinePromptFor(["list_routines", "propose_routine", "propose_routine_action"]);
    expect(prompt).toContain("list_routines");
    expect(prompt).toContain("propose_routine_action");
  });
});

describe("githubToolPromptFor", () => {
  it("is silent when github tools are off", () => {
    expect(githubToolPromptFor(false)).toBe("");
  });

  it("names github_clone when github tools are on", () => {
    expect(githubToolPromptFor(true)).toContain("github_clone");
  });
});

describe("phoneToolPromptFor", () => {
  it("is silent when phone tools are off", () => {
    expect(phoneToolPromptFor(false)).toBe("");
  });

  it("names phone_status when phone tools are on", () => {
    expect(phoneToolPromptFor(true)).toContain("phone_status");
  });
});

describe("httpCatalogPromptFor", () => {
  const gate = {
    agents: false,
    localComputer: true,
    workspace: true,
    recall: false,
    phone: false,
    github: true,
    commsDepth: 0,
    maxCommsDepth: 1,
    chiefOfStaff: false,
  };

  it("includes github guidance when This Computer is granted", () => {
    expect(httpCatalogPromptFor(gate)).toContain("github_clone");
  });

  it("omits bash fragments when the computer section already names them", () => {
    expect(harnessTool("bash")?.promptFragment).toBeTruthy();
    const omitted = httpCatalogPromptFor(gate, { omitHostFileToolFragments: true });
    expect(omitted).not.toContain("Use bash");
    const kept = httpCatalogPromptFor(gate, { omitHostFileToolFragments: false });
    expect(kept).toContain("Use bash");
  });

  it("does not repeat recall tool fragments", () => {
    const withRecall = httpCatalogPromptFor({ ...gate, recall: true, github: false });
    expect(withRecall).not.toContain("recall_search");
  });
});

describe("hasFileTools", () => {
  it("is kept for a CLI driver (has a workspace, does not run the harness tool loop)", () => {
    expect(hasFileTools(true, false)).toBe(true);
  });

  it("is enabled for a toolLoop driver with a workspace for workspace file tools", () => {
    expect(hasFileTools(true, true)).toBe(true);
  });

  it("is enabled for a toolLoop driver when localComputer is mounted", () => {
    expect(hasFileTools(true, true, true)).toBe(true);
  });

  it("is suppressed when the driver has no workspace and no host computer", () => {
    expect(hasFileTools(false, false)).toBe(false);
    expect(hasFileTools(false, true)).toBe(false);
  });
});
