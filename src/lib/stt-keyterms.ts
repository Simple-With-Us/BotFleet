/** Shared vocabulary rules for Settings and each cloud STT session. */
export const KEYTERMS_MAX = 100;

export function parseKeyterms(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of raw.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= KEYTERMS_MAX) break;
  }
  return out;
}

export const formatKeyterms = (list: readonly string[]): string => list.join(", ");

export function keytermsDirty(current: readonly string[], saved: readonly string[]): boolean {
  return formatKeyterms(parseKeyterms(formatKeyterms(current))) !==
    formatKeyterms(parseKeyterms(formatKeyterms(saved)));
}

/** Per-call names win when the streaming provider's 100-term cap is full. */
export function sessionKeyterms(names: readonly string[], global: readonly string[]): string[] {
  const prioritized = parseKeyterms(formatKeyterms(names));
  return parseKeyterms(formatKeyterms([...prioritized, ...global]));
}

/** The saved baseline advances only when this PUT succeeds. */
export async function persistKeyterms(
  terms: readonly string[],
  request: typeof fetch = fetch,
): Promise<string[]> {
  const canonical = parseKeyterms(formatKeyterms(terms));
  const res = await request("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callStt: { keyterms: canonical } }),
  });
  if (!res.ok) throw new Error(`PUT /api/config → ${res.status}`);
  return canonical;
}
