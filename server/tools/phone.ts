// First-party Android phone tools for the HTTP driver lane.
//
// Same adb-driven logic drivers/phone-proxy.ts runs for CLI/ACP engines that
// mount it as a stdio MCP server — called in-process here instead, the same
// shift BASH/READ_FILE/WRITE_FILE/EDIT_FILE already made for host-computer
// tools. `screenshot` is intentionally omitted: the HTTP tool-loop contract
// (TurnToolOutcome) is text-only today, with no image/binary variant, so a
// PNG result has nowhere to go — read_screen's accessibility text is the
// substitute until that gap is closed as its own follow-up.

import { callTool } from "../drivers/phone-proxy.ts";
import type { ComputerToolExecutor } from "./computer.ts";

const ACTIONS = [
  "status",
  "read_screen",
  "list_apps",
  "open_app",
  "tap_text",
  "tap",
  "swipe",
  "type_text",
  "press",
] as const;

function toOutcome(result: Awaited<ReturnType<typeof callTool>>) {
  const text = result.content
    .map((part) => (part.type === "text" ? part.text : `[${part.type} content omitted on this lane]`))
    .join("\n")
    .trim();
  return result.isError
    ? ({ kind: "error", content: text || "phone tool failed", detail: "phone_error" } as const)
    : ({ kind: "result", content: text || "(no output)" } as const);
}

export function createPhoneTools(): Record<string, ComputerToolExecutor> {
  const executors: Record<string, ComputerToolExecutor> = {};
  for (const action of ACTIONS) {
    executors[`phone_${action}`] = async (call) => {
      try {
        return toOutcome(await callTool(action, call.arguments));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { kind: "error", content: message, detail: "phone_error" };
      }
    };
  }
  return executors;
}
