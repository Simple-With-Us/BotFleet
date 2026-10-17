// Context windows (in tokens) for models whose size is published in official
// docs.  Only verified rows belong here; a model that is not listed has no
// known window and is never clamped.
//
// MiniMax: https://platform.minimax.io/docs/guides/text-generation
// (Supported Models and Legacy Models tables, read 2026-10-16).  The window is
// a fixed property of the model.  The 512K choice MiniMax Code offers is a
// client-side cap (Claude Code auto-compact window, Codex model_context_window),
// not a request parameter.
const WINDOWS: ReadonlyMap<string, number> = new Map([
  ["minimax-m3.1-flash-preview", 1_000_000],
  ["minimax-m3", 1_000_000],
  ["minimax-m2.7", 204_800],
  ["minimax-m2.7-highspeed", 204_800],
  ["minimax-m2.5", 204_800],
  ["minimax-m2.5-highspeed", 204_800],
  ["minimax-m2.1", 204_800],
  ["minimax-m2.1-highspeed", 204_800],
  ["minimax-m2", 204_800],
]);

/** The published window for a model id, or undefined when it is not known.
 *  Matches the id exactly, ignoring case, after dropping a trailing
 *  `-thinking`: the mcode engine lists its models that way (for example
 *  `MiniMax-M3.1-Flash-Preview-thinking`), and the variant has the same window
 *  as the base model.  This mirrors `catalogMinimaxPriceKey` in
 *  gen-ai-cost.ts. */
export function contextWindowFor(model: string | undefined | null): number | undefined {
  if (!model) return undefined;
  const id = model.trim().toLowerCase();
  return WINDOWS.get(id) ?? WINDOWS.get(id.replace(/-thinking$/, ""));
}
