/** Plain-English catalog probe copy for the OpenCode engine row (`BF-2488`). */

/** Turn a probe's internal message into text for Settings and the model picker. */
export function humanizeOpenCodeModelProbeProblem(raw: string): string {
  const text = raw.trim();
  if (!text) return text;
  if (text.startsWith("OpenCode's model probe")) return text;
  if (text === "opencode models answered nothing") {
    return "OpenCode answered but listed no models.";
  }
  const listedNothing = text.match(/^opencode models listed nothing \((.+)\)$/u);
  if (listedNothing) {
    return `OpenCode listed no models (${listedNothing[1]}).`;
  }
  if (text.startsWith("opencode models listed nothing")) {
    return "OpenCode listed no models.";
  }
  return text;
}
