// Test harness for tests/e2e/delegation-card.visual.spec.ts.
//
// Mounts DelegationCard with a fixed delegation view and progress line.
import { StoreProvider } from "@/state/store";
import { DelegationCard } from "./DelegationCard";

const view = {
  senderName: "Scout",
  reason: "Need a second pair of eyes on the rollout",
  payload: "Please verify the helper cards on the staging bot.",
  headline: "Delegated by @Scout",
  subtitle: "Reason: Need a second pair of eyes on the rollout",
};

export default function DelegationCardVisualFixture() {
  return (
    <StoreProvider>
      <div data-testid="delegation-card-fixture" className="min-h-screen bg-app p-6 text-ink">
        <DelegationCard view={view} progress="Working · Read · notes.md · 2 tools" />
      </div>
    </StoreProvider>
  );
}
