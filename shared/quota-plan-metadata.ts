import { z } from "zod";

const displayTextSchema = z.string().max(500).refine((value) => {
  if (!value.trim()) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    // SAFETY: C0 and DEL can split a value, and so can the C1 range plus the
    // Unicode line and paragraph terminators, so the guard covers all of them.
    if (
      codePoint !== undefined &&
      (codePoint < 32 || codePoint === 127 || (codePoint >= 0x80 && codePoint <= 0x9f) ||
        codePoint === 0x2028 || codePoint === 0x2029)
    ) return false;
  }
  return true;
});

const quotaPlanMetadataSchema = z.object({
  detectedPlanName: displayTextSchema.optional().catch(undefined),
  userPlanName: displayTextSchema.optional().catch(undefined),
  userCostUsd: displayTextSchema.optional().catch(undefined),
  userRenewalDateText: displayTextSchema.optional().catch(undefined),
  userSubtitle: displayTextSchema.optional().catch(undefined),
  showCostAndRenewal: z.boolean().optional().catch(undefined),
  hasMismatch: z.boolean().catch(false),
});

/** Producer-reported identity and user-entered display details, kept separate. */
export type QuotaPlanMetadata = z.infer<typeof quotaPlanMetadataSchema>;

/** Metadata is display-only.  Unknown keys are stripped by the schema. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: local files and HTTP responses are untrusted JSON at this boundary and must be parsed from unknown.
export function parseQuotaPlanMetadata(value: unknown): QuotaPlanMetadata | undefined {
  const parsed = quotaPlanMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Captions never become billing settings or routing inputs. */
export function quotaPlanMetadataLines(value: QuotaPlanMetadata | undefined): string[] {
  if (!value) return [];
  const lines: string[] = [];
  if (value.detectedPlanName) lines.push(`Detected Plan: ${value.detectedPlanName}`);
  if (value.userPlanName) lines.push(`Entered Plan: ${value.userPlanName}`);
  if (value.userSubtitle) lines.push(value.userSubtitle);
  if (value.showCostAndRenewal === true) {
    if (value.userCostUsd) lines.push(`Entered Cost (USD): ${value.userCostUsd}`);
    if (value.userRenewalDateText) lines.push(`Entered Renewal: ${value.userRenewalDateText}`);
  }
  if (value.hasMismatch) lines.push("Detected and entered plans differ");
  return lines;
}
