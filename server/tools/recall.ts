// Fleet-recall (Bot RAG) tools for the HTTP driver lane.
//
// Same business logic the CLI-lane MCP proxy runs (server/drivers/
// qdrant-proxy.ts, via server/recall-tools.ts) — called as a plain function
// here instead of over a spawned stdio JSON-RPC pipe, the same shift
// BASH/READ_FILE/WRITE_FILE/EDIT_FILE already made for host-computer tools.
// This module stays free of any `server/index.ts` dependency; the caller
// hands in the resolved settings.

import type { TurnToolOutcome } from "../contracts.ts";
import type { RecallSettings } from "../recall-transport.ts";
import { recallContributeWith, recallSearchWith, recallStatsWith, type RecallOutcome } from "../recall-tools.ts";
import type { ComputerToolExecutor } from "./computer.ts";

export interface RecallToolsOptions {
  settings: RecallSettings;
  /** Default `seat` for recall_contribute when the model omits one. */
  defaultSeat: string;
}

/** `ok: false` (not configured, bad arguments, a network/service error) is
 *  a failing tool call — `kind: "error"` — the same way every other tool
 *  in this PR (github.ts, phone.ts, and the pre-existing computer.ts)
 *  reports a failure, so the transcript chip and `TurnToolOutcome.kind`
 *  the driver loop reads actually reflect what happened instead of always
 *  reading as success. */
function toOutcome(result: RecallOutcome): TurnToolOutcome {
  return result.ok ? { kind: "result", content: result.text } : { kind: "error", content: result.text };
}

/** Mirrors qdrant-proxy.ts's own dispatch-level guard: the service and
 *  collection are chosen once in Settings, not per call — a model that
 *  tries to steer one call at a different collection gets told so
 *  instead of the argument being silently dropped. */
function collectionMismatch(settings: RecallSettings, args: Record<string, unknown>): TurnToolOutcome | null {
  if (args.collection && String(args.collection) !== settings.collection) {
    return {
      kind: "error",
      content: "Bot RAG cannot select a different collection for one call; select the service and collection in Settings.",
      detail: "invalid_argument",
    };
  }
  return null;
}

export function createRecallTools(options: RecallToolsOptions): Record<string, ComputerToolExecutor> {
  const recallSearch: ComputerToolExecutor = async (call) => {
    const mismatch = collectionMismatch(options.settings, call.arguments);
    if (mismatch) return mismatch;
    return toOutcome(await recallSearchWith(options.settings, call.arguments));
  };

  const recallContribute: ComputerToolExecutor = async (call) => {
    const mismatch = collectionMismatch(options.settings, call.arguments);
    if (mismatch) return mismatch;
    return toOutcome(await recallContributeWith(options.settings, options.defaultSeat, call.arguments));
  };

  const recallStats: ComputerToolExecutor = async () => toOutcome(await recallStatsWith(options.settings));

  return {
    recall_search: recallSearch,
    recall_contribute: recallContribute,
    recall_stats: recallStats,
  };
}
