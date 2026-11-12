// Settings deep-link scroll: wait for the target card instead of racing it.
//
// Cards like Resources mount their target ids only after their fetch
// resolves, so the old fixed 80ms timeout missed slow loads and the
// auto-scroll silently failed.  Poll until the element exists or ~2s pass.
export const SETTING_HIGHLIGHT_CLASSES = [
  "ring-2",
  "ring-accent",
  "ring-offset-2",
  "ring-offset-panel",
  "shadow-[0_0_20px_rgba(33,139,255,0.35)]",
  "rounded-xl",
  "transition-all",
  "duration-300",
];

/** The subset the highlight timer clears, mirroring the modal's handler. */
export const SETTING_HIGHLIGHT_REMOVED_CLASSES = [
  "ring-2",
  "ring-accent",
  "ring-offset-2",
  "ring-offset-panel",
  "shadow-[0_0_20px_rgba(33,139,255,0.35)]",
];

/** The smallest surface the deep-link scroll needs: the real document
 *  satisfies it, and tests stub it without a single type assertion. */
export interface SettingScrollTarget {
  scrollIntoView(options?: ScrollIntoViewOptions): void;
  classList: { add(...tokens: string[]): void; remove(...tokens: string[]): void };
}

export interface SettingDoc {
  getElementById(id: string): SettingScrollTarget | null;
}

export function scrollToSettingDomId(
  domId: string,
  doc: SettingDoc = document,
  schedule: (fn: () => void, ms: number) => void = (fn, ms) => window.setTimeout(fn, ms),
  now: () => number = Date.now,
): void {
  const deadline = now() + 2000;
  const attempt = (): void => {
    const el = doc.getElementById(domId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add(...SETTING_HIGHLIGHT_CLASSES);
      schedule(() => {
        el.classList.remove(...SETTING_HIGHLIGHT_REMOVED_CLASSES);
      }, 2600);
      return;
    }
    if (now() < deadline) schedule(attempt, 100);
  };
  attempt();
}
