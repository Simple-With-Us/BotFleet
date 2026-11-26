/** The advisor model id:  a model slug, a short alias, or an injected id.
 *
 *  An advisor reaches the engine as one launch argument, so a value with
 *  spaces or punctuation would be a different argument than the one meant.
 *  The rule is one place, so the API that saves one and the driver that
 *  passes one agree on what an id is. */
const ADVISOR_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]*$/i;

/** True when the value is an advisor model id this fleet may pass. */
export function isAdvisorModelId(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 64 && ADVISOR_MODEL_ID.test(trimmed);
}
