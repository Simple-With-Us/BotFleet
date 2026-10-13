// Visual harness for neutral Engine Settings facts and OpenAI-compatible visibility.
import { EngineCallout } from "./EngineCallout";
import { showBuiltInOpenAiCompatible } from "@/lib/engine-status";
import { ProviderMark } from "./ProviderIcons";

function EngineFactRow(props: {
  driverKind: string;
  name: string;
  models: readonly string[];
}) {
  return (
    <div className="border-b border-hairline/30 py-3 last:border-b-0">
      <div className="flex items-center gap-2 text-[13px] text-ink">
        <ProviderMark driverKind={props.driverKind} size={18} />
        <span className="font-medium">{props.name}</span>
      </div>
      <EngineCallout driverKind={props.driverKind} models={props.models} />
    </div>
  );
}

export default function EngineCalloutVisualFixture() {
  const openAiConfigured = showBuiltInOpenAiCompatible(true, "https://api.example.test/v1");
  const openAiHidden = showBuiltInOpenAiCompatible(false, "");

  return (
    <div
      data-testid="engine-settings-visibility-board"
      className="grid gap-5 bg-inset/30 p-6"
      style={{ background: "#f4f4f5", width: 640 }}
    >
      <section data-testid="openai-hidden-state" className="rounded-xl border border-hairline/40 bg-raised px-4">
        <h2 className="pt-3 text-[12px] font-medium uppercase tracking-wide text-ink-secondary">
          No OpenAI-Compatible Endpoint
        </h2>
        <EngineFactRow driverKind="codexAgent" name="Codex" models={["gpt-6.1-codex"]} />
        {openAiHidden && (
          <EngineFactRow driverKind="openai-compat" name="OpenAI-Compatible" models={[]} />
        )}
      </section>

      <section data-testid="openai-configured-state" className="rounded-xl border border-hairline/40 bg-raised px-4">
        <h2 className="pt-3 text-[12px] font-medium uppercase tracking-wide text-ink-secondary">
          Configured Endpoint
        </h2>
        <EngineFactRow driverKind="codexAgent" name="Codex" models={["gpt-6.1-codex"]} />
        {openAiConfigured && (
          <EngineFactRow
            driverKind="openai-compat"
            name="OpenAI-Compatible"
            models={["vendor/model-a", "vendor/model-b"]}
          />
        )}
      </section>
    </div>
  );
}
