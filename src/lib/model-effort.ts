import type { EffortLevel } from "../../server/contracts.ts";

export interface ModelEffortSubject {
  driverKind?: string;
  capabilities?: {
    effortLevels?: readonly EffortLevel[];
  };
}

export interface ModelOptionEffortSubject {
  id?: string;
  effortLevels?: readonly EffortLevel[];
  supportsEffort?: boolean;
}

/**
 * Returns the supported reasoning effort levels for a specific model on an engine.
 *
 * Empty array = model does NOT support reasoning effort (the UI should hide or disable the effort picker).
 */
export function modelEffortLevels(
  engine: ModelEffortSubject | null | undefined,
  modelOption: ModelOptionEffortSubject | null | undefined,
  modelId?: string,
): readonly EffortLevel[] {
  const engineLevels = engine?.capabilities?.effortLevels ?? [];
  if (!engineLevels.length) return [];

  // If the model option explicitly declares effort levels:
  if (modelOption?.effortLevels !== undefined) {
    return modelOption.effortLevels;
  }

  // If explicitly flagged as not supporting effort:
  if (modelOption?.supportsEffort === false) {
    return [];
  }

  const effectiveId = (modelOption?.id ?? modelId ?? "").trim();
  const lowerId = effectiveId.toLowerCase();
  const driverKind = (engine?.driverKind ?? "").toLowerCase();

  // Known engine + model rules:
  // 1. DSH / Harness: MiniMax rows without their own list do not support
  //    reasoning effort.  A row that does declare one (MiniMax M3.1 once the
  //    install's settings.yaml declares its reasoningEfforts) already returned
  //    above, so only list-less rows such as M2.7 Highspeed reach this.
  if ((driverKind.includes("dsh") || driverKind.includes("deepseek")) && lowerId.includes("minimax")) {
    return [];
  }

  // 2. Claude CLI: Haiku models do not support reasoning effort / extended thinking.
  if (driverKind.includes("claude") && lowerId.includes("haiku")) {
    return [];
  }

  // 3. Codex: legacy / non-reasoning GPT models (gpt-4o, gpt-4o-mini, gpt-4, gpt-3.5) do not support reasoning effort.
  if (driverKind.includes("codex")) {
    if (
      lowerId.startsWith("gpt-4o") ||
      lowerId.startsWith("gpt-4-") ||
      lowerId === "gpt-4" ||
      lowerId.startsWith("gpt-3.5") ||
      lowerId.includes("chatgpt-4o")
    ) {
      return [];
    }
  }

  return engineLevels;
}

export function modelSupportsEffort(
  engine: ModelEffortSubject | null | undefined,
  modelOption: ModelOptionEffortSubject | null | undefined,
  modelId?: string,
): boolean {
  return modelEffortLevels(engine, modelOption, modelId).length > 0;
}
