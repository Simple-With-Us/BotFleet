/** Client-side Usage Monitor settings patch.  Empty token fields are omitted
 * so a Save or blur cannot wipe a stored secret the input never echoed. */

export function isAbsoluteHttpUrl(value: string): boolean {
  const raw = value.trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export type UsageConfigPatch = {
  ingestUrl: string;
  ingestToken?: string;
  readToken?: string;
};

export function buildUsageConfigPatch(input: {
  ingestUrl: string;
  ingestToken: string;
  readToken: string;
}): { ok: true; patch: UsageConfigPatch } | { ok: false; error: string } {
  const ingestUrl = input.ingestUrl.trim();
  if (ingestUrl && !isAbsoluteHttpUrl(ingestUrl)) {
    return { ok: false, error: "Usage Monitor URL must be an absolute http(s) URL." };
  }
  const patch: UsageConfigPatch = { ingestUrl };
  const ingestToken = input.ingestToken.trim();
  const readToken = input.readToken.trim();
  if (ingestToken) patch.ingestToken = ingestToken;
  if (readToken) patch.readToken = readToken;
  return { ok: true, patch };
}
