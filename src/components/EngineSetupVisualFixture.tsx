// Test harness for tests/e2e/engine-setup.visual.spec.ts.
//
// Mounts the real EngineSetup card in the no-command installer state:
// the install descriptor exists, but this platform has no one-line command.
// The card is a pure render of that instance.  It does not talk to a bot
// server.
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
    // darwin only: hostPlatform() on the Playwright chromium lane is linux,
    // so installCommandFor returns null and the card shows the no-command
    // sentence instead of a command row.
    command: { darwin: "echo kimi-setup" },
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
