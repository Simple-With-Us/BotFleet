// Which lane, if any, an engine's background-job tools are mounted on (jobs
// P2; the HTTP lane is jobs P1).
//
// The decision lived twice — once in `jobsForTurn` for the tool-loop lane and
// once in `jobsForCliTurn` for the command-line lane — and each copy was a
// slightly different expression, which is how "the prompt says the bot has
// jobs but the mounted tools do not" happens.  So it is derived here, once,
// from flags the drivers already declare plus the owner's settings, and both
// call sites read the answer.
//
// Like `computer-capability.ts`, this module is dependency-free on purpose: it
// imports no `node:*` builtin and nothing from `server/index.ts`, so the
// fixtures table and its coverage check can load it without a harness.  It
// deliberately does NOT know about jobs being switched off in the registry, the
// Windows refusal, or admission: those are the registry's own fences, refused
// at the moment a job starts, and they are not a reason to withhold the tools.

/** The slice of driver capabilities this derivation reads. */
export interface JobLaneFlags {
  /** The harness runs the model-to-tool rounds itself (jobs P1 lane). */
  toolLoop?: boolean;
  /** The driver mounts `turn.integrations.agents` as MCP tools, which is how
   *  the command-line lane carries the job tools. */
  agentsMcp?: boolean;
  /** The engine runs BotFleet's own job tools. */
  backgroundJobs?: "none" | "emulated" | "native";
}

/** The owner's `jobs` settings, as far as the mount decision reads them. */
export interface JobLaneSettings {
  enabled: boolean;
  cliLanes: boolean;
}

export type JobLane = "http" | "mcp" | "none";

export interface JobLaneResult {
  lane: JobLane;
  /** Why, in the words a maintainer would use.  Never shown to a bot. */
  reason: string;
}

/** The lane an engine's job tools are mounted on, and why.
 *
 * `hostComputer` is a separate argument rather than a capability because a bot
 * holding "This Computer" is what a job needs: a job runs a real process, and
 * an engine with no host shell has nothing to run it on. */
export function jobLane(
  capabilities: JobLaneFlags,
  settings: JobLaneSettings,
  hostComputer: boolean,
): JobLaneResult {
  if (!settings.enabled) return { lane: "none", reason: "the owner turned jobs off" };
  if (capabilities.backgroundJobs !== "emulated") {
    return {
      lane: "none",
      reason:
        capabilities.backgroundJobs === "native"
          ? "this engine runs its own background work, which dies when the turn settles"
          : "this engine does not run BotFleet's job tools",
    };
  }
  if (!hostComputer) return { lane: "none", reason: "the bot does not hold This Computer" };
  if (capabilities.toolLoop === true) return { lane: "http", reason: "the harness runs this engine's tool rounds" };
  if (capabilities.agentsMcp !== true) return { lane: "none", reason: "this engine mounts no MCP server to carry the tools" };
  if (!settings.cliLanes) return { lane: "none", reason: "the owner turned the command-line job lane off" };
  return { lane: "mcp", reason: "the tools ride the agents MCP server" };
}
