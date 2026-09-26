// Server-backed store. The React app holds no transports of its own:
// it dispatches typed commands over HTTP and folds the one SSE event
// stream from the harness server into local state. The reducer stays
// pure; everything async lives in the wrapped dispatch + SSE fold.
import { UPDATE_STATUS_EVENT } from "@/lib/update-control";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CloudBackend, EffortLevel } from "../../server/contracts.ts";
import type { AccessTokenState } from "../../server/recall-access.ts";
import type { ComputerReach } from "../../server/computer-capability.ts";
import type { BotColor, BotMotion } from "@/lib/mascot";
import type { BotAvatarCrop } from "../../shared/bot-avatar";
import type { ConnectorToolGrant } from "../../shared/connector-tools";
import type { RoutineRequestCardData } from "../../shared/routine-request";
import type { ToolKind } from "../../shared/tool-activity";
import {
  DEFAULT_ROOM_TERMINOLOGY,
  resolveRoomLabels,
  type RoomLabels,
  type RoomTerminology,
} from "../../shared/terminology";
import {
  parseConversationMode,
  type ConversationMode,
} from "../../shared/conversation-mode";
import type { Routine, RoutineInput, RoutineRun } from "@/lib/routines";
import type { ResourceTrigger } from "@/lib/resource-triggers";
import type { WebhookAttempt, WebhookIngressStatus, WebhookTrigger } from "@/lib/webhooks";
import { currentCall } from "@/lib/call";
import { showNotification, type NotificationTarget } from "@/lib/notify";
import { speaker } from "@/lib/tts";
import { createBotPatchQueue, type BotUpdatePatch } from "./bot-patch-queue";
import { skillRecorderEnabled } from "@/lib/feature-flags";

export type { BotColor, MausColor } from "@/lib/mascot";

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  /** permission asks: the tool being requested (drives the approval box) */
  tool?: string;
  /** why auto mode stopped to ask anyway */
  held?: string;
  /** the narrow grant "always allow" remembers, e.g. "Bash:git" */
  allowKey?: string;
  approvalScope?: "local-computer";
  /** Persisted proposal used by the server when the user confirms it. */
  routineRequest?: RoutineRequestCardData;
}

export interface ConnectorCardData {
  slug: string;
  label: string;
  description: string;
  status: "required" | "authorizing" | "connected" | "failed";
  resumeKey: string;
  error?: string;
  dismissed?: boolean;
  resumed?: boolean;
}

export interface SecretRequestCardData {
  target: import("../../shared/credential-request").CredentialTargetId;
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
  /** `system` is auto-delivered instructions (routine / webhook / resource). */
  role: "bot" | "user" | "system";
  /** For a `system` message: what actually fired it — mirrors the server's
   * RoutineRunTrigger, inlined so this module does not depend on it.  Lets
   * the UI show an accurate subtitle instead of a generic "Routine" label
   * for every non-webhook/imessage system message. */
  automationSource?: "schedule" | "manual" | "webhook" | "resource";
  kind: "text" | "options" | "activity" | "screen" | "connector" | "secret";
  text?: string;
  card?: OptionCardData;
  connector?: ConnectorCardData;
  secret?: SecretRequestCardData;
  /** activity messages: tool name + outcome. `spoken` is the server's
   * narration of the same chip ("reading a file"), used by call mode. */
  /** `setup` marks an error fixed by installing something, not by retrying. */
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
  /** user messages sent into a running turn — the model saw it mid-turn */
  steered?: boolean;
  /** screen messages: a frame of the bot's computer (base64) */
  png?: string;
  mime?: string;
  /** A paginated page answers `hasImage` instead of the pixels: a thousand
   * base64 desktop captures is the one thing that must never arrive with a
   * transcript.  The frame is fetched from the per-message image route when
   * something actually shows it. */
  hasImage?: boolean;
  at: number;
  /** the message this one follows; null = thread root. Edited messages
   * share a parentId with the version they replace — that's a fork. */
  parentId?: string | null;
  /** Flat reply reference for an inline quote; unrelated to branch ancestry. */
  replyToId?: string;
  /** rooms: which member said this (sender attribution). */
  from?: { botId: string; name: string; color: BotColor };
  /** emoji reactions; by = "user" or a member botId. */
  reactions?: Array<{ emoji: string; by: string }>;
  /** comm chips: "Messaged @X" linking to the bot⇄bot channel. */
  comm?: { groupId: string; withBotId: string; withName: string; withColor: BotColor };
  /** sent while the bot was mid-turn; auto-sends when the turn settles.
   * Rendered only while the bot is busy, so a flag stranded by a server
   * restart never shows a promise nothing will keep. */
  queued?: boolean;
  /** steer-queue entry this drained user line came from. Pending chips
   * match on this id, not on equal text. Absent on ordinary sends. */
  queueId?: string;
}

export type GroupDefaultResponder =
  | { kind: "member"; botId: string }
  | { kind: "everyone" }
  | { kind: "mentions" };

/** A room: several bots + you in one shared thread. */
export interface Group {
  id: string;
  threadId: string;
  name: string;
  avatarUrl?: string | null;
  avatarCrop?: "circle" | "rounded" | "square" | "mascot" | null;
  memberIds: string[];
  defaultResponder: GroupDefaultResponder;
  bulletin: string;
  unread: boolean;
  createdAt: number;
  /** auto-created bot⇄bot channel (ask_bot exchanges mirror here) */
  dm?: boolean;
  busyBotId?: string | null;
  /** the room's shared desk — where member turns run their shell tools,
   * overriding each member's own folder; absent = each member's own */
  cwd?: string;
  /** Additional associated workspace folders/repositories */
  extraCwds?: string[];
  /** folder the room's turns actually run in, pinned on the first turn;
   * null = each member's own default; absent = not pinned yet */
  pinnedCwd?: string | null;
  /** the one message pinned to the top of this room's transcript */
  pinnedMessageId?: string;
  /** sidebar section heading this room is filed under (shared with bots) */
  section?: string;
  /** New user-created rooms remain in setup until Save or Skip. */
  setupCompletedAt?: number | null;
  setupSkippedAt?: number | null;
  /** Separate conversations in this channel. DMs deliberately stay on one
   * thread and omit this collection. */
  tasks?: GroupTask[];
  messages: Message[];
  /** The hydrate said the server holds messages older than the first one it
   * sent.  Read once into `hasMore` and not kept on the room, so there is
   * one place a pill can ask. */
  hasMore?: boolean;
}

/** One of a channel's independent conversations. The channel's threadId
 * points at the active one; folder and pin state belong to the task. */
export interface GroupTask {
  threadId: string;
  title: string;
  createdAt: number;
  /** Last message in this task's thread; falls back to createdAt. */
  lastActivity?: number;
  pinnedCwd?: string | null;
  pinnedMessageId?: string;
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  effort?: EffortLevel;
  fallbacks?: ModelSelection[];
}

/** One of a bot's separate contexts: its own thread, transcript and
 * provider session. The bot's threadId points at the active one. */
export interface Task {
  threadId: string;
  title: string;
  createdAt: number;
  /** Last message in this task's thread; falls back to createdAt. */
  lastActivity?: number;
  /** what this task has spent, banked once per settled turn */
  usage?: TaskUsage;
  /** Per-instance breakdown of `usage`, banked from the selection that
   *  actually ran each turn (post-fallback).  `engineId` is the registry
   *  engine resolved at bank time, so attribution survives deleting the
   *  connection;  `byModel` splits the bucket per model that ran.
   *  Absent on older records. */
  usageByInstance?: Record<string, TaskUsage & { engineId?: string; byModel?: Record<string, TaskUsage> }>;
  /** folder this task's turns run in, pinned on its first turn; null =
   * legacy home-folder session; absent = not pinned yet */
  cwd?: string | null;
  /** Optional engine for this conversation.  Absent means the bot's own
   * modelSelection.  Used in Projects mode so a thread is not a named bot. */
  modelSelection?: ModelSelection;
  /** Active engine actually in use (including fallback rollover). */
  activeModelSelection?: ModelSelection;
  /** Stable webhook/routine identity so a re-fire appends here. */
  automationKey?: string;
  /** This thread is asleep: 0 until it does anything again, a timestamp
   * until that moment, absent means awake.  The harness drops deadlines it
   * has already passed, so an arriving snapshot is authoritative — but a
   * window left open across one is not, which is why the sidebar checks the
   * clock too.  See `shared/thread-snooze.ts`. */
  snoozedUntil?: number;
}

export interface TaskUsage {
  input: number;
  output: number;
  /** cached share of `input` (context the model re-read); absent on records
   * from builds before it was tracked */
  cachedInput?: number;
  /** null until any turn reported a cost — most engines never do; records
   * from builds before cost existed lack the field entirely */
  costUsd: number | null;
  turns: number;
}

export interface Bot {
  id: string;
  threadId: string;
  /** Server-stamped create time. Used as the roster fallback when a bot
   * has no messages and no task activity yet. */
  createdAt?: number;
  /** every context this bot has, newest first */
  tasks?: Task[];
  /** Shared-room turns this bot spoke, banked per engine instance (room
   *  threads are not bot tasks).  `lastAt` is the bucket's most recent
   *  turn, for period windows. */
  roomUsageByInstance?: Record<string, TaskUsage & { lastAt: number; engineId?: string; byModel?: Record<string, TaskUsage> }>;
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: BotColor;
  mascotExpression?: string | null;
  /** App-owned image attachment used for this bot's profile. */
  avatarUrl?: string | null;
  /** Mascot, or the crop applied to avatarUrl. */
  avatarCrop?: BotAvatarCrop;
  unread: boolean;
  busy?: boolean;
  activityStartedAt?: number;
  /** what the bot is doing, as the harness sees it; busy is derived from it */
  activity?: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
  modelSelection: ModelSelection;
  /** Active engine actually in use (including fallback rollover). */
  activeModelSelection?: ModelSelection;
  /** Where this bot's computer runs; unset = auto (cloud box if one exists, else local). */
  computers?: Array<"cloud" | "vm" | "local" | "off">;
  /** Which cloud computer backs `computer: "cloud"`; absent means Box. */
  cloudBackend?: CloudBackend;
  /** Allow Auto to prepare/start the managed VPS container. Off by default. */
  autoStartVps?: boolean;
  /** where new tasks run their shell tools; absent = the private bot workspace */
  cwd?: string;
  /** auto mode: the bot approves its own tool permissions */
  autoApprove?: boolean;
  /** optional model review for otherwise undecided, attended approvals */
  autoReview?: "off" | "shadow" | "enforce";
  /** tools this bot may always use without asking */
  alwaysAllow?: string[];
  /** Ceiling on HTTP toolLoop rounds (MiniMax / Grok HTTP / openai-compat). Unset or null uses 12. */
  maxToolRounds?: number | null;
  /** speak this bot's replies aloud as they settle */
  speakReplies?: boolean;
  /** this bot's own voice id (falls back to the app-wide one) */
  voice?: string;
  pinned?: boolean;
  hidden?: boolean;
  /** Sidebar section this bot renders under; absent = unsectioned. */
  section?: string;
  /** the one message pinned to the top of this bot's active thread */
  pinnedMessageId?: string;
  /** This sidebar section's primary coordinator. */
  chiefOfStaff?: boolean;
  /** When this bot wants to talk to another bot (ask_bot/delegate_bot),
   * pause and ask the user first. Off by default. */
  approvePeerComms?: boolean;
  /** Whether this bot may use the workspace's connected apps. Unset means
   * allowed for existing bots; imported bots start with this disabled. */
  composio?: boolean;
  /** Per-bot Composio tool grants. Unset = every connected service, every
   * tool (legacy). An explicit record — including the empty one — allows
   * only what it names. A PATCH may send `null` to clear back to legacy,
   * mirroring avatarUrl. */
  connectorTools?: Record<string, ConnectorToolGrant> | null;
  messages: Message[];
  /** The hydrate said the server holds messages older than the first one it
   * sent.  Read once into `hasMore` and not kept on the conversation, so
   * there is one place a pill can ask. */
  hasMore?: boolean;
  /** leaf of the visible conversation branch (see visibleMessages) */
  activeLeafId?: string | null;
}

/** The visible conversation: walk parentId links from the active leaf back
 * to the root. Falls back to the flat list for pre-branching payloads. */
export function visibleMessages(bot: Bot): Message[] {
  const leafId = bot.activeLeafId;
  if (!leafId) return bot.messages;
  const byId = new Map(bot.messages.map((m) => [m.id, m]));
  if (!byId.has(leafId)) return bot.messages;
  const path: Message[] = [];
  let cur = byId.get(leafId);
  while (cur) {
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

/** Roster timestamp across every task, not just the currently selected
 * thread. An unread update on a background task must not keep showing
 * yesterday from the open conversation. */
export function latestChatActivity(
  tasks: Array<{ lastActivity?: number; createdAt: number }> | undefined,
  loadedLastAt: number | undefined,
  createdAt: number,
): number {
  const fromTasks = (tasks ?? []).map((task) => task.lastActivity ?? task.createdAt);
  return Math.max(loadedLastAt ?? 0, createdAt, ...fromTasks);
}

/** Pinned first, then newest activity. Unread is a badge, not a sort key. */
export function compareBotsByRecentActivity(a: Bot, b: Bot): number {
  const pin = Number(b.pinned ?? false) - Number(a.pinned ?? false);
  if (pin !== 0) return pin;
  return (
    latestChatActivity(b.tasks, visibleMessages(b).at(-1)?.at, b.createdAt ?? 0) -
    latestChatActivity(a.tasks, visibleMessages(a).at(-1)?.at, a.createdAt ?? 0)
  );
}

export function compareGroupsByRecentActivity(a: Group, b: Group): number {
  return (
    latestChatActivity(b.tasks, b.messages.at(-1)?.at, b.createdAt) -
    latestChatActivity(a.tasks, a.messages.at(-1)?.at, a.createdAt)
  );
}

/** All versions of a turn-starting message (itself + the forks that
 * replaced it), oldest first. Length 1 = never edited. A turn starter is a
 * person's "user" message OR an auto-delivered routine/webhook/resource
 * instruction stored as "system" — Regenerate forks either role (see
 * store.branchMessage), so both need their siblings to stay reachable
 * through the version controls. */
export function messageVersions(bot: Bot, message: Message): Message[] {
  if ((message.role !== "user" && message.role !== "system") || message.kind !== "text") return [message];
  return bot.messages
    .filter(
      (m) => m.role === message.role && m.kind === "text" && (m.parentId ?? null) === (message.parentId ?? null),
    )
    .sort((a, b) => a.at - b.at);
}

/** GET /api/config — configured flags only; secrets are never echoed. */
export interface ConfigStatus {
  /** The server's host platform (`process.platform`).  Absent from older
   * servers. */
  host?: { platform: string };
  xai?: { configured: boolean };
  /** The two `install.apiKeyOnly` engines: an endpoint and a key, no CLI to
   * install and no interactive sign-in.  `url` is configuration, not a
   * credential, so it comes back in full; `pending` is the packaged-app
   * state where the encrypted store holds the key but its replay has not
   * reached the harness yet. */
  openaiCompat?: { configured: boolean; url: string; pending: boolean };
  minimax?: { configured: boolean; url: string; pending: boolean };
  deepseek?: { configured: boolean };
  composio: {
    configured: boolean;
    mode?: "managed" | "self-hosted" | "unavailable";
    /** Why the managed connected-apps service is or is not in use. */
    managedSetup?: { status: "unconfigured" | "ready" | "failed"; message?: string };
  };
  box: { configured: boolean };
  vps: { configured: boolean; sshAlias: string };
  rooms: { turnTimeoutMinutes: number };
  /** What a bot that has never been configured is given. */
  botDefaults?: {
    computers: Array<"cloud" | "vm" | "local">;
    cloudBackend: "box" | "vps";
    /** null = every destination is allowed (the shipped default).  Legacy
     * input — the redesigned Computer settings UI reads
     * `computerProviders` instead and writes back through here so the
     * server's allowlist gate keeps working through the cut-over. */
    allowedComputers: Array<"cloud" | "vm" | "local"> | null;
    /** Per-provider allowlist written by the redesigned Computer
     * settings UI.  The toggles drive this shape; the legacy
     * `allowedComputers` above is back-filled from it for the cut-over
     * release. */
    computerProviders?: {
      asciiBox: boolean;
      selfHostedVps: boolean;
      localVm: boolean;
      localMac: boolean;
    };
    /** Shared-vs-per-bot VPS mode.  `null` is only legal when
     * `selfHostedVps` is false. */
    vpsMode?: "shared" | "per-bot" | null;
  };
  ingress?: { publicUrl?: string; enabled?: boolean };
  localVm: { mode: "shared" | "per-bot"; maxInstances: number };
  opencodeGo?: { configured: boolean };
  /** Voice (ElevenLabs). `configured` = a key is saved; `ready` = a key AND
   * a voice, which is what it takes to actually speak. The key itself is
   * never echoed back. */
  tts?: { configured: boolean; ready: boolean; voice: string; provider?: "elevenlabs" | "system" };
  /** Shared write-only credential for on-demand GPT Image avatars. */
  imageGen?: { configured: boolean };
  /** who's using the app — collected in onboarding, shown in the sidebar */
  profile?: { name: string; email: string };
  autoUpdate?: {
    enabled: boolean;
    lastCheckMs?: number | null;
    /** Resolved by the harness: a tick inside the 6h window reports
     * `due: false` so the Settings panel does not have to redo the math. */
    due?: boolean;
    lastAppFingerprint?: string | null;
  };
  terminology?: RoomTerminology;
  /** The finished words, resolved by the harness so every client
   * agrees. Absent only when talking to an older harness. */
  roomLabels?: RoomLabels;
  /** Simple (Grok-style bots + group threads) or Projects (categories of
   * threads).  Absent means simple. */
  conversationMode?: ConversationMode;
  /** Shared Qdrant Bot RAG vector database status. `url` and `collection`
   * are empty until the operator sets them — BotFleet ships no endpoint. */
  qdrant?: {
    enabled: boolean;
    url: string;
    configured: boolean;
    hasApiKey: boolean;
    collection: string;
    /** Cloudflare Access service token.  The id comes back so the panel can
     * show which token is in place; the secret half never does. */
    accessClientId: string;
    hasAccessClientSecret: boolean;
    hasAccessServiceToken: boolean;
    /** Which half of the pair is missing, when one of them is. */
    accessTokenState?: AccessTokenState;
  };
  /** Usage-monitor telemetry. `ingestUrl` is empty when unconfigured; the
   * token is never echoed back, only `hasToken`. */
  usage?: {
    ingestUrl: string;
    configured: boolean;
    hasToken: boolean;
    hasReadToken?: boolean;
    /** Whether a locally-observed subscription cap diverts auto-fallback. */
    localQuotaRouting?: boolean;
    projects: Array<{ slug: string; match: string[] }>;
    enginePlans?: Record<string, { planName?: string; costPerMonth?: number | null }>;
  };
  /** Opt-in flags. Absent means off. */
  features?: { skillRecorder: boolean; showToolCalls?: boolean; summarizeToolCalls?: boolean };
  /** Sentry diagnostics.  `configured` mirrors `hasDsn` — a key is on file,
   * whether or not `enabled` is currently true.  The DSN itself never
   * appears here; it travels only over `GET /api/observability`. */
  observability?: {
    configured: boolean;
    enabled: boolean;
    /** Stored switch before DSN availability is folded into `enabled`. */
    requestedEnabled?: boolean;
    hasDsn: boolean;
    host: string | null;
    // "infisical" mirrors server/observability.ts's ObservabilityStatusView:
    // the SDK itself only ever sees env/config/none, but a store-held DSN
    // reports this instead so the card names the vault, not "Settings".
    source: "env" | "config" | "none" | "infisical";
    environment: string;
    tracesSampleRate: number;
    aiTracesSampleRate?: number;
    httpTracesSampleRate?: number;
    uiTracesSampleRate?: number;
    logsEnabled: boolean;
  };
  /** Infisical secret-store status.  Booleans and counts only — the project
   * id, site URL and the vault's own names live on the loopback
   * `GET /api/infisical/status` route (see `fetchSecrets` below), which no
   * window subscribes to. */
  infisical?: {
    configured: boolean;
    enabled: boolean;
    writeThrough: boolean;
    environment: string;
    hasClientSecret: boolean;
    managedCount: number;
    lastSyncAt: string | null;
    stale: boolean;
    hasError: boolean;
    pendingProviderReload: boolean;
  };
}

export type { RoomTerminology };

/** The words to call a room, for any component that renders one.
 *
 * The harness resolves these and sends them as `roomLabels`; resolving
 * locally is the fallback for an older harness that only sends the key. */
export function getRoomTerminology(config?: ConfigStatus | null): {
  key: RoomTerminology;
  singular: string;
  plural: string;
} {
  const key = config?.terminology ?? DEFAULT_ROOM_TERMINOLOGY;
  const labels = config?.roomLabels ?? resolveRoomLabels(key);
  return { key, singular: labels.singular, plural: labels.plural };
}

export function getConversationMode(config?: ConfigStatus | null): ConversationMode {
  return parseConversationMode(config?.conversationMode);
}

export type ConfigStatusFrame = Pick<
  ConfigStatus,
  "xai" | "deepseek" | "composio" | "box" | "vps" | "rooms" | "botDefaults" | "host" | "ingress" | "localVm" | "opencodeGo" | "tts" | "imageGen" | "profile" | "autoUpdate" | "terminology" | "roomLabels" | "conversationMode" | "qdrant" | "usage" | "features" | "observability" | "infisical"
>;

export function configStatusFromFrame(frame: ConfigStatusFrame): ConfigStatus {
  return {
    xai: frame.xai,
    deepseek: frame.deepseek,
    composio: frame.composio,
    box: frame.box,
    vps: frame.vps,
    rooms: frame.rooms,
    // Every inheriting bot's resolved cloud backend depends on this
    // surviving each SSE `config` frame — drop it here and
    // resolveCloudBackend() silently falls back to "box" fleet-wide.
    botDefaults: frame.botDefaults,
    host: frame.host,
    ingress: frame.ingress,
    localVm: frame.localVm,
    opencodeGo: frame.opencodeGo,
    tts: frame.tts,
    imageGen: frame.imageGen,
    profile: frame.profile,
    autoUpdate: frame.autoUpdate,
    terminology: frame.terminology,
    roomLabels: frame.roomLabels,
    conversationMode: frame.conversationMode,
    qdrant: frame.qdrant,
    usage: frame.usage,
    features: frame.features,
    observability: frame.observability,
    infisical: frame.infisical,
  };
}

/** How an engine gets installed — declared by its driver, mirrors
 * EngineInstall in server/contracts.ts. Absent for engines that need no
 * local binary. `command` omits platforms that have no one-liner. */
export interface EngineInstall {
  command?: Partial<Record<"darwin" | "win32" | "linux", string>>;
  docsUrl?: string;
  signInCommand?: string;
  needsNode?: boolean;
  /** No CLI, no interactive login — authenticates with a bare API key. */
  apiKeyOnly?: boolean;
}

/** One row of GET /api/instances — the model picker's data. */
export interface InstanceInfo {
  instanceId: string;
  driverKind: string;
  displayName: string;
  enabled?: boolean;
  snapshot: {
    state: "available" | "unavailable";
    reason?: string;
    authenticated?: boolean;
    version?: string | null;
    /** a reported cost on a subscription is notional; the UI says so */
    billing?: "metered" | "subscription";
    quota?: {
      capped: boolean;
      resetsAt?: number | null;
      error?: string;
      windowsLabel?: string;
      models?: Record<string, {
        capped: boolean;
        remainingPercent?: number | null;
        secondaryRemainingPercent?: number | null;
        resetsAt?: number | null;
        error?: string;
        windowsLabel?: string;
      }>;
      /** MiniMax's own balance/quota summary, computed per instance — see
       *  server/contracts.ts's ProviderSnapshot.quota.minimax. */
      minimax?: {
        source: "account-balance" | "token-plan" | "unavailable";
        capExists: boolean;
        status: "ok" | "near_cap" | "capped" | "unknown";
        balanceUsd: number | null;
        remainingPercent: number | null;
        secondaryRemainingPercent: number | null;
        resetsAt: number | null;
        weeklyResetsAt: number | null;
        error: string | null;
      };
    };
  };
  models: {
    default: string;
    options: Array<{
      id: string;
      label: string;
      custom?: boolean;
      loaded?: boolean;
      /** Short tag rendered next to the label in the model picker (e.g. a
       * price/speed tradeoff the user should see before picking).  Drivers
       * set it on static catalog rows; the picker renders it as a chip with
       * `badgeTitle` (full sentence) on hover.  Keep the chip under ~10 chars
       * so it does not push the label to a second line on narrow chat heads. */
      badge?: string;
      /** Hover explanation for `badge`.  Without this the chip renders
       * without a tooltip and a screen-reader hint. */
      badgeTitle?: string;
      effortLevels?: readonly EffortLevel[];
      supportsEffort?: boolean;
    }>;
  };
  capabilities?: {
    computerMcp?: boolean;
    agentsMcp?: boolean;
    composioMcp?: boolean;
    images?: boolean;
    effortLevels?: readonly EffortLevel[];
    /** the engine keeps a live session and takes a message mid-turn */
    queueing?: boolean;
    localComputerMcp?: boolean;
    /** This engine can answer a bounded review prompt without changing the
     * bot's active conversation. */
    approvalReview?: boolean;
    /** The harness runs this engine's tool loop, so Maximum Tool Rounds applies. */
    toolLoop?: boolean;
  };
  /** Which computer destinations this engine can be given at all, derived
   *  server-side in `server/computer-capability.ts` and shipped whole.  The
   *  picker LOOKS THIS UP; it does not restate the rule, because the last
   *  hand-mirrored copy drifted and offered destinations the turn refused.
   *  Optional only so a row from an older server stays fail-closed. */
  computerReach?: ComputerReach;
  /** `custom` engines sit below the rail divider — no subscription catalog. */
  access?: "subscription" | "custom";
  install?: EngineInstall;
  /** Configured CLI path override — set ONLY when the user overrode it;
   * absent means the driver default is in effect. */
  cli?: string;
  /** Driver's default binary name (e.g. "claude"). */
  cliDefault?: string;
  /** Absolute paths of every default binary found on PATH, PATH order. */
  cliCandidates?: string[];
  /** YOLO full access bypass permissions */
  fullAuto?: boolean;
  /** Custom engine icon URL or data URL */
  iconUrl?: string;
  /** User-created custom engine instance */
  isCustom?: boolean;
}

export type AppSettingsSection =
  | "general"
  | "connections"
  | "remote"
  | "engines"
  | "models"
  | "companion"
  | "computers"
  | "usage"
  | "observability"
  | "secrets";

export interface AppState {
  bots: Bot[];
  groups: Group[];
  instances: InstanceInfo[];
  config: ConfigStatus | null;
  /** selected chat — a bot id OR a group id */
  selectedId: string;
  activeView: "chat" | "team-map" | "routines" | "skill-recorder";
  selectedRoutineId?: string | null;
  routines: Routine[];
  routineRuns: RoutineRun[];
  webhooks: WebhookTrigger[];
  webhookAttempts: WebhookAttempt[];
  webhookIngress: WebhookIngressStatus | null;
  resourceTriggers: ResourceTrigger[];
  settingsOpen: boolean;
  pluginsOpen: boolean;
  computerOpen: boolean;
  /** the per-thread event inspector (runtime stream + native protocol tee) */
  inspectorOpen: boolean;
  appSettingsOpen: boolean;
  appSettingsSection: AppSettingsSection;
  /** latest live frame of a bot's computer, per botId */
  screens: Record<string, { png: string; mime: string }>;
  /** bots whose cloud computer is being provisioned */
  provisioning: Record<string, boolean>;
  /** who is driving each bot's computer: held = the person has the wheel
   * (the bot's hands are refused server-side); helpReason = the bot's open
   * plea for the person to take over */
  computerControl: Record<string, { held: boolean; helpReason: string | null }>;
  /** a search hit to scroll to once its thread is on screen; nonce lets the
   * same message be focused twice in a row */
  focusMessage: { threadId: string; messageId: string; nonce: number; consumed: boolean } | null;
  connected: boolean;
  hydration: {
    status: "idle" | "loading" | "ready" | "failed";
    error: string | null;
    retryAt: number | null;
  };
  error: string | null;
  mascotMotion: {
    botId: string;
    nonce: number;
    kind: Exclude<BotMotion, "none">;
  } | null;
  /** 1:1 queue-fallback lines waiting for drain; keyed by threadId.
   * Each entry is identified by the server queueId, not by text. */
  pendingQueued: Record<string, Array<{ queueId: string; text: string; at: number }>>;
  /** queueIds whose drain frame beat the POST continuation. One-shot and
   * bounded to a short event window so other clients cannot grow it forever. */
  consumedQueueIds: Record<string, true>;
  /** Bumps on optimistic bot edits so a stale REST hydrate cannot clobber them. */
  botEpoch: Record<string, number>;
  groupEpoch: Record<string, number>;
  /** Whether the server still holds messages older than the oldest one this
   * client loaded, keyed by threadId.  The desktop used to hydrate every
   * message of every bot's active thread at once; it now takes a tail and
   * pulls earlier pages when the reader asks, which is what the iOS
   * companion has always done. */
  hasMore: Record<string, boolean>;
  /** Threads with a scrollback page in flight — the pill says "Loading…"
   * instead of firing a second request per click. */
  loadingEarlier: Record<string, boolean>;
}

/** Messages hydrated per thread on a cold start.
 *
 * Enough that most conversations arrive whole and nobody sees a pill, small
 * enough that a fleet of bots with thousand-message computer-use threads
 * does not put all of it on the heap at once.  Earlier pages arrive on
 * demand at PAGE_SIZE each. */
export const INITIAL_PAGE = 200;
export const PAGE_SIZE = 200;

const MAX_CONSUMED_QUEUE_IDS = 64;

/** A resumed stream covers its event gap, but it cannot repair a REST
 * snapshot that previously failed. */
export function shouldHydrateAfterHello(resumed: boolean, previousHydrationFailed: boolean): boolean {
  return !resumed || previousHydrationFailed;
}

export async function runHydrationRequests(
  requests: Array<{ label: string; request: Promise<unknown> }>,
): Promise<void> {
  const settled = await Promise.allSettled(requests.map(({ request }) => request));
  const failed = settled.flatMap((result, index) =>
    result.status === "rejected" ? [requests[index]!.label] : [],
  );
  if (failed.length) throw new Error(`Could not refresh ${failed.join(", ")}.`);
}

function rememberConsumedQueueId(consumed: Record<string, true>, queueId: string): Record<string, true> {
  const next = { ...consumed, [queueId]: true as const };
  const overflow = Object.keys(next).length - MAX_CONSUMED_QUEUE_IDS;
  if (overflow > 0) {
    for (const id of Object.keys(next).slice(0, overflow)) delete next[id];
  }
  return next;
}

export type BotAnnouncement = Omit<Bot, "messages"> & { messages?: Message[] };

export type Action =
  | {
      type: "hydrate";
      bots: Bot[];
      groups: Group[];
      computerControl: Record<string, { held: boolean; helpReason: string | null }>;
      overlays?: Record<string, BotUpdatePatch>;
      botEpochAtFetch?: Record<string, number>;
      groupEpochAtFetch?: Record<string, number>;
    }
  | { type: "loadEarlier"; threadId: string }
  | { type: "earlierLoading"; threadId: string }
  | { type: "earlierLoaded"; threadId: string; messages: Message[]; hasMore: boolean }
  | { type: "showRoutines"; routineId?: string }
  | { type: "showTeamMap" }
  | { type: "showSkillRecorder" }
  | { type: "routinesHydrated"; routines: Routine[]; runs: RoutineRun[] }
  | { type: "routinePatched"; routine: Routine }
  | { type: "routineDeleted"; routineId: string }
  | { type: "routineRunPatched"; run: RoutineRun }
  | { type: "webhooksHydrated"; webhooks: WebhookTrigger[]; attempts: WebhookAttempt[]; ingress: WebhookIngressStatus }
  | { type: "webhookPatched"; webhook: WebhookTrigger }
  | { type: "webhookAttempted"; attempt: WebhookAttempt }
  | { type: "webhookDeleted"; webhookId: string }
  | { type: "resourceTriggersHydrated"; triggers: ResourceTrigger[] }
  | { type: "resourceTriggerPatched"; trigger: ResourceTrigger }
  | { type: "resourceTriggerDeleted"; triggerId: string }
  | { type: "createRoutine"; input: RoutineInput }
  | { type: "updateRoutine"; routineId: string; patch: Partial<RoutineInput> }
  | { type: "deleteRoutine"; routineId: string }
  | { type: "runRoutine"; routineId: string }
  | { type: "cancelRoutineRun"; runId: string }
  | { type: "markRoutineRunSeen"; runId: string }
  | { type: "groupPatched"; group: Partial<Group> & { id: string } }
  | { type: "groupDeleted"; groupId: string }
  | { type: "createGroup"; memberIds: string[]; name?: string; section?: string }
  | { type: "sendGroup"; groupId: string; text: string; replyToId?: string }
  | {
      type: "patchGroup";
      groupId: string;
      patch: Partial<Pick<Group, "name" | "avatarUrl" | "avatarCrop" | "bulletin" | "memberIds" | "defaultResponder" | "pinnedMessageId" | "section" | "cwd" | "extraCwds">>;
    }
  | { type: "deleteGroup"; groupId: string }
  | { type: "newGroupTask"; groupId: string }
  | { type: "switchGroupTask"; groupId: string; threadId: string }
  | { type: "renameGroupTask"; groupId: string; threadId: string; title: string }
  | { type: "moveGroupTask"; groupId: string; threadId: string; toGroupId: string }
  | { type: "moveGroupTaskToBot"; groupId: string; threadId: string; botId: string }
  | { type: "moveTaskToBot"; botId: string; threadId: string; toBotId: string }
  | { type: "moveTaskToGroup"; botId: string; threadId: string; toGroupId: string }
  | { type: "mergeTasks"; botId: string; threadId: string; intoThreadId: string }
  | { type: "deleteGroupTask"; groupId: string; threadId: string }
  | { type: "toggleReaction"; threadId: string; messageId: string; emoji: string }
  | { type: "interruptGroup"; groupId: string }
  | { type: "instances"; instances: InstanceInfo[] }
  | { type: "configStatus"; config: ConfigStatus }
  | { type: "select"; id: string }
  | { type: "send"; botId: string; text: string; replyToId?: string }
  | { type: "pendingQueued"; threadId: string; queueId: string; text: string; at?: number }
  | { type: "consumePendingQueued"; threadId: string; queueId: string }
  | { type: "cancelQueued"; botId: string; queueId: string }
  | { type: "editMessage"; botId: string; messageId: string; text: string }
  | { type: "switchBranch"; botId: string; messageId: string }
  | { type: "threadActive"; threadId: string; activeLeafId: string }
  | { type: "answerCard"; botId: string; messageId: string; answer: string }
  | { type: "dismissCard"; botId: string; messageId: string }
  // permission cards answer by THREAD, so a request raised inside a room
  // can be answered the same way as one in a 1:1 chat
  | {
      type: "decideRequest";
      threadId: string;
      requestId: string;
      behavior: "allow" | "deny" | "answer";
      message?: string;
      /** remember this exact grant (the server's allowKey) for the bot */
      alwaysAllow?: { botId: string; key: string };
      /** Local UI recovery hook for voice flows. Never sent to the server. */
      onError?: (message: string) => void;
    }
  | { type: "newTask"; botId: string }
  | { type: "switchTask"; botId: string; threadId: string }
  | { type: "taskSwitched"; bot: Bot }
  | { type: "renameTask"; botId: string; threadId: string; title: string }
  /** Put one thread to sleep, or wake it.  `null` is the wake — an omitted
   * field means "leave it alone" on the harness route, and `0` is the real
   * until-activity sentinel rather than an empty value. */
  | { type: "snoozeTask"; botId: string; threadId: string; snoozedUntil: number | null }
  | { type: "deleteTask"; botId: string; threadId: string }
  | { type: "newBot" }
  | { type: "botAdded"; bot: Bot }
  | { type: "deleteBot"; botId: string }
  | { type: "duplicateBot"; botId: string }
  | { type: "markUnread"; botId: string }
  | { type: "botPatched"; bot: BotAnnouncement }
  | { type: "messageAdded"; threadId: string; message: Message }
  | { type: "messagePatched"; threadId: string; message: Message }
  | { type: "screenFrame"; botId: string; png: string; mime: string }
  | { type: "provisioning"; botId: string; on: boolean }
  | { type: "computerControl"; botId: string; held: boolean; helpReason: string | null }
  | { type: "setModel"; botId: string; selection: ModelSelection }
  | { type: "interrupt"; botId: string }
  | { type: "connected"; value: boolean }
  | { type: "hydrationStarted" }
  | { type: "hydrationReady" }
  | { type: "hydrationFailed"; message: string; retryAt: number | null }
  | { type: "error"; message: string | null }
  | { type: "toggleSettings"; open?: boolean }
  | { type: "togglePlugins"; open?: boolean }
  | { type: "toggleComputer"; open?: boolean }
  | { type: "toggleInspector"; open?: boolean }
  | { type: "focusMessage"; threadId: string; messageId: string }
  | { type: "focusMessageConsumed"; nonce: number }
  | { type: "toggleAppSettings"; open?: boolean; section?: AppSettingsSection }
  | {
      type: "updateBot";
      botId: string;
      patch: BotUpdatePatch;
    };

export function openNotificationTarget(
  dispatch: (action: Action) => void,
  target: NotificationTarget,
  state: Pick<AppState, "bots" | "groups">,
) {
  // A room's approval/question notification carries the asker bot with the
  // GROUP's thread id; asking the bot to switch to that thread would 404.
  // Open the room itself. A thread that is neither a room nor one of the
  // bot's own lands on a plain bot select instead of an error banner.
  const group = state.groups.find(
    (candidate) =>
      candidate.threadId === target.threadId ||
      (candidate.tasks ?? []).some((task) => task.threadId === target.threadId),
  );
  if (group) {
    dispatch({ type: "select", id: group.id });
    if (group.threadId !== target.threadId) {
      dispatch({ type: "switchGroupTask", groupId: group.id, threadId: target.threadId });
    }
    return;
  }
  dispatch({ type: "select", id: target.botId });
  const bot = state.bots.find((candidate) => candidate.id === target.botId);
  if (!bot) return;
  const known =
    bot.threadId === target.threadId ||
    (bot.tasks ?? []).some((task) => task.threadId === target.threadId);
  if (known) dispatch({ type: "switchTask", botId: target.botId, threadId: target.threadId });
}

function updateBot(state: AppState, botId: string, fn: (b: Bot) => Bot): AppState {
  return { ...state, bots: state.bots.map((b) => (b.id === botId ? fn(b) : b)) };
}

function bumpEpoch(map: Record<string, number>, id: string): Record<string, number> {
  return { ...map, [id]: (map[id] ?? 0) + 1 };
}

/** REST hydrate must not wipe in-flight profile patches. Overlay is the same
 * map SSE `bot` frames already apply; epoch keeps a local bot that changed
 * after the snapshot request started, even once the queue has drained. */
export function mergeHydrateBots(
  localBots: Bot[],
  serverBots: Bot[],
  overlays: Record<string, BotUpdatePatch>,
  localEpoch: Record<string, number>,
  epochAtFetch: Record<string, number>,
): Bot[] {
  const localById = new Map(localBots.map((bot) => [bot.id, bot]));
  return serverBots.map((serverBot) => {
    const overlay = overlays[serverBot.id] ?? {};
    const local = localById.get(serverBot.id);
    const started = epochAtFetch[serverBot.id] ?? 0;
    const now = localEpoch[serverBot.id] ?? 0;
    if (local && now > started) return { ...local, ...overlay };
    return { ...serverBot, ...overlay };
  });
}

export function mergeHydrateGroups(
  localGroups: Group[],
  serverGroups: Group[],
  localEpoch: Record<string, number>,
  epochAtFetch: Record<string, number>,
): Group[] {
  const localById = new Map(localGroups.map((group) => [group.id, group]));
  return serverGroups.map((serverGroup) => {
    const local = localById.get(serverGroup.id);
    const started = epochAtFetch[serverGroup.id] ?? 0;
    const now = localEpoch[serverGroup.id] ?? 0;
    if (local && now > started) return local;
    return serverGroup;
  });
}

function withMascotMotion(
  state: AppState,
  botId: string,
  kind: Exclude<BotMotion, "none">,
): AppState {
  return {
    ...state,
    mascotMotion: {
      botId,
      nonce: (state.mascotMotion?.nonce ?? 0) + 1,
      kind,
    },
  };
}

function patchCard(state: AppState, botId: string, messageId: string, patch: Partial<OptionCardData>): AppState {
  return updateBot(state, botId, (b) => ({
    ...b,
    messages: b.messages.map((m) =>
      m.id === messageId && m.card ? { ...m, card: { ...m.card, ...patch } } : m,
    ),
  }));
}

/** First-run quiz still sitting on this bot's thread. */
function openOnboardingCard(bot: Bot): Message | undefined {
  return bot.messages.find(
    (message) => message.kind === "options" && message.card && !message.card.requestId && !message.card.dismissed,
  );
}

function dismissOnboardingCard(state: AppState, botId: string): AppState {
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const quiz = bot ? openOnboardingCard(bot) : undefined;
  return quiz ? patchCard(state, botId, quiz.id, { dismissed: true }) : state;
}

/** Sticky top-bar 502 from the attached-UI shim.  Clear it once the harness answers. */
export function isHarnessUnreachableError(message: string | null | undefined): boolean {
  return typeof message === "string" && /harness on port \d+ is not reachable/i.test(message);
}

/** Scrollback flags straight off a hydrate payload.  The server answers
 * `hasMore` per conversation whenever the request asked for a page; a full
 * response omits it, which reads as "nothing older to fetch". */
function hydratedHasMore(
  bots: Array<{ threadId: string; hasMore?: boolean }>,
  groups: Array<{ threadId: string; hasMore?: boolean }>,
): AppState["hasMore"] {
  const flags: AppState["hasMore"] = {};
  for (const conversation of [...bots, ...groups]) {
    if (conversation?.threadId) flags[conversation.threadId] = conversation.hasMore === true;
  }
  return flags;
}

/** Put an older page in front of what is already loaded, dropping anything
 * the client already holds.  A page can overlap the tail after an edit
 * rewrote ids, and a duplicated message would render twice and break the
 * parentId walk. */
export function prependEarlier(current: Message[], earlier: Message[]): Message[] {
  const known = new Set(current.map((message) => message.id));
  const fresh = earlier.filter((message) => !known.has(message.id));
  return fresh.length ? [...fresh, ...current] : current;
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "hydrate": {
      const known = (id: string) => action.bots.some((b) => b.id === id) || action.groups.some((g) => g.id === id);
      const selectedId =
        state.selectedId && known(state.selectedId) ? state.selectedId : (action.bots[0]?.id ?? "");
      return {
        ...state,
        bots: mergeHydrateBots(
          state.bots,
          action.bots,
          action.overlays ?? {},
          state.botEpoch,
          action.botEpochAtFetch ?? {},
        ),
        groups: mergeHydrateGroups(
          state.groups,
          action.groups,
          state.groupEpoch,
          action.groupEpochAtFetch ?? {},
        ),
        computerControl: action.computerControl,
        selectedId,
        error: isHarnessUnreachableError(state.error) ? null : state.error,
        // a fresh hydrate replaces the whole picture, scrollback included:
        // carrying the old flags over would leave a pill promising a page
        // for a thread the server just sent in full
        hasMore: hydratedHasMore(action.bots, action.groups),
        loadingEarlier: {},
      };
    }
    // an effect-only action: the wrapper fetches, and `earlierLoaded` lands
    // the page.  Listed so the reducer stays exhaustive.
    case "loadEarlier":
      return state;
    case "earlierLoading":
      return { ...state, loadingEarlier: { ...state.loadingEarlier, [action.threadId]: true } };
    case "earlierLoaded": {
      const loadingEarlier = { ...state.loadingEarlier };
      delete loadingEarlier[action.threadId];
      const hasMore = { ...state.hasMore, [action.threadId]: action.hasMore };
      if (!action.messages.length) return { ...state, loadingEarlier, hasMore };
      return {
        ...state,
        loadingEarlier,
        hasMore,
        bots: state.bots.map((bot) =>
          bot.threadId === action.threadId
            ? { ...bot, messages: prependEarlier(bot.messages, action.messages) }
            : bot,
        ),
        groups: state.groups.map((group) =>
          group.threadId === action.threadId
            ? { ...group, messages: prependEarlier(group.messages, action.messages) }
            : group,
        ),
      };
    }
    case "showRoutines":
      return {
        ...state,
        activeView: "routines",
        selectedRoutineId: action.routineId ?? null,
        settingsOpen: false,
        computerOpen: false,
        inspectorOpen: false,
        appSettingsOpen: false,
        pluginsOpen: false,
      };
    case "showTeamMap":
      return {
        ...state,
        activeView: "team-map",
        settingsOpen: false,
        computerOpen: false,
        inspectorOpen: false,
        appSettingsOpen: false,
        pluginsOpen: false,
      };
    case "showSkillRecorder":
      if (!skillRecorderEnabled(state.config)) return state;
      return {
        ...state,
        activeView: "skill-recorder",
        settingsOpen: false,
        computerOpen: false,
        inspectorOpen: false,
        appSettingsOpen: false,
        pluginsOpen: false,
      };
    case "routinesHydrated":
      return { ...state, routines: action.routines, routineRuns: action.runs };
    case "routinePatched": {
      const exists = state.routines.some((routine) => routine.id === action.routine.id);
      return {
        ...state,
        routines: exists
          ? state.routines.map((routine) => (routine.id === action.routine.id ? action.routine : routine))
          : [action.routine, ...state.routines],
      };
    }
    case "routineDeleted":
      return { ...state, routines: state.routines.filter((routine) => routine.id !== action.routineId) };
    case "routineRunPatched": {
      const exists = state.routineRuns.some((run) => run.id === action.run.id);
      const runs = exists
        ? state.routineRuns.map((run) => (run.id === action.run.id ? action.run : run))
        : [action.run, ...state.routineRuns];
      return { ...state, routineRuns: runs.sort((a, b) => b.scheduledFor - a.scheduledFor) };
    }
    case "webhooksHydrated":
      return { ...state, webhooks: action.webhooks, webhookAttempts: action.attempts, webhookIngress: action.ingress };
    case "webhookPatched": {
      const exists = state.webhooks.some((webhook) => webhook.id === action.webhook.id);
      return {
        ...state,
        webhooks: exists
          ? state.webhooks.map((webhook) => (webhook.id === action.webhook.id ? action.webhook : webhook))
          : [action.webhook, ...state.webhooks],
      };
    }
    case "webhookDeleted":
      return {
        ...state,
        webhooks: state.webhooks.filter((webhook) => webhook.id !== action.webhookId),
        webhookAttempts: state.webhookAttempts.filter((attempt) => attempt.webhookId !== action.webhookId),
      };
    case "resourceTriggersHydrated":
      return { ...state, resourceTriggers: action.triggers };
    case "resourceTriggerPatched": {
      const exists = state.resourceTriggers.some((trigger) => trigger.id === action.trigger.id);
      return {
        ...state,
        resourceTriggers: exists
          ? state.resourceTriggers.map((trigger) => (trigger.id === action.trigger.id ? action.trigger : trigger))
          : [action.trigger, ...state.resourceTriggers],
      };
    }
    case "resourceTriggerDeleted":
      return { ...state, resourceTriggers: state.resourceTriggers.filter((trigger) => trigger.id !== action.triggerId) };
    case "webhookAttempted": {
      const attempts = state.webhookAttempts.some((attempt) => attempt.id === action.attempt.id)
        ? state.webhookAttempts.map((attempt) => attempt.id === action.attempt.id ? action.attempt : attempt)
        : [...state.webhookAttempts, action.attempt];
      return { ...state, webhookAttempts: attempts.slice(-2_000) };
    }
    case "groupPatched": {
      const exists = state.groups.some((g) => g.id === action.group.id);
      const groups = exists
        ? state.groups.map((g) => (g.id === action.group.id ? { ...g, ...action.group, messages: action.group.messages ?? g.messages } : g))
        : [{ ...(action.group as Group), messages: action.group.messages ?? [] }, ...state.groups];
      return { ...state, groups };
    }
    case "groupDeleted": {
      const groups = state.groups.filter((g) => g.id !== action.groupId);
      const selectedId = state.selectedId === action.groupId ? (state.bots[0]?.id ?? "") : state.selectedId;
      return { ...state, groups, selectedId };
    }
    case "instances":
      return { ...state, instances: action.instances };
    case "configStatus":
      return {
        ...state,
        config: action.config,
        activeView:
          state.activeView === "skill-recorder" && !skillRecorderEnabled(action.config)
            ? "chat"
            : state.activeView,
      };
    case "select": {
      if (state.groups.some((g) => g.id === action.id)) {
        const wasUnread = state.groups.find((g) => g.id === action.id)?.unread;
        return {
          ...state,
          activeView: "chat",
          selectedId: action.id,
          groups: state.groups.map((g) => (g.id === action.id ? { ...g, unread: false } : g)),
          groupEpoch: wasUnread ? bumpEpoch(state.groupEpoch, action.id) : state.groupEpoch,
        };
      }
      const wasUnread = state.bots.find((b) => b.id === action.id)?.unread;
      const next = updateBot(
        withMascotMotion({ ...state, activeView: "chat", selectedId: action.id }, action.id, "switch"),
        action.id,
        (b) => ({ ...b, unread: false }),
      );
      return wasUnread ? { ...next, botEpoch: bumpEpoch(next.botEpoch, action.id) } : next;
    }
    // optimistic card settle; the server's message.patch confirms it later
    case "answerCard": {
      const bot = state.bots.find((candidate) => candidate.id === action.botId);
      const card = bot?.messages.find((message) => message.id === action.messageId)?.card;
      return withMascotMotion(
        patchCard(state, action.botId, action.messageId, {
          answered: action.answer,
          // talking past the first-run quiz hides it; live asks stay until resolved
          ...(card?.requestId ? {} : { dismissed: true }),
        }),
        action.botId,
        "working",
      );
    }
    case "dismissCard":
      return patchCard(state, action.botId, action.messageId, { dismissed: true });
    case "decideRequest":
      return state; // the server's request.resolved patch settles the card
    case "botAdded":
      return withMascotMotion({
        ...state,
        // An HTTP create/import response and its SSE broadcast can race. Fold
        // both paths without ever showing the same bot twice.
        bots: [action.bot, ...state.bots.filter((bot) => bot.id !== action.bot.id)],
        activeView: "chat",
        selectedId: action.bot.id,
      }, action.bot.id, "arrive");
    case "deleteBot": {
      const bots = state.bots.filter((b) => b.id !== action.botId);
      const selectedId =
        state.selectedId === action.botId ? (bots.find((b) => !b.hidden)?.id ?? bots[0]?.id ?? "") : state.selectedId;
      return { ...state, bots, selectedId };
    }
    case "markUnread": {
      const next = updateBot(withMascotMotion(state, action.botId, "surprise"), action.botId, (b) => ({ ...b, unread: true }));
      return { ...next, botEpoch: bumpEpoch(next.botEpoch, action.botId) };
    }
    case "botPatched": {
      const before = state.bots.find((b) => b.id === action.bot.id);
      // Bot frames are complete except for their transcript. An unknown one
      // was created by another client (the phone, another app window, or a
      // team import), so add it now; the following message frames will fill
      // its greeting without waiting for a full-page hydration.
      if (!before) {
        return {
          ...state,
          bots: [{ ...action.bot, messages: action.bot.messages ?? [] }, ...state.bots],
        };
      }
      const kind =
        action.bot.unread && !before?.unread
          ? "surprise"
          : action.bot.busy === true && !before?.busy
            ? "working"
            : action.bot.busy === false && before?.busy
              ? "celebrate"
              : null;
      const animated = kind ? withMascotMotion(state, action.bot.id, kind) : state;
      const next = action.bot.chiefOfStaff
        ? {
            ...animated,
            bots: animated.bots.map((b) =>
              b.id === action.bot.id || (b.section?.trim() || "") !== (action.bot.section?.trim() || "")
                ? b
                : { ...b, chiefOfStaff: false },
            ),
          }
        : animated;
      const switchedThread =
        typeof action.bot.threadId === "string" && action.bot.threadId !== before.threadId;
      return updateBot(next, action.bot.id, (b) => ({
        ...b,
        ...action.bot,
        // Ordinary bot patches omit messages and must preserve the current
        // transcript. A task switch is different: its full bot event carries
        // the new transcript, which must replace the previous task before the
        // webhook's streamed messages begin arriving.
        messages:
          switchedThread && Array.isArray(action.bot.messages)
            ? action.bot.messages
            : b.messages,
      }));
    }
    case "messageAdded": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) {
        // room thread — plain linear append, no branching/mascot machinery
        const group = state.groups.find((g) => g.threadId === action.threadId);
        if (!group) return state;
        if (group.messages.some((m) => m.id === action.message.id)) return state;
        return {
          ...state,
          groups: state.groups.map((g) =>
            g.id === group.id ? { ...g, messages: [...g.messages, action.message] } : g,
          ),
        };
      }
      // every server-side append chains onto (and becomes) the active leaf
      const next = updateBot(state, bot.id, (b) => {
        if (b.messages.some((m) => m.id === action.message.id)) {
          return { ...b, activeLeafId: action.message.id };
        }
        let messages = [...b.messages, action.message];
        // base64 screen frames are big; a long computer-use session would
        // grow memory without bound. Keep the newest few frames' pixels and
        // strip the rest (the message row survives as a placeholder).
        if (action.message.kind === "screen") {
          const withPng = messages.filter((m) => m.kind === "screen" && m.png);
          const excess = withPng.length - MAX_KEPT_SCREEN_FRAMES;
          if (excess > 0) {
            const dropIds = new Set(withPng.slice(0, excess).map((m) => m.id));
            messages = messages.map((m) => (dropIds.has(m.id) ? { ...m, png: undefined } : m));
          }
        }
        return { ...b, messages, activeLeafId: action.message.id };
      });
      const motion =
        action.message.kind === "options"
          ? "thinking"
          : action.message.kind === "activity"
            ? action.message.tool?.ok === false
              ? "failure"
              : action.message.tool?.ok === true
                ? "success"
                : "working"
            : action.message.role === "bot" && action.message.kind === "text"
              ? "blink"
              : null;
      const animated = motion ? withMascotMotion(next, bot.id, motion) : next;
      return animated;
    }
    case "messagePatched": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) {
        const group = state.groups.find((g) => g.threadId === action.threadId);
        if (!group) return state;
        return {
          ...state,
          groups: state.groups.map((g) =>
            g.id === group.id
              ? { ...g, messages: g.messages.map((m) => (m.id === action.message.id ? action.message : m)) }
              : g,
          ),
        };
      }
      const motion =
        action.message.kind === "activity"
          ? action.message.tool?.ok === false
            ? "failure"
            : action.message.tool?.ok === true
              ? "success"
              : "working"
          : null;
      const next = motion ? withMascotMotion(state, bot.id, motion) : state;
      return updateBot(next, bot.id, (b) => ({
        ...b,
        messages: b.messages.map((m) => (m.id === action.message.id ? action.message : m)),
      }));
    }
    case "screenFrame":
      return {
        ...withMascotMotion(state, action.botId, "success"),
        screens: { ...state.screens, [action.botId]: { png: action.png, mime: action.mime } },
        provisioning: { ...state.provisioning, [action.botId]: false },
      };
    case "provisioning":
      return {
        ...(action.on ? withMascotMotion(state, action.botId, "launch") : state),
        provisioning: { ...state.provisioning, [action.botId]: action.on },
      };
    case "computerControl":
      return {
        ...state,
        computerControl: {
          ...state.computerControl,
          [action.botId]: { held: action.held, helpReason: action.helpReason },
        },
      };
    case "setModel": {
      const next = updateBot(state, action.botId, (b) => ({ ...b, modelSelection: action.selection }));
      return { ...next, botEpoch: bumpEpoch(next.botEpoch, action.botId) };
    }
    case "connected":
      return {
        ...state,
        connected: action.value,
        // A 502 from the UI shim sticks in `error` even after the always-on
        // harness answers again.  SSE open (or a later hydrate) is proof
        // the banner is stale.
        error: action.value && isHarnessUnreachableError(state.error) ? null : state.error,
      };
    case "hydrationStarted":
      return { ...state, hydration: { status: "loading", error: null, retryAt: null } };
    case "hydrationReady":
      return { ...state, hydration: { status: "ready", error: null, retryAt: null } };
    case "hydrationFailed":
      return {
        ...state,
        hydration: { status: "failed", error: action.message, retryAt: action.retryAt },
      };
    case "error":
      return {
        ...(action.message && state.selectedId
          ? withMascotMotion(state, state.selectedId, "alert")
          : state),
        error: action.message,
      };
    // bot settings, the computer panel, and app settings share the right slot
    case "toggleSettings": {
      const open = action.open ?? !state.settingsOpen;
      return {
        ...state,
        settingsOpen: open,
        computerOpen: open ? false : state.computerOpen,
        inspectorOpen: open ? false : state.inspectorOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "togglePlugins":
      return { ...state, pluginsOpen: action.open ?? !state.pluginsOpen };
    case "focusMessage":
      return {
        ...state,
        focusMessage: {
          threadId: action.threadId,
          messageId: action.messageId,
          nonce: (state.focusMessage?.nonce ?? 0) + 1,
          consumed: false,
        },
      };
    case "focusMessageConsumed":
      if (!state.focusMessage || state.focusMessage.nonce !== action.nonce) return state;
      return { ...state, focusMessage: { ...state.focusMessage, consumed: true } };
    case "toggleComputer": {
      const open = action.open ?? !state.computerOpen;
      return {
        ...state,
        computerOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        inspectorOpen: open ? false : state.inspectorOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "toggleInspector": {
      const open = action.open ?? !state.inspectorOpen;
      return {
        ...state,
        inspectorOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "toggleAppSettings": {
      const open = action.open ?? !state.appSettingsOpen;
      return {
        ...state,
        appSettingsOpen: open,
        appSettingsSection: action.section ?? state.appSettingsSection,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        inspectorOpen: open ? false : state.inspectorOpen,
        pluginsOpen: open ? false : state.pluginsOpen,
      };
    }
    case "updateBot": {
      const mascotChanged =
        Object.prototype.hasOwnProperty.call(action.patch, "color") ||
        Object.prototype.hasOwnProperty.call(action.patch, "mascotExpression");
      const animated = mascotChanged
        ? withMascotMotion(state, action.botId, "customize")
        : state;
      const target = animated.bots.find((bot) => bot.id === action.botId);
      const chiefSection = (action.patch.section ?? target?.section)?.trim() || "";
      const next = action.patch.chiefOfStaff
        ? {
            ...animated,
            bots: animated.bots.map((b) =>
              b.id === action.botId || (b.section?.trim() || "") !== chiefSection
                ? b
                : { ...b, chiefOfStaff: false },
            ),
          }
        : animated;
      const { acknowledgeLocalAuto: _ack, ...botPatch } = action.patch;
      const patched = updateBot(next, action.botId, (b) => ({ ...b, ...botPatch }));
      return { ...patched, botEpoch: bumpEpoch(patched.botEpoch, action.botId) };
    }
    case "threadActive": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return state;
      return updateBot(state, bot.id, (b) => ({
        ...b,
        activeLeafId: action.activeLeafId,
      }));
    }
    // optimistic leaf move; the server's thread frame confirms it later
    case "switchBranch": {
      const bot = state.bots.find((b) => b.id === action.botId);
      if (!bot) return state;
      let cur = action.messageId;
      for (;;) {
        const children = bot.messages.filter((m) => m.parentId === cur);
        if (!children.length) break;
        cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
      }
      return updateBot(state, action.botId, (b) => ({ ...b, activeLeafId: cur }));
    }
    // optimistic room edits; the server's group frame confirms them later
    case "patchGroup":
      return {
        ...state,
        groups: state.groups.map((g) => (g.id === action.groupId ? { ...g, ...action.patch } : g)),
        groupEpoch: bumpEpoch(state.groupEpoch, action.groupId),
      };
    case "toggleReaction": {
      const toggle = (m: Message): Message => {
        if (m.id !== action.messageId) return m;
        const reactions = m.reactions ?? [];
        const at = reactions.findIndex((r) => r.emoji === action.emoji && r.by === "user");
        const next = at >= 0 ? reactions.filter((_, i) => i !== at) : [...reactions, { emoji: action.emoji, by: "user" }];
        return { ...m, reactions: next.length ? next : undefined };
      };
      return {
        ...state,
        bots: state.bots.map((b) =>
          b.threadId === action.threadId ? { ...b, messages: b.messages.map(toggle) } : b,
        ),
        groups: state.groups.map((g) =>
          g.threadId === action.threadId ? { ...g, messages: g.messages.map(toggle) } : g,
        ),
      };
    }
    // handled entirely by the async wrapper
    case "pendingQueued": {
      if (state.consumedQueueIds[action.queueId]) {
        const consumedQueueIds = { ...state.consumedQueueIds };
        delete consumedQueueIds[action.queueId];
        return { ...state, consumedQueueIds };
      }
      const prev = state.pendingQueued[action.threadId] ?? [];
      if (prev.some((entry) => entry.queueId === action.queueId)) return state;
      return {
        ...state,
        pendingQueued: {
          ...state.pendingQueued,
          [action.threadId]: [
            ...prev,
            {
              queueId: action.queueId,
              text: action.text,
              // Stamp once at remember-time; ChatView must not remint Date.now().
              at: action.at ?? Date.now(),
            },
          ],
        },
      };
    }
    case "consumePendingQueued": {
      const prev = state.pendingQueued[action.threadId] ?? [];
      const at = prev.findIndex((entry) => entry.queueId === action.queueId);
      if (at < 0) {
        return {
          ...state,
          consumedQueueIds: rememberConsumedQueueId(state.consumedQueueIds, action.queueId),
        };
      }
      const rest = prev.filter((_, i) => i !== at);
      const pendingQueued = { ...state.pendingQueued };
      if (rest.length) pendingQueued[action.threadId] = rest;
      else delete pendingQueued[action.threadId];
      return { ...state, pendingQueued };
    }
    case "cancelQueued": {
      const bot = state.bots.find((candidate) => candidate.id === action.botId);
      if (!bot) return state;
      const prev = state.pendingQueued[bot.threadId] ?? [];
      const rest = prev.filter((entry) => entry.queueId !== action.queueId);
      if (rest.length === prev.length) return state;
      const pendingQueued = { ...state.pendingQueued };
      if (rest.length) pendingQueued[bot.threadId] = rest;
      else delete pendingQueued[bot.threadId];
      return { ...state, pendingQueued };
    }
    case "send":
      return withMascotMotion(dismissOnboardingCard(state, action.botId), action.botId, "working");
    case "editMessage":
      return withMascotMotion(state, action.botId, "working");
    case "newTask":
    case "switchTask":
    case "deleteTask":
    case "newGroupTask":
    case "switchGroupTask":
    case "deleteGroupTask":
      return state;
    case "renameTask":
      return updateBot(state, action.botId, (bot) => ({
        ...bot,
        tasks: (bot.tasks ?? []).map((task) =>
          task.threadId === action.threadId ? { ...task, title: action.title } : task,
        ),
      }));
    // Paint the snooze at once.  The harness answers with the same state and
    // an SSE frame overwrites this, but a row that only dims a round trip
    // later reads as a menu that did nothing.
    case "snoozeTask":
      return updateBot(state, action.botId, (bot) => ({
        ...bot,
        tasks: (bot.tasks ?? []).map((task) => {
          if (task.threadId !== action.threadId) return task;
          const { snoozedUntil: _asleep, ...awake } = task;
          return action.snoozedUntil === null ? awake : { ...task, snoozedUntil: action.snoozedUntil };
        }),
      }));
    case "renameGroupTask":
      return {
        ...state,
        groups: state.groups.map((group) =>
          group.id === action.groupId
            ? {
                ...group,
                tasks: (group.tasks ?? []).map((task) =>
                  task.threadId === action.threadId ? { ...task, title: action.title } : task,
                ),
              }
            : group,
        ),
      };
    case "moveGroupTask": {
      const moving = (state.groups.find((group) => group.id === action.groupId)?.tasks ?? []).find(
        (task) => task.threadId === action.threadId,
      );
      // A channel keeps its last conversation, and the server enforces that
      // too; refusing here keeps the sidebar honest if the drop is illegal.
      const source = state.groups.find((group) => group.id === action.groupId);
      if (!moving || !source || (source.tasks ?? []).length < 2) return state;
      return {
        ...state,
        groups: state.groups.map((group) => {
          if (group.id === action.groupId) {
            const remaining = (group.tasks ?? []).filter(
              (task) => task.threadId !== action.threadId,
            );
            return {
              ...group,
              tasks: remaining,
              // The channel was showing the one that left, so show the next.
              threadId: group.threadId === action.threadId ? remaining[0]!.threadId : group.threadId,
            };
          }
          if (group.id === action.toGroupId) {
            return { ...group, tasks: [moving, ...(group.tasks ?? [])] };
          }
          return group;
        }),
      };
    }
    case "moveGroupTaskToBot": {
      const source = state.groups.find((group) => group.id === action.groupId);
      const moving = (source?.tasks ?? []).find((task) => task.threadId === action.threadId);
      if (!moving || !source || (source.tasks ?? []).length < 2) return state;
      return {
        ...state,
        groups: state.groups.map((group) => {
          if (group.id !== action.groupId) return group;
          const remaining = (group.tasks ?? []).filter((task) => task.threadId !== action.threadId);
          return {
            ...group,
            tasks: remaining,
            threadId: group.threadId === action.threadId ? remaining[0]!.threadId : group.threadId,
          };
        }),
        bots: state.bots.map((bot) =>
          bot.id === action.botId
            ? {
                ...bot,
                tasks: [
                  { threadId: moving.threadId, title: moving.title, createdAt: moving.createdAt },
                  ...(bot.tasks ?? []),
                ],
              }
            : bot,
        ),
      };
    }
    case "mergeTasks": {
      const source = state.bots.find((bot) => bot.id === action.botId);
      if (!source || action.threadId === action.intoThreadId || (source.tasks ?? []).length < 2) return state;
      const remaining = (source.tasks ?? []).filter((task) => task.threadId !== action.threadId);
      if (remaining.length === (source.tasks ?? []).length) return state;
      if (!remaining.some((task) => task.threadId === action.intoThreadId)) return state;
      return {
        ...state,
        bots: state.bots.map((bot) =>
          bot.id === action.botId
            ? {
                ...bot,
                tasks: remaining,
                threadId: bot.threadId === action.threadId ? action.intoThreadId : bot.threadId,
              }
            : bot,
        ),
      };
    }
    case "moveTaskToBot": {
      const source = state.bots.find((bot) => bot.id === action.botId);
      const moving = (source?.tasks ?? []).find((task) => task.threadId === action.threadId);
      if (!moving || !source || (source.tasks ?? []).length < 2) return state;
      return {
        ...state,
        bots: state.bots.map((bot) => {
          if (bot.id === action.botId) {
            const remaining = (bot.tasks ?? []).filter((task) => task.threadId !== action.threadId);
            return {
              ...bot,
              tasks: remaining,
              threadId: bot.threadId === action.threadId ? remaining[0]!.threadId : bot.threadId,
            };
          }
          if (bot.id === action.toBotId) return { ...bot, tasks: [moving, ...(bot.tasks ?? [])] };
          return bot;
        }),
      };
    }
    case "moveTaskToGroup": {
      const source = state.bots.find((bot) => bot.id === action.botId);
      const moving = (source?.tasks ?? []).find((task) => task.threadId === action.threadId);
      if (!moving || !source || (source.tasks ?? []).length < 2) return state;
      return {
        ...state,
        bots: state.bots.map((bot) => {
          if (bot.id !== action.botId) return bot;
          const remaining = (bot.tasks ?? []).filter((task) => task.threadId !== action.threadId);
          return {
            ...bot,
            tasks: remaining,
            threadId: bot.threadId === action.threadId ? remaining[0]!.threadId : bot.threadId,
          };
        }),
        groups: state.groups.map((group) =>
          group.id === action.toGroupId
            ? {
                ...group,
                tasks: [
                  { threadId: moving.threadId, title: moving.title, createdAt: moving.createdAt },
                  ...(group.tasks ?? []),
                ],
              }
            : group,
        ),
      };
    }
    case "taskSwitched":
      return updateBot(state, action.bot.id, (bot) => ({ ...bot, ...action.bot, messages: action.bot.messages ?? [] }));
    case "newBot":
    case "duplicateBot":
    case "interrupt":
    case "createGroup":
    case "sendGroup":
    case "deleteGroup":
    case "interruptGroup":
    case "createRoutine":
    case "updateRoutine":
    case "deleteRoutine":
    case "runRoutine":
    case "cancelRoutineRun":
    case "markRoutineRunSeen":
      return state;
  }
}

/** Newest screen frames whose pixels stay in memory per thread. */
const MAX_KEPT_SCREEN_FRAMES = 8;

export const initialState: AppState = {
  bots: [],
  groups: [],
  instances: [],
  config: null,
  selectedId: "",
  activeView: "chat",
  selectedRoutineId: null,
  routines: [],
  routineRuns: [],
  webhooks: [],
  webhookAttempts: [],
  webhookIngress: null,
  resourceTriggers: [],
  settingsOpen: false,
  pluginsOpen: false,
  computerOpen: false,
  inspectorOpen: false,
  appSettingsOpen: false,
  appSettingsSection: "general",
  screens: {},
  provisioning: {},
  computerControl: {},
  focusMessage: null,
  connected: false,
  hydration: { status: "idle", error: null, retryAt: null },
  error: null,
  mascotMotion: null,
  pendingQueued: {},
  consumedQueueIds: {},
  botEpoch: {},
  groupEpoch: {},
  hasMore: {},
  loadingEarlier: {},
};

// ── API client ─────────────────────────────────────────────────────────
/** Thrown by `api()` on a non-2xx response.  Carries the parsed JSON body
 * alongside `.message`, so a caller that needs more than the error string —
 * apply-defaults' `needsAcknowledgement` list is the first one — does not
 * have to re-fetch or duplicate this function's request/parse logic. */
export class ApiError extends Error {
  readonly body: any;
  constructor(message: string, body: any) {
    super(message);
    this.name = "ApiError";
    this.body = body;
  }
}

export async function api(path: string, init?: RequestInit): Promise<any> {
  const method = (init?.method ?? "GET").toUpperCase();
  const retryable = method === "GET" || method === "HEAD";
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < (retryable ? 2 : 1); attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 200));
    const res = await fetch(path, {
      headers: { "content-type": "application/json" },
      ...init,
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    lastError = new ApiError(body.error ?? `${res.status} ${res.statusText}`, body);
    if (res.status !== 502) break;
  }
  throw lastError ?? new Error("request failed");
}

/** One row per mapped credential, as `GET /api/infisical/status` returns it
 * (`server/index.ts`'s `secretFieldRows()`).  `value` is the plaintext only
 * for the handful of fields that are identifiers rather than secrets — every
 * `secret: true` row carries `null` here, in every state. */
export interface SecretFieldRow {
  id: string;
  label: string;
  section: string;
  secret: boolean;
  infisicalName: string;
  inVault: boolean;
  source: "infisical" | "env" | "file" | "none";
  /** A file outside BotFleet that holds this value when nothing BotFleet
   * manages does — `~/.mmx/config.json` for the MiniMax key.  Server-probed;
   * null whenever a managed source already has the value. */
  elsewhere?: string | null;
  hasValue: boolean;
  hasLocalCopy: boolean;
  managed: boolean;
  value: string | null;
}

/** Loopback-only: project id, site URL and the vault's own names — the
 * fields `GET /api/config`'s `infisical` block deliberately omits — live
 * only in this response. */
export interface InfisicalStatusPayload {
  infisical: {
    configured: boolean;
    enabled: boolean;
    writeThrough: boolean;
    source: "env" | "config" | "none";
    siteUrl: string | null;
    projectId: string | null;
    environment: string;
    secretPath: string;
    hasClientId: boolean;
    hasClientSecret: boolean;
    refreshMinutes: number;
    lastSyncAt: string | null;
    lastAttemptAt: string | null;
    lastSyncMs: number | null;
    lastError: string | null;
    stale: boolean;
    pendingProviderReload: boolean;
    vaultCount: number;
    vaultNames: string[];
    appliedCount: number;
    appliedFields: string[];
    unusedVaultNames: string[];
  };
  fields: SecretFieldRow[];
}

export function fetchSecrets(): Promise<InfisicalStatusPayload> {
  return api("/api/infisical/status");
}

/** Where every mapped credential came from, as of the last fetch — the
 * per-field badge next to a Composio key, a Usage Monitor token, or a Bot RAG
 * connection reads this instead of each polling `/api/infisical/status` on
 * its own. Empty until the first fetch resolves, which reads as "unknown"
 * everywhere a caller checks the map rather than throwing. */
/** One provenance row per mapped credential, keyed by `SecretFieldSpec.id`.
 * `elsewhere` travels with it: a field whose only value lives in a file the
 * driver reads on its own (`~/.mmx/config.json`) has to be nameable wherever
 * a badge is rendered, or a row says "Not set" beside an engine whose turns
 * visibly work. */
export interface SecretSourceRow {
  source: SecretFieldRow["source"];
  managed: boolean;
  infisicalName: string;
  elsewhere: string | null;
}

export function useSecretSources(): Map<string, SecretSourceRow> {
  const [rows, setRows] = useState<SecretFieldRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchSecrets()
      .then((data) => {
        if (!cancelled && Array.isArray(data?.fields)) setRows(data.fields);
      })
      .catch(() => {
        // A window without loopback access (or a very old harness) simply
        // sees no badges — the same fail-quiet the rest of this file uses
        // for every best-effort background fetch.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(
    () =>
      new Map(
        rows.map((row) => [
          row.id,
          {
            source: row.source,
            managed: row.managed,
            infisicalName: row.infisicalName,
            elsewhere: row.elsewhere ?? null,
          },
        ]),
      ),
    [rows],
  );
}

/** Per-frame stream state lives in its OWN context: token frames update only
 * the components that read this hook (the chat's streaming tail), while every
 * useStore consumer — sidebar, mascots, pickers, the settled transcript —
 * keeps its render tree untouched during a stream. */
interface StreamState {
  /** in-flight assistant text per threadId */
  streaming: Record<string, string>;
  /** in-flight extended thinking per threadId (ephemeral) */
  reasoning: Record<string, string>;
}
const EMPTY_STREAM: StreamState = { streaming: {}, reasoning: {} };
const StreamContext = createContext<StreamState>(EMPTY_STREAM);

export function useStreaming() {
  return useContext(StreamContext);
}

const StoreContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
  /** Commit any debounced profile edits before an operation reads the bot. */
  flushBotPatches: (botId: string) => Promise<void>;
  /** Re-fetch engine availability — after an install, without a restart.
   * `fresh: true` bypasses the server's describe() memo (see the impl). */
  refreshInstances: (opts?: { fresh?: boolean }) => Promise<void>;
} | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  // per-frame stream-delta batching (see the "runtime" SSE case); stream
  // state is intentionally OUTSIDE the reducer so token frames re-render
  // only StreamContext consumers
  const [stream, setStream] = useState<StreamState>(EMPTY_STREAM);
  const deltaBuffer = useRef(new Map<string, { text: string; reasoning: string }>());
  const deltaFlush = useRef<number | null>(null);
  const clearStream = (threadId: string) => {
    // Drop the thread's un-flushed deltas too: the settled message that
    // triggered this clear already contains them. Without this, the pending
    // rAF re-creates a "ghost" stream bubble holding the tail fragment —
    // it renders below any card/chip that settled next (so a permission
    // card looks glued to the top), keeps the caret blinking while the bot
    // is actually waiting, and the next block's deltas append onto the
    // duplicated tail instead of starting a fresh bubble.
    deltaBuffer.current.delete(threadId);
    setStream((prev) => {
      if (!(threadId in prev.streaming) && !(threadId in prev.reasoning)) return prev;
      const { [threadId]: _s, ...streaming } = prev.streaming;
      const { [threadId]: _r, ...reasoning } = prev.reasoning;
      return { streaming, reasoning };
    });
  };
  const flushDeltas = () => {
    if (deltaFlush.current !== null) {
      cancelAnimationFrame(deltaFlush.current);
      deltaFlush.current = null;
    }
    const buf = deltaBuffer.current;
    if (buf.size === 0) return;
    const entries = [...buf];
    buf.clear();
    setStream((prev) => {
      const streaming = { ...prev.streaming };
      const reasoning = { ...prev.reasoning };
      for (const [threadId, d] of entries) {
        if (d.text) streaming[threadId] = (streaming[threadId] ?? "") + d.text;
        if (d.reasoning) reasoning[threadId] = (reasoning[threadId] ?? "") + d.reasoning;
      }
      return { streaming, reasoning };
    });
  };

  const botPatchQueue = useMemo(
    () =>
      createBotPatchQueue({
        send: async (botId, patch, signal) => {
          const result: { bot: BotAnnouncement } = await api(`/api/bots/${botId}`, {
            method: "PATCH",
            body: JSON.stringify(patch),
            signal,
          });
          return result.bot;
        },
        reconcile: async (botId, signal) => {
          const result: { bots: BotAnnouncement[] } = await api("/api/bots", { signal });
          return result.bots.find((candidate) => candidate.id === botId) ?? null;
        },
        onAuthoritative: (bot, optimisticOverlay) => {
          rawDispatch({ type: "botPatched", bot: { ...bot, ...optimisticOverlay } });
        },
        onError: (error) => {
          rawDispatch({ type: "error", message: error.message });
                  },
      }),
    [],
  );

  useEffect(() => {
    // StrictMode's dev probe runs this cleanup once against the same memoized
    // queue; revive undoes it so profile saves survive development mounts.
    botPatchQueue.revive();
    return () => botPatchQueue.dispose();
  }, [botPatchQueue]);

  const groupPatchGen = useRef<Record<string, number>>({});

  const dispatch = useMemo(() => {
    const showError = (e: unknown) => {
      rawDispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
          };
    // fire-and-forget card persistence; the route is optional server-side
    const persistCard = (botId: string, messageId: string, patch: Partial<OptionCardData>) => {
      fetch(`/api/bots/${botId}/cards/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => {});
    };

    const wrapped: React.Dispatch<Action> = (action) => {
      const botBeforeUpdate =
        action.type === "updateBot" || action.type === "setModel" || action.type === "markUnread"
          ? stateRef.current.bots.find((candidate) => candidate.id === action.botId)
          : action.type === "select"
            ? stateRef.current.bots.find((candidate) => candidate.id === action.id)
            : undefined;
      const groupBeforePatch =
        action.type === "patchGroup"
          ? stateRef.current.groups.find((candidate) => candidate.id === action.groupId)
          : action.type === "select"
            ? stateRef.current.groups.find((candidate) => candidate.id === action.id)
            : undefined;
      const quizBeforeSend = (() => {
        if (action.type !== "send") return undefined;
        const bot = stateRef.current.bots.find((candidate) => candidate.id === action.botId);
        return bot ? openOnboardingCard(bot) : undefined;
      })();
      if (action.type === "deleteBot") botPatchQueue.cancel(action.botId);
      // A queued message is still real until the server confirms deletion.
      // All other actions keep their existing optimistic behavior.
      if (action.type !== "cancelQueued") rawDispatch(action);
      switch (action.type) {
        case "createRoutine":
          api("/api/routines", { method: "POST", body: JSON.stringify(action.input) }).catch(showError);
          break;
        case "updateRoutine":
          api(`/api/routines/${action.routineId}`, {
            method: "PATCH",
            body: JSON.stringify(action.patch),
          }).catch(showError);
          break;
        case "deleteRoutine":
          api(`/api/routines/${action.routineId}`, { method: "DELETE" }).catch(showError);
          break;
        case "runRoutine":
          api(`/api/routines/${action.routineId}/run`, { method: "POST" }).catch(showError);
          break;
        case "cancelRoutineRun":
          api(`/api/routine-runs/${action.runId}/cancel`, { method: "POST" }).catch(showError);
          break;
        case "markRoutineRunSeen":
          api(`/api/routine-runs/${action.runId}/seen`, { method: "POST" }).catch(showError);
          break;
        case "cancelQueued":
          void api(`/api/bots/${action.botId}/queue/${action.queueId}`, { method: "DELETE" })
            .then(() => rawDispatch(action))
            .catch(showError);
          break;
        case "send": {
          // persist through the existing card route so an older server that
          // does not auto-dismiss still hides the quiz on this client
          if (quizBeforeSend) persistCard(action.botId, quizBeforeSend.id, { dismissed: true });
          // Stamp before the POST so a slow 202 still shows send-time, not
          // response-receipt time (Codex P2 on #587).
          const sentAt = Date.now();
          void api(`/api/bots/${action.botId}/messages`, {
            method: "POST",
            body: JSON.stringify({ text: action.text, replyToId: action.replyToId }),
          })
            .then((body) => {
              if (
                body?.queued &&
                typeof body.threadId === "string" &&
                typeof body.queueId === "string"
              ) {
                rawDispatch({
                  type: "pendingQueued",
                  threadId: body.threadId,
                  queueId: body.queueId,
                  text: action.text,
                  at: sentAt,
                });
              }
            })
            .catch(showError);
          break;
        }
        case "editMessage":
          api(`/api/bots/${action.botId}/messages/${action.messageId}/edit`, {
            method: "POST",
            body: JSON.stringify({ text: action.text }),
          }).catch(showError);
          break;
        case "switchBranch":
          api(`/api/bots/${action.botId}/active-branch`, {
            method: "POST",
            body: JSON.stringify({ messageId: action.messageId }),
          }).catch(showError);
          break;
        case "decideRequest": {
          const respond = () =>
            api(`/api/threads/${action.threadId}/respond`, {
              method: "POST",
              body: JSON.stringify({
                requestId: action.requestId,
                behavior: action.behavior,
                message: action.message,
              }),
            }).catch((error) => {
              showError(error);
              action.onError?.(error instanceof Error ? error.message : String(error));
            });
          if (action.alwaysAllow) {
            const bot = stateRef.current.bots.find((b) => b.id === action.alwaysAllow!.botId);
            const next = [...new Set([...(bot?.alwaysAllow ?? []), action.alwaysAllow.key])];
            // save the grant BEFORE releasing the bot: it may ask again
            // within milliseconds, and a grant that hasn't landed yet
            // would make "always allow" ask a second time. A failed save
            // still lets this one through — losing a preference must not
            // strand the turn — but it says so.
            void api(`/api/bots/${action.alwaysAllow.botId}`, {
              method: "PATCH",
              body: JSON.stringify({ alwaysAllow: next }),
            })
              .catch(showError)
              .finally(respond);
            break;
          }
          void respond();
          break;
        }
        case "answerCard": {
          const bot = stateRef.current.bots.find((b) => b.id === action.botId);
          const card = bot?.messages.find((m) => m.id === action.messageId)?.card;
          if (card?.requestId) {
            const behavior =
              action.answer === "Allow" ? "allow" : action.answer === "Deny" ? "deny" : "answer";
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify({
                requestId: card.requestId,
                behavior,
                message: behavior === "answer" ? action.answer : undefined,
              }),
            }).catch(showError);
          } else {
            persistCard(action.botId, action.messageId, { answered: action.answer, dismissed: true });
            api(`/api/bots/${action.botId}/messages`, {
              method: "POST",
              body: JSON.stringify({ text: action.answer }),
            }).catch(showError);
          }
          break;
        }
        case "dismissCard": {
          const bot = stateRef.current.bots.find((b) => b.id === action.botId);
          const card = bot?.messages.find((m) => m.id === action.messageId)?.card;
          if (card?.requestId) {
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify({ requestId: card.requestId, behavior: "deny", message: "Dismissed by user." }),
            }).catch(() => {});
          } else {
            persistCard(action.botId, action.messageId, { dismissed: true });
          }
          break;
        }
        case "newBot":
          api("/api/bots", { method: "POST" })
            .then(({ bot }) => rawDispatch({ type: "botAdded", bot }))
            .catch(showError);
          break;
        case "duplicateBot": {
          const source = stateRef.current.bots.find((b) => b.id === action.botId);
          if (!source) break;
          const duplicateProfile = {
            name: `${source.name} copy`,
            title: source.title,
            description: source.description,
            notifications: source.notifications,
            modelSelection: source.modelSelection,
            computers: source.computers,
            cloudBackend: source.cloudBackend,
            autoStartVps: source.autoStartVps,
            avatarUrl: source.avatarUrl,
            avatarCrop: source.avatarCrop,
          };
          api("/api/bots", { method: "POST" })
            .then(({ bot }) =>
              api(`/api/bots/${bot.id}`, {
                method: "PATCH",
                // JSON.stringify omits undefined optional fields while preserving
                // an explicit null avatar clear, so duplication mirrors the source.
                body: JSON.stringify(duplicateProfile),
              }).then(({ bot: patched }) =>
                rawDispatch({ type: "botAdded", bot: { ...bot, ...patched, messages: bot.messages } }),
              ),
            )
            .catch(showError);
          break;
        }
        case "deleteBot":
          api(`/api/bots/${action.botId}`, { method: "DELETE" }).catch(showError);
          break;
        case "markUnread":
          if (botBeforeUpdate) {
            botPatchQueue.enqueue(action.botId, { unread: true }, botBeforeUpdate);
          }
          break;
        case "select": {
          if (botBeforeUpdate?.unread) {
            botPatchQueue.enqueue(action.id, { unread: false }, botBeforeUpdate);
          } else if (groupBeforePatch?.unread) {
            api(`/api/groups/${action.id}`, { method: "PATCH", body: JSON.stringify({ unread: false }) }).catch(
              (error) => {
                rawDispatch({ type: "groupPatched", group: { id: action.id, unread: true } });
                showError(error);
              },
            );
          }
          break;
        }
        case "createGroup":
          api(`/api/groups`, {
            method: "POST",
            body: JSON.stringify({ memberIds: action.memberIds, name: action.name, section: action.section }),
          })
            .then(({ group }) => {
              rawDispatch({ type: "groupPatched", group });
              rawDispatch({ type: "select", id: group.id });
            })
            .catch(showError);
          break;
        case "sendGroup":
          api(`/api/groups/${action.groupId}/messages`, {
            method: "POST",
            body: JSON.stringify({ text: action.text, replyToId: action.replyToId }),
          }).catch(showError);
          break;
        case "patchGroup": {
          const previous = groupBeforePatch;
          const gen = (groupPatchGen.current[action.groupId] =
            (groupPatchGen.current[action.groupId] ?? 0) + 1);
          api(`/api/groups/${action.groupId}`, {
            method: "PATCH",
            body: JSON.stringify(action.patch),
          }).catch((error) => {
            if (groupPatchGen.current[action.groupId] !== gen) return;
            if (previous) rawDispatch({ type: "groupPatched", group: previous });
            showError(error);
          });
          break;
        }
        case "deleteGroup":
          api(`/api/groups/${action.groupId}`, { method: "DELETE" }).catch(showError);
          break;
        case "toggleReaction":
          api(`/api/threads/${action.threadId}/messages/${action.messageId}/reactions`, {
            method: "POST",
            body: JSON.stringify({ emoji: action.emoji, by: "user" }),
          }).catch(showError);
          break;
        case "setModel":
          if (botBeforeUpdate) {
            botPatchQueue.enqueue(action.botId, { modelSelection: action.selection }, botBeforeUpdate);
          }
          break;
        case "interrupt":
          // The server answers `stopped` — whether a live turn was actually
          // reached.  A Stop that silently matched nothing used to look
          // identical to one that worked, which is how a wedged turn could
          // swallow two minutes of presses without a word.
          api(`/api/bots/${action.botId}/interrupt`, { method: "POST" })
            .then((reply: any) => {
              if (reply && reply.stopped === false) {
                // Two opposite problems, so they must not share a message: a refusal
                // means the engine was asked and would not stop, which is the case
                // this endpoint exists to make visible.
                rawDispatch({
                  type: "error",
                  message: reply.refused
                    ? "The engine refused to stop that turn."
                    : "Nothing was running to stop.",
                });
              }
            })
            .catch(showError);
          break;
        // tasks: the server answers with the bot AND the live transcript,
        // because switching changes which conversation is on screen
        case "newTask":
          api(`/api/bots/${action.botId}/tasks`, { method: "POST", body: "{}" })
            .then((r: any) => r?.bot && dispatch({ type: "taskSwitched", bot: r.bot }))
            .catch(showError);
          break;
        case "switchTask":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, { method: "POST" })
            .then((r: any) => r?.bot && dispatch({ type: "taskSwitched", bot: r.bot }))
            .catch(showError);
          break;
        case "renameTask":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ title: action.title }),
          }).catch(showError);
          break;
        case "snoozeTask":
          // The key has to be present for a wake: the harness reads an
          // absent field as "leave the snooze alone", and JSON.stringify
          // would drop an undefined.
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ snoozedUntil: action.snoozedUntil }),
          }).catch(showError);
          break;
        case "deleteTask":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, { method: "DELETE" })
            .then((r: any) => r?.bot && dispatch({ type: "taskSwitched", bot: r.bot }))
            .catch(showError);
          break;
        // Channel tasks mirror bot tasks, but hydrate the whole channel so
        // switching atomically replaces its transcript, folder and pin.
        case "newGroupTask":
          api(`/api/groups/${action.groupId}/tasks`, { method: "POST", body: "{}" })
            .then((r: any) => r?.group && dispatch({ type: "groupPatched", group: r.group }))
            .catch(showError);
          break;
        case "switchGroupTask":
          api(`/api/groups/${action.groupId}/tasks/${action.threadId}`, { method: "POST" })
            .then((r: any) => r?.group && dispatch({ type: "groupPatched", group: r.group }))
            .catch(showError);
          break;
        case "renameGroupTask":
          api(`/api/groups/${action.groupId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ title: action.title }),
          }).catch(showError);
          break;
        case "moveGroupTask":
          api(`/api/groups/${action.groupId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ groupId: action.toGroupId }),
          }).catch(showError);
          break;
        case "moveGroupTaskToBot":
          api(`/api/groups/${action.groupId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ botId: action.botId }),
          }).catch(showError);
          break;
        case "mergeTasks":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ mergeInto: action.intoThreadId }),
          }).catch(showError);
          break;
        case "moveTaskToBot":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ botId: action.toBotId }),
          }).catch(showError);
          break;
        case "moveTaskToGroup":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ groupId: action.toGroupId }),
          }).catch(showError);
          break;
        case "deleteGroupTask":
          api(`/api/groups/${action.groupId}/tasks/${action.threadId}`, { method: "DELETE" })
            .then((r: any) => r?.group && dispatch({ type: "groupPatched", group: r.group }))
            .catch(showError);
          break;
        case "interruptGroup":
          api(`/api/groups/${action.groupId}/interrupt`, { method: "POST" }).catch(showError);
          break;
        case "updateBot": {
          if (botBeforeUpdate) {
            botPatchQueue.enqueue(action.botId, action.patch, botBeforeUpdate);
          }
          break;
        }
        case "loadEarlier": {
          const current = stateRef.current;
          const conversation =
            current.bots.find((bot) => bot.threadId === action.threadId) ??
            current.groups.find((group) => group.threadId === action.threadId);
          const oldest = conversation?.messages[0]?.id;
          // nothing loaded yet means the hydrate is still in flight; it will
          // bring the tail and the flag, and the pill will be there after
          if (!oldest || current.loadingEarlier[action.threadId]) break;
          rawDispatch({ type: "earlierLoading", threadId: action.threadId });
          api(`/api/threads/${action.threadId}/messages?limit=${PAGE_SIZE}&before=${encodeURIComponent(oldest)}`)
            .then((page: { messages?: Message[]; hasMore?: boolean }) =>
              rawDispatch({
                type: "earlierLoaded",
                threadId: action.threadId,
                messages: page?.messages ?? [],
                hasMore: page?.hasMore === true,
              }),
            )
            // a failed page must not leave the pill spinning forever; the
            // reader can click again
            .catch(() =>
              rawDispatch({ type: "earlierLoaded", threadId: action.threadId, messages: [], hasMore: true }),
            );
          break;
        }
        default:
          break;
      }
    };
    return wrapped;
  }, [botPatchQueue]);

  // ── initial load + SSE fold ──────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const loadAll = async (botEpochAtFetch: Record<string, number>, groupEpochAtFetch: Record<string, number>) => {
      const requests = [
        {
          label: "bots",
          request: api(`/api/bots?messages=${INITIAL_PAGE}`).then(({ bots, groups, computerControl }) => {
            if (!alive) return;
            const overlays: Record<string, BotUpdatePatch> = {};
            for (const bot of bots ?? []) {
              const overlay = botPatchQueue.overlayFor(bot.id);
              if (Object.keys(overlay).length) overlays[bot.id] = overlay;
            }
            rawDispatch({
              type: "hydrate",
              bots,
              groups: groups ?? [],
              computerControl: computerControl ?? {},
              overlays,
              botEpochAtFetch,
              groupEpochAtFetch,
            });
          }),
        },
        {
          label: "engines",
          request: api("/api/instances")
            .then(({ instances }) => alive && rawDispatch({ type: "instances", instances })),
        },
        {
          label: "settings",
          request: api("/api/config")
            .then((config) => alive && rawDispatch({ type: "configStatus", config })),
        },
        {
          label: "routines",
          request: api("/api/routines")
            .then(({ routines, runs }) => alive && rawDispatch({ type: "routinesHydrated", routines, runs })),
        },
        {
          label: "webhooks",
          request: api("/api/webhooks").then(
            ({ webhooks, attempts, ingress }) =>
              alive && rawDispatch({ type: "webhooksHydrated", webhooks, attempts: attempts ?? [], ingress }),
          ),
        },
        {
          label: "resource triggers",
          request: api("/api/resource-triggers")
            .then(({ triggers }) => alive && rawDispatch({ type: "resourceTriggersHydrated", triggers: triggers ?? [] })),
        },
      ];
      await runHydrationRequests(requests);
    };

    // A snapshot and the live fold have to meet at a defined boundary. Start
    // hydration only after the stream says hello, queue frames that arrive
    // while the REST snapshot is in flight, then apply them on top. Otherwise
    // a late hydrate can overwrite a newer event, or an event can land between
    // an eager request and the stream opening and disappear entirely.
    let hydrated = false;
    let hydrating = false;
    let hydrationFailed = false;
    let hydrationRetryAttempts = 0;
    let hydrationRetry: ReturnType<typeof setTimeout> | null = null;
    let rehydrateRequested = false;
    const pendingFrames: any[] = [];
    let handleFrame: (frame: any) => void;
    const hydrate = () => {
      if (hydrating) {
        // A second non-resumable hello means this snapshot may have started
        // before another connection gap. Run one more after it settles.
        rehydrateRequested = true;
        return;
      }
      if (hydrationRetry) {
        clearTimeout(hydrationRetry);
        hydrationRetry = null;
      }
      hydrating = true;
      hydrated = false;
      rawDispatch({ type: "hydrationStarted" });
      const botEpochAtFetch = { ...stateRef.current.botEpoch };
      const groupEpochAtFetch = { ...stateRef.current.groupEpoch };
      void loadAll(botEpochAtFetch, groupEpochAtFetch)
        .then(() => {
          hydrationFailed = false;
          hydrationRetryAttempts = 0;
          rawDispatch({ type: "hydrationReady" });
        })
        .catch((error) => {
          if (!alive) return;
          hydrationFailed = true;
          const retryDelays = [1_000, 3_000, 10_000] as const;
          const delay = retryDelays[hydrationRetryAttempts++] ?? null;
          rawDispatch({
            type: "hydrationFailed",
            message: error instanceof Error ? error.message : "Could not refresh saved data.",
            retryAt: delay === null ? null : Date.now() + delay,
          });
          if (delay !== null) hydrationRetry = setTimeout(hydrate, delay);
        })
        .finally(() => {
          if (!alive) return;
          hydrating = false;
          if (rehydrateRequested) {
            rehydrateRequested = false;
            hydrate();
            return;
          }
          hydrated = true;
          for (const frame of pendingFrames.splice(0)) handleFrame(frame);
        });
    };
    // If SSE is unavailable, the app should still show its saved state. A
    // later first hello hydrates again because it cannot prove there was no
    // gap before that connection opened.
    const hydrationFallback = setTimeout(hydrate, 1_000);

    const es = new EventSource("/api/events?screens=off");
    // The hydrate decision belongs to the hello frame, not to onopen: the
    // server replays what we missed when it can, and re-downloading every
    // transcript on a reconnect it already covered is pure waste.
    es.onopen = () => rawDispatch({ type: "connected", value: true });
    es.onerror = () => rawDispatch({ type: "connected", value: false });
    handleFrame = (frame) => {
      switch (frame.kind) {
        case "message": {
          rawDispatch({ type: "messageAdded", threadId: frame.threadId, message: frame.message });
          if (frame.message?.role === "user" && typeof frame.message.queueId === "string") {
            rawDispatch({
              type: "consumePendingQueued",
              threadId: frame.threadId,
              queueId: frame.message.queueId,
            });
          }
          // a settled assistant bubble replaces the in-flight stream
          if (frame.message?.role === "bot" && frame.message?.kind === "text") {
            clearStream(frame.threadId);
            // Auto-speak lives HERE rather than in the chat view so a bot
            // you switched away from still reads its answer out — which is
            // the whole point of listening while you do something else. A
            // Auto-speak is disabled during any call. Call mode owns both the
            // singleton speaker and microphone ordering for its whole lifetime.
            const owner = stateRef.current.bots.find((b) => b.threadId === frame.threadId);
            if (owner?.speakReplies && currentCall() === null && frame.message.text?.trim()) {
              void speaker.speak(frame.message.text, {
                botId: owner.id,
                messageId: frame.message.id,
                voiceId: owner.voice,
              });
            }
          }
          break;
        }
        case "message.patch":
          rawDispatch({ type: "messagePatched", threadId: frame.threadId, message: frame.message });
          break;
        // An update runs detached and takes minutes; the harness pushes a
        // new status on every step so the Updates card and the floating
        // banner follow it live.  It is not reducer state — only the two
        // update components want it — so it goes out as a window event
        // rather than growing the store.
        case "update.status":
          window.dispatchEvent(new CustomEvent(UPDATE_STATUS_EVENT, { detail: frame.status }));
          break;
        case "thread":
          rawDispatch({ type: "threadActive", threadId: frame.threadId, activeLeafId: frame.activeLeafId });
          // a rewind also invalidates any half-streamed text from the old branch
          clearStream(frame.threadId);
          break;
        case "bot": {
          const bot = frame.bot as BotAnnouncement;
          // reading the selected chat clears its badge immediately
          if (bot.unread && bot.id === stateRef.current.selectedId) {
            bot.unread = false;
            botPatchQueue.enqueue(bot.id, { unread: false }, bot);
          }
          rawDispatch({
            type: "botPatched",
            bot: { ...bot, ...botPatchQueue.overlayFor(bot.id) },
          });
          break;
        }
        case "group": {
          const group = frame.group as Partial<Group> & { id: string };
          // reading the selected room clears its badge immediately
          if (group.unread && group.id === stateRef.current.selectedId) {
            group.unread = false;
            fetch(`/api/groups/${group.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ unread: false }),
            }).catch(() => {});
          }
          rawDispatch({ type: "groupPatched", group });
          break;
        }
        // the harness decided this was worth interrupting for; the toggle
        // in each bot's settings is what gates it, server-side
        case "notify":
          // the wrapped dispatch, not rawDispatch: `select` clears the badge
          // in local state either way, but only the wrapper PATCHes
          // unread:false back. Opening a bot from its own notification and
          // watching the badge return on the next hydration is exactly the
          // bug that makes notifications feel broken.
          showNotification(
            frame.notification,
            (target) => openNotificationTarget(dispatch, target, stateRef.current),
            stateRef.current.bots.find((bot) => bot.id === frame.notification.botId)?.avatarUrl,
          );
          break;
        case "group.deleted":
          rawDispatch({ type: "groupDeleted", groupId: frame.groupId });
          break;
        case "routine":
          rawDispatch({ type: "routinePatched", routine: frame.routine });
          break;
        case "routine.deleted":
          rawDispatch({ type: "routineDeleted", routineId: frame.routineId });
          break;
        case "routine.run":
          rawDispatch({ type: "routineRunPatched", run: frame.run });
          break;
        case "webhook":
          rawDispatch({ type: "webhookPatched", webhook: frame.webhook });
          break;
        case "webhook.attempt":
          rawDispatch({ type: "webhookAttempted", attempt: frame.attempt });
          break;
        case "webhook.deleted":
          rawDispatch({ type: "webhookDeleted", webhookId: frame.webhookId });
          break;
        case "resource-trigger":
          rawDispatch({ type: "resourceTriggerPatched", trigger: frame.trigger });
          break;
        case "resource-trigger.deleted":
          rawDispatch({ type: "resourceTriggerDeleted", triggerId: frame.triggerId });
          break;
        case "runtime": {
          const event = frame.event;
          if (event.type === "content.delta") {
            // Batch token deltas per animation frame (t3code-style): a fast
            // stream dispatches once per frame instead of once per token, so
            // the app tree re-renders at most ~60x/s while streaming.
            const buf = deltaBuffer.current;
            const entry = buf.get(event.threadId) ?? { text: "", reasoning: "" };
            if (event.streamKind === "assistant_text") entry.text += event.delta;
            else if (event.streamKind === "reasoning_text") entry.reasoning += event.delta;
            buf.set(event.threadId, entry);
            if (deltaFlush.current === null) {
              deltaFlush.current = requestAnimationFrame(() => {
                deltaFlush.current = null;
                flushDeltas();
              });
            }
          } else if (event.type === "turn.completed") {
            // flush any buffered tail before clearing so no tokens are lost
            flushDeltas();
            clearStream(event.threadId);
          }
          break;
        }
        case "screen":
          rawDispatch({ type: "screenFrame", botId: frame.botId, png: frame.png, mime: frame.mime ?? "image/png" });
          break;
        case "computer":
          rawDispatch({ type: "provisioning", botId: frame.botId, on: frame.state === "provisioning" });
          break;
        case "computer-control":
          rawDispatch({
            type: "computerControl",
            botId: frame.botId,
            held: frame.held === true,
            helpReason: typeof frame.helpReason === "string" ? frame.helpReason : null,
          });
          break;
        case "bot.deleted":
          botPatchQueue.cancel(frame.botId);
          rawDispatch({ type: "deleteBot", botId: frame.botId });
          break;
        // a key changed and the fleet hot-reloaded — refresh the picker so
        // newly available providers un-dim immediately
        case "config":
          rawDispatch({
            type: "configStatus",
            config: configStatusFromFrame(frame),
          });
          api("/api/instances")
            .then(({ instances }) => rawDispatch({ type: "instances", instances }))
            .catch(() => {});
          break;
      }
    };
    es.onmessage = (raw) => {
      let frame: any;
      try {
        frame = JSON.parse(raw.data);
      } catch {
        return;
      }
      // `hello` is the snapshot boundary. A false `resumed` means the server
      // could not fill the gap, so queue subsequent frames behind a hydrate.
      if (frame.kind === "hello") {
        clearTimeout(hydrationFallback);
        if (frame.resumed !== true) {
          // The snapshot replaces the pre-gap transcript.  Discard both
          // rendered fragments and queued deltas from that older boundary.
          deltaBuffer.current.clear();
          if (deltaFlush.current !== null) {
            cancelAnimationFrame(deltaFlush.current);
            deltaFlush.current = null;
          }
          setStream(EMPTY_STREAM);
          pendingFrames.length = 0;
        }
        if (shouldHydrateAfterHello(frame.resumed === true, hydrationFailed)) hydrate();
        return;
      }
      if (hydrated) handleFrame(frame);
      else pendingFrames.push(frame);
    };
    return () => {
      alive = false;
      clearTimeout(hydrationFallback);
      if (hydrationRetry) clearTimeout(hydrationRetry);
      es.close();
    };
  }, []);

  // Re-probe the engines on demand. A CLI installed while the app is running
  // is invisible until something asks again — the setup screens expose this
  // as "Check again" so the user isn't told to restart when a refresh will do.
  //
  // Every describe() spawns `--version`/auth/model-discovery per CLI, which
  // costs real seconds on a machine with many engines installed — so this
  // rides the registry's maxAgeMs memo by default (server/index.ts caps it at
  // 15s) the same as the passive callers below (initial hydrate, the `config`
  // SSE push, the throttled focus probe). `fresh: true` is for a caller that
  // just changed something the memo wouldn't know about yet — an explicit
  // "Check again"/"Refresh" click, or a just-saved CLI/fullAuto override.
  const refreshInstances = useCallback(async (opts?: { fresh?: boolean }) => {
    try {
      const { instances } = await api(opts?.fresh ? "/api/instances?fresh=1" : "/api/instances");
      rawDispatch({ type: "instances", instances });
    } catch {
      /* offline or server down — the existing list stays */
    }
  }, []);

  // Installing a CLI or signing one in happens in a terminal, outside this
  // window — so the moment the user comes back is exactly when our engine
  // snapshot is most likely stale. Re-probe on focus, throttled so that
  // ordinary alt-tabbing doesn't spawn a `--version` call per switch.
  const lastFocusProbe = useRef(0);
  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (now - lastFocusProbe.current < 3000) return;
      lastFocusProbe.current = now;
      void refreshInstances();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshInstances]);

  const flushBotPatches = useCallback(
    (botId: string) => botPatchQueue.flush(botId),
    [botPatchQueue],
  );
  const value = useMemo(
    () => ({ state, dispatch, flushBotPatches, refreshInstances }),
    [state, dispatch, flushBotPatches, refreshInstances],
  );
  return (
    <StoreContext.Provider value={value}>
      <StreamContext.Provider value={stream}>{children}</StreamContext.Provider>
    </StoreContext.Provider>
  );
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore outside provider");
  return ctx;
}

export function formatTime(at: number) {
  return new Date(at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
