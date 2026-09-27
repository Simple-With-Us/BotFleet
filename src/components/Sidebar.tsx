import { track } from "@/lib/analytics";
import {
  availableLabel,
  installBlockedBusy,
  installBlockedReason,
  installBlockedReasonDetail,
  mayUseLegacyLocalUpdate,
  runningLabel,
  updateSource,
  useUpdateControl,
} from "@/lib/update-control";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowDownToLine,
  BellDot,
  BellOff,
  Bot as BotIcon,
  Bug,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ClipboardCopy,
  Clock3,
  Copy,
  Crown,
  FolderMinus,
  FolderPlus,
  Library,
  Loader2,
  Moon,
  Network,
  Pencil,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Settings,
  Puzzle,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { api, useStore, formatTime, visibleMessages, getRoomTerminology, getConversationMode, latestChatActivity, compareBotsByRecentActivity, compareGroupsByRecentActivity, type Bot, type Group, type Message } from "@/state/store";
import { allowsMultipleBotThreads, rosterPrimaryLabel } from "../../shared/conversation-mode";
import {
  THREAD_DRAG_TYPE,
  beginThreadDrag,
  endThreadDrag,
  readThreadDragEvent,
  threadDragTypes,
} from "@/lib/thread-drag";

import { BotAvatar, InitialsAvatar } from "./Avatar";
import { ProviderMark } from "./ProviderIcons";
import { stateForBot } from "@/lib/mascot";
import { botStatusText, botWaitReason } from "@/lib/sidebar-activity";
import { useUpdaterState } from "@/lib/updater";
import { cn } from "@/lib/cn";
import { plainPreview } from "@/lib/plain-preview";
import { classifyTool, toolVerb } from "../../shared/tool-activity";
import { skillRecorderEnabled } from "@/lib/feature-flags";
import { nextRename } from "@/lib/rename";
import {
  isThreadSnoozed,
  orderedThreadRows,
  resolveCustomSnooze,
  resolveSnoozePreset,
  SNOOZE_PRESET_LABELS,
  SNOOZE_PRESETS,
  snoozeLabel,
  useSnoozeExpiry,
} from "@/lib/thread-snooze";
import { ThreadSnoozeBadge, ThreadWakeButton } from "./SidebarThreadRow";
import { imageAttachmentFromFile, intakeFiles } from "@/lib/composer-attachments";
import { pathForFile } from "./ComposerAttachments";
import { appendDraftAttachments } from "@/lib/drafts";
import { botAvatarUrlFromStoredPath } from "../../shared/bot-avatar";
import { ImagePlus } from "lucide-react";
import { downloadAllBots } from "@/lib/team-files";
import { openSentryFeedback } from "@/lib/sentry";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { MIN_QUERY, SearchResults } from "./SearchResults";
import { TeamLibraryPanel, type TeamImportResult } from "./TeamLibraryPanel";
import { RenameTitle } from "./RenameTitle";
import { BotPickerList } from "./BotPickerList";
import {
  MAX_SIDEBAR_THREAD_COUNT,
  MIN_SIDEBAR_THREAD_COUNT,
  loadCollapsedRooms,
  loadCollapsedSectionsWithBotChatsDefault,
  saveCollapsedSections,
  loadSidebarDensity,
  loadSidebarThreadCount,
  parseSidebarThreadCount,
  saveCollapsedRooms,
  saveSidebarDensity,
  saveSidebarThreadCount,
  loadSectionOrder,
  saveSectionOrder,
  orderSectionNames,
  BOT_CHATS_SECTION,
  SECTION_DRAG_TYPE,
  ROSTER_DRAG_TYPE,
  partitionSidebarGroups,
  type SidebarDensity,
} from "@/lib/sidebar-preferences";
import { phoneSettingsAction, SidebarPhoneButton } from "./SidebarPhoneButton";

/** "Milind Soni" → "MS", "milind" → "M", "you@x.dev" → "Y", unset → "?" */
function profileInitials(profile?: { name?: string; email?: string }): string {
  const name = profile?.name?.trim();
  if (name) {
    const words = name.split(/\s+/);
    return words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  }
  const email = profile?.email?.trim();
  return email ? email[0]!.toUpperCase() : "?";
}

/** Manual update check, next to the settings gear.  Packaged app only (no
 * bridge in dev/browser).  One button, state-dependent, and it has to agree
 * with the Updates card and the floating popup about which update path is
 * live — a toolbar button that quietly ran the old untracked local updater
 * while the card was driving a tracked one is exactly the split this avoids.
 * A brief "up to date" tick keeps a click from ever being silent. */
function UpdateButton() {
  const s = useUpdaterState();
  const local = useUpdateControl();
  const [checkedAt, setCheckedAt] = useState(0);
  const updater = window.ogb?.updater;
  const status = s?.status ?? "idle";
  // download and install both round-trip through main before the status
  // changes — spin on the click itself, and let the new status clear it
  const [pending, setPending] = useState(false);
  useEffect(() => setPending(false), [status]);
  const source = updateSource(local.status, Boolean(updater));
  const harnessStatus = source === "harness" ? local.status : null;
  const harnessRunning = harnessStatus?.running ?? null;
  const harnessAvailable = harnessStatus?.available ?? null;
  // a check that found nothing lands back on idle — acknowledge it for 3s.
  // Only a check that actually SUCCEEDED, though: a failed one also leaves
  // nothing available, and a green tick then answers a comparison that never
  // happened — which is the exact false "up to date" the harness answers 502
  // to prevent.  `local.error` already folds in the harness's own
  // `checkError`; both are named so neither can be lost to a later change.
  const checkFailed = Boolean(local.error) || Boolean(harnessStatus?.checkError);
  const upToDate = source === "harness"
    ? Boolean(checkedAt) && !checkFailed && !harnessAvailable && !harnessRunning
      && Date.now() - checkedAt < 3000
    : Boolean(checkedAt) && (!s || s.status === "idle") && Date.now() - checkedAt < 3000;
  useEffect(() => {
    if (!upToDate) return;
    const timer = setTimeout(() => setCheckedAt(0), 3000);
    return () => clearTimeout(timer);
  }, [upToDate]);
  if (source === "none") return null;

  if (harnessStatus) {
    const busy = local.busy !== null || Boolean(harnessRunning);
    // An install affordance that cannot install.  The button used to fall
    // through to a plain check whenever `canRun` was false — a different
    // action under the same label, with no install, no error and no icon
    // change, so it read as dead.  It says why instead, and stays down.
    const blockedReason = installBlockedReason(harnessStatus);
    const blockedReasonDetail = installBlockedReasonDetail(harnessStatus);
    const isBusyBlocked = installBlockedBusy(harnessStatus);
    const isBlocked = blockedReason !== null && !isBusyBlocked;
    const label = harnessRunning
      ? runningLabel(harnessRunning)
      : harnessAvailable
        ? `${availableLabel(harnessStatus)} — ${isBusyBlocked ? "pause & install" : (blockedReason ?? "install")}`
        : upToDate
          ? "You're up to date"
          : "Check for Updates";
    // The harness's own diagnostic sentence behind a mapped reason, for the
    // hover only — the label above stays short.  Falls back to the label
    // itself when there is nothing extra to say.
    const tooltip = harnessAvailable && (isBusyBlocked ? "Active work will pause and resume after update" : blockedReasonDetail)
      ? `${availableLabel(harnessStatus)} — ${isBusyBlocked ? "Active work will pause and resume after update" : blockedReasonDetail}`
      : label;
    return (
      // The title rides on the wrapper: a disabled button is not hovered, so
      // its own tooltip never appears, and the reason has to be readable.
      <span className="inline-flex" title={tooltip}>
        <button
          onClick={() => {
            if (harnessRunning) return;
            if (harnessAvailable) return void local.install({ force: true });
            setCheckedAt(Date.now());
            void local.check();
          }}
          disabled={busy || isBlocked || !harnessStatus.capabilities.canCheck}
          aria-label={label}
          className="relative flex size-10 items-center justify-center rounded-md text-accent hover:bg-raised disabled:opacity-60"
        >
          {busy ? (
            <Loader2 size={18} className="animate-spin" />
          ) : upToDate ? (
            <Check size={18} />
          ) : harnessAvailable ? (
            <ArrowDownToLine size={18} />
          ) : (
            <RefreshCw size={18} />
          )}
          {harnessAvailable && !harnessRunning && (
            <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent" />
          )}
        </button>
      </span>
    );
  }

  if (!updater) return null;
  // The release-feed path.  `updater.local()` survives here only for a
  // harness that gave no answer at all — see mayUseLegacyLocalUpdate.
  const legacyLocal = mayUseLegacyLocalUpdate(local.status, s?.canLocalUpdate);
  const working =
    pending || status === "checking" || status === "downloading" || status === "installing";
  const label =
    status === "available"
      ? `Version ${s?.version ?? ""} available — download`
      : status === "downloading"
        ? s?.percent == null
          ? "Starting download…"
          : `Downloading… ${Math.round(s.percent)}%`
        : status === "downloaded"
          ? `Version ${s?.version ?? ""} ready — restart to update`
          : status === "installing"
            ? "Restarting to update…"
            : status === "checking"
              ? "Checking for updates…"
              : upToDate
                ? "You're up to date"
                : status === "error" && legacyLocal
                  ? "Update From This Mac"
                  : "Check for Updates";

  return (
    <button
      onClick={() => {
        if (status === "downloaded") {
          setPending(true);
          return void updater.install();
        }
        if (status === "available") {
          setPending(true);
          return void updater.download();
        }
        if (status === "error" && legacyLocal && updater.local) {
          setPending(true);
          return void updater.local();
        }
        setCheckedAt(Date.now());
        void updater.check();
      }}
      disabled={working}
      title={label}
      aria-label={label}
      className="relative flex size-10 items-center justify-center rounded-md text-accent hover:bg-raised disabled:opacity-60"
    >
      {working ? (
        <Loader2 size={18} className="animate-spin" />
      ) : upToDate ? (
        <Check size={18} />
      ) : status === "available" ? (
        <ArrowDownToLine size={18} />
      ) : (
        <RefreshCw size={18} />
      )}
      {status === "downloaded" && (
        <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent" />
      )}
    </button>
  );
}

function preview(bot: Bot, last: Message | undefined, bots: Bot[]): string {
  // waiting-on-you/busy get a status line more specific than a bare
  // spinner when it's known what the bot is waiting on — see
  // @/lib/sidebar-activity (ported from upstream's SidebarBotActivity).
  const status = botStatusText(bot, botWaitReason(bot, last, bots));
  if (status) return status;
  if (!last) return "";
  if (last.kind === "options" && last.card) return plainPreview(last.card.title);
  if (last.kind === "activity" && last.tool) return activityPreview(last.tool);
  if (last.kind === "screen") return "Screen frame";
  // the roster shows what a bot SAID, not the source it said it in: a reply
  // formatted for the transcript would otherwise arrive here as asterisks
  // and `&nbsp;`, which is the one thing the copy rule says a person must
  // never be shown
  return plainPreview(last.text);
}

/** A step, in the roster's one line: the same verb and target the transcript
 * shows, so the two never describe the same work differently. */
function activityPreview(tool: NonNullable<Message["tool"]>): string {
  if (tool.name.startsWith("error:")) return plainPreview(tool.name.slice(6));
  const kind = tool.kind ?? classifyTool(tool.name);
  const verb = toolVerb(kind, tool.name);
  const target = tool.target ?? (verb === tool.name ? undefined : tool.name);
  return target ? `${verb} · ${target}` : verb;
}

interface MenuState {
  botId: string;
  x: number;
  y: number;
}

function groupPreview(group: Group, bots: Bot[]): string {
  if (group.busyBotId) {
    return `${bots.find((b) => b.id === group.busyBotId)?.name ?? "A bot"} is working…`;
  }
  const last = group.messages.at(-1);
  if (!last) return "No messages yet";
  const text = last.kind === "activity" && last.tool ? activityPreview(last.tool) : plainPreview(last.text);
  if (last.role === "user") return `You: ${text}`;
  return last.from ? `${last.from.name}: ${text}` : text;
}

/** Room avatar: 2–3 overlapping bots in the same 56px slot a single bot gets. */
function StackedBots({ group, members, density }: { group: Group; members: Bot[]; density: SidebarDensity }) {
  const iconOnly = density === "icons";
  const slotSize = iconOnly ? "size-12" : density === "compact" ? "size-10" : "size-14";
  const singleSize = iconOnly ? 44 : density === "compact" ? 40 : 56;
  
  if (group.avatarUrl) {
    const radius =
      group.avatarCrop === "square"
        ? "0"
        : group.avatarCrop === "circle"
        ? "50%"
        : "22%";
    return (
      <div className={cn("flex shrink-0 items-center justify-center", slotSize)}>
        <img
          src={group.avatarUrl}
          alt={group.name}
          className="size-full object-cover shadow-sm"
          style={{ width: singleSize, height: singleSize, borderRadius: radius }}
          draggable={false}
        />
      </div>
    );
  }
  if (members.length <= 1) {
    const b = members[0];
    return (
      <div className={cn("flex shrink-0 items-center justify-center", slotSize)}>
        {b ? <BotAvatar bot={b} state={stateForBot(b)} size={singleSize} animated={false} /> : <Users size={24} className="text-ink-secondary" />}
      </div>
    );
  }
  const shown = members.slice(0, 3);
  const extra = members.length - shown.length;
  return (
    <div className={cn("flex shrink-0 items-center justify-center", slotSize)}>
      <div className="flex items-center -space-x-3">
        {shown.map((b) => (
          <BotAvatar key={b.id} bot={b} state={stateForBot(b)} size={30} animated={false} />
        ))}
        {extra > 0 && (
          <span className="z-10 flex size-[22px] items-center justify-center rounded-full border border-hairline/40 bg-raised text-[10px] font-medium text-ink-secondary">
            +{extra}
          </span>
        )}
      </div>
    </div>
  );
}

/** Whatever a conversation hangs under in the sidebar: a bot or a channel.
 * The two record types differ, so the rows work from this instead. */
interface ThreadOwner {
  kind: "bot" | "group";
  id: string;
  name: string;
  /** The conversation this owner is currently showing. */
  threadId: string;
}

const THREAD_DROP_CLASS = "bg-ink/15 ring-2 ring-ink/25";

/** What a thread row needs to draw itself.  Bot threads and channel threads
 * share this shape; only a bot thread can carry a snooze, because a channel
 * conversation has no per-thread snooze route. */
type SidebarThread = {
  threadId: string;
  title: string;
  createdAt: number;
  lastActivity?: number;
  snoozedUntil?: number;
};

/** One conversation inside a channel.
 *
 * The server already names these from the first thing said in them and lets
 * them be renamed, so this row is the missing half: somewhere to see the
 * name, change it, and move the conversation somewhere else. */
function ThreadListItem({
  owner,
  task,
  density,
  siblingCount,
  onMenu,
  renameSignal,
}: {
  owner: ThreadOwner;
  task: SidebarThread;
  density: SidebarDensity;
  siblingCount: number;
  onMenu: (menu: { ownerId: string; threadId: string; x: number; y: number }) => void;
  /** Bumped by the context menu's Rename, which lives outside this row. */
  renameSignal: number;
}) {
  const { state, dispatch } = useStore();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [isDragTarget, setIsDragTarget] = useState(false);
  const active =
    state.activeView === "chat" &&
    state.selectedId === owner.id &&
    owner.threadId === task.threadId;
  // Re-read on every render rather than memoised: the branch above re-renders
  // when the nearest deadline passes, and a stale `asleep` would leave the
  // moon on a row that has already woken.
  const asleep = isThreadSnoozed(task.snoozedUntil);

  const commit = () => {
    const title = draft.trim();
    setRenaming(false);
    if (!title || title === task.title) return;
    dispatch(
      owner.kind === "group"
        ? { type: "renameGroupTask", groupId: owner.id, threadId: task.threadId, title }
        : { type: "renameTask", botId: owner.id, threadId: task.threadId, title },
    );
  };

  useEffect(() => {
    if (renameSignal === 0) return;
    setDraft(task.title);
    setRenaming(true);
  }, [renameSignal, task.title]);

  const label = task.title || "New task";

  if (renaming) {
    return (
      <div className="flex items-center pl-9 pr-2 py-1">
        <input
          autoFocus
          value={draft}
          maxLength={80}
          aria-label={`Rename ${label}`}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") {
              setDraft(task.title);
              setRenaming(false);
            }
          }}
          className="w-full rounded-md border border-hairline/50 bg-inset px-2 py-1 text-[13px] text-ink focus:outline-none"
        />
      </div>
    );
  }

  // The wake button is a SIBLING of the row, never inside it: the row is a
  // button, and a button inside a button is neither valid nor reachable —
  // the same reason ThreadDisclosure sits outside its row.
  return (
    <div className="flex items-center">
      <button
        draggable={siblingCount > 1}
        onDragStart={(event) => {
          const payload = beginThreadDrag({
            threadId: task.threadId,
            fromId: owner.id,
            fromKind: owner.kind,
          });
          event.dataTransfer.setData(THREAD_DRAG_TYPE, payload);
          event.dataTransfer.setData("text/plain", payload);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => endThreadDrag()}
        onClick={() => {
          dispatch({ type: "select", id: owner.id });
          if (owner.threadId === task.threadId) return;
          dispatch(
            owner.kind === "group"
              ? { type: "switchGroupTask", groupId: owner.id, threadId: task.threadId }
              : { type: "switchTask", botId: owner.id, threadId: task.threadId },
          );
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          setDraft(task.title);
          setRenaming(true);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu({ ownerId: owner.id, threadId: task.threadId, x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu({
            ownerId: owner.id,
            threadId: task.threadId,
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          });
        }}
        onDragEnter={(event) => {
          if (!threadDragTypes(event)) return;
          event.preventDefault();
          setIsDragTarget(true);
        }}
        onDragLeave={() => setIsDragTarget(false)}
        onDragOver={(event) => {
          if (!threadDragTypes(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setIsDragTarget(false);
          const dragged = readThreadDragEvent(event);
          if (!dragged || dragged.threadId === task.threadId) return;
          if (dragged.fromKind === "bot" && owner.kind === "bot" && dragged.fromId === owner.id) {
            dispatch({
              type: "mergeTasks",
              botId: owner.id,
              threadId: dragged.threadId,
              intoThreadId: task.threadId,
            });
            return;
          }
          if (dragged.fromKind === "bot" && owner.kind === "bot") {
            dispatch({
              type: "moveTaskToBot",
              botId: dragged.fromId,
              threadId: dragged.threadId,
              toBotId: owner.id,
            });
          }
        }}
        title={`${label}\u00a0 — double-click to rename, drag onto a bot to move, onto a thread to merge`}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-lg py-1 pr-2 text-left transition-colors",
          density === "compact" ? "pl-8" : "pl-9",
          isDragTarget
            ? THREAD_DROP_CLASS
            : active
              ? "bg-raised text-ink"
              : "text-ink-secondary hover:bg-raised/50 hover:text-ink",
        )}
      >
        <span className="size-1.5 shrink-0 rounded-full bg-current opacity-40" />
        <span className={cn("truncate text-[13px]", asleep && "opacity-60")}>{label}</span>
        <ThreadSnoozeBadge threadId={task.threadId} snoozedUntil={task.snoozedUntil} />
      </button>
      {asleep && (
        <ThreadWakeButton
          label={label}
          onWake={() =>
            dispatch({ type: "snoozeTask", botId: owner.id, threadId: task.threadId, snoozedUntil: null })
          }
        />
      )}
    </div>
  );
}

/** A channel row plus the conversations inside it.
 *
 * Collapsed state and how many to show are presentation, so they live in
 * this device's storage rather than the harness — the phone has its own
 * screen and its own idea of how much fits. */
/** Right-click menu for one conversation.
 *
 * The two move options open on hover rather than click, because picking a
 * destination is the whole point of the menu — a second click to reveal the
 * list would be a step with nothing in it. */
function ThreadContextMenu({
  menu,
  owner,
  siblingCount,
  onClose,
  onRename,
}: {
  menu: { ownerId: string; threadId: string; x: number; y: number };
  owner: ThreadOwner;
  /** How many conversations the owner has; the last one cannot move. */
  siblingCount: number;
  onClose: () => void;
  onRename: () => void;
}) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState<"channels" | "bots" | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customAt, setCustomAt] = useState("");
  const terminology = getRoomTerminology(state.config);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-thread-menu]")) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // A bot and a channel each keep their last conversation, so with only one
  // there is nowhere for this one to go.
  const movable = siblingCount > 1;
  const otherRooms = state.groups.filter(
    (g) => !g.dm && !(owner.kind === "group" && g.id === owner.id),
  );
  const bots = state.bots.filter(
    (b) => !b.hidden && !(owner.kind === "bot" && b.id === owner.id),
  );

  // Only a bot thread can sleep: a channel conversation has no per-thread
  // snooze route, and the bot-wide snooze in routines.ts is a wider thing
  // that belongs to the bot's own menu.
  const snoozeThread =
    owner.kind === "bot"
      ? state.bots.find((b) => b.id === owner.id)?.tasks?.find((t) => t.threadId === menu.threadId)
      : undefined;
  const asleep = isThreadSnoozed(snoozeThread?.snoozedUntil);
  const snooze = (snoozedUntil: number | null) => {
    dispatch({ type: "snoozeTask", botId: owner.id, threadId: menu.threadId, snoozedUntil });
    onClose();
  };

  // The snooze block makes this menu roughly twice the 220px first guess.
  const top = Math.min(menu.y, window.innerHeight - (snoozeThread ? 420 : 220));
  const left = Math.min(menu.x, window.innerWidth - 250);
  const itemClass =
    "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] text-ink hover:bg-raised/70";

  const submenu = (entries: Array<{ id: string; name: string }>, move: (id: string) => void) => (
    <div className="absolute left-full top-0 -ml-1 max-h-[280px] w-[200px] overflow-y-auto rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60">
      {entries.length === 0 ? (
        <div className="px-3 py-2 text-[12px] text-ink-secondary">Nothing to move it to</div>
      ) : (
        entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => {
              move(entry.id);
              onClose();
            }}
            className="block w-full truncate px-3 py-2 text-left text-[13px] text-ink hover:bg-raised/70"
            title={entry.name}
          >
            {entry.name}
          </button>
        ))
      )}
    </div>
  );

  return createPortal(
    <div
      data-thread-menu
      style={{ top, left }}
      className="fixed z-40 w-[228px] rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      <button type="button" className={itemClass} onClick={() => { onRename(); onClose(); }}>
        Rename
      </button>
      {snoozeThread && (
        <>
          <div className="mt-1 flex items-center gap-2 border-t border-hairline/40 px-3 pb-1 pt-2 text-[11px] text-ink-secondary">
            <Moon size={12} aria-hidden="true" />
            Snooze
          </div>
          {SNOOZE_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className={itemClass}
              // Resolved on the CLICK, never when the menu opened: a menu
              // left open overnight must not snooze until a morning that has
              // already been and gone.
              onClick={() => snooze(resolveSnoozePreset(preset))}
            >
              {SNOOZE_PRESET_LABELS[preset]}
            </button>
          ))}
          {customOpen ? (
            <div className="flex items-center gap-1.5 px-3 py-2">
              <input
                autoFocus
                type="datetime-local"
                aria-label="Snooze until"
                value={customAt}
                onChange={(event) => setCustomAt(event.target.value)}
                className="min-w-0 flex-1 rounded-md border border-hairline/50 bg-inset px-2 py-1 text-[12px] text-ink focus:outline-none"
              />
              <button
                type="button"
                // A moment already past is not a snooze.  Refuse rather than
                // store one that is over before it starts.
                disabled={resolveCustomSnooze(customAt) === undefined}
                onClick={() => {
                  const at = resolveCustomSnooze(customAt);
                  if (at !== undefined) snooze(at);
                }}
                className="shrink-0 rounded-md bg-raised px-2 py-1 text-[12px] text-ink hover:bg-raised/70 disabled:opacity-40"
              >
                Set
              </button>
            </div>
          ) : (
            <button type="button" className={itemClass} onClick={() => setCustomOpen(true)}>
              Custom&hellip;
            </button>
          )}
          {asleep && (
            <button type="button" className={itemClass} onClick={() => snooze(null)}>
              <span className="flex items-center gap-2">
                <BellOff size={13} aria-hidden="true" />
                Stop snoozing
              </span>
              <span className="text-[11px] text-ink-secondary">
                {snoozeLabel(snoozeThread.snoozedUntil)}
              </span>
            </button>
          )}
          <div className="mb-1 border-b border-hairline/40" />
        </>
      )}
      {movable && (
        <>
          <div className="relative" onMouseEnter={() => setOpen("channels")} onMouseLeave={() => setOpen(null)}>
            <button type="button" className={itemClass} aria-haspopup="menu" aria-expanded={open === "channels"}>
              Move to {terminology.singular}
              <ChevronRight size={14} className="text-ink-secondary" />
            </button>
            {open === "channels" &&
              submenu(
                otherRooms.map((room) => ({ id: room.id, name: room.name })),
                (id) =>
                  dispatch(
                    owner.kind === "group"
                      ? {
                          type: "moveGroupTask",
                          groupId: owner.id,
                          threadId: menu.threadId,
                          toGroupId: id,
                        }
                      : {
                          type: "moveTaskToGroup",
                          botId: owner.id,
                          threadId: menu.threadId,
                          toGroupId: id,
                        },
                  ),
              )}
          </div>
          <div className="relative" onMouseEnter={() => setOpen("bots")} onMouseLeave={() => setOpen(null)}>
            <button type="button" className={itemClass} aria-haspopup="menu" aria-expanded={open === "bots"}>
              Move to Bot
              <ChevronRight size={14} className="text-ink-secondary" />
            </button>
            {open === "bots" &&
              submenu(
                bots.map((bot) => ({ id: bot.id, name: bot.name })),
                (id) =>
                  dispatch(
                    owner.kind === "group"
                      ? {
                          type: "moveGroupTaskToBot",
                          groupId: owner.id,
                          threadId: menu.threadId,
                          botId: id,
                        }
                      : {
                          type: "moveTaskToBot",
                          botId: owner.id,
                          threadId: menu.threadId,
                          toBotId: id,
                        },
                  ),
              )}
          </div>
        </>
      )}
      {!movable && (
        <div className="px-3 py-2 text-[12px] text-ink-secondary">
          {owner.kind === "group" ? `A ${terminology.singular.toLowerCase()}` : "A bot"} keeps its
          last conversation.
        </div>
      )}
    </div>,
    document.body,
  );
}

/** The conversations belonging to one bot or channel, under its row.
 *
 * Both kinds own conversations, and most of them live under bots — a bot
 * that runs a nightly routine collects one per firing — so hanging them off
 * channels alone would have hidden nearly all of them.
 *
 * Collapsed state and how many to show are presentation, so they live in
 * this device's storage rather than the harness: the phone has its own
 * screen and its own idea of how much fits. */
function GroupListItem({
  group,
  density,
  onMenu,
}: {
  group: Group;
  density: SidebarDensity;
  onMenu: (menu: { groupId: string; x: number; y: number }) => void;
}) {
  const { state, dispatch } = useStore();
  const [isDragTarget, setIsDragTarget] = useState(false);
  const dragDepth = useRef(0);
  const selected = state.activeView === "chat" && state.selectedId === group.id;
  const members = group.memberIds
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is Bot => Boolean(b));
  const last = group.messages.at(-1);
  const activityAt = latestChatActivity(group.tasks, last?.at, group.createdAt);

  const acceptsThread = (e: React.DragEvent) => threadDragTypes(e);

  const carriesFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const onDragEnter = (e: React.DragEvent) => {
    if (!carriesFiles(e) && !acceptsThread(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragTarget(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!carriesFiles(e) && !acceptsThread(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragTarget(false);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (carriesFiles(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    } else if (acceptsThread(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };
  const onDrop = async (e: React.DragEvent) => {
    if (!carriesFiles(e) && !acceptsThread(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setIsDragTarget(false);
    const dragged = readThreadDragEvent(e);
    if (dragged) {
      if (dragged.fromKind === "group" && dragged.fromId !== group.id) {
        dispatch({
          type: "moveGroupTask",
          groupId: dragged.fromId,
          threadId: dragged.threadId,
          toGroupId: group.id,
        });
      } else if (dragged.fromKind === "bot") {
        dispatch({
          type: "moveTaskToGroup",
          botId: dragged.fromId,
          threadId: dragged.threadId,
          toGroupId: group.id,
        });
      }
      return;
    }
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    dispatch({ type: "select", id: group.id });
    const { attachments } = await intakeFiles(files, {
      allowImages: true,
      getPath: pathForFile,
      uploadImage: imageAttachmentFromFile,
    });
    if (attachments.length) {
      appendDraftAttachments(`group:${group.id}:${group.threadId}`, attachments);
    }
  };

  return (
    <button
      onClick={() => {
        dispatch({ type: "select", id: group.id });
        window.dispatchEvent(new CustomEvent("focus-composer"));
      }}
      draggable={!group.dm}
      onDragStart={(event) => {
        if (group.dm) return;
        event.dataTransfer.setData(ROSTER_DRAG_TYPE, JSON.stringify({ kind: "group", id: group.id }));
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ groupId: group.id, x: e.clientX, y: e.clientY });
      }}
      // the menu must be reachable without a pointer: Shift+F10, and the
      // dedicated ContextMenu key (whose native event carries no useful
      // coordinates) both open it centered on the row
      onKeyDown={(e) => {
        if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        onMenu({ groupId: group.id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }}
      className={cn(
        "relative flex w-full items-center rounded-xl text-left transition-all",
        density === "icons" ? "justify-center px-1 py-1.5" : density === "compact" ? "gap-2 px-2 py-1.5" : "gap-3 px-3 py-2.5",
        isDragTarget
          ? THREAD_DROP_CLASS
          : selected
            ? "bg-raised"
            : "hover:bg-raised/50",
      )}
      title={density === "icons" ? group.name : undefined}
      aria-label={density === "icons" ? group.name : undefined}
    >
      <StackedBots group={group} members={members} density={density} />
      <div className={cn("min-w-0 flex-1", density === "icons" && "hidden")}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[15px] font-semibold text-ink" title={group.name}>{group.name}</span>
          {selected && activityAt > 0 && <span className="shrink-0 text-xs text-ink-secondary">{formatTime(activityAt)}</span>}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] text-ink-secondary" title={groupPreview(group, state.bots)}>{groupPreview(group, state.bots)}</span>
          {group.unread && <span className="size-2 shrink-0 rounded-full bg-accent" />}
        </div>
      </div>
      {density === "icons" && group.unread && (
        <span className="absolute bottom-1.5 right-1.5 size-2 rounded-full border border-panel bg-accent" />
      )}
    </button>
  );
}

function ThreadBranch({
  owner,
  tasks,
  density,
  threadCount,
  collapsed,
}: {
  owner: ThreadOwner;
  tasks: SidebarThread[];
  density: SidebarDensity;
  threadCount: number;
  collapsed: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const [threadMenu, setThreadMenu] = useState<{
    ownerId: string;
    threadId: string;
    x: number;
    y: number;
  } | null>(null);
  const [renameSignals, setRenameSignals] = useState<Record<string, number>>({});

  // A snoozed thread SINKS rather than disappearing, and the moment its
  // deadline passes it is back in plain update order — where update order is
  // the last thing that happened in the thread whoever caused it, a person,
  // a webhook or a schedule, all of which land as messages.  The thread the
  // person is reading stays put: snoozing the conversation on screen must
  // not yank it out from under them.
  useSnoozeExpiry(tasks);
  const ordered = orderedThreadRows(
    tasks,
    Date.now(),
    new Set(owner.threadId ? [owner.threadId] : []),
  );
  const shown = showAll ? ordered : ordered.slice(0, threadCount);
  const hidden = ordered.length - shown.length;
  const moreClass = cn(
    "w-full rounded-lg py-1 pr-2 text-left text-[12px] text-ink-secondary hover:bg-raised/50 hover:text-ink",
    density === "compact" ? "pl-8" : "pl-9",
  );

  if (collapsed) return null;
  return (
    <div className="mt-0.5 flex flex-col gap-0.5">
      {shown.map((task) => (
        <ThreadListItem
          key={task.threadId}
          owner={owner}
          task={task}
          density={density}
          siblingCount={ordered.length}
          onMenu={setThreadMenu}
          renameSignal={renameSignals[task.threadId] ?? 0}
        />
      ))}
      {hidden > 0 && (
        <button onClick={() => setShowAll(true)} className={moreClass}>
          More Threads&hellip; ({hidden})
        </button>
      )}
      {showAll && ordered.length > threadCount && (
        <button onClick={() => setShowAll(false)} className={moreClass}>
          Show Fewer
        </button>
      )}
      {threadMenu && (
        <ThreadContextMenu
          menu={threadMenu}
          owner={owner}
          siblingCount={ordered.length}
          onClose={() => setThreadMenu(null)}
          onRename={() =>
            setRenameSignals((current) => ({
              ...current,
              [threadMenu.threadId]: (current[threadMenu.threadId] ?? 0) + 1,
            }))
          }
        />
      )}
    </div>
  );
}

/** The disclosure triangle that opens a row's conversations.  Rendered as a
 * sibling of the row rather than inside it: the rows are buttons, and a
 * button inside a button is neither valid nor reachable. */
function ThreadDisclosure({
  count,
  collapsed,
  name,
  onToggle,
}: {
  count: number;
  collapsed: boolean;
  name: string;
  onToggle: () => void;
}) {
  if (count < 1) return <span className="w-[18px] shrink-0" aria-hidden="true" />;
  return (
    <button
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-label={`${collapsed ? "Show" : "Hide"} the ${count} conversation${count === 1 ? "" : "s"} in ${name}`}
      className="shrink-0 rounded-md p-0.5 text-ink-secondary hover:bg-raised/50 hover:text-ink"
    >
      <ChevronRight size={14} className={cn("transition-transform", !collapsed && "rotate-90")} />
    </button>
  );
}

/** Wraps any sidebar row with its disclosure triangle and its
 * conversations, so bots and channels get the same treatment without
 * either row component having to know about threads. */
function ThreadTree({
  owner,
  tasks,
  density,
  threadCount,
  collapsed,
  onToggle,
  children,
}: {
  owner: ThreadOwner;
  tasks: SidebarThread[];
  density: SidebarDensity;
  threadCount: number;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  // Avatars-only mode has no room for a tree, and one conversation is just
  // the row itself said twice.
  if (density === "icons" || tasks.length < 2) return <>{children}</>;
  return (
    <div>
      <div className="flex items-center">
        <ThreadDisclosure
          count={tasks.length}
          collapsed={collapsed}
          name={owner.name}
          onToggle={onToggle}
        />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
      <ThreadBranch
        owner={owner}
        tasks={tasks}
        density={density}
        threadCount={threadCount}
        collapsed={collapsed}
      />
    </div>
  );
}

function RoomContextMenu({
  menu,
  onClose,
  onMoveToSection,
}: {
  menu: { groupId: string; x: number; y: number };
  onClose: () => void;
  onMoveToSection: (groupId: string) => void;
}) {
  const { state, dispatch } = useStore();
  const group = state.groups.find((g) => g.id === menu.groupId);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(group?.name ?? "");

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-room-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!group) return null;
  const terminology = getRoomTerminology(state.config);
  const saveRename = () => {
    const name = nextRename(group.name, draft);
    if (name) dispatch({ type: "patchGroup", groupId: group.id, patch: { name } });
    onClose();
  };
  
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const saved = await imageAttachmentFromFile(file);
      if (!saved) throw new Error("Choose a PNG, JPEG, GIF, or WebP image");
      const avatarUrl = botAvatarUrlFromStoredPath(saved.path);
      if (!avatarUrl) throw new Error("The uploaded image could not be used as an avatar");
      dispatch({ type: "patchGroup", groupId: group.id, patch: { avatarUrl } });
      onClose();
    } catch (e) {
      console.error("Failed to upload channel photo:", e);
      setUploading(false);
    }
  };

  const top = Math.min(menu.y, window.innerHeight - 204);
  const left = Math.min(menu.x, window.innerWidth - 240);
  return createPortal(
    <div
      data-room-menu
      style={{ top, left }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      {renaming ? (
        <div className="flex items-center gap-1 px-2 py-1">
          <input
            autoFocus
            value={draft}
            maxLength={100}
            aria-label={`Rename ${group.name}`}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                saveRename();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            className="min-w-0 flex-1 rounded-lg bg-raised px-2 py-1.5 text-[14px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={saveRename}
            aria-label="Save Channel Name"
            title="Save"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Check size={15} />
          </button>
          <button
            type="button"
            onClick={() => setRenaming(false)}
            aria-label="Cancel"
            title="Cancel"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => {
            setDraft(group.name);
            setRenaming(true);
          }}
          className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
        >
          <Pencil size={16} className="text-ink-secondary" />
          Rename {terminology.singular}
        </button>
      )}
      <button
        onClick={() => {
          fileRef.current?.click();
        }}
        disabled={uploading}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70 disabled:opacity-50"
      >
        {uploading ? <Loader2 size={16} className="animate-spin text-ink-secondary" /> : <ImagePlus size={16} className="text-ink-secondary" />}
        Change Photo
      </button>
      {group.avatarUrl && (
        <button
          onClick={() => {
            dispatch({ type: "patchGroup", groupId: group.id, patch: { avatarUrl: null } });
            onClose();
          }}
          className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink-secondary hover:bg-raised/70 hover:text-danger"
        >
          <Trash2 size={16} />
          Remove Photo
        </button>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/png, image/jpeg, image/gif, image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          void upload(file);
        }}
      />
      <button
        onClick={() => {
          onClose();
          onMoveToSection(group.id);
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
      >
        <FolderPlus size={16} className="text-ink-secondary" />
        Move to Context
      </button>
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(group.threadId);
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
      >
        <ClipboardCopy size={16} className="text-ink-secondary" />
        Copy conversation ID
      </button>
      <button
        onClick={() => {
          dispatch({ type: "deleteGroup", groupId: group.id });
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger hover:bg-raised/70"
      >
        <Trash2 size={16} />
        Delete {terminology.singular}
      </button>
    </div>,
    document.body,
  );
}

/** Pick members and an optional Work/Personal/project context, then create. */
function NewRoomPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const terminology = getRoomTerminology(state.config);
  const [name, setName] = useState("");
  const [section, setSection] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const bots = state.bots.filter((b) => !b.hidden);
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const create = () => {
    if (!picked.size) return;
    dispatch({
      type: "createGroup",
      memberIds: [...picked],
      name: name.trim() || undefined,
      section: section.trim() || undefined,
    });
    track("room_created", { members: picked.size, context: Boolean(section.trim()) });
    onClose();
  };
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-[340px] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl">
        <div className="mb-3 text-[15px] font-semibold text-ink">New {terminology.singular}</div>
        <input
          autoFocus
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") onClose();
          }}
          placeholder={`${terminology.singular} name (for example, Website launch)`}
          className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <input
          value={section}
          maxLength={60}
          onChange={(e) => setSection(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") onClose();
          }}
          placeholder="Context (optional): Work, Personal, Client…"
          aria-label={`${terminology.singular} context`}
          className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <BotPickerList
          bots={bots}
          picked={picked}
          onToggle={toggle}
          emptyHint={`Create a bot first — ${terminology.plural.toLowerCase()} are made of bots.`}
        />
        <button
          onClick={create}
          disabled={!picked.size}
          className="mt-3 w-full rounded-lg bg-accent py-2 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          Create {terminology.singular}{picked.size ? ` · ${picked.size} ${picked.size === 1 ? "bot" : "bots"}` : ""}
        </button>
      </div>
    </div>
  );
}

/** A roster section's header.
 *
 * It used to be a 10px uppercase whisper — the same register as a form-field
 * caption — for the labels that divide the whole roster: the channels, the
 * bots, every section a person made.  A heading that names a region of the
 * app should be legible at a glance, and a region worth naming is worth
 * being able to fold away, so this is a real heading and a real control.
 *
 * `onToggle` is optional: a divider with no section to remember (icon-rail
 * density, say) still renders as a label. */
function SectionDivider({
  name,
  count,
  collapsed,
  onToggle,
  reorderable,
  onReorder,
  onDropRoster,
}: {
  name: string;
  /** rows inside, shown when the section is folded so the count is not lost */
  count?: number;
  collapsed?: boolean;
  onToggle?: () => void;
  reorderable?: boolean;
  onReorder?: (from: string, onto: string) => void;
  onDropRoster?: (kind: "bot" | "group", id: string, section: string) => void;
}) {
  const label = (
    <>
      <span className="text-[12.5px] font-semibold tracking-[0.01em] text-ink">{name}</span>
      {collapsed && count !== undefined && count > 0 && (
        <span className="rounded-full bg-raised px-1.5 py-px text-[10.5px] font-medium text-ink-secondary tabular-nums">
          {count}
        </span>
      )}
    </>
  );
  if (!onToggle) {
    return (
      <div className="flex items-center gap-2 px-3 pb-1 pt-4 first:pt-1" data-section={name}>
        {label}
        <span className="h-px flex-1 bg-hairline/40" />
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      draggable={reorderable}
      onDragStart={(event) => {
        if (!reorderable) return;
        event.dataTransfer.setData(SECTION_DRAG_TYPE, name);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(event) => {
        const types = [...event.dataTransfer.types];
        if (!types.includes(SECTION_DRAG_TYPE) && !types.includes(ROSTER_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        event.preventDefault();
        const from = event.dataTransfer.getData(SECTION_DRAG_TYPE);
        if (from && from !== name) {
          onReorder?.(from, name);
          return;
        }
        const roster = event.dataTransfer.getData(ROSTER_DRAG_TYPE);
        if (!roster) return;
        try {
          const parsed = JSON.parse(roster) as { kind?: string; id?: string };
          if ((parsed.kind === "bot" || parsed.kind === "group") && parsed.id) {
            onDropRoster?.(parsed.kind, parsed.id, name);
          }
        } catch {
          // ignore malformed payloads
        }
      }}
      className="group/section flex w-full items-center gap-1.5 rounded-lg px-3 pb-1 pt-4 text-left first:pt-1 hover:bg-raised/40"
      data-section={name}
    >
      <ChevronDown
        size={13}
        className={cn(
          "shrink-0 text-ink-secondary/70 transition-transform",
          collapsed && "-rotate-90",
        )}
      />
      {label}
      <span className="h-px flex-1 bg-hairline/40" />
    </button>
  );
}

/** Move-to-section popover: existing sections as chips (checkmark on the
 * target's current one), a create field, and a remove action. Serves bots
 * and channels alike — the caller supplies the assignment. Mirrors the
 * context menu's fixed positioning + dismiss-on-outside-click contract. */
function SectionPicker({
  current,
  anchor,
  onClose,
  onAssign,
}: {
  /** the target's current section; undefined = none */
  current: string | undefined;
  anchor: { x: number; y: number };
  onClose: () => void;
  /** "" clears — the server drops an empty section */
  onAssign: (section: string) => void;
}) {
  const { state } = useStore();
  const [name, setName] = useState("");
  const trimmed = name.trim();

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-section-picker]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // Hidden bots can carry a stale assignment; don't offer it as a context.
  // Channels and bots share one namespace, so Work or Personal can hold both.
  const sections = [
    ...new Set([
      ...state.bots.filter((b) => !b.hidden && b.section).map((b) => b.section!),
      ...state.groups.filter((g) => g.section).map((g) => g.section!),
    ]),
  ];

  const assign = (section: string) => {
    onAssign(section);
    onClose();
  };

  const top = Math.max(8, Math.min(anchor.y, window.innerHeight - 300));
  const left = Math.min(anchor.x, window.innerWidth - 260);

  return (
    <div
      data-section-picker
      style={{ top, left }}
      className="fixed z-40 w-[236px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-2 shadow-2xl shadow-black/60"
    >
      <div className="px-3.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
        Move to Context
      </div>
      {sections.length > 0 && (
        <div className="flex flex-col gap-0.5 px-1.5 py-1">
          {sections.map((section) => (
            <button
              key={section}
              onClick={() => assign(section)}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]",
                section === current ? "bg-raised text-ink" : "text-ink hover:bg-raised/70",
              )}
            >
              <span className="truncate" title={section}>{section}</span>
              {section === current && <Check size={14} className="shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex items-center gap-1.5 px-2.5 py-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed || trimmed.length > 60) return;
          assign(trimmed);
        }}
      >
        <input
          autoFocus
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New context…"
          aria-label="New Context Name"
          className="w-full rounded-lg bg-raised/70 px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <button
          type="submit"
          disabled={!trimmed || trimmed.length > 60}
          className={cn(
            "shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] font-medium",
            trimmed ? "bg-accent text-panel" : "bg-raised/70 text-ink-secondary",
          )}
        >
          Add
        </button>
      </form>
      {current && (
        <>
          <div className="mx-2 my-1 border-t border-hairline/40" />
          <button
            onClick={() => assign("")}
            className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[13px] text-danger hover:bg-raised/70"
          >
            <FolderMinus size={15} />
            Remove from context
          </button>
        </>
      )}
    </div>
  );
}

function BotContextMenu({
  menu,
  onClose,
  onArchive,
  onMoveToSection,
}: {
  menu: MenuState;
  onClose: () => void;
  onArchive: (bot: Bot) => void;
  onMoveToSection: (botId: string) => void;
}) {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((b) => b.id === menu.botId);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-bot-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!bot) return null;
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  const visibleBotCount = state.bots.filter((candidate) => !candidate.hidden).length;
  const archiveBlocked = Boolean(bot.chiefOfStaff) || visibleBotCount <= 1;
  const archiveHint = bot.chiefOfStaff
    ? "Choose another Chief of Staff first"
    : visibleBotCount <= 1
      ? "Keep at least one active bot"
      : undefined;
  // keep the menu on-screen near the click
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 380));
  const left = Math.min(menu.x, window.innerWidth - 240);

  const item = (
    icon: React.ReactNode,
    label: string,
    onClick?: () => void,
    opts?: { danger?: boolean; disabled?: boolean; hint?: string },
  ) => (
    <button
      key={label}
      disabled={opts?.disabled}
      onClick={() => {
        onClick?.();
        onClose();
      }}
      title={opts?.hint}
      className={cn(
        "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px]",
        opts?.danger ? "text-danger" : "text-ink",
        opts?.disabled ? "cursor-default opacity-40" : "hover:bg-raised/70",
      )}
    >
      {icon}
      {label}
    </button>
  );
  const divider = (key: string) => <div key={key} className="mx-2 my-1 border-t border-hairline/40" />;

  return (
    <div
      data-bot-menu
      style={{ top, left }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      {[
        item(
          bot.pinned ? <PinOff size={16} className="text-ink-secondary" /> : <Pin size={16} className="text-ink-secondary" />,
          bot.pinned ? "Unpin" : "Pin",
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } }),
        ),
        item(
          <Crown size={16} className={bot.chiefOfStaff ? "text-accent" : "text-ink-secondary"} />,
          bot.chiefOfStaff ? "Remove Chief of Staff" : "Make Chief of Staff",
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { chiefOfStaff: !bot.chiefOfStaff } }),
          {
            disabled: !bot.chiefOfStaff && !canCoordinate,
            hint: !bot.chiefOfStaff && !canCoordinate ? "Choose an engine with coordination first" : undefined,
          },
        ),
        item(<FolderPlus size={16} className="text-ink-secondary" />, "Move to Section", () => {
          onClose();
          onMoveToSection(bot.id);
        }),
        item(<BellDot size={16} className="text-ink-secondary" />, "Mark as Unread", () =>
          dispatch({ type: "markUnread", botId: bot.id }),
        ),
        divider("d1"),
        item(<Pencil size={16} className="text-ink-secondary" />, "Edit Profile", () => {
          dispatch({ type: "select", id: bot.id });
          dispatch({ type: "toggleSettings", open: true });
        }),
        item(<Copy size={16} className="text-ink-secondary" />, "Duplicate", () =>
          dispatch({ type: "duplicateBot", botId: bot.id }),
        ),
        divider("d2"),
        item(<ClipboardCopy size={16} className="text-ink-secondary" />, "Copy Conversation ID", () => {
          void navigator.clipboard?.writeText(bot.threadId);
        }),
        divider("d3"),
        item(
          <Archive size={16} className="text-ink-secondary" />,
          "Archive",
          () => onArchive(bot),
          {
            disabled: archiveBlocked,
            hint: archiveHint,
          },
        ),
        item(<Trash2 size={16} />, "Delete", () => dispatch({ type: "deleteBot", botId: bot.id }), {
          danger: true,
        }),
      ]}
    </div>
  );
}

function BotListItem({
  bot,
  density,
  onMenu,
  onArchive,
  archiveDisabled,
}: {
  bot: Bot;
  density: SidebarDensity;
  onMenu: (menu: MenuState) => void;
  onArchive: (bot: Bot) => void;
  archiveDisabled: boolean;
}) {
  const { state, dispatch } = useStore();
  const [renaming, setRenaming] = useState(false);
  const selected = state.activeView === "chat" && state.selectedId === bot.id;
  const mascotMotion = selected && state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const iconOnly = density === "icons";
  useEffect(() => {
    if (iconOnly) setRenaming(false);
  }, [iconOnly]);
  const avatarSize = iconOnly ? 44 : density === "compact" ? 40 : 56;
  // the visible branch, so a version switch changes the row with the chat
  const visible = visibleMessages(bot);
  const last = visible.at(-1);
  const activityAt = latestChatActivity(bot.tasks, last?.at, bot.createdAt ?? 0);
  const waitReason = botWaitReason(bot, last, state.bots);
  const previewText = preview(bot, last, state.bots);
  // Icon shape ported from upstream's SidebarBotActivity: CircleAlert for
  // anything needing a person or naming a teammate, a spinning Loader2 as
  // the fallback for plain busy work, nothing for idle.
  const StatusIcon = waitReason ? (waitReason.kind === "teammate" ? Clock3 : CircleAlert) : bot.busy ? Loader2 : null;
  const rowClass = cn(
    "flex w-full items-center rounded-xl border text-left",
    iconOnly
      ? "justify-center px-1 py-1.5"
      : density === "compact"
        ? "gap-2 px-2 py-1.5 pr-12"
        : "gap-3 px-3 py-2.5 pr-12",
    bot.chiefOfStaff
      ? selected
        ? "border-accent/40 bg-accent/15"
        : "border-accent/25 bg-accent/5 hover:bg-accent/10"
      : selected
        ? "border-transparent bg-raised"
        : "border-transparent hover:bg-raised/50",
  );
  const body = (
    <>
      <BotAvatar
        bot={bot}
        state={stateForBot({ ...bot, messages: visible })}
        size={avatarSize}
        motion={mascotMotion?.kind ?? "none"}
        motionKey={mascotMotion?.nonce ?? 0}
        // Motion means something is happening. A resting bot holds a resting
        // pose — N idle rows bobbing at display rate was most of the app's
        // visible-idle CPU (states are keyword-derived, so "working" can be
        // decorative; busy/unread/motion are the real signals).
        animated={Boolean(bot.busy) || Boolean(bot.unread) || (mascotMotion?.kind ?? "none") !== "none"}
      />
      <div className={cn("min-w-0 flex-1", iconOnly && "hidden")}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[15px] font-semibold text-ink">
            {bot.pinned && <Pin size={12} className="shrink-0 text-ink-secondary" />}
            <RenameTitle
              key={iconOnly ? "icons" : "expanded"}
              value={bot.name}
              onCommit={(name) => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })}
              onEditingChange={setRenaming}
              className="truncate"
              inputClassName="w-full rounded bg-inset px-1 py-0.5 text-[15px] font-semibold"
            />
            {(() => {
              const currentSelection = bot.activeModelSelection ?? bot.modelSelection;
              const instance = state.instances.find((entry) => entry.instanceId === currentSelection.instanceId);
              if (!instance) return null;
              const modelOption = instance.models.options.find((o) => o.id === currentSelection.model);
              const modelName = modelOption?.label || currentSelection.model;
              const title = `${modelName} (${instance.displayName || instance.driverKind})`;
              return (
                <span className="ml-2 shrink-0" title={title}>
                  <ProviderMark driverKind={instance.driverKind} model={currentSelection.model} size={14} />
                </span>
              );
            })()}
          </span>
          {selected && activityAt > 0 && !renaming && (
            <span className="shrink-0 text-xs text-ink-secondary transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
              {formatTime(activityAt)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[13px] text-ink-secondary">
            {bot.chiefOfStaff && (
              <span className="flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-accent">
                <Crown size={11} /> Chief of Staff
              </span>
            )}
            {bot.chiefOfStaff && previewText && <span className="shrink-0 text-ink-secondary/60">·</span>}
            {StatusIcon && (
              <StatusIcon
                size={11}
                aria-hidden="true"
                className={cn("shrink-0", waitReason ? "text-warning" : "animate-spin text-success")}
              />
            )}
            <span className="truncate" title={previewText}>{previewText}</span>
          </span>
          {bot.unread && (
            <span className="size-2 shrink-0 rounded-full bg-accent" />
          )}
        </div>
      </div>
    </>
  );
  const [isDragTarget, setIsDragTarget] = useState(false);
  const dragDepth = useRef(0);

  const acceptsThread = (e: React.DragEvent) => threadDragTypes(e);
  const carriesFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const onDragEnter = (e: React.DragEvent) => {
    if (!carriesFiles(e) && !acceptsThread(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragTarget(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!carriesFiles(e) && !acceptsThread(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragTarget(false);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (carriesFiles(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    } else if (acceptsThread(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };
  const onDrop = async (e: React.DragEvent) => {
    if (!carriesFiles(e) && !acceptsThread(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setIsDragTarget(false);
    const dragged = readThreadDragEvent(e);
    if (dragged) {
      if (dragged.fromKind === "bot" && dragged.fromId !== bot.id) {
        dispatch({
          type: "moveTaskToBot",
          botId: dragged.fromId,
          threadId: dragged.threadId,
          toBotId: bot.id,
        });
      } else if (dragged.fromKind === "group") {
        dispatch({
          type: "moveGroupTaskToBot",
          groupId: dragged.fromId,
          threadId: dragged.threadId,
          botId: bot.id,
        });
      }
      return;
    }
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    dispatch({ type: "select", id: bot.id });
    const instance = state.instances.find((i) => i.instanceId === bot.modelSelection?.instanceId);
    const allowImages = Boolean(instance?.capabilities?.images);
    const { attachments } = await intakeFiles(files, {
      allowImages,
      getPath: pathForFile,
      uploadImage: imageAttachmentFromFile,
    });
    if (attachments.length) {
      appendDraftAttachments(`bot:${bot.id}`, attachments);
    }
  };

  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    onMenu({ botId: bot.id, x: event.clientX, y: event.clientY });
  };

  // Keep the rename <input> out of role="button" — a button's descendants
  // are presentational, which hides the field from assistive tech.
  if (renaming) {
    return (
      <div className={rowClass} onContextMenu={onContextMenu}>
        {body}
      </div>
    );
  }

  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(ROSTER_DRAG_TYPE, JSON.stringify({ kind: "bot", id: bot.id }));
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn(
        "group relative rounded-xl transition-all",
        isDragTarget && THREAD_DROP_CLASS,
      )}
      title={iconOnly ? bot.name : undefined}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={iconOnly ? bot.name : undefined}
        onClick={() => {
        dispatch({ type: "select", id: bot.id });
        window.dispatchEvent(new CustomEvent("focus-composer"));
      }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            dispatch({ type: "select", id: bot.id });
          }
        }}
        onContextMenu={onContextMenu}
        className={rowClass}
      >
        {body}
      </div>
      {iconOnly && bot.unread && (
        <span className="pointer-events-none absolute bottom-1.5 right-1.5 size-2 rounded-full border border-panel bg-accent" />
      )}
      {!iconOnly && <button
        type="button"
        disabled={archiveDisabled}
        onClick={() => onArchive(bot)}
        aria-label={`Archive ${bot.name}`}
        title={
          bot.chiefOfStaff
            ? "Choose another Chief of Staff first"
            : archiveDisabled
              ? "Keep at least one active bot"
              : `Archive ${bot.name}`
        }
        className="absolute right-1 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-lg bg-card/90 text-ink-secondary opacity-0 shadow-sm transition hover:bg-raised hover:text-ink focus:opacity-100 disabled:cursor-default disabled:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100"
      >
        <Archive size={14} />
      </button>}
    </div>
  );
}

function ArchivedBotsPanel({
  bots,
  onClose,
  onRestored,
}: {
  bots: Bot[];
  onClose: () => void;
  onRestored: (message: string) => void;
}) {
  const { dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restoringAll, setRestoringAll] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyId && !restoringAll) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busyId, onClose, restoringAll]);

  const restore = async (bot: Bot) => {
    setBusyId(bot.id);
    setError("");
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      dispatch({ type: "select", id: bot.id });
      onRestored(`${bot.name} restored`);
      if (bots.length === 1) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const restoreAll = async () => {
    setRestoringAll(true);
    setError("");
    try {
      const responses = await Promise.all(
        bots.map((bot) =>
          api(`/api/bots/${bot.id}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: false }),
          }),
        ),
      );
      for (const response of responses) dispatch({ type: "botPatched", bot: response.bot });
      const first = bots[0];
      if (first) dispatch({ type: "select", id: first.id });
      onRestored(`${bots.length} ${bots.length === 1 ? "bot" : "bots"} restored`);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestoringAll(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && !busyId && !restoringAll && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="archived-bots-title"
        tabIndex={-1}
        className="animate-pop-in flex max-h-[min(680px,calc(100dvh-2rem))] w-full max-w-[760px] flex-col overflow-hidden rounded-[24px] border border-hairline/50 bg-panel shadow-2xl shadow-black/50 outline-none"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-4 pt-6 sm:px-8 sm:pt-7">
          <div>
            <h2 id="archived-bots-title" className="text-[22px] font-semibold tracking-[-0.01em] text-ink">Archived Bots</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">Conversations are kept until you choose to delete a bot.</p>
          </div>
          <div className="flex items-center gap-1">
            {bots.length > 1 && (
              <button
                onClick={() => void restoreAll()}
                disabled={restoringAll || Boolean(busyId)}
                className="flex items-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
              >
                {restoringAll && <Loader2 size={13} className="animate-spin" />}
                Restore All
              </button>
            )}
            <button
              onClick={onClose}
              disabled={restoringAll || Boolean(busyId)}
              className="flex size-10 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
              aria-label="Close Archived Bots"
            >
              <X size={21} />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-3 sm:px-8">
          <div className="mb-3 text-[12px] font-medium text-ink-secondary">{bots.length} archived</div>
          <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
            {bots.map((bot) => (
              <div key={bot.id} className="flex min-h-[82px] items-center gap-3 border-b border-hairline/35 px-1 py-3">
                <BotAvatar bot={bot} state={stateForBot(bot)} size={42} animated={false} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-ink" title={bot.name}>{bot.name}</div>
                  <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary" title={bot.title || "Bot"}>{bot.title || "Bot"}</div>
                </div>
                <button
                  onClick={() => void restore(bot)}
                  disabled={restoringAll || Boolean(busyId)}
                  className="flex min-w-[78px] items-center justify-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
                >
                  {busyId === bot.id && <Loader2 size={13} className="animate-spin" />}
                  Restore
                </button>
              </div>
            ))}
          </div>
          {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const importReturnRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sectionPicker, setSectionPicker] = useState<MenuState | null>(null);
  const [roomMenu, setRoomMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [roomSectionPicker, setRoomSectionPicker] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [newRoom, setNewRoom] = useState(false);
  const [threadCount, setThreadCountState] = useState(() => loadSidebarThreadCount());
  const setThreadCount = (next: number) => {
    const clamped = parseSidebarThreadCount(String(next));
    setThreadCountState(clamped);
    saveSidebarThreadCount(clamped);
  };
  const [collapsedRooms, setCollapsedRooms] = useState<Set<string>>(() => loadCollapsedRooms());
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => loadCollapsedSectionsWithBotChatsDefault());
  const [sectionOrder, setSectionOrder] = useState<string[]>(() => loadSectionOrder());
  const toggleSection = (name: string) => {
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      saveCollapsedSections(next);
      return next;
    });
  };
  const sectionOpen = (name: string) => !collapsedSections.has(name);
  const toggleRoom = (groupId: string) => {
    setCollapsedRooms((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      saveCollapsedRooms(next);
      return next;
    });
  };
  const [teamLibraryOpen, setTeamLibraryOpen] = useState(false);
  const [teamInstallUrl, setTeamInstallUrl] = useState<string | null>(null);
  const [archivedBotsOpen, setArchivedBotsOpen] = useState(false);
  const [exportingTeam, setExportingTeam] = useState(false);
  const [teamFeedback, setTeamFeedback] = useState<{
    error: boolean;
    text: string;
    undo?: TeamImportResult;
    restoreBot?: { id: string; name: string };
  } | null>(null);
  const [query, setQuery] = useState("");
  const [density, setDensityState] = useState<SidebarDensity>(() => loadSidebarDensity());
  const [lastExpandedDensity, setLastExpandedDensity] = useState<Exclude<SidebarDensity, "icons">>(() => {
    const saved = loadSidebarDensity();
    return saved === "icons" ? "comfortable" : saved;
  });
  const [densityOpen, setDensityOpen] = useState(false);

  const setDensity = (next: SidebarDensity) => {
    setDensityState(next);
    if (next !== "icons") setLastExpandedDensity(next);
    // Search is hidden in avatar-only mode. Keeping its value would silently
    // filter bots, rooms, and message results with no visible way to clear it.
    else setQuery("");
    saveSidebarDensity(next);
    setDensityOpen(false);
  };

  const toggleCollapsed = () => {
    if (density === "icons") setDensity(lastExpandedDensity);
    else {
      setLastExpandedDensity(density);
      setDensity("icons");
    }
  };

  // Esc closes the drawer, mirroring ApiKeys.tsx:75-85. Bound only while the
  // drawer is open — on mobile, exactly when a bot/room context menu or the
  // New Room panel can be open on top of it, so the same Escape press closes
  // them together. Fine, since both directions are "get me out of here."
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  useEffect(() => {
    if (!densityOpen) return;
    const closeDensityMenu = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDensityOpen(false);
    };
    window.addEventListener("keydown", closeDensityMenu);
    return () => window.removeEventListener("keydown", closeDensityMenu);
  }, [densityOpen]);

  useEffect(() => {
    return window.ogb?.onPackageInstall?.((url) => {
      setTeamInstallUrl(url);
      setTeamLibraryOpen(true);
    });
  }, []);

  // File ▸ Import Bots opens the same panel the Teams button does.
  useEffect(() => {
    const open = () => setTeamLibraryOpen(true);
    window.addEventListener("open-team-library", open);
    return () => window.removeEventListener("open-team-library", open);
  }, []);

  useEffect(() => {
    if (!teamFeedback) return;
    const timer = window.setTimeout(() => setTeamFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [teamFeedback]);

  const exportAllBots = async () => {
    setExportingTeam(true);
    setTeamFeedback(null);
    try {
      const exported = await downloadAllBots();
      track("team_exported", { members: exported.members, scope: "all_visible" });
      setTeamFeedback({ error: false, text: `${exported.members} bots exported` });
    } catch (cause) {
      setTeamFeedback({
        error: true,
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setExportingTeam(false);
    }
  };

  const undoTeamLoad = async (result: TeamImportResult) => {
    setTeamFeedback(null);
    try {
      await Promise.all([
        ...result.importedRoutineIds.map((routineId) =>
          api(`/api/routines/${routineId}`, { method: "DELETE" }).then(() =>
            dispatch({ type: "routineDeleted", routineId }),
          ),
        ),
        ...result.importedGroupIds.map((groupId) =>
          api(`/api/groups/${groupId}`, { method: "DELETE" }).then(() =>
            dispatch({ type: "groupDeleted", groupId }),
          ),
        ),
      ]);
      const archiveNew = await Promise.all(
        result.importedBotIds.map((botId) =>
          api(`/api/bots/${botId}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: true, chiefOfStaff: false }),
          }),
        ),
      );
      for (const response of archiveNew) dispatch({ type: "botPatched", bot: response.bot });

      const previousChiefs = result.archived.filter((bot) => bot.chiefOfStaff);
      const restoreOthers = await Promise.all(
        result.archived
          .filter((bot) => !bot.chiefOfStaff)
          .map((bot) =>
            api(`/api/bots/${bot.id}`, {
              method: "PATCH",
              body: JSON.stringify({ hidden: false }),
            }),
          ),
      );
      for (const response of restoreOthers) dispatch({ type: "botPatched", bot: response.bot });
      const restoredChiefs = await Promise.all(
        previousChiefs.map((previousChief) =>
          api(`/api/bots/${previousChief.id}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: false, chiefOfStaff: true }),
          }),
        ),
      );
      for (const response of restoredChiefs) dispatch({ type: "botPatched", bot: response.bot });
      const first = result.archived[0];
      if (first) dispatch({ type: "select", id: first.id });
      setTeamFeedback({ error: false, text: "Previous team restored" });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const archiveBot = async (bot: Bot) => {
    const activeBots = state.bots.filter((candidate) => !candidate.hidden);
    if (bot.chiefOfStaff || activeBots.length <= 1) return;
    setTeamFeedback(null);
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: true }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      if (state.selectedId === bot.id) {
        const next = activeBots.find((candidate) => candidate.id !== bot.id);
        if (next) dispatch({ type: "select", id: next.id });
      }
      setTeamFeedback({
        error: false,
        text: `${bot.name} archived`,
        restoreBot: { id: bot.id, name: bot.name },
      });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const undoBotArchive = async (bot: { id: string; name: string }) => {
    setTeamFeedback(null);
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      dispatch({ type: "select", id: bot.id });
      setTeamFeedback({ error: false, text: `${bot.name} restored` });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const macInset = capabilities.windowChrome === "mac-inset";
  const browser = capabilities.host.label === "Browser";
  // SAFETY: Electron's documented -webkit-app-region CSS property is not in
  // React's CSSProperties type, but the renderer accepts it as an inline style.
  const windowDragStyle = macInset
    ? ({ WebkitAppRegion: "drag" } as React.CSSProperties)
    : undefined;
  // SAFETY: Same Electron-only CSS property as windowDragStyle; interactive
  // buttons must explicitly opt out of the draggable title-bar region.
  const windowNoDragStyle = macInset
    ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties)
    : undefined;

  const q = query.trim().toLowerCase();

  // Message search rides the same box as the name filter: names match
  // instantly from local state; transcript hits are the SearchResults
  // section below the list (debounced, lands on the message).

  // UI5: this used to filter and sort state.bots/state.groups (with a
  // lowercase preview() per bot) directly in the render body, so every store
  // dispatch re-ran it even when neither bots, groups, nor the query had
  // changed. Memoized on exactly those three — state.bots/state.groups keep
  // their identity across unrelated dispatches (the same assumption
  // MessagesList's memoization already relies on in ChatView), so this now
  // only redoes the work when the roster, the rooms, or the search text
  // actually moved. Returned as one object rather than several memos: the
  // pieces are cheap to destructure and it keeps a single dependency list
  // instead of six near-identical ones.
  const {
    unsectionedChief,
    sectionChiefs,
    sectionedBots,
    visibleBots,
    visibleGroups,
    botChats,
    sectionedGroups,
    unsectionedGroups,
  } = useMemo(() => {
    const byRecentBot = compareBotsByRecentActivity;
    const byRecentGroup = compareGroupsByRecentActivity;
    const matchingBots = state.bots
      .filter((b) => !b.hidden)
      .filter(
        (b) =>
          !q ||
          b.name.toLowerCase().includes(q) ||
          (b.title ?? "").toLowerCase().includes(q) ||
          preview(b, visibleMessages(b).at(-1), state.bots).toLowerCase().includes(q),
      );
    const unsectionedChief = matchingBots.find((bot) => bot.chiefOfStaff && !bot.section);
    const sectionChiefs = matchingBots.filter((bot) => bot.chiefOfStaff && bot.section);
    const sectionedBots = matchingBots
      .filter((bot) => !bot.chiefOfStaff && bot.section)
      .sort(byRecentBot);
    const visibleBots = matchingBots
      .filter((bot) => !bot.chiefOfStaff && !bot.section)
      .sort(byRecentBot);
    const visibleGroups = state.groups.filter(
      (g) =>
        !q ||
        g.name.toLowerCase().includes(q) ||
        (g.tasks ?? []).some((task) => task.title.toLowerCase().includes(q)),
    );
    const {
      botChats: botChatsRaw,
      sectionedRooms: sectionedGroupsRaw,
      unsectionedRooms: unsectionedGroupsRaw,
    } = partitionSidebarGroups(visibleGroups);
    return {
      unsectionedChief,
      sectionChiefs,
      sectionedBots,
      visibleBots,
      visibleGroups,
      botChats: [...botChatsRaw].sort(byRecentGroup),
      sectionedGroups: [...sectionedGroupsRaw].sort(byRecentGroup),
      unsectionedGroups: [...unsectionedGroupsRaw].sort(byRecentGroup),
    };
  }, [state.bots, state.groups, q]);
  const terminology = getRoomTerminology(state.config);
  const conversationMode = getConversationMode(state.config);
  const showExtraThreads = allowsMultipleBotThreads(conversationMode);
  const primary = rosterPrimaryLabel(conversationMode);
  // User contexts keep a stored order.  Bot ↔ Bot is not a user context and
  // always sits at the bottom, collapsed until opened.  DMs stay out of Apps
  // even when a leftover section tag remains on the record (#237).
  const sectionNames: string[] = [];
  for (const bot of sectionedBots) {
    if (!sectionNames.includes(bot.section!)) sectionNames.push(bot.section!);
  }
  for (const bot of sectionChiefs) {
    if (!sectionNames.includes(bot.section!)) sectionNames.push(bot.section!);
  }
  for (const group of sectionedGroups) {
    if (!sectionNames.includes(group.section!)) sectionNames.push(group.section!);
  }
  const orderedSectionNames = orderSectionNames(sectionNames, sectionOrder);
  const activeBotCount = state.bots.filter((bot) => !bot.hidden).length;
  const archivedBots = state.bots.filter((bot) => bot.hidden);
  const pendingTeamUndo = teamFeedback?.undo;
  const pendingBotUndo = teamFeedback?.restoreBot;

  return (
    <aside
      aria-label="Bots and Navigation"
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-hairline/40 bg-panel transition-[width] duration-200",
        density === "icons" ? "w-[80px]" : density === "compact" ? "w-[272px]" : "w-[320px]",
        // Below md only: the sidebar leaves the flow and slides in over the chat.
        // Scoped with max-md: rather than cancelled with md: on purpose — Tailwind
        // v4 emits the native `translate` property, and any value other than
        // `none` turns this element into a containing block for its `fixed`
        // descendants. Cancelling it with an `md:` prefix still emits a value, which
        // silently reparents NewRoomPanel's overlay and the "+" menu backdrop on
        // desktop.
        "max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40",
        "max-md:transition-transform max-md:duration-200",
        open ? "max-md:translate-x-0" : "max-md:-translate-x-full",
      )}
    >
      {/* macOS owns inset traffic lights; Linux/Windows use native chrome. */}
      <div
        className={cn("flex items-center pt-3.5 pb-1", density === "icons" ? "flex-col gap-1 px-2" : "justify-between px-4")}
        style={windowDragStyle}
      >
        {macInset ? (
          <div className={density === "icons" ? "h-5 w-full" : "w-14"} />
        ) : browser ? (
          <div className="flex items-center gap-2">
            <span className="size-3 rounded-full bg-[#ff5f57]" />
            <span className="size-3 rounded-full bg-[#febc2e]" />
            <span className="size-3 rounded-full bg-[#28c840]" />
          </div>
        ) : <div />}
        <div
          className={cn("relative flex items-center", density === "icons" ? "flex-col gap-1" : "gap-1")}
          style={windowNoDragStyle}
        >
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={density === "icons" ? "Expand Sidebar" : "Collapse Sidebar to Avatars"}
            className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            title={density === "icons" ? "Expand Sidebar" : "Collapse to Avatars"}
          >
            {density === "icons" ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setDensityOpen((value) => !value)}
              aria-label="Choose Sidebar Density"
              aria-expanded={densityOpen}
              className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
              title="Sidebar Density"
            >
              <span aria-hidden="true" className="flex size-5 flex-col items-center justify-center gap-[3px]">
                <span className="h-px w-3.5 rounded-full bg-current" />
                <span className="h-px w-2.5 rounded-full bg-current" />
                <span className="h-px w-3.5 rounded-full bg-current" />
              </span>
            </button>
            {densityOpen && (
              <>
                <div className="fixed inset-0 z-30" onMouseDown={() => setDensityOpen(false)} />
                <div className={cn(
                  "absolute top-full z-40 mt-1 w-40 overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60",
                  density === "icons" ? "left-0" : "right-0",
                )}>
                  {(["comfortable", "compact", "icons"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setDensity(option)}
                      className={cn(
                        "flex w-full items-center justify-between px-3 py-2 text-left text-[13px] capitalize hover:bg-raised/70",
                        density === option ? "text-accent" : "text-ink",
                      )}
                    >
                      {option === "icons" ? "Avatars only" : option}
                      {density === option && <Check size={14} />}
                    </button>
                  ))}
                  <div className="my-1 h-px bg-hairline/40" />
                  <div className="px-3 py-2">
                    <label
                      htmlFor="sidebar-thread-count"
                      className="block text-[12px] text-ink-secondary"
                    >
                      Threads per {terminology.singular.toLowerCase()}
                    </label>
                    <input
                      id="sidebar-thread-count"
                      type="number"
                      min={MIN_SIDEBAR_THREAD_COUNT}
                      max={MAX_SIDEBAR_THREAD_COUNT}
                      value={threadCount}
                      onChange={(event) => setThreadCount(Number(event.target.value))}
                      className="mt-1 w-full rounded-md border border-hairline/40 bg-inset px-2 py-1 text-[13px] text-ink focus:outline-none"
                    />
                  </div>
                </div>
              </>
            )}
          </div>
          <button
            ref={importReturnRef}
            onClick={() => setPlusOpen((o) => !o)}
            aria-label="New or Share"
            className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            title="New or Share"
          >
            <Plus size={20} strokeWidth={2} />
          </button>
          {plusOpen && (
            <>
              <div className="fixed inset-0 z-30" onMouseDown={() => setPlusOpen(false)} />
              <div className={cn(
                "absolute top-full z-40 mt-1 w-44 overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60",
                density === "icons" ? "left-0" : "right-0",
              )}>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    track("bot_created");
                    dispatch({ type: "newBot" });
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <BotIcon size={16} className="text-ink-secondary" />
                  {primary.newLabel}
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    setNewRoom(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Users size={16} className="text-ink-secondary" />
                  New {terminology.singular}
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    void exportAllBots();
                  }}
                  disabled={exportingTeam}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  {exportingTeam ? <Loader2 size={16} className="animate-spin text-ink-secondary" /> : <ArrowDownToLine size={16} className="text-ink-secondary" />}
                  {exportingTeam ? "Exporting…" : "Export All Bots"}
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    setTeamLibraryOpen(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Library size={16} className="text-ink-secondary" />
                  Teams
                </button>
                {archivedBots.length > 0 && (
                  <button
                    onClick={() => {
                      setPlusOpen(false);
                      setArchivedBotsOpen(true);
                    }}
                    className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                  >
                    <Archive size={16} className="text-ink-secondary" />
                    <span className="flex-1">Archived Bots</span>
                    <span className="text-[11.5px] text-ink-secondary">{archivedBots.length}</span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Search */}
      <div className={cn("pt-2 pb-3", density === "icons" ? "hidden" : "px-3")}>
        <div className="flex items-center gap-2 rounded-lg bg-raised/70 px-3 py-2">
          <Search size={16} className="text-ink-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Search"
            aria-label={`Search ${primary.plural} and Messages`}
            className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </div>
      </div>

      {/* Bot list */}
      <div className="flex-1 overflow-y-auto px-2">
        <div className="flex flex-col gap-0.5">
          {/* Transcript hits go above the roster.  They were last before,
              which put them under every bot and channel — the reason the
              search looked like it only matched names. */}
          <SearchResults query={query} onLanded={() => setQuery("")} />
          {!unsectionedChief && sectionChiefs.length === 0 && visibleBots.length === 0 && sectionedBots.length === 0 && visibleGroups.length === 0 && q && q.length < MIN_QUERY && (
            <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">Nothing matches “{query}”</div>
          )}
          {unsectionedChief && (
            <div className="mb-1.5">
              <ThreadTree
                key={unsectionedChief.id}
                owner={{ kind: "bot", id: unsectionedChief.id, name: unsectionedChief.name, threadId: unsectionedChief.threadId }}
                tasks={showExtraThreads ? (unsectionedChief.tasks ?? []) : []}
                density={density}
                threadCount={threadCount}
                collapsed={collapsedRooms.has(unsectionedChief.id)}
                onToggle={() => toggleRoom(unsectionedChief.id)}
              >
                <BotListItem
                  bot={unsectionedChief}
                  density={density}
                  onMenu={setMenu}
                  onArchive={(bot) => void archiveBot(bot)}
                  archiveDisabled
                />
              </ThreadTree>
            </div>
          )}
          {unsectionedGroups.length > 0 && density !== "icons" && (
            <SectionDivider
              name={terminology.plural}
              count={unsectionedGroups.length}
              collapsed={!sectionOpen(terminology.plural)}
              onToggle={() => toggleSection(terminology.plural)}
            />
          )}
          {(density === "icons" || sectionOpen(terminology.plural)) && unsectionedGroups.map((g) => (
            <ThreadTree
              key={g.id}
              owner={{ kind: "group", id: g.id, name: g.name, threadId: g.threadId }}
              tasks={showExtraThreads ? (g.tasks ?? []) : []}
              density={density}
              threadCount={threadCount}
              collapsed={collapsedRooms.has(g.id)}
              onToggle={() => toggleRoom(g.id)}
            >
              <GroupListItem group={g} density={density} onMenu={setRoomMenu} />
            </ThreadTree>
          ))}
          {visibleBots.length > 0 && density !== "icons" && (
            <SectionDivider
              name={primary.plural}
              count={visibleBots.length}
              collapsed={!sectionOpen(primary.plural)}
              onToggle={() => toggleSection(primary.plural)}
            />
          )}
          {(density === "icons" || sectionOpen(primary.plural)) && visibleBots.map((b) => (
            <ThreadTree
              key={b.id}
              owner={{ kind: "bot", id: b.id, name: b.name, threadId: b.threadId }}
              tasks={showExtraThreads ? (b.tasks ?? []) : []}
              density={density}
              threadCount={threadCount}
              collapsed={collapsedRooms.has(b.id)}
              onToggle={() => toggleRoom(b.id)}
            >
              <BotListItem
                key={b.id}
                bot={b}
                density={density}
                onMenu={setMenu}
                onArchive={(bot) => void archiveBot(bot)}
                archiveDisabled={activeBotCount <= 1}
              />
            </ThreadTree>
          ))}
          {orderedSectionNames.map((name) => {
            const rows =
              sectionChiefs.filter((bot) => bot.section === name).length +
              sectionedGroups.filter((g) => g.section === name).length +
              sectionedBots.filter((b) => b.section === name).length;
            const open = density === "icons" || sectionOpen(name);
            return (
            <Fragment key={name}>
              {density !== "icons" && (
                <SectionDivider
                  name={name}
                  count={rows}
                  collapsed={!open}
                  onToggle={() => toggleSection(name)}
                  reorderable
                  onReorder={(from, onto) => {
                    const current = orderSectionNames(
                      orderedSectionNames,
                      orderedSectionNames.filter((n) => n !== from),
                    );
                    const without = current.filter((n) => n !== from);
                    const at = without.indexOf(onto);
                    const next = [...without.slice(0, Math.max(0, at)), from, ...without.slice(Math.max(0, at))];
                    setSectionOrder(next);
                    saveSectionOrder(next);
                  }}
                  onDropRoster={(kind, id, section) => {
                    if (kind === "bot") dispatch({ type: "updateBot", botId: id, patch: { section } });
                    else {
                      const group = state.groups.find((entry) => entry.id === id);
                      if (group?.dm) return;
                      dispatch({ type: "patchGroup", groupId: id, patch: { section } });
                    }
                  }}
                />
              )}
              {open && sectionChiefs
                .filter((bot) => bot.section === name)
                .map((bot) => (
                  <ThreadTree
                    key={bot.id}
                    owner={{ kind: "bot", id: bot.id, name: bot.name, threadId: bot.threadId }}
                    tasks={showExtraThreads ? (bot.tasks ?? []) : []}
                    density={density}
                    threadCount={threadCount}
                    collapsed={collapsedRooms.has(bot.id)}
                    onToggle={() => toggleRoom(bot.id)}
                  >
                    <BotListItem
                      key={bot.id}
                      bot={bot}
                      density={density}
                      onMenu={setMenu}
                      onArchive={(candidate) => void archiveBot(candidate)}
                      archiveDisabled
                    />
                  </ThreadTree>
                ))}
              {open && sectionedGroups
                .filter((g) => g.section === name)
                .map((g) => (
                  <ThreadTree
                    key={g.id}
                    owner={{ kind: "group", id: g.id, name: g.name, threadId: g.threadId }}
                    tasks={showExtraThreads ? (g.tasks ?? []) : []}
                    density={density}
                    threadCount={threadCount}
                    collapsed={collapsedRooms.has(g.id)}
                    onToggle={() => toggleRoom(g.id)}
                  >
                    <GroupListItem group={g} density={density} onMenu={setRoomMenu} />
                  </ThreadTree>
                ))}
              {open && sectionedBots
                .filter((b) => b.section === name)
                .map((b) => (
                  <ThreadTree
                    key={b.id}
                    owner={{ kind: "bot", id: b.id, name: b.name, threadId: b.threadId }}
                    tasks={showExtraThreads ? (b.tasks ?? []) : []}
                    density={density}
                    threadCount={threadCount}
                    collapsed={collapsedRooms.has(b.id)}
                    onToggle={() => toggleRoom(b.id)}
                  >
                    <BotListItem
                      key={b.id}
                      bot={b}
                      density={density}
                      onMenu={setMenu}
                      onArchive={(bot) => void archiveBot(bot)}
                      archiveDisabled={activeBotCount <= 1}
                    />
                  </ThreadTree>
                ))}
            </Fragment>
            );
          })}
          {botChats.length > 0 && density !== "icons" && (
            <SectionDivider
              name={BOT_CHATS_SECTION}
              count={botChats.length}
              collapsed={!sectionOpen(BOT_CHATS_SECTION)}
              onToggle={() => toggleSection(BOT_CHATS_SECTION)}
            />
          )}
          {(density === "icons" || sectionOpen(BOT_CHATS_SECTION)) &&
            botChats.map((g) => (
              <ThreadTree
                key={g.id}
                owner={{ kind: "group", id: g.id, name: g.name, threadId: g.threadId }}
                tasks={showExtraThreads ? (g.tasks ?? []) : []}
                density={density}
                threadCount={threadCount}
                collapsed={collapsedRooms.has(g.id)}
                onToggle={() => toggleRoom(g.id)}
              >
                <GroupListItem group={g} density={density} onMenu={setRoomMenu} />
              </ThreadTree>
            ))}
        </div>
      </div>

      {/* Footer */}
      <div className={cn("pb-3 pt-2", density === "icons" ? "px-2" : "px-3")}>
        <button
          onClick={() => dispatch({ type: "showTeamMap" })}
          aria-label={density === "icons" ? "Team Map" : undefined}
          title={density === "icons" ? "Team Map" : undefined}
          className={cn(
            "flex min-h-10 w-full items-center rounded-xl py-2 text-left transition-colors",
            density === "icons" ? "justify-center px-2" : "gap-3 px-3",
            state.activeView === "team-map" ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
          )}
        >
          <Network size={20} className={state.activeView === "team-map" ? "text-accent" : "text-ink-secondary"} />
          <span className={cn("flex-1 text-[14px]", density === "icons" && "hidden")}>Team Map</span>
        </button>
        {skillRecorderEnabled(state.config) && (
          <button
            onClick={() => dispatch({ type: "showSkillRecorder" })}
            aria-label={density === "icons" ? "Teach a Skill" : undefined}
            title={density === "icons" ? "Teach a Skill" : undefined}
            className={cn(
              "flex min-h-10 w-full items-center rounded-xl py-2 text-left transition-colors",
              density === "icons" ? "justify-center px-2" : "gap-3 px-3",
              state.activeView === "skill-recorder" ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
            )}
          >
            <Sparkles size={20} className={state.activeView === "skill-recorder" ? "text-accent" : "text-ink-secondary"} />
            <span className={cn("flex-1 text-[14px]", density === "icons" && "hidden")}>Teach a Skill</span>
          </button>
        )}
        <button
          onClick={() => dispatch({ type: "showRoutines" })}
          aria-label={density === "icons" ? "Tasks &amp; Routines" : undefined}
          title={density === "icons" ? "Tasks &amp; Routines" : undefined}
          className={cn(
            "flex min-h-10 w-full items-center rounded-xl py-2 text-left transition-colors",
            density === "icons" ? "justify-center px-2" : "gap-3 px-3",
            state.activeView === "routines" ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
          )}
        >
          <CalendarDays size={20} className={state.activeView === "routines" ? "text-accent" : "text-ink-secondary"} />
          <span className={cn("flex-1 text-[14px]", density === "icons" && "hidden")}>Tasks &amp; Routines</span>
          {state.routineRuns.some((run) => ["failed", "missed"].includes(run.status) && !run.seenAt) && (
            <span className="size-2 rounded-full bg-danger" />
          )}
        </button>
        <button
          onClick={() => dispatch({ type: "togglePlugins", open: true })}
          className={cn("flex min-h-10 w-full items-center rounded-xl py-2 text-left hover:bg-raised/50", density === "icons" ? "justify-center px-2" : "gap-3 px-3")}
          aria-label={density === "icons" ? "Connected Apps" : undefined}
          title={density === "icons" ? "Connected Apps" : undefined}
        >
          <Puzzle size={20} className="text-ink-secondary" />
          <span className={cn("text-[14px] text-ink", density === "icons" && "hidden")}>Connected Apps</span>
        </button>
        {density === "icons" && (
          <SidebarPhoneButton
            density={density}
            onOpen={() => dispatch(phoneSettingsAction())}
          />
        )}
        {density === "icons" && (
          <button
            type="button"
            onClick={() => void openSentryFeedback()}
            className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            title="Report a Problem"
            aria-label="Report a Problem"
          >
            <Bug size={18} />
          </button>
        )}
        <div className={cn("flex items-center", density === "icons" && "justify-center")}>
          <button
            onClick={() => dispatch({ type: "toggleAppSettings" })}
            className={cn("flex min-w-0 items-center rounded-xl py-2 text-left hover:bg-raised/50", density === "icons" ? "justify-center px-2" : "flex-1 gap-3 px-3")}
            aria-label={density === "icons" ? "App settings" : undefined}
            title={density === "icons" ? (state.config?.profile?.name?.trim() || "App Settings") : undefined}
          >
            <InitialsAvatar initials={profileInitials(state.config?.profile)} size={28} />
            <span
              className={cn("truncate text-[14px] text-ink", density === "icons" && "hidden")}
              title={state.config?.profile?.name?.trim() || state.config?.profile?.email?.trim() || "You"}
            >
              {state.config?.profile?.name?.trim() || state.config?.profile?.email?.trim() || "You"}
            </span>
          </button>
          {density !== "icons" && (
            <SidebarPhoneButton
              density={density}
              onOpen={() => dispatch(phoneSettingsAction())}
            />
          )}
          {density !== "icons" && <UpdateButton />}
          {density !== "icons" && (
            <button
              type="button"
              onClick={() => void openSentryFeedback()}
              className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
              title="Report a Problem"
              aria-label="Report a Problem"
            >
              <Bug size={18} />
            </button>
          )}
          {density !== "icons" && <button
            onClick={() => dispatch({ type: "toggleAppSettings" })}
            className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            title="App Settings"
          >
            <Settings size={18} />
          </button>}
        </div>
      </div>

      {menu && (
        <BotContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onArchive={(bot) => void archiveBot(bot)}
          onMoveToSection={(botId) => setSectionPicker({ botId, x: menu.x, y: menu.y })}
        />
      )}
      {sectionPicker && (
        <SectionPicker
          current={state.bots.find((b) => b.id === sectionPicker.botId)?.section}
          anchor={sectionPicker}
          onClose={() => setSectionPicker(null)}
          onAssign={(section) => dispatch({ type: "updateBot", botId: sectionPicker.botId, patch: { section } })}
        />
      )}
      {roomMenu && (
        <RoomContextMenu
          key={roomMenu.groupId}
          menu={roomMenu}
          onClose={() => setRoomMenu(null)}
          onMoveToSection={(groupId) => setRoomSectionPicker({ groupId, x: roomMenu.x, y: roomMenu.y })}
        />
      )}
      {roomSectionPicker && (
        <SectionPicker
          current={state.groups.find((g) => g.id === roomSectionPicker.groupId)?.section}
          anchor={roomSectionPicker}
          onClose={() => setRoomSectionPicker(null)}
          onAssign={(section) =>
            dispatch({ type: "patchGroup", groupId: roomSectionPicker.groupId, patch: { section } })
          }
        />
      )}
      {newRoom && <NewRoomPanel onClose={() => setNewRoom(false)} />}
      {archivedBotsOpen && (
        <ArchivedBotsPanel
          bots={archivedBots}
          onClose={() => setArchivedBotsOpen(false)}
          onRestored={(message) => setTeamFeedback({ error: false, text: message })}
        />
      )}
      {teamLibraryOpen && (
        <TeamLibraryPanel
          returnFocusRef={importReturnRef}
          initialUrl={teamInstallUrl ?? undefined}
          onClose={() => {
            setTeamLibraryOpen(false);
            setTeamInstallUrl(null);
          }}
          onImported={(result) => {
            setTeamLibraryOpen(false);
            setTeamInstallUrl(null);
            setTeamFeedback(
              result.archived.length > 0
                ? {
                    error: false,
                    text: `${result.name} loaded · ${result.members} ${result.members === 1 ? "bot" : "bots"}`,
                    undo: result,
                  }
                : {
                    error: false,
                    text: `${result.name} loaded · ${result.members} ${result.members === 1 ? "bot" : "bots"}`,
                  },
            );
          }}
        />
      )}
      {teamFeedback &&
        createPortal(
          <div
            role="status"
            className={cn(
              "fixed bottom-4 left-4 z-[60] max-w-[300px] rounded-xl border px-3.5 py-2.5 text-[13px] shadow-xl",
              teamFeedback.error
                ? "border-danger/30 bg-card text-danger"
                : "border-hairline/50 bg-card text-ink",
            )}
          >
            <div className="flex items-center gap-3">
              <span>{teamFeedback.text}</span>
              {pendingTeamUndo && (
                <button
                  onClick={() => void undoTeamLoad(pendingTeamUndo)}
                  className="rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-raised"
                >
                  Undo
                </button>
              )}
              {pendingBotUndo && (
                <button
                  onClick={() => void undoBotArchive(pendingBotUndo)}
                  className="rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-raised"
                >
                  Undo
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </aside>
  );
}
