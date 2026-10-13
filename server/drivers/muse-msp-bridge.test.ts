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

import {
  childExitAction,
  permissionRequestId,
  consumeMspMessage,
  translateAcpToMsp,
  translateMspToAcp,
  translatePermissionAnswer,
} from "./muse-msp-bridge.ts";

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
    translateMspToAcp({ jsonrpc: "2.0", method: "turn/completed",
      params: { sessionId: "sess-1", terminal: "completed" } });
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
      params: { sessionId: "sess-1", turnId: "t1", terminal: "completed", error: null },
    });
    expect(completed.id).toBe(20);
    expect(completed.result?.stopReason).toBe("end_turn");
  });

  it("answers once, and reports a refused turn as a refusal", () => {
    translateAcpToMsp(acpPrompt(21));
    const [first] = translateMspToAcp({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { sessionId: "s", turnId: "t", terminal: "failed", error: { code: 1, message: "boom" } },
    });
    expect(first.result?.stopReason).toBe("refusal");
    // A second terminal event must not answer a prompt nobody is holding.
    expect(
      translateMspToAcp({ jsonrpc: "2.0", method: "turn/completed", params: { sessionId: "s", terminal: "completed" } }),
    ).toEqual([]);
  });

  it("rejects a second prompt without orphaning or cancelling the first", () => {
    translateAcpToMsp(acpPrompt(901));
    const [rejected] = translateAcpToMsp(acpPrompt(902));
    expect(rejected.id).toBe(902);
    expect(rejected.error?.code).toBe(-32600);
    expect(rejected.method).toBeUndefined();
    const [completed] = translateMspToAcp({ jsonrpc: "2.0", method: "turn/completed",
      params: { sessionId: "sess-1", terminal: "completed" } });
    expect(completed.id).toBe(901);
    expect(completed.result?.stopReason).toBe("end_turn");
  });

  it.each([
    ["cancelled", "cancelled"],
    ["failed", "refusal"],
  ] as const)("maps MSP %s without an error object to ACP %s", (terminal, stopReason) => {
    translateAcpToMsp(acpPrompt(903));
    const [completed] = translateMspToAcp({ jsonrpc: "2.0", method: "turn/completed",
      params: { sessionId: "sess-1", terminal } });
    expect(completed.id).toBe(903);
    expect(completed.result?.stopReason).toBe(stopReason);
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

  it.each(["ap#segment", "ap#1", "ap#0", "ap#01", "ap%23#2", "ap#part#3", "ap-é#4"])(
    "round-trips opaque approval id %s through initial and re-asked wire ids",
    (approvalId) => {
      const [, initial] = translateMspToAcp({
        jsonrpc: "2.0", method: "approval/request",
        params: { sessionId: "s", approvalId, currentRequirementId: "req-1", availableChoices: [{ id: "allow" }] },
      });
      expect(initial.id).toBe(`perm-${encodeURIComponent(approvalId)}`);
      expect(permissionRequestId(initial.id)).toBe(approvalId);
      translateMspToAcp({
        jsonrpc: "2.0", method: "approval/updated",
        params: { approvalId, currentRequirementId: "req-2" },
      });
      const answer = (id: string | number | null | undefined) => ({
        jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId: "allow" } },
      });
      const reasked = translatePermissionAnswer(permissionRequestId(initial.id)!, answer(initial.id));
      expect(reasked.toMsp).toEqual([]);
      const nextId = reasked.toAcp[0]?.id;
      expect(nextId).toBe(`perm-${encodeURIComponent(approvalId)}#1`);
      expect(permissionRequestId(nextId)).toBe(approvalId);
      // A repeated old answer must not authorize the newly presented stage.
      expect(translatePermissionAnswer(approvalId, answer(initial.id))).toEqual({ toMsp: [], toAcp: [] });
      const decided = translatePermissionAnswer(permissionRequestId(nextId)!, answer(nextId));
      expect(decided.toMsp[0]?.params).toMatchObject({ approvalId, requirementId: "req-2", choiceId: "allow" });
      translateMspToAcp({ jsonrpc: "2.0", method: "approval/resolved", params: { approvalId } });
    },
  );

  it("keeps a numeric-ending bare id distinct from another approval's generation", () => {
    const ask = (approvalId: string) => translateMspToAcp({
      jsonrpc: "2.0", method: "approval/request",
      params: { sessionId: "s", approvalId, currentRequirementId: "req-1", availableChoices: [{ id: "allow" }] },
    })[1];
    const bare = ask("collision#1");
    const other = ask("collision");
    // Exercise the producer/parser round-trip without assuming an encoding.
    expect(permissionRequestId(bare.id)).toBe("collision#1");
    translateMspToAcp({ jsonrpc: "2.0", method: "approval/updated", params: { approvalId: "collision", currentRequirementId: "req-2" } });
    const answer = (id: string | number | null | undefined) => ({
      jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    const reasked = translatePermissionAnswer("collision", answer(other.id)).toAcp[0];
    expect(bare.id).not.toBe(reasked.id);
    expect(permissionRequestId(reasked.id)).toBe("collision");
    expect(translatePermissionAnswer(permissionRequestId(bare.id)!, answer(bare.id)).toMsp[0]?.params?.approvalId).toBe("collision#1");
    expect(translatePermissionAnswer("collision", answer(other.id))).toEqual({ toMsp: [], toAcp: [] });
    expect(translatePermissionAnswer("collision", answer(reasked.id)).toMsp[0]?.params?.requirementId).toBe("req-2");
    for (const approvalId of ["collision", "collision#1"]) {
      translateMspToAcp({ jsonrpc: "2.0", method: "approval/resolved", params: { approvalId } });
    }
  });

  it("rejects malformed or foreign permission wire ids", () => {
    for (const id of [null, undefined, 12, "bf-r1", "perm-ap#text", "perm-ap#0", "perm-ap#01", "perm-ap#-1", "perm-ap#1.5", "perm-ap%ZZ", "perm-ap%23#1#2"]) {
      expect(permissionRequestId(id)).toBeUndefined();
    }
    expect(permissionRequestId("perm-ap")).toBe("ap");
    expect(permissionRequestId("perm-ap#1")).toBe("ap");
    expect(permissionRequestId("perm-ap%231")).toBe("ap#1");
  });

  it("treats an approval refresh as new information rather than a new request", () => {
    // The multi-stage trap:  MSP REFRESHES a pending approval instead of
    // re-issuing `approval/request`, so a client waiting for a fresh request
    // per stage hangs forever.  The notification itself must not re-ask.
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
    expect(refreshed).toEqual([]);
  });

  it("refuses to decide a requirement the human was not shown", () => {
    // The human was asked under req-1.  MSP then advanced the stage.  Their
    // answer must not be forwarded as approval/decide for req-2.
    translateMspToAcp({
      jsonrpc: "2.0",
      method: "approval/request",
      params: {
        sessionId: "s",
        approvalId: "ap-stale",
        currentRequirementId: "req-1",
        itemId: "it",
        rawArgs: {},
        toolName: "shell",
        availableChoices: [{ id: "allow" }, { id: "deny" }],
      },
    });
    translateMspToAcp({
      jsonrpc: "2.0",
      method: "approval/updated",
      params: {
        sessionId: "s",
        approvalId: "ap-stale",
        currentRequirementId: "req-2",
        availableChoices: [{ id: "allow" }, { id: "allow_always" }, { id: "deny" }],
      },
    });
    const first = translatePermissionAnswer("ap-stale", {
      jsonrpc: "2.0",
      id: "perm-ap-stale",
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    expect(first.toMsp).toEqual([]);
    expect(first.toAcp[0]?.method).toBe("session/request_permission");
    expect(first.toAcp[0]?.id).toBe("perm-ap-stale#1");

    const second = translatePermissionAnswer("ap-stale", {
      jsonrpc: "2.0",
      id: "perm-ap-stale#1",
      result: { outcome: { outcome: "selected", optionId: "allow-always" } },
    });
    expect(second.toAcp).toEqual([]);
    expect(second.toMsp[0]?.method).toBe("approval/decide");
    expect(second.toMsp[0]?.params?.requirementId).toBe("req-2");
    expect(second.toMsp[0]?.params?.choiceId).toBe("allow_always");
  });

  it("keeps an object requirement id and will not satisfy the next stage with it", () => {
    const presented = { approvalId: "ap-obj", sourceIndex: 0 };
    const advanced = { approvalId: "ap-obj", sourceIndex: 1 };
    translateMspToAcp({
      jsonrpc: "2.0",
      method: "approval/request",
      params: {
        sessionId: "s",
        approvalId: "ap-obj",
        currentRequirementId: presented,
        itemId: "it",
        rawArgs: {},
        toolName: "shell",
        availableChoices: [
          { choiceId: "allow_once", decision: "approved", scope: "once" },
          { choiceId: "deny", decision: "denied", scope: "once" },
        ],
      },
    });
    translateMspToAcp({
      jsonrpc: "2.0",
      method: "approval/updated",
      params: {
        sessionId: "s",
        approvalId: "ap-obj",
        currentRequirementId: advanced,
        availableChoices: [
          { choiceId: "allow_once", decision: "approved", scope: "once" },
          { choiceId: "deny", decision: "denied", scope: "once" },
        ],
      },
    });
    const stale = translatePermissionAnswer("ap-obj", {
      jsonrpc: "2.0",
      id: "perm-ap-obj",
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    expect(stale.toMsp).toEqual([]);
    const decided = translatePermissionAnswer("ap-obj", {
      jsonrpc: "2.0",
      id: "perm-ap-obj#1",
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    expect(decided.toMsp[0]?.params?.requirementId).toEqual(advanced);
    expect(decided.toMsp[0]?.params?.choiceId).toBe("allow_once");
  });

  it("maps the human's option onto the server's choice id", () => {
    const choices = [
      { choiceId: "allow_once", decision: "approved", scope: "once", label: "Allow once" },
      { choiceId: "allow_session", decision: "approvedForSession", scope: "session", label: "Always" },
      { choiceId: "deny", decision: "denied", scope: "once", label: "Deny" },
    ];
    const ask = (approvalId: string) => {
      translateMspToAcp({
        jsonrpc: "2.0",
        method: "approval/request",
        params: {
          sessionId: "s",
          approvalId,
          currentRequirementId: "req-1",
          itemId: "it",
          rawArgs: {},
          toolName: "shell",
          availableChoices: choices,
        },
      });
    };
    const answer = (approvalId: string, optionId: string) =>
      translatePermissionAnswer(approvalId, {
        jsonrpc: "2.0",
        id: `perm-${approvalId}`,
        result: { outcome: { outcome: "selected", optionId } },
      });

    ask("ap-once");
    expect(answer("ap-once", "allow").toMsp[0]?.params?.choiceId).toBe("allow_once");
    ask("ap-always");
    expect(answer("ap-always", "allow-always").toMsp[0]?.params?.choiceId).toBe("allow_session");
    ask("ap-deny");
    expect(answer("ap-deny", "reject").toMsp[0]?.params?.choiceId).toBe("deny");
  });

  it("still decides when a refresh repeats the requirement the human was shown", () => {
    translateMspToAcp({
      jsonrpc: "2.0",
      method: "approval/request",
      params: {
        sessionId: "s",
        approvalId: "ap-same",
        currentRequirementId: "req-1",
        itemId: "it",
        rawArgs: {},
        toolName: "shell",
        availableChoices: [{ id: "allow" }, { id: "deny" }],
      },
    });
    translateMspToAcp({
      jsonrpc: "2.0",
      method: "approval/updated",
      params: {
        sessionId: "s",
        approvalId: "ap-same",
        currentRequirementId: "req-1",
        availableChoices: [{ id: "allow" }, { id: "deny" }],
      },
    });
    const effect = translatePermissionAnswer("ap-same", {
      jsonrpc: "2.0",
      id: "perm-ap-same",
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    expect(effect.toAcp).toEqual([]);
    expect(effect.toMsp[0]?.params?.requirementId).toBe("req-1");
    expect(effect.toMsp[0]?.params?.choiceId).toBe("allow");
    expect(effect.toMsp[0]?.params?.sessionId).toBe("s");
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

  it("keeps the approval after the human answers so approval/resolved can close it", () => {
    translateMspToAcp({
      jsonrpc: "2.0",
      method: "approval/request",
      params: {
        sessionId: "s",
        approvalId: "ap-held",
        currentRequirementId: "req-1",
        itemId: "it",
        rawArgs: {},
        toolName: "shell",
        availableChoices: [{ choiceId: "allow_once", decision: "approved", scope: "once" }, { choiceId: "deny", decision: "denied", scope: "once" }],
      },
    });
    const decided = translatePermissionAnswer("ap-held", {
      jsonrpc: "2.0",
      id: "perm-ap-held",
      result: { outcome: { outcome: "selected", optionId: "reject" } },
    });
    expect(decided.toMsp[0]?.method).toBe("approval/decide");
    const [resolved] = translateMspToAcp({
      jsonrpc: "2.0",
      method: "approval/resolved",
      params: { sessionId: "s", approvalId: "ap-held" },
    });
    expect(resolved.params?.update?.sessionUpdate).toBe("tool_call_update");
    expect(resolved.params?.update && "status" in resolved.params.update ? resolved.params.update.status : "").toBe(
      "failed",
    );
  });

  it("relays an MSP response to the ACP request that asked for it", () => {
    // The read loop used to hand every muse serve line to the translator,
    // which drops a response.  session/start then never reaches BotFleet.
    const [started] = translateAcpToMsp({
      jsonrpc: "2.0",
      id: 41,
      method: "session/new",
      params: { cwd: "/tmp/project", mcpServers: [] },
    });
    const [relayed] = consumeMspMessage({
      jsonrpc: "2.0",
      id: started.id,
      result: { session: { sessionId: "sess-relay" } },
    });
    expect(relayed?.id).toBe(41);
    expect(relayed?.result?.sessionId).toBe("sess-relay");
    expect(consumeMspMessage({ jsonrpc: "2.0", id: started.id, result: { session: { sessionId: "other" } } })).toEqual(
      [],
    );

    const [delta] = consumeMspMessage({
      jsonrpc: "2.0",
      method: "item/delta",
      params: { field: "text", delta: "hi" },
    });
    expect(delta?.params?.sessionId).toBe("sess-relay");
  });

  it("ignores MSP traffic it does not translate", () => {
    expect(translateMspToAcp({ jsonrpc: "2.0", method: "session/contextUsage", params: {} })).toEqual([]);
    expect(translateMspToAcp({ jsonrpc: "2.0", method: "workflow/childControl", params: {} })).toEqual([]);
  });
});

describe("child exit", () => {
  it("re-raises a signal and does not report a signal death as code 0", () => {
    expect(childExitAction(null, "SIGKILL")).toEqual({ kind: "signal", signal: "SIGKILL" });
    expect(childExitAction(null, null)).toEqual({ kind: "exit", code: 1 });
    expect(childExitAction(3, null)).toEqual({ kind: "exit", code: 3 });
    expect(childExitAction(0, null)).toEqual({ kind: "exit", code: 0 });
  });
});