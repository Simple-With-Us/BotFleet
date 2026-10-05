// Test harness for tests/e2e/host-cli-integration.visual.spec.ts.
//
// Mounts the real HostCliIntegrationCard with a fixed config snapshot.
// StoreProvider is not used: it would hydrate from the bot server and
// replace this state. The card does not fetch on mount.
import { useMemo, type Dispatch } from "react";
import { HostCliIntegrationCard } from "./HostCliIntegrationCard";
import { initialState, StoreContext, type Action, type ConfigStatus } from "@/state/store";

export default function HostCliIntegrationCardVisualFixture() {
  const value = useMemo(
    () => ({
      state: {
        ...initialState,
        config: {
          localVm: {
            mode: "shared",
            maxInstances: 1,
            shareCliCredentials: true,
            allowHostTerminal: false,
          },
        } as ConfigStatus,
      },
      dispatch: (() => {}) as Dispatch<Action>,
      flushBotPatches: async () => {},
      refreshInstances: async () => {},
    }),
    [],
  );

  return (
    <StoreContext.Provider value={value}>
      <div
        data-testid="host-cli-integration-board"
        style={{ background: "#f4f4f5", padding: 24, width: 720 }}
      >
        <HostCliIntegrationCard />
      </div>
    </StoreContext.Provider>
  );
}
