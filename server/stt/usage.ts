import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { dataDir } from "../data-dir.ts";
import { telemetry } from "../telemetry.ts";
import { sttCostUsd, type XaiSttMode } from "../../shared/xai-stt.ts";

export interface SttUsageRow {
  at: number;
  provider: "xai";
  mode: XaiSttMode;
  durationSeconds: number;
  usd: number;
}

function usageFile(): string {
  return join(dataDir(), "stt-usage.jsonl");
}

/** Record one REST or streaming transcription against Usage Monitor and a
 *  local log.  Pricing is $0.10/hr REST and $0.20/hr streaming. */
export function recordSttUsage(
  provider: "xai",
  durationSeconds: number,
  mode: XaiSttMode,
  detail: { service?: string } = {},
): void {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return;
  const seconds = Math.round(durationSeconds * 1000) / 1000;
  const usd = sttCostUsd(seconds, mode);
  telemetry.trackAux({
    kind: "stt",
    provider,
    service: detail.service ?? (mode === "streaming" ? "xai-stt-streaming" : "xai-stt"),
    label: "BotFleet speech-to-text",
    unit: "request",
    costUsd: usd,
    billingMode: "estimated",
    metadata: { durationSeconds: seconds, mode },
  });
  try {
    mkdirSync(dirname(usageFile()), { recursive: true, mode: 0o700 });
    const row: SttUsageRow = { at: Date.now(), provider, mode, durationSeconds: seconds, usd };
    appendFileSync(usageFile(), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  } catch (error) {
    console.warn("Could not record speech-to-text usage:", error);
  }
}
