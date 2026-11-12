// Prompt assembly for unattended webhook and schedule turns.
//
// A provider prompt cache hits only on a byte-identical prefix.  These wakes
// carry a standing system prompt, tool schemas, and saved instructions that
// do not change between deliveries, plus a tail that does: timestamps, wake
// payloads, and per-run ids.  The tail has to follow the standing prefix.
// Model selection, tool execution, and the stored transcript are untouched.
import { volatileDigest } from "./system-prompt.ts";
import type { JsonSchemaObject } from "./tools/registry.ts";
import { TURN_REPLY_CUE } from "./turn-context.ts";

export interface WakePromptSection {
  id: string;
  label: string;
  text: string;
  volatile: boolean;
  bytes?: number;
}

export interface WakeToolSchema {
  name: string;
  description?: string;
  parameters?: JsonSchemaObject;
}

export interface ArrangedWakePrompt {
  /** Stable system sections, tool schemas, and hoisted saved instructions. */
  prefix: string;
  /** True when saved instructions moved into `prefix` and the per-wake tail is `userText`. */
  hoisted: boolean;
  system: string;
  systemStable: string;
  systemVolatile: string;
  volatileDigest: string;
  sections: Array<WakePromptSection & { bytes: number }>;
  bytes: { stable: number; volatile: number };
  userText: string;
}

const REPLAY_BOUNDARY = `\n\n${TURN_REPLY_CUE}\n\n`;

const RECEIVED_LINE = /^Received: \d{4}-\d{2}-\d{2}T/;
const DELIVERY_ID_LINE = /^Delivery ID: \S+$/;
const RUN_ID_LINE = /^Run ID: \S+$/;
const FOLD_COUNT_LINE = /^\(?\d+ deliveries arrived while this trigger was waiting\./;
const FOLD_OMITTED_LINE = /^\[Earlier deliveries omitted for length\]$/;
const FOLD_HEADER_LINE = /^(?:--- Delivery \d+ ---|--- \d+ ---)$/;

function isVolatileLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    RECEIVED_LINE.test(trimmed) ||
    DELIVERY_ID_LINE.test(trimmed) ||
    RUN_ID_LINE.test(trimmed) ||
    FOLD_COUNT_LINE.test(trimmed) ||
    FOLD_OMITTED_LINE.test(trimmed) ||
    FOLD_HEADER_LINE.test(trimmed)
  );
}

const UNTRUSTED_OPEN = /^\[UNTRUSTED (?:WEBHOOK EVENT DATA|RESOURCE SAMPLE)\]/;
const AUTHENTICATED_TASK_OPEN = /^\[AUTHENTICATED WEBHOOK TASK\]/;

function untrustedOpen(line: string): boolean {
  return UNTRUSTED_OPEN.test(line.trim());
}

function payloadBoundary(line: string): boolean {
  const trimmed = line.trim();
  return untrustedOpen(trimmed) || AUTHENTICATED_TASK_OPEN.test(trimmed);
}

/** Byte offset of the first payload/untrusted boundary, or -1. */
function payloadBoundaryOffset(text: string): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (payloadBoundary(line)) return offset;
    offset += line.length + (i < lines.length - 1 ? 1 : 0);
  }
  return -1;
}

/** True when a slice looks like replayed mid-thread history, not a bare wake. */
function hasReplayRolePrefix(segment: string): boolean {
  return /(?:^|\n)(?:User|Assistant): /.test(segment);
}

/** Byte offset where the current wake starts, after the last trusted replay cue.
 *  A cue after a payload boundary in the current wake is payload text, not a
 *  harness join.  The first cue may follow history that already contains an
 *  untrusted block;  those history lines are `User:` / `Assistant:` prefixed. */
function lastTrustedReplayEnd(text: string): number {
  let start = 0;
  let search = 0;
  let acceptedAny = false;
  while (true) {
    const at = text.indexOf(REPLAY_BOUNDARY, search);
    if (at < 0) break;
    const segment = text.slice(start, at);
    if (payloadBoundaryOffset(segment) >= 0) {
      if (acceptedAny || !hasReplayRolePrefix(segment)) break;
    }
    start = at + REPLAY_BOUNDARY.length;
    search = start;
    acceptedAny = true;
  }
  return start;
}

/** True when the current wake (after any trusted mid-thread cue) has no payload. */
export function unattendedCurrentWakeIsStandingText(text: string): boolean {
  return payloadBoundaryOffset(text.slice(lastTrustedReplayEnd(text))) < 0;
}

/** Split one wake body into saved instructions and the per-wake tail.
 *  Volatile lines keep their relative order.  The standing instructions keep
 *  theirs.  An untrusted block runs to the end of the body: the payload can
 *  contain the closer, so the first closer is not a boundary.  Nothing after
 *  the opening line is hoisted into the system prefix. */
export function splitUnattendedWakeText(text: string) {
  const stable: string[] = [];
  const volatile: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (payloadBoundary(line)) {
      volatile.push(lines.slice(i).join("\n"));
      break;
    }
    if (isVolatileLine(line)) {
      volatile.push(line.trim());
      continue;
    }
    stable.push(line);
  }
  return {
    stableContext: stable.join("\n").trim(),
    volatileTail: volatile.join("\n\n").trim(),
  };
}

/** The tool list an HTTP driver sends, in that order, as one stable block. */
export function canonicalToolSchemaBlock(tools: readonly WakeToolSchema[]): string {
  if (tools.length === 0) return "";
  const payload = tools.map((tool) => {
    const parameters = tool.parameters ?? { type: "object" as const, properties: {}, required: [] };
    if (tool.description === undefined) {
      return { type: "function" as const, function: { name: tool.name, parameters } };
    }
    return {
      type: "function" as const,
      function: { name: tool.name, description: tool.description, parameters },
    };
  });
  return `Tool schemas:\n${JSON.stringify(payload)}`;
}

function withBytes(section: WakePromptSection): WakePromptSection & { bytes: number } {
  return { ...section, bytes: Buffer.byteLength(section.text, "utf8"), volatile: section.volatile };
}

/** Order one unattended wake: stable prefix, then the per-wake tail.
 *  `sections` stay in their relative order inside each half.  Tool schemas
 *  and saved instructions sit after the stable system sections and before
 *  every volatile section. */
export function arrangeUnattendedWakePrompt(input: {
  sections: readonly WakePromptSection[];
  toolSchemas?: readonly WakeToolSchema[];
  wakeText: string;
  /** When false, schemas stay on the driver's tools field and out of the text. */
  inlineToolSchemas?: boolean;
}): ArrangedWakePrompt {
  const inline = input.inlineToolSchemas !== false;
  // Only a harness mid-thread cue starts the current wake.  A cue after the
  // first payload boundary of that wake is data and stays in the tail.
  const replayEnd = lastTrustedReplayEnd(input.wakeText);
  const head = input.wakeText.slice(0, replayEnd);
  const split = splitUnattendedWakeText(input.wakeText.slice(replayEnd));
  const hoisted = split.stableContext.length > 0 && split.volatileTail.length > 0;
  const schemaBlock = inline ? canonicalToolSchemaBlock(input.toolSchemas ?? []) : "";
  const stable = input.sections.filter((section) => !section.volatile);
  const volatile = input.sections.filter((section) => section.volatile);
  const added: WakePromptSection[] = [];
  if (schemaBlock) {
    const lead = stable.length > 0 || added.length > 0 ? "\n\n" : "";
    added.push({ id: "tool-schemas", label: "Tool schemas", text: `${lead}${schemaBlock}`, volatile: false });
  }
  if (hoisted) {
    const lead = stable.length > 0 || added.length > 0 ? "\n\n" : "";
    added.push({
      id: "wake-instructions",
      label: "Wake instructions",
      text: `${lead}${split.stableContext}`,
      volatile: false,
    });
  }
  const sections = [...stable, ...added, ...volatile].map(withBytes);
  const systemStable = sections.filter((section) => !section.volatile).map((section) => section.text).join("");
  const systemVolatile = sections.filter((section) => section.volatile).map((section) => section.text).join("");
  const system = sections.map((section) => section.text).join("");
  const userText = hoisted ? `${head}${split.volatileTail}` : input.wakeText;
  return {
    prefix: systemStable,
    hoisted,
    system,
    systemStable,
    systemVolatile,
    volatileDigest: volatileDigest(systemVolatile),
    sections,
    bytes: {
      stable: Buffer.byteLength(systemStable, "utf8"),
      volatile: Buffer.byteLength(systemVolatile, "utf8"),
    },
    userText,
  };
}

/** Log a cached-token count when the provider reported one.  Counts only. */
export function logReportedCachedTokens(usage: {
  input?: number;
  output?: number;
  cachedInput?: number;
} | undefined): void {
  if (!usage) return;
  const cached = usage.cachedInput;
  if (cached === undefined || !Number.isFinite(cached)) return;
  const input = usage.input !== undefined && Number.isFinite(usage.input) ? Math.round(usage.input) : 0;
  const output = usage.output !== undefined && Number.isFinite(usage.output) ? Math.round(usage.output) : 0;
  console.info(
    `[prompt-cache] cachedInputTokens=${Math.round(cached)} inputTokens=${input} outputTokens=${output}`,
  );
}
