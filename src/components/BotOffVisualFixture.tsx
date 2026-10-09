// Test harness for tests/e2e/bot-off.visual.spec.ts.
//
// Mounts the real pieces of the bot On/Off switch under a fixed store:
//   - two real sidebar rows (BotListItem), one On and one Off, in the roomy and
//     the icon-only densities, so the dimmed avatar and the "Off" label are
//     pinned where the owner actually sees them;
//   - the real On/Off card from the Bot Profile panel in both states;
//   - the real disabled composer an Off bot shows instead of its input.
//
// StoreProvider is not used: it hydrates from the bot server and would replace
// these fixed bots.  Nothing here talks to a server, so the spec needs no
// route mocking.  Dispatch is swallowed because the shot clicks nothing.
import { useMemo, type Dispatch } from "react";
import { BotListItem } from "./Sidebar";
import { BotOffComposer } from "./BotOffComposer";
import { BotPowerToggle } from "./BotPowerToggle";
import { initialState, StoreContext, type Action, type Bot } from "@/state/store";

const base: Omit<Bot, "id" | "threadId" | "name" | "title" | "color"> = {
  description: "",
  notifications: false,
  unread: false,
  modelSelection: { instanceId: "dsh", model: "deepseek-v4" },
  messages: [],
  createdAt: 1_781_526_600_000,
};

const awake: Bot = {
  ...base,
  id: "visual-on",
  threadId: "visual-on-thread",
  name: "Atlas",
  title: "Operator",
  color: "blue",
};

const asleep: Bot = {
  ...base,
  id: "visual-off",
  threadId: "visual-off-thread",
  name: "Scout",
  title: "Sentry triage",
  color: "green",
  off: true,
};

const noop = () => {};

export default function BotOffVisualFixture() {
  const value = useMemo(
    () => ({
      state: { ...initialState, bots: [awake, asleep], selectedId: awake.id },
      // SAFETY: nothing in this shot is clicked; a throwaway dispatch keeps the
      // store contract satisfied without a server.
      dispatch: (() => {}) as Dispatch<Action>,
      flushBotPatches: async () => {},
      refreshInstances: async () => {},
    }),
    [],
  );

  return (
    <StoreContext.Provider value={value}>
      <div data-testid="bot-off-fixture" className="flex w-[420px] flex-col gap-4 bg-app p-4 text-ink">
        <section aria-label="Sidebar rows" className="flex flex-col gap-1 rounded-xl bg-card p-2">
          {[awake, asleep].map((bot) => (
            <BotListItem key={bot.id} bot={bot} density="comfortable" onMenu={noop} onArchive={noop} archiveDisabled />
          ))}
          <div className="flex items-center gap-2 px-2 pt-1">
            {[awake, asleep].map((bot) => (
              <div key={bot.id} className="w-[64px]">
                <BotListItem bot={bot} density="icons" onMenu={noop} onArchive={noop} archiveDisabled />
              </div>
            ))}
          </div>
        </section>
        <section aria-label="Bot Profile switch" className="flex flex-col gap-3">
          <BotPowerToggle off={false} onChange={noop} />
          <BotPowerToggle off onChange={noop} />
        </section>
        <section aria-label="Composer" className="-mx-5 -mb-3">
          <BotOffComposer botName={asleep.name} onTurnOn={noop} />
        </section>
      </div>
    </StoreContext.Provider>
  );
}
