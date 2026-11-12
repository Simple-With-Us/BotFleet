import { z } from "zod";

import { REPLY_WAIT_RANGE_MESSAGE, ReplyWaitMinutesSchema } from "./drivers/openai-compat.ts";
import { instanceModelsSchema } from "./instance-models.ts";

const newlineFreeString = (field: string, message = `${field} must be a string`) =>
  z.string({ error: message })
    .refine((value) => !/[\r\n]/.test(value), { message: `${field} must not contain newlines` });

/** Strict body for PATCH /api/instances/:id — unknown keys are rejected. */
export const InstancePatchBodySchema = z.object({
  cli: newlineFreeString("cli").optional(),
  models: instanceModelsSchema.optional(),
  replyWaitMinutes: z.union([ReplyWaitMinutesSchema, z.null()]).optional(),
  fullAuto: z.boolean({ error: "fullAuto must be a boolean" }).optional(),
  enabled: z.boolean({ error: "enabled must be a boolean" }).optional(),
  key: newlineFreeString("key").optional(),
}).strict();

/** Credential-restore replay accepts only `key`. */
export const InstancePatchRestoreBodySchema = z.object({
  key: newlineFreeString("key"),
}).strict();

/** Map the first schema issue to the route's stable error strings. */
export function instancePatchInputError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid instance patch body";
  if (issue.code === "unrecognized_keys") return "invalid instance patch body";
  const field = issue.path[0];
  if (field === "replyWaitMinutes") return REPLY_WAIT_RANGE_MESSAGE;
  if (field === "models") return "models must contain at most 100 unique IDs with valid labels";
  if (field === "cli") {
    if (issue.message.includes("newline")) return "cli must not contain newlines";
    return "cli must be a string";
  }
  if (field === "fullAuto") return "fullAuto must be a boolean";
  if (field === "enabled") return "enabled must be a boolean";
  if (field === "key") {
    if (issue.message.includes("newline")) return "key must not contain newlines";
    return "key must be a string";
  }
  return "invalid instance patch body";
}
