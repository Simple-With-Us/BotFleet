// Test harness for tests/e2e/linux-local-control.visual.spec.ts.
//
// Mounts the real LinuxLocalControl card with a Linux desktop bridge stub.
// Playwright's chromium lane has no Electron preload, so without this stub the
// section would not render (platform !== "linux").  URL param `state` picks
// the user-visible face this PR's copy and casing work targets:
//
//   off              — disabled, Enable Local Control (Beta)
//   wayland          — Wayland safety block, This Computer sentence
//   needs-attention  — enabled but not ready, Try Again / Disable Local Control
//   ready            — ready badge and bundled driver line
import { z } from "zod";
import { DesktopCapabilitiesProvider } from "./DesktopCapabilities";
import { LinuxLocalControl } from "./LinuxLocalControl";

const FixtureStateSchema = z.enum(["off", "wayland", "needs-attention", "ready"]);
type FixtureState = z.infer<typeof FixtureStateSchema>;

function parseState(raw: string | null): FixtureState {
  const parsed = FixtureStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : "off";
}

function capabilitiesFor(state: FixtureState): DesktopCapabilities {
  const session = state === "wayland" ? ("wayland" as const) : ("x11" as const);
  const host = {
    platform: "linux" as const,
    label: "Linux",
    session,
    packaged: true,
  };
  const shell: Omit<DesktopCapabilities, "localComputer"> = {
    host,
    windowChrome: "native",
    screenPreview: {
      available: false,
      interaction: "none",
      reasonCode: "desktop-app-required",
    },
    dictation: {
      available: false,
      engine: "none",
      onDevice: false,
      reasonCode: "unsupported-platform",
    },
  };

  switch (state) {
    case "wayland":
      return {
        ...shell,
        localComputer: {
          available: false,
          support: "limited",
          enabled: false,
          status: "unavailable",
          reasonCode: "linux-wayland-seat-safety-blocked",
        },
      };
    case "needs-attention":
      return {
        ...shell,
        localComputer: {
          available: false,
          support: "supported",
          enabled: true,
          status: "error",
          message: "Computer Driver could not connect to the X11 session.",
          driverPath: "/opt/botfleet/cua-bridge",
          driverVersion: "0.19.3",
          driverSource: "bundled",
        },
      };
    case "ready":
      return {
        ...shell,
        localComputer: {
          available: true,
          support: "supported",
          enabled: true,
          status: "ready",
          driverPath: "/opt/botfleet/cua-bridge",
          driverVersion: "0.19.3",
          driverSource: "bundled",
        },
      };
    case "off":
    default:
      return {
        ...shell,
        localComputer: {
          available: false,
          support: "supported",
          enabled: false,
          status: "disabled",
        },
      };
  }
}

const unavailableLocalControl = {
  enabled: false,
  status: "unavailable" as const,
};

function linuxLocalControlDesktopBridge(): NonNullable<Window["ogb"]> {
  const unsubscribe = () => {};
  return {
    platform: "linux",
    getCapabilities: () => {
      const state = parseState(new URLSearchParams(window.location.search).get("state"));
      return Promise.resolve(capabilitiesFor(state));
    },
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
      isAvailable: () => Promise.resolve(false),
      list: () => Promise.resolve([]),
      speak: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    },
    permStatus: () => Promise.resolve({ mic: "unknown" }),
    permRequestMic: () => Promise.resolve(false),
    permOpenSettings: () => Promise.resolve(),
  };
}

if (typeof window !== "undefined" && !window.ogb) {
  window.ogb = linuxLocalControlDesktopBridge();
}

export default function LinuxLocalControlVisualFixture() {
  return (
    <DesktopCapabilitiesProvider>
      <div
        data-testid="linux-local-control-board"
        style={{ width: 440, padding: 16, background: "#f4f4f5" }}
      >
        <LinuxLocalControl />
      </div>
    </DesktopCapabilitiesProvider>
  );
}
