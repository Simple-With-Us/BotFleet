import { delegationMessageView } from "../shared/delegation-message.ts";
import type { RoutineRunTrigger } from "./routines.ts";

/** Only an attended first prompt or a bot's delegated payload can name a new task. */
export function firstTurnTitleText(
  text: string,
  automationSource?: RoutineRunTrigger,
  cardContinuation?: boolean,
): string | undefined {
  if (cardContinuation || !text.trim()) return undefined;
  if (!automationSource) return text;
  if (automationSource !== "delegation") return undefined;
  return delegationMessageView("system", text, undefined, "delegation")?.payload || undefined;
}
