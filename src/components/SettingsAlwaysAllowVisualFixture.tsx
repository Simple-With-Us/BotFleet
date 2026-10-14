// Test harness for tests/e2e/settings-always-allow.visual.spec.ts.
//
// Pins Agent settings → Always allowed empty and populated states.
// ?state=empty|populated (default empty).
import { z } from "zod";
import { BotAlwaysAllowCard } from "./BotAlwaysAllowCard";

const stateSchema = z.enum(["empty", "populated"]).catch("empty");

const SAMPLE_KEYS = [
  "provider-tool:claude:linear:list_issues:abc1234567890abcd",
  "provider-tool:claude:linear:create_issue:def4567890abcdef",
];

export default function SettingsAlwaysAllowVisualFixture() {
  const state = stateSchema.parse(new URLSearchParams(window.location.search).get("state"));
  const alwaysAllow = state === "populated" ? SAMPLE_KEYS : [];

  return (
    <div
      data-testid="settings-always-allow-fixture"
      data-fixture-state={state}
      className="w-[520px] bg-app p-4 text-ink"
    >
      <BotAlwaysAllowCard alwaysAllow={alwaysAllow} onRemove={noop} />
    </div>
  );
}

function noop() {}
