// Voice synthesis is billed by characters, not model tokens. Keep this
// separate from model-token usage and record only successful syntheses.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const usageFile = () => join(process.env.OMB_DATA_DIR ?? join(homedir(), ".botfleet"), "tts-usage.jsonl");
export type SpeechProvider = "minimax" | "elevenlabs";
export interface SpeechUsage { at: number; provider: SpeechProvider; characters: number; source: "provider" | "submitted" }

/** Best-effort accounting cannot make a successful generated clip fail. */
export function recordSpeechUsage(provider: SpeechProvider, characters: number, source: SpeechUsage["source"]): void {
  if (!Number.isSafeInteger(characters) || characters < 0) return;
  try { mkdirSync(dirname(usageFile()), { recursive: true, mode: 0o700 }); appendFileSync(usageFile(), JSON.stringify({ at: Date.now(), provider, characters, source }) + "\n", { mode: 0o600 }); }
  catch (error) { console.warn("Could not record speech usage:", error); }
}

export function speechUsageTotals(): Record<SpeechProvider, { characters: number; requests: number; providerReported: number }> {
  const totals = {
    minimax: { characters: 0, requests: 0, providerReported: 0 },
    elevenlabs: { characters: 0, requests: 0, providerReported: 0 },
  };
  try {
    if (!existsSync(usageFile())) return totals;
    for (const line of readFileSync(usageFile(), "utf8").split("\n")) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as SpeechUsage;
        if (row.provider !== "minimax" && row.provider !== "elevenlabs") continue;
        if (!Number.isSafeInteger(row.characters) || row.characters < 0) continue;
        totals[row.provider].characters += row.characters;
        totals[row.provider].requests += 1;
        if (row.source === "provider") totals[row.provider].providerReported += row.characters;
      } catch { /* one damaged row does not hide other usage */ }
    }
  } catch (error) { console.warn("Could not read speech usage:", error); }
  return totals;
}
