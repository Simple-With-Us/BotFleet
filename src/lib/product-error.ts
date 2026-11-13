export type ProductError = {
  headline: string;
  detail?: string;
};

function rawText(raw: unknown): string {
  if (raw instanceof Error) return raw.message;
  if (typeof raw === "string") return raw;
  if (raw == null) return "";
  return String(raw);
}

/** Map a thrown error to Title Case product copy.  The original message stays in `detail`. */
export function productErrorMessage(raw: unknown): ProductError {
  const detail = rawText(raw).trim();
  const lower = detail.toLowerCase();

  if (!detail) return { headline: "Something Went Wrong." };

  if (lower.includes("failed to fetch") || lower.includes("networkerror") || lower.includes("load failed") || lower.includes("econnrefused")) {
    return { headline: "Couldn't Reach the Bot Server.\u00A0 Check that BotFleet is running.", detail };
  }
  if (/\b401\b/.test(lower) || lower.includes("unauthorized")) {
    return { headline: "Couldn't Sign In.\u00A0 Check this computer's connection.", detail };
  }
  if (/\b404\b/.test(lower) || lower.includes("not found")) {
    return { headline: "Nothing Was Found.", detail };
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("aborted")) {
    return { headline: "That Took Too Long.\u00A0 Try again.", detail };
  }
  if (/\bhttp\s+\d{3}\b/.test(lower) || /\b50\d\b/.test(lower)) {
    return { headline: "The Server Couldn't Complete That.\u00A0 Try again.", detail };
  }

  return { headline: "Something Went Wrong.", detail };
}

export function productErrorHeadline(raw: unknown): string {
  return productErrorMessage(raw).headline;
}
