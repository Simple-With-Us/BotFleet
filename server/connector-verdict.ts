// The harness-side verdict for connected-app tool calls: per-bot Composio
// tool grants, enforced where the loopback relay already knows which bot is
// calling and the decision log is native.
//
// Every Composio tool call crosses POST /api/internal/connectors/mcp: the
// provider CLIs talk to the stdio bridge (connector-proxy.ts), and the
// bridge forwards each JSON-RPC frame there. So the grants verdict lives on
// the harness side, where composio.ts's relayMcp() actually reaches
// Composio — the bridge itself never sees a key it could enforce with.
//
// Three shapes reach this module:
//
//   * a direct per-toolkit call — params.name is the tool itself, e.g.
//     GMAIL_SEND_EMAIL;
//   * the executor meta-tool — COMPOSIO_MULTI_EXECUTE_TOOL, whose
//     arguments name one or many target tools;
//   * everything else — connection cards, discovery, notifications —
//     which passes through untouched (tools/list filtering is separate,
//     see filterConnectorToolsList below).
//
// Unrecognized argument shapes are denied by default: a call whose target
// tools cannot be read is a call whose tools cannot be checked, and the
// grants promise — "this bot may call exactly these tools" — must hold
// even against a model that garbles the protocol.
import { CONNECTOR_TOOL_NAME_PATTERN, type ConnectorToolGrant } from "../shared/connector-tools.ts";

/** The executor meta-tool: the only meta-tool whose arguments name target
 * tools. Discovery and connection meta-tools keep their existing flows. */
export const COMPOSIO_MULTI_EXECUTE_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";

/** One tools/call frame, classified for the verdict. names carries every
 * target tool in call order (duplicates preserved for the audit summary;
 * the verdict itself judges distinct names). */
export type ConnectorCall =
  | { kind: "passthrough" }
  | { kind: "tools"; invoked: string; names: string[] }
  | { kind: "unrecognized"; invoked: string; reason: string };

export interface ConnectorDenial {
  tool: string;
  /** null when the name carries no service prefix at all. */
  service: string | null;
  /** the service is granted but the exact tool is not on its list. */
  onGrantedService: boolean;
}

export interface ConnectorVerdict {
  allowed: boolean;
  /** the bot carries no connectorTools record: legacy all-tools behavior. */
  legacy: boolean;
  denials: ConnectorDenial[];
  /** the grant key that allowed the first tool, for the allow row. */
  rule: string;
}

/** The service a Composio tool name belongs to: the upper-snake prefix
 * before the first underscore, lowercased (GMAIL_SEND_EMAIL to gmail). A
 * name with no underscore names no service, so no grant can cover it. */
export function serviceSlugFor(tool: string): string | null {
  const underscore = tool.indexOf("_");
  if (underscore <= 0) return null;
  return tool.slice(0, underscore).toLowerCase();
}

/** True for the platform meta-tools and per-service connection cards that
 * are never subject to a connectorTools grant: search/schema discovery and
 * the connect/wait flow are how a bot GETS a connection, not a use of one.
 * Shared by the call classifier and the tools/list filter so the two can
 * never show/allow different sets. */
function isUngatedToolName(name: string): boolean {
  if (name.startsWith("COMPOSIO_")) return true;
  return name.endsWith("_MANAGE_CONNECTIONS") || name.endsWith("_WAIT_FOR_CONNECTIONS");
}

/** Classify one relayed JSON-RPC frame. Anything that is not a tools/call,
 * or is a discovery/connection/platform meta-tool, passes through. */
export function connectorCallFromFrame(payload): ConnectorCall {
  if (!payload || !(Object.prototype.toString.call(payload) === "[object Object]") || Array.isArray(payload)) return { kind: "passthrough" };
  // SAFETY: the toString-call + !Array.isArray() guards above restrict
  // payload to a JSON object, so the cast to the JSON-RPC envelope is exact.
  const frame = payload as { method?: unknown; params?: unknown };
  if (frame.method !== "tools/call") return { kind: "passthrough" };
  const params = frame.params;
  if (!params || !(Object.prototype.toString.call(params) === "[object Object]") || Array.isArray(params)) {
    return { kind: "unrecognized", invoked: "tools/call", reason: "the call carried no params object" };
  }
  // SAFETY: same invariant; cast narrows to the params.name field.
  const name = (params as { name?: unknown }).name;
  if (!(Object.prototype.toString.call(name) === "[object String]") || !name) {
    return { kind: "unrecognized", invoked: "tools/call", reason: "the call named no tool" };
  }
  if (name === COMPOSIO_MULTI_EXECUTE_TOOL) {
    // SAFETY: same invariant — params.arguments is the documented
    // multi-execute envelope; the cast narrows it for the dispatch.
    return multiExecuteCall(name, (params as { arguments?: unknown }).arguments);
  }
  // Platform meta-tools (search, schemas, remote workbench) are not
  // connected-app tools, and per-service connection cards keep their card
  // flow in any spelling — neither is gated by connectorTools.
  if (isUngatedToolName(name)) return { kind: "passthrough" };
  if (!CONNECTOR_TOOL_NAME_PATTERN.test(name)) {
    return { kind: "unrecognized", invoked: name, reason: "the tool name is not a Composio tool name" };
  }
  return { kind: "tools", invoked: name, names: [name] };
}

/** Read the target tools out of COMPOSIO_MULTI_EXECUTE_TOOL arguments:
 * the upstream schema is a 1-50 item tools array of { tool_slug,
 * arguments }; a legacy single { tool_slug } object is accepted too.
 * Anything else cannot be checked, so it is denied. */
function multiExecuteCall(invoked: string, args): ConnectorCall {
  if (!args || !(Object.prototype.toString.call(args) === "[object Object]") || Array.isArray(args)) {
    return { kind: "unrecognized", invoked, reason: "the arguments were not an object" };
  }
  // SAFETY: the toString-call + !Array.isArray() guards restrict args
  // to a JSON object, so the cast to the documented envelope is exact.
  const tools = (args as { tools?: unknown }).tools;
  // SAFETY: same invariant; cast narrows to the legacy tool_slug field.
  const singleSlug = (args as { tool_slug?: unknown }).tool_slug;
  if (Array.isArray(tools)) {
    if (tools.length === 0) {
      return { kind: "unrecognized", invoked, reason: "the tools list was empty" };
    }
    const names: string[] = [];
    for (const item of tools) {
      const slug = item && (Object.prototype.toString.call(item) === "[object Object]") && !Array.isArray(item)
        ? // SAFETY: the toString-call + !Array.isArray() guards restrict
          // item to a JSON object, so the cast to the documented
          // { tool_slug } envelope is exact.
          (item as { tool_slug?: unknown }).tool_slug
        : undefined;
      if (!(Object.prototype.toString.call(slug) === "[object String]") || !slug) {
        return { kind: "unrecognized", invoked, reason: "an entry in the tools list named no tool_slug" };
      }
      names.push(slug);
    }
    return batchCall(invoked, names);
  }
  if ((Object.prototype.toString.call(singleSlug) === "[object String]") && singleSlug) {
    return batchCall(invoked, [singleSlug]);
  }
  return { kind: "unrecognized", invoked, reason: "the arguments named no tools to execute" };
}

/** Run each batch slug through the same checks a direct call gets:
 * meta-tools and connection cards are ungated (dropped from the verdict),
 // SAFETY: the surrounding code established this is the documented shape; the cast narrows.

 * and a slug that is not a Composio tool name is refused as unrecognized
 * instead of being judged by its prefix. A batch of only ungated slugs
 * passes through, like the same calls made directly. */
function batchCall(invoked: string, slugs: string[]): ConnectorCall {
  const names: string[] = [];
  for (const slug of slugs) {
    if (isUngatedToolName(slug)) continue;
    if (!CONNECTOR_TOOL_NAME_PATTERN.test(slug)) {
      return { kind: "unrecognized", invoked, reason: "an entry in the tools list is not a Composio tool name" };
    }
    names.push(slug);
  }
  if (names.length === 0) return { kind: "passthrough" };
  return { kind: "tools", invoked, names };
}

/** Judge distinct target names against a bot's grants. grants undefined
 * is the legacy all-tools bot and passes everything; an explicit record —
 * including the empty one — allows only what it names. */
export function evaluateConnectorTools(
  names: string[],
  grants: Record<string, ConnectorToolGrant> | undefined,
): ConnectorVerdict {
  if (grants === undefined) {
    return { allowed: true, legacy: true, denials: [], rule: "composio" };
  }
  const denials: ConnectorDenial[] = [];
  let rule = "";
  for (const tool of new Set(names)) {
    const service = serviceSlugFor(tool);
    const grant = service === null ? undefined : grants[service];
    if (grant && (grant.tools === "*" || grant.tools.includes(tool))) {
      if (!rule) rule = "connectorTools." + service;
      continue;
    }
    denials.push({ tool, service, onGrantedService: Boolean(grant) });
  }
  return { allowed: denials.length === 0, legacy: false, denials, rule };
}

/** Safe to hand straight to the model: names the refused tool and says who
 * can change it. It never lists what the bot could have called instead —
 * a refusal that enumerates adjacent grants teaches the model to probe. */
export function connectorRefusalText(denials: ConnectorDenial[]): string {
  const named = denials.map((denial) => '"' + denial.tool + '"').join(", ");
  const one = denials.length === 1;
  return [
    named + " " + (one ? "is" : "are") + " not granted to this bot.",
    "This call was not performed.",
    "Ask the person to grant " + (one ? "it" : "these tools") + " in BotFleet if they want " + (one ? "it" : "them") + " run.",
  ].join("  ");
}

/** The unrecognized-shape refusal: names the meta-tool and what could not
 * be read, and still points at the person rather than at any tool list. */
export function connectorUnrecognizedText(invoked: string, reason: string): string {
  return [
    "A " + invoked + " call arrived in a shape BotFleet could not read (" + reason + "), so it was not performed.",
    "Send a well-formed call that names the tools to execute.",
    "Ask the person to grant any tool this bot needs.",
  ].join("  ");
}

/** Filter a tools/list result down to what a bot may call, so the model is
 * never shown a tool it cannot use. grants undefined (legacy) or an entry
 * shaped unexpectedly passes every tool through unfiltered — this is a UX
 * courtesy on top of the hard boundary evaluateConnectorTools already
 * enforces at call time, so failing open here costs nothing but a wasted,
 * clearly-refused attempt. */
export function filterConnectorToolsList(
  tools,
  grants: Record<string, ConnectorToolGrant> | undefined,
) {
  if (!Array.isArray(tools)) return [];
  if (grants === undefined) return tools;
  return tools.filter((tool) => {
    // SAFETY: the toString-call + !Array.isArray() guards restrict
    // tool to a JSON object, so the cast to { name } envelope is exact.
    const name = tool && (Object.prototype.toString.call(tool) === "[object Object]") && !Array.isArray(tool) ? (tool as { name?: unknown }).name : undefined;
    if (!(Object.prototype.toString.call(name) === "[object String]") || !name) return true;
    if (isUngatedToolName(name)) return true;
    const service = serviceSlugFor(name);
    const grant = service === null ? undefined : grants[service];
    return Boolean(grant && (grant.tools === "*" || grant.tools.includes(name)));
  });
}
