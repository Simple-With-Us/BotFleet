import { isShortProviderErrorText, isTransientCapacityChip } from "./model-fallback.ts";

const PREFIX_LIMIT = 512;
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
