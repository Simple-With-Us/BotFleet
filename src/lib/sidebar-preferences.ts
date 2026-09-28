export type SidebarDensity = "comfortable" | "compact" | "icons";

export const SIDEBAR_DENSITY_KEY = "botfleet.sidebarDensity";

export function parseSidebarDensity(value: string | null): SidebarDensity {
  switch (value) {
    case "comfortable":
    case "compact":
    case "icons":
      return value;
    default:
      return "comfortable";
  }
}

export function loadSidebarDensity(storage?: Pick<Storage, "getItem"> | null): SidebarDensity {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parseSidebarDensity(target?.getItem(SIDEBAR_DENSITY_KEY) ?? null);
  } catch {
    return "comfortable";
  }
}

export function saveSidebarDensity(
  density: SidebarDensity,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(SIDEBAR_DENSITY_KEY, density);
  } catch {
    // Private browsing and locked-down webviews may reject localStorage.
    // The in-memory React state still makes the control useful this session.
  }
}

export const SIDEBAR_WIDTH_KEY = "botfleet.sidebarWidth";
export const DEFAULT_SIDEBAR_WIDTH = 320;
export const DEFAULT_SIDEBAR_COMPACT_WIDTH = 272;
export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 640;

export function parseSidebarWidth(value: string | null, density?: SidebarDensity): number {
  const fallback = density === "compact" ? DEFAULT_SIDEBAR_COMPACT_WIDTH : DEFAULT_SIDEBAR_WIDTH;
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const whole = Math.round(parsed);
  if (whole < MIN_SIDEBAR_WIDTH) return MIN_SIDEBAR_WIDTH;
  if (whole > MAX_SIDEBAR_WIDTH) return MAX_SIDEBAR_WIDTH;
  return whole;
}

export function loadSidebarWidth(
  storage?: Pick<Storage, "getItem"> | null,
  density?: SidebarDensity,
): number {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parseSidebarWidth(target?.getItem(SIDEBAR_WIDTH_KEY) ?? null, density);
  } catch {
    return density === "compact" ? DEFAULT_SIDEBAR_COMPACT_WIDTH : DEFAULT_SIDEBAR_WIDTH;
  }
}

export function saveSidebarWidth(
  width: number,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(SIDEBAR_WIDTH_KEY, String(parseSidebarWidth(String(width))));
  } catch {
    // Same private-browsing resilience as other sidebar preferences.
  }
}

/** The width a density switch settles on. Only an untouched default follows
 * the density (comfortable's 320 becomes compact's 272 and back); a width
 * the person dragged to is their choice and survives the switch. The caller
 * persists the result — a swap that stays in-memory reads back as the other
 * density's default on the next load. */
export function densityAdjustedSidebarWidth(width: number, density: SidebarDensity): number {
  if (density === "compact" && width === DEFAULT_SIDEBAR_WIDTH) return DEFAULT_SIDEBAR_COMPACT_WIDTH;
  if (density === "comfortable" && width === DEFAULT_SIDEBAR_COMPACT_WIDTH) return DEFAULT_SIDEBAR_WIDTH;
  return width;
}

/** How many of a channel's conversations the sidebar shows before it offers
 * the rest.  A handful is enough to recognise the one you want; the number
 * is a preference because "a handful" differs per person and per screen. */
export const SIDEBAR_THREAD_COUNT_KEY = "botfleet.sidebarThreadCount";
export const DEFAULT_SIDEBAR_THREAD_COUNT = 6;
export const MIN_SIDEBAR_THREAD_COUNT = 1;
export const MAX_SIDEBAR_THREAD_COUNT = 20;

export function parseSidebarThreadCount(value: string | null): number {
  // Nothing stored means the default, not zero: Number(null) is 0, which
  // would otherwise clamp to the minimum and show one conversation.
  if (value === null || value.trim() === "") return DEFAULT_SIDEBAR_THREAD_COUNT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SIDEBAR_THREAD_COUNT;
  const whole = Math.round(parsed);
  if (whole < MIN_SIDEBAR_THREAD_COUNT) return MIN_SIDEBAR_THREAD_COUNT;
  if (whole > MAX_SIDEBAR_THREAD_COUNT) return MAX_SIDEBAR_THREAD_COUNT;
  return whole;
}

export function loadSidebarThreadCount(storage?: Pick<Storage, "getItem"> | null): number {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parseSidebarThreadCount(target?.getItem(SIDEBAR_THREAD_COUNT_KEY) ?? null);
  } catch {
    return DEFAULT_SIDEBAR_THREAD_COUNT;
  }
}

export function saveSidebarThreadCount(
  count: number,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(SIDEBAR_THREAD_COUNT_KEY, String(parseSidebarThreadCount(String(count))));
  } catch {
    // Same reasoning as the density preference: a blocked store is not a
    // reason to fail, the in-memory state still works this session.
  }
}

/** Which channels are collapsed.  Collapsed is the exception, so the stored
 * value is the list of collapsed ids and an unknown channel starts open. */
export const SIDEBAR_COLLAPSED_ROOMS_KEY = "botfleet.sidebarCollapsedRooms";

export function parseCollapsedRooms(value: string | null): Set<string> {
  if (!value) return new Set();
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

export function loadCollapsedRooms(storage?: Pick<Storage, "getItem"> | null): Set<string> {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parseCollapsedRooms(target?.getItem(SIDEBAR_COLLAPSED_ROOMS_KEY) ?? null);
  } catch {
    return new Set();
  }
}

export function saveCollapsedRooms(
  collapsed: Set<string>,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(SIDEBAR_COLLAPSED_ROOMS_KEY, JSON.stringify([...collapsed]));
  } catch {
    // See above.
  }
}

/** Which roster sections are collapsed.
 *
 * A separate key from the channel one on purpose: a section groups channels
 * and bots, so one list holding both would make "Apps" and a channel called
 * "Apps" the same entry.  Collapsed is the exception here too — an unknown
 * section starts open, which is what a newly created one should do. */
export const SIDEBAR_COLLAPSED_SECTIONS_KEY = "botfleet.sidebarCollapsedSections";

export function loadCollapsedSections(storage?: Pick<Storage, "getItem"> | null): Set<string> {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parseCollapsedRooms(target?.getItem(SIDEBAR_COLLAPSED_SECTIONS_KEY) ?? null);
  } catch {
    return new Set();
  }
}

export function saveCollapsedSections(
  collapsed: Set<string>,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(SIDEBAR_COLLAPSED_SECTIONS_KEY, JSON.stringify([...collapsed]));
  } catch {
    // See above.
  }
}

/** Bot-to-bot DMs are not user rooms.  They stay in this named dropdown
 * even if an older write left a leftover Apps/Work section on the record.
 * Default-collapsed until opened; user contexts keep a stored order. */
export const BOT_CHATS_SECTION = "Bot Chats";
/** Pre-rename collapsed-section key.  Migrated on load so a stored collapse is kept. */
export const LEGACY_BOT_CHATS_SECTION = "Bot ↔ Bot";
export const SIDEBAR_BOT_CHATS_INIT_KEY = "botfleet.sidebarBotChatsInit";
export const SIDEBAR_SECTION_ORDER_KEY = "botfleet.sidebarSectionOrder";
export const SECTION_DRAG_TYPE = "application/x-botfleet-section";
export const ROSTER_DRAG_TYPE = "application/x-botfleet-roster";

export function partitionSidebarGroups<T extends { dm?: boolean; section?: string }>(
  groups: T[],
): { botChats: T[]; sectionedRooms: T[]; unsectionedRooms: T[] } {
  const botChats = groups.filter((group) => group.dm);
  const rooms = groups.filter((group) => !group.dm);
  return {
    botChats,
    sectionedRooms: rooms.filter((group) => Boolean(group.section)),
    unsectionedRooms: rooms.filter((group) => !group.section),
  };
}

export function loadCollapsedSectionsWithBotChatsDefault(
  storage?: (Pick<Storage, "getItem"> & Pick<Storage, "setItem">) | null,
): Set<string> {
  const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
  const collapsed = loadCollapsedSections(target);
  let dirty = false;
  if (collapsed.has(LEGACY_BOT_CHATS_SECTION)) {
    collapsed.delete(LEGACY_BOT_CHATS_SECTION);
    collapsed.add(BOT_CHATS_SECTION);
    dirty = true;
  }
  try {
    if (target && target.getItem(SIDEBAR_BOT_CHATS_INIT_KEY) !== "1") {
      collapsed.add(BOT_CHATS_SECTION);
      target.setItem(SIDEBAR_BOT_CHATS_INIT_KEY, "1");
      dirty = true;
    }
    if (dirty) saveCollapsedSections(collapsed, target);
  } catch {
    collapsed.add(BOT_CHATS_SECTION);
  }
  return collapsed;
}

export function loadSectionOrder(storage?: Pick<Storage, "getItem"> | null): string[] {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    const raw = target?.getItem(SIDEBAR_SECTION_ORDER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((name): name is string => typeof name === "string" && name.length > 0)
      .map((name) => (name === LEGACY_BOT_CHATS_SECTION ? BOT_CHATS_SECTION : name));
  } catch {
    return [];
  }
}

export function saveSectionOrder(order: string[], storage?: Pick<Storage, "setItem"> | null): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(SIDEBAR_SECTION_ORDER_KEY, JSON.stringify(order));
  } catch {
    // Same private-browsing rule as the other sidebar prefs.
  }
}

export function orderSectionNames(names: string[], stored: string[]): string[] {
  const unique = [...new Set(names.filter((name) => name !== BOT_CHATS_SECTION))];
  const head = stored.filter((name) => unique.includes(name));
  const rest = unique.filter((name) => !head.includes(name));
  return [...head, ...rest];
}
