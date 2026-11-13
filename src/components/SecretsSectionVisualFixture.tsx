import { useMemo, type Dispatch } from "react";
import { StoreContext, initialState, type Action, type AppState } from "@/state/store";
import { SecretsSection } from "./SecretsSection";

const noopDispatch: Dispatch<Action> = () => {};

export default function SecretsSectionVisualFixture() {
  const value = useMemo(() => {
    const state: AppState = {
      ...initialState,
      config: {
        ...initialState.config!,
        infisical: {
          configured: false,
          enabled: false,
          writeThrough: false,
          authMethod: "service-token",
          environment: "prod",
          hasClientSecret: false,
          hasToken: false,
          hasWriteToken: false,
          managedCount: 0,
          lastSyncAt: null,
          stale: false,
          hasError: false,
          pendingProviderReload: false,
        },
      },
    };
    return {
      state,
      dispatch: noopDispatch,
      flushBotPatches: async () => {},
      refreshInstances: async () => {},
    };
  }, []);

  return (
    <StoreContext.Provider value={value}>
      <main data-testid="secrets-section-fixture" className="bg-app p-6 text-ink" style={{ width: 760 }}>
        <SecretsSection />
      </main>
    </StoreContext.Provider>
  );
}
