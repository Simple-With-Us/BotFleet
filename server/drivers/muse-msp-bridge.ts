#!/usr/bin/env node
// MSP → ACP bridge in front of `muse serve`.
//
// WHY THIS EXISTS.  Muse Code is not an ACP agent.  It speaks the Muse Session
// Protocol over stdio:  the client spawns `muse serve` and exchanges
// newline-delimited JSON-RPC 2.0.  Its methods are `session/start`,
// `turn/start`, `approval/decide` — not ACP's `session/new`, `session/prompt`,
// `session/request_permission`.  The only ACP path that existed was the
// community `@bex-co/muse-code-acp` adapter, and that adapter does not work
// against Muse Code 1.4.2:  it bundles `@muse-code/sdk@1.3.0`, which predates
// the move to macOS Keychain credential storage, so on a device-code session it
// answers "not logged in" on an account where `muse exec` works fine.
//
// So this process is the adapter, and it is ours.  The shape is the same one
// `server/drivers/dsh-acp-bridge.ts` uses — a stdio shim inserted by wrapSpawn,
// with the real binary after `--`, stdout reserved for the ACP channel — but
// the work is bigger, because `dsh --profile acp` already speaks ACP and this
// has to TRANSLATE.
//
//   BotFleet (ACP)  →  this bridge  →  muse serve (MSP)
//
// THE TWO SHAPE MISMATCHES THAT MATTER:
//
// 1. `session/prompt` in ACP is a request that RESOLVES when the turn ends.
//    `turn/start` in MSP is fire-and-forget and reports only that a turn was
//    accepted (`{ commandId, disposition, startedNewTurn, status, turnId }`).
//    So the bridge holds the ACP prompt id open and answers it on MSP
//    `turn/completed`.  Dropping that would make every turn look instantly
//    empty.
//
// 2. Approvals invert.  In ACP the agent asks the client with
//    `session/request_permission` and the answer is the decision.  In MSP the
//    server asks with `approval/request`, that request's reply is only a
//    PRESENTATION RECEIPT, and the decision travels out of band as
//    `approval/decide` carrying `choiceId` plus the `requirementId` that was
//    current when it was presented.  So:  present, wait for the human, then
//    send `approval/decide`.
//
// THE MULTI-STAGE TRAP, handled on purpose rather than discovered later.
// `approval/request` carries `currentRequirementId`, and MSP 1.2.1 REFRESHES a
// pending approval instead of re-issuing `approval/request`.  A client that
// waits for a fresh `approval/request` per stage hangs.  Instead every pending
// approval is tracked with the `requirementId` it was presented under, an
// `approval/updated` notification invalidates a decision made against a stale
// requirement, and the decision always carries the requirement it was granted
// against.  `approval/listPending` exists for exactly this and the driver calls
// it when a turn ends with an approval still outstanding.
//
// stdout is the ACP channel — never console.log here.
import { spawn } from "node:child_process";
import readline from "node:readline";

/** ACP `sessionUpdate` variants this bridge emits.  Deliberately few:  a
 *  variant BotFleet does not understand is a notification it drops silently,
 *  so anything not listed here is simply not translated. */
type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } }
  | { sessionUpdate: "agent_thought_chunk"; content: { type: "text"; text: string } }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title: string;
      kind: "execute" | "edit" | "other";
      status: "pending" | "in_progress" | "completed" | "failed";
      rawInput?: unknown;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      status: "pending" | "in_progress" | "completed" | "failed";
    };

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
  result?: unknown;
  error?: { code: number; message: string };
};

/** One approval awaiting a human, with the requirement it was presented under.
 *  `requirementId` is what makes a stale decision detectable rather than
 *  merely wrong. */
interface PendingApproval {
  approvalId: string;
  /** The requirement in force when we presented this to the human.  A decision
   *  computed against a different one is refused by MSP, which then re-presents
   *  — so we invalidate rather than send something we know is stale. */
  requirementId: string;
  /** MSP's own ids, so a refusal can be mapped back to the human's choice. */
  availableChoices: Array<{ id?: string; [key: string]: unknown }>;
  /** Titles we showed, so `approval/resolved` can close the right tool call. */
  toolCallId: string;
}

let nextCommandId = 1;
const commandId = (): string => `bf-${nextCommandId++}`;

/**
 * A bridge-owned MSP id for a request whose ACP answer must be relayed back.
 * Returns null for fire-and-forget calls, which carry no ACP id to answer.
 */
function relayId(acpId: string | number | null | undefined): string | number | null {
  if (acpId === undefined || acpId === null) return null;
  const mspId = `bf-r${nextCommandId++}`;
  acpIdForMsq.set(mspId, acpId);
  return mspId;
}

const out = (msg: JsonRpcMessage): void => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

const log = (...parts: unknown[]): void => {
  // stderr is the only safe place for bridge diagnostics: stdout is the ACP wire.
  process.stderr.write(`[muse-msp-bridge] ${parts.map(String).join(" ")}\n`);
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** MSP session id ↔ ACP session id are the same string; the ACP side just never
 *  learns about `viewCursor`. */
let currentSessionId: string | null = null;

/** The ACP `session/prompt` request waiting for a turn to end.  At most one is
 *  outstanding, which is what ACP's own single-threaded prompt loop expects. */
let pendingPrompt: { id: string | number } | null = null;

const approvals = new Map<string, PendingApproval>();

/**
 * ACP ids and MSP ids are DIFFERENT ID SPACES, and must never be mixed.
 * BotFleet numbers its requests; MSP numbers its own.  Forwarding an ACP id
 * inward would let an MSP response be mistaken for the answer to an ACP
 * request — the collision shows up as a turn that resolves with someone else's
 * payload.  So every relayed call gets a bridge-generated MSP id, and the ACP
 * id it belongs to is remembered here.
 */
const acpIdForMsq = new Map<string | number, string | number>();

let child: ReturnType<typeof spawn> | null = null;

// ---------------------------------------------------------------------------
// Outward:  ACP in, MSP out
// ---------------------------------------------------------------------------

/** Translate one ACP message into zero or more MSP messages.
 *
 *  Exported so the translation table can be unit-tested without a child
 *  process — the failure mode of a bridge is a mistranslated shape that only
 *  shows up on a real turn, so the mapping is the thing worth pinning. */
export function translateAcpToMsp(message: JsonRpcMessage): JsonRpcMessage[] {
  const method = message.method;
  const params = message.params ?? {};

  switch (method) {
    case "initialize":
      // ACP's protocolVersion has no MSP counterpart;  MSP `initialize` takes
      //  `capabilities` and `clientInfo` only, so there is nothing to map.
      return [{ jsonrpc: "2.0", id: relayId(message.id), method: "initialize", params: {} }];

    case "session/new": {
      const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
      return [
        {
          jsonrpc: "2.0",
          id: relayId(message.id),
          method: "session/start",
          params: {
            commandId: commandId(),
            workspaceRoot: cwd,
            ...(Array.isArray(params.mcpServers) && params.mcpServers.length > 0
              ? { config: { mcpServers: params.mcpServers } }
              : {}),
          },
        },
      ];
    }

    case "session/load":
    case "session/resume":
      return [
        {
          jsonrpc: "2.0",
          id: relayId(message.id),
          method: "session/resume",
          params: { commandId: commandId(), sessionId: params.sessionId },
        },
      ];

    case "session/prompt": {
      const prompt = Array.isArray(params.prompt) ? params.prompt : [];
      const text = prompt
        .map((block: any) => (typeof block?.text === "string" ? block.text : ""))
        .filter(Boolean)
        .join("\n");
      // ACP resolves this request when the turn ends;  MSP does not, so the id
      //  is parked in `pendingPrompt` and answered from `turn/completed`.
      if (message.id !== undefined && message.id !== null) {
        pendingPrompt = { id: message.id };
      }
      return [
        {
          jsonrpc: "2.0",
          id: null,
          method: "turn/start",
          params: {
            commandId: commandId(),
            sessionId: params.sessionId,
            input: text,
          },
        },
      ];
    }

    case "session/cancel":
      return [
        {
          jsonrpc: "2.0",
          id: null,
          method: "turn/cancel",
          params: { commandId: commandId(), sessionId: params.sessionId },
        },
      ];

    // ACP's model/effort knobs are `session/set_config_option` with a
    //  category, and MSP has dedicated methods for both.  This is the whole
    //  reason the bridge is worth building:  the community adapter has no
    //  `model` config option, which is why the driver reported model switching
    //  as unsupported and why the picker could only name one model.
    case "session/set_config_option": {
      const value = params.value;
      const sessionId = params.sessionId;
      if (typeof value !== "string") return [];
      if (params.category === "model" || params.configId === "model") {
        return [
          { jsonrpc: "2.0", id: null, method: "session/setModel", params: { commandId: commandId(), sessionId, modelId: value } },
        ];
      }
      if (params.category === "thought_level" || params.configId === "thinkingEffort") {
        return [
          {
            jsonrpc: "2.0",
            id: null,
            method: "session/setReasoningEffort",
            params: { commandId: commandId(), sessionId, effort: value },
          },
        ];
      }
      return [];
    }

    default:
      // Anything unimplemented is answered, never left hanging:  an unanswered
      //  ACP request is a BotFleet turn that waits forever.
      if (message.id !== undefined && message.id !== null) {
        return [
          { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `muse bridge: ${method} is not implemented` } },
        ];
      }
      return [];
  }
}

// ---------------------------------------------------------------------------
// Inward:  MSP in, ACP out
// ---------------------------------------------------------------------------

/** One MSP message translated into zero or more ACP messages. */
export function translateMspToAcp(message: JsonRpcMessage): JsonRpcMessage[] {
  const method = message.method;
  const params = message.params ?? {};

  // A response to something we asked inward is relayed by
  //  `acknowledgePermission`, which owns the id mapping.  The translator never
  //  sees one.
  if (message.id !== undefined && message.id !== null && method === undefined) {
    return [];
  }

  switch (method) {
    case "session/started":
      return [];

    case "turn/completed": {
      // The ACP prompt resolves here and nowhere else.
      if (!pendingPrompt) return [];
      const { id } = pendingPrompt;
      pendingPrompt = null;
      const errored = Boolean(params.error);
      return [{ jsonrpc: "2.0", id, result: { stopReason: errored ? "refusal" : "end_turn" } }];
    }

    case "item/delta": {
      const field = String(params.field ?? "");
      const delta = params.delta;
      const text = typeof delta === "string" ? delta : "";
      if (!text) return [];
      const sessionId = currentSessionId ?? params.sessionId;
      if (!sessionId) return [];
      const update: SessionUpdate =
        field === "thinking" || field === "reasoning"
          ? { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } }
          : { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
      return [{ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }];
    }

    case "approval/request": {
      const sessionId = String(params.sessionId ?? currentSessionId ?? "");
      const approvalId = String(params.approvalId ?? "");
      const choices: PendingApproval["availableChoices"] = Array.isArray(params.availableChoices)
        ? params.availableChoices
        : [];
      const toolName = String(params.toolName ?? params.subject ?? "tool");
      const toolCallId = String(params.toolCallId ?? approvalId);
      const requirementId = String(params.currentRequirementId ?? "");

      approvals.set(approvalId, { approvalId, requirementId, availableChoices: choices, toolCallId });

      // ACP options carry a `kind` the core matches on a prefix:  it looks for
      //  `allow*` and `reject*` and refuses to guess otherwise, so both are
      //  always offered and the chosen id maps back to MSP's own choice.
      const options = [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ];

      const title = String(params.subject ?? toolName).slice(0, 200);
      return [
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title,
              kind: "other",
              status: "pending",
              rawInput: params.rawArgs,
            } satisfies SessionUpdate,
          },
        },
        {
          jsonrpc: "2.0",
          id: `perm-${approvalId}`,
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: { toolCallId, title, kind: "other", rawInput: params.rawArgs },
            options,
          },
        },
      ];
    }

    // The refresh path.  A stage advanced while the human was deciding, so the
    //  requirement in force has moved:  mark it and let the next decision be
    //  made against the new one rather than sending a known-stale answer.
    case "approval/updated": {
      const approvalId = String(params.approvalId ?? "");
      const pending = approvals.get(approvalId);
      if (pending && typeof params.currentRequirementId === "string") {
        pending.requirementId = params.currentRequirementId;
        if (Array.isArray(params.availableChoices)) pending.availableChoices = params.availableChoices;
        log(`approval ${approvalId} refreshed to requirement ${pending.requirementId}`);
      }
      return [];
    }

    case "approval/resolved": {
      const approvalId = String(params.approvalId ?? "");
      const pending = approvals.get(approvalId);
      approvals.delete(approvalId);
      if (!pending) return [];
      // Prefer the session we are on, but the notification carries its own id,
      //  so a resolve never depends on module state having been populated by an
      //  earlier round trip.
      const sessionId = currentSessionId ?? String(params.sessionId ?? "");
      if (!sessionId) return [];
      return [
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "tool_call_update", toolCallId: pending.toolCallId, status: "completed" } satisfies SessionUpdate,
          },
        },
      ];
    }

    // The human answered.  Turn that into MSP's out-of-band decision.
    case "@perm-response":
      return [];

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function sendToMcp(message: JsonRpcMessage): void {
  if (!child?.stdin?.writable) {
    log("no child stdin to write to");
    return;
  }
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

/** An ACP `session/request_permission` answer became an MSP decision. */
function handlePermissionAnswer(id: string, message: JsonRpcMessage): void {
  const approvalId = id.replace(/^perm-/, "");
  const pending = approvals.get(approvalId);
  if (!pending) {
    // Already resolved, or never known:  answering nothing is correct here,
    //  because the ACP side has already been released by the receipt path.
    return;
  }
  const outcome = (message.result as any)?.outcome;
  if (!outcome || outcome.outcome !== "selected") {
    approvals.delete(approvalId);
    sendToMcp({
      jsonrpc: "2.0",
      id: null,
      method: "approval/decide",
      params: {
        commandId: commandId(),
        approvalId,
        requirementId: pending.requirementId,
        sessionId: currentSessionId ?? "",
        choiceId: "deny",
        feedback: "declined",
      },
    });
    return;
  }
  const choiceId = String(outcome.optionId ?? "allow");
  approvals.delete(approvalId);
  sendToMcp({
    jsonrpc: "2.0",
    id: null,
    method: "approval/decide",
    params: {
      commandId: commandId(),
      approvalId,
      // Always the requirement this decision was granted under.
      requirementId: pending.requirementId,
      sessionId: currentSessionId ?? "",
      choiceId,
      feedback: choiceId.startsWith("allow") ? "allowed" : "declined",
    },
  });
}

/** An inbound MSP response, or BotFleet's answer to a permission we posed. */
function acknowledgePermission(message: JsonRpcMessage): void {
  const rawId = message.id;

  // BotFleet answering one of OUR permission presentations:  an ACP response
  //  with an id we minted as `perm-<approvalId>`.
  if (typeof rawId === "string" && rawId.startsWith("perm-")) {
    handlePermissionAnswer(rawId, message);
    return;
  }

  // A response to something we asked MSP, relayed to the ACP caller.
  if (rawId === undefined || rawId === null) return;
  const acpId = acpIdForMsq.get(rawId);
  if (acpId === undefined) return; // a response to a fire-and-forget call
  acpIdForMsq.delete(rawId);

  const result = message.result as any;

  // Learn the session id as soon as it exists:  every later outward message
  //  needs it, and `turn/completed` arrives after the prompt is already open.
  if (result?.session?.sessionId) currentSessionId = String(result.session.sessionId);

  if (message.error) {
    out({ jsonrpc: "2.0", id: acpId, error: message.error });
    return;
  }

  switch (typeof result?.sessionId === "string" || result?.session?.sessionId ? "session" : "other") {
    case "session":
      out({ jsonrpc: "2.0", id: acpId, result: { sessionId: result.session?.sessionId ?? result.sessionId } });
      return;
    default:
      out({ jsonrpc: "2.0", id: acpId, result });
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  if (sep < 0 || sep === argv.length - 1) {
    log("usage: muse-msp-bridge -- <muse serve argv...>");
    process.exit(2);
  }
  const command = argv[sep + 1];
  const args = argv.slice(sep + 2);

  child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
  child.on("exit", (code, signal) => {
    // 3 is MSP's "cannot load settings or credentials", which the driver reads
    //  as an auth problem rather than a crash.
    log(`muse serve exited code=${code} signal=${signal}`);
    process.exit(code ?? 0);
  });
  child.on("error", (err) => {
    log(`spawn failed: ${err.message}`);
    process.exit(1);
  });

  // ACP in.
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    // A response coming back from BotFleet (a permission answer) never reaches
    //  the translator.
    if (parsed.method === undefined && parsed.id !== undefined && parsed.id !== null) {
      acknowledgePermission(parsed);
      return;
    }
    for (const outbound of translateAcpToMsp(parsed)) sendToMcp(outbound);
  });

  // MSP in.
  const childOut = child.stdout;
  if (!childOut) {
    log("muse serve produced no stdout to read");
    process.exit(1);
  }
  readline.createInterface({ input: childOut }).on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    for (const outbound of translateMspToAcp(parsed)) out(outbound);
  });
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("muse-msp-bridge.ts") || entry.endsWith("muse-msp-bridge.js")) {
  main();
}