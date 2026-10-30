import { createHash } from "node:crypto";

export function billedClaudeCallEventId(sessionId: string, callId: string): string {
  return `bf-call-v1:${createHash("sha256").update(JSON.stringify([sessionId, callId])).digest("hex")}`;
}

export interface ClaudeBilledCall {
  id: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function counts(raw: unknown): Pick<ClaudeBilledCall, "input" | "output" | "cacheRead" | "cacheWrite"> | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  const values = [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens];
  if (!values.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return null;
  if (usage.cache_creation && typeof usage.cache_creation === "object") {
    const split = usage.cache_creation as Record<string, unknown>;
    const parts = [split.ephemeral_5m_input_tokens ?? 0, split.ephemeral_1h_input_tokens ?? 0];
    if (!parts.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
        (parts[0] as number) + (parts[1] as number) !== values[3]) return null;
  }
  return { input: values[0] as number, output: values[1] as number, cacheRead: values[2] as number, cacheWrite: values[3] as number };
}

/** Exact proof for the deliberately narrow, single-call Claude turn subset.
 * Missing fields, changed streaming snapshots, multiple calls/results and
 * old CLIs without lifecycle ownership invalidate the entire proof.
 */
export class ClaudeSingleCallLedger {
  private invalid = false;
  private ownResults = 0;
  private pending: ClaudeBilledCall | undefined;
  private billed: ClaudeBilledCall | undefined;

  observe(message: unknown, lifecycleOwned: boolean): void {
    if (!lifecycleOwned || !message || typeof message !== "object") { this.invalid = true; return; }
    const msg = message as Record<string, unknown>;
    const usage = counts(msg.usage);
    if (typeof msg.id !== "string" || !msg.id || msg.id.length > 200 ||
        typeof msg.model !== "string" || !msg.model || msg.model.length > 200 || msg.model === "<synthetic>" || !usage) {
      this.invalid = true;
      return;
    }
    const call = { id: msg.id, model: msg.model, ...usage };
    if (this.pending && JSON.stringify(this.pending) !== JSON.stringify(call)) this.invalid = true;
    this.pending = call;
  }

  result(rawUsage: unknown, ours: boolean): void {
    const candidate = this.pending;
    this.pending = undefined;
    if (!ours) return;
    this.ownResults += 1;
    const expected = counts(rawUsage);
    if (this.ownResults !== 1 || !candidate || !expected ||
        candidate.input !== expected.input || candidate.output !== expected.output ||
        candidate.cacheRead !== expected.cacheRead || candidate.cacheWrite !== expected.cacheWrite) {
      this.invalid = true;
      return;
    }
    this.billed = candidate;
  }

  proof(): ClaudeBilledCall | undefined {
    return !this.invalid && this.ownResults === 1 && !this.pending ? this.billed : undefined;
  }
}
