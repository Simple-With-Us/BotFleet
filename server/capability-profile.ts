// Pre-dispatch capability gate: which task classes an engine can run, and
// which (engine, task-class) pairs are doomed before we spend a turn.
//
// Dependency-free like `computer-capability.ts` so the client can import the
// same answers the server gates on.  Callers pass host-grant and bot context
// in; this module does not read the store or registry.

import {
  computerReach,
  computerTransport,
  type ComputerCapabilityFlags,
  type ComputerReach,
  type ComputerTransport,
} from "./computer-capability.ts";

export type TaskClass =
  | "chat"
  | "coding"
  | "shell"
  | "desktop_gui"
  | "vm"
  | "cloud"
  | "images"
  | "connected_apps"
  | "peer_comms";

export type Approvals = "broker" | "auto-deny" | "none";

export type ShellPolicy = "always" | "with_host_grant" | "never";

export interface CapabilityProfile {
  engine: string;
  model: string;
  transport: ComputerTransport | null;
  reach: ComputerReach;
  approvals: Approvals;
  mcp: { mounted: boolean; verified: boolean };
  images: boolean;
  steer: boolean;
  dweb: boolean;
  workspaceTools: boolean;
  shell: ShellPolicy;
  effortLevels: readonly string[];
  setupRequirements: string[];
  executionHints: string[];
  composioMcp: boolean;
  agentsMcp: boolean;
}

export type DoomedVerdict = "refuse" | "warn";

export type DriverKind = string;

export type DoomedPolicy = Record<string, Partial<Record<TaskClass, DoomedVerdict>>>;

/** Per-engine overrides for deliberate degradation (antigravity desktop) or
 *  hard refusals seeded from the engine audit.  `satisfies` checks the
 *  policy without annotating the binding as an open dictionary. */
export const DOOMED_POLICY = {
  antigravityAgent: { desktop_gui: "warn" },
  grok: { coding: "refuse" },
  dshAgent: { connected_apps: "warn" },
} satisfies DoomedPolicy;

export interface WisdomEntry {
  engine: string;
  best_for: string[];
  avoid_for: string[];
  setup_required: string[];
  anti_pattern: string[];
  last_confirmed_by: string;
  last_confirmed_at: string;
  confidence: number;
}

export const WISDOM: WisdomEntry[] = [
  {
    engine: "antigravityAgent",
    best_for: ["long autonomous coding sessions with MCP tools"],
    avoid_for: ["unattended This Computer desktop control — approvals are auto-denied"],
    setup_required: ["Antigravity CLI logged in", "This Computer grant only when a person is at the keyboard"],
    anti_pattern: ["Scheduling GUI routines on Antigravity while unattended"],
    last_confirmed_by: "BF-DIRECTOR",
    last_confirmed_at: "2026-09-22",
    confidence: 0.9,
  },
  {
    engine: "grok",
    best_for: ["fast tool-loop turns on the host with a This Computer grant"],
    avoid_for: ["workspace file tools without host grant", "image attachments", "failover target for coding/file work"],
    setup_required: ["xAI credentials", "This Computer grant for shell/file tools"],
    anti_pattern: ["Failing over a Claude coding turn to Grok HTTP"],
    last_confirmed_by: "BF-DIRECTOR",
    last_confirmed_at: "2026-09-22",
    confidence: 0.9,
  },
  {
    engine: "dshAgent",
    best_for: ["DeepSeek via DSH with standard MCP coding tools"],
    avoid_for: ["connected-apps workflows before MCP verification lands"],
    setup_required: ["DSH CLI", "dsh login"],
    anti_pattern: ["Assuming Composio mounts are verified on DSH"],
    last_confirmed_by: "BF-DIRECTOR",
    last_confirmed_at: "2026-09-22",
    confidence: 0.75,
  },
  {
    engine: "dsh",
    best_for: ["harness DeepSeek with vision-aware model routing"],
    avoid_for: ["image turns on visionless Pro row — route to Flash first"],
    setup_required: ["DeepSeek Harness configured"],
    anti_pattern: ["Leaving <attached-image> on a visionless DSH model"],
    last_confirmed_by: "CURSOR",
    last_confirmed_at: "2026-10-15",
    confidence: 0.85,
  },
];

export interface ProfileForInput {
  instanceId: string;
  driverKind: string;
  capabilities: ComputerCapabilityFlags & {
    images?: boolean;
    composioMcp?: boolean;
    agentsMcp?: boolean;
    queueing?: boolean;
    effortLevels?: readonly string[];
    toolLoop?: boolean;
    computerMcp?: boolean;
  };
  model: string;
}

export interface RequiredForInput {
  computers?: readonly ("cloud" | "vm" | "local")[];
  text: string;
  routineNeeds?: TaskClass[];
  skillCaps?: string[];
  runOn?: "bot" | "cloud";
  hostShellGranted?: boolean;
  /** Routine prompts may echo user markup; do not treat that as an image turn. */
  ignorePromptImageMarkers?: boolean;
}

export interface CapabilityGateContext {
  hostShellGranted: boolean;
}

export interface WisdomInspectPayload {
  wisdom: WisdomEntry[];
  executionHintsByEngine: Record<string, string[]>;
}

export interface CapabilityGateResult {
  action: "ok" | "warn" | "refuse";
  taskClass?: TaskClass;
  verdict?: DoomedVerdict;
  reason?: string;
  profile: CapabilityProfile;
  required: Set<TaskClass>;
}

const TASK_CLASS_ORDER: TaskClass[] = [
  "images",
  "vm",
  "cloud",
  "desktop_gui",
  "shell",
  "coding",
  "connected_apps",
  "peer_comms",
  "chat",
];

function defaultApprovals(driverKind: string): Approvals {
  if (driverKind === "antigravityAgent") return "auto-deny";
  if (driverKind === "boxAgent") return "none";
  return "broker";
}

function defaultShell(driverKind: string): ShellPolicy {
  if (driverKind === "grok") return "with_host_grant";
  if (driverKind === "boxAgent") return "never";
  return "always";
}

function defaultWorkspaceTools(driverKind: string): boolean {
  return driverKind !== "grok" && driverKind !== "boxAgent";
}

function defaultImages(cap: ProfileForInput["capabilities"], driverKind: string): boolean {
  if (driverKind === "grok") return false;
  return cap.images === true;
}

function wisdomForEngine(engine: string): WisdomEntry | undefined {
  return WISDOM.find((entry) => entry.engine === engine);
}

function driverExecutionHints(driverKind: string, model: string): string[] {
  const row = wisdomForEngine(driverKind);
  if (!row) return [];
  const hints: string[] = [];
  if (row.best_for.length) hints.push(`Best for: ${row.best_for.join("; ")}.`);
  if (row.avoid_for.length) hints.push(`Avoid: ${row.avoid_for.join("; ")}.`);
  if (row.anti_pattern.length) hints.push(`Anti-patterns: ${row.anti_pattern.join("; ")}.`);
  if (driverKind === "dsh" && model.includes("pro") && !model.toLowerCase().includes("flash")) {
    hints.push("Visionless DSH models: switch to Flash before image attachments.");
  }
  return hints;
}

export function profileFor(input: ProfileForInput): CapabilityProfile {
  const transport = computerTransport(input);
  const reach = computerReach(input);
  const caps = input.capabilities;
  const patch: Partial<CapabilityProfile> = {};
  if (input.driverKind === "dshAgent") {
    patch.mcp = { mounted: true, verified: false };
  }
  const base: CapabilityProfile = {
    engine: input.driverKind,
    model: input.model,
    transport,
    reach,
    approvals: defaultApprovals(input.driverKind),
    mcp: { mounted: transport === "mcpClient", verified: input.driverKind !== "dshAgent" },
    images: defaultImages(caps, input.driverKind),
    steer: caps.queueing === true,
    dweb: caps.toolLoop === true || caps.computerMcp === true,
    workspaceTools: defaultWorkspaceTools(input.driverKind),
    shell: defaultShell(input.driverKind),
    effortLevels: caps.effortLevels ?? [],
    setupRequirements: wisdomForEngine(input.driverKind)?.setup_required ?? [],
    executionHints: driverExecutionHints(input.driverKind, input.model),
    composioMcp: caps.composioMcp === true,
    agentsMcp: caps.agentsMcp === true,
    ...patch,
  };
  return base;
}

/** The composer writes this exact tag.  A bare mention of the words does not
 *  count: webhook text that talks about the marker must not skip a routine. */
const ATTACHED_IMAGE_TAG = /<attached-image\s+path="[^"]*"\s*\/>/;

export function promptNeedsImages(text: string): boolean {
  return ATTACHED_IMAGE_TAG.test(text);
}

export function requiredFor(input: RequiredForInput): Set<TaskClass> {
  const required = new Set<TaskClass>();
  const text = input.text ?? "";
  if (!input.ignorePromptImageMarkers && promptNeedsImages(text)) required.add("images");
  if (input.routineNeeds?.length) {
    for (const need of input.routineNeeds) required.add(need);
  }
  if (input.skillCaps?.includes("phoneMcp")) required.add("connected_apps");
  const computers = input.computers ?? [];
  if (computers.includes("local")) required.add("desktop_gui");
  if (computers.includes("vm")) required.add("vm");
  if (computers.includes("cloud") || input.runOn === "cloud") required.add("cloud");
  if (!required.size) required.add("chat");
  return required;
}

function satisfies(profile: CapabilityProfile, taskClass: TaskClass, ctx: CapabilityGateContext): boolean {
  switch (taskClass) {
    case "chat":
      return true;
    case "images":
      return profile.images;
    case "vm":
      return profile.reach.vm;
    case "cloud":
      return profile.reach.box || profile.reach.vps;
    case "desktop_gui":
      return profile.reach.local || profile.reach.vm || profile.reach.box || profile.reach.vps;
    case "shell":
      if (profile.shell === "never") return false;
      if (profile.shell === "with_host_grant") return ctx.hostShellGranted;
      return true;
    case "coding":
      // boxAgent edits files on the machine it is already running on.  A
      // tool-loop engine whose shell needs a host grant (Grok HTTP) cannot
      // code until that grant exists; otherwise the policy refuse never fires.
      if (profile.transport === "remoteAgent") return true;
      if (profile.workspaceTools || profile.transport === "mcpClient") return true;
      if (profile.transport === "harnessToolLoop") {
        if (profile.shell === "with_host_grant") return ctx.hostShellGranted;
        return true;
      }
      return false;
    case "connected_apps":
      return profile.composioMcp;
    case "peer_comms":
      return profile.agentsMcp;
    default: {
      const _exhaustive: never = taskClass;
      return _exhaustive;
    }
  }
}

function missingReason(profile: CapabilityProfile, taskClass: TaskClass): string {
  switch (taskClass) {
    case "images":
      return `${profile.engine} cannot read image attachments on model ${profile.model}`;
    case "vm":
      return `${profile.engine} cannot reach a Local VM`;
    case "cloud":
      return `${profile.engine} cannot run on a cloud computer`;
    case "desktop_gui":
      return `${profile.engine} cannot drive a desktop GUI on this bot`;
    case "shell":
      return `${profile.engine} cannot run host shell commands without a grant`;
    case "coding":
      return `${profile.engine} cannot edit files in the bot workspace`;
    case "connected_apps":
      return `${profile.engine} cannot mount connected apps (Composio)`;
    case "peer_comms":
      return `${profile.engine} cannot coordinate with other bots`;
    case "chat":
      return `${profile.engine} cannot chat`;
    default: {
      const _exhaustive: never = taskClass;
      return String(_exhaustive);
    }
  }
}

function hardRefusal(taskClass: TaskClass): boolean {
  switch (taskClass) {
    case "images":
    case "vm":
    case "cloud":
    case "desktop_gui":
    case "shell":
    case "coding":
      return true;
    case "connected_apps":
    case "peer_comms":
    case "chat":
      return false;
    default: {
      const _exhaustive: never = taskClass;
      return _exhaustive;
    }
  }
}

function policyVerdict(engine: string, taskClass: TaskClass, policy: DoomedPolicy): DoomedVerdict {
  const enginePolicy = policy[engine]?.[taskClass];
  if (enginePolicy) return enginePolicy;
  // A missing hard class cannot succeed, so the turn is not spent.  Connected
  // apps and peer comms warn: the turn can still run with that surface absent.
  return hardRefusal(taskClass) ? "refuse" : "warn";
}

export function doomedReason(
  profile: CapabilityProfile,
  required: Set<TaskClass>,
  policy: DoomedPolicy = DOOMED_POLICY,
  ctx: CapabilityGateContext = { hostShellGranted: true },
): { taskClass: TaskClass; verdict: DoomedVerdict; reason: string } | null {
  for (const taskClass of TASK_CLASS_ORDER) {
    if (!required.has(taskClass)) continue;
    if (satisfies(profile, taskClass, ctx)) continue;
    const verdict = policyVerdict(profile.engine, taskClass, policy);
    return { taskClass, verdict, reason: missingReason(profile, taskClass) };
  }
  return null;
}

export function evaluateCapabilityGate(
  profileInput: ProfileForInput,
  requiredInput: RequiredForInput,
  ctx: CapabilityGateContext,
): CapabilityGateResult {
  const profile = profileFor(profileInput);
  const required = requiredFor(requiredInput);
  const doomed = doomedReason(profile, required, DOOMED_POLICY, ctx);
  if (!doomed) return { action: "ok", profile, required };
  if (doomed.verdict === "warn") {
    return { action: "warn", profile, required, taskClass: doomed.taskClass, verdict: doomed.verdict, reason: doomed.reason };
  }
  return { action: "refuse", profile, required, taskClass: doomed.taskClass, verdict: doomed.verdict, reason: doomed.reason };
}

/** True when the bot may use per-bot workspace file tools (not grok/box). */
export function worksInWorkspace(driverKind: string): boolean {
  return defaultWorkspaceTools(driverKind);
}

export function formatExecutionHints(profile: CapabilityProfile): string {
  if (!profile.executionHints.length) return "";
  return `[Engine capability hints for ${profile.engine}]\n${profile.executionHints.map((hint) => `- ${hint}`).join("\n")}`;
}

export function wisdomInspectPayload(engine?: string) {
  const entries = engine ? WISDOM.filter((row) => row.engine === engine) : WISDOM;
  const pairs = entries.map((entry) => {
    const hints = profileFor({
      instanceId: entry.engine,
      driverKind: entry.engine,
      capabilities: {},
      model: "default",
    }).executionHints;
    return [entry.engine, hints] as const;
  });
  return { wisdom: entries, executionHintsByEngine: Object.fromEntries(pairs) };
}
