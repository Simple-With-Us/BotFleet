// Which computer the preview is looking at.
//
// A bot's `computers` is a multi-select: it can hold ["cloud", "local"] and
// mean "this bot may use either".  The panel, however, could only ever show
// one, because it resolved the list by a fixed precedence and rendered that.
// Auto-selection stays the default — it is the right answer most of the time
// — but a person needs to be able to look at any of the computers the bot
// holds, because "this bot has the Local VM" and "the Local VM actually works
// for this bot" are different claims and only the second one is visible.
//
// Pure, so the precedence that ships today is pinned by a test rather than
// re-derived from a chain of `includes()` calls in a component effect.

/** The three destinations a bot's computer can live on. */
export type ComputerKind = "vm" | "local" | "cloud";
/** `auto` defers to the precedence below; the rest pin one destination. */
export type PreviewChoice = ComputerKind | "auto";
/** No computer at all — the bot's list is empty. */
export type PreviewTarget = ComputerKind | "off";

/** The order the panel already used, kept exactly as it was. */
export const AUTO_PRECEDENCE: readonly ComputerKind[] = ["vm", "cloud", "local"] as const;

/**
 * The computer auto-selection picks.
 *
 * This reproduces the pre-existing behaviour, which was not a simple
 * "first in the array": the Local VM won outright, cloud won whenever the bot
 * held it at all, and "This Mac" was the fallback when neither was present.
 * Getting this wrong would silently change which computer every bot uses.
 */
export function autoSource(computers: readonly ComputerKind[]): PreviewTarget {
  for (const kind of AUTO_PRECEDENCE) {
    if (computers.includes(kind)) return kind;
  }
  return "off";
}

/**
 * The computer to actually show, given what the person asked for.
 *
 * A choice the bot does not hold falls back to auto rather than showing a
 * computer the bot has no claim to — picking "Local VM" for a bot without one
 * would render a stranger's desktop.
 */
export function resolvePreviewSource(
  computers: readonly ComputerKind[],
  choice: PreviewChoice,
): PreviewTarget {
  if (choice !== "auto" && computers.includes(choice)) return choice;
  return autoSource(computers);
}

/**
 * Does the person need to be offered a choice at all?
 *
 * A bot holding exactly one computer has nothing to switch between, so the
 * picker stays out of the way.
 */
export function hasPreviewChoice(computers: readonly ComputerKind[]): boolean {
  return computers.length > 1;
}

/** The picker row: auto first, then every computer the bot holds. */
export function previewChoices(computers: readonly ComputerKind[]): PreviewChoice[] {
  if (!hasPreviewChoice(computers)) return [];
  return ["auto", ...AUTO_PRECEDENCE.filter((kind) => computers.includes(kind))];
}

/**
 * Is a previously chosen source still valid for this bot?
 *
 * A choice made for one bot — or one that has since had the computer removed
 * — must not silently show the wrong thing, and the honest repair is to go
 * back to auto, which is always defined.
 */
export function choiceSurvives(choice: PreviewChoice, computers: readonly ComputerKind[]): PreviewChoice {
  if (choice === "auto") return "auto";
  return computers.includes(choice) ? choice : "auto";
}
