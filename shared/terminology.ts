/** What the product calls a room, in the words the person using it prefers.
 *
 * A room is one shared conversation with a team of bots.  Different people
 * reach for different words — Channels, Groups, Projects, Apps, Topics — and
 * some want a word we have not thought of, so the setting also takes a custom
 * pair.  It is a pair rather than one word because English plurals are not
 * reliably "add an s": Category becomes Categories, Box becomes Boxes.  The
 * settings screen asks for both forms and pre-fills the plural with
 * `suggestPlural`, so the usual case is still a single thing to type.
 *
 * The harness resolves the pair once and hands clients the finished labels,
 * so the Mac app and the iOS companion never re-derive them and cannot drift.
 */

/** Preset room words, plus `custom` for a word the presets do not cover. */
export type RoomTerminology =
  | "channels"
  | "groups"
  | "projects"
  | "apps"
  | "topics"
  | "repos"
  | "custom";

/** The two forms every room label needs. */
export interface RoomLabels {
  /** "Channel" — used in "New Channel", "Channel Details", "Rename Channel". */
  singular: string;
  /** "Channels" — used in section headers and "All Channels". */
  plural: string;
}

/** A custom pair as the person typed it, before validation. */
export interface CustomRoomLabels {
  singular?: string;
  plural?: string;
}

export const ROOM_TERMINOLOGY_PRESETS: Record<Exclude<RoomTerminology, "custom">, RoomLabels> = {
  channels: { singular: "Channel", plural: "Channels" },
  groups: { singular: "Group", plural: "Groups" },
  projects: { singular: "Project", plural: "Projects" },
  apps: { singular: "App", plural: "Apps" },
  topics: { singular: "Topic", plural: "Topics" },
  repos: { singular: "Repo", plural: "Repos" },
};

/** Every preset in the order the settings picker offers them. */
export const ROOM_TERMINOLOGY_OPTIONS: readonly RoomTerminology[] = [
  "channels",
  "groups",
  "projects",
  "apps",
  "topics",
  "repos",
  "custom",
];

export const DEFAULT_ROOM_TERMINOLOGY: RoomTerminology = "channels";

/** Longer than this is not a label any more, it is a sentence in a header. */
export const ROOM_LABEL_MAX_LENGTH = 24;

/** Match the suffix to the word's own case so HUB pluralizes to HUBS. */
function matchCase(word: string, suffix: string): string {
  const letters = word.replace(/[^A-Za-z]/g, "");
  const shouting = letters.length > 1 && letters === letters.toUpperCase();
  return shouting ? suffix.toUpperCase() : suffix;
}

/** A best guess at the plural, offered as a pre-fill the person can correct.
 *
 * This is deliberately a suggestion and never a rule: the stored plural is
 * whatever they leave in the field, so an irregular word like Person/People
 * costs one edit rather than being impossible. */
export function suggestPlural(singular: string): string {
  const word = singular.trim();
  if (!word) return "";
  const lower = word.toLowerCase();
  if (/(?:s|x|z|ch|sh)$/.test(lower)) return word + matchCase(word, "es");
  if (/[^aeiou]y$/.test(lower)) return word.slice(0, -1) + matchCase(word, "ies");
  if (/fe$/.test(lower)) return word.slice(0, -2) + matchCase(word, "ves");
  if (/[^f]f$/.test(lower)) return word.slice(0, -1) + matchCase(word, "ves");
  return word + matchCase(word, "s");
}

/** Trim a typed label to something that fits a sidebar header, or null if it
 * is empty once trimmed.  Newlines and runs of whitespace collapse so a
 * pasted label cannot break the layout. */
export function sanitizeRoomLabel(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim().slice(0, ROOM_LABEL_MAX_LENGTH);
  return cleaned.length ? cleaned : null;
}

/** The finished pair for a stored setting.
 *
 * Falls back a step at a time rather than all the way to the default: a
 * custom singular with an empty plural still gets a sensible plural, because
 * a half-filled setting should not silently revert the person's word. */
export function resolveRoomLabels(
  terminology: RoomTerminology | undefined,
  custom?: CustomRoomLabels | null,
): RoomLabels {
  if (terminology === "custom") {
    const singular = sanitizeRoomLabel(custom?.singular);
    const plural = sanitizeRoomLabel(custom?.plural);
    if (singular) return { singular, plural: plural ?? suggestPlural(singular) };
    if (plural) return { singular: plural, plural };
    return ROOM_TERMINOLOGY_PRESETS[DEFAULT_ROOM_TERMINOLOGY as Exclude<RoomTerminology, "custom">];
  }
  const preset = terminology ?? DEFAULT_ROOM_TERMINOLOGY;
  return (
    ROOM_TERMINOLOGY_PRESETS[preset as Exclude<RoomTerminology, "custom">] ??
    ROOM_TERMINOLOGY_PRESETS[DEFAULT_ROOM_TERMINOLOGY as Exclude<RoomTerminology, "custom">]
  );
}

/** The same pair in lower case, for the middle of a sentence — "move to
 * another channel".  Custom labels that are proper nouns keep their capitals,
 * which is why this is a separate call rather than a blanket toLowerCase. */
export function lowerRoomLabels(labels: RoomLabels): RoomLabels {
  const lower = (word: string) => {
    const letters = word.replace(/[^A-Za-z]/g, "");
    const shouting = letters.length > 1 && letters === letters.toUpperCase();
    return shouting ? word : word.charAt(0).toLowerCase() + word.slice(1);
  };
  return { singular: lower(labels.singular), plural: lower(labels.plural) };
}
