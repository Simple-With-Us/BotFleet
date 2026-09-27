// Readable chip text for a saved model that is no longer in the engine's
// picker options (the picker stays latest-only, so an older saved selection
// such as `gpt-6-sol` has no row to borrow a label from).  Codex selections
// may be stored as `provider::model`; the provider prefix is dropped.  Only
// GPT ids are reshaped, to match the catalog's own labels ("GPT-5.6 Sol");
// any other id is shown as saved rather than guessed at.
// Display-only: never used to validate, route, or rewrite a saved model id.
const GPT_ID = /^gpt-(\d+(?:\.\d+)*)((?:-[a-z0-9]+)*)$/i;

export function readableModelLabel(id: string): string {
  const sep = id.lastIndexOf("::");
  const model = sep >= 0 ? id.slice(sep + 2) : id;
  const gpt = GPT_ID.exec(model);
  if (!gpt) return model || id;
  const words = gpt[2]
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return [`GPT-${gpt[1]}`, ...words].join(" ");
}
