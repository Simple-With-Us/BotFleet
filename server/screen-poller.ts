export type ScreenFrame = { png: string; mime: string };

type Entry = {
  timer: ReturnType<typeof setInterval> | null;
  capture: (force?: boolean) => Promise<void>;
  last: ScreenFrame | null;
  touched: boolean;
};

/** Keep per-turn capture state even without a viewer: tool use still earns a
 * settled screen message, but idle turns spend no box commands on previews. */
export class ScreenPollers {
  private readonly entries = new Map<string, Entry>();
  private readonly hasViewer: (botId: string) => boolean;
  private readonly publish: (botId: string, frame: ScreenFrame) => void;
  private readonly intervalMs: number;
  private readonly minGapMs: number;

  constructor(
    hasViewer: (botId: string) => boolean,
    publish: (botId: string, frame: ScreenFrame) => void,
    intervalMs = 6000,
    minGapMs = 3000,
  ) {
    this.hasViewer = hasViewer;
    this.publish = publish;
    this.intervalMs = intervalMs;
    this.minGapMs = minGapMs;
  }

  has(botId: string): boolean {
    return this.entries.has(botId);
  }

  start(botId: string, capture: () => Promise<{ png: string; format: string }>, screenIsTheWork = false): void {
    if (this.entries.has(botId)) return;
    let current: Promise<void> | null = null;
    let lastAt = -Infinity;
    const entry: Entry = {
      timer: null,
      last: null,
      touched: screenIsTheWork,
      capture: async (force = false) => {
        if (current) {
          await current;
          if (!force) return;
        }
        if (!force && Date.now() - lastAt < this.minGapMs) return;
        const pending = (async () => {
          try {
            const { png, format } = await capture();
            const frame = { png, mime: format === "jpeg" ? "image/jpeg" : "image/png" };
            entry.last = frame;
            this.publish(botId, frame);
          } catch {
            // The box may be asleep or busy.  A viewer can retry next tick.
          } finally {
            lastAt = Date.now();
            current = null;
          }
        })();
        current = pending;
        await pending;
      },
    };
    this.entries.set(botId, entry);
    this.viewerChanged();
  }

  /** A viewer joining mid-turn starts captures; the last viewer leaving stops
   * the timer without erasing the turn's tool-use state. */
  viewerChanged(): void {
    for (const [botId, entry] of this.entries) {
      if (this.hasViewer(botId)) {
        if (!entry.timer) {
          void entry.capture();
          entry.timer = setInterval(() => void entry.capture(), this.intervalMs);
        }
      } else if (entry.timer) {
        clearInterval(entry.timer);
        entry.timer = null;
      }
    }
  }

  poke(botId: string): void {
    const entry = this.entries.get(botId);
    if (!entry) return;
    entry.touched = true;
    if (this.hasViewer(botId)) void entry.capture();
  }

  stop(botId: string): void {
    const entry = this.entries.get(botId);
    if (!entry) return;
    if (entry.timer) clearInterval(entry.timer);
    this.entries.delete(botId);
  }

  async final(botId: string): Promise<ScreenFrame | null> {
    const entry = this.entries.get(botId);
    if (!entry) return null;
    this.stop(botId);
    if (!entry.touched) return null;
    await entry.capture(true);
    return entry.last;
  }
}
