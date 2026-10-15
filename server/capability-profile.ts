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

/** Per-engine overrides for deliberate degradation (antigravity desktop) or
 *  hard refusals seeded from the engine audit. */
export const DOOMED_POLICY: Record<string, Partial<Record<TaskClass, DoomedVerdict>>> = {
  antigravityAgent: { desktop_gui: "warn" },
  grok: { coding: "refuse" },
  dshAgent: { connected_apps: "warn" },
};

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
    best_for: ["long autonomous coding with MCP computers"],
    avoid_for: ["host approval cards", "unattended desktop control"],
    setup_required: ["agy CLI installed and signed in"],
    anti_pattern: ["dispatching desktop_gui without warning — approvals are auto-denied"],
    last_confirmed_by: "engine-audit",
    last_confirmed_at: "2026-09-25",
    confidence: 0.9,
  },
  {
    engine: "grok",
    best_for: ["fast API chat", "tool-loop tasks with host grant"],
    avoid_for: ["workspace file edits without host shell grant"],
    setup_required: ["XAI_API_KEY"],
    anti_pattern: ["coding turns on API Grok when the bot has no host terminal grant"],
    last_confirmed_by: "engine-audit",
    last_confirmed_at: "2026-09-25",
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
}

export interface CapabilityGateContext {
  hostShellGranted: boolean;
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

function driverExecutionHints(driverKind: string): string[] {
  const row = WISDOM.find((entry) => entry.engine === driverKind);
  if (!row) return [];
  const hints: string[] = [];
  if (row.best_for.length) hints.push(`Best for: ${row.best_for.join("; ")}.`);
  if (row.avoid_for.length) hints.push(`Avoid for: ${row.avoid_for.join("; ")}.`);
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
    setupRequirements: [],
    executionHints: driverExecutionHints(input.driverKind),
    composioMcp: caps.composioMcp === true,
    agentsMcp: caps.agentsMcp === true,
    ...patch,
  };
  return base;
}

export function requiredFor(input: RequiredForInput): Set<TaskClass> {
  const required = new Set<TaskClass>();
  const text = input.text ?? "";
  if (text.includes("<attached-image ")) required.add("images");
  if (input.routineNeeds?.length) {
    for (const need of input.routineNeeds) required.add(need);
  }
  if (input.skillCaps?.includes("phoneMcp")) required.add("connected_apps");
  const computers = input.computers ?? [];
  if (computers.includes("local")) required.add("desktop_gui");
  if (computers.includes("vm")) required.add("vm");
  if (computers.includes("cloud") || input.runOn === "cloud") required.add("cloud");
  if (computers.length > 0 || input.runOn === "cloud") {
    // File/shell work in a workspace-backed bot implies coding unless it is
    // only chat — grants narrow this later at mount time.
    if (!required.has("images")) required.add("coding");
  }
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
      return profile.workspaceTools || profile.transport === "mcpClient" || profile.transport === "harnessToolLoop";
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

function policyVerdict(
  engine: string,
  taskClass: TaskClass,
  policy: Record<string, Partial<Record<TaskClass, DoomedVerdict>>>,
): DoomedVerdict {
  const enginePolicy = policy[engine]?.[taskClass];
  if (enginePolicy) return enginePolicy;
  if (taskClass === "images" && engine !== "minimax") return "refuse";
  if (taskClass === "vm") return "refuse";
  return "refuse";
}

export function doomedReason(
  profile: CapabilityProfile,
  required: Set<TaskClass>,
  policy: Record<string, Partial<Record<TaskClass, DoomedVerdict>>> = DOOMED_POLICY,
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
