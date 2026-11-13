// Which cloud backend a bot actually runs on, and what to call it.
//
// `bot.cloudBackend` is the bot's own choice, and it is unset far more often
// than not: a bot that never opened the picker inherits the workspace default.
// The server has always resolved it — `resolveCloudBackend` is called by the
// turn that mounts the computer and by every status, tunnel and lifecycle
// endpoint — and the client did not.  It read `bot.cloudBackend ?? "box"`,
// which is the workspace default's fallback wearing the answer's clothes.
//
// The cost was not a cosmetic label.  For a bot inheriting a `"vps"` default,
// `GET /api/bots/:id/computer` returns a VPS status body and the panel parsed
// it as a box one, named the destination "ASCII.dev Box", and offered the box
// lifecycle controls for a container living on the person's own server.
//
// So the answer lives here, once, for both panels — and it calls the server's
// resolver rather than restating the rule, because a second copy of a rule is
// how the first drift happened.
import { resolveCloudBackend } from "../../server/computer-grants.ts";
import type { CloudBackend } from "../../server/contracts.ts";

/** The bot fields this answer reads.  Deliberately narrow: this is a "where
 * does it run" question, not a bot editor. */
export interface CloudBackendBot {
  cloudBackend?: CloudBackend;
}

/** Where this bot's cloud computer actually is.
 *
 * `workspaceDefault` is `state.config.botDefaults.cloudBackend`.  The server
 * defaults that field itself, so it is always populated on the wire -- but the
 * client used to drop it from every config SSE frame, which quietly reduced
 * this to the bare `"box"` fallback after the first broadcast.  The frame now
 * carries it (`ConfigStatusFrame` in `src/state/store.tsx`); if it is ever
 * dropped again, this resolver degrades silently rather than loudly, so the
 * test below pins the inherited case. */
export function botCloudBackend(
  bot: CloudBackendBot,
  workspaceDefault?: CloudBackend,
): CloudBackend {
  return resolveCloudBackend(bot.cloudBackend, workspaceDefault);
}

/** True when that answer came from the workspace default rather than from
 * this bot.
 *
 * The picker highlights the resolved backend either way — a lit segment in a
 * segmented control means "this is what happens", and highlighting `box` for
 * a bot about to open a VPS is the same lie as the label was.  This is what
 * keeps that honest: it tells the person the choice is not yet theirs, and
 * that picking either segment pins it to this bot. */
export function cloudBackendInherited(bot: CloudBackendBot): boolean {
  return bot.cloudBackend === undefined;
}

/** What to call the cloud destination in the "Runs On" picker.
 *
 * Both panels name the same button, so they share the string.  The two labels
 * are not interchangeable: one is a computer BotFleet rents, the other is a
 * container on a machine the person pays for and can reach by SSH. */
export function cloudDestinationLabel(backend: CloudBackend): string {
  return backend === "vps" ? "Self-hosted VPS" : "ASCII.dev Box";
}
