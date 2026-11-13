/** Plain-English catalog load failures for the OpenCode engine row (`BF-2666`). */

/** One sentence gap: a no-break space and a space, which survives HTML. */
const GAP = "\u00A0 ";

/** Safe fallback when the internal message is not recognized. */
export const OPEN_CODE_MODELS_LOAD_FAILED =
  `BotFleet couldn't load OpenCode's models.${GAP}Try again in a moment.`;

export const OPEN_CODE_MODELS_TIMED_OUT_BUSY =
  `BotFleet couldn't load OpenCode's models.${GAP}It timed out while your computer was busy.`;

export const OPEN_CODE_MODELS_STOPPED_EARLY =
  `BotFleet couldn't load OpenCode's models.${GAP}OpenCode stopped before it could answer.`;

export const OPEN_CODE_ANSWERED_NO_MODELS = "OpenCode answered but listed no models.";

export const OPEN_CODE_LISTED_NO_MODELS = "OpenCode listed no models.";

const KNOWN_SENTENCES: ReadonlySet<string> = new Set([
  OPEN_CODE_MODELS_LOAD_FAILED,
  OPEN_CODE_MODELS_TIMED_OUT_BUSY,
  OPEN_CODE_MODELS_STOPPED_EARLY,
  OPEN_CODE_ANSWERED_NO_MODELS,
  OPEN_CODE_LISTED_NO_MODELS,
]);

const PROBE_TIMEOUT = /^OpenCode's model probe timed out\b/i;
const PROBE_STOPPED = /^OpenCode's model probe was stopped\b/i;
const ANSWERED_NOTHING = /^opencode models answered nothing$/i;
const LISTED_NOTHING = /^opencode models listed nothing\b/i;

/** Turn an internal probe message into copy for Settings and the model picker. */
export function humanizeOpenCodeModelProbeProblem(raw: string): string {
  const text = raw.trim();
  if (!text) return text;
  // The server stores the humanized sentence, and the client humanizes again:
  // a sentence this function already produced passes through unchanged.
  if (KNOWN_SENTENCES.has(text)) return text;
  if (PROBE_TIMEOUT.test(text)) return OPEN_CODE_MODELS_TIMED_OUT_BUSY;
  if (PROBE_STOPPED.test(text)) return OPEN_CODE_MODELS_STOPPED_EARLY;
  if (ANSWERED_NOTHING.test(text)) return OPEN_CODE_ANSWERED_NO_MODELS;
  if (LISTED_NOTHING.test(text)) return OPEN_CODE_LISTED_NO_MODELS;
  if (/^OpenCode returned no usable models$/i.test(text)) return OPEN_CODE_LISTED_NO_MODELS;
  return OPEN_CODE_MODELS_LOAD_FAILED;
}

/** Whether `humanizeOpenCodeModelProbeProblem` maps this text to the generic fallback. */
export function openCodeModelProbeProblemIsUnknown(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  return humanizeOpenCodeModelProbeProblem(text) === OPEN_CODE_MODELS_LOAD_FAILED;
}
