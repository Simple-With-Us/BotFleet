// The per-bot Composio grant card's wording, kept out of the JSX so it can be
// read and tested as copy.  Two things this copy has to get right, both of
// which it got wrong when it lived inline:
//
//   1. Name the service.  "Connected Apps" reads like a BotFleet feature; the
//      accounts behind it are Composio's, and the user is being asked to hand a
//      bot their Gmail and Slack credentials.  Saying so is what makes the
//      grant legible — and App Settings → Connections already names Composio,
//      so this is consistency rather than a new disclosure.
//   2. Say what the toggle does in BOTH states.  Every other switch in this
//      panel means "on = the bot may do the thing".  This one has to say which
//      direction it runs, because the sibling restriction switch below it is
//      lit in the *narrower* state.

export const CONNECTED_APPS_HEADING = "Connected Apps via Composio";

export interface ConnectedAppsBlurbInput {
  /** App Settings → Connections has a working Composio service. */
  configured: boolean;
  /** The bot's engine exposes the Composio MCP tools. */
  canUse: boolean;
  /** The per-bot `composio` grant. Defaults on, so absent means enabled. */
  enabled: boolean;
  /** Apps a bot can actually use:  an active account, or a toolkit that needs
   *  no sign-in of its own.  Unknown when the inventory could not be read, so
   *  the copy never claims zero on a guess. */
  apps?: number | null;
  /** False when the inventory could not be read at all. */
  authoritative?: boolean;
}

export function connectedAppsBlurb({
  configured,
  canUse,
  enabled,
  apps = null,
  authoritative = true,
}: ConnectedAppsBlurbInput): string {
  if (!configured) {
    return "Composio is not set up for this workspace, so this bot has no apps to use.  Set it up in App Settings → Connections.";
  }
  if (!canUse) {
    return "This bot's engine cannot call Composio tools, so no connected app is reachable.";
  }
  // A service with nothing connected is not an app a bot can use, and saying
  // otherwise was the claim this copy got wrong.  An inventory that could not
  // be read is not a count of zero, so it keeps the old wording.
  if (authoritative && apps === 0) {
    return enabled
      ? "Composio is set up for this workspace, but nothing is connected yet, so this bot has no app to use.  Connect one in App Settings → Connections."
      : "Keep every connected Composio account off limits to this bot.  Nothing is connected yet.";
  }
  return enabled
    ? "Let this bot use the Gmail, Calendar, Slack, and other accounts you connected through Composio."
    : "Keep every connected Composio account off limits to this bot.";
}
