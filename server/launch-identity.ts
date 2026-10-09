// The launcher contract: what BotFleet tells every engine child about who it
// is.
//
// An engine child is a claude, codex, ACP, agy or pi process BotFleet starts
// for one bot's turn.  It loads its own platform's rules files, skills and
// hooks, and those name a default seat (Claude's name CLAUDE, Codex's name
// CODEX).  Nothing in them knows the child is a bot BotFleet launched, so a
// plumber bot on the claude engine would act as CLAUDE.  The fix is to hand
// the child its identity in its environment, where the fleet tools read it
// and refuse any other:
//
//   AGENT_LAUNCHER=botfleet       a launcher started this session, so no
//                                 platform default applies
//   AGENT_LAUNCH_SEAT=<seat>      the seat BotFleet assigned, set by the
//                                 launcher only (skills never write it)
//   AGENT_SEAT=<seat>             the same value, for older readers
//   AGENT_SESSION=<thread id>     BotFleet's id for this bot's thread
//   AGENT_SYNC_ATTACH=0           the Claude hooks plugin never attaches a
//                                 session BotFleet launched
//
// It also removes every variable that could carry a different identity from
// the harness's own environment (a harness started from a seat's shell would
// otherwise pass that seat on) and every Zulip credential: BF bots post
// through BotFleet's own Zulip support (docs/zulip.md), so an engine never
// needs a key.
//
// The values are per bot and per turn, so they are applied where a child is
// spawned, not once per engine instance: two bots on one claude instance get
// two seats.  A bot whose name names no role still gets AGENT_LAUNCHER and no
// seat, so fleet tools refuse for it instead of falling back to a default.
//
// The seat itself is switched on by BOTFLEET_FLEET_SEAT_PROMPTS=1, the same
// switch as the seat sentence in the system prompt (server/seat-prompt.ts), so
// the environment and the prompt can never name different seats and an
// install that has not turned the operator fleet on carries no seat names.

import type { LaunchIdentity } from "./contracts.ts";

export type { LaunchIdentity } from "./contracts.ts";

export interface BotfleetRole {
  /** Lowercase slug: the file name in `bots/` and the `@fleet-seat:` value. */
  id: string;
  /** Title Case, as the role is spoken of in prose. */
  name: string;
  /** The fleet seat.  Literals, not built from the id, so the seat names are
   *  greppable and the privacy test's `BF-` marker finds nothing to ban. */
  seat: string;
}

/** The ten BotFleet role seats, in alphabetical order. */
export const BOTFLEET_ROLES = [
  { id: "builder", name: "Builder", seat: "BF-BUILDER" },
  { id: "compiler", name: "Compiler", seat: "BF-COMPILER" },
  { id: "deployer", name: "Deployer", seat: "BF-DEPLOYER" },
  { id: "designer", name: "Designer", seat: "BF-DESIGNER" },
  { id: "fixer", name: "Fixer", seat: "BF-FIXER" },
  { id: "housekeeper", name: "Housekeeper", seat: "BF-HOUSEKEEPER" },
  { id: "monitor", name: "Monitor", seat: "BF-MONITOR" },
  { id: "oracle", name: "Oracle", seat: "BF-ORACLE" },
  { id: "plumber", name: "Plumber", seat: "BF-PLUMBER" },
  { id: "publisher", name: "Publisher", seat: "BF-PUBLISHER" },
] as const satisfies readonly BotfleetRole[];

export type KnownBotfleetRole = (typeof BOTFLEET_ROLES)[number];

/** True when the harness assigns fleet seats and injects the seat prompt
 *  (Mac operator fleet).  Off, a launched child still gets AGENT_LAUNCHER and
 *  the scrub, and has no seat. */
export function fleetSeatPromptsEnabled(): boolean {
  return process.env.BOTFLEET_FLEET_SEAT_PROMPTS === "1";
}

const BF_PREFIX = /^BF[-_\s]+(.+)$/i;
const DESC_SEAT = /@fleet-seat:\s*([a-z0-9_-]+)/i;

function roleFromSlug(raw: string): KnownBotfleetRole | null {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/^bf[-_]/, "");
  return BOTFLEET_ROLES.find((role) => role.id === slug) ?? null;
}

/** The role a bot record names, or null when it names none.  In order:
 *  an `@fleet-seat:` line in its description, a `BF-` or `BF ` prefixed name,
 *  then a bare name that is exactly a role (`Plumber`, case folded).  A name
 *  that only contains a role word (`Plumber 2`) names none, and neither does
 *  `BF-Director`, which has no role seat. */
export function resolveBotfleetRole(bot: { name: string; description?: string | null }): KnownBotfleetRole | null {
  const fromDescription = bot.description?.match(DESC_SEAT)?.[1];
  if (fromDescription) {
    const role = roleFromSlug(fromDescription);
    if (role) return role;
  }
  const name = bot.name.trim();
  const prefixed = name.match(BF_PREFIX)?.[1];
  return roleFromSlug(prefixed ?? name);
}

/** The identity for one turn of one bot.  `threadId` is the thread the turn
 *  runs on (a room turn uses the room's thread). */
export function launchIdentityFor(
  bot: { name: string; description?: string | null },
  threadId: string,
): LaunchIdentity {
  const role = fleetSeatPromptsEnabled() ? resolveBotfleetRole(bot) : null;
  return { seat: role?.seat ?? null, session: threadId };
}

/** The variables a launched child is given.  A type alias, not an interface,
 *  so it is assignable to a process environment. */
export type LaunchEnvironment = {
  AGENT_LAUNCHER: "botfleet";
  AGENT_SYNC_ATTACH: "0";
  AGENT_LAUNCH_SEAT?: string;
  AGENT_SEAT?: string;
  AGENT_SESSION?: string;
};

/** The variables a launched child is given, in the form its environment
 *  takes.  `identity` absent means a launched child with no seat. */
export function launchEnvironment(identity?: LaunchIdentity): LaunchEnvironment {
  const env: LaunchEnvironment = { AGENT_LAUNCHER: "botfleet", AGENT_SYNC_ATTACH: "0" };
  if (identity?.seat) {
    env.AGENT_LAUNCH_SEAT = identity.seat;
    env.AGENT_SEAT = identity.seat;
  }
  if (identity?.session) env.AGENT_SESSION = identity.session;
  return env;
}

const SCRUB_NAMES = new Set(["AGENT_SEAT", "AGENT_TAG", "AGENT_SESSION", "CLAUDE_CODE_SESSION_ID"]);
const SCRUB_PREFIXES = ["AGENT_LAUNCH", "AGENT_SYNC_", "ZULIP_"];

/** Whether an inherited variable could carry another identity or a Zulip
 *  credential into a launched child.  Compared upper-cased: Windows
 *  environment names are case-insensitive. */
export function isLaunchIdentityName(name: string): boolean {
  const upper = name.toUpperCase();
  return SCRUB_NAMES.has(upper) || SCRUB_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** A copy of `env` for a launched child: every inherited identity and Zulip
 *  variable removed first, then this turn's launch variables set.  Applied to
 *  the merged environment (the harness's, the instance's, the driver's), so
 *  nothing configured earlier can survive it.  Never mutates its argument:
 *  an engine instance builds some environments once and shares them across
 *  turns. */
export function applyLaunchIdentity(
  env: Record<string, string | undefined>,
  identity?: LaunchIdentity,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!isLaunchIdentityName(name)) out[name] = value;
  }
  return Object.assign(out, launchEnvironment(identity));
}

/** Codex runs the model's shell commands under its own
 *  `shell_environment_policy`, which can hide the variables above from them
 *  (a user config with `include_only` does).  These `-c` overrides set the
 *  same values there.  Whether `set` survives an `include_only` list depends
 *  on the Codex build, so the owner's Codex config should also name these
 *  variables (docs/launch-identity.md). */
export function codexShellPolicyArgs(identity?: LaunchIdentity): string[] {
  const args: string[] = [];
  for (const [name, value] of Object.entries(launchEnvironment(identity))) {
    if (value !== undefined) args.push("-c", `shell_environment_policy.set.${name}=${JSON.stringify(value)}`);
  }
  return args;
}
