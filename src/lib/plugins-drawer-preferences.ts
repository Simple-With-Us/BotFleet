export const PLUGINS_DRAWER_WIDTH_KEY = "botfleet.pluginsDrawerWidth";

/** Right rail for the Plugins manager.  Half of an unsized flex sibling on a
 *  typical window is roughly a quarter of the viewport; 360px is the
 *  starting point before the person drags. */
export const DEFAULT_PLUGINS_DRAWER_WIDTH = 360;
export const MIN_PLUGINS_DRAWER_WIDTH = 280;
export const MAX_PLUGINS_DRAWER_WIDTH = 720;

export function parsePluginsDrawerWidth(value: string | null): number {
  if (value === null || value.trim() === "") return DEFAULT_PLUGINS_DRAWER_WIDTH;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PLUGINS_DRAWER_WIDTH;
  const whole = Math.round(parsed);
  if (whole < MIN_PLUGINS_DRAWER_WIDTH) return MIN_PLUGINS_DRAWER_WIDTH;
  if (whole > MAX_PLUGINS_DRAWER_WIDTH) return MAX_PLUGINS_DRAWER_WIDTH;
  return whole;
}

export function loadPluginsDrawerWidth(storage?: Pick<Storage, "getItem"> | null): number {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parsePluginsDrawerWidth(target?.getItem(PLUGINS_DRAWER_WIDTH_KEY) ?? null);
  } catch {
    return DEFAULT_PLUGINS_DRAWER_WIDTH;
  }
}

export function savePluginsDrawerWidth(
  width: number,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(PLUGINS_DRAWER_WIDTH_KEY, String(parsePluginsDrawerWidth(String(width))));
  } catch {
    // Private browsing may reject localStorage; width still applies this session.
  }
}
