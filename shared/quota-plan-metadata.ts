/** Producer-reported identity and user-entered display details, kept separate. */
export type QuotaPlanMetadata = {
  detectedPlanName?: string;
  userPlanName?: string;
  userCostUsd?: string;
  userRenewalDateText?: string;
  userSubtitle?: string;
  showCostAndRenewal?: boolean;
  hasMismatch: boolean;
};

/** Metadata is display-only.  Refuse unknown fields and malformed values. */
export function parseQuotaPlanMetadata(value: unknown): QuotaPlanMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const result: QuotaPlanMetadata = { hasMismatch: raw.hasMismatch === true };
  const fields = ["detectedPlanName", "userPlanName", "userCostUsd", "userRenewalDateText", "userSubtitle"] as const;
  for (const key of fields) {
    const text = raw[key];
    if (typeof text === "string" && text.length <= 500 && !/[\x00-\x1f\x7f]/.test(text) && text.trim()) {
      result[key] = text;
    }
  }
  if (typeof raw.showCostAndRenewal === "boolean") result.showCostAndRenewal = raw.showCostAndRenewal;
  return result;
}

/** Captions never become billing settings or routing inputs. */
export function quotaPlanMetadataLines(value: unknown): string[] {
  const metadata = parseQuotaPlanMetadata(value);
  if (!metadata) return [];
  const lines: string[] = [];
  if (metadata.detectedPlanName) lines.push(`Detected Plan: ${metadata.detectedPlanName}`);
  if (metadata.userPlanName) lines.push(`Entered Plan: ${metadata.userPlanName}`);
  if (metadata.userSubtitle) lines.push(metadata.userSubtitle);
  if (metadata.showCostAndRenewal === true) {
    if (metadata.userCostUsd) lines.push(`Entered Cost (USD): ${metadata.userCostUsd}`);
    if (metadata.userRenewalDateText) lines.push(`Entered Renewal: ${metadata.userRenewalDateText}`);
  }
  if (metadata.hasMismatch) lines.push("Detected and entered plans differ");
  return lines;
}
