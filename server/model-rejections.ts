/**
 * Model-rejection marks: stop offering a model id the provider said it does
 * not have.
 *
 * A saved fallback chain holds model ids the owner picked weeks ago.  A
 * provider retires or renames one, and from then on every turn that reaches
 * that entry fails the same way: the CLI answers "no such model" before it does
 * any work.  Nothing remembered that answer, so each new user turn started over
 * at the primary, walked to the same dead entry, and spent a spawn on it.
 *
 * A mark is a fact about one (bot, engine instance, model) triple, so it is
 * keyed on all three.  Two other registries were considered and are wrong
 * for this:
 *
 *  - The doomed breaker (`doomed-dispatch.ts`) is keyed on (bot, engine) with
 *    no model.  Marking `claude-3-7-sonnet` dead there would refuse every
 *    healthy Claude entry on the same bot for fifteen minutes.
 *  - The quota cooldown (`model-fallback.ts`) is keyed on the model, but the
 *    Usage settings render every row of it as a quota hit, and its default TTL
 *    is fifteen minutes.  A retired model is not a quota.
 *
 * The TTL is long (six hours) because a model that does not exist stays that
 * way, and short enough that a fixed install or a fresh login is noticed the
 * same day.  Three things end a mark early: the model answering a turn, the
 * owner saving a selection that names it, and the engine being deleted or
 * reloaded.  A mark never blocks the primary outright: `resolveModel` routes
 * around a marked primary only when a usable fallback exists, and a chain whose
 * every entry is marked fails visibly instead of looping.
 *
 * Mirrors `DoomedDispatchRegistry` and `QuotaCooldownRegistry`: lazy expiry on
 * read, the same `enablePersist(path, write?)` seam, and a corrupt file is an
 * empty registry.  Importing this from model-fallback.ts is acyclic: its only
 * relative import is ./atomic.ts.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

/** How long a rejected model stays out of the walk. */
export const MODEL_REJECTION_TTL_MS = 6 * 60 * 60_000;

/** Answers "is this (bot, instance, model) currently marked rejected?".  Takes
 *  the same `now` the surrounding code holds so a whole chain is judged against
 *  one instant. */
export type ModelRejectionGate = (botId: string, instanceId: string, model: string, now: number) => boolean;

export interface ModelRejection {
  botId: string;
  instanceId: string;
  model: string;
  /** What the engine said, already redacted by the caller.  For a person and
   *  for logs; nothing branches on it. */
  reason: string;
  recordedAt: number;
  expiresAt: number;
}

export class ModelRejectionRegistry {
  private readonly rows = new Map<string, ModelRejection>();
  private persistPath: string | null = null;
  private persistImpl: ((path: string, json: string) => void) | null = null;

  private static key(botId: string, instanceId: string, model: string): string {
    return `${botId}:${instanceId}:${model}`;
  }

  enablePersist(path: string, write?: (path: string, json: string) => void): void {
    this.persistPath = path;
    this.persistImpl = write ?? null;
    this.load();
  }

  private persist(): void {
    if (!this.persistPath) return;
    const body = JSON.stringify({ version: 1, rejections: [...this.rows.values()] });
    if (this.persistImpl) {
      this.persistImpl(this.persistPath, body);
      return;
    }
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileAtomic(this.persistPath, body);
    } catch {
      /* a failed persist must not break a turn */
    }
  }

  private load(): void {
    if (!this.persistPath) return;
    try {
      if (!existsSync(this.persistPath)) return;
      const parsed = JSON.parse(readFileSync(this.persistPath, "utf8")) as { rejections?: unknown };
      if (!Array.isArray(parsed.rejections)) return;
      const now = Date.now();
      let removed = false;
      for (const row of parsed.rejections as Array<Partial<ModelRejection> | null>) {
        if (
          !row ||
          typeof row.botId !== "string" ||
          typeof row.instanceId !== "string" ||
          typeof row.model !== "string" ||
          typeof row.expiresAt !== "number" ||
          row.expiresAt <= now
        ) {
          removed = true;
          continue;
        }
        this.rows.set(ModelRejectionRegistry.key(row.botId, row.instanceId, row.model), {
          botId: row.botId,
          instanceId: row.instanceId,
          model: row.model,
          reason: typeof row.reason === "string" ? row.reason : "",
          recordedAt: typeof row.recordedAt === "number" ? row.recordedAt : now,
          expiresAt: row.expiresAt,
        });
      }
      if (removed) this.persist();
    } catch {
      /* corrupt file = empty registry */
    }
  }

  /** Mark a model rejected.  A second rejection restarts the clock. */
  record(input: { botId: string; instanceId: string; model: string; reason?: string; now?: number; ttlMs?: number }): ModelRejection {
    const now = input.now ?? Date.now();
    const row: ModelRejection = {
      botId: input.botId,
      instanceId: input.instanceId,
      model: input.model,
      reason: (input.reason ?? "").slice(0, 500),
      recordedAt: now,
      expiresAt: now + (input.ttlMs ?? MODEL_REJECTION_TTL_MS),
    };
    this.rows.set(ModelRejectionRegistry.key(row.botId, row.instanceId, row.model), row);
    this.persist();
    return row;
  }

  get(botId: string, instanceId: string, model: string, now = Date.now()): ModelRejection | undefined {
    const key = ModelRejectionRegistry.key(botId, instanceId, model);
    const row = this.rows.get(key);
    if (!row) return undefined;
    if (now >= row.expiresAt) {
      this.rows.delete(key);
      this.persist();
      return undefined;
    }
    return row;
  }

  isRejected(botId: string, instanceId: string, model: string, now = Date.now()): boolean {
    return this.get(botId, instanceId, model, now) !== undefined;
  }

  list(now = Date.now()): ModelRejection[] {
    const live: ModelRejection[] = [];
    let expired = false;
    for (const [key, row] of [...this.rows.entries()]) {
      if (now >= row.expiresAt) {
        this.rows.delete(key);
        expired = true;
      } else {
        live.push(row);
      }
    }
    if (expired) this.persist();
    return live;
  }

  clear(botId: string, instanceId: string, model: string): void {
    if (this.rows.delete(ModelRejectionRegistry.key(botId, instanceId, model))) this.persist();
  }

  clearWhere(predicate: (row: ModelRejection) => boolean): void {
    let changed = false;
    for (const [key, row] of [...this.rows.entries()]) {
      if (!predicate(row)) continue;
      this.rows.delete(key);
      changed = true;
    }
    if (changed) this.persist();
  }

  clearInstance(instanceId: string): void {
    this.clearWhere((row) => row.instanceId === instanceId);
  }
}

export const modelRejections = new ModelRejectionRegistry();

export function enableModelRejectionPersist(path: string): void {
  modelRejections.enablePersist(path);
}
