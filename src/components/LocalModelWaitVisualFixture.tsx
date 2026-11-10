import { useMemo, useState } from "react";
import { initialState, StoreContext, type Action, type InstanceInfo } from "@/state/store";
import { EngineRow } from "./EnginesSettings";

const initialInstance: InstanceInfo = {
  instanceId: "custom-ollama-local",
  driverKind: "openai-compat",
  displayName: "Ollama Local",
  enabled: true,
  localModelWaitAvailable: true,
  replyWaitMinutes: 20,
  snapshot: { state: "available", authenticated: true },
  models: { default: "fixture-model", options: [{ id: "fixture-model", label: "Fixture Model" }] },
};

export default function LocalModelWaitVisualFixture() {
  const [instance, setInstance] = useState(initialInstance);
  const value = useMemo(() => ({
    state: { ...initialState, instances: [instance] },
    dispatch: (_action: Action) => undefined,
    flushBotPatches: async () => undefined,
    refreshInstances: async () => undefined,
  }), [instance]);

  return (
    <StoreContext.Provider value={value}>
      <main data-testid="local-model-wait-board" className="bg-panel p-6" style={{ width: 720 }}>
        <h1 className="mb-3 text-[15px] font-semibold text-ink">Engine Settings</h1>
        <EngineRow
          instance={instance}
          busyInstanceId={null}
          onPatch={async (patch) => {
            setInstance((current) => {
              const next = { ...current };
              const replyWaitMinutes = patch.replyWaitMinutes;
              if (replyWaitMinutes === null) {
                delete next.replyWaitMinutes;
              } else if (replyWaitMinutes !== undefined) {
                next.replyWaitMinutes = replyWaitMinutes;
              }
              return next;
            });
            return { ok: true };
          }}
        />
        <output data-testid="local-model-wait-state" className="sr-only">
          {instance.replyWaitMinutes ?? "default"}
        </output>
      </main>
    </StoreContext.Provider>
  );
}
