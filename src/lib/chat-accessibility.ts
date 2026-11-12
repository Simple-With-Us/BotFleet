/** Spoken names for chat controls. Plain language a person hears.
 *  The headline of an automated instruction already says what fired
 *  (a scheduled run, a webhook, a resource alert). The instruction's
 *  own first line follows, so the card is not only a badge. */

const SENTENCE_GAP = ".\u00A0 ";

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function instructionCardLabel(input: {
  name?: string;
  headline: string;
  subtitle?: string;
  when?: string;
}): string {
  const name = collapse(input.name ?? "");
  const headline = collapse(input.headline);
  const subtitle = collapse(input.subtitle ?? "");
  const when = collapse(input.when ?? "");
  const parts: string[] = [];
  if (name && name !== headline) parts.push(name);
  if (headline) parts.push(headline);
  if (subtitle && subtitle !== headline && subtitle !== name) parts.push(subtitle);
  if (when) parts.push(when);
  if (parts.length === 0) return "Automated instruction";
  return parts.join(SENTENCE_GAP);
}

/** The model control folds to a mark alone when the chat header is narrow.
 *  The spoken name keeps the model, and a note such as Retired when there is one. */
export function modelControlLabel(modelName: string, note?: string): string {
  const name = collapse(modelName) || "Choose a model";
  const extra = collapse(note ?? "");
  return extra ? `Model, ${name}, ${extra}` : `Model, ${name}`;
}

export function speakAloudLabel(on: boolean): string {
  return on ? "Speak replies aloud, on" : "Speak replies aloud, off";
}
