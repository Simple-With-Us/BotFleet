// Context windows (in tokens) for models whose size is published in official
// docs.  Only verified rows belong here; a model that is not listed has no
// known window and is never clamped.
//
// MiniMax: https://platform.minimax.io/docs/guides/text-generation
// (Supported Models and Legacy Models tables, read 2026-10-16).  The window is
// a fixed property of the model.  The 512K choice MiniMax Code offers is a
// client-side cap (Claude Code auto-compact window, Codex model_context_window),
// not a request parameter.
//
// The keys are the live catalog ids in lower case.  MiniMax renamed the M3.1
// Flash rows, and the rename did not move a window: the model publishes a
// fixed 1M window, and the 512K in the native driver's own catalog row is the
// client-side cap the picker offers, not a smaller model.
//
// Both rows therefore map to 1M here.  The dsh catalog declares
// `MiniMax-M3.1-Flash` with a 1M window, so a table entry of 524,288 for
// that shared id would clamp a dsh turn's own configured budget down by
// about half; `resolveAcpPromptBudget` treats this table as the clamp
// authority, so the published window is what belongs in it.
const WINDOWS: ReadonlyMap<string, number> = new Map([
  ["minimax-m3.1-flash", 1_000_000],
  ["minimax-m3.1-flash-1m", 1_000_000],
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
 *  `MiniMax-M3.1-Flash-thinking`), and the variant has the same window
 *  as the base model.  This mirrors `catalogMinimaxPriceKey` in
 *  gen-ai-cost.ts. */
export function contextWindowFor(model: string | undefined | null): number | undefined {
  if (!model) return undefined;
  const id = model.trim().toLowerCase();
  return (
    WINDOWS.get(id) ??
    WINDOWS.get(id.replace(/-thinking$/, "")) ??
    WINDOWS.get(id.replace(/-thinking(-1m)$/, "$1"))
  );
}
