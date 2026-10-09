// Test harness for tests/e2e/usage-notices.visual.spec.ts.
//
// Mounts the real HeldBotsNotice and RedundantChainsNotice (the two notices
// UsageSection draws at the top of Engine Quotas) inside the same Card, with
// fixed data, so the spec pins what an owner reads when scheduled work is held
// or a fallback chain is shorter than the picker shows.  Two states: several
// bots (plural headings) and exactly one bot (singular headings).  Nothing
// here talks to a server, so the spec needs no route mocking.
import { HeldBotsNotice, RedundantChainsNotice } from "../../site/src/components/UsageNotices";
import { Card } from "./SettingsPrimitives";
import type { DoomedPair, RedundantChain } from "./UsageSection";

const OPENED_AT = 1_781_526_600_000;

const ATLAS = "3f9a1c2e-5b7d-4e80-9a11-0c2d4e6f8a10";
const SCOUT = "7b2d4e6f-1c3a-4b59-8d22-9e0f1a2b3c4d";

const held: DoomedPair[] = [
  {
    botId: ATLAS,
    instanceId: "dsh",
    consecutiveFailures: 3,
    openedAt: OPENED_AT,
    lastFailureAt: OPENED_AT,
    lastError: "DeepSeek Harness is not signed in",
    holds: true,
  },
  {
    botId: SCOUT,
    instanceId: "grok",
    consecutiveFailures: 5,
    openedAt: OPENED_AT,
    lastFailureAt: OPENED_AT,
    holds: true,
  },
];

const redundant: RedundantChain[] = [
  {
    botId: ATLAS,
    name: "Atlas",
    total: 3,
    effective: 2,
    redundant: [{ instanceId: "dsh", model: "deepseek-v4", reason: "same-as-primary" }],
  },
  {
    botId: ATLAS,
    name: "Atlas",
    scope: "task",
    threadId: "9c1e5a77-2d40-4f6b-8a13-5b6c7d8e9f01",
    total: 2,
    effective: 1,
    redundant: [{ instanceId: "grok", model: "grok-4", reason: "duplicate" }],
  },
  {
    botId: SCOUT,
    name: "Scout",
    total: 4,
    effective: 3,
    redundant: [{ instanceId: "claude", model: "claude-sonnet-4.5", reason: "duplicate" }],
  },
];

function Notices({ heldPairs, chains }: { heldPairs: DoomedPair[]; chains: RedundantChain[] }) {
  return (
    <Card title="Engine Quotas" subtitle="Live remaining usage for each engine.">
      <HeldBotsNotice heldPairs={heldPairs} />
      <RedundantChainsNotice redundantChains={chains} />
    </Card>
  );
}

export default function UsageNoticesVisualFixture() {
  return (
    <div data-testid="usage-notices-fixture" className="flex w-[520px] flex-col gap-4 bg-app p-4 text-ink">
      <section data-testid="usage-notices-plural" aria-label="Several bots">
        <Notices heldPairs={held} chains={redundant} />
      </section>
      <section data-testid="usage-notices-singular" aria-label="One bot">
        <Notices heldPairs={held.slice(0, 1)} chains={redundant.slice(0, 2)} />
      </section>
    </div>
  );
}
