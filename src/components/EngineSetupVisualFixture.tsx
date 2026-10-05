// Test harness for tests/e2e/engine-setup.visual.spec.ts.
//
// Mounts the real EngineSetup card in the no-command installer state.
// The install descriptor is present, but `command` is omitted so
// installCommandFor returns null on every host: darwin, win32, and linux,
// whether the platform comes from window.ogb or the user agent. A
// darwin-only command rendered CommandRow on macOS and skipped the sentence
// this spec exists to capture. The card does not talk to a bot server.
import { EngineSetup } from "./EngineSetup";
import type { InstanceInfo } from "@/state/store";

const noCommandInstaller: InstanceInfo = {
  instanceId: "kimi",
  driverKind: "kimiAgent",
  displayName: "Kimi",
  models: { default: "kimi-code/k3", options: [] },
  snapshot: { state: "unavailable", reason: "kimi CLI not found" },
  install: {
    docsUrl: "https://example.com/kimi-setup",
  },
};

export default function EngineSetupVisualFixture() {
  return (
    <div
      data-testid="engine-setup-board"
      style={{ background: "#f4f4f5", padding: 24, width: 420 }}
    >
      <EngineSetup instance={noCommandInstaller} />
    </div>
  );
}
