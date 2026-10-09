import { mergeBotVoices, type BotVoices } from "../../shared/bot-voice";
import type { Bot, BotAnnouncement } from "./store";

/** A `voices` edit as the desktop sends it: only the device being changed.
 * `null` (or "") clears that device.  The top-level `voices: null` clears
 * both devices, so the desktop never sends it. */
export type DeviceVoicesPatch = { mac?: string | null; iphone?: string | null };

/** Every field written through the desktop's broad bot PATCH boundary. */
export type BotUpdatePatch = Partial<
  Pick<
    Bot,
    | "name"
    | "title"
    | "description"
    | "notifications"
    | "computers"
    | "cloudBackend"
    | "autoStartVps"
    | "color"
    | "mascotExpression"
    | "avatarUrl"
    | "avatarCrop"
    | "autoApprove"
    | "bypassPermissions"
    | "speakReplies"
    | "speechDevices"
    | "maxToolRounds"
    | "voice"
    | "voiceSummaryMode"
    | "pinned"
    | "hidden"
    | "off"
    | "section"
    | "pinnedMessageId"
    | "chiefOfStaff"
    | "approvePeerComms"
    | "composio"
    | "modelSelection"
    | "unread"
  >
> & {
  /** Per-device voice overrides.  Merged per device on every path, never
   * replaced wholesale, so a Mac edit cannot drop the iPhone's value. */
  voices?: DeviceVoicesPatch;
  /** Rides the PATCH body only: the server's proof that the local-auto
   * warning dialog was shown (see server/index.ts's consent gate). It must
   * reach the wire inside the coalesced body and must never fold into bot
   * state — the queue strips it from every overlay it hands back. */
  acknowledgeLocalAuto?: boolean;
};

interface BotPatchQueueEntry {
  botId: string;
  fallback: BotAnnouncement;
  pending: BotUpdatePatch;
  inFlight: BotUpdatePatch;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  controller: AbortController | null;
  cancelled: boolean;
  idleWaiters: Array<() => void>;
}

export interface BotPatchQueueOptions {
  delayMs?: number;
  send: (
    botId: string,
    patch: BotUpdatePatch,
    signal: AbortSignal,
  ) => Promise<BotAnnouncement>;
  reconcile: (botId: string, signal: AbortSignal) => Promise<BotAnnouncement | null>;
  onAuthoritative: (bot: BotAnnouncement, optimisticOverlay: BotUpdatePatch) => void;
  onError: (error: Error) => void;
}

export interface BotPatchQueue {
  enqueue: (botId: string, patch: BotUpdatePatch, fallback: BotAnnouncement) => void;
  flush: (botId: string) => Promise<void>;
  overlayFor: (botId: string) => BotUpdatePatch;
  cancel: (botId: string) => void;
  /** Undo a dispose. Exists for React StrictMode, whose dev-mode mount probe
   * runs the effect cleanup once against the SAME memoized queue — without
   * this, dispose() would permanently disable saving in development. */
  revive: () => void;
  dispose: () => void;
}

const hasFields = (patch: BotUpdatePatch): boolean => Object.keys(patch).length > 0;

/** What may fold back into renderer bot state: everything except the consent
 * flag, which is wire-only. One strip point covers both overlay paths. */
const stateOverlay = (patch: BotUpdatePatch): BotUpdatePatch => {
  const { acknowledgeLocalAuto: _ack, ...fields } = patch;
  return fields;
};

/** Coalesce two patches.  Every field but `voices` is last-write-wins;
 * `voices` merges per device, so a Mac edit followed by an iPhone edit inside
 * one debounce window sends both. */
export function mergeBotPatches(earlier: BotUpdatePatch, later: BotUpdatePatch): BotUpdatePatch {
  const merged = { ...earlier, ...later };
  if (earlier.voices && later.voices) merged.voices = { ...earlier.voices, ...later.voices };
  return merged;
}

/** Fold an optimistic patch into a bot.  `voices` is applied per device
 * (the same rule as the harness, shared/bot-voice.ts), so the device the
 * patch does not name keeps its stored value. */
export function applyBotPatch<T extends { voices?: BotVoices | null }>(bot: T, patch: BotUpdatePatch): T {
  const { voices, ...rest } = stateOverlay(patch);
  // SAFETY: `rest` holds only Bot fields from BotUpdatePatch (the consent
  // flag and `voices` are removed above), so spreading it over a Bot-shaped
  // T keeps T's shape; `voices` is then set to its merged BotVoices value.
  const next = { ...bot, ...rest } as T;
  if (voices !== undefined) next.voices = mergeBotVoices(bot.voices, voices) ?? null;
  return next;
}

/**
 * A per-bot mutation lane: edits debounce together, requests never overtake
 * one another, and every response/error is folded back from an authoritative
 * server bot while preserving only edits that were made later.
 */
export function createBotPatchQueue(options: BotPatchQueueOptions): BotPatchQueue {
  const entries = new Map<string, BotPatchQueueEntry>();
  const delayMs = options.delayMs ?? 400;
  let disposed = false;

  const settleIfIdle = (entry: BotPatchQueueEntry) => {
    if (entry.running || entry.timer !== null || hasFields(entry.pending)) return;
    entries.delete(entry.botId);
    for (const resolve of entry.idleWaiters.splice(0)) resolve();
  };

  const drain = async (entry: BotPatchQueueEntry): Promise<void> => {
    if (disposed || entry.running || entry.timer !== null || !hasFields(entry.pending)) return;
    entry.running = true;
    const patch = entry.pending;
    entry.pending = {};
    entry.inFlight = patch;
    const controller = new AbortController();
    entry.controller = controller;

    try {
      const bot = await options.send(entry.botId, patch, controller.signal);
      if (disposed || entry.cancelled) return;
      entry.fallback = bot;
      options.onAuthoritative(bot, stateOverlay(entry.pending));
    } catch (caught) {
      if (!disposed && !entry.cancelled) {
        // A rejected patch is no longer optimistic. Re-read before rolling back
        // because a lost HTTP response may still have committed and broadcast.
        entry.inFlight = {};
        let bot: BotAnnouncement | null = entry.fallback;
        try {
          bot = await options.reconcile(entry.botId, controller.signal);
          if (bot) entry.fallback = bot;
        } catch {
          // The captured pre-edit bot is safer than leaving rejected input in
          // state when the reconciliation request is unavailable too.
        }
        // Deletion may cancel this lane while the re-read is in flight. Folding
        // that result back into state would resurrect the deleted bot.
        if (disposed || entry.cancelled) return;
        if (bot) options.onAuthoritative(bot, stateOverlay(entry.pending));
        options.onError(caught instanceof Error ? caught : new Error(String(caught)));
      }
    } finally {
      entry.controller = null;
      entry.inFlight = {};
      entry.running = false;
      if (!disposed && !entry.cancelled) {
        if (hasFields(entry.pending) && entry.timer === null) void drain(entry);
        settleIfIdle(entry);
      }
    }
  };

  const schedule = (entry: BotPatchQueueEntry) => {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void drain(entry);
    }, delayMs);
  };

  return {
    enqueue(botId, patch, fallback) {
      if (disposed || !hasFields(patch)) return;
      const entry = entries.get(botId) ?? {
        botId,
        fallback,
        pending: {},
        inFlight: {},
        timer: null,
        running: false,
        controller: null,
        cancelled: false,
        idleWaiters: [],
      };
      entries.set(botId, entry);
      entry.pending = mergeBotPatches(entry.pending, patch);
      schedule(entry);
    },

    flush(botId) {
      const entry = entries.get(botId);
      if (!entry) return Promise.resolve();
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      const idle = new Promise<void>((resolve) => entry.idleWaiters.push(resolve));
      void drain(entry);
      settleIfIdle(entry);
      return idle;
    },

    overlayFor(botId) {
      const entry = entries.get(botId);
      return entry ? stateOverlay(mergeBotPatches(entry.inFlight, entry.pending)) : {};
    },

    cancel(botId) {
      const entry = entries.get(botId);
      if (!entry) return;
      entry.cancelled = true;
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.controller?.abort();
      entries.delete(botId);
      for (const resolve of entry.idleWaiters.splice(0)) resolve();
    },

    revive() {
      disposed = false;
    },

    dispose() {
      disposed = true;
      for (const entry of entries.values()) {
        entry.cancelled = true;
        if (entry.timer !== null) clearTimeout(entry.timer);
        entry.controller?.abort();
        for (const resolve of entry.idleWaiters.splice(0)) resolve();
      }
      entries.clear();
    },
  };
}
