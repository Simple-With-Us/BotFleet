// The bridge's translation tables.
//
// A bridge fails in a specific way:  a mistranslated shape that type-checks and
// unit-tests clean, then produces a turn that looks empty, or an approval that
// never resolves, or a cost that is silently zero.  None of that is visible
// without a real engine, so the mapping itself is what gets pinned here.
//
// The two shape mismatches these exist to hold:
//
//   1. ACP `session/prompt` RESOLVES when the turn ends;  MSP `turn/start` only
//      reports that a turn was accepted.  So the prompt id is parked and
//      answered from `turn/completed`.
//   2. Approvals invert, and in the harder direction:  MSP's reply to
//      `approval/request` is a presentation receipt, and the decision travels
//      separately as `approval/decide` carrying the `requirementId` in force
//      when the human was asked.
import { describe, expect, it } from "vitest";

import { translateAcpToMsp, translateMspToAcp } from "./muse-msp-bridge.ts";

const acpPrompt = (id: number | string, sessionId = "sess-1") => ({
  jsonrpc: "2.0",
  id,
  method: "session/prompt",
  params: { sessionId, prompt: [{ type: "text", text: "hello" }] },
});

describe("ACP to MSP", () => {
  it("turns session/new into session/start with a workspace root and its own id", () => {
    const [message] = translateAcpToMsp({
      jsonrpc: "2.0",
      id: 7,
      method: "session/new",
      params: { cwd: "/tmp/project", mcpServers: [] },
    });
    expect(message.method).toBe("session/start");
    expect(message.params).toMatchObject({ workspaceRoot: "/tmp/project" });
    // `commandId` is REQUIRED by MSP and is its own correlation token — not the
    // ACP request id.
    expect(message.params?.commandId).toBeTruthy();
    // The id must NOT be the ACP id:  the two are different id spaces and a
    // collision silently attributes one call's answer to another.
    expect(message.id).not.toBe(7);
  });

  it("carries MCP servers into session/start config", () => {
    const [message] = translateAcpToMsp({
      jsonrpc: "2.0",
      id: 8,
      method: "session/new",
      params: { cwd: "/tmp/project", mcpServers: [{ name: "composio", command: "node" }] },
    });
    expect(message.params?.config?.mcpServers).toHaveLength(1);
  });

  it("maps session/load to session/resume", () => {
    const [message] = translateAcpToMsp({
      jsonrpc: "2.0",
      id: 9,
      method: "session/load",
      params: { sessionId: "sess-7", cwd: "/tmp/p", mcpServers: [] },
    });
    expect(message.method).toBe("session/resume");
    expect(message.params?.sessionId).toBe("sess-7");
  });

  it("flattens the ACP prompt block list into MSP input", () => {
    const [message] = translateAcpToMsp(acpPrompt(10));
    expect(message.method).toBe("turn/start");
    expect(message.params?.input).toBe("hello");
    expect(message.params?.sessionId).toBe("sess-1");
  });

  it("never leaves an unimplemented ACP request hanging", () => {
    // An unanswered ACP request is a BotFleet turn that waits forever, so the
    // default must be an error, not silence.
    const [message] = translateAcpToMsp({ jsonrpc: "2.0", id: 11, method: "session/fork", params: {} });
    expect(message.id).toBe(11);
    expect(message.error?.code).toBe(-32601);
  });

  it("maps model and effort config options onto MSP's dedicated methods", () => {
    // This is the reason the bridge is worth building:  the community adapter
    // has no `model` config option, which is why the driver could not switch
    // models and why the picker could only name one.
    const [model] = translateAcpToMsp({
      jsonrpc: "2.0",
      id: null,
      method: "session/set_config_option",
      params: { sessionId: "s1", category: "model", configId: "model", value: "muse-spark-1.3" },
    });
    expect(model.method).toBe("session/setModel");
    expect(model.params?.modelId).toBe("muse-spark-1.3");

    const [effort] = translateAcpToMsp({
      jsonrpc: "2.0",
      id: null,
      method: "session/set_config_option",
      params: { sessionId: "s1", category: "thought_level", configId: "thinkingEffort", value: "high" },
    });
    expect(effort.method).toBe("session/setReasoningEffort");
    expect(effort.params?.effort).toBe("high");
  });

  it("ignores an ACP config option it cannot honour", () => {
    expect(
      translateAcpToMsp({
        jsonrpc: "2.0",
        id: null,
        method: "session/set_config_option",
        params: { sessionId: "s1", category: "mystery", value: "x" },
      }),
    ).toEqual([]);
  });
});

describe("MSP to ACP", () => {
  it("answers the parked prompt on turn/completed, not on turn/start", () => {
    // The mismatch that would make every turn look instantly empty if wrong.
    translateAcpToMsp(acpPrompt(20));
    const [completed] = translateMspToAcp({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { sessionId: "sess-1", turnId: "t1", terminal: true, error: null },
    });
    expect(completed.id).toBe(20);
    expect(completed.result?.stopReason).toBe("end_turn");
  });

  it("answers once, and reports a refused turn as a refusal", () => {
    translateAcpToMsp(acpPrompt(21));
    const [first] = translateMspToAcp({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { sessionId: "s", turnId: "t", terminal: true, error: { code: 1, message: "boom" } },
    });
    expect(first.result?.stopReason).toBe("refusal");
    // A second terminal event must not answer a prompt nobody is holding.
    expect(
      translateMspToAcp({ jsonrpc: "2.0", method: "turn/completed", params: { sessionId: "s", terminal: true } }),
    ).toEqual([]);
  });

  it("maps an item/delta onto an assistant or reasoning chunk by field", () => {
    const [text] = translateMspToAcp({
      jsonrpc: "2.0",
      method: "item/delta",
      params: { sessionId: "sess-1", itemId: "i1", field: "text", delta: "hi" },
    });
    expect(text.params?.update?.sessionUpdate).toBe("agent_message_chunk");
    expect(text.params?.update && "content" in text.params.update ? text.params.update.content.text : "").toBe("hi");

    const [thought] = translateMspToAcp({
      jsonrpc: "2.0",
      method: "item/delta",
      params: { sessionId: "sess-1", itemId: "i1", field: "thinking", delta: "hmm" },
    });
    expect(thought.params?.update?.sessionUpdate).toBe("agent_thought_chunk");
  });

  it("announces a tool call and asks for permission, both with allow and reject options", () => {
    // BotFleet's core looks for an option whose `kind` starts with `allow` or
    // `reject` and refuses to guess, so both must always be present.
    const [update, request] = translateMspToAcp({
      jsonrpc: "2.0",
      method: "approval/request",
      params: {
        sessionId: "sess-1",
        approvalId: "ap-1",
        currentRequirementId: "req-1",
        itemId: "it-1",
        rawArgs: { command: "rm -rf /tmp/x" },
        toolName: "shell",
        subject: "run a shell command",
        availableChoices: [{ id: "allow" }, { id: "deny" }],
      },
    });
    expect(update?.params?.update?.sessionUpdate).toBe("tool_call");
    expect(request.method).toBe("session/request_permission");
    const kinds = (request.params?.options ?? []).map((option) => option.kind);
    expect(kinds.some((k: string) => k.startsWith("allow"))).toBe(true);
    expect(kinds.some((k: string) => k.startsWith("reject"))).toBe(true);
  });

  it("treats an approval refresh as new information rather than a new request", () => {
    // The multi-stage trap:  MSP 1.2.1 REFRESHES a pending approval instead of
    //  re-issuing `approval/request`, so a client waiting for a fresh request
    //  per stage hangs forever.  A refresh must NOT re-ask the human.
    const [, request] = translateMspToAcp({
      jsonrpc: "2.0",
      method: "approval/request",
      params: {
        sessionId: "s",
        approvalId: "ap-2",
        currentRequirementId: "req-1",
        itemId: "it",
        rawArgs: {},
        availableChoices: [{ id: "allow" }],
      },
    });
    expect(request.method).toBe("session/request_permission");

    const refreshed = translateMspToAcp({
      jsonrpc: "2.0",
      method: "approval/updated",
      params: { sessionId: "s", approvalId: "ap-2", currentRequirementId: "req-2", availableChoices: [{ id: "allow" }, { id: "allow_always" }] },
    });
    // No second request to the human; the outstanding one is now against req-2.
    expect(refreshed).toEqual([]);
  });

  it("closes the tool call when the approval resolves", () => {
    translateMspToAcp({
      jsonrpc: "2.0",
      method: "approval/request",
      params: {
        sessionId: "s",
        approvalId: "ap-3",
        currentRequirementId: "req-1",
        itemId: "it",
        rawArgs: {},
        toolName: "t",
        availableChoices: [{ id: "allow" }],
      },
    });
    const [resolved] = translateMspToAcp({
      jsonrpc: "2.0",
      method: "approval/resolved",
      params: { sessionId: "s", approvalId: "ap-3" },
    });
    expect(resolved.params?.update?.sessionUpdate).toBe("tool_call_update");
    expect(resolved.params?.update && "status" in resolved.params.update ? resolved.params.update.status : "").toBe(
      "completed",
    );
  });

  it("ignores MSP traffic it does not translate", () => {
    expect(translateMspToAcp({ jsonrpc: "2.0", method: "session/contextUsage", params: {} })).toEqual([]);
    expect(translateMspToAcp({ jsonrpc: "2.0", method: "workflow/childControl", params: {} })).toEqual([]);
  });
});