/** The persisted message fields this pure projection needs. Keeping this
 * structural avoids pulling the renderer's TSX store into server tests. */
export interface TimelineMessage {
  id: string;
  role: "bot" | "user" | "system";
  kind: "text" | "options" | "activity" | "screen" | "connector" | "secret" | "sign-in";
  text?: string;
  tool?: { name: string; ok?: boolean };
  png?: string;
  at: number;
}

export interface TimelineEvent {
  id: string;
  at: number;
  label: string;
  state: "running" | "complete" | "failed" | "observed";
  kind: "task" | "tool" | "screen" | "result";
}

/** Turn an already-persisted transcript into a compact, honest timeline. It
 * deliberately derives only from events the harness has recorded — this UI
 * never guesses that an action or result happened. */
export function timelineEvents(messages: TimelineMessage[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  let sawTurnStart = false;
  for (const message of messages) {
    if (message.kind === "text" && (message.role === "user" || message.role === "system") && message.text?.trim()) {
      // The first turn-starter is always "Task started" regardless of role.
      // After that, label by what actually happened: a later "user" message
      // is a real reply typed by a person; a later "system" message is the
      // same routine/webhook/resource firing again in a reused thread, not
      // a person weighing in — do not borrow the human label for it.
      events.push({
        id: message.id,
        at: message.at,
        label: !sawTurnStart ? "Task started" : message.role === "user" ? "User input" : "Automated instruction",
        state: "observed",
        kind: "task",
      });
      sawTurnStart = true;
    } else if (message.kind === "activity" && message.tool) {
      const failed = message.tool.ok === false || message.tool.name.startsWith("error:");
      events.push({
        id: message.id,
        at: message.at,
        label: failed ? message.tool.name.replace(/^error:\s*/i, "") : message.tool.name,
        // An activity is appended at tool start and patched with its outcome.
        // Until that patch arrives, do not imply that the action succeeded.
        state: failed ? "failed" : message.tool.ok === true ? "complete" : "running",
        kind: "tool",
      });
    } else if (message.kind === "screen") {
      events.push({ id: message.id, at: message.at, label: "Screen observed", state: "observed", kind: "screen" });
    } else if (message.kind === "text" && message.role === "bot" && message.text?.trim()) {
      events.push({ id: message.id, at: message.at, label: "Response recorded", state: "complete", kind: "result" });
    }
  }
  return events;
}
