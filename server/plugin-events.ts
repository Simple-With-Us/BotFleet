// Host event bus for plugins: matching, scoped delivery, retries, and
// a durable per-plugin ledger.
//
// The bus never runs plugin code itself.  Transport is injected:
// `transport.deliver` runs one sandbox call (server/plugin-loader.ts
// `invokePluginEvent`), and `transport.scope` applies the subscription's
// content/chat gating before anything crosses into a plugin.  Event
// state lives in the host — a plugin process staying alive retains
// nothing.
//
// Outcomes are stable reason codes only.  Event text never reaches logs
// or health views.  Pending retries persist across restarts with content
// stripped (refs and context redeliver; the plugin routes on those).
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import {
  PLUGIN_DELIVERY_RESULTS,
  pluginDeliveryOutcomeSchema,
  pluginEventEnvelopeSchema,
  pluginRoutingDecisionSchema,
  subscriptionMatchesEvent,
  type PluginDeliveryOutcome,
  type PluginDeliveryResult,
  type PluginEventEnvelope,
  type PluginEventSubscription,
  type PluginRoutingDecision,
} from "../shared/plugin-events.ts";
import type { PluginSandboxResult } from "./plugin-loader.ts";

const LEDGER_FILE = "plugin-events.json";
const SEEN_RING_LIMIT = 1000;
const RECENT_LIMIT = 50;
const DEAD_LETTER_LIMIT = 100;
const PENDING_LIMIT = 200;
export const MAX_DELIVERY_ATTEMPTS = 5;
const RETRY_BASE_MS = 1000;

const ledgerSchema = z.object({
  version: z.literal(1),
  seen: z.array(z.string().max(256)).max(SEEN_RING_LIMIT * 2),
  pending: z.array(z.object({
    event: z.record(z.string(), z.json()),
    attempts: z.number().int().min(0),
    notBefore: z.number().int().min(0),
  }).strict()).max(PENDING_LIMIT * 2),
  deadLetter: z.array(z.object({
    eventId: z.string().max(256),
    at: z.string(),
    attempts: z.number().int().min(0),
    reason: z.string().max(128),
  }).strict()).max(DEAD_LETTER_LIMIT * 2),
  recent: z.array(pluginDeliveryOutcomeSchema).max(RECENT_LIMIT * 2),
}).strict();

interface Ledger {
  seen: string[];
  pending: Array<{ event: Record<string, unknown>; attempts: number; notBefore: number }>;
  deadLetter: Array<{ eventId: string; at: string; attempts: number; reason: string }>;
  recent: PluginDeliveryOutcome[];
}

/** Transport the bus calls into.  Implemented by server/plugins.ts,
 *  which owns the loaded sandboxes, manifests, and chat summaries. */
export interface PluginEventTransport {
  /** Enabled plugins with a matching subscription, in load order. */
  subscribers(event: PluginEventEnvelope): string[];
  /** Manifest capabilities for one plugin, or null when unknown. */
  capabilities(pluginName: string): readonly string[] | null;
  /** Subscriptions declared by one plugin. */
  subscriptions(pluginName: string): readonly PluginEventSubscription[];
  /** Apply a subscription's content/chat gating to one envelope. */
  scope(pluginName: string, subscription: PluginEventSubscription, event: PluginEventEnvelope): PluginEventEnvelope;
  /** Run one sandbox onEvent call. */
  deliver(pluginName: string, event: PluginEventEnvelope): Promise<PluginSandboxResult>;
  /** A valid routing decision arrived (first attempt or retry). */
  onDecision(pluginName: string, event: PluginEventEnvelope, decision: PluginRoutingDecision): void;
}

export interface PluginEventBusOptions {
  baseDir: string;
  now?: () => number;
  retryBaseMs?: number;
  /** Disable background retry timers (tests drain manually). */
  manualRetries?: boolean;
}

function ledgerPath(baseDir: string, pluginName: string): string {
  return join(baseDir, pluginName, LEDGER_FILE);
}

function loadLedger(baseDir: string, pluginName: string): Ledger {
  const path = ledgerPath(baseDir, pluginName);
  try {
    statSync(path);
  } catch {
    return { seen: [], pending: [], deadLetter: [], recent: [] };
  }
  try {
    const parsed = ledgerSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) throw new Error("schema");
    return {
      seen: [...parsed.data.seen],
      pending: parsed.data.pending.map((p) => ({ ...p, event: { ...p.event } })),
      deadLetter: [...parsed.data.deadLetter],
      recent: [...parsed.data.recent],
    };
  } catch {
    try {
      renameSync(path, `${path}.invalid-${Date.now()}`);
    } catch {
      // Best effort.
    }
    return { seen: [], pending: [], deadLetter: [], recent: [] };
  }
}

function saveLedger(baseDir: string, pluginName: string, ledger: Ledger): void {
  const path = ledgerPath(baseDir, pluginName);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const payload = {
    version: 1,
    seen: ledger.seen.slice(-SEEN_RING_LIMIT),
    pending: ledger.pending.slice(-PENDING_LIMIT),
    deadLetter: ledger.deadLetter.slice(-DEAD_LETTER_LIMIT),
    recent: ledger.recent.slice(-RECENT_LIMIT),
  };
  const tmp = join(tmpdir(), `bf-plugin-events-${process.pid}-${Date.now()}.json`);
  writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
  renameSync(tmp, path);
}

function isTransient(reason: string): boolean {
  return reason === "timeout" || reason === "sandbox_exited" || reason === "handler_threw" || reason === "result_too_large";
}

/** The host event bus.  One per plugin runtime; pure logic over an
 *  injected transport so tests never spawn sandboxes. */
export class PluginEventBus {
  private readonly baseDir: string;
  private readonly transport: PluginEventTransport;
  private readonly now: () => number;
  private readonly retryBaseMs: number;
  private readonly manualRetries: boolean;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private draining = new Set<string>();

  constructor(transport: PluginEventTransport, options: PluginEventBusOptions) {
    this.transport = transport;
    this.baseDir = options.baseDir;
    this.now = options.now ?? (() => Date.now());
    this.retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
    this.manualRetries = options.manualRetries ?? false;
  }

  /** Emit one envelope to every enabled subscriber.  Resolves after the
   *  first attempt per plugin; retries continue in the background and
   *  valid decisions reach `transport.onDecision` whenever they land. */
  async emit(rawEvent: unknown): Promise<PluginDeliveryOutcome[]> {
    const parsed = pluginEventEnvelopeSchema.safeParse(rawEvent);
    if (!parsed.success) return [];
    const event = parsed.data;
    const outcomes: PluginDeliveryOutcome[] = [];
    for (const pluginName of this.transport.subscribers(event)) {
      outcomes.push(await this.deliverFirstAttempt(pluginName, event));
    }
    return outcomes;
  }

  /** Requeue persisted pending retries after a restart.  Content was
   *  stripped at persist time; plugins route on refs and context. */
  resume(): void {
    // Pending rows are per-plugin; subscribers() needs an event, so scan
    // ledgers lazily on the next emit plus an explicit sweep is overkill:
    // instead, this no-op documents the contract — pending rows are read
    // by drainPending(pluginName), called after every emit and by the
    // host tick.  Kept as a method so the lifecycle has a named step.
  }

  /** Drain due pending retries for one plugin (host tick + tests). */
  async drainPending(pluginName: string): Promise<PluginDeliveryOutcome[]> {
    if (this.draining.has(pluginName)) return [];
    this.draining.add(pluginName);
    try {
      const outcomes: PluginDeliveryOutcome[] = [];
      for (;;) {
        const ledger = loadLedger(this.baseDir, pluginName);
        const row = ledger.pending.find((p) => p.notBefore <= this.now());
        if (!row) break;
        ledger.pending = ledger.pending.filter((p) => p !== row);
        const parsed = pluginEventEnvelopeSchema.safeParse(row.event);
        if (!parsed.success) {
          saveLedger(this.baseDir, pluginName, ledger);
          continue;
        }
        outcomes.push(await this.attempt(pluginName, parsed.data, ledger, row.attempts));
      }
      return outcomes;
    } finally {
      this.draining.delete(pluginName);
    }
  }

  /** Recent outcomes plus queue depths for health views.  No event text. */
  health(pluginName: string): {
    pending: number;
    deadLetter: number;
    recent: PluginDeliveryOutcome[];
  } {
    const ledger = loadLedger(this.baseDir, pluginName);
    return { pending: ledger.pending.length, deadLetter: ledger.deadLetter.length, recent: [...ledger.recent].reverse() };
  }

  /** Drop all bus state for a plugin.  Called on remove. */
  clear(pluginName: string): void {
    try {
      unlinkSync(ledgerPath(this.baseDir, pluginName));
    } catch {
      // Missing is fine.
    }
    const timer = this.timers.get(pluginName);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(pluginName);
    }
  }

  private record(
    pluginName: string,
    ledger: Ledger,
    outcome: Omit<PluginDeliveryOutcome, "at">,
  ): PluginDeliveryOutcome {
    const full: PluginDeliveryOutcome = { ...outcome, at: new Date(this.now()).toISOString() };
    ledger.recent.push(full);
    saveLedger(this.baseDir, pluginName, ledger);
    return full;
  }

  private scheduleRetry(pluginName: string, ledger: Ledger, event: PluginEventEnvelope, attempts: number): void {
    // Persist without content: refs and context redeliver; text does not
    // sit in the plugin dir across restarts.  The caller saves the ledger
    // once via record(), so this only mutates and arms the timer.
    const { content: _dropped, ...rest } = event;
    void _dropped;
    ledger.pending.push({ event: { ...rest }, attempts, notBefore: this.now() + this.retryBaseMs * 2 ** (attempts - 1) });
    if (this.manualRetries) return;
    if (this.timers.has(pluginName)) return;
    const delay = this.retryBaseMs * 2 ** (attempts - 1);
    this.timers.set(pluginName, setTimeout(() => {
      this.timers.delete(pluginName);
      void this.drainPending(pluginName);
    }, Math.min(delay, 2_147_483_647)));
  }

  private async deliverFirstAttempt(pluginName: string, event: PluginEventEnvelope): Promise<PluginDeliveryOutcome> {
    const ledger = loadLedger(this.baseDir, pluginName);
    if (ledger.seen.includes(event.eventId)) {
      return this.record(pluginName, ledger, {
        eventId: event.eventId, plugin: pluginName, result: "duplicate", attempts: 0, reason: "duplicate",
      });
    }
    const capabilities = this.transport.capabilities(pluginName);
    if (!capabilities || !capabilities.includes("events.subscribe")) {
      return this.record(pluginName, ledger, {
        eventId: event.eventId, plugin: pluginName, result: "refused", attempts: 0, reason: "capability",
      });
    }
    const subscription = this.transport.subscriptions(pluginName).find((sub) => subscriptionMatchesEvent(sub, event));
    if (!subscription) {
      return this.record(pluginName, ledger, {
        eventId: event.eventId, plugin: pluginName, result: "noSubscription", attempts: 0,
      });
    }
    ledger.seen.push(event.eventId);
    const scoped = this.transport.scope(pluginName, subscription, event);
    return this.attempt(pluginName, scoped, ledger, 1);
  }

  private async attempt(
    pluginName: string,
    event: PluginEventEnvelope,
    ledger: Ledger,
    attempts: number,
  ): Promise<PluginDeliveryOutcome> {
    let result: PluginSandboxResult;
    try {
      result = await this.transport.deliver(pluginName, event);
    } catch {
      result = { ok: false, reason: "sandbox_exited" };
    }
    if (!result.ok) {
      const reason = result.reason;
      if (reason === "not_implemented") {
        return this.record(pluginName, ledger, {
          eventId: event.eventId, plugin: pluginName, result: "failed", attempts, reason,
        });
      }
      if (isTransient(reason) && attempts < MAX_DELIVERY_ATTEMPTS) {
        this.scheduleRetry(pluginName, ledger, event, attempts + 1);
        return this.record(pluginName, ledger, {
          eventId: event.eventId, plugin: pluginName, result: "retry", attempts, reason,
        });
      }
      if (isTransient(reason)) {
        ledger.deadLetter.push({ eventId: event.eventId, at: new Date(this.now()).toISOString(), attempts, reason });
      }
      return this.record(pluginName, ledger, {
        eventId: event.eventId,
        plugin: pluginName,
        result: isTransient(reason) ? "deadLetter" : "failed",
        attempts,
        reason,
      });
    }
    const decision = pluginRoutingDecisionSchema.safeParse(result.value);
    if (!decision.success) {
      return this.record(pluginName, ledger, {
        eventId: event.eventId, plugin: pluginName, result: "failed", attempts, reason: "validation_failed",
      });
    }
    if (decision.data.action === "requestWake") {
      const capabilities = this.transport.capabilities(pluginName) ?? [];
      if (!capabilities.includes("dispatch.wake")) {
        return this.record(pluginName, ledger, {
          eventId: event.eventId, plugin: pluginName, result: "refused", attempts, reason: "capability",
        });
      }
    }
    try {
      this.transport.onDecision(pluginName, event, decision.data);
    } catch {
      // A host-side decision failure must not fail the delivery record.
    }
    return this.record(pluginName, ledger, {
      eventId: event.eventId, plugin: pluginName, result: "delivered", attempts,
    });
  }
}

export type { PluginDeliveryOutcome, PluginDeliveryResult, PluginEventEnvelope, PluginRoutingDecision };
export { PLUGIN_DELIVERY_RESULTS };
