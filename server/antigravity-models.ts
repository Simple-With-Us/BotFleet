import type { ModelCatalog } from "./contracts.ts";

// Static FALLBACK catalog for the Antigravity driver — never the primary
// source.  readAntigravityModelCatalog() reads the person's own `agy`
// settings first and only lands here when that read fails, and
// mergeLocalInject() layers any host::model routes on top.
//
// Aligned 2026-09-24 with the `agy` build the driver itself documents and was
// measured against, 1.1.26 (see the header of drivers/antigravity.ts).  The
// list below is every model id the driver and its tests name today: the
// `gemini-3.8-flash-high` default, the `gemini-3.6-flash-low` the snapshot
// probe spawns, and the ids antigravityQuotaCatalogId() has to resolve back
// to catalog identities.  The September 18 refresh (PR #485) updated four
// driver catalogs and missed this one, which is how the header came to claim
// 1.1.23 — whoever refreshes the fleet's catalogs next, this file is the
// fifth, and the version in this note moves with it.
export const STATIC_ANTIGRAVITY_MODELS: ModelCatalog = {
  default: "gemini-3.8-flash-high",
  options: [
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
    { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
    { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
    { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
    { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
    { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
    { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
    { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
    { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
    { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
    { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
  ],
};


/** Match reported names to catalog identities; opaque upstream IDs are not routes. */
export function antigravityQuotaCatalogId(model: { modelId: string; label: string }): string | undefined {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const id = normalize(model.modelId);
  const label = normalize(model.label);
  return STATIC_ANTIGRAVITY_MODELS.options.find((option) =>
    normalize(option.id) === id || normalize(option.label) === label || normalize(option.id) === label
  )?.id;
}
