// Bot + thread persistence. bots.json holds bot records (including the
// thread→instance binding and per-instance resume cursors — upstream's
// ProviderSessionDirectory, recipe step 6: persist the binding from day
// one). messages-<threadId>.json holds the folded transcript.
import { existsSync, readFileSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { peerAllowKey, type PeerAction } from "./peer-approval-key.ts";
import { DATA_DIR } from "./config.ts";
import * as mdb from "./message-db.ts";
import { workspaceDir } from "./workspace.ts";
import { newId, type CloudBackend, type ModelSelection, type ThreadId, type TurnBillingMode } from "./contracts.ts";
import { pickBotName } from "./names.ts";
import { redactSecretsInText } from "./redact.ts";
import { botAvatarProfile, type BotAvatarCrop } from "../shared/bot-avatar.ts";
import { isSnoozeExpired, SNOOZE_UNTIL_ACTIVITY } from "../shared/thread-snooze.ts";
import type { ConnectorToolGrant } from "../shared/connector-tools.ts";
import type { RoutineRequestCardData } from "../shared/routine-request.ts";
import type { ToolKind } from "../shared/tool-activity.ts";

export type BotColor =
  | "green"
  | "blue"
  | "red"
  | "orange"
  | "purple"
  | "cyan"
  | "pink"
  | "yellow"
  | "teal"
  | "coral";

/**
 * The face a bot rests on, as one of the engine's state names. Kept as a plain
 * string rather than a union: bots saved under the app's earlier ten-face
 * vocabulary still carry those names, and the client resolves both on read.
 */
export type BotExpression = string;

/** @deprecated Prefer BotColor. */
export type MausColor = BotColor;
/** @deprecated Prefer BotExpression. */
export type MausExpression = BotExpression;

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  /** permission cards: the tool being requested, so the card can show what
   * is actually being asked and offer "always allow this tool". */
  tool?: string;
  /** why this stopped despite auto mode (destructive-looking command) */
  held?: string;
  /** the narrow grant "always allow" remembers, e.g. "Bash:git" */
  allowKey?: string;
  /** Local actions never share remembered grants with cloud/tool approvals. */
  approvalScope?: "local-computer";
  /** A durable chat-created routine proposal. The scheduler only applies it
   * after this card is explicitly confirmed by the user. */
  routineRequest?: RoutineRequestCardData;
}

export interface ConnectorCardData {
  /** Composio toolkit slug. It is validated server-side before every action. */
  slug: string;
  label: string;
  description: string;
  status: "required" | "authorizing" | "connected" | "failed";
  /** Cards created by one agent request resume together after all connect. */
  resumeKey: string;
  error?: string;
  dismissed?: boolean;
  resumed?: boolean;
}

export interface SecretRequestCardData {
  /** Fixed allowlisted credential id; never an arbitrary config path. */
  target: import("../shared/credential-request.ts").CredentialTargetId;
  label: string;
  description: string;
  placeholder: string;
  helpUrl: string;
  requestKey: string;
  provided?: boolean;
  dismissed?: boolean;
  resumed?: boolean;
  error?: string;
}

export interface Message {
  id: string;
  /** `system` is auto-delivered instructions (routine, webhook, resource).
   * Never a person typing — the model still sees it as the turn prompt. */
  role: "bot" | "user" | "system";
  /** For a `system` message: what actually fired it (mirrors
   * RoutineRunTrigger from ./routines.ts, inlined here so store.ts does not
   * depend on the routines module).  Lets the UI show an accurate subtitle
   * ("Run Now", "Resource Alert", "Webhook") instead of guessing from text,
   * and instead of collapsing every non-webhook/imessage system message
   * into a generic "Routine" label regardless of what actually triggered
   * it. */
  automationSource?: "schedule" | "manual" | "webhook" | "resource";
  kind: "text" | "options" | "activity" | "screen" | "connector" | "secret";
  text?: string;
  card?: OptionCardData;
  connector?: ConnectorCardData;
  secret?: SecretRequestCardData;
  /** activity messages: tool name + outcome. `spoken` is the same chip as
   * a phrase a voice can read ("reading a file") — computed once here so
   * call mode never has to re-derive it from the raw tool name, and absent
   * for chips not worth interrupting the ear for. */
  /** `setup` marks an error the user fixes by installing or configuring
   * something — the UI offers setup instead of a retry that cannot work. */
  tool?: {
    name: string;
    ok?: boolean;
    spoken?: string;
    setup?: boolean;
    /** what the step acted on — the path, command, pattern or URL the
     * engine already reported.  Clipped and home-shortened at the driver
     * boundary (`shared/tool-activity.ts`), never the whole payload: the
     * renderer holds every message of every thread, so a transcript row
     * carries a headline, not the evidence. */
    target?: string;
    /** coarse class of work, for the row's icon and verb */
    kind?: ToolKind;
    /** one line of what came back, or why it failed */
    detail?: string;
    /** wall time from start to completion, milliseconds */
    durationMs?: number;
  };
  /** user messages sent INTO a running turn (capabilities.queueing): the
   * model saw it mid-turn, so the transcript marks it — a reader should
   * know the reply above it may already account for this line */
  steered?: boolean;
  /** screen messages: a frame of the bot's computer (base64 image) */
  png?: string;
  mime?: string;
  at: number;
  /** the message this one follows; null = thread root. Edited messages
   * share a parentId with the version they replace — that's a fork. */
  parentId?: string | null;
  /** Optional flat reply reference. Unlike parentId this never changes the
   * conversation branch; it only quotes one earlier text message inline. */
  replyToId?: string;
  /** group threads: which member said this (sender attribution). */
  from?: { botId: string; name: string; color: string };
  /** emoji reactions; by = "user" or a member botId. */
  reactions?: Array<{ emoji: string; by: string }>;
  /** comm chips: "Messaged @X" in the caller's chat, linking to the
   * bot⇄bot channel where the exchange is mirrored. */
  comm?: { groupId: string; withBotId: string; withName: string; withColor: string };
  /** user messages sent while the bot was mid-turn, waiting in the
   * steer-queue to auto-send on settle. Cleared when the drain consumes
   * them; a true stranded by a restart is inert because the client only
   * shows the affordance while the bot is busy. */
  queued?: boolean;
  /** steer-queue entry this drained user line came from. The client pending
   * chip matches on this id, not on equal text. Absent on ordinary sends. */
  queueId?: string;
}

export type GroupDefaultResponder =
  | { kind: "member"; botId: string }
  | { kind: "everyone" }
  | { kind: "mentions" };

/** One independent conversation inside a user-created channel. Channel
 * membership and instructions stay on GroupRecord; transcript-bound state
 * lives here so switching tasks never moves a pin or working directory into
 * another provider context. */
export interface GroupTaskRecord {
  threadId: ThreadId;
  title: string;
  createdAt: number;
  pinnedCwd?: string | null;
  pinnedMessageId?: string;
}

/** A room: a shared thread where several bots + the user talk. Plain
 * messages follow `defaultResponder`; explicit @mentions always override it.
 * The bulletin is the room's shared instructions — every member's turn gets
 * it as part of its system prompt. */
export interface GroupRecord {
  id: string;
  /** The active task's thread. Direct-message channels remain single-threaded. */
  threadId: ThreadId;
  /** User-created channels have independent tasks, newest first. */
  tasks?: GroupTaskRecord[];
  name: string;
  avatarUrl?: string | null;
  avatarCrop?: "circle" | "rounded" | "square" | "mascot" | null;
  memberIds: string[];
  defaultResponder: GroupDefaultResponder;
  bulletin: string;
  unread: boolean;
  createdAt: number;
  /** true for auto-created bot⇄bot channels (ask_bot exchanges live here;
   * the user can open the channel and chip in) */
  dm?: boolean;
  /** transient: the member currently running a turn (never persisted) */
  busyBotId?: string | null;
  /** the room's shared desk: where member turns run their shell tools,
   * overriding each member's own folder. The room pins its own copy on its
   * first turn (pinnedCwd). Absent = each member's own default. */
  cwd?: string;
  /** Auxiliary / additional workspace folders for multi-repo channels. */
  extraCwds?: string[];
  /** Compatibility mirror of the active task's pinned folder. */
  pinnedCwd?: string | null;
  /** Compatibility mirror of the active task's pinned message. */
  pinnedMessageId?: string;
  /** sidebar section heading this room is filed under; shares the bots'
   * namespace so one heading can hold a project's room and its people */
  section?: string;
  /** New user-created rooms start with setup pending. Null timestamps are
   * intentional: records from before room setup has existed omit both keys
   * and remain immediately usable. */
  setupCompletedAt?: number | null;
  setupSkippedAt?: number | null;
}

/** One task = one conversation with its own context.
 *
 * A bot used to be a single endless thread, which meant every job
 * contaminated the next and the only way to get a clean slate was to
 * clone the bot. A task is that clean slate: its own thread, its own
 * transcript, and — the part that actually matters — its own provider
 * session. Sharing resume cursors between tasks would resume the other
 * task's session and quietly undo the whole thing. */
export interface TaskRecord {
  threadId: ThreadId;
  title: string;
  createdAt: number;
  /** provider-native continuation per instance, for THIS task only */
  resumeCursors: Record<string, unknown>;
  /** which instance dispatched the most recent turn. A cursor alone can't
   * say whether an engine's session is current — another engine may have
   * taken turns since — so this is what decides an inline replay. Absent
   * on tasks from before the field existed. */
  lastInstanceId?: string;
  /** what this task has spent: banked once per turn from turn.completed */
  usage?: TaskUsage;
  /** Per-instance breakdown of `usage`, banked from the selection that
   *  ACTUALLY ran each turn (post-fallback), so cost attribution follows
   *  the engine that ran, not the configured one.  Absent on records from
   *  before the field existed; those attribute whole-task, by the
   *  configured selection. */
  usageByInstance?: Record<string, InstanceUsage>;
  /** the folder this task's turns run in, pinned on its first turn from
   * the bot's `cwd` at that moment. Pinned, not read live: Claude keeps
   * sessions per project directory and Codex threads carry their cwd, so
   * a folder that moved under a live session would break resume. `null`
   * = pinned to the default (home); absent = not pinned yet. */
  cwd?: string | null;
  /** Optional engine for this conversation.  Absent means the bot's own
   * modelSelection.  Used in Projects mode so a thread is not a named bot. */
  modelSelection?: ModelSelection;
  /** The model selection that actually ran on the most recent turn (post-fallback). */
  activeModelSelection?: ModelSelection;
  /** Stable identity for a webhook, resource trigger, or routine so a
   * re-fire appends here instead of minting another task.  Shape is
   * `webhook:<id>` or `routine:<id>` from `automationThreadKey`. */
  automationKey?: string;
  /** Extra automation keys folded in by `mergeBotTasks` when the task that
   * originally owned them was merged into this one.  A merged source's key
   * (and its own aliases) move here rather than being dropped, so the next
   * firing still finds this task through `taskByAutomationKey` instead of
   * falling through to the run-history fallback (which fails once the
   * source task is gone) and minting a duplicate. */
  automationKeyAliases?: string[];
  /** This thread is asleep: 0 sleeps until the thread does anything again,
   * a timestamp sleeps until that moment, and absent means awake.  Narrower
   * than the bot-wide snooze in `server/routines.ts` — the bot keeps working
   * its other threads.  See `shared/thread-snooze.ts`. */
  snoozedUntil?: number;
}

export interface TaskUsage {
  input: number;
  output: number;
  /** The part of `input` the provider served from its prompt cache — context
   * the model re-read rather than fresh text. Every turn resends the whole
   * conversation plus the system prompt and tool schemas, so on a chatty
   * thread this is most of `input`. Absent on records from older builds. */
  cachedInput?: number;
  /** null until any turn reports a cost — most engines never do. Records
   * written by builds before cost existed lack the field; read as null. */
  costUsd: number | null;
  turns: number;
}

/** Per-instance usage bucket: the running tally plus the registry engine
 *  (driver kind) resolved when the turn banked — so attribution survives
 *  the connection being deleted — and a per-model breakdown so pricing
 *  and session rows can follow the model that actually ran. */
export type InstanceUsage = TaskUsage & {
  engineId?: string;
  byModel?: Record<string, TaskUsage>;
};

/** Room buckets add the most-recent-turn timestamp for period windows. */
export type RoomUsage = InstanceUsage & { lastAt: number };

/** Merge one settled turn into a running usage tally.  Shared by the
 *  per-task ledger, its per-instance breakdown, and the per-bot room
 *  ledger so all three clean and accumulate identically. */
function mergeTaskUsage(
  prev: TaskUsage | undefined,
  turn: { input?: number; output?: number; cachedInput?: number; costUsd: number | null; billingMode?: TurnBillingMode },
): TaskUsage {
  const base: TaskUsage = { input: 0, output: 0, costUsd: null, turns: 0, ...prev };
  const cost = turn.billingMode !== "estimated" && typeof turn.costUsd === "number" && Number.isFinite(turn.costUsd)
    ? turn.costUsd
    : null;
  const prevCost = typeof base.costUsd === "number" ? base.costUsd : null;
  // providers occasionally report NaN or a negative on a partial turn —
  // never let that poison a running tally
  const clean = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
  // the cached share exists on a record only once a driver has reported
  // it — a driver that never does leaves the record shaped as before
  const cachedKnown = typeof base.cachedInput === "number" || typeof turn.cachedInput === "number";
  const prevInput = clean(base.input);
  const turnInput = clean(turn.input);
  const nextCachedInput = Math.min(clean(base.cachedInput), prevInput)
    + Math.min(clean(turn.cachedInput), turnInput);
  return {
    input: prevInput + turnInput,
    output: base.output + clean(turn.output),
    ...(cachedKnown ? { cachedInput: nextCachedInput } : {}),
    costUsd: cost === null ? prevCost : (prevCost ?? 0) + cost,
    turns: base.turns + 1,
  };
}

/** A custom connection can be deleted and recreated under the same slug
 *  with a DIFFERENT driver.  Banking the new turns into the same bucket
 *  would re-attribute the old usage to the new engine, so an engine change
 *  on an already-banked instance forks the bucket onto a suffixed key.
 *  The same holds for a pre-upgrade bucket with turns but no engineId:
 *  stamping it with whatever engine banks next would re-attribute history
 *  that may belong to a different (possibly deleted) driver, so it forks
 *  too — the legacy bucket keeps its honest "unknown engine" shape. */
function forkKey(
  byInstance: Record<string, InstanceUsage>,
  instanceId: string,
  meta?: { engineId?: string; model?: string },
): string {
  const prev = byInstance[instanceId];
  if (meta?.engineId) {
    if (prev?.engineId && prev.engineId !== meta.engineId) {
      return `${instanceId}~${meta.engineId}`;
    }
    if (!prev?.engineId && (prev?.turns ?? 0) > 0) {
      return `${instanceId}~${meta.engineId}`;
    }
  }
  return instanceId;
}

/** Merge one settled turn into a per-instance bucket, preserving any
 *  engineId/byModel the bucket already carries. */
function mergeInstanceUsage(
  prev: InstanceUsage | undefined,
  turn: { input?: number; output?: number; cachedInput?: number; costUsd: number | null; billingMode?: TurnBillingMode },
  meta?: { engineId?: string; model?: string },
): InstanceUsage {
  const out: InstanceUsage = mergeTaskUsage(prev, turn);
  const engineId = meta?.engineId ?? prev?.engineId;
  if (engineId) out.engineId = engineId;
  if (meta?.model) {
    out.byModel = { ...(prev?.byModel ?? {}) };
    out.byModel[meta.model] = mergeTaskUsage(prev?.byModel?.[meta.model], turn);
  } else if (prev?.byModel) {
    out.byModel = prev.byModel;
  }
  return out;
}

/** Everything the BOT authored is scrubbed of content-shaped secrets before
 * it is stored: its reply text, a tool title (an ACP engine's title can be
 * the whole command line), a permission card's summary. What the user typed
 * is theirs and stays as typed. Stored, not just displayed: the transcript
 * is replayed into every rebuild, and a leaked key would otherwise be
 * permanent. */
function redactBotAuthored<T extends Omit<Message, "id" | "at"> & { at?: number }>(message: T): T {
  if (message.role !== "bot") return message;
  const out = { ...message };
  if (typeof out.text === "string") out.text = redactSecretsInText(out.text);
  if (out.tool?.name) out.tool = { ...out.tool, name: redactSecretsInText(out.tool.name) };
  if (out.card) {
    const card = { ...out.card } as OptionCardData & { summary?: string };
    card.title = redactSecretsInText(card.title);
    if (typeof card.subtitle === "string") card.subtitle = redactSecretsInText(card.subtitle);
    if (typeof card.summary === "string") card.summary = redactSecretsInText(card.summary);
    if (typeof card.held === "string") card.held = redactSecretsInText(card.held);
    // Routine definitions are executable bot-authored text stored behind the
    // visible summary. Scrub the durable payload too so nesting it on a card
    // cannot bypass the transcript's secret-redaction boundary.
    if (card.routineRequest) {
      const operation = card.routineRequest.operation;
      card.routineRequest = {
        ...card.routineRequest,
        operation: operation.action === "create"
          ? {
              ...operation,
              routine: {
                ...operation.routine,
                name: redactSecretsInText(operation.routine.name),
                instructions: redactSecretsInText(operation.routine.instructions),
              },
            }
          : operation.action === "update"
            ? {
                ...operation,
                changes: {
                  ...operation.changes,
                  ...(typeof operation.changes.name === "string"
                    ? { name: redactSecretsInText(operation.changes.name) }
                    : {}),
                  ...(typeof operation.changes.instructions === "string"
                    ? { instructions: redactSecretsInText(operation.changes.instructions) }
                    : {}),
                },
              }
            : { ...operation },
      };
    }
    out.card = card;
  }
  if (out.connector) {
    out.connector = {
      ...out.connector,
      label: redactSecretsInText(out.connector.label),
      description: redactSecretsInText(out.connector.description),
      error: out.connector.error ? redactSecretsInText(out.connector.error) : undefined,
    };
  }
  if (out.secret) {
    out.secret = {
      ...out.secret,
      label: redactSecretsInText(out.secret.label),
      description: redactSecretsInText(out.secret.description),
      error: out.secret.error ? redactSecretsInText(out.secret.error) : undefined,
    };
  }
  return out;
}

/** What changed, emitted by the store itself right after each write. The
 * server maps these onto its SSE frames in ONE place, so no mutation path
 * can persist without the app hearing about it — the two-write-paths bug
 * (persist without emit → UI drifts; emit without persist → a restart
 * loses what the user just watched) is closed by construction. Bot and
 * group changes carry only the id: the wire shape (cursor stripping) is
 * the caller's business. */
export type BotActivity = "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
/** The states in which the bot cannot take a new message. */
export const ACTIVITY_BUSY: ReadonlySet<BotActivity> = new Set(["working", "waiting-on-you", "no-signal"]);

export type StoreChange =
  | { type: "message"; threadId: string; message: Message }
  | { type: "message.patch"; threadId: string; message: Message }
  | { type: "thread"; threadId: string; activeLeafId: string }
  | { type: "thread.deleted"; threadId: string }
  | { type: "bot"; botId: string }
  | { type: "bot.deleted"; botId: string }
  | { type: "group"; groupId: string }
  | { type: "group.deleted"; groupId: string };

/** What a task is called before its first message names it. */
export const UNTITLED_TASK = "New task";

/** A task's name, taken from the first thing you asked it to do. */
export function titleFromMessage(text: string): string {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line || UNTITLED_TASK;
}

export interface BotRecord {
  /** Shared-room turns this bot spoke, banked per engine instance (room
   *  threads are not bot tasks, so they cannot live on the task ledger).
   *  `lastAt` is the most recent turn in the bucket, for period windows. */
  roomUsageByInstance?: Record<string, RoomUsage>;
  id: string;
  /** the ACTIVE task's thread — everything that runs a turn reads this */
  threadId: ThreadId;
  /** every task this bot has, newest first */
  tasks?: TaskRecord[];
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: BotColor;
  mascotExpression?: BotExpression | null;
  /** App-owned attachment served as this bot's custom profile image. */
  avatarUrl?: string;
  /** Mascot, or the crop applied to avatarUrl. */
  avatarCrop?: BotAvatarCrop;
  unread: boolean;
  modelSelection: ModelSelection;
  /** The model selection that actually ran on the most recent turn (post-fallback). */
  activeModelSelection?: ModelSelection;
  /** provider-native continuation per instance (e.g. claude session id) */
  resumeCursors: Record<string, unknown>;
  /** which computer the bot acts on: its cloud box, this Mac (local CUA),
   * or none. Unset = auto (box when it exists, else local when available). */
  computers?: Array<"cloud" | "vm" | "local">;
  /** Which cloud computer backs `computer: "cloud"`; absent means Box. */
  cloudBackend?: CloudBackend;
  /** Auto mode may prepare/start this bot's managed VPS container. Off by
   * default because starting remote infrastructure is an external action. */
  autoStartVps?: boolean;
  /** where NEW tasks run their shell tools; each task pins its own copy
   * on its first turn (TaskRecord.cwd). Absent = the home folder. */
  cwd?: string;
  /** Auto mode: the bot approves its own tool permissions and keeps
   * working instead of stopping to ask. Questions it asks YOU still come
   * through, and a short list of destructive commands still stops it. */
  autoApprove?: boolean;
  /** Optional model review of otherwise undecided, attended approval cards.
   * Unknown persisted values are treated as off by the review boundary. */
  autoReview?: "off" | "shadow" | "enforce";
  /** Tools this bot may always use without asking, even outside auto mode
   * (set by "Always allow" on an approval card). */
  alwaysAllow?: string[];
  /** Ceiling on model→tool rounds for HTTP toolLoop engines (MiniMax / Grok
   * HTTP / openai-compat). Unset = DEFAULT_TURN_LOOP_BUDGET.maxRounds (12).
   * Integer 1..200; invalid values are treated as absent at dispatch. */
  maxToolRounds?: number;
  /** Speak this bot's replies aloud as they settle, without being asked.
   * Off by default: a hosted voice costs money per character, so speaking
   * is something you turn on, never something that happens to you. */
  speakReplies?: boolean;
  /** This bot's own voice id, so a room of bots doesn't sound like one
   * person. Falls back to the app-wide voice in config. */
  voice?: string;
  /** true after an edit/branch-switch rewound the visible conversation:
   * provider sessions still hold the abandoned branch, so the next turn
   * must start fresh (drop cursors) and replay the surviving path. */
  rewound?: boolean;
  pinned?: boolean;
  hidden?: boolean;
  /** Optional labeled divider used to organize this bot in the sidebar. */
  section?: string;
  /** the one message pinned to the top of this bot's active thread; a pin
   * that no longer resolves (branch switched away, deleted) renders nothing */
  pinnedMessageId?: string;
  /** The coordinator for this bot's sidebar section. The store enforces
   * at most one Chief per section (including the unsectioned area). */
  chiefOfStaff?: boolean;
  /** Pause for human approval before this bot talks to a peer (ask_bot,
   * delegate_bot). Off by default: a chief-of-staff-style bot is most
   * useful when it can coordinate without nagging. */
  approvePeerComms?: boolean;
  /** Whether this bot may use the workspace's connected apps (Composio).
   * Unset/true = allowed (the user configured the key deliberately);
   * false = this bot never receives the connection. Imported team members
   * start false — a shared persona must not reach the user's Gmail on
   * turn one. */
  composio?: boolean;
  /** Per-bot Composio tool grants. Unset = legacy all-tools (every
   * connected service, every tool) — added after bots already existed, so
   * an untouched bot must keep working exactly as before. An explicit
   * record — including the empty one — restricts to exactly what it names;
   * enforced in the /api/internal/connectors/mcp relay (connector-verdict.ts),
   * never here. See shared/connector-tools.ts for the grant shape. */
  connectorTools?: Record<string, ConnectorToolGrant>;
  /** Additional repo paths for context. */
  extraCwds?: string[];
  /** Custom user-provided instructions and persistent memory notes. */
  userNotes?: string;
  /** Public, package-authored playbooks installed for this bot. They carry
   * process guidance only—never executable code, credentials, or grants. */
  playbooks?: InstalledPlaybook[];
  /** Listing provenance and connector intent retained for package details
   * and future re-export. It never means the apps are authorized. */
  installedPackage?: InstalledPackageMetadata;
  /** Derived from `activity` — kept so the 200+ readers across the app and
   * tests keep working unchanged. Write through setActivity(), never here. */
  busy?: boolean;
  activityStartedAt?: number;
  /** What the bot is doing right now, as the harness sees it. `busy` alone
   * could not tell working from waiting-on-you from a stalled engine.
   * Transient like busy: reset to idle on load. */
  activity?: BotActivity;
  /** Durable crash marker: the thread a turn was dispatched on. Cleared
   * when that turn settles. Unlike activity/busy, this survives restart. */
  inflightThreadId?: string;
  createdAt: number;
}

export interface InstalledPlaybook {
  key: string;
  name: string;
  summary: string;
  triggers: string[];
  instructions: string;
}

export interface InstalledPackageMetadata {
  id: string;
  name: string;
  release: string;
  requiredApps: Array<{ slug: string; label: string; reason: string; optional?: boolean }>;
}

const BOTS_FILE = join(DATA_DIR, "bots.json");
const GROUPS_FILE = join(DATA_DIR, "groups.json");
/** How long a burst of saveBots() calls coalesces into one atomic write. */
const BOTS_SAVE_DEBOUNCE_MS = 250;
const messagesFile = (threadId: string) => join(DATA_DIR, `messages-${threadId}.json`);

const COLORS: BotColor[] = [
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
  "coral",
];

/** Sections are persisted as display labels, so exact trimmed labels are
 * their identity. Missing/blank means the unsectioned (General) team. */
export const sectionKey = (section?: string | null): string => section?.trim() || "";

/** Resolve @mentions in a message against a bot roster: `@` must start a
 * word, the name must end on a word boundary (so "@New Bottle" never matches
 * "New Bot"), names match case-insensitively, longest name wins (so
 * "@New Bot 2" never half-matches "New Bot"), hidden bots skipped, results
 * deduped. Callers pre-filter the sender out of `peers`. */
export function mentionedBots<T extends { name: string; hidden?: boolean }>(text: string, peers: T[]): T[] {
  const candidates = peers
    .filter((p) => !p.hidden && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  const found: T[] = [];
  let at = -1;
  while ((at = lower.indexOf("@", at + 1)) !== -1) {
    if (at > 0 && !/\s/.test(text[at - 1])) continue; // user@host, not a tag
    const rest = lower.slice(at + 1);
    const hit = candidates.find((p) => {
      const name = p.name.toLowerCase();
      if (!rest.startsWith(name)) return false;
      const after = rest[name.length]; // must not run into a longer word
      return after === undefined || !/[a-z0-9]/i.test(after);
    });
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}

/** Keep live bot ids.  Deleted-bot ghosts that were already on the roster are
 * dropped so a phone save of name/bulletin/folder is not blocked by an id the
 * Members toggles cannot show.  A newly added unknown id is still an error. */
export function resolveRoomMemberIds(
  value: unknown,
  existingIds: readonly string[] | undefined,
  botExists: (id: string) => boolean,
): { ok: true; memberIds: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "memberIds must be a list of bot IDs" };
  const existing = new Set(existingIds ?? []);
  for (const id of value) {
    if (typeof id !== "string" || !id.trim()) {
      return { ok: false, error: `unknown channel member: ${String(id)}` };
    }
    if (botExists(id) || existing.has(id)) continue;
    return { ok: false, error: `unknown channel member: ${id}` };
  }
  const memberIds = [...new Set(value.filter((id): id is string => typeof id === "string" && botExists(id)))];
  if (!memberIds.length) return { ok: false, error: "a channel needs at least one bot" };
  return { ok: true, memberIds };
}

/** Normalize persisted or API-provided routing. Old rooms did not have this
 * field; giving them their first member as lead fixes the old silent-send
 * behavior without making every prompt fan out to every model. */
export function normalizeGroupDefaultResponder(
  value: unknown,
  memberIds: string[],
  dm = false,
): GroupDefaultResponder {
  if (dm) return { kind: "mentions" };
  if (value && typeof value === "object") {
    const candidate = value as { kind?: unknown; botId?: unknown };
    if (candidate.kind === "everyone") return { kind: "everyone" };
    if (candidate.kind === "mentions") return { kind: "mentions" };
    if (
      candidate.kind === "member" &&
      typeof candidate.botId === "string" &&
      memberIds.includes(candidate.botId)
    ) {
      return { kind: "member", botId: candidate.botId };
    }
  }
  if (memberIds.length === 0) return { kind: "mentions" };
  return { kind: "member", botId: memberIds[0] };
}

/** Resolve the bots invoked by a human room message. Explicit targets win;
 * otherwise the room policy chooses one member, everyone, or nobody. */
export function roomResponders<T extends { id: string; name: string; hidden?: boolean }>(
  text: string,
  members: T[],
  defaultResponder: GroupDefaultResponder,
): T[] {
  const available = members.filter((member) => !member.hidden);
  if (/(?:^|\s)@everyone\b/i.test(text)) return available;
  const mentioned = mentionedBots(text, available);
  if (mentioned.length) return mentioned;
  if (defaultResponder.kind === "everyone") return available;
  if (defaultResponder.kind === "member") {
    const lead = available.find((member) => member.id === defaultResponder.botId);
    return lead ? [lead] : [];
  }
  return [];
}

const onboardingCard = (): OptionCardData => ({
  title: "What do you mostly want help with?",
  subtitle: "Pick whatever's closest; we can always expand from there.",
  options: ["Work & projects", "Writing & research", "Life admin", "A bit of everything"],
});

/** Messages form a tree (forks appear when a message is edited); the
 * visible conversation is the path from the root to activeLeafId. */
interface ThreadState {
  messages: Message[];
  activeLeafId: string | null;
}

/** How many threads' full message arrays `Store` keeps warm in memory at
 * once. `GET /api/bots` used to hydrate every bot and group's thread
 * through this cache with no eviction — one request against a large
 * database pulled every thread into the heap for the life of the process
 * (HS12/HS21). A thread's existence lives on its bot/group record, never
 * here, so evicting a thread's cached messages loses nothing durable:
 * the next read just re-hydrates from sqlite. */
const DEFAULT_THREAD_CACHE_LIMIT = 64;

/** A bounded LRU over per-thread message caches. `get` touches (moves the
 * entry to the most-recently-used end); `set` evicts the least-recently-
 * used entries past `limit`. Backed by a plain Map: insertion order is
 * Map's own iteration order, so "delete then re-set" is enough to move a
 * key to the MRU end, and `.keys().next()` is always the LRU key. */
class ThreadCache {
  private map = new Map<string, ThreadState>();
  private limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get(threadId: string): ThreadState | undefined {
    const state = this.map.get(threadId);
    if (state) {
      this.map.delete(threadId);
      this.map.set(threadId, state);
    }
    return state;
  }

  set(threadId: string, state: ThreadState): void {
    this.map.delete(threadId);
    this.map.set(threadId, state);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(threadId: string): void {
    this.map.delete(threadId);
  }

  /** Membership only — deliberately does not touch LRU order, so a test
   * can inspect the cache without perturbing the eviction it's testing. */
  has(threadId: string): boolean {
    return this.map.has(threadId);
  }
}

export class Store {
  bots: BotRecord[] = [];
  groups: GroupRecord[] = [];
  private threads: ThreadCache;
  private defaultSelection: () => ModelSelection;
  private listeners = new Set<(change: StoreChange) => void>();
  /** true when no bots.json existed at load — the one time the roster is seeded */
  private firstRun = false;
  /** true when bots.json existed but did not parse — do not treat an empty
   * in-memory roster as "every room member was deleted". */
  private botsLoadFailed = false;
  /** Coalesces bursts of saveBots() calls — a single startTurn used to fire
   * at least three full-roster fsynced rewrites — into one atomic write.
   * Fires a fixed delay after the first dirty call in a burst rather than
   * resetting per call, so sustained activity still flushes on a bounded
   * cadence instead of being starved. */
  private saveBotsTimer: ReturnType<typeof setTimeout> | null = null;
  private botsDirty = false;
  /** Thread ids sleeping on the until-activity sentinel.  `appendMessage`
   * is the hot path every turn runs through, so it asks this rather than
   * walking the roster for a snooze that is almost never there. */
  private readonly threadsAwaitingActivity = new Set<string>();

  /** `opts.threadCacheLimit` only exists so tests can force evictions
   * without creating dozens of real threads; production always takes the
   * default. */
  constructor(defaultSelection: () => ModelSelection, opts: { threadCacheLimit?: number } = {}) {
    this.defaultSelection = defaultSelection;
    this.threads = new ThreadCache(opts.threadCacheLimit ?? DEFAULT_THREAD_CACHE_LIMIT);
    mkdirSync(DATA_DIR, { recursive: true });
    try {
      this.bots = JSON.parse(readFileSync(BOTS_FILE, "utf8"));
    } catch (error) {
      this.bots = [];
      // Only a missing bots.json is a first run. A file that exists but will
      // not parse must not be silently replaced with a fresh default roster.
      this.firstRun = (error as NodeJS.ErrnoException)?.code === "ENOENT";
      this.botsLoadFailed = !this.firstRun;
    }
    try {
      this.groups = JSON.parse(readFileSync(GROUPS_FILE, "utf8"));
    } catch {
      this.groups = [];
    }
    // busy never survives a restart — no turn does either. Rooms saved
    // before default responders existed adopt their first member as lead.
    let botsMigrated = false;
    const chiefSectionsSeen = new Set<string>();
    let groupsMigrated = false;
    for (const b of this.bots) {
      // transient state never survives a restart — and if a previous
      // process died mid-turn, bots.json still says busy/working; persist
      // the reset so the next load does not read it again
      if (b.busy || (b.activity !== undefined && b.activity !== "idle")) botsMigrated = true;
      b.busy = false;
      b.activity = "idle";
      if (b.cloudBackend !== undefined && b.cloudBackend !== "box" && b.cloudBackend !== "vps") {
        delete b.cloudBackend;
        botsMigrated = true;
      }
      if (b.autoStartVps !== undefined && b.autoStartVps !== true && b.autoStartVps !== false) {
        delete b.autoStartVps;
        botsMigrated = true;
      }
      const avatar = botAvatarProfile(b);
      if (b.avatarUrl !== undefined && avatar.avatarUrl !== b.avatarUrl) {
        delete b.avatarUrl;
        botsMigrated = true;
      }
      if (b.avatarCrop !== undefined && avatar.avatarCrop !== b.avatarCrop) {
        delete b.avatarCrop;
        botsMigrated = true;
      }
      // A snooze IS durable — unlike busy, it is a decision the person made,
      // and a relaunch must not wake every thread they put to sleep.  Only
      // the until-activity index is rebuilt here; expired deadlines heal on
      // read and are swept by `wakeExpiredThreadSnoozes`.
      for (const task of b.tasks ?? []) {
        if (task.snoozedUntil === SNOOZE_UNTIL_ACTIVITY) this.threadsAwaitingActivity.add(task.threadId);
      }
    }
    for (const b of this.bots) {
      if (!b.chiefOfStaff) continue;
      const key = sectionKey(b.section);
      if (!chiefSectionsSeen.has(key)) {
        chiefSectionsSeen.add(key);
        if (b.hidden) {
          b.hidden = false;
          botsMigrated = true;
        }
        continue;
      }
      b.chiefOfStaff = false;
      botsMigrated = true;
    }
    // Peer grants originally used mutable display names (ask_bot:@Helper).
    // Convert only when exactly one bot has that name; ambiguous legacy
    // entries remain inert rather than granting access to the wrong bot.
    for (const b of this.bots) {
      if (!b.alwaysAllow?.length) continue;
      let changed = false;
      const migrated = b.alwaysAllow.map((key) => {
        const match = key.match(/^(ask_bot|delegate_bot):@(.+)$/);
        if (!match) return key;
        const candidates = this.bots.filter((candidate) => candidate.name === match[2]);
        if (candidates.length !== 1) return key;
        changed = true;
        return peerAllowKey(match[1] as PeerAction, candidates[0]!.id);
      });
      if (changed) {
        b.alwaysAllow = [...new Set(migrated)];
        botsMigrated = true;
      }
    }
    for (const g of this.groups) {
      g.busyBotId = null;
      if (!g.dm && !this.botsLoadFailed) {
        const liveMembers = g.memberIds.filter((id) => this.bot(id));
        if (liveMembers.length !== g.memberIds.length) {
          g.memberIds = liveMembers;
          groupsMigrated = true;
        }
      }
      const normalized = normalizeGroupDefaultResponder(g.defaultResponder, g.memberIds, Boolean(g.dm));
      if (JSON.stringify(normalized) !== JSON.stringify(g.defaultResponder)) groupsMigrated = true;
      g.defaultResponder = normalized;
      // Bot-to-bot channels intentionally remain one canonical thread.
      if (g.dm) {
        if (g.tasks !== undefined) {
          delete g.tasks;
          groupsMigrated = true;
        }
        continue;
      }
      if (!g.tasks?.length) {
        g.tasks = [
          {
            threadId: g.threadId,
            title: this.firstUserLine(g.threadId) ?? UNTITLED_TASK,
            createdAt: g.createdAt,
            ...(g.pinnedCwd !== undefined ? { pinnedCwd: g.pinnedCwd } : {}),
            ...(g.pinnedMessageId ? { pinnedMessageId: g.pinnedMessageId } : {}),
          },
        ];
        groupsMigrated = true;
      }
      // Repair a malformed/stale active pointer conservatively. Every task
      // transcript is retained; the newest known task becomes active.
      let active = g.tasks.find((task) => task.threadId === g.threadId);
      if (!active) {
        active = g.tasks[0]!;
        g.threadId = active.threadId;
        groupsMigrated = true;
      }
      g.pinnedCwd = active.pinnedCwd;
      g.pinnedMessageId = active.pinnedMessageId;
    }
    if (botsMigrated) this.saveBots();
    if (groupsMigrated) this.saveGroups();
    // bots saved before tasks existed have one endless thread; adopt it as
    // their first task so nothing is lost and nothing special-cases it
    for (const b of this.bots) {
      if (b.tasks?.length) continue;
      b.tasks = [
        {
          threadId: b.threadId,
          title: this.firstUserLine(b.threadId) ?? UNTITLED_TASK,
          createdAt: b.createdAt,
          resumeCursors: b.resumeCursors ?? {},
        },
      ];
    }
    // Search reads SQLite directly, so migrate every known legacy transcript
    // at startup rather than waiting until the user happens to open it. Only
    // pending JSON files are touched; already-migrated threads stay lazy.
    const knownThreads = new Set([
      ...this.bots.flatMap((b) => [b.threadId, ...(b.tasks ?? []).map((task) => task.threadId)]),
      ...this.groups.flatMap((group) => [group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]),
    ]);
    for (const threadId of knownThreads) {
      const legacyFile = messagesFile(threadId);
      if (existsSync(legacyFile)) mdb.readThread(threadId, legacyFile);
    }
  }

  private saveBots() {
    this.botsDirty = true;
    if (this.saveBotsTimer) return;
    this.saveBotsTimer = setTimeout(() => this.flushBotsFromTimer(), BOTS_SAVE_DEBOUNCE_MS);
    this.saveBotsTimer.unref?.();
  }

  /** The debounce timer's flush.  A throw here would be an uncaught exception
   * in a timer callback, so a failed write is logged instead; `botsDirty`
   * stays set, and the next saveBots() or the shutdown flush retries it. */
  private flushBotsFromTimer(): void {
    this.saveBotsTimer = null;
    try {
      this.flushBotsNow();
    } catch (error) {
      console.error("store: debounced bots.json save failed; the next save or shutdown retries it", error);
    }
  }

  /** Synchronous, immediate write-through — used by patchBot() for the
   * inflightThreadId crash marker (unlike busy/activity, it survives a
   * restart and must be durable before a turn dispatches), by tests
   * asserting on-disk state right after a mutation (including a fresh
   * `new Store` against the same files, which reads whatever is on disk
   * right now), and by the shutdown path so a pending coalesced save is
   * never lost when the process exits. A no-op when nothing is dirty.
   * `botsDirty` is cleared only after the write succeeds, so a failed write
   * throws with the pending change still marked for the next try. */
  flushBotsNow(): void {
    if (this.saveBotsTimer) {
      clearTimeout(this.saveBotsTimer);
      this.saveBotsTimer = null;
    }
    if (!this.botsDirty) return;
    // busy/activity never survive a restart (reset on load above) and
    // change on every turn transition, so they are excluded here rather
    // than debounced — nothing to coalesce for state nobody reads back.
    writeFileAtomic(BOTS_FILE, JSON.stringify(this.bots.map(({ busy, activity, ...bot }) => bot), null, 2));
    this.botsDirty = false;
  }

  private saveGroups() {
    writeFileAtomic(GROUPS_FILE, JSON.stringify(this.groups.map(({ busyBotId, ...g }) => g), null, 2));
  }

  // ── groups ────────────────────────────────────────────────────────────
  /** Subscribe to every write. Listeners run after the write and after
   * save; a throwing listener never breaks the write. */
  onChange(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: StoreChange) {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        console.error("store: change listener threw", error);
      }
    }
  }

  group(id: string): GroupRecord | undefined {
    return this.groups.find((g) => g.id === id);
  }

  groupByThread(threadId: string): GroupRecord | undefined {
    return this.groups.find(
      (group) => group.threadId === threadId || group.tasks?.some((task) => task.threadId === threadId),
    );
  }

  createGroup(
    name: string,
    memberIds: string[],
    dm = false,
    section?: string,
    setup?: {
      bulletin?: string;
      defaultResponder?: GroupDefaultResponder;
      completed?: boolean;
    },
  ): GroupRecord {
    const threadId = newId();
    const createdAt = Date.now();
    const group: GroupRecord = {
      id: newId(),
      threadId,
      ...(dm
        ? {}
        : { tasks: [{ threadId, title: UNTITLED_TASK, createdAt }] }),
      name,
      memberIds,
      defaultResponder: dm
        ? { kind: "mentions" }
        : normalizeGroupDefaultResponder(setup?.defaultResponder, memberIds, false),
      bulletin: setup?.bulletin ?? "",
      unread: false,
      createdAt,
      dm: dm || undefined,
      busyBotId: null,
      section,
      ...(dm
        ? {}
        : {
            setupCompletedAt: setup?.completed ? createdAt : null,
            setupSkippedAt: null,
          }),
    };
    this.groups.unshift(group);
    this.saveGroups();
    this.emit({ type: "group", groupId: group.id });
    return group;
  }

  /** The bot⇄bot channel for a pair, if it exists (order-insensitive). */
  dmGroup(a: string, b: string): GroupRecord | undefined {
    return this.groups.find(
      (g) => g.dm && g.memberIds.length === 2 && g.memberIds.includes(a) && g.memberIds.includes(b),
    );
  }

  patchGroup(id: string, patch: Partial<Pick<GroupRecord, "name" | "avatarUrl" | "avatarCrop" | "memberIds" | "defaultResponder" | "bulletin" | "unread" | "busyBotId" | "cwd" | "extraCwds" | "pinnedMessageId" | "section" | "setupCompletedAt" | "setupSkippedAt">>): GroupRecord | null {
    const group = this.group(id);
    if (!group) return null;
    Object.assign(group, patch);
    if (!group.dm && Object.prototype.hasOwnProperty.call(patch, "pinnedMessageId")) {
      const active = this.activeGroupTask(group.id);
      if (active) active.pinnedMessageId = patch.pinnedMessageId;
    }
    group.defaultResponder = normalizeGroupDefaultResponder(
      group.defaultResponder,
      group.memberIds,
      Boolean(group.dm),
    );
    this.saveGroups();
    this.emit({ type: "group", groupId: group.id });
    return group;
  }

  /** A thread's durable record: DB rows plus any legacy JSON leftovers. */
  private deleteThreadRecord(threadId: string) {
    this.threads.delete(threadId);
    mdb.deleteThread(threadId);
    for (const file of [messagesFile(threadId), `${messagesFile(threadId)}.imported`]) {
      try {
        unlinkSync(file);
      } catch {}
    }
    this.emit({ type: "thread.deleted", threadId });
  }

  deleteGroup(id: string): boolean {
    const group = this.group(id);
    if (!group) return false;
    this.groups = this.groups.filter((g) => g.id !== id);
    this.saveGroups();
    for (const threadId of new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)])) {
      this.deleteThreadRecord(threadId);
    }
    this.emit({ type: "group.deleted", groupId: id });
    return true;
  }

  // ── channel tasks ────────────────────────────────────────────────────
  groupTasks(groupId: string): GroupTaskRecord[] {
    const group = this.group(groupId);
    return group?.dm ? [] : (group?.tasks ?? []);
  }

  activeGroupTask(groupId: string): GroupTaskRecord | undefined {
    const group = this.group(groupId);
    return group?.tasks?.find((task) => task.threadId === group.threadId);
  }

  groupTaskByThread(groupId: string, threadId: string): GroupTaskRecord | undefined {
    const group = this.group(groupId);
    if (!group || group.dm) return undefined;
    return group.tasks?.find((task) => task.threadId === threadId);
  }

  createGroupTask(groupId: string, title?: string): GroupTaskRecord | null {
    const group = this.group(groupId);
    if (!group || group.dm) return null;
    const task: GroupTaskRecord = {
      threadId: newId(),
      title: title?.trim() || UNTITLED_TASK,
      createdAt: Date.now(),
    };
    group.tasks = [task, ...(group.tasks ?? [])];
    group.threadId = task.threadId;
    group.pinnedCwd = undefined;
    group.pinnedMessageId = undefined;
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return task;
  }

  switchGroupTask(groupId: string, threadId: string): GroupRecord | null {
    const group = this.group(groupId);
    const task = group?.tasks?.find((candidate) => candidate.threadId === threadId);
    if (!group || group.dm || !task) return null;
    group.threadId = task.threadId;
    group.pinnedCwd = task.pinnedCwd;
    group.pinnedMessageId = task.pinnedMessageId;
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return group;
  }

  renameGroupTask(groupId: string, threadId: string, title: string): GroupTaskRecord | null {
    const task = this.groupTaskByThread(groupId, threadId);
    if (!task) return null;
    task.title = title.trim().slice(0, 80) || UNTITLED_TASK;
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return task;
  }

  titleGroupTaskFromFirstMessage(groupId: string, text: string, threadId?: string) {
    const task = threadId ? this.groupTaskByThread(groupId, threadId) : this.activeGroupTask(groupId);
    if (!task || task.title !== UNTITLED_TASK) return;
    task.title = titleFromMessage(text);
    this.saveGroups();
    this.emit({ type: "group", groupId });
  }

  /** Move one conversation to another channel.
   *
   * The thread keeps its id, so every message, branch and active leaf comes
   * with it untouched — only which channel lists it changes.  A channel is
   * never left without a conversation: moving the one it is currently
   * showing hands it the next most recent, and a channel down to its last
   * task keeps it, because an empty channel has nothing to open. */
  moveGroupTask(fromGroupId: string, threadId: string, toGroupId: string): GroupRecord[] | null {
    if (fromGroupId === toGroupId) return null;
    const from = this.group(fromGroupId);
    const to = this.group(toGroupId);
    if (!from || !to || from.dm || to.dm) return null;
    if (!from.tasks || from.tasks.length < 2) return null;
    const task = from.tasks.find((entry) => entry.threadId === threadId);
    if (!task) return null;

    from.tasks = from.tasks.filter((entry) => entry.threadId !== threadId);
    if (from.threadId === threadId) {
      const next = from.tasks[0]!;
      from.threadId = next.threadId;
      from.pinnedCwd = next.pinnedCwd;
      from.pinnedMessageId = next.pinnedMessageId;
    }
    to.tasks = [task, ...(to.tasks ?? [])];

    this.saveGroups();
    this.emit({ type: "group", groupId: from.id });
    this.emit({ type: "group", groupId: to.id });
    return [from, to];
  }

  /** Move a channel's conversation to a bot, where it becomes one of that
   * bot's own threads.
   *
   * The thread id survives, so the transcript comes across whole — what
   * changes is who answers next.  The conversation arrives without resume
   * cursors because those belong to the channel's turns, not this bot's:
   * the next turn starts a fresh provider session over the same history. */
  /** Move one of a bot's conversations to another bot.
   *
   * The thread id survives, so the transcript comes with it; the resume
   * cursors do not, because they name a provider session belonging to the
   * bot it came from.  A bot keeps its last conversation, for the same
   * reason a channel does: there would be nothing left to open. */
  moveTaskToBot(fromBotId: string, threadId: string, toBotId: string): BotRecord[] | null {
    if (fromBotId === toBotId) return null;
    const from = this.bot(fromBotId);
    const to = this.bot(toBotId);
    if (!from || !to || !from.tasks || from.tasks.length < 2) return null;
    const task = from.tasks.find((entry) => entry.threadId === threadId);
    if (!task) return null;

    from.tasks = from.tasks.filter((entry) => entry.threadId !== threadId);
    if (from.threadId === threadId) {
      const next = from.tasks[0]!;
      from.threadId = next.threadId;
      from.resumeCursors = {};
    }
    to.tasks = [{ ...task, resumeCursors: {}, lastInstanceId: undefined }, ...(to.tasks ?? [])];

    this.saveBots();
    this.emit({ type: "bot", botId: from.id });
    this.emit({ type: "bot", botId: to.id });
    return [from, to];
  }

  /** Fold one of a bot's conversations into another.  The destination
   * thread keeps its id and resume cursors; the source task is deleted.
   * A divider plus the source messages are appended so the transcript
   * stays one conversation the model can keep reading. */
  mergeBotTasks(botId: string, fromThreadId: string, intoThreadId: string): BotRecord | null {
    if (fromThreadId === intoThreadId) return null;
    const bot = this.bot(botId);
    if (!bot || !bot.tasks || bot.tasks.length < 2) return null;
    const from = bot.tasks.find((entry) => entry.threadId === fromThreadId);
    const into = bot.tasks.find((entry) => entry.threadId === intoThreadId);
    if (!from || !into) return null;

    const incoming = this.messagesFor(fromThreadId);
    if (incoming.length > 0) {
      const label = from.title?.trim() || "Merged thread";
      this.appendMessage(intoThreadId, {
        role: "user",
        kind: "text",
        text: `Merged “${label}” into this thread.`,
      });
      for (const message of incoming) {
        const { id: _id, parentId: _parent, ...rest } = message;
        this.appendMessage(intoThreadId, rest);
      }
    }

    // The source task's automation key (and any it already collected from
    // an earlier merge) must survive its deletion below, or the next
    // webhook/routine firing misses `taskByAutomationKey`, then misses the
    // run-history fallback too (the source thread is gone), and mints a
    // fresh duplicate task — exactly what keyed tasks exist to prevent.
    const mergedKeys = [from.automationKey, ...(from.automationKeyAliases ?? [])].filter(
      (key): key is string => Boolean(key),
    );
    if (mergedKeys.length > 0) {
      const aliases = new Set(into.automationKeyAliases ?? []);
      for (const key of mergedKeys) {
        if (key === into.automationKey) continue;
        aliases.add(key);
      }
      into.automationKeyAliases = aliases.size > 0 ? [...aliases] : undefined;
    }

    return this.deleteTask(botId, fromThreadId);
  }

  /** Fold one of a room's conversations into another.  Direct-message
   * channels stay single-threaded and cannot merge. */
  mergeGroupTasks(groupId: string, fromThreadId: string, intoThreadId: string): GroupRecord | null {
    if (fromThreadId === intoThreadId) return null;
    const group = this.group(groupId);
    if (!group || group.dm || !group.tasks || group.tasks.length < 2) return null;
    const from = group.tasks.find((entry) => entry.threadId === fromThreadId);
    const into = group.tasks.find((entry) => entry.threadId === intoThreadId);
    if (!from || !into) return null;

    const incoming = this.messagesFor(fromThreadId);
    if (incoming.length > 0) {
      const label = from.title?.trim() || "Merged thread";
      this.appendMessage(intoThreadId, {
        role: "user",
        kind: "text",
        text: `Merged “${label}” into this thread.`,
      });
      for (const message of incoming) {
        const { id: _id, parentId: _parent, ...rest } = message;
        this.appendMessage(intoThreadId, rest);
      }
    }

    return this.deleteGroupTask(groupId, fromThreadId);
  }

  /** Fold every extra bot and room conversation into the active thread.
   * Used when switching the workspace to Simple with merge opted in. */
  mergeAllExtraThreads(): { bots: number; groups: number; threads: number } {
    let bots = 0;
    let groups = 0;
    let threads = 0;
    for (const bot of this.bots) {
      const into = bot.threadId;
      const extras = [...(bot.tasks ?? [])]
        .filter((task) => task.threadId !== into)
        .sort((a, b) => a.createdAt - b.createdAt);
      if (extras.length === 0) continue;
      bots += 1;
      for (const extra of extras) {
        if (this.mergeBotTasks(bot.id, extra.threadId, into)) threads += 1;
      }
    }
    for (const group of this.groups) {
      if (group.dm) continue;
      const into = group.threadId;
      const extras = [...(group.tasks ?? [])]
        .filter((task) => task.threadId !== into)
        .sort((a, b) => a.createdAt - b.createdAt);
      if (extras.length === 0) continue;
      groups += 1;
      for (const extra of extras) {
        if (this.mergeGroupTasks(group.id, extra.threadId, into)) threads += 1;
      }
    }
    return { bots, groups, threads };
  }

  /** Move one of a bot's conversations into a channel, where the channel's
   * members answer it from then on. */
  moveTaskToGroup(fromBotId: string, threadId: string, groupId: string): {
    bot: BotRecord;
    group: GroupRecord;
  } | null {
    const bot = this.bot(fromBotId);
    const group = this.group(groupId);
    if (!bot || !group || group.dm || !bot.tasks || bot.tasks.length < 2) return null;
    const task = bot.tasks.find((entry) => entry.threadId === threadId);
    if (!task) return null;

    bot.tasks = bot.tasks.filter((entry) => entry.threadId !== threadId);
    if (bot.threadId === threadId) {
      const next = bot.tasks[0]!;
      bot.threadId = next.threadId;
      bot.resumeCursors = {};
    }
    group.tasks = [
      {
        threadId: task.threadId,
        title: task.title,
        createdAt: task.createdAt,
        ...(task.cwd === undefined ? {} : { pinnedCwd: task.cwd }),
      },
      ...(group.tasks ?? []),
    ];

    this.saveBots();
    this.saveGroups();
    this.emit({ type: "bot", botId: bot.id });
    this.emit({ type: "group", groupId: group.id });
    return { bot, group };
  }

  moveGroupTaskToBot(groupId: string, threadId: string, botId: string): {
    group: GroupRecord;
    bot: BotRecord;
  } | null {
    const group = this.group(groupId);
    const bot = this.bot(botId);
    if (!group || !bot || group.dm) return null;
    if (!group.tasks || group.tasks.length < 2) return null;
    const task = group.tasks.find((entry) => entry.threadId === threadId);
    if (!task) return null;

    group.tasks = group.tasks.filter((entry) => entry.threadId !== threadId);
    if (group.threadId === threadId) {
      const next = group.tasks[0]!;
      group.threadId = next.threadId;
      group.pinnedCwd = next.pinnedCwd;
      group.pinnedMessageId = next.pinnedMessageId;
    }
    bot.tasks = [
      {
        threadId: task.threadId,
        title: task.title,
        createdAt: task.createdAt,
        resumeCursors: {},
        ...(task.pinnedCwd === undefined ? {} : { cwd: task.pinnedCwd }),
      },
      ...(bot.tasks ?? []),
    ];

    this.saveGroups();
    this.saveBots();
    this.emit({ type: "group", groupId: group.id });
    this.emit({ type: "bot", botId: bot.id });
    return { group, bot };
  }

  deleteGroupTask(groupId: string, threadId: string): GroupRecord | null {
    const group = this.group(groupId);
    if (!group || group.dm || !group.tasks || group.tasks.length < 2) return null;
    if (!group.tasks.some((task) => task.threadId === threadId)) return null;
    group.tasks = group.tasks.filter((task) => task.threadId !== threadId);
    this.deleteThreadRecord(threadId);
    if (group.threadId === threadId) {
      const next = group.tasks[0]!;
      group.threadId = next.threadId;
      group.pinnedCwd = next.pinnedCwd;
      group.pinnedMessageId = next.pinnedMessageId;
    }
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return group;
  }

  /** Toggle an emoji reaction on a message ("user" or a member botId). */
  toggleReaction(threadId: string, messageId: string, emoji: string, by: string): Message | null {
    const existing = this.messagesFor(threadId).find((m) => m.id === messageId);
    if (!existing) return null;
    const reactions = existing.reactions ?? [];
    const at = reactions.findIndex((r) => r.emoji === emoji && r.by === by);
    const next = at >= 0 ? reactions.filter((_, i) => i !== at) : [...reactions, { emoji, by }];
    return this.patchMessage(threadId, messageId, { reactions: next.length ? next : undefined });
  }

  private thread(threadId: string): ThreadState {
    const t = this.threads.get(threadId);
    if (t) return t;
    // SQLite is the source of truth; a thread with no rows imports its
    // legacy messages-<threadId>.json once, inside readThread
    return this.cacheThread(threadId, mdb.readThread(threadId, messagesFile(threadId)));
  }

  /** Finish hydrating a full set of thread rows into the cache: chain any
   * legacy (pre-branching) rows' parentId in array order, default the
   * active leaf to the newest message, and store it (evicting the LRU
   * entry if the cache is now over its bound). Shared by a full load and
   * by messagesTail() when its bounded read turns out to be the whole
   * thread anyway. */
  private cacheThread(threadId: string, rows: mdb.ThreadRows): ThreadState {
    const { messages, activeLeafId: storedLeaf } = rows;
    let activeLeafId = storedLeaf;
    // legacy rows carry no parentId — chain them in array order
    let prev: string | null = null;
    for (const m of messages) {
      if (m.parentId === undefined) m.parentId = prev;
      prev = m.id;
    }
    if (!activeLeafId) activeLeafId = messages.at(-1)?.id ?? null;
    const t = { messages, activeLeafId };
    this.threads.set(threadId, t);
    return t;
  }

  messagesFor(threadId: string): Message[] {
    return this.thread(threadId).messages;
  }

  /** A bounded page of a thread's newest messages, for callers that only
   * need a display page — the GET /api/bots hydrate and a fresh
   * scrollback view. Reads just `limit` rows at the SQL boundary instead
   * of the whole transcript (HS12/HS21), unless the thread is already
   * cached from other work (then it's a plain in-memory slice, no extra
   * SQL) or the bounded read comes back as the complete thread anyway
   * (short thread, or a one-time legacy import) — that gets cached like
   * any other full load so a later messagesFor() doesn't re-read it.
   * Legacy rows that predate per-message parentId are only chained
   * correctly on a full load, so a bounded page missing that context
   * falls back to one rather than returning messages with a broken
   * parent chain. */
  messagesTail(threadId: string, limit: number): { messages: Message[]; hasMore: boolean; activeLeafId: string | null } {
    let state = this.threads.get(threadId);
    if (!state) {
      const tail = mdb.readThreadTail(threadId, messagesFile(threadId), limit);
      const legacyRows = tail.hasMore !== undefined && tail.messages.some((m) => m.parentId === undefined);
      if (tail.hasMore !== true || legacyRows) {
        state = this.cacheThread(threadId, legacyRows ? mdb.readThread(threadId, messagesFile(threadId)) : tail);
      } else {
        return {
          messages: tail.messages,
          hasMore: tail.hasMore,
          activeLeafId: tail.activeLeafId ?? tail.messages.at(-1)?.id ?? null,
        };
      }
    }
    const { messages, activeLeafId } = state;
    const start = Math.max(0, messages.length - limit);
    return { messages: messages.slice(start), hasMore: start > 0, activeLeafId };
  }

  /** Test-only: whether a thread's messages are currently warm in the LRU,
   * so a test can prove a bounded read stayed bounded (or that eviction
   * actually happened) without depending on internal call counts. Reads
   * membership only — does not touch LRU order. */
  threadIsCachedForTests(threadId: string): boolean {
    return this.threads.has(threadId);
  }

  activeLeaf(threadId: string): string | null {
    return this.thread(threadId).activeLeafId;
  }

  /** The visible conversation: root → activeLeafId. */
  activePath(threadId: string): Message[] {
    const t = this.thread(threadId);
    const byId = new Map(t.messages.map((m) => [m.id, m]));
    const path: Message[] = [];
    let cur = t.activeLeafId ? byId.get(t.activeLeafId) : undefined;
    while (cur) {
      path.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return path.reverse();
  }

  appendMessage(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }): Message {
    const t = this.thread(threadId);
    const full: Message = { id: newId(), at: Date.now(), parentId: t.activeLeafId, ...redactBotAuthored(message) };
    mdb.appendMessage(threadId, full);
    t.messages.push(full);
    t.activeLeafId = full.id;
    if (full.kind === "screen") {
      for (const pruned of this.pruneScreenFrames(t)) {
        mdb.updateMessage(threadId, pruned);
        this.emit({ type: "message.patch", threadId, message: pruned });
      }
    }
    this.emit({ type: "message", threadId, message: full });
    // A message landing here IS the "new activity" an until-activity snooze
    // waits for — whoever caused it, a person, a routine or the bot itself.
    // Every path that adds to a transcript funnels through here, so this one
    // hook is the whole alarm.  A timed snooze is left to its clock.
    if (this.threadsAwaitingActivity.has(threadId)) this.wakeThreadOnActivity(threadId);
    // The first-run quiz is not a live ask. Talking past it hides it so the
    // transcript is just the greeting plus what they said. Cards with a
    // requestId are permission/question prompts and stay until answered.
    // role "system" covers auto-delivered routine/webhook/resource
    // instructions (stored that way so iOS/desktop never paint a blue user
    // bubble for them) — a thread that opens with one of those should not
    // leave the onboarding card stuck forever either.
    if ((full.role === "user" || full.role === "system") && full.kind === "text") this.dismissOnboardingCard(threadId);
    return full;
  }

  /** Hide the first-run quiz on this thread, if it is still open. */
  dismissOnboardingCard(threadId: string): Message | null {
    const t = this.thread(threadId);
    const card = t.messages.find(
      (message) => message.kind === "options" && message.card && !message.card.requestId && !message.card.dismissed,
    );
    if (!card?.card) return null;
    return this.patchMessage(threadId, card.id, { card: { ...card.card, dismissed: true } });
  }

  /** Screen frames are ~100-500KB of base64 each; keeping every frame of a
   * long computer session bloats the transcript for nothing the client
   * would ever show. The newest few keep their pixels; older ones stay in
   * the transcript as placeholders. Mirrors the client's own frame cap.
   * Returns the messages whose pixels were dropped so the caller can
   * persist exactly those. */
  private pruneScreenFrames(t: { messages: Message[] }, keep = 4): Message[] {
    const pruned: Message[] = [];
    let seen = 0;
    for (let i = t.messages.length - 1; i >= 0 && seen < t.messages.length; i--) {
      const m = t.messages[i];
      if (m.kind !== "screen" || !m.png) continue;
      seen += 1;
      if (seen > keep) {
        m.png = undefined;
        pruned.push(m);
      }
    }
    return pruned;
  }

  /** Fork the conversation: a new message that replaces `sourceId`
   * (same parent, new text) and becomes the active leaf.  Preserves the
   * source's role and automationSource — regenerating or editing an
   * auto-delivered instruction (role="system") must produce another
   * system-attributed prompt, not a fabricated human user bubble. */
  branchMessage(threadId: string, sourceId: string, text: string): Message | null {
    const t = this.thread(threadId);
    const source = t.messages.find((m) => m.id === sourceId);
    if (!source) return null;
    const full: Message = {
      id: newId(),
      at: Date.now(),
      role: source.role === "system" ? "system" : "user",
      kind: "text",
      text,
      parentId: source.parentId ?? null,
      replyToId: source.replyToId,
      automationSource: source.automationSource,
    };
    mdb.appendMessage(threadId, full);
    t.messages.push(full);
    t.activeLeafId = full.id;
    this.emit({ type: "message", threadId, message: full });
    return full;
  }

  /** Point the visible conversation at the branch containing `messageId`,
   * descending to that branch's most recently active leaf. */
  setActiveLeaf(threadId: string, messageId: string): string | null {
    const t = this.thread(threadId);
    if (!t.messages.some((m) => m.id === messageId)) return null;
    let cur = messageId;
    for (;;) {
      const children = t.messages.filter((m) => m.parentId === cur);
      if (!children.length) break;
      cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
    }
    t.activeLeafId = cur;
    mdb.setActiveLeaf(threadId, cur);
    this.emit({ type: "thread", threadId, activeLeafId: cur });
    return cur;
  }

  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null {
    const t = this.thread(threadId);
    const idx = t.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return null;
    t.messages[idx] = { ...t.messages[idx], ...patch, card: patch.card ?? t.messages[idx].card };
    mdb.updateMessage(threadId, t.messages[idx]);
    this.emit({ type: "message.patch", threadId, message: t.messages[idx] });
    return t.messages[idx];
  }

  bot(id: string) {
    return this.bots.find((b) => b.id === id) ?? null;
  }

  botByThread(threadId: string) {
    return this.bots.find((b) => b.threadId === threadId || b.tasks?.some((t) => t.threadId === threadId)) ?? null;
  }

  createBot(
    profile: Partial<
      Pick<BotRecord, "name" | "title" | "description" | "color" | "mascotExpression" | "modelSelection" | "section">
    > = {},
    opts: {
      /** false = no greeting/onboarding seed. Imported bots must not open
       * with a first-person greeting the user never asked for. */
      seedMessages?: boolean;
    } = {},
  ): BotRecord {
    const name = profile.name?.trim() || pickBotName(this.bots.map((b) => b.name));
    const section = sectionKey(profile.section);
    const bot: BotRecord = {
      id: newId(),
      threadId: newId(),
      name,
      title: profile.title ?? "",
      description: profile.description ?? "",
      notifications: true,
      color: profile.color ?? COLORS[this.bots.length % COLORS.length],
      ...(profile.mascotExpression ? { mascotExpression: profile.mascotExpression } : {}),
      unread: false,
      modelSelection: profile.modelSelection ?? this.defaultSelection(),
      resumeCursors: {},
      createdAt: Date.now(),
    };
    if (section) bot.section = section;
    bot.tasks = [{ threadId: bot.threadId, title: UNTITLED_TASK, createdAt: bot.createdAt, resumeCursors: {} }];
    this.bots.unshift(bot);
    this.saveBots();
    // Announce the owner before its onboarding transcript. SSE clients need
    // the bot/thread mapping before they can place either message.
    this.emit({ type: "bot", botId: bot.id });
    if (opts.seedMessages !== false) {
      this.appendMessage(bot.threadId, {
        role: "bot",
        kind: "text",
        text: `Hey — I'm ${name}. Nice to meet you.`,
      });
      this.appendMessage(bot.threadId, { role: "bot", kind: "options", card: onboardingCard() });
    }
    return bot;
  }

  deleteBot(id: string): boolean {
    const bot = this.bot(id);
    if (!bot) return false;
    this.bots = this.bots.filter((b) => b.id !== id);
    // Rooms keep their own roster.  Strip the deleted id so memberIds and
    // defaultResponder never point at a ghost.  A remaining member becomes
    // the lead; an empty roster falls back to mentions.
    for (const group of [...this.groups]) {
      if (!group.memberIds.includes(id)) continue;
      const memberIds = group.memberIds.filter((memberId) => memberId !== id);
      this.patchGroup(group.id, {
        memberIds,
        defaultResponder: normalizeGroupDefaultResponder(
          group.defaultResponder,
          memberIds,
          Boolean(group.dm),
        ),
      });
    }
    // every task's transcript goes with the bot, not just the open one
    for (const threadId of new Set([bot.threadId, ...(bot.tasks ?? []).map((t) => t.threadId)])) {
      this.deleteThreadRecord(threadId);
    }
    // the bot's workspace (files + memory) goes with it — same rule as its
    // transcripts: deleting a bot deletes what it knew
    try {
      rmSync(workspaceDir(id), { recursive: true, force: true });
    } catch {}
    this.saveBots();
    this.emit({ type: "bot.deleted", botId: id });
    return true;
  }

  patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null {
    const bot = this.bot(id);
    if (!bot) return null;
    // Only a real engine/model switch invalidates inheriting tasks' last-turn
    // selection.  Effort- or fallback-only edits (e.g. startTurn stripping an
    // unsupported effort) keep the same primary model and must not clear it.
    const modelSwitched =
      patch.modelSelection !== undefined &&
      (patch.modelSelection?.instanceId !== bot.modelSelection?.instanceId ||
        patch.modelSelection?.model !== bot.modelSelection?.model);
    if (modelSwitched) {
      if (bot.tasks) {
        for (const task of bot.tasks) {
          if (!task.modelSelection) {
            delete task.activeModelSelection;
          }
        }
      }
    }
    Object.assign(bot, patch);
    this.saveBots();
    if ("inflightThreadId" in patch) {
      // Durable crash marker (see the field's own doc comment): unlike
      // busy/activity it survives a restart, and boot recovery depends on it
      // being on disk before a turn actually dispatches — a debounced write
      // could lose it to a crash in the gap. Flush immediately rather than
      // let it coalesce with the general roster debounce.
      this.flushBotsNow();
    }
    this.emit({ type: "bot", botId: id });
    return bot;
  }

  /** The one way runtime state changes. Sets `activity` and derives `busy`
   * from it, so a reader that only knows busy sees the same truth. Neither
   * field is persisted (both reset to idle on load — see the constructor),
   * so an activity blink never touches disk. */
  setActivity(botId: string, activity: BotActivity): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot) return null;
    const busy = ACTIVITY_BUSY.has(activity);
    if (bot.activity === activity && Boolean(bot.busy) === busy) return bot;
    bot.activity = activity;
    bot.busy = busy;
    bot.activityStartedAt = Date.now();
    this.emit({ type: "bot", botId });
    return bot;
  }

  /** Elect one Chief of Staff in its section (or clear one section) as one persisted change.
   * The changed records are returned so the server can update every open
   * window, including the bot that just handed the role over. */
  setChiefOfStaff(id: string | null, section?: string | null): BotRecord[] | null {
    const selected = id ? this.bot(id) : null;
    if (id && !selected) return null;
    const targetSection = sectionKey(selected?.section ?? section);
    const changed: BotRecord[] = [];
    for (const bot of this.bots) {
      if (sectionKey(bot.section) !== targetSection) continue;
      const next = bot.id === id;
      if (Boolean(bot.chiefOfStaff) === next && !(next && bot.hidden)) continue;
      if (next) {
        bot.chiefOfStaff = true;
        // A section's main contact must stay reachable in the sidebar.
        bot.hidden = false;
      } else {
        bot.chiefOfStaff = false;
      }
      changed.push(bot);
    }
    if (changed.length) this.saveBots();
    for (const bot of changed) this.emit({ type: "bot", botId: bot.id });
    return changed;
  }

  setResumeCursor(botId: string, instanceId: string, cursor: unknown, threadId?: string) {
    const bot = this.bot(botId);
    if (!bot) return;
    // the cursor belongs to the task that produced it, not to the bot
    const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId);
    if (cursor === undefined || cursor === null) {
      if (task) delete task.resumeCursors[instanceId];
      if (!threadId || bot.threadId === threadId) delete bot.resumeCursors[instanceId];
    } else {
      if (task) task.resumeCursors[instanceId] = cursor;
      // The legacy mirror follows the task visible in chat, never a detached
      // routine task working in the background.
      if (!threadId || bot.threadId === threadId) bot.resumeCursors[instanceId] = cursor;
    }
    this.saveBots();
    this.emit({ type: "bot", botId });
  }

  /** Record which instance just took a turn on this task. Called at
   * dispatch, not at cursor time — transcript-replay engines never
   * produce a cursor, and they still count as having run last. */
  markTaskDispatched(botId: string, threadId: string, instanceId: string) {
    const task = this.taskByThread(botId, threadId);
    if (!task || task.lastInstanceId === instanceId) return;
    task.lastInstanceId = instanceId;
    this.saveBots();
  }

  /** Bank one settled turn onto its task. Called once per turn.completed;
   * the running per-driver token indicator is deliberately not used here
   * because its meaning differs by driver.  When the caller passes the
   * instanceId that ACTUALLY ran the turn (post-fallback), the turn is
   * also banked into the task's per-instance breakdown, so cost
   * attribution follows the engine that ran, not the configured one. */
  addTaskUsage(
    botId: string,
    threadId: string,
    turn: { input?: number; output?: number; cachedInput?: number; costUsd: number | null; billingMode?: TurnBillingMode },
    instanceId?: string,
    meta?: { engineId?: string; model?: string },
  ): TaskUsage | null {
    const task = this.taskByThread(botId, threadId);
    if (!task) return null;
    task.usage = mergeTaskUsage(task.usage, turn);
    if (instanceId) {
      const byInstance = (task.usageByInstance ??= {});
      const key = forkKey(byInstance, instanceId, meta);
      byInstance[key] = mergeInstanceUsage(byInstance[key], turn, meta);
    }
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task.usage;
  }

  /** Bank one settled SHARED-ROOM turn onto the speaking bot, keyed by the
   * instance that ran it.  Room threads are not bot tasks, so they cannot
   * go through addTaskUsage — without this the room's spend reached
   * telemetry only and the Usage tab never saw it.  `lastAt` lets period
   * windows (the 30-day projection) decide whether the bucket counts. */
  addRoomUsage(
    botId: string,
    instanceId: string,
    turn: { input?: number; output?: number; cachedInput?: number; costUsd: number | null; billingMode?: TurnBillingMode },
    meta?: { engineId?: string; model?: string },
  ): void {
    const bot = this.bot(botId);
    if (!bot) return;
    const byInstance = (bot.roomUsageByInstance ??= {});
    const key = forkKey(byInstance, instanceId, meta);
    byInstance[key] = { ...mergeInstanceUsage(byInstance[key], turn, meta), lastAt: Date.now() };
    this.saveBots();
    this.emit({ type: "bot", botId });
  }

  /** The folder a task's turn runs in. Pins on first call from the bot's
   * current folder — unless the task already has a session (a thread from
   * before folders existed), which pins to the default so the folder can't
   * move under it. Returns the pinned value: a path, or null for default. */
  pinTaskCwd(botId: string, threadId: string, fallbackCwd?: string, opts: { none?: boolean } = {}): string | null {
    const bot = this.bot(botId);
    const task = bot ? this.taskByThread(botId, threadId) : undefined;
    if (!bot || !task) return null;
    if (opts.none) {
      if (task.cwd !== null) {
        task.cwd = null;
        this.saveBots();
        this.emit({ type: "bot", botId });
      }
      return null;
    }
    if (task.cwd === undefined) {
      task.cwd = Object.keys(task.resumeCursors).length === 0 ? (bot.cwd ?? fallbackCwd ?? null) : null;
      this.saveBots();
      this.emit({ type: "bot", botId });
    }
    return task.cwd;
  }

  /** The folder a room's member turns run in. Pins on the first turn that
   * dispatches, from the room's `cwd` at that moment. Pinned, not read
   * live, for the same reason tasks pin (see pinTaskCwd): engines key
   * their sessions and files to the folder a thread starts in, and a room
   * lives on ONE thread forever — so changing the room's folder applies to
   * future rooms, never under a room that already started working
   * somewhere. Returns the pinned value: a path, or null = each member's
   * own default. */
  pinGroupCwd(groupId: string, threadId?: string): string | null {
    const group = this.group(groupId);
    if (!group) return null;
    const task = threadId ? this.groupTaskByThread(groupId, threadId) : this.activeGroupTask(groupId);
    // Direct-message channels retain the original single-thread contract.
    if (!task) {
      if (!group.dm) return null;
      if (group.pinnedCwd === undefined) {
        group.pinnedCwd = group.cwd ?? null;
        this.saveGroups();
        this.emit({ type: "group", groupId: group.id });
      }
      return group.pinnedCwd;
    }
    if (task.pinnedCwd === undefined) {
      task.pinnedCwd = group.cwd ?? null;
      if (group.threadId === task.threadId) group.pinnedCwd = task.pinnedCwd;
      this.saveGroups();
      this.emit({ type: "group", groupId: group.id });
    }
    return task.pinnedCwd;
  }

  // ── tasks ─────────────────────────────────────────────────────────────
  /** The first thing the human asked in a thread — a task's natural name. */
  private firstUserLine(threadId: string): string | null {
    const first = this.messagesFor(threadId).find((m) => m.role === "user" && m.kind === "text" && m.text?.trim());
    return first?.text ? titleFromMessage(first.text) : null;
  }

  tasks(botId: string): TaskRecord[] {
    return this.bot(botId)?.tasks ?? [];
  }

  activeTask(botId: string): TaskRecord | undefined {
    const bot = this.bot(botId);
    return bot?.tasks?.find((t) => t.threadId === bot.threadId);
  }

  taskByThread(botId: string, threadId: string): TaskRecord | undefined {
    return this.bot(botId)?.tasks?.find((t) => t.threadId === threadId);
  }

  /** True if the thread is one of the bot's own tasks, or belongs to a group the bot is a member of. */
  threadBelongsToBot(botId: string, threadId: string): boolean {
    if (this.taskByThread(botId, threadId)) return true;
    const group = this.groupByThread(threadId);
    return group ? group.memberIds.includes(botId) : false;
  }

  taskByAutomationKey(botId: string, automationKey: string): TaskRecord | undefined {
    if (!automationKey) return undefined;
    return this.bot(botId)?.tasks?.find(
      (t) => t.automationKey === automationKey || t.automationKeyAliases?.includes(automationKey),
    );
  }

  stampAutomationKey(botId: string, threadId: string, automationKey: string): TaskRecord | null {
    const task = this.taskByThread(botId, threadId);
    if (!task || !automationKey) return null;
    if (task.automationKey === automationKey) return task;
    // Simple mode shares one conversation across sources.  The first key
    // wins so a later routine cannot steal the lookup for an earlier one.
    if (task.automationKey) return task;
    task.automationKey = automationKey;
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  /** A fresh context on the same bot: new thread, new session, same
   * persona/tools/computer. Becomes the active task.  A matching
   * `automationKey` returns the existing task instead of minting another. */
  createTask(botId: string, title?: string, activate = true, automationKey?: string): TaskRecord | null {
    const bot = this.bot(botId);
    if (!bot) return null;
    if (automationKey) {
      const existing = this.taskByAutomationKey(botId, automationKey);
      if (existing) {
        if (activate && bot.threadId !== existing.threadId) this.switchTask(botId, existing.threadId);
        return existing;
      }
    }
    const task: TaskRecord = {
      threadId: newId(),
      title: title?.trim() || UNTITLED_TASK,
      createdAt: Date.now(),
      resumeCursors: {},
      ...(automationKey ? { automationKey } : {}),
    };
    bot.tasks = [task, ...(bot.tasks ?? [])];
    if (activate) {
      bot.threadId = task.threadId;
      bot.resumeCursors = {}; // legacy mirror follows the active task
    }
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  switchTask(botId: string, threadId: string): BotRecord | null {
    const bot = this.bot(botId);
    const task = bot?.tasks?.find((t) => t.threadId === threadId);
    if (!bot || !task) return null;
    bot.threadId = task.threadId;
    bot.resumeCursors = { ...task.resumeCursors };
    this.saveBots();
    this.emit({ type: "bot", botId });
    return bot;
  }

  renameTask(botId: string, threadId: string, title: string): TaskRecord | null {
    return this.patchTask(botId, threadId, { title });
  }

  /** Rename, set a per-thread model, or put the thread to sleep.
   *
   * `modelSelection: null` clears the override so the bot's engine is used
   * again; `snoozedUntil: null` wakes the thread now.  An omitted field
   * always means "leave it alone", which is why waking travels as an
   * explicit null rather than as an absent key. */
  patchTask(
    botId: string,
    threadId: string,
    patch: {
      title?: string;
      modelSelection?: ModelSelection | null;
      activeModelSelection?: ModelSelection | null;
      snoozedUntil?: number | null;
    },
  ): TaskRecord | null {
    const task = this.bot(botId)?.tasks?.find((t) => t.threadId === threadId);
    if (!task) return null;
    if (patch.title !== undefined) {
      task.title = patch.title.trim().slice(0, 80) || UNTITLED_TASK;
    }
    if (patch.modelSelection !== undefined) {
      if (patch.modelSelection === null) delete task.modelSelection;
      else task.modelSelection = patch.modelSelection;
    }
    if (patch.activeModelSelection !== undefined) {
      if (patch.activeModelSelection === null) delete task.activeModelSelection;
      else task.activeModelSelection = patch.activeModelSelection;
    }
    if (patch.snoozedUntil !== undefined) {
      if (patch.snoozedUntil === null) delete task.snoozedUntil;
      else task.snoozedUntil = patch.snoozedUntil;
      if (task.snoozedUntil === SNOOZE_UNTIL_ACTIVITY) this.threadsAwaitingActivity.add(threadId);
      else this.threadsAwaitingActivity.delete(threadId);
    }
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  /** End an until-activity snooze because the thread just did something.
   *
   * Self-healing: a thread that has since been deleted or merged away leaves
   * the index, so a stale id costs one lookup once and never again. */
  private wakeThreadOnActivity(threadId: string): void {
    this.threadsAwaitingActivity.delete(threadId);
    const bot = this.bots.find((b) => b.tasks?.some((t) => t.threadId === threadId));
    const task = bot?.tasks?.find((t) => t.threadId === threadId);
    if (!bot || !task || task.snoozedUntil !== SNOOZE_UNTIL_ACTIVITY) return;
    delete task.snoozedUntil;
    this.saveBots();
    this.emit({ type: "bot", botId: bot.id });
  }

  /** Drop every snooze whose deadline has passed, so a woken thread returns
   * to plain update order without waiting for someone to touch its bot.
   *
   * Clients heal expired deadlines on read as well — the harness clock is
   * the authority and a device's may be skewed — but a desktop or phone left
   * open needs the change to ARRIVE, which is what the emit here is for.
   * Returns the bots that changed so a caller can log or assert on it. */
  wakeExpiredThreadSnoozes(now = Date.now()): string[] {
    const woken: string[] = [];
    for (const bot of this.bots) {
      let changed = false;
      for (const task of bot.tasks ?? []) {
        if (!isSnoozeExpired(task.snoozedUntil, now)) continue;
        delete task.snoozedUntil;
        changed = true;
      }
      if (changed) woken.push(bot.id);
    }
    if (!woken.length) return woken;
    this.saveBots();
    for (const botId of woken) this.emit({ type: "bot", botId });
    return woken;
  }

  /** Name a task after its first message, once. */
  titleTaskFromFirstMessage(botId: string, text: string, threadId?: string) {
    const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId);
    if (!task || task.title !== UNTITLED_TASK) return;
    task.title = titleFromMessage(text);
    this.saveBots();
    this.emit({ type: "bot", botId });
  }

  /** Delete a task and its transcript. A bot always keeps one. */
  deleteTask(botId: string, threadId: string): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot || !bot.tasks || bot.tasks.length < 2) return null;
    if (!bot.tasks.some((t) => t.threadId === threadId)) return null;
    bot.tasks = bot.tasks.filter((t) => t.threadId !== threadId);
    this.deleteThreadRecord(threadId);
    if (bot.threadId === threadId) {
      bot.threadId = bot.tasks[0]!.threadId;
      bot.resumeCursors = { ...bot.tasks[0]!.resumeCursors };
    }
    this.saveBots();
    this.emit({ type: "bot", botId });
    return bot;
  }

  /** First-run seed: one bot so the app never opens empty — it gets a
   * random friendly name like every other bot. */
  seedIfEmpty() {
    if (this.bots.length || !this.firstRun) return;
    const bot = this.createBot({
      name: "Director",
      title: "Chief of Staff",
      description: "Chief of staff for the BotFleet roster. Route work, manage other bots, and coordinate fleet-wide tasks.",
      color: "blue",
      mascotExpression: "focused"
    });
    bot.autoApprove = false;
    const inbox = bot.tasks?.[0];
    if (inbox) inbox.title = "Inbox";
    this.saveBots();
  }
}
