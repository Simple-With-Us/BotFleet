// Readable chip text for a saved model that is no longer in the engine's
// picker options (the picker stays latest-only, so an older saved selection
// such as `gpt-6-sol` or `claude-3-7-sonnet` has no row to borrow a label
// from).  Codex selections may be stored as `provider::model`; the provider
// prefix is dropped.  Claude, GPT, and Grok ids take the label their model
// class gives them (shared/model-lineage.ts: "Claude Sonnet 3.7", "GPT-5.6
// Luna", "Grok 4.6"); other GPT ids are reshaped to the catalog's own style;
// any other id is shown as saved rather than guessed at.
// Display-only: never used to validate, route, or rewrite a saved model id.
import { anyLineageLabel } from "../../shared/model-lineage";

const GPT_ID = /^gpt-(\d+(?:\.\d+)*)((?:-[a-z0-9]+)*)$/i;

export function readableModelLabel(id: string): string {
  const sep = id.lastIndexOf("::");
  const model = sep >= 0 ? id.slice(sep + 2) : id;
  const lineage = anyLineageLabel(model);
  if (lineage) return lineage;
  const gpt = GPT_ID.exec(model);
  if (!gpt) return model || id;
  const words = gpt[2]
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return [`GPT-${gpt[1]}`, ...words].join(" ");
}
