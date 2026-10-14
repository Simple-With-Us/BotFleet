import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applySkin, followsComputerLook, readSkin } from "./lib/skins";
import { initSentryFromRuntime } from "./lib/sentry";
import "./styles.css";

// Ask the harness for the live switch before starting even the packaged
// client.  A saved opt-out must win before tracing or replay can capture the
// first render; an unreachable harness leaves this window inert.
void initSentryFromRuntime();

// Before the first paint, not inside a component: stamping the skin during
// render would show one frame of the default palette first.
applySkin(readSkin());

if (globalThis.window && window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const pref = readSkin();
    if (followsComputerLook(pref)) applySkin(pref);
  });
}

const rootElement = document.getElementById("root")!;
const fixtureParam =
  globalThis.window ? new URLSearchParams(window.location.search).get("fixture") : null;

if (fixtureParam === "tv-face") {
  // Visual-spec harness: dynamically import so the fixture chunk is not paid
  // for in the real app boot path.  The App render below is unchanged for any
  // other URL.
  void import("./components/tv-face/TVFaceAvatarVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "engine-setup") {
  // Visual-spec harness: dynamically import so the fixture chunk is not paid
  // for in the real app boot path.  The App render below is unchanged for any
  // other URL.
  void import("./components/EngineSetupVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "engine-callout") {
  // Visual-spec harness: dynamically import so the fixture chunk is not paid
  // for in the real app boot path. The App render below is unchanged for any
  // other URL.
  void import("./components/EngineCalloutVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "provider-icons") {
  // Visual-spec harness (tests/e2e/provider-icons.visual.spec.ts): the
  // changed `ProviderMark` cases (muse, mcode) and the EngineQuotasPanel that
  // ships in the picker header.  Dynamically imported so the real app boot
  // path never pays for it.
  void import("./components/ProviderIconsVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "model-rows") {
  // Visual-spec harness (tests/e2e/model-rows.visual.spec.ts): the real
  // `ModelRow` at the pane widths where a slug used to break one character per
  // line, beside the usage block that replaced the per-row quota chip.
  void import("./components/ModelRowsVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "team-map-context") {
  void import("./components/TeamMapPage").then((mod) => {
    const Fixture = mod.TeamMapSharedContextVisualFixture;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "computer-panel") {
  // Visual-spec harness: dynamically import so the fixture chunk is not paid
  // for in the real app boot path.  The App render below is unchanged for any
  // other URL.
  void import("./components/ComputerPanelVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "host-cli-integration") {
  // Visual-spec harness: dynamically import so the fixture chunk is not paid
  // for in the real app boot path.  The App render below is unchanged for any
  // other URL.
  void import("./components/HostCliIntegrationCardVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "transcription-settings") {
  // Visual-spec harness: mount the real call-dictation selector with fixed
  // config.  The real app boot path stays unchanged for other URLs.
  void import("./components/TranscriptionSettingsVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "voice-settings-personal") {
  // Visual-spec harness: dynamically import so the fixture chunk is not paid
  // for in the real app boot path.  The App render below is unchanged for any
  // other URL.
  void import("./components/VoiceSettingsVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "call-button") {
  // Visual-spec harness: dynamically import so the fixture chunk is not paid
  // for in the real app boot path.  The App render below is unchanged for any
  // other URL.
  void import("./components/CallButtonVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "karaoke") {
  // Visual-spec harness (tests/e2e/karaoke.visual.spec.ts): a reply being
  // read aloud, highlighted on the message itself.  Dynamically imported so
  // the real app boot path never pays for it.
  void import("./components/KaraokeVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "update-drain") {
  // Visual-spec harness (tests/e2e/update-drain.visual.spec.ts): the line a
  // chat shows while an update holds new work.  Dynamically imported so the
  // real app boot path never pays for it.
  void import("./components/UpdateDrainVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "routine-hold") {
  // Visual-spec harness: dynamically import so the fixture chunk is not paid
  // for in the real app boot path. The App render below is unchanged for any
  // other URL.
  void import("./components/RoutineHoldVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "routine-calendar-density") {
  // Visual-spec harness: the real calendar with the overlapping-run density
  // that used to paint every card into one unreadable pile.
  void import("./components/RoutineCalendarVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "bot-off") {
  // Visual-spec harness (tests/e2e/bot-off.visual.spec.ts): the bot On/Off
  // switch — sidebar rows, the Bot Profile card and the disabled composer.
  // Dynamically imported so the real app boot path never pays for it.
  void import("./components/BotOffVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "runtime-cards") {
  // Visual-spec harness: mounts the real LocalVmRuntimeCard and
  // SharedVpsRuntimeCard under a StoreContext with a hand-built
  // ConfigStatus.  The card and state are picked via URL params (see
  // RuntimeCardsVisualFixture.tsx).
  void import("./components/RuntimeCardsVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "linux-local-control") {
  // Visual-spec harness: Linux Local Control copy and casing (see
  // LinuxLocalControlVisualFixture.tsx).
  void import("./components/LinuxLocalControlVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "kanban-command-center") {
  // Visual-spec harness: dynamically import so the fixture chunk is not paid
  // for in the real app boot path.  The App render below is unchanged for any
  // other URL.  Drive state with ?state=populated|empty|filtered.
  void import("./components/KanbanCommandCenterVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "fleet-matrix-view") {
  // Visual-spec harness: dynamically import so the fixture chunk is not paid
  // for in the real app boot path.  Drives the FleetMatrixView's view-mode
  // switch (matrix grid vs kanban board) for visual coverage of both modes.
  void import("./components/FleetMatrixViewVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "usage-notices") {
  // Visual-spec harness (tests/e2e/usage-notices.visual.spec.ts): the held-bots
  // and shorter-fallback-chain notices from Settings → Usage → Engine Quotas.
  // Dynamically imported so the real app boot path never pays for it.
  void import("./components/UsageNoticesVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "conversation-mode-row") {
  // Visual-spec harness (tests/e2e/conversation-mode-row.visual.spec.ts):
  // Settings → Workspace Arrangement.  Pins the Projects-subtitle
  // interpolation (the lowercase room word) and the merge panel.
  void import("./components/ConversationModeRowVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "engine-marks") {
  // Visual-spec harness (tests/e2e/engine-marks.visual.spec.ts): the model
  // picker's engine rail, in a preset skin or in the Custom Palette whose main
  // text is its accent.  Dynamically imported so the fixture chunk is not paid
  // for in the real app boot path.
  void import("./components/EngineMarksVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "bypass-warning") {
  // Visual-spec harness (tests/e2e/bypass-warning.visual.spec.ts): the Permission
  // Bypass confirmation dialog, standard, high-risk model and busy.
  void import("./components/BypassPermissionsWarningVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "sign-in-card") {
  // Visual-spec harness (tests/e2e/sign-in-card.visual.spec.ts): the Sign in
  // needed card, open, with a persistent error, and after Done.
  void import("./components/SignInRequestCardVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "pending-approval-write-always") {
  // Visual-spec harness (tests/e2e/pending-approval-write-always.visual.spec.ts):
  // write-shaped MCP always-allow confirm dialog and approval action strip.
  void import("./components/PendingApprovalWriteAlwaysVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else if (fixtureParam === "settings-always-allow") {
  // Visual-spec harness (tests/e2e/settings-always-allow.visual.spec.ts):
  // Agent settings Always allowed empty and populated revoke list.
  void import("./components/SettingsAlwaysAllowVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
