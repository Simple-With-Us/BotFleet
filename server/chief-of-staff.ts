export interface ChiefTeamMember {
  id: string;
  name: string;
  title?: string;
  description?: string;
  /** Accepted and deliberately IGNORED by the roster: see the note on
   *  chiefOfStaffSystemPrompt.  Callers hand this function whole bot rows,
   *  and keeping the field declared is what makes "we chose not to print
   *  it" readable at the call site instead of looking like an omission. */
  busy?: boolean;
  hidden?: boolean;
  section?: string;
}

// The roster is interpolated into a TRUSTED bot's system prompt on every
// turn, and its inputs (name/title/description) are user-editable and — via
// team import — third-party-authored. Caps bound both the token spend and
// how much room an imported persona gets to talk to the Chief with system
// authority. agents-proxy applies the same discipline (120-char list_bots
// descriptions); these are the roster's own limits.
const ROSTER_MAX_BOTS = 40;
const ROSTER_NAME_MAX = 80;
const ROSTER_ROLE_MAX = 120;
const ROSTER_ABOUT_MAX = 200;

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

const sectionKey = (section?: string): string => section?.trim() || "";

/** Dynamic system context for a section's Chief of Staff.
 * It names the current team on every turn, while list_bots remains the
 * authoritative tool for IDs and live availability at delegation time.
 *
 * DELIBERATELY ABSENT: each teammate's live `busy` state.  This string
 * reaches the driver as `turn.system`, and the Claude driver passes it as
 * `--append-system-prompt`, which is part of the spawn fingerprint it
 * compares before handing the next turn to the warm process (`argsKey` in
 * drivers/claude.ts).  Interpolating availability here meant any teammate
 * starting or finishing a turn changed the Chief's fingerprint and tore its
 * CLI down for a `--resume` respawn, so the one bot BotFleet is built
 * around got the least benefit from session reuse.  The roster is
 * MEMBERSHIP — names, roles, about.  Availability is a live fact, and
 * list_bots is the tool that reports it freshly at the moment the Chief is
 * actually about to delegate.
 *
 * `availableAgentTools` is the tool-NAME set this Chief's turn actually has
 * — not a boolean — so a driver that can reach ask_bot but not create_bot /
 * delegate_bot (today's MiniMax, whose HTTP catalog stops at the registry's
 * three tools) is told it can delegate one-off work but not build a team,
 * rather than being handed the full CLI-lane paragraph regardless. */
export function chiefOfStaffSystemPrompt(
  chiefId: string,
  bots: ChiefTeamMember[],
  availableAgentTools: readonly string[],
  trustedBotFleetStatus = "",
): string {
  const chief = bots.find((bot) => bot.id === chiefId);
  const chiefSection = sectionKey(chief?.section);
  const sectionName = chiefSection || "General";
  const team = bots.filter(
    (bot) => bot.id !== chiefId && !bot.hidden && sectionKey(bot.section) === chiefSection,
  );
  const listed = team.slice(0, ROSTER_MAX_BOTS);
  const overflow = team.length - listed.length;
  const roster = team.length
    ? listed
        .map((bot) => {
          const name = clip(bot.name, ROSTER_NAME_MAX);
          const role = clip(bot.title?.trim() || "General assistant", ROSTER_ROLE_MAX);
          const about = bot.description?.trim();
          return `- ${name} — ${role}${about ? `: ${clip(about, ROSTER_ABOUT_MAX)}` : ""}`;
        })
        .join("\n") + (overflow > 0 ? `\n- …and ${overflow} more (use list_bots for the full roster).` : "")
    : "- No other visible bots are available yet.";

  const canAskBot = availableAgentTools.includes("ask_bot");
  const canDelegate = canAskBot && availableAgentTools.includes("delegate_bot");
  const canBuildTeam = canDelegate && availableAgentTools.includes("create_bot");
  const delegation = canAskBot
    ? [
        "Use list_bots to confirm the live roster, IDs, and who is busy right now — this prompt lists who is on the team, not who is free. Use ask_bot when a teammate is better suited to part of the request.",
        canBuildTeam
          ? "When the user asks you to assemble a team, use create_bot for each genuinely useful specialist. Give each one a clear role and instructions, then use delegate_bot to assign its work. Do not create duplicate or unnecessary bots."
          : undefined,
        // ask_bot holds this turn open for the peer's ENTIRE turn, and the
        // tool clock ends it eventually however patient the person is.
        // delegate_bot returns at once and the peer answers as its own turn,
        // which is the right shape for anything slow — so say so here, where
        // the Chief decides, rather than leaving it to be discovered by
        // timing out.
        canDelegate
          ? "ask_bot waits for the teammate's whole turn before you can continue, so prefer delegate_bot for anything that might run long — research, a build, a multi-step job — and keep ask_bot for a question you need answered before you can go on."
          : undefined,
        "Delegate with a clear, self-contained brief and wait for the teammate's actual reply before claiming its work is complete.",
        "You may consult more than one teammate when the request genuinely benefits, then combine their results into one coherent answer.",
      ]
        .filter(Boolean)
        .join(" ")
    : "Your current engine cannot contact teammates. Be honest about that limitation and ask the user to choose a delegation-compatible engine before promising coordinated work.";

  return [
    `You are the Chief of Staff for the ${sectionName} section. You are the user's primary contact for this section's team of bots.`,
    "Own the outcome: understand the request, decide what to handle yourself, coordinate the right specialists when useful, and return one concise consolidated answer.",
    "Do not delegate trivial work merely to appear busy. Never invent a teammate's progress or result. Normal permission and approval rules still apply.",
    delegation,
    `Current ${sectionName} section team:`,
    roster,
    trustedBotFleetStatus,
  ].filter(Boolean).join("\n");
}
