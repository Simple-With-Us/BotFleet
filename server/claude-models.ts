import type { ModelCatalog } from "./contracts.ts";

// model catalog ported from upstream packages/contracts/src/model.ts
// Lives in a dependency-free module so model-fallback.ts can check built-in
// ids without importing the driver.
export const STATIC_CLAUDE_MODELS: ModelCatalog = {
  default: "claude-sonnet-5",
  options: [
    { id: "claude-fable-5-1", label: "Claude Fable 5.1", effortLevels: ["low", "medium", "high", "xhigh", "max"], supportsEffort: true },
    { id: "claude-opus-5", label: "Claude Opus 5", effortLevels: ["low", "medium", "high", "xhigh", "max"], supportsEffort: true },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", effortLevels: ["low", "medium", "high", "xhigh", "max"], supportsEffort: true },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", effortLevels: [], supportsEffort: false },
  ],
};
