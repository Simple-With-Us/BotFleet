import { isShortProviderErrorText, isTransientCapacityChip } from "./model-fallback.ts";
import type { RuntimeEvent } from "./contracts.ts";

const PREFIX_LIMIT = 512;
const MAX_PENDING_TOOLS = 256;
const LIFECYCLE_TOOL_TITLE = /^\s*(?:hookRun|reminderChild|workflow|subagent)/i;
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

/** Classify accumulated stream prefixes, rather than incomplete error fragments. */
export class ProviderRouteActivity {
  private readonly prefixes = new WeakMap<ActivityOwner, { assistant_text: string; reasoning_text: string }>();
  private readonly pendingTools = new WeakMap<ActivityOwner, Map<string, { threadId: string; turnId?: string }>>();

  /** Only a real tool that started on this dispatch can prove successful work. */
  observeTool(owner: ActivityOwner, event: RuntimeEvent): boolean {
    if ((event.type !== "item.started" && event.type !== "item.completed") || event.itemType !== "tool" || !event.itemId) {
      return false;
    }
    const pending = this.pendingTools.get(owner) ?? new Map<string, { threadId: string; turnId?: string }>();
    if (event.type === "item.started") {
      if (event.toolKind === "notice" || event.parentItemId || event.subagentId || LIFECYCLE_TOOL_TITLE.test(event.title ?? "")) {
        pending.delete(event.itemId);
        return false;
      }
      pending.set(event.itemId, { threadId: event.threadId, turnId: event.turnId });
      while (pending.size > MAX_PENDING_TOOLS) pending.delete(pending.keys().next().value!);
      this.pendingTools.set(owner, pending);
      return false;
    }
    const started = pending.get(event.itemId);
    pending.delete(event.itemId);
    if (!started || !event.ok || event.subagentId || LIFECYCLE_TOOL_TITLE.test(event.title ?? "") ||
      started.threadId !== event.threadId || started.turnId !== event.turnId) return false;
    return ![event.title, event.detail].some((text) => text && (isShortProviderErrorText(text) || isTransientCapacityChip(text)));
  }

  observe(owner: ActivityOwner, stream: "assistant_text" | "reasoning_text", delta: string): boolean {
    const state = this.prefixes.get(owner) ?? { assistant_text: "", reasoning_text: "" };
    state[stream] = (state[stream] + delta).slice(0, PREFIX_LIMIT);
    this.prefixes.set(owner, state);
    const prefix = state[stream].trim();
    if (!prefix || isShortProviderErrorText(prefix) || isTransientCapacityChip(prefix)) return false;
    const normalized = prefix.toLowerCase().replace(/\s+/g, " ");
    return !ERROR_PREFIXES.some((candidate) => candidate.startsWith(normalized) || normalized.startsWith(candidate));
  }
}
