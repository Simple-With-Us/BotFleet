// Voice synthesis is billed by characters, not model tokens. Keep this
// separate from model-token usage and record only successful syntheses.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { telemetry } from "../telemetry.ts";
import { dataDir } from "../data-dir.ts";

const usageFile = () => join(dataDir(), "tts-usage.jsonl");
export type SpeechProvider = "minimax" | "elevenlabs" | "xai" | "azure";
export interface SpeechUsage { at: number; provider: SpeechProvider; characters: number; source: "provider" | "submitted" }

/** Usage Monitor's name for who synthesized the clip. */
const UM_PROVIDER: Record<SpeechProvider, string> = {
  minimax: "minimax",
  elevenlabs: "elevenlabs",
  xai: "xai",
  azure: "azure",
};

/** Best-effort accounting cannot make a successful generated clip fail.
 *
 * Every clip is also reported to Usage Monitor (BF-2435).  Its schema has no
 * character unit, so the event counts one request and carries the characters
 * (and whether the provider or this server counted them) in metadata. */
export function recordSpeechUsage(
  provider: SpeechProvider,
  characters: number,
  source: SpeechUsage["source"],
  detail: { service?: string } = {},
): void {
  if (!Number.isSafeInteger(characters) || characters < 0) return;
  telemetry.trackAux({
    kind: "tts",
    provider: UM_PROVIDER[provider],
    service: detail.service ?? "tts",
    label: "BotFleet speech",
    metadata: { characters, characterSource: source },
  });
  try { mkdirSync(dirname(usageFile()), { recursive: true, mode: 0o700 }); appendFileSync(usageFile(), JSON.stringify({ at: Date.now(), provider, characters, source }) + "\n", { mode: 0o600 }); }
  catch (error) { console.warn("Could not record speech usage:", error); }
}

export function speechUsageTotals(): Record<SpeechProvider, { characters: number; requests: number; providerReported: number }> {
  const totals = {
    minimax: { characters: 0, requests: 0, providerReported: 0 },
    elevenlabs: { characters: 0, requests: 0, providerReported: 0 },
    xai: { characters: 0, requests: 0, providerReported: 0 },
    azure: { characters: 0, requests: 0, providerReported: 0 },
  };
  try {
    if (!existsSync(usageFile())) return totals;
    for (const line of readFileSync(usageFile(), "utf8").split("\n")) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as SpeechUsage;
        if (!(row.provider in totals)) continue;
        if (!Number.isSafeInteger(row.characters) || row.characters < 0) continue;
        totals[row.provider].characters += row.characters;
        totals[row.provider].requests += 1;
        if (row.source === "provider") totals[row.provider].providerReported += row.characters;
      } catch { /* one damaged row does not hide other usage */ }
    }
  } catch (error) { console.warn("Could not read speech usage:", error); }
  return totals;
}
