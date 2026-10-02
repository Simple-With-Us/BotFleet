// What each engine instance last said its slash commands are.
//
// An engine announces its catalog only after a turn has run (the Claude init
// frame) or right after a session opens (ACP), and never when asked, so the
// command menu cannot be built from a probe.  This cache keeps the last
// announcement per engine instance, in memory and mirrored to a file in the
// data directory so a restart does not empty the menu.
//
//  - An announcement replaces the entry.
//  - An entry is dropped when the engine's version no longer matches the one
//    it was announced under (an upgrade can add or rename commands).
//  - There is no time limit: the built-in commands do not depend on the folder
//    a bot works in, so one turn on any bot of an instance fills the menu for
//    every bot on that instance.
//  - Reading never spawns, probes or wakes an engine.

import { existsSync, readFileSync } from "node:fs";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";

const entrySchema = z.object({
  /** the engine's version banner when it announced, or null if unknown */
  version: z.string().nullable(),
  names: z.array(z.string()),
  /** when it announced, in epoch milliseconds */
  at: z.number(),
});
export type EngineCommandEntry = z.infer<typeof entrySchema>;

const fileSchema = z.object({ schemaVersion: z.literal(1), instances: z.record(z.string(), entrySchema) });

export class EngineCommandCache {
  private readonly entries = new Map<string, EngineCommandEntry>();
  private readonly path: string | null;
  private readonly now: () => number;

  // Not a parameter property: the server runs under Node's strip-only
  // TypeScript mode, which rejects `constructor(private readonly x)`.
  constructor(path: string | null, now: () => number = () => Date.now()) {
    this.path = path;
    this.now = now;
    this.load();
  }

  /** Keep what an instance announced, replacing any earlier list. */
  record(instanceId: string, names: readonly string[], version: string | null): void {
    const previous = this.entries.get(instanceId);
    if (previous && previous.version === version && sameNames(previous.names, names)) {
      // the same list again: nothing to write
      return;
    }
    this.entries.set(instanceId, { version, names: [...names], at: this.now() });
    this.save();
  }

  /** The names an instance last announced, or null when it has not announced or
   *  announced under another version.  `version` is what the engine reports
   *  now; an unknown version on either side never drops an entry, because the
   *  registry has not always probed yet at boot. */
  get(instanceId: string, version: string | null): readonly string[] | null {
    const entry = this.entries.get(instanceId);
    if (!entry) return null;
    if (entry.version !== null && version !== null && entry.version !== version) {
      this.entries.delete(instanceId);
      this.save();
      return null;
    }
    return entry.names;
  }

  /** Forget an instance that was removed. */
  forget(instanceId: string): void {
    if (this.entries.delete(instanceId)) this.save();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      if (!parsed.success) return;
      for (const [instanceId, entry] of Object.entries(parsed.data.instances)) this.entries.set(instanceId, entry);
    } catch {
      // an unreadable mirror costs only a menu that fills again after the next turn
    }
  }

  private save(): void {
    if (!this.path) return;
    const instances = Object.fromEntries(this.entries);
    try {
      writeFileAtomic(this.path, `${JSON.stringify({ schemaVersion: 1, instances })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`[engine-commands] could not save the command cache: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}
