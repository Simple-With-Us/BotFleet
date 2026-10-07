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

/** Prompt block ACP actually sends.  Text is the only field the bridge forwards. */
interface PromptBlock {
  type?: string;
  text?: string;
}

/** MCP server entry copied into MSP `session/start` config when the client sent one. */
interface McpServerConfig {
  name?: string;
  command?: string;
}

interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

interface PermissionOutcome {
  outcome?: string;
  optionId?: string;
}

/** One server-minted menu entry.  `choiceId` is what `approval/decide` must
 *  echo; `id` is the older fixture spelling of the same field. */
interface ApprovalChoice {
  id?: string;
  choiceId?: string;
  decision?: string;
  label?: string;
  scope?: string;
}

/** MSP stage token.  The wire sends `{ approvalId, sourceIndex }`.  A plain
 *  string is accepted so a fixture can name a stage without the object. */
interface RequirementRef {
  approvalId: string;
  sourceIndex: number;
}

type RequirementId = string | RequirementRef;

/** Fields the two translators read.  Optional because each method carries a
 *  different slice; a missing field is "this method did not send it". */
interface RpcParams {
  cwd?: string;
  mcpServers?: McpServerConfig[];
  sessionId?: string;
  prompt?: PromptBlock[];
  value?: string;
  category?: string;
  configId?: string;
  commandId?: string;
  workspaceRoot?: string;
  config?: { mcpServers: McpServerConfig[] };
  input?: string;
  modelId?: string;
  effort?: string;
  field?: string;
  delta?: string;
  error?: { code: number; message: string } | null;
  approvalId?: string;
  currentRequirementId?: RequirementId;
  requirementId?: RequirementId;
  choiceId?: string;
  feedback?: string;
  turnId?: string;
  terminal?: boolean;
  itemId?: string;
  availableChoices?: ApprovalChoice[];
  toolName?: string;
  subject?: string;
  toolCallId?: string;
  rawArgs?: { command?: string };
  update?: SessionUpdate;
  options?: PermissionOption[];
  toolCall?: { toolCallId: string; title: string; kind: string; rawInput?: { command?: string } };
}

interface RpcResult {
  sessionId?: string;
  session?: { sessionId?: string };
  outcome?: PermissionOutcome;
  stopReason?: string;
}

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: RpcParams;
  result?: RpcResult;
  error?: { code: number; message: string };
};

/** One approval awaiting a human, with the requirement it was presented under.
 *  `requirementId` is what makes a stale decision detectable rather than
 *  merely wrong. */
interface PendingApproval {
  approvalId: string;
  /** The requirement in force when we presented this to the human.  A decision
   *  is sent only against this value.  MSP refuses a decide aimed at a later
   *  stage, and adopting that stage here would approve a requirement the human
   *  was not shown. */
  requirementId: RequirementId;
  /** Set when `approval/updated` moved the stage after presentation.  The
   *  human's answer to the old presentation is re-asked, not forwarded. */
  supersededRequirement: RequirementId | null;
  /** MSP's own ids, so a refusal can be mapped back to the human's choice. */
  availableChoices: ApprovalChoice[];
  /** Titles we showed, so `approval/resolved` can close the right tool call. */
  toolCallId: string;
  title: string;
  sessionId: string;
  rawArgs?: { command?: string };
  /** 0 is the first presentation.  A re-ask bumps it so the new ACP request id
   *  does not collide with the one the human already answered. */
  generation: number;
  /** Recorded when the human answers the presentation currently shown.
   *  `approval/resolved` reads it to close the tool call. */
  decisionStatus: "completed" | "failed" | null;
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

/** Stable identity for a stage token.  Strings and `{ approvalId, sourceIndex }`
 *  objects both survive `JSON.stringify`, and a key-order mismatch fails closed
 *  (the human is asked again) rather than treating two stages as one. */
function requirementToken(value: RequirementId | undefined): string {
  if (value === undefined) return "";
  return JSON.stringify(value);
}

function sameRequirement(left: RequirementId | undefined, right: RequirementId | undefined): boolean {
  return requirementToken(left) === requirementToken(right);
}

function choiceIdOf(choice: ApprovalChoice): string {
  return choice.choiceId ?? choice.id ?? "";
}

function isDenyChoice(choice: ApprovalChoice): boolean {
  const decision = choice.decision ?? "";
  const id = choiceIdOf(choice);
  if (decision === "denied" || decision === "deniedPolicyAmendment" || decision === "abort") return true;
  if (id === "deny" || id === "reject") return true;
  if (id.startsWith("deny") || id.startsWith("reject")) return true;
  return false;
}

function isAllowChoice(choice: ApprovalChoice): boolean {
  if (isDenyChoice(choice)) return false;
  const decision = choice.decision ?? "";
  const id = choiceIdOf(choice);
  if (decision.startsWith("approved")) return true;
  if (id === "allow" || id.startsWith("allow")) return true;
  return false;
}

function isBroadAllow(choice: ApprovalChoice): boolean {
  if (!isAllowChoice(choice)) return false;
  const id = choiceIdOf(choice);
  const scope = choice.scope ?? "";
  const decision = choice.decision ?? "";
  if (scope === "session" || scope === "localPersistent") return true;
  if (decision === "approvedForSession" || decision === "approvedPolicyAmendment") return true;
  if (id.includes("always") || id.includes("session") || id.includes("policy")) return true;
  return false;
}

function isOnceAllow(choice: ApprovalChoice): boolean {
  if (!isAllowChoice(choice)) return false;
  const id = choiceIdOf(choice);
  const scope = choice.scope ?? "";
  const decision = choice.decision ?? "";
  if (scope === "once" || decision === "approved") return true;
  if (id === "allow" || id.includes("once")) return true;
  return false;
}

/** ACP mints `allow` / `allow-always` / `reject`.  MSP accepts only a `choiceId`
 *  from the server menu, and a constructed id is refused.  Map the human's
 *  option onto that menu, and fall back to the nearest safe entry on it. */
function mspChoiceIdForAcpOption(optionId: string, choices: ApprovalChoice[]): string {
  const denies = choices.filter((choice) => isDenyChoice(choice) && choiceIdOf(choice).length > 0);
  const allows = choices.filter((choice) => isAllowChoice(choice) && choiceIdOf(choice).length > 0);
  if (optionId === "reject" || optionId.startsWith("reject")) {
    const chosen = denies[0];
    // No deny on the menu: do not substitute an allow.  MSP refuses an unknown
    // id, which leaves the tool pending instead of granting it.
    return chosen ? choiceIdOf(chosen) : "deny";
  }
  if (optionId === "allow-always") {
    const chosen = allows.find(isBroadAllow) ?? allows[0];
    return chosen ? choiceIdOf(chosen) : "allow";
  }
  const chosen = allows.find(isOnceAllow) ?? allows[0];
  return chosen ? choiceIdOf(chosen) : "allow";
}

function acpPermissionOptions(): PermissionOption[] {
  return [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ];
}

function permissionWireId(pending: PendingApproval): string {
  if (pending.generation === 0) return `perm-${encodeURIComponent(pending.approvalId)}`;
  return `perm-${encodeURIComponent(pending.approvalId)}#${pending.generation}`;
}

function permissionRequestMessage(pending: PendingApproval): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: permissionWireId(pending),
    method: "session/request_permission",
    params: {
      sessionId: pending.sessionId,
      toolCall: {
        toolCallId: pending.toolCallId,
        title: pending.title,
        kind: "other",
        rawInput: pending.rawArgs,
      },
      options: acpPermissionOptions(),
    },
  };
}

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
      const cwd = params.cwd ?? process.cwd();
      const startParams: RpcParams = {
        commandId: commandId(),
        workspaceRoot: cwd,
      };
      const mcpServers = params.mcpServers;
      if (mcpServers && mcpServers.length > 0) {
        startParams.config = { mcpServers };
      }
      return [
        {
          jsonrpc: "2.0",
          id: relayId(message.id),
          method: "session/start",
          params: startParams,
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
      const prompt = params.prompt ?? [];
      const text = prompt
        .map((block) => block.text ?? "")
        .filter((part) => part.length > 0)
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
      if (value === undefined) return [];
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

  // A response to something we asked inward is relayed by `consumeMspMessage`,
  // which owns the id mapping.  The translator never sees one.
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
      const field = params.field ?? "";
      const text = params.delta ?? "";
      if (!text) return [];
      // The notification's own session wins.  `currentSessionId` only fills in
      // when the frame omitted one, which is how a relayed `session/start`
      // result becomes usable for later frames.
      const sessionId = params.sessionId ?? currentSessionId;
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
      const choices = params.availableChoices ?? [];
      const toolName = String(params.toolName ?? params.subject ?? "tool");
      const toolCallId = String(params.toolCallId ?? approvalId);
      const requirementId = params.currentRequirementId ?? "";
      const title = String(params.subject ?? toolName).slice(0, 200);

      const pending: PendingApproval = {
        approvalId,
        requirementId,
        supersededRequirement: null,
        availableChoices: choices,
        toolCallId,
        title,
        sessionId,
        rawArgs: params.rawArgs,
        generation: 0,
        decisionStatus: null,
      };
      approvals.set(approvalId, pending);

      // ACP options carry a `kind` the core matches on a prefix:  it looks for
      //  `allow*` and `reject*` and refuses to guess otherwise, so both are
      //  always offered and the chosen id maps back to MSP's own choice.
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
        permissionRequestMessage(pending),
      ];
    }

    // The refresh path.  A stage that moved after we asked the human stays
    // recorded against the presentation.  The presented requirement is not
    // replaced:  their answer must not become `approval/decide` for the new one.
    case "approval/updated": {
      const approvalId = String(params.approvalId ?? "");
      const pending = approvals.get(approvalId);
      const requirementId = params.currentRequirementId;
      if (pending && params.availableChoices) pending.availableChoices = params.availableChoices;
      if (pending && requirementId !== undefined && !sameRequirement(requirementId, pending.requirementId)) {
        pending.supersededRequirement = requirementId;
        log(
          `approval ${approvalId} moved to requirement ${requirementToken(requirementId)} while presented under ${requirementToken(pending.requirementId)}`,
        );
      }
      return [];
    }

    case "approval/resolved": {
      const approvalId = String(params.approvalId ?? "");
      const pending = approvals.get(approvalId);
      approvals.delete(approvalId);
      if (!pending) return [];
      // The notification's own session wins, so a resolve does not depend on
      // the relay having populated module state.  The status is the one the
      // human recorded; a resolve that arrived without an answer stays completed.
      const sessionId = params.sessionId ?? currentSessionId ?? pending.sessionId;
      if (!sessionId) return [];
      const status = pending.decisionStatus ?? "completed";
      return [
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "tool_call_update", toolCallId: pending.toolCallId, status } satisfies SessionUpdate,
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

interface PermissionAnswerEffect {
  toMsp: JsonRpcMessage[];
  toAcp: JsonRpcMessage[];
}

/** The human answered a permission we posed.
 *
 *  The approval stays in `approvals` until `approval/resolved`, so that
 *  notification can still close the tool call.  A stage that moved after we
 *  asked is not decided:  the new requirement is presented instead. */
export function translatePermissionAnswer(approvalId: string, message: JsonRpcMessage): PermissionAnswerEffect {
  const pending = approvals.get(approvalId);
  if (!pending || message.id !== permissionWireId(pending)) return { toMsp: [], toAcp: [] };
  if (pending.supersededRequirement !== null) {
    pending.requirementId = pending.supersededRequirement;
    pending.supersededRequirement = null;
    pending.generation += 1;
    pending.decisionStatus = null;
    return { toMsp: [], toAcp: [permissionRequestMessage(pending)] };
  }
  if (pending.decisionStatus) return { toMsp: [], toAcp: [] };

  const outcome = message.result?.outcome;
  const optionId = !outcome || outcome.outcome !== "selected" ? "reject" : String(outcome.optionId ?? "allow");
  const choiceId = mspChoiceIdForAcpOption(optionId, pending.availableChoices);
  const rejected = optionId === "reject" || optionId.startsWith("reject");
  pending.decisionStatus = rejected ? "failed" : "completed";
  const sessionId = pending.sessionId || currentSessionId || "";
  return {
    toMsp: [
      {
        jsonrpc: "2.0",
        id: null,
        method: "approval/decide",
        params: {
          commandId: commandId(),
          approvalId,
          // Always the requirement this decision was granted under.
          requirementId: pending.requirementId,
          sessionId,
          choiceId,
          feedback: rejected ? "declined" : "allowed",
        },
      },
    ],
    toAcp: [],
  };
}

/** An ACP `session/request_permission` answer became an MSP decision. */
function handlePermissionAnswer(approvalId: string, message: JsonRpcMessage): void {
  const effect = translatePermissionAnswer(approvalId, message);
  for (const outbound of effect.toMsp) sendToMcp(outbound);
  for (const outbound of effect.toAcp) out(outbound);
}

/** A response to something we asked MSP, turned into the ACP message the
 *  caller is blocked on.  Also learns the session id. */
function relayMspResponse(message: JsonRpcMessage): JsonRpcMessage[] {
  const rawId = message.id;
  if (rawId === undefined || rawId === null) return [];
  const acpId = acpIdForMsq.get(rawId);
  if (acpId === undefined) return [];
  acpIdForMsq.delete(rawId);

  const result = message.result;
  // Learn the session id as soon as it exists:  every later outward message
  // needs it, and `turn/completed` arrives after the prompt is already open.
  if (result?.session?.sessionId) currentSessionId = result.session.sessionId;

  if (message.error) return [{ jsonrpc: "2.0", id: acpId, error: message.error }];

  const sessionId = result?.session?.sessionId ?? result?.sessionId;
  if (sessionId !== undefined) return [{ jsonrpc: "2.0", id: acpId, result: { sessionId } }];
  return [{ jsonrpc: "2.0", id: acpId, result }];
}

/** One frame from `muse serve`.  Responses to our own requests are relayed;
 *  notifications go through the translator.  The read loop calls this and
 *  nothing else — `translateMspToAcp` drops a response on purpose. */
export function consumeMspMessage(message: JsonRpcMessage): JsonRpcMessage[] {
  if (message.method === undefined && message.id !== undefined && message.id !== null) {
    return relayMspResponse(message);
  }
  return translateMspToAcp(message);
}

/** An inbound MSP response, or BotFleet's answer to a permission we posed. */
function acknowledgePermission(message: JsonRpcMessage): void {
  const rawId = message.id;

  // BotFleet answering one of OUR permission presentations:  an ACP response
  // with an id we minted as `perm-<approvalId>`.
  const permissionId = permissionRequestId(rawId);
  if (permissionId !== undefined) {
    handlePermissionAnswer(permissionId, message);
    return;
  }

  for (const outbound of relayMspResponse(message)) out(outbound);
}

/** Permission wire ids encode the opaque approval id before appending a re-ask
 *  generation.  Thus a literal '#' (including '#1') is never a suffix.  Only
 *  canonical positive-integer generations minted by the bridge are stripped. */
export function permissionRequestId(id: string | number | null | undefined): string | undefined {
  if (typeof id !== "string" || !id.startsWith("perm-")) return undefined;
  const body = id.slice("perm-".length);
  const mark = body.lastIndexOf("#");
  if (mark !== -1 && !/^[1-9]\d*$/.test(body.slice(mark + 1))) return undefined;
  const encoded = mark === -1 ? body : body.slice(0, mark);
  try {
    const approvalId = decodeURIComponent(encoded);
    // Accept only the domain our wire-id producer emits, not ambiguous raw ids.
    return encodeURIComponent(approvalId) === encoded ? approvalId : undefined;
  } catch {
    return undefined;
  }
}

/** How the bridge should die when `muse serve` does.  A signal is a crash
 *  (OOM, SIGKILL) and must not be reported as exit code 0.  Code 3 is MSP's
 *  "cannot load settings or credentials", which the driver reads as auth. */
export function childExitAction(
  code: number | null,
  signal: NodeJS.Signals | null,
): { kind: "signal"; signal: NodeJS.Signals } | { kind: "exit"; code: number } {
  if (signal) return { kind: "signal", signal };
  return { kind: "exit", code: code ?? 1 };
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
    log(`muse serve exited code=${code} signal=${signal}`);
    const action = childExitAction(code, signal);
    if (action.kind === "signal") {
      // Die the same way the engine did.  Drop our own handler first so the
      // re-raise does not loop.
      process.removeAllListeners(action.signal);
      process.kill(process.pid, action.signal);
      return;
    }
    process.exit(action.code);
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
    for (const outbound of consumeMspMessage(parsed)) out(outbound);
  });
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("muse-msp-bridge.ts") || entry.endsWith("muse-msp-bridge.js")) {
  main();
}