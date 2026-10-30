import { isShortProviderErrorText, isTransientCapacityChip } from "./model-fallback.ts";
import type { RuntimeEvent } from "./contracts.ts";

const PREFIX_LIMIT = 512;
const MAX_PENDING_TOOLS = 256;
const LIFECYCLE_TOOL_TITLE = /^\s*(?:hookRun|reminderChild|workflow|subagent)(?=[\s:_-]|$)/i;
const ERROR_PREFIXES = [
  "error", "http", "429", "402", "rate limit", "rate_limit", "too many", "concurrency", "concurrent",
  "maximum", "max concurrent", "resource exhausted", "resource_exhausted", "internal", "api request failed",
  "provider error", "request failed", "service unavailable", "bad gateway", "session limit", "session cap",
  "usage limit", "usage cap", "subscription quota", "token plan", "plan limit", "billing", "insufficient",
  "credits", "out of credits", "you've hit", "you have hit", "you have exceeded", "your usage", "your quota",
  "we're receiving too many", "we are receiving too many", "muse:", "meta:", "claude:", "codex:", "grok:",
  "gemini:", "antigravity:", "deepseek:", "openai:", "{", "[", ">", '"', "'",
];

interface ActivityOwner { dispatchId: number }
interface StreamActivity { text: string; prefix: string; healthy: boolean }

/** Classify accumulated stream prefixes, rather than incomplete error fragments. */
export class ProviderRouteActivity {
  private readonly prefixes = new WeakMap<ActivityOwner, { assistant_text: StreamActivity; reasoning_text: StreamActivity }>();
  private readonly pendingTools = new WeakMap<ActivityOwner, Map<string, { threadId: string; turnId?: string }>>();

  /** Only a real tool that started on this dispatch can prove successful work. */
  observeTool(owner: ActivityOwner, event: RuntimeEvent): boolean {
    if ((event.type !== "item.started" && event.type !== "item.completed") || event.itemType !== "tool" || !event.itemId) {
      return false;
    }
    const pending = this.pendingTools.get(owner) ?? new Map<string, { threadId: string; turnId?: string }>();
    if (event.type === "item.started") {
      if (event.toolKind === "notice" || event.parentItemId || event.subagentId || LIFECYCLE_TOOL_TITLE.test(event.title ?? "")) {
        // Helper ids may overlap their parent's ids; an untyped notice collision
        // remains ambiguous and must not manufacture parent-model health.
        if (!event.parentItemId && !event.subagentId) pending.delete(event.itemId);
        return false;
      }
      pending.set(event.itemId, { threadId: event.threadId, turnId: event.turnId });
      while (pending.size > MAX_PENDING_TOOLS) pending.delete(pending.keys().next().value!);
      this.pendingTools.set(owner, pending);
      return false;
    }
    if (event.subagentId) return false;
    const started = pending.get(event.itemId);
    pending.delete(event.itemId);
    if (LIFECYCLE_TOOL_TITLE.test(event.title ?? "")) return false;
    if (!started || !event.ok || started.threadId !== event.threadId ||
      (started.turnId !== undefined && event.turnId !== undefined && started.turnId !== event.turnId)) return false;
    return ![event.title, event.detail].some((text) => text && (isShortProviderErrorText(text) || isTransientCapacityChip(text)));
  }

  observe(owner: ActivityOwner, stream: "assistant_text" | "reasoning_text", delta: string): boolean {
    const state = this.prefixes.get(owner) ?? {
      assistant_text: { text: "", prefix: "", healthy: false },
      reasoning_text: { text: "", prefix: "", healthy: false },
    };
    const activity = state[stream];
    if (activity.text.length === PREFIX_LIMIT || !delta) return activity.healthy;
    activity.text += delta.slice(0, PREFIX_LIMIT - activity.text.length);
    this.prefixes.set(owner, state);
    const prefix = activity.text.trim();
    if (prefix === activity.prefix) return activity.healthy;
    activity.prefix = prefix;
    if (!prefix || isShortProviderErrorText(prefix) || isTransientCapacityChip(prefix)) {
      activity.healthy = false;
      return false;
    }
    const normalized = prefix.toLowerCase().replace(/\s+/g, " ");
    activity.healthy = !ERROR_PREFIXES.some((candidate) => candidate.startsWith(normalized) || normalized.startsWith(candidate));
    return activity.healthy;
  }
}
