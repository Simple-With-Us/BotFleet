import { cn } from "./cn";

/** Viewport width at and below which right rails overlay chat instead of
 * shrinking it.  Electron's main window minWidth is 900; sidebar (320) plus
 * Bot Profile (400) / Computer (400) / Inspector (460) otherwise leaves as
 * little as ~120px of chat. */
export const RAIL_OVERLAY_MAX_PX = 1099;

/** Shared aside classes for Bot Profile, Inspector, Computer, and Group
 * settings.  Docked as a flex column from 1100px up; overlay/sheet below. */
export function railAsideClass(...extra: Array<string | false | null | undefined>) {
  return cn(
    "animate-panel-in z-20 flex h-full max-w-full shrink-0 flex-col border-l border-hairline/40 bg-panel",
    "max-[1099px]:absolute max-[1099px]:inset-y-0 max-[1099px]:right-0 max-[1099px]:shadow-2xl",
    "min-[1100px]:relative",
    ...extra,
  );
}
