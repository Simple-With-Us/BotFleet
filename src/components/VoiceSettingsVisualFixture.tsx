// Test harness for tests/e2e/voice-settings-personal-voice.visual.spec.ts.
//
// Mounts the real VoiceSettings card with the desktop bridge reporting that
// Personal Voice cannot be spoken (macOS older than 14).  The spec then
// submits a personal: voice id through Add Voice ID.  commitVoice is what
// paints the denial; this file does not pre-render that error.
import { useEffect, useState } from "react";
import { DesktopCapabilitiesProvider, useDesktopCapabilities } from "./DesktopCapabilities";
import { VoiceSettings } from "./VoiceSettings";
import { StoreProvider, useStore, type Bot, type ConfigStatus } from "@/state/store";

const deniedCapabilities: DesktopCapabilities = {
  host: {
    platform: "darwin",
    label: "macOS",
    session: "unknown",
    packaged: true,
  },
  windowChrome: "mac-inset",
  screenPreview: {
    available: false,
    interaction: "none",
    reasonCode: "desktop-app-required",
  },
  dictation: {
    available: true,
    engine: "apple-speech",
    onDevice: true,
    personalVoice: false,
    reasonCode: "requires-macos-14",
  },
  localComputer: {
    available: false,
    support: "unsupported",
    enabled: false,
    status: "unavailable",
    reasonCode: "desktop-app-required",
  },
};

const unavailableLocalControl = {
  enabled: false,
  status: "unavailable" as const,
};

// A complete desktop bridge, not a cast.  The visual lane and the unit tests
// both need personalVoice.speak (and getCapabilities) to type-check as the
// real preload contract.  Missing a required method is a type error.
export function personalVoiceDesktopBridge(over: {
  capabilities?: DesktopCapabilities;
  speak?: (text: string, voiceId?: string) => Promise<void>;
} = {}): NonNullable<Window["ogb"]> {
  const capabilities = over.capabilities ?? deniedCapabilities;
  const unsubscribe = () => {};
  return {
    platform: "darwin",
    getCapabilities: () => Promise.resolve(capabilities),
    onCapabilitiesChanged: () => unsubscribe,
    localControl: {
      status: () => Promise.resolve(unavailableLocalControl),
      enable: () => Promise.resolve(unavailableLocalControl),
      disable: () => Promise.resolve(unavailableLocalControl),
      retry: () => Promise.resolve(unavailableLocalControl),
    },
    beginScreenPreviewIntent: () => false,
    screenFrame: () => Promise.resolve(null),
    speechStart: () => Promise.resolve(),
    speechStop: () => Promise.resolve(),
    onSpeechTranscript: () => unsubscribe,
    onSpeechEnd: () => unsubscribe,
    personalVoice: {
      isAvailable: () => Promise.resolve(capabilities.dictation.personalVoice === true),
      list: () => Promise.resolve([]),
      speak: over.speak ?? (() => Promise.resolve()),
      stop: () => Promise.resolve(),
    },
    permStatus: () => Promise.resolve({ mic: "unknown" }),
    permRequestMic: () => Promise.resolve(false),
    permOpenSettings: () => Promise.resolve(),
  };
}

// Installed before DesktopCapabilitiesProvider mounts.  Playwright's chromium
// lane has no Electron bridge, so without this stub the card would deny with
// the browser reason instead of the macOS 14 sentence this path exists for.
if (typeof window !== "undefined" && !window.ogb) {
  window.ogb = personalVoiceDesktopBridge();
}

const configuredTts: ConfigStatus = {
  composio: { configured: false },
  box: { configured: false },
  vps: { configured: false, sshAlias: "" },
  rooms: { turnTimeoutMinutes: 30 },
  localVm: { mode: "shared", maxInstances: 1 },
  tts: { provider: "minimax", configured: true, ready: true, voice: "standard-default" },
};

function CapabilitiesFlag() {
  const { ready, capabilities } = useDesktopCapabilities();
  return (
    <div
      data-testid="personal-voice-capabilities"
      data-ready={ready ? "true" : "false"}
      data-personal-voice={capabilities.dictation.personalVoice === true ? "true" : "false"}
      data-reason={capabilities.dictation.reasonCode ?? ""}
      hidden
    />
  );
}

function VoiceCard() {
  const { state, dispatch } = useStore();
  const [voice, setVoice] = useState("");

  useEffect(() => {
    dispatch({ type: "configStatus", config: configuredTts });
  }, [dispatch]);

  if (!state.config?.tts) {
    return <div data-testid="voice-settings-board">Loading voice settings…</div>;
  }

  // satisfies Bot checks the fixture against the app's Bot contract.
  // `as Bot` would let a missing or mistyped field through.
  const bot = {
    id: "bot-visual",
    name: "Assistant",
    threadId: "t-visual",
    title: "",
    description: "",
    notifications: false,
    color: "blue",
    unread: false,
    modelSelection: { instanceId: "fixture", model: "default" },
    messages: [],
    voice,
  } satisfies Bot;

  return (
    <div
      data-testid="voice-settings-board"
      style={{ background: "#f4f4f5", padding: 24, width: 560 }}
    >
      <CapabilitiesFlag />
      <VoiceSettings
        bot={bot}
        onPatch={(patch) => {
          if (typeof patch.voice === "string") setVoice(patch.voice);
        }}
      />
    </div>
  );
}

export default function VoiceSettingsVisualFixture() {
  return (
    <StoreProvider>
      <DesktopCapabilitiesProvider>
        <VoiceCard />
      </DesktopCapabilitiesProvider>
    </StoreProvider>
  );
}
