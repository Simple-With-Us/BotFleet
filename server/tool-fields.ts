// The two extra fields every driver puts on `item.started`.
//
// `shared/tool-activity.ts` holds the vocabulary because the client needs the
// same table; this is the Node-side convenience that fills in the home
// directory and hands back exactly the shape the event wants, so a driver
// spreads one call instead of repeating the same three lines nine times.
import { homedir } from "node:os";

import { toolActivity } from "../shared/tool-activity.ts";
import type { ToolKind } from "../shared/tool-activity.ts";

export interface ToolFields {
  target?: string;
  toolKind?: ToolKind;
}

/** `target` + `toolKind` for a tool step, from whatever payload the engine
 * reported.  `hint` is the engine's own kind when it has one (ACP does) — it
 * beats guessing from the name. */
export function toolFields(
  name: string | undefined,
  rawInput: unknown,
  options: { hint?: string; locations?: unknown; cwd?: string } = {},
): ToolFields {
  const activity = toolActivity(name, {
    hint: options.hint,
    rawInput,
    locations: options.locations,
    home: homedir(),
    cwd: options.cwd,
  });
  return { target: activity.target, toolKind: activity.kind };
}

/** OpenAI-shaped tool arguments arrive as a JSON *string*.  A partial or
 * malformed one is normal — arguments stream in fragments — so a parse
 * failure is not an error, it just means the row shows the tool's name and
 * nothing more. */
export function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
