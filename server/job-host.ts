// BotFleet's host for the durable job runtime.
//
// Delegated work is an assignment in runtime.db, written before anything
// runs.  A restart reruns a cut turn once, unless that turn already acted
// outward.  Stop cancels work that has not started and does not resume the
// conversation the person stopped.  Peer approval, section checks, Off
// bots and the one-hop cap stay BotFleet's: they are stricter than the
// upstream tree, and a Chief's approval switch does not raise a teammate.
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { botIsOff } from "../shared/bot-power.ts";
import { getOrCreateChannel, mirrorExchange, type CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import { requestPeerApproval, type ApprovalBus } from "./peer-approval.ts";
import {
  Runtime,
  composeEnvelope,
  composeReport,
  openRuntimeStore,
  type Assignment,
  type EnqueueRequest,
  type EnqueueResult,
  type RunInput,
  type RunResult,
  type TurnRunner,
} from "./runtime/index.ts";
import { sectionKey, type BotRecord, type Store } from "./store.ts";

const FANOUT_CAP = 4;

/** Finished trees stay readable to assignment_status for this long. */
export const FINISHED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** One saved handoff.  Extra legacy fields, such as depth, are ignored. */
const legacyItemSchema = z.object({
  toBotId: z.string().min(1),
  message: z.string().min(1),
  reason: z.string().optional(),
});

const legacyQueueSchema = z.record(z.string(), z.unknown());
const legacyListSchema = z.array(z.unknown());

/** Activity rows that already changed something outside the workspace.
 *  A restart must not run that turn again. */
export function isOutwardActivity(name: string, target?: string): boolean {
  const blob = `${name} ${target ?? ""}`.trim();
  if (/^(github_push|github_commit|github_pr_create|zulip_post|zulip_reply|linq_voice_message)$/i.test(name)) return true;
  if (/\bgit\s+(push|commit)\b/i.test(blob)) return true;
  if (/\b(pay|charge|refund)\b/i.test(blob)) return true;
  if (/send_email|gmail_send|SEND_EMAIL/i.test(blob)) return true;
  if (/\b(publish|tweet)\b/i.test(blob)) return true;
  return false;
}

export interface CoordinateInput {
  fromBotId: string;
  fromThreadId: string;
  botIds: string[];
  message: string;
  reason?: string;
  rework?: boolean;
  thread?: "standing" | "new";
  reply?: "resume" | "none";
  consult?: boolean;
  doneWhen?: string;
  /** The caller's comms depth.  A peer turn is already at the cap. */
  depth: number;
}

export interface JobHostDeps {
  store: Store;
  commsBus: CommsBus;
  approvalBus: ApprovalBus;
  startTurn(
    botId: string,
    text: string,
    opts: {
      commsDepth: number;
      threadId?: string;
      unattended?: boolean;
      automationSource?: "delegation";
      from?: { botId: string; name: string; color: string };
      comm?: { groupId: string; withBotId: string; withName: string; withColor: string };
      onDispatchError?: (message: string) => void;
    },
  ): Promise<void>;
  subscribe(listener: (event: { type: string; threadId?: string; text?: string; ok?: boolean; itemType?: string }) => void): () => void;
  snoozed(botId: string): boolean;
  /** True when the caller is unattended, so the peer turn is too. */
  unattended(botId: string | undefined): boolean;
  /** Remember this peer turn so a reload or a stall can mirror how it ended. */
  watchDelegation?(threadId: string, channelId: string, botId: string): void;
  /** The turn never started.  Mirror that, once, into the channel. */
  abandonDelegation?(threadId: string, failureName: string): void;
  /** How long a finished tree stays readable.  Tests pass a short window. */
  finishedRetentionMs?: number;
}

export interface PublicAssignment {
  id: string;
  status: string;
  outcome?: string;
  outcomeDetail?: string;
  botId: string;
  botName?: string;
  duplicate?: boolean;
  result?: string;
  reply?: string;
}

export interface JobHostBody {
  error?: string;
  message?: string;
  assignments?: PublicAssignment[];
  assignment?: PublicAssignment;
  children?: PublicAssignment[];
  errors?: string[];
  [key: string]: unknown;
}

export interface JobHost {
  coordinate(input: CoordinateInput): { status: number; body: JobHostBody };
  status(fromBotId: string, fromThreadId: string, id?: string): { status: number; body: JobHostBody };
  stopThread(botId: string, threadId: string): void;
  onTurnSettled(threadId: string, ok: boolean, text: string): void;
  boot(): void;
  tick(): void;
  edges(): Array<{ sourceBotId: string; targetBotId: string; state: string; threadId: string; groupId?: string; reason?: string }>;
  /** The bot is gone.  Cancel every assignment it asked for or was asked to run. */
  releaseBot(botId: string): void;
  close(): void;
}

export function createJobHost(deps: JobHostDeps): JobHost {
  const store = openRuntimeStore(join(DATA_DIR, "runtime.db"));
  const channels = new Map<string, string>();
  const dispatching = new Set<string>();
  let imported = false;
  let lastPrune = 0;
  const retentionMs = deps.finishedRetentionMs ?? FINISHED_RETENTION_MS;

  const namesOf = (assignment: Assignment) => {
    const requester = assignment.requester.botId ? deps.store.bot(assignment.requester.botId) : undefined;
    const assignee = deps.store.bot(assignment.assignee.botId);
    return {
      requester: requester?.name ?? assignment.requester.botId ?? "a bot",
      assignee: assignee?.name ?? assignment.assignee.botId,
      person: "the person",
    };
  };

  const runner: TurnRunner = {
    validate(assignment) {
      const target = deps.store.bot(assignment.assignee.botId);
      if (!target) return "no such bot";
      if (target.hidden) return "that bot is hidden";
      if (botIsOff(target)) return "that bot is switched off";
      if (deps.snoozed(target.id)) return "that bot was stopped";
      const requesterId = assignment.requester.botId;
      const requester = requesterId ? deps.store.bot(requesterId) : undefined;
      if (requester && sectionKey(requester.section) !== sectionKey(target.section)) {
        return "that bot belongs to a different section";
      }
      if (requester && assignment.requester.threadId && !deps.store.threadBelongsToBot(requester.id, assignment.requester.threadId)) {
        return "source thread does not belong to sender";
      }
      return undefined;
    },
    canStart(assignment) {
      const target = deps.store.bot(assignment.assignee.botId);
      if (!target) return "no such bot";
      if (target.busy) return false;
      return true;
    },
    async run(assignment, input, signal) {
      const threadId = assignment.assignee.destination.threadId;
      dispatching.add(threadId);
      try {
        return await runTurn(assignment, input, signal);
      } finally {
        dispatching.delete(threadId);
      }
    },
    park(assignment, question) {
      const threadId = assignment.requester.threadId ?? assignment.assignee.destination.threadId;
      deps.store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `Needs input: ${question.slice(0, 160)}`, ok: false },
      });
    },
    report(assignment) {
      const who = deps.store.bot(assignment.assignee.botId)?.name ?? assignment.assignee.botId;
      const threadId = assignment.requester.threadId ?? assignment.assignee.destination.threadId;
      const detail = assignment.outcomeDetail ? ` — ${assignment.outcomeDetail}` : "";
      const ok = assignment.status === "completed";
      deps.store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `@${who} ${assignment.status}${assignment.outcome ? ` (${assignment.outcome})` : ""}${detail}`.slice(0, 240), ok },
      });
    },
    changed() {},
    names: namesOf,
    outward(assignment) {
      const since = assignment.startedAt ?? assignment.createdAt;
      return deps.store.messagesFor(assignment.assignee.destination.threadId).flatMap((message) => {
        if (message.at < since || message.tool?.ok === false) return [];
        const name = message.tool?.name ?? "";
        if (!name || !isOutwardActivity(name, message.tool?.target)) return [];
        return [message.tool?.target ? `${name} ${message.tool.target}` : name];
      });
    },
  };

  const runtime = new Runtime(store, runner, {
    limits: {
      depth: 1,
      requests: FANOUT_CAP,
      // The harness watchdog already ends a quiet turn.  A second clock
      // here would cancel work the watchdog still considers live.
      turnStallMs: Number.POSITIVE_INFINITY,
    },
    log: (line) => console.error("runtime:", line),
  });

  async function runTurn(assignment: Assignment, input: RunInput, signal: AbortSignal): Promise<RunResult> {
    if (signal.aborted) return { kind: "failed", outcome: "stopped", text: "Stopped before it started" };
    const target = deps.store.bot(assignment.assignee.botId);
    const requester = assignment.requester.botId ? deps.store.bot(assignment.requester.botId) : undefined;
    if (!target) return { kind: "failed", outcome: "refused", text: "no such bot" };
    if (requester?.approvePeerComms && input.turn === "first") {
      const verdict = await requestPeerApproval(
        deps.approvalBus,
        requester,
        target,
        assignment.brief,
        "coordinate_bots",
        assignment.requester.threadId,
      );
      if (verdict !== "allow") return { kind: "failed", outcome: "denied", text: "denied by user" };
      if (signal.aborted) return { kind: "failed", outcome: "stopped", text: "Stopped before it started" };
    }
    const fresh = deps.store.bot(target.id);
    const freshFrom = requester ? deps.store.bot(requester.id) : undefined;
    if (!fresh || (requester && !freshFrom)) return { kind: "failed", outcome: "refused", text: "no such bot" };
    if (fresh.busy) return { kind: "failed", outcome: "refused", text: `@${fresh.name} is busy` };
    // A resume of the requester is that bot continuing its own conversation.
    // A channel with itself would match any direct message it already has.
    const self = freshFrom?.id === fresh.id;
    const channel = freshFrom && !self ? getOrCreateChannel(deps.store, freshFrom, fresh) : undefined;
    if (channel) channels.set(assignment.id, channel.id);
    if (freshFrom && !self && input.turn === "first") {
      mirrorExchange(deps.commsBus, freshFrom, fresh, assignment.brief, channel, assignment.requester.threadId);
    }
    const settled = input.settled ?? [];
    const report = settled.length ? `${composeReport(assignment, settled, (child) => namesOf(child).assignee)}\n\n` : "";
    const text = `${input.restartNote}${report}${input.envelope || composeEnvelope(assignment, namesOf(assignment))}`;
    const threadId = assignment.assignee.destination.threadId;
    if (channel) deps.watchDelegation?.(threadId, channel.id, fresh.id);
    let dispatchError: string | undefined;
    let releaseWait = (_message: string) => {};
    const settledTurn = waitForTurn(threadId, signal, (release) => {
      releaseWait = release;
    });
    let from: { botId: string; name: string; color: string } | undefined;
    let comm: { groupId: string; withBotId: string; withName: string; withColor: string } | undefined;
    if (freshFrom && !self) {
      from = { botId: freshFrom.id, name: freshFrom.name, color: freshFrom.color };
      if (channel) comm = { groupId: channel.id, withBotId: freshFrom.id, withName: freshFrom.name, withColor: freshFrom.color };
    }
    const started = deps.startTurn(fresh.id, text, {
      commsDepth: assignment.depth,
      threadId,
      unattended: deps.unattended(freshFrom?.id),
      automationSource: "delegation",
      from,
      comm,
      onDispatchError: (message) => {
        dispatchError = message;
        releaseWait(message);
      },
    }).then(
      () => true,
      (error) => {
        dispatchError = error instanceof Error ? error.message : String(error);
        return false;
      },
    );
    const startedOk = await started;
    if (!startedOk || dispatchError) {
      releaseWait(dispatchError ?? "the turn could not start");
      noteCouldNotStart(assignment, threadId);
      return { kind: "failed", outcome: "provider_error", text: dispatchError ?? "the turn could not start" };
    }
    const result = await settledTurn;
    if (dispatchError) {
      noteCouldNotStart(assignment, threadId);
      return { kind: "failed", outcome: "provider_error", text: dispatchError };
    }
    // A turn that actually started is mirrored by the harness fold (and by
    // a provider reload) through the watch registered above.  Mirroring
    // here as well would write the same ending twice.
    if (result.ok) return { kind: "completed", text: result.text, evidence: outwardEvidence(threadId, assignment.startedAt) };
    return { kind: "failed", outcome: signal.aborted ? "stopped" : "provider_error", text: result.text || "the turn did not finish" };
  }

  function noteCouldNotStart(assignment: Assignment, threadId: string): void {
    const source = assignment.requester.threadId;
    if (source) {
      deps.store.appendMessage(source, {
        role: "bot",
        kind: "activity",
        tool: { name: "Delegated turn could not start", ok: false },
      });
    }
    deps.abandonDelegation?.(threadId, "Delegated turn could not start");
  }

  function waitForTurn(
    threadId: string,
    signal: AbortSignal,
    bindFailure: (release: (message: string) => void) => void,
  ): Promise<{ ok: boolean; text: string }> {
    return new Promise((resolve) => {
      let text = "";
      let done = false;
      const finish = (ok: boolean, out: string) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        unsub();
        resolve({ ok, text: out });
      };
      bindFailure((message) => finish(false, message));
      const onAbort = () => finish(false, text || "Stopped");
      signal.addEventListener("abort", onAbort, { once: true });
      const unsub = deps.subscribe((event) => {
        if (event.threadId !== threadId) return;
        if (event.type === "item.completed" && event.itemType === "assistant_text" && event.text) {
          text += (text ? "\n" : "") + event.text;
        } else if (event.type === "turn.completed") {
          finish(event.ok !== false, text);
        }
      });
    });
  }

  function outwardEvidence(threadId: string, since: number | undefined) {
    const labels = deps.store.messagesFor(threadId).flatMap((message) => {
      if (since !== undefined && message.at < since) return [];
      const name = message.tool?.name;
      if (!name || message.tool?.ok === false || !isOutwardActivity(name, message.tool?.target)) return [];
      return [message.tool?.target ? `${name} ${message.tool.target}` : name];
    });
    return labels.length ? { outward: labels } : undefined;
  }

  function runningRoot(botId: string, threadId: string): Assignment | undefined {
    return store.all({ nonTerminal: true }).find((row) =>
      row.parentId === undefined &&
      row.status === "running" &&
      row.assignee.botId === botId &&
      row.assignee.destination.threadId === threadId
    );
  }

  function destinationFor(target: BotRecord, thread: "standing" | "new", title: string): { ok: true; threadId: string; kind: "standing_thread" | "work_thread" } | { ok: false; reason: string } {
    if (thread === "standing") return { ok: true, threadId: target.threadId, kind: "standing_thread" };
    const task = deps.store.createTask(target.id, title.slice(0, 80), false);
    if (!task) return { ok: false, reason: "a new thread could not be opened" };
    return { ok: true, threadId: task.threadId, kind: "work_thread" };
  }

  function importLegacy(): void {
    if (imported) return;
    imported = true;
    const file = join(DATA_DIR, "delegations.json");
    const text = readLegacy(file);
    if (text === undefined) return;
    const moved = importLegacyText(text);
    retireLegacy(file);
    if (moved) console.log(`delegations: imported ${moved} queued handoff(s) into the job runtime`);
  }

  function importLegacyText(text: string): number {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return 0;
    }
    const parsed = legacyQueueSchema.safeParse(raw);
    if (!parsed.success) return 0;
    let moved = 0;
    for (const [threadId, value] of Object.entries(parsed.data)) {
      const list = legacyListSchema.safeParse(value);
      if (!list.success) continue;
      const from = deps.store.botByThread(threadId);
      if (!from) continue;
      for (const entry of list.data) {
        const item = legacyItemSchema.safeParse(entry);
        if (!item.success) continue;
        const target = deps.store.bot(item.data.toBotId);
        if (!target) continue;
        const message = item.data.message;
        const reason = item.data.reason ?? "";
        const requester: EnqueueRequest["requester"] = { kind: "bot_turn", botId: from.id, threadId };
        if (from.chiefOfStaff) requester.chief = true;
        const result = runtime.enqueue({
          origin: { kind: "person", source: "chat", ref: threadId },
          requester,
          assignee: { botId: target.id, destination: { kind: "standing_thread", threadId: target.threadId } },
          brief: reason ? `${message}\n\n[Reason: ${reason}]` : message,
          reply: "none",
          levels: { own: target.autoApprove ? "auto" : "ask" },
        });
        if (result.ok) moved += 1;
      }
    }
    return moved;
  }

  function sweepFinished(force: boolean): void {
    const now = Date.now();
    if (!force && now - lastPrune < PRUNE_INTERVAL_MS) return;
    lastPrune = now;
    runtime.prune(now - retentionMs);
  }

  const host: JobHost = {
    coordinate(input) {
      if (input.depth >= 1) {
        return { status: 200, body: { error: "delegation chains are limited to one hop — do this one yourself" } };
      }
      const from = deps.store.bot(input.fromBotId);
      if (!from) return { status: 404, body: { error: "no such bot" } };
      if (!deps.store.threadBelongsToBot(from.id, input.fromThreadId)) {
        return { status: 403, body: { error: "source thread does not belong to sender" } };
      }
      const message = input.message.trim();
      if (!message || input.botIds.length === 0) {
        return { status: 400, body: { error: "bot_ids and message are required" } };
      }
      const requester: EnqueueRequest["requester"] = { kind: "bot_turn", botId: from.id, threadId: input.fromThreadId };
      if (from.chiefOfStaff) requester.chief = true;
      const root = runningRoot(from.id, input.fromThreadId) ?? runtime.begin({
        origin: { kind: "person", source: "chat", ref: input.fromThreadId, quote: message.slice(0, 400) },
        requester,
        assignee: { botId: from.id, destination: { kind: "standing_thread", threadId: input.fromThreadId } },
        brief: message,
        level: from.autoApprove ? "auto" : "ask",
      });
      const assignments: PublicAssignment[] = [];
      const errors: string[] = [];
      const seen = new Set<string>();
      for (const rawId of input.botIds) {
        const token = rawId.trim();
        const target = deps.store.bots.find((bot) => bot.id === token || `@${bot.name}` === token || bot.name === token.replace(/^@/, ""));
        if (!target) {
          errors.push(`no such bot: ${token}`);
          continue;
        }
        if (seen.has(target.id)) continue;
        seen.add(target.id);
        if (target.id === from.id) {
          errors.push("a bot cannot hand work to itself");
          continue;
        }
        const where = destinationFor(target, input.thread ?? "standing", input.reason || message);
        if (!where.ok) {
          errors.push(where.reason);
          continue;
        }
        const levels: EnqueueRequest["levels"] = { own: target.autoApprove ? "auto" : "ask" };
        if (from.autoApprove) levels.chief = "auto";
        const request: EnqueueRequest = {
          parentId: root.id,
          origin: root.origin,
          requester: root.requester,
          assignee: { botId: target.id, destination: { kind: where.kind, threadId: where.threadId } },
          mode: input.consult ? "consult" : "work",
          reply: input.reply ?? "resume",
          brief: input.reason ? `${message}\n\n[Reason: ${input.reason}]` : message,
          levels,
        };
        if (input.doneWhen) request.doneWhen = input.doneWhen;
        if (input.rework) request.rework = true;
        const result: EnqueueResult = runtime.enqueue(request);
        if (!result.ok) {
          errors.push(result.reason);
          continue;
        }
        if (!result.duplicate) {
          const label = `Handed to @${target.name}${input.reason ? `: ${input.reason}` : ""}`;
          deps.store.appendMessage(input.fromThreadId, { role: "bot", kind: "activity", tool: { name: label } });
        }
        assignments.push({
          id: result.assignment.id,
          botId: target.id,
          botName: target.name,
          duplicate: result.duplicate,
          status: result.assignment.status,
        });
      }
      // Written now, started only after this turn settles.  Stop can still
      // cancel anything that has not started, and a crash finds the rows.
      if (assignments.length === 0) {
        return { status: 200, body: { error: errors[0] ?? "nothing was handed off" } };
      }
      const names = assignments.map((row) => `@${String(row.botName)}`).join(", ");
      const reply = input.reply ?? "resume";
      const messageBack = reply === "none"
        ? `Sent to ${names}.  Nothing comes back.`
        : `Handed to ${names}.  The result comes back on this conversation when the work finishes.`;
      const body: JobHostBody = { assignments, message: messageBack };
      if (errors.length) body.errors = errors;
      return { status: 200, body };
    },
    status(fromBotId, fromThreadId, id) {
      const from = deps.store.bot(fromBotId);
      if (!from) return { status: 404, body: { error: "no such bot" } };
      if (id) {
        const view = runtime.status(id);
        if (!view) return { status: 404, body: { error: "no such assignment" } };
        const owner = view.assignment.requester.botId === from.id || view.assignment.assignee.botId === from.id;
        if (!owner) return { status: 403, body: { error: "that assignment belongs to another bot" } };
        return { status: 200, body: { assignment: publicAssignment(view.assignment), children: view.children.map(publicAssignment) } };
      }
      const outstanding = runtime.outstanding({ botId: from.id, threadId: fromThreadId });
      return { status: 200, body: { assignments: outstanding.map(publicAssignment) } };
    },
    stopThread(botId, threadId) {
      runtime.stopRequester({ botId, threadId }, "Stopped by user");
    },
    onTurnSettled(threadId, ok, text) {
      if (dispatching.has(threadId)) return;
      const bot = deps.store.botByThread(threadId);
      if (!bot) return;
      const root = runningRoot(bot.id, threadId);
      if (!ok) {
        runtime.stopRequester({ botId: bot.id, threadId }, "Stopped by user");
        // This bot is idle again.  Work queued for it, or for anyone it was
        // blocking, still has to be admitted.
        runtime.tick();
        return;
      }
      if (root) runtime.end(root.id, { ok: true, text: text.trim() || lastSpoken(threadId) });
      // A turn that was not a runtime root can still free a bot a queued
      // assignment was waiting on.  Child turns tick themselves when they
      // settle; this covers the requester's own turn and a busy peer.
      runtime.tick();
    },
    boot() {
      runtime.open();
      importLegacy();
      sweepFinished(true);
      runtime.tick();
    },
    tick() {
      sweepFinished(false);
      runtime.tick();
    },
    edges() {
      return runtime.liveEdges().map((edge) => {
        const row = store.all({ nonTerminal: true }).find((item) =>
          item.assignee.botId === edge.targetBotId && item.assignee.destination.threadId === edge.threadId && item.parentId
        );
        const mapped = {
          sourceBotId: edge.sourceBotId,
          targetBotId: edge.targetBotId,
          state: edge.state,
          threadId: edge.threadId,
          groupId: edge.groupId,
          reason: row?.brief ? row.brief.slice(0, 80) : undefined,
        };
        return mapped;
      });
    },
    releaseBot(botId) {
      const ids: string[] = [];
      for (const row of store.all({ nonTerminal: true })) {
        if (row.assignee.botId === botId || row.requester.botId === botId) ids.push(row.id);
      }
      runtime.cancelMany(ids, "Bot deleted");
    },
    close() {
      runtime.close();
      store.close();
    },
  };

  function lastSpoken(threadId: string): string {
    const messages = deps.store.messagesFor(threadId);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role === "bot" && message.kind === "text" && message.text?.trim()) return message.text;
    }
    return "";
  }

  return host;
}

function publicAssignment(assignment: Assignment): PublicAssignment {
  const view: PublicAssignment = {
    id: assignment.id,
    status: assignment.status,
    botId: assignment.assignee.botId,
    result: assignment.result,
  };
  if (assignment.outcome) view.outcome = assignment.outcome;
  if (assignment.outcomeDetail) view.outcomeDetail = assignment.outcomeDetail;
  if (assignment.reply) view.reply = assignment.reply;
  return view;
}

function readLegacy(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function retireLegacy(file: string): void {
  const marked = `${file}.migrated`;
  const dest = existsSync(marked) ? `${marked}.${Date.now()}` : marked;
  try {
    renameSync(file, dest);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}
