// Test harness for tests/e2e/bypass-local-computer.visual.spec.ts.
//
// Pins the Bypass Including This Mac switch: off, on, disabled until Bypass
// Permissions is on, and the warning that stands in front of turning it on.
// ?state=off|on|disabled|warning (default off).  The control and the warning
// copy are the same modules SettingsPanel renders.
import { z } from "zod";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import {
  BYPASS_LOCAL_COMPUTER_WARNING_BODY,
  BYPASS_LOCAL_COMPUTER_WARNING_TITLE,
  BypassLocalComputerControl,
} from "./BypassLocalComputerControl";

const stateSchema = z.enum(["off", "on", "disabled", "warning"]).catch("off");

const noop = () => {};

export default function BypassLocalComputerVisualFixture() {
  const state = stateSchema.parse(new URLSearchParams(window.location.search).get("state"));
  const bypassPermissions = state !== "disabled";
  const bypassLocalComputer = state === "on";
  return (
    <div
      data-testid="bypass-local-computer-fixture"
      data-fixture-state={state}
      className="min-h-screen bg-app p-6 text-ink"
    >
      <div data-testid="bypass-local-computer-card" className="w-[520px] rounded-xl bg-card p-4">
        <BypassLocalComputerControl
          bypassPermissions={bypassPermissions}
          bypassLocalComputer={bypassLocalComputer}
          onTurnOff={noop}
          onRequestOn={noop}
        />
      </div>
      <LocalComputerAutoWarning
        open={state === "warning"}
        title={BYPASS_LOCAL_COMPUTER_WARNING_TITLE}
        body={BYPASS_LOCAL_COMPUTER_WARNING_BODY}
        onCancel={noop}
        onConfirm={noop}
      />
    </div>
  );
}
