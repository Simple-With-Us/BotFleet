// Test harness for tests/e2e/call-button.visual.spec.ts.
//
// Mounts the real CallTargetButton (src/components/CallView.tsx) for a bot
// whose only voice is an Apple Personal Voice, on a desktop bridge that
// reports Personal Voice as not speakable.  The button then paints the
// Personal Voice denial in its label and in its Call Unavailable popover.
//
// `&reason=requires-macos-14` (default): a Mac older than macOS 14.
// `&reason=non-apple`: no reason code, so the popover says Personal Voice
// speaks on Apple devices.
import { useEffect } from "react";
import { CallTargetButton } from "./CallView";
import { DesktopCapabilitiesProvider } from "./DesktopCapabilities";
import { personalVoiceDesktopBridge } from "./VoiceSettingsVisualFixture";
import { StoreProvider, useStore, type ConfigStatus } from "@/state/store";

const reasonParam = globalThis.window ? new URLSearchParams(window.location.search).get("reason") : null;
const nonApple = reasonParam === "non-apple";

function dictationCapabilities(): DesktopCapabilities["dictation"] {
  const base = { available: true, engine: "apple-speech", onDevice: true, personalVoice: false } as const;
  if (nonApple) return base;
  return { ...base, reasonCode: "requires-macos-14" };
}

const capabilities: DesktopCapabilities = {
  host: { platform: "darwin", label: "macOS", session: "unknown", packaged: true },
  windowChrome: "mac-inset",
  screenPreview: { available: false, interaction: "none", reasonCode: "desktop-app-required" },
  dictation: dictationCapabilities(),
  localComputer: {
    available: false,
    support: "unsupported",
    enabled: false,
    status: "unavailable",
    reasonCode: "desktop-app-required",
  },
};

// Set after the import of VoiceSettingsVisualFixture, which installs its own
// default bridge as a side effect: this fixture states its capabilities
// explicitly instead of inheriting that default.
if (globalThis.window) {
  window.ogb = personalVoiceDesktopBridge({ capabilities });
}

const configuredTts: ConfigStatus = {
  composio: { configured: false },
  box: { configured: false },
  vps: { configured: false, sshAlias: "" },
  rooms: { turnTimeoutMinutes: 30 },
  localVm: { mode: "shared", maxInstances: 1 },
  tts: { provider: "minimax", configured: true, ready: true, voice: "fixture-hosted-voice" },
};

function Board() {
  const { state, dispatch } = useStore();
  useEffect(() => {
    dispatch({ type: "configStatus", config: configuredTts });
  }, [dispatch]);

  if (!state.config?.tts) {
    return <div data-testid="call-button-board">Loading call button…</div>;
  }

  // The popover is absolutely positioned under the button, so the board is
  // tall enough to hold it and the screenshot frames both.
  return (
    <div
      data-testid="call-button-board"
      style={{ background: "#f4f4f5", padding: 24, width: 420, height: 260, display: "flex", justifyContent: "flex-end" }}
    >
      <CallTargetButton
        targetId="bot-visual"
        targetName="Assistant"
        voices={["personal:fixture-voice"]}
        requireExplicitVoices={false}
        onStart={() => {}}
      />
    </div>
  );
}

export default function CallButtonVisualFixture() {
  return (
    <StoreProvider>
      <DesktopCapabilitiesProvider>
        <Board />
      </DesktopCapabilitiesProvider>
    </StoreProvider>
  );
}
