import type { ModelCatalog } from "./contracts.ts";

// model catalog ported from upstream packages/contracts/src/model.ts
// Lives in a dependency-free module so model-fallback.ts can check built-in
// ids without importing the driver.
//
// Opus 5.5 and Sonnet 5.5 are the current Opus and Sonnet.  Opus 5 and
// Sonnet 5 stay as rows so a saved selection on them still counts as an
// official id (see resolveClaudeTurnModel in drivers/claude.ts), but pickers
// never offer them once a newer member is runnable: shared/model-lineage.ts
// hides a superseded class member and moves saved selections forward.
// Sonnet 5.5 is the static default, and it is only published for a Claude
// CLI that lists it (2.1.284+).  server/model-lineage.ts drops it, and Opus
// 5.5 (2.1.280+), from the catalog an older CLI is shown.
export const STATIC_CLAUDE_MODELS: ModelCatalog = {
  default: "claude-sonnet-5-5",
  options: [
    { id: "claude-fable-5-1", label: "Claude Fable 5.1", effortLevels: ["low", "medium", "high", "xhigh", "max"], supportsEffort: true },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", effortLevels: ["low", "medium", "high", "xhigh", "max"], supportsEffort: true },
    { id: "claude-opus-5", label: "Claude Opus 5", effortLevels: ["low", "medium", "high", "xhigh", "max"], supportsEffort: true },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", effortLevels: ["low", "medium", "high", "xhigh", "max"], supportsEffort: true },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", effortLevels: ["low", "medium", "high", "xhigh", "max"], supportsEffort: true },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", effortLevels: [], supportsEffort: false },
  ],
};
