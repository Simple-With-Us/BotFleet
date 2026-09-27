import { downloadAllBots, downloadAllConversations } from "@/lib/team-files";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Loader2, Menu, X } from "lucide-react";
import { StoreProvider, useStore, type AppSettingsSection } from "@/state/store";
import { ERROR_RECOVERY_EVENT, type ErrorRecoveryDetail } from "@/components/ErrorRow";
import { Onboarding } from "@/components/Onboarding";
import { emailGateDone, initAnalytics } from "@/lib/analytics";
import { unreadConversationCount } from "@/lib/unread";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { UpdateBanner } from "@/components/UpdateBanner";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { NoEngines } from "@/components/NoEngines";

// UI2: every one of these is already conditionally rendered — near-modal
// panels/pages that most sessions never open in a given launch — so they
// shipped in the main chunk for nothing. React.lazy splits each into its own
// chunk; the named export → { default } reshape is because none of them
// default-export. See docs/audits/2026-09-24-efficiency-audit.md.
// SettingsModal and InspectorPanel are not named in that finding but are the
// same shape as SettingsPanel/GroupSettingsPanel right next to them, so they
// are split too; GroupView and Onboarding are primary/first-run views, not
// rarely-open panels, and stay static.
const SettingsPanel = lazy(() =>
  import("@/components/SettingsPanel").then((m) => ({ default: m.SettingsPanel })),
);
const GroupSettingsPanel = lazy(() =>
  import("@/components/GroupSettingsPanel").then((m) => ({ default: m.GroupSettingsPanel })),
);
const PluginsPanel = lazy(() =>
  import("@/components/PluginsPanel").then((m) => ({ default: m.PluginsPanel })),
);
const ComputerPanel = lazy(() =>
  import("@/components/ComputerPanel").then((m) => ({ default: m.ComputerPanel })),
);
const InspectorPanel = lazy(() =>
  import("@/components/InspectorPanel").then((m) => ({ default: m.InspectorPanel })),
);
const SettingsModal = lazy(() =>
  import("@/components/SettingsModal").then((m) => ({ default: m.SettingsModal })),
);
const RoutinesPage = lazy(() =>
  import("@/components/RoutinesPage").then((m) => ({ default: m.RoutinesPage })),
);
const CommandPalette = lazy(() =>
  import("@/components/CommandPalette").then((m) => ({ default: m.CommandPalette })),
);
const LocalVmWorkspace = lazy(() =>
  import("@/components/LocalVmWorkspace").then((m) => ({ default: m.LocalVmWorkspace })),
);
const SkillRecorderPage = lazy(() =>
  import("@/components/SkillRecorderPage").then((m) => ({ default: m.SkillRecorderPage })),
);
const TeamMapPage = lazy(() =>
  import("@/components/TeamMapPage").then((m) => ({ default: m.TeamMapPage })),
);

/** Small, unobtrusive placeholder while a lazy panel's chunk loads. Each
 * loads once per install (cached after), so this is on screen for a beat at
 * most — a corner toast rather than anything that competes with the panel's
 * own chrome, since panels here range from a slide-over to a full page. */
function PanelFallback() {
  return (
    <div className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full bg-panel px-3 py-2 text-[12px] text-ink-secondary shadow-lg">
      <Loader2 size={14} className="animate-spin" />
      Loading…
    </div>
  );
}

function Shell() {
  const { state, dispatch } = useStore();
  const unreadCount = unreadConversationCount(state.bots, state.groups);
  // Mobile-only drawer state. Above md, none of these properties are emitted
  // at all — Sidebar scopes every mobile class with max-md: rather than
  // cancelling them with md:, which would still emit a translate value and
  // turn the aside into a containing block for its fixed descendants (see
  // Sidebar.tsx's className comment).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [localVmWorkspaceBotId, setLocalVmWorkspaceBotId] = useState<string | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const group = state.groups.find((g) => g.id === state.selectedId);
  const bot = group ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0]);

  // Nothing on this machine can run a bot. A missing cloud login does not
  // count — that CLI can still host a local model. Wait for the first
  // /api/instances response before deciding: an empty list means "not asked
  // yet", and flashing the setup screen at every launch would be worse.
  const noEngines =
    state.connected &&
    state.instances.length > 0 &&
    !state.instances.some((i) => i.snapshot.state === "available");

  // App-wide shortcuts: ⌘N new bot · ⌘1–9 jump to bot · ⌘⇧[ / ⌘⇧] prev/next.
  // Kept deliberately small; every panel already closes on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const bots = state.bots.filter((b) => !b.hidden);
      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "newBot" });
      } else if (/^[1-9]$/.test(e.key)) {
        const target = bots[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          dispatch({ type: "select", id: target.id });
        }
      } else if (e.shiftKey && (e.key === "[" || e.key === "]")) {
        const idx = bots.findIndex((b) => b.id === state.selectedId);
        const next = bots[(idx + (e.key === "]" ? 1 : -1) + bots.length) % bots.length];
        if (next) {
          e.preventDefault();
          dispatch({ type: "select", id: next.id });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.bots, state.selectedId, dispatch]);

  useEffect(() => {
    window.ogb?.setUnreadCount?.(unreadCount);
  }, [unreadCount]);

  useEffect(() => {
    const onRecovery = (event: Event) => {
      const detail = (event as CustomEvent<ErrorRecoveryDetail>).detail;
      if (!detail) return;
      const targetId = detail.botId || state.selectedId;
      switch (detail.action) {
        case "switch-model":
          if (detail.botId) dispatch({ type: "select", id: detail.botId });
          dispatch({ type: "toggleSettings", open: true });
          break;
        case "add-key":
          dispatch({ type: "toggleAppSettings", open: true, section: "connections" });
          break;
        case "open-computer":
          if (targetId) dispatch({ type: "select", id: targetId });
          dispatch({ type: "toggleComputer", open: true });
          break;
        case "use-this-computer":
          if (targetId && state.bots.some((candidate) => candidate.id === targetId)) {
            dispatch({ type: "updateBot", botId: targetId, patch: { computers: ["local"] } });
            dispatch({ type: "select", id: targetId });
          }
          dispatch({ type: "toggleComputer", open: true });
          break;
        case "create-local-vm":
          if (targetId) dispatch({ type: "select", id: targetId });
          dispatch({ type: "toggleComputer", open: true });
          break;
      }
    };
    window.addEventListener(ERROR_RECOVERY_EVENT, onRecovery);
    return () => window.removeEventListener(ERROR_RECOVERY_EVENT, onRecovery);
  }, [dispatch, state.selectedId, state.bots]);

  useEffect(() => {
    if (!window.ogb?.onMenuAction) return;
    return window.ogb.onMenuAction((action: string, payload?: unknown) => {
      if (action === "open-settings") {
        const section = (payload as { section?: AppSettingsSection } | undefined)?.section;
        dispatch({ type: "toggleAppSettings", open: true, section });
      } else if (action === "new-bot") {
        dispatch({ type: "newBot" });
      } else if (action === "new-channel") {
        window.dispatchEvent(new CustomEvent("open-new-channel"));
      } else if (action === "new-task") {
        if (state.selectedId) {
          const targetBot = state.bots.find((b) => b.id === state.selectedId);
          if (targetBot) {
            dispatch({ type: "newTask", botId: targetBot.id });
          }
        }
        window.dispatchEvent(new CustomEvent("focus-composer"));
      } else if (action === "export-bots") {
        void downloadAllBots().catch(() => {});
      } else if (action === "import-bots") {
        window.dispatchEvent(new CustomEvent("open-team-library"));
      } else if (action === "export-conversations") {
        void downloadAllConversations().catch(() => {});
      } else if (action === "view-chat") {
        dispatch({ type: "toggleAppSettings", open: false });
        dispatch({ type: "toggleComputer", open: false });
        dispatch({ type: "togglePlugins", open: false });
      } else if (action === "view-routines") {
        dispatch({ type: "toggleAppSettings", open: false });
        window.dispatchEvent(new CustomEvent("open-routines"));
      } else if (action === "view-triggers") {
        window.dispatchEvent(new CustomEvent("open-resource-triggers"));
      } else if (action === "view-computer") {
        dispatch({ type: "toggleComputer", open: true });
      } else if (action === "view-plugins") {
        dispatch({ type: "togglePlugins", open: true });
      }
    });
  }, [state.selectedId, state.bots, dispatch]);

  // Warm connected-account state as soon as the local server is available.
  // The modal then opens with the correct Connect/Add account buttons and
  // quietly revalidates instead of rediscovering every account from scratch.
  // PluginsPanel is lazy now (UI2), so this reaches preloadConnectedApps
  // through the same dynamic import rather than a static one that would
  // pull the whole panel back into the main chunk just for this call.
  useEffect(() => {
    if (!state.connected) return;
    void import("@/components/PluginsPanel")
      .then((m) => m.preloadConnectedApps())
      .catch(() => {});
  }, [state.connected]);

  // Picking a conversation closes the drawer: on a phone the chat is what you
  // asked for, and leaving the list up would hide it. Watching activeView too
  // catches re-selecting the bot that is already current from another view —
  // the reducer switches the view without changing selectedId. pluginsOpen
  // and settingsOpen cover the same idea from a different trigger: close the
  // drawer whenever an action opens something over the chat.
  useEffect(() => {
    setDrawerOpen(false);
  }, [state.selectedId, state.activeView, state.pluginsOpen, state.settingsOpen]);

  useEffect(() => {
    if (
      localVmWorkspaceBotId &&
      (state.activeView !== "chat" || state.selectedId !== localVmWorkspaceBotId)
    ) {
      setLocalVmWorkspaceBotId(null);
    }
  }, [localVmWorkspaceBotId, state.activeView, state.selectedId]);

  const openLocalVmWorkspace = (botId: string) => {
    dispatch({ type: "toggleComputer", open: false });
    setLocalVmWorkspaceBotId(botId);
  };

  const openComputerFromWorkspace = (botId: string) => {
    setLocalVmWorkspaceBotId(null);
    dispatch({ type: "select", id: botId });
    dispatch({ type: "toggleComputer", open: true });
  };

  const nativeViewOverlayOpen =
    drawerOpen ||
    paletteOpen ||
    state.settingsOpen ||
    state.computerOpen ||
    state.inspectorOpen ||
    state.appSettingsOpen ||
    state.pluginsOpen;

  // The viewer outlives ComputerPanel and can target any bot, so release control
  // here (always mounted) when a bot's viewer closes. release() is idempotent.
  useEffect(() => {
    return window.ogb?.desktopViewer?.onState((viewer) => {
      if (viewer.open || !viewer.contextId) return;
      const botId = viewer.contextId;
      void fetch(`/api/bots/${botId}/computer/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "release" }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((snap) => {
          if (snap) dispatch({ type: "computerControl", botId, held: snap.held === true, helpReason: snap.helpReason ?? null });
        })
        .catch(() => {});
      void fetch(`/api/bots/${botId}/computer/viewer-close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => {});
    });
  }, [dispatch]);

  return (
    <div className="flex h-full flex-col">
      {/* fixed-position popup, bottom-left — outside the layout flow */}
      <UpdateBanner />
      {state.error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 border-b border-danger/30 bg-danger/10 px-4 py-2 text-[13px] text-danger"
        >
          <span className="min-w-0 break-words">{state.error}</span>
          <button
            type="button"
            aria-label="Dismiss Error"
            onClick={() => dispatch({ type: "error", message: null })}
            className="shrink-0 rounded-md p-0.5 hover:bg-danger/15"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {state.hydration.error && (
        <div
          role="alert"
          className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-[13px] text-ink"
        >
          <span className="font-medium">Some saved data could not refresh.</span>{"\u00A0 "}
          <span>{state.hydration.error}</span>{"\u00A0 "}
          <span>
            {state.hydration.retryAt
              ? "The last loaded data stays visible.\u00A0 BotFleet will retry shortly."
              : "The last loaded data stays visible.\u00A0 Reopen BotFleet to try again."}
          </span>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
      <button
        type="button"
        ref={menuButtonRef}
        aria-label="Open Bot List"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
        className="absolute left-3 top-3 z-30 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink md:hidden"
      >
        <Menu size={18} />
      </button>
      {drawerOpen && (
        <div
          aria-hidden
          onMouseDown={(e) => e.target === e.currentTarget && setDrawerOpen(false)}
          className="absolute inset-0 z-30 bg-black/50 md:hidden"
        />
      )}
      <Sidebar
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          menuButtonRef.current?.focus();
        }}
      />
      {state.activeView === "team-map" ? (
        <Suspense fallback={<PanelFallback />}>
          <TeamMapPage />
        </Suspense>
      ) : state.activeView === "routines" ? (
        <Suspense fallback={<PanelFallback />}>
          <RoutinesPage />
        </Suspense>
      ) : state.activeView === "skill-recorder" ? (
        <Suspense fallback={<PanelFallback />}>
          <SkillRecorderPage />
        </Suspense>
      ) : localVmWorkspaceBotId ? (
        <Suspense fallback={<PanelFallback />}>
          <LocalVmWorkspace
            primaryBotId={localVmWorkspaceBotId}
            overlayOpen={nativeViewOverlayOpen}
            onClose={() => setLocalVmWorkspaceBotId(null)}
            onOpenComputer={openComputerFromWorkspace}
          />
        </Suspense>
      ) : noEngines ? (
        <NoEngines />
      ) : group ? (
        <GroupView key={group.id} group={group} />
      ) : bot ? (
        <ChatView bot={bot} />
      ) : (
        <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
          <Loader2 size={20} className="animate-spin" />
          <div className="text-[14px]">
            {state.connected ? "No bots yet" : "Connecting to the bot server…"}
          </div>
          {!state.connected && !window.ogb && (
            <div className="text-[12px]">
              Start it with <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
            </div>
          )}
        </main>
      )}
      {(state.settingsOpen || state.computerOpen || state.inspectorOpen) && (
        <div
          aria-hidden
          onMouseDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (state.settingsOpen) dispatch({ type: "toggleSettings", open: false });
            else if (state.computerOpen) dispatch({ type: "toggleComputer", open: false });
            else if (state.inspectorOpen) dispatch({ type: "toggleInspector", open: false });
          }}
          className="absolute inset-0 z-10 hidden bg-black/40 max-[1099px]:block"
        />
      )}
      {state.settingsOpen && bot && (
        <Suspense fallback={<PanelFallback />}>
          <SettingsPanel bot={bot} />
        </Suspense>
      )}
      {state.settingsOpen && group && (
        <Suspense fallback={<PanelFallback />}>
          <GroupSettingsPanel group={group} />
        </Suspense>
      )}
      {state.computerOpen && bot && (
        <Suspense fallback={<PanelFallback />}>
          <ComputerPanel bot={bot} onOpenVmWorkspace={openLocalVmWorkspace} />
        </Suspense>
      )}
      {state.inspectorOpen && bot && (
        <Suspense fallback={<PanelFallback />}>
          <InspectorPanel bot={bot} />
        </Suspense>
      )}
      {state.appSettingsOpen && (
        <Suspense fallback={<PanelFallback />}>
          <SettingsModal />
        </Suspense>
      )}
      {state.pluginsOpen && (
        <Suspense fallback={<PanelFallback />}>
          <PluginsPanel />
        </Suspense>
      )}
      {/* mounted after the modals: same z-50 tier, so DOM order keeps the
          palette on top when one of them is open underneath. Always
          mounted (not gated on a boolean), so its own chunk starts loading
          right away; fallback is null rather than PanelFallback so an
          unopened command palette does not flash a "Loading…" toast on
          every launch. */}
      <Suspense fallback={null}>
        <CommandPalette onOpenChange={setPaletteOpen} />
      </Suspense>
      </div>
    </div>
  );
}

export default function App() {
  const [gated, setGated] = useState(() => !emailGateDone());
  useEffect(() => {
    initAnalytics();
  }, []);
  return (
    <DesktopCapabilitiesProvider>
      <StoreProvider>
        <Shell />
        {gated && <Onboarding onDone={() => setGated(false)} />}
      </StoreProvider>
    </DesktopCapabilitiesProvider>
  );
}
