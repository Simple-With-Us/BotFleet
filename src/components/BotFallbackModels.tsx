// A bot's fallback models, as the per-bot settings panel draws them.
//
// Every entry the bot stores gets a row, however many that is: a chain longer
// than the cap (written through the API before the cap existed) must still be
// visible and removable from here, or it keeps running with nobody able to
// see it.  Only the Add control is gated on the cap, through the same shared
// constant the Models page and the iOS profile read.
import type { Bot, ModelSelection } from "@/state/store";
import { canAddFallback } from "../../shared/model-limits";
import { ModelPicker } from "./ModelPicker";

export function BotFallbackModels({
  bot,
  onChange,
}: {
  bot: Bot;
  /** Receives the bot's whole model selection with its new fallbacks. */
  onChange: (selection: ModelSelection) => void;
}) {
  const fallbacks = bot.modelSelection.fallbacks ?? [];
  const save = (next: ModelSelection[]) => onChange({ ...bot.modelSelection, fallbacks: next });

  return (
    <>
      {fallbacks.map((fallback, i) => (
        <div key={i} className="flex flex-col gap-2 pt-4 border-t border-hairline/40">
          <div className="flex items-center justify-between">
            <div className="text-[13px] font-medium text-ink">Fallback #{i + 1}</div>
            <button
              onClick={() => {
                const next = [...fallbacks];
                next.splice(i, 1);
                save(next);
              }}
              className="text-[12px] text-red-500 hover:underline"
            >
              Remove
            </button>
          </div>
          <ModelPicker
            bot={bot}
            contained
            selection={fallback}
            onChange={(sel) => {
              const next = [...fallbacks];
              next[i] = sel;
              save(next);
            }}
          />
        </div>
      ))}

      {canAddFallback(fallbacks.length) && (
        <button
          onClick={() =>
            save([
              ...fallbacks,
              { instanceId: bot.modelSelection.instanceId, model: bot.modelSelection.model },
            ])
          }
          className="mt-2 text-left text-[13px] text-blue-500 hover:underline"
        >
          Add Fallback Model
        </button>
      )}
    </>
  );
}
