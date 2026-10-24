// How a handoff says no.
//
// One `coordinate_bots` call can name several bots, and each can refuse for
// its own reason: switched off, hidden, in another section, not a bot at all.
// The reasons are listed together, so the asker sees every bot that failed and
// why in one answer and can fix them in one retry, instead of learning about
// them one round at a time.  Both tool lanes (the MCP proxy and the HTTP tool
// host) and the job host list them through this one function so the format
// cannot drift between them.

/** The reasons a handoff was turned away, as one line.  Each reason is said
 *  once, in the order it came; it should name the bot it is about. */
export function joinRefusals(reasons: readonly string[]): string {
  return [...new Set(reasons)].join("; ");
}
