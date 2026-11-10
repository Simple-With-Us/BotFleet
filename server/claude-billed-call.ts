import { createHash } from "node:crypto";
import { z } from "zod";

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

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const UsageSchema = z.object({
  input_tokens: count, output_tokens: count, cache_read_input_tokens: count, cache_creation_input_tokens: count,
  cache_creation: z.object({ ephemeral_5m_input_tokens: count.optional(), ephemeral_1h_input_tokens: count.optional() }).optional(),
});
const MessageSchema = z.object({
  id: z.string().min(1).max(200),
  model: z.string().min(1).max(160).refine(model => model !== "<synthetic>"),
  usage: UsageSchema,
});
const UsageInputSchema = UsageSchema.partial();
const MessageInputSchema = MessageSchema.partial().extend({ usage: UsageInputSchema.optional() });
type UsageInput = z.infer<typeof UsageInputSchema> | undefined;
type MessageInput = z.infer<typeof MessageInputSchema> | undefined;

function counts(raw: UsageInput): Pick<ClaudeBilledCall, "input" | "output" | "cacheRead" | "cacheWrite"> | null {
  const parsed = UsageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const usage = parsed.data;
  const values = [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens];
  if (!Number.isSafeInteger(values.reduce((total, value) => total + value, 0))) return null;
  if (usage.cache_creation &&
      (usage.cache_creation.ephemeral_5m_input_tokens ?? 0) + (usage.cache_creation.ephemeral_1h_input_tokens ?? 0) !== usage.cache_creation_input_tokens) return null;
  return { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens };
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

  observe(message: MessageInput, lifecycleOwned: boolean): void {
    const parsed = MessageSchema.safeParse(message);
    if (!lifecycleOwned || !parsed.success) { this.invalid = true; return; }
    const msg = parsed.data;
    const usage = counts(msg.usage);
    if (!usage) {
      this.invalid = true;
      return;
    }
    const call = { id: msg.id, model: msg.model, ...usage };
    if (this.pending && JSON.stringify(this.pending) !== JSON.stringify(call)) this.invalid = true;
    this.pending = call;
  }

  result(rawUsage: UsageInput, ours: boolean): void {
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
