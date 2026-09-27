// Notifications — what is worth interrupting someone for.
//
// `BotRecord.notifications` has been a switch in the settings panel that
// nothing read. This is the thing that reads it. The rule it encodes is
// small and deliberate: a bot that is *blocked on you* is worth a buzz, and
// a bot that *finished* is worth one if you asked for it; everything else a
// bot does while it works is not.
//
// Delivery is a separate concern. The harness emits a frame; whoever is
// listening decides what to do with it — desktop banners, paired-phone
// local notifications while the companion is open, and APNs from the
// sidecar when a paired phone is not streaming.

export type NotifyKind = "approval" | "question" | "done" | "routine-failed" | "takeover";

export interface Notification {
  kind: NotifyKind;
  botId: string;
  botName: string;
  threadId: string;
  title: string;
  body: string;
  /** The bot's stored profile image, when it has one; clients show it as
   * the OS notification's icon so every banner carries its bot's face. */
  avatarUrl?: string;
  /** Which request is waiting, on the two kinds where something is.  A
   * phone answering Approve or Deny from a lock screen has no transcript
   * to search, so without this it has to guess which card the banner meant
   * — and a thread with two open cards makes that guess wrong. */
  requestId?: string;
  /** The tool that asked, for display and telemetry.  Nothing may depend
   * on it: an older harness sends neither field. */
  tool?: string;
}

/** The two kinds where a request is actually waiting on a person. */
export function isBlockingKind(kind: NotifyKind): boolean {
  return kind === "approval" || kind === "question";
}

/** One line, short enough for a lock screen, with the newlines, code
 * fences, and HTML entities (like &nbsp;) of a model's answer flattened out of it. */
export function summarize(text: string, max = 140): string {
  const line = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/g, " ")
    .replace(/&#xA0;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export interface NotifyBot {
  id: string;
  name: string;
  threadId: string;
  notifications?: boolean;
}

/** Build the frame for one event, or null when it should stay quiet.
 *
 * Kept pure and separate from the event fold so the policy — which is the
 * part people will argue about — can be read and tested on its own. */
export function buildNotification(
  kind: NotifyKind,
  bot: NotifyBot,
  threadId: string,
  detail: string,
  extra?: { avatarUrl?: string; requestId?: string; tool?: string; snoozed?: boolean },
): Notification | null {
  // The toggle means what it says: off is off, including for approvals.
  // A bot whose notifications you turned off can still block waiting for
  // you — that is the choice you made, and the chat still shows the card.
  if (bot.notifications === false) return null;
  // A snoozed thread is an alert the person asked not to get yet — either
  // this thread's own snooze or the bot-wide one it sits under.  Only the
  // banner is suppressed: nothing here owns unread, so the sidebar badge,
  // the transcript and any waiting approval card all still arrive, and the
  // moment the snooze ends the thread is loud again with no backlog to
  // replay.  Callers resolve the state (`shared/thread-snooze.ts`) so this
  // stays a pure policy function with no clock of its own.
  if (extra?.snoozed === true) return null;

  const body = summarize(detail);
  const title =
    kind === "approval"
      ? `${bot.name} needs approval`
      : kind === "question"
        ? `${bot.name} has a question`
        : kind === "takeover"
          ? `${bot.name} needs your hands`
          : kind === "routine-failed"
            ? `${bot.name}'s routine failed`
            : `${bot.name} finished`;

  // A "finished" with nothing to say is not worth a notification — the
  // badge in the sidebar already carries that much.
  if (kind === "done" && !body) return null;

  const frame: Notification = { kind, botId: bot.id, botName: bot.name, threadId, title, body };
  if (extra?.avatarUrl !== undefined) frame.avatarUrl = extra.avatarUrl;
  // Request identity belongs only to a frame where a request is waiting.
  // Enforced here rather than trusted to every call site, because a `done`
  // frame carrying a request id would invite a client to answer it.
  if (isBlockingKind(kind)) {
    if (extra?.requestId !== undefined) frame.requestId = extra.requestId;
    if (extra?.tool !== undefined) frame.tool = extra.tool;
  }
  return frame;
}
