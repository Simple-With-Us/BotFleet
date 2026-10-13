import { z } from "zod";

import type { JsonValue } from "../../schema.ts";

const acpAvailableModelSchema = z
  .object({
    modelId: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const acpSessionModelsSchema = z
  .object({
    availableModels: z.array(acpAvailableModelSchema).optional(),
    currentModelId: z.string().optional(),
  })
  .passthrough();

/** JSON-RPC result from `session/new`, `session/load`, or accumulated session config. */
export const acpSessionLifecycleResultSchema = z
  .object({
    sessionId: z.string().optional(),
    configOptions: z.array(z.unknown()).optional(),
    models: acpSessionModelsSchema.optional(),
  })
  .passthrough();

export type AcpSessionLifecycleResult = z.infer<typeof acpSessionLifecycleResultSchema>;
export type AcpSessionModels = z.infer<typeof acpSessionModelsSchema>;
export type AcpAvailableModel = z.infer<typeof acpAvailableModelSchema>;

export function parseAcpSessionLifecycleResult(value: JsonValue | null | undefined): AcpSessionLifecycleResult | null {
  const parsed = acpSessionLifecycleResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function mergeSessionCurrentModelId(
  prior: AcpSessionLifecycleResult | null,
  modelId: string,
): AcpSessionLifecycleResult {
  const modelParse = acpSessionModelsSchema.safeParse(prior?.models);
  const mergedModels = modelParse.success
    ? acpSessionModelsSchema.parse({ ...modelParse.data, currentModelId: modelId })
    : acpSessionModelsSchema.parse({ currentModelId: modelId });
  if (!prior) {
    return acpSessionLifecycleResultSchema.parse({ models: mergedModels });
  }
  return acpSessionLifecycleResultSchema.parse({ ...prior, models: mergedModels });
}

export function sessionAvailableModels(result: AcpSessionLifecycleResult | null | undefined): AcpAvailableModel[] {
  const models = acpSessionModelsSchema.safeParse(result?.models);
  if (!models.success || !models.data.availableModels) return [];
  return models.data.availableModels;
}

export function sessionCurrentModelId(result: AcpSessionLifecycleResult | null | undefined): string | undefined {
  const models = acpSessionModelsSchema.safeParse(result?.models);
  return models.success ? models.data.currentModelId : undefined;
}
