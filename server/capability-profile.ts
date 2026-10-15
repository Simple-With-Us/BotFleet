// Engine capability profiles, doomed-effort policy, and versioned wisdom.
//
// Companion to `computer-capability.ts`: reach answers which destinations an
// engine can be given; this module answers which task classes it can execute
// well, what setup it still needs, and how to run it efficiently.  The client
// may import it — same dependency ban as `computer-capability.ts`.

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
  shell: "always" | "with_host_grant" | "never";
  effortLevels: readonly string[];
  setupRequirements: string[];
  executionHints: string[];
}

export type DoomedVerdict = "refuse" | "warn";

/** Per-engine overrides when a task class is missing or degraded. */
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

/** Versioned fleet wisdom — confirmed patterns replace replayed folklore. */
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

export interface ProfileInput {
  driverKind: string;
  capabilities?: ComputerCapabilityFlags & {
    agentsMcp?: boolean;
    composioMcp?: boolean;
    images?: boolean;
    effortLevels?: readonly string[];
    queueing?: boolean;
  } | null;
  model: string;
  /** When false, grok coding is refused per DOOMED_POLICY. */
  hasHostComputer?: boolean;
}

function defaultApprovals(driverKind: string): Approvals {
  if (driverKind === "antigravityAgent") return "auto-deny";
  if (driverKind === "boxAgent") return "none";
  return "broker";
}

function defaultShell(
  driverKind: string,
  caps: ProfileInput["capabilities"],
): CapabilityProfile["shell"] {
  if (driverKind === "grok" || driverKind === "minimax" || driverKind === "openai-compat") {
    return caps?.localComputerMcp ? "with_host_grant" : "never";
  }
  if (caps?.toolLoop || caps?.computerMcp) return "always";
  return "never";
}

function defaultWorkspaceTools(driverKind: string): boolean {
  return driverKind !== "grok" && driverKind !== "boxAgent";
}

function wisdomForEngine(engine: string): WisdomEntry | undefined {
  return WISDOM.find((entry) => entry.engine === engine);
}

function hintsFromWisdom(engine: string): string[] {
  const entry = wisdomForEngine(engine);
  if (!entry) return [];
  const hints: string[] = [];
  if (entry.best_for.length) hints.push(`Best for: ${entry.best_for.join("; ")}.`);
  if (entry.avoid_for.length) hints.push(`Avoid: ${entry.avoid_for.join("; ")}.`);
  if (entry.anti_pattern.length) hints.push(`Anti-patterns: ${entry.anti_pattern.join("; ")}.`);
  return hints;
}

export function profileFor(input: ProfileInput): CapabilityProfile {
  const caps = input.capabilities ?? {};
  const reach = computerReach({ driverKind: input.driverKind, capabilities: caps });
  const transportKind = computerTransport({ driverKind: input.driverKind, capabilities: caps });

  const setupRequirements: string[] = [];
  const wisdom = wisdomForEngine(input.driverKind);
  if (wisdom?.setup_required.length) setupRequirements.push(...wisdom.setup_required);

  const executionHints = hintsFromWisdom(input.driverKind);
  if (input.driverKind === "dsh" && input.model.includes("pro") && !input.model.toLowerCase().includes("flash")) {
    executionHints.push("Visionless DSH models: switch to Flash before image attachments.");
  }

  const mcpVerified = input.driverKind !== "dshAgent";

  return {
    engine: input.driverKind,
    model: input.model,
    transport: transportKind,
    reach,
    approvals: defaultApprovals(input.driverKind),
    mcp: { mounted: Boolean(caps.computerMcp || caps.composioMcp || caps.agentsMcp), verified: mcpVerified },
    images: caps.images === true,
    steer: caps.queueing === true,
    dweb: false,
    workspaceTools: defaultWorkspaceTools(input.driverKind),
    shell: defaultShell(input.driverKind, caps),
    effortLevels: caps.effortLevels ?? [],
    setupRequirements,
    executionHints,
  };
}

export interface RequiredForInput {
  computers?: readonly ("cloud" | "vm" | "local")[];
  text: string;
  runOn?: "bot" | "cloud" | "vm";
  routineNeeds?: TaskClass[];
  skillCaps?: string[];
}

/** Deterministic task-class requirements for v1 — no prompt NLP. */
export function requiredFor(input: RequiredForInput): Set<TaskClass> {
  const required = new Set<TaskClass>();
  if (input.text.includes("<attached-image ")) required.add("images");
  if (input.runOn === "cloud" || input.computers?.includes("cloud")) required.add("cloud");
  if (input.runOn === "vm" || input.computers?.includes("vm")) required.add("vm");
  if (input.computers?.includes("local")) required.add("desktop_gui");
  if (input.skillCaps?.includes("phoneMcp") || input.skillCaps?.includes("composioMcp")) {
    required.add("connected_apps");
  }
  for (const need of input.routineNeeds ?? []) required.add(need);
  return required;
}

function profileSupports(profile: CapabilityProfile, task: TaskClass, hasHostComputer: boolean): boolean {
  switch (task) {
    case "chat":
      return true;
    case "coding":
      if (profile.engine === "grok" && !hasHostComputer && !profile.workspaceTools) return false;
      return profile.workspaceTools || profile.shell !== "never";
    case "shell":
      if (profile.shell === "always") return true;
      if (profile.shell === "with_host_grant") return hasHostComputer;
      return false;
    case "desktop_gui":
      return profile.reach.local && profile.approvals !== "auto-deny";
    case "vm":
      return profile.reach.vm;
    case "cloud":
      return profile.reach.box || profile.reach.vps;
    case "images":
      return profile.images;
    case "connected_apps":
      return profile.mcp.mounted && profile.mcp.verified;
    case "peer_comms":
      return profile.mcp.mounted;
    default: {
      const _exhaustive: never = task;
      return _exhaustive;
    }
  }
}

function policyVerdict(engine: string, task: TaskClass): DoomedVerdict | undefined {
  return DOOMED_POLICY[engine]?.[task];
}

function defaultVerdictForMissing(task: TaskClass, profile: CapabilityProfile): DoomedVerdict {
  if (task === "images" && !profile.images) return "refuse";
  if (task === "vm" && !profile.reach.vm) return "refuse";
  if (task === "desktop_gui") return "warn";
  return "refuse";
}

export function doomedReason(
  profile: CapabilityProfile,
  required: Set<TaskClass>,
  opts?: { hasHostComputer?: boolean },
): { taskClass: TaskClass; verdict: DoomedVerdict; reason: string } | null {
  const hasHost = opts?.hasHostComputer === true;
  for (const taskClass of required) {
    if (taskClass === "chat") continue;
    const supported = profileSupports(profile, taskClass, hasHost);
    if (supported) continue;
    const verdict = policyVerdict(profile.engine, taskClass) ?? defaultVerdictForMissing(taskClass, profile);
    const reason = incapableReason(profile, taskClass, hasHost);
    return { taskClass, verdict, reason };
  }
  return null;
}

export function incapableReason(profile: CapabilityProfile, taskClass: TaskClass, hasHostComputer: boolean): string {
  switch (taskClass) {
    case "images":
      return `${profile.engine} cannot open image attachments for model ${profile.model}`;
    case "vm":
      return `${profile.engine} cannot use the Local VM`;
    case "cloud":
      return `${profile.engine} cannot run cloud computer tasks`;
    case "desktop_gui":
      return `${profile.engine} cannot control This Computer${profile.approvals === "auto-deny" ? " (approvals unavailable)" : ""}`;
    case "coding":
      return hasHostComputer
        ? `${profile.engine} cannot run coding tools in the workspace`
        : `${profile.engine} needs a This Computer grant for coding tools`;
    case "shell":
      return hasHostComputer
        ? `${profile.engine} cannot run shell tools`
        : `${profile.engine} needs a This Computer grant for shell access`;
    case "connected_apps":
      return profile.mcp.verified
        ? `${profile.engine} cannot reach connected apps`
        : `${profile.engine} connected-apps MCP is not verified yet`;
    case "peer_comms":
      return `${profile.engine} cannot coordinate with other bots`;
    default:
      return `${profile.engine} cannot satisfy ${taskClass}`;
  }
}

/** True when the bot may use per-bot workspace file tools (not grok/box). */
export function worksInWorkspace(driverKind: string): boolean {
  return defaultWorkspaceTools(driverKind);
}

export function formatExecutionHints(profile: CapabilityProfile): string {
  if (!profile.executionHints.length) return "";
  return `[Engine capability hints for ${profile.engine}]\n${profile.executionHints.map((h) => `- ${h}`).join("\n")}`;
}

export function wisdomInspectPayload(engine?: string): {
  wisdom: WisdomEntry[];
  executionHintsByEngine: Record<string, string[]>;
} {
  const entries = engine ? WISDOM.filter((w) => w.engine === engine) : WISDOM;
  const executionHintsByEngine: Record<string, string[]> = {};
  for (const entry of entries) {
    executionHintsByEngine[entry.engine] = profileFor({
      driverKind: entry.engine,
      model: "default",
      capabilities: {},
    }).executionHints;
  }
  return { wisdom: entries, executionHintsByEngine };
}
