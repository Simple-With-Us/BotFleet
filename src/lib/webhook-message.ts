export interface WebhookMessageView {
  task: string;
  payload?: string;
  event?: string;
  project?: string;
  /** Issue title or event name — the line a person reads on the collapsed card. */
  headline: string;
  subtitle?: string;
}

const INSTRUCTION_MARKERS = [
  "AUTHENTICATED WEBHOOK TASK",
  "USER-CONFIGURED WEBHOOK INSTRUCTIONS",
  "DEFAULT WEBHOOK INSTRUCTIONS",
];

function block(text: string, marker: string): string | undefined {
  const match = text.match(new RegExp(`\\[${marker}\\]\\n([\\s\\S]*?)\\n\\[\\/${marker}\\]`));
  return match?.[1]?.trim() || undefined;
}

function metaLine(eventData: string, key: string): string | undefined {
  const match = eventData.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Best-effort Sentry (and similar) fields from the untrusted JSON body. */
export function webhookPayloadFields(payload: string): { title?: string; project?: string } {
  try {
    const root = asRecord(JSON.parse(payload));
    if (!root) return {};
    const data = asRecord(root.data) ?? root;
    const issue = asRecord(data.issue);
    const projectValue = issue?.project ?? data.project ?? root.project;
    let project: string | undefined;
    if (typeof projectValue === "string" && projectValue.trim()) project = projectValue.trim();
    else {
      const proj = asRecord(projectValue);
      const slug = proj?.slug ?? proj?.name;
      if (typeof slug === "string" && slug.trim()) project = slug.trim();
    }
    const titleValue = issue?.title ?? issue?.culprit ?? data.title ?? root.message;
    const title = typeof titleValue === "string" && titleValue.trim() ? titleValue.trim() : undefined;
    return { title, project };
  } catch {
    return {};
  }
}

/** Convert the model-safe webhook prompt into the smaller view shown in chat.
 * The stored message stays untouched, preserving the trust boundary for model
 * context and follow-up turns. */
export function webhookMessageView(text: string): WebhookMessageView | null {
  let task = "";
  for (const marker of INSTRUCTION_MARKERS) {
    const found = block(text, marker);
    if (found) {
      task = found;
      break;
    }
  }

  const eventData = block(text, "UNTRUSTED WEBHOOK EVENT DATA");
  if (!task || !eventData) return null;

  const splitAt = eventData.indexOf("\n\n");
  const payload = (splitAt >= 0 ? eventData.slice(splitAt + 2) : "").trim() || undefined;
  const event = metaLine(eventData, "Event");
  const fields = payload ? webhookPayloadFields(payload) : {};
  const headline = fields.title || event || "Incoming Webhook";
  const subtitleParts = [fields.project, event && event !== headline ? event : undefined].filter(Boolean);
  return {
    task,
    payload,
    event,
    project: fields.project,
    headline,
    subtitle: subtitleParts.length ? subtitleParts.join(" · ") : undefined,
  };
}
