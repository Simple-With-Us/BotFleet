// Turns engine events into helper snapshots, and decides which of those
// the wire may carry.  A running helper publishes at once when it starts,
// then at most once a second.  A helper that finishes publishes immediately.
//
// The tracker does not write the transcript.  The caller publishes each
// returned snapshot as `subagent.updated` and patches the row.
import type { RuntimeEvent } from "../contracts.ts";
import {
  HELPER_UPDATE_MIN_MS,
  helperActivityLine,
  helperLabel,
  helperToolFidelity,
  type HelperStatus,
  type SubagentSnapshot,
} from "../../shared/helpers.ts";

export interface HelperPublication {
  at: number;
  provider: string;
  providerInstanceId?: string;
  turnId?: string;
  subagent: SubagentSnapshot;
}

interface LiveHelper {
  snapshot: SubagentSnapshot;
  provider: string;
  providerInstanceId?: string;
  turnId?: string;
  lastPublishedAt: number;
  dirty: boolean;
}

interface PendingStep {
  title?: string;
  target?: string;
}

export class HelperTracker {
  private readonly lives = new Map<string, LiveHelper>();
  /** `threadId:itemId` of a step, to the helper it ran inside. */
  private readonly childOf = new Map<string, string>();
  /** Steps whose parent helper had not opened yet. */
  private readonly pendingSteps = new Map<string, PendingStep[]>();
  /** Helpers that already settled — late steps must not buffer forever. */
  private readonly settledKeys = new Set<string>();
  /** Running helpers per thread, innermost last — for named engines that
   * do not stamp a parent id on inner steps. */
  private readonly activeHelpers = new Map<string, string[]>();

  /** Snapshots that should go out now.  A change inside the one-second
   * cap is remembered for `due`. */
  observe(event: RuntimeEvent, now: number): HelperPublication[] {
    if (event.type === "subagent.updated") return [];
    const touched = this.apply(event, now);
    const out: HelperPublication[] = [];
    for (const key of touched) {
      const published = this.take(key, now, this.force(key));
      if (published) out.push(published);
    }
    this.trim();
    return out;
  }

  /** Snapshots whose held update has waited out the cap. */
  due(now: number): HelperPublication[] {
    const out: HelperPublication[] = [];
    for (const key of this.lives.keys()) {
      const live = this.lives.get(key);
      if (!live?.dirty) continue;
      if (live.snapshot.status === "running" && now - live.lastPublishedAt < HELPER_UPDATE_MIN_MS) continue;
      const published = this.take(key, now, true);
      if (published) out.push(published);
    }
    return out;
  }

  /** Milliseconds until the next held update, or null when nothing is waiting. */
  nextWait(now: number): number | null {
    let wait: number | null = null;
    for (const live of this.lives.values()) {
      if (!live.dirty || live.snapshot.status !== "running") continue;
      const remain = Math.max(0, HELPER_UPDATE_MIN_MS - (now - live.lastPublishedAt));
      if (wait === null || remain < wait) wait = remain;
    }
    return wait;
  }

  private force(key: string): boolean {
    return this.lives.get(key)?.snapshot.status !== "running";
  }

  private take(key: string, now: number, force: boolean): HelperPublication | null {
    const live = this.lives.get(key);
    if (!live) return null;
    if (!force && now - live.lastPublishedAt < HELPER_UPDATE_MIN_MS) {
      live.dirty = true;
      return null;
    }
    live.dirty = false;
    live.lastPublishedAt = now;
    const publication = this.publication(live, now);
    if (live.snapshot.status !== "running") this.lives.delete(key);
    return publication;
  }

  private publication(live: LiveHelper, at: number): HelperPublication {
    return {
      at,
      provider: live.provider,
      providerInstanceId: live.providerInstanceId,
      turnId: live.turnId,
      subagent: { ...live.snapshot },
    };
  }

  private key(threadId: string, id: string): string {
    return `${threadId}:${id}`;
  }

  private apply(event: RuntimeEvent, now: number): string[] {
    switch (event.type) {
      case "item.started":
        return event.itemType === "tool" ? this.onStarted(event, now) : [];
      case "item.completed":
        return event.itemType === "tool" ? this.onCompleted(event, now) : [];
      case "item.updated":
        return this.onUpdated(event);
      case "content.delta":
        return this.onDelta(event);
      case "turn.completed":
        return this.settleMatching(event, event.ok, now);
      case "session.exited":
        return this.settleMatching(event, false, now);
      case "session.started":
      case "session.invalidated":
      case "turn.started":
      case "turn.retrying":
      case "request.opened":
      case "request.resolved":
      case "thread.token-usage.updated":
      case "runtime.error":
      case "runtime.notice":
      case "context.injected":
      case "engine.commands":
      case "subagent.updated":
        return [];
      default: {
        const never: never = event;
        return never;
      }
    }
  }

  private onStarted(event: Extract<RuntimeEvent, { type: "item.started" }>, now: number): string[] {
    const itemId = event.itemId;
    if (!itemId) return [];
    const touched: string[] = [];
    const fidelity = helperToolFidelity(event.title);
    if (fidelity) {
      const id = itemId;
      const key = this.key(event.threadId, id);
      if (!this.lives.has(key)) {
        const parentKey = event.parentItemId ? this.key(event.threadId, event.parentItemId) : undefined;
        const parent = parentKey ? this.lives.get(parentKey) : undefined;
        const snapshot: SubagentSnapshot = {
          id,
          threadId: event.threadId,
          parentItemId: id,
          depth: parent ? parent.snapshot.depth + 1 : 1,
          fidelity: parent ? "typed" : fidelity,
          label: helperLabel(event.title ?? "Helper", event.target),
          toolCount: 0,
          startedAt: now,
          endedAt: null,
          status: "running",
        };
        const live: LiveHelper = {
          snapshot,
          provider: event.provider,
          providerInstanceId: event.providerInstanceId,
          turnId: event.turnId,
          lastPublishedAt: Number.NEGATIVE_INFINITY,
          dirty: true,
        };
        this.settledKeys.delete(key);
        this.lives.set(key, live);
        this.pushActiveHelper(event.threadId, id);
        this.replayPendingSteps(key, live);
      }
      touched.push(key);
    }
    const helperId = event.subagentId ?? event.parentItemId ?? this.topActiveHelper(event.threadId);
    if (helperId && helperId !== itemId && !fidelity) {
      this.childOf.set(this.key(event.threadId, itemId), helperId);
      const parentKey = this.key(event.threadId, helperId);
      const parent = this.lives.get(parentKey);
      if (parent && parent.snapshot.status === "running") {
        this.countStep(parent, event);
        touched.push(parentKey);
      } else if (!this.settledKeys.has(parentKey)) {
        const pending = this.pendingSteps.get(parentKey) ?? [];
        pending.push({ title: event.title, target: event.target });
        this.pendingSteps.set(parentKey, pending);
      }
    }
    return touched;
  }

  private countStep(
    parent: LiveHelper,
    event: Extract<RuntimeEvent, { type: "item.started" }>,
  ): void {
    parent.snapshot.toolCount += 1;
    const line = helperActivityLine(event.title, event.target);
    if (line) parent.snapshot.lastActivity = line;
    parent.dirty = true;
    this.noteSource(parent, event);
  }

  private replayPendingSteps(parentKey: string, parent: LiveHelper): void {
    const pending = this.pendingSteps.get(parentKey);
    if (!pending?.length) return;
    this.pendingSteps.delete(parentKey);
    for (const step of pending) {
      parent.snapshot.toolCount += 1;
      const line = helperActivityLine(step.title, step.target);
      if (line) parent.snapshot.lastActivity = line;
    }
    parent.dirty = true;
  }

  private pushActiveHelper(threadId: string, id: string): void {
    const stack = this.activeHelpers.get(threadId) ?? [];
    stack.push(id);
    this.activeHelpers.set(threadId, stack);
  }

  private removeActiveHelper(threadId: string, id: string): void {
    const stack = this.activeHelpers.get(threadId);
    if (!stack) return;
    const index = stack.lastIndexOf(id);
    if (index >= 0) stack.splice(index, 1);
    if (!stack.length) this.activeHelpers.delete(threadId);
  }

  private topActiveHelper(threadId: string): string | undefined {
    const stack = this.activeHelpers.get(threadId);
    return stack?.[stack.length - 1];
  }

  private onCompleted(
    event: Extract<RuntimeEvent, { type: "item.completed"; itemType: "tool" }>,
    now: number,
  ): string[] {
    const itemId = event.itemId;
    if (!itemId) return [];
    const own = this.key(event.threadId, itemId);
    const live = this.lives.get(own);
    if (live && live.snapshot.status === "running") {
      this.finish(live, event.ok ? "completed" : "failed", now);
      this.noteSource(live, event);
      return [own];
    }
    const helperId = event.subagentId ?? this.childOf.get(own);
    if (!helperId) return [];
    const parent = this.lives.get(this.key(event.threadId, helperId));
    if (!parent || parent.snapshot.status !== "running") return [];
    if (!event.ok && event.detail) {
      const line = helperActivityLine(undefined, event.detail);
      if (line) parent.snapshot.lastActivity = line;
      parent.dirty = true;
      this.noteSource(parent, event);
      return [this.key(event.threadId, helperId)];
    }
    return [];
  }

  private onUpdated(event: Extract<RuntimeEvent, { type: "item.updated" }>): string[] {
    if (event.itemType !== "tool" || event.tokens == null || event.tokens <= 0) return [];
    const helperId = event.subagentId ?? event.itemId;
    if (!helperId) return [];
    const key = this.key(event.threadId, helperId);
    const live = this.lives.get(key);
    if (!live || live.snapshot.status !== "running") return [];
    live.snapshot.tokens = (live.snapshot.tokens ?? 0) + event.tokens;
    live.dirty = true;
    this.noteSource(live, event);
    return [key];
  }

  private onDelta(event: Extract<RuntimeEvent, { type: "content.delta" }>): string[] {
    if (!event.subagentId || event.streamKind !== "assistant_text" || !event.delta.trim()) return [];
    const key = this.key(event.threadId, event.subagentId);
    const live = this.lives.get(key);
    if (!live || live.snapshot.status !== "running") return [];
    const line = helperActivityLine(undefined, event.delta);
    if (!line) return [];
    live.snapshot.lastActivity = line;
    live.dirty = true;
    this.noteSource(live, event);
    return [key];
  }

  /** A room thread can host two turns at once.  Ending one settles the
   * helpers that turn started, and a process exit settles the helpers of
   * that engine instance.  A helper with no turn id, or an exit with no
   * instance id, still settles with the thread: that is the single-turn
   * shape. */
  private settleMatching(
    event: Extract<RuntimeEvent, { type: "turn.completed" | "session.exited" }>,
    ok: boolean,
    now: number,
  ): string[] {
    const status: HelperStatus = ok ? "completed" : "failed";
    const touched: string[] = [];
    const settledIds = new Set<string>();
    for (const [key, live] of this.lives) {
      if (live.snapshot.threadId !== event.threadId || live.snapshot.status !== "running") continue;
      if (!this.belongsToSettlement(live, event)) continue;
      this.finish(live, status, now);
      touched.push(key);
      settledIds.add(live.snapshot.id);
    }
    const prefix = `${event.threadId}:`;
    for (const [child, helperId] of this.childOf) {
      if (child.startsWith(prefix) && settledIds.has(helperId)) this.childOf.delete(child);
    }
    return touched;
  }

  private belongsToSettlement(
    live: LiveHelper,
    event: Extract<RuntimeEvent, { type: "turn.completed" | "session.exited" }>,
  ): boolean {
    if (event.type === "session.exited") {
      if (event.providerInstanceId && live.providerInstanceId) return live.providerInstanceId === event.providerInstanceId;
      return true;
    }
    if (event.turnId && live.turnId) return live.turnId === event.turnId;
    return true;
  }

  private finish(live: LiveHelper, status: HelperStatus, now: number): void {
    live.snapshot.status = status;
    live.snapshot.endedAt = now;
    live.dirty = true;
    const helperKey = this.key(live.snapshot.threadId, live.snapshot.id);
    this.removeActiveHelper(live.snapshot.threadId, live.snapshot.id);
    this.pendingSteps.delete(helperKey);
    this.settledKeys.add(helperKey);
    if (this.settledKeys.size > 500) {
      const oldest = this.settledKeys.values().next().value;
      if (oldest !== undefined) this.settledKeys.delete(oldest);
    }
    const threadPrefix = `${live.snapshot.threadId}:`;
    for (const [child, parentId] of this.childOf) {
      if (child.startsWith(threadPrefix) && parentId === live.snapshot.id) this.childOf.delete(child);
    }
  }

  private noteSource(live: LiveHelper, event: RuntimeEvent): void {
    live.provider = event.provider;
    if (event.providerInstanceId) live.providerInstanceId = event.providerInstanceId;
    if (event.turnId) live.turnId = event.turnId;
  }

  /** A helper that never settles must not keep every thread's history. */
  private trim(): void {
    if (this.lives.size <= 200) return;
    for (const [key, live] of this.lives) {
      if (live.snapshot.status === "running") continue;
      this.lives.delete(key);
      if (this.lives.size <= 200) break;
    }
  }
}
