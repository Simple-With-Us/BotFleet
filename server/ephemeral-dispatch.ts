/** One-shot automation wakes: run with no history replay, then post a single
 *  summary line back to the owning automation thread.
 *
 *  The workspace is keyed and reused so a storm does not mint a task per
 *  delivery.  The session is still fresh: dispatch clears the resume cursor
 *  and sends an empty transcript.  Classify, gate, and Designer UI-pass
 *  wakes take this path without an extra settings flag. */

export interface EphemeralResultDelivery {
  ownerThreadId: string;
  ephemeralThreadId: string;
  routineName: string;
  triggerSource?: string;
  ok: boolean;
  output?: string;
  error?: string;
}

const UI_PASS = /\bui[\s-]*pass\b/i;
const CLASSIFY_GATE = /\bclassify(?:\s*\/\s*|\s+)gate\b/i;
const CLASSIFY_WORD = /\bclassify\b/i;
const GATE_WORD = /\bgate\b/i;

/** True when this trigger's own name or saved instructions are a classify,
 *  gate, or Designer UI-pass wake.  Delivery payloads are not an input:
 *  a PR title that says "UI pass" must not flip an unrelated webhook. */
export function isClassifyOrUiPassWake(input: {
  name?: string;
  instructions?: string;
  id?: string;
}): boolean {
  const name = input.name ?? "";
  const instructions = input.instructions ?? "";
  const id = input.id ?? "";
  if (UI_PASS.test(name) || UI_PASS.test(instructions) || UI_PASS.test(id)) return true;
  if (CLASSIFY_GATE.test(name) || CLASSIFY_GATE.test(instructions) || CLASSIFY_GATE.test(id)) return true;
  if (CLASSIFY_WORD.test(name) || CLASSIFY_WORD.test(id)) return true;
  if (GATE_WORD.test(name) && CLASSIFY_WORD.test(instructions)) return true;
  return false;
}

/** Whether this run should dispatch as a one-shot.  An explicit `oneShotWake`
 *  flag counts, and so does a classify / UI-pass trigger.  Resource wakes
 *  and anything a person typed stay on the owning thread. */
export function wantsEphemeralDispatch(input: {
  triggerSource?: string;
  oneShotWake?: boolean;
  name?: string;
  instructions?: string;
  id?: string;
}): boolean {
  if (input.triggerSource !== "webhook" && input.triggerSource !== "schedule") return false;
  if (input.oneShotWake === true) return true;
  return isClassifyOrUiPassWake(input);
}

/** What a normal scheduled turn is told when Zulip tools are mounted.  A
 *  one-shot turn does not mount them, so it must not name `zulip_post`. */
export const SCHEDULE_ZULIP_POST_NOTE =
  " This task was started from an owner-saved routine.  If the saved instructions ask you to post an update to Zulip, use zulip_post; outbound channel policy and the secret scan still apply.";

/** The schedule sentence for this turn.  Empty when Zulip is not mounted,
 *  and empty on a one-shot wake, which leaves Zulip out of the tool catalog. */
export function scheduleAutomationNote(zulipMounted: boolean, oneShot: boolean): string {
  if (!zulipMounted || oneShot) return "";
  return SCHEDULE_ZULIP_POST_NOTE;
}

/** Standing line for a one-shot wake.  Stable across deliveries so a warm
 *  prefix can cache it. */
export const EPHEMERAL_DISPATCH_NOTE =
  " This is a one-shot classify or gate wake.  You have no earlier turns in this session.  Answer from the current message only, and put the verdict in your reply.  Do not message other bots, and do not continue another thread.";

export interface EphemeralPromptSection {
  id: string;
  label: string;
  text: string;
}

/** System-prompt sections for a one-shot wake: identity, the one-shot rule,
 *  and the untrusted-data note for whatever triggered it.  No peer roster
 *  and no tool catalog. */
export function ephemeralPromptSections(input: {
  persona: string;
  automationNote: string;
}): EphemeralPromptSection[] {
  return [
    { id: "persona", label: "Identity", text: input.persona },
    { id: "ephemeral", label: "One-shot", text: EPHEMERAL_DISPATCH_NOTE },
    { id: "automation", label: "Automation source", text: input.automationNote },
  ];
}

/** MCP surfaces a one-shot wake must not mount.  The peer roster and the
 *  connected-app, phone, recall, and custom catalogs are the fat prefix.
 *  Computer mounts stay, so a UI pass on a CLI engine can still read the diff. */
const EPHEMERAL_DROPPED_INTEGRATIONS = ["agents", "composio", "phone", "dweb", "qdrant", "custom"] as const;

export function stripEphemeralToolPrefix(integrations: {
  agents?: unknown;
  composio?: unknown;
  phone?: unknown;
  dweb?: unknown;
  qdrant?: unknown;
  custom?: unknown;
  computer?: unknown;
  localComputer?: unknown;
  computers?: unknown;
}): void {
  for (const key of EPHEMERAL_DROPPED_INTEGRATIONS) {
    integrations[key] = undefined;
  }
}

/** Text the owner thread receives after a one-shot wake settles. */
export function formatEphemeralResultMessage(input: EphemeralResultDelivery): string {
  const label = input.routineName.trim() || "Automation";
  if (!input.ok) {
    const detail = (input.error ?? "The bot did not complete this run").trim().slice(0, 500);
    return `[${label}] One-shot run failed: ${detail}`;
  }
  const body = (input.output ?? "").trim();
  if (!body) return `[${label}] One-shot run completed with no text output.`;
  return `[${label}] ${body}`;
}
