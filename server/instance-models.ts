import { z } from "zod";

const modelText = z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/);

/** Parse model edits at the instance HTTP boundary before persisting them. */
export const instanceModelsSchema = z.array(z.object({
  id: modelText,
  label: modelText,
}).strip()).max(100).superRefine((models, context) => {
  const seen = new Set<string>();
  for (const [index, model] of models.entries()) {
    if (seen.has(model.id)) {
      context.addIssue({ code: "custom", path: [index, "id"], message: "Duplicate model ID" });
    }
    seen.add(model.id);
  }
});
