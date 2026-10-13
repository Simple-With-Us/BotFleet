/** One-shot automation wakes: run on a fresh thread with no history replay,
 *  then post a single summary line back to the owning automation thread. */

export interface EphemeralResultDelivery {
  ownerThreadId: string;
  ephemeralThreadId: string;
  routineName: string;
  triggerSource?: string;
  ok: boolean;
  output?: string;
  error?: string;
}

/** Text the owner thread receives after a one-shot wake settles. */
export function formatEphemeralResultMessage(input: EphemeralResultDelivery): string {
  const label = input.routineName.trim() || "Automation";
  if (!input.ok) {
    const detail = (input.error ?? "The bot did not complete this run").trim().slice(0, 500);
    return `[${label}] One-shot run failed: ${detail}`;
  }
  const body = (input.output ?? "").trim();
  if (!body) return `[${label}] One-shot run completed with no text output.`;
  return `[${label}] ${body}`;
}
