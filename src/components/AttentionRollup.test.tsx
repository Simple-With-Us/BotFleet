// The fleet rollup on both of its surfaces: the All Apps tab in the App Deck and
// the header pills in the Fleet Matrix.  Every bot here belongs to all three
// rooms, so a total that adds the per-room counts would read 3 for each state.
// SSR style, as the rest of this repo's component tests do.
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  StoreContext,
  initialState,
  type AppState,
  type Bot,
  type Group,
} from "@/state/store";
import { AppDeck } from "./AppDeck";
import { FleetMatrixView } from "./FleetMatrixView";

function bot(id: string, name: string, activity: Bot["activity"], unread = false): Bot {
  return {
    id,
    threadId: `${id}-thread`,
    name,
    title: name,
    description: "",
    notifications: false,
    color: "blue",
    unread,
    activity,
    modelSelection: { instanceId: "claude", model: "claude-sonnet" },
    messages: [],
  };
}

function room(id: string, name: string, memberIds: string[]): Group {
  return {
    id,
    threadId: `${id}-thread`,
    name,
    memberIds,
    defaultResponder: { kind: "everyone" },
    bulletin: "",
    unread: false,
    createdAt: 0,
    messages: [],
  };
}

/** One bot in each state the pills count, all members of all three rooms. */
function sharedBotsState(): AppState {
  const memberIds = ["bot-dead", "bot-waiting", "bot-working", "bot-reader"];
  return {
    ...initialState,
    bots: [
      bot("bot-dead", "Crashy", "dead"),
      bot("bot-waiting", "Approver", "waiting-on-you"),
      bot("bot-working", "Builder", "working"),
      bot("bot-reader", "Reader", "idle", true),
    ],
    groups: [
      room("room-a", "Ops", memberIds),
      room("room-b", "Tools", memberIds),
      room("room-c", "Docs", memberIds),
    ],
  };
}

function render(state: AppState, child: ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      StoreContext.Provider,
      {
        value: {
          state,
          dispatch: () => {},
          flushBotPatches: async () => {},
          refreshInstances: async () => {},
        },
      },
      child,
    ),
  );
}

describe("fleet rollup counts each bot once", () => {
  it("shows one of each state in the Fleet Matrix header pills", () => {
    const html = render(
      sharedBotsState(),
      createElement(FleetMatrixView, {
        onSelectApp: () => {},
        onSelectBot: () => {},
        onOpenAppRoom: () => {},
        onSelectBotInApp: () => {},
      }),
    );

    expect(html).toContain("1 Errors");
    expect(html).toContain("1 Needs Action");
    expect(html).toContain("1 Working");
    expect(html).toContain("1 Unread");
    for (const label of ["Errors", "Needs Action", "Working", "Unread"]) {
      expect(html).not.toContain(`3 ${label}`);
    }
  });

  it("shows one of each state on the All Apps tab, while each app chip keeps its own count", () => {
    const html = render(
      sharedBotsState(),
      createElement(AppDeck, { activeAppId: null, onSelectApp: () => {} }),
    );

    const rollup = (pattern: RegExp) => html.match(pattern)?.[1];
    expect(rollup(/title="(\d+) unresolved errors across/)).toBe("1");
    expect(rollup(/title="(\d+) bots? waiting for your action"/)).toBe("1");
    expect(rollup(/title="(\d+) bots? working"/)).toBe("1");
    expect(rollup(/title="(\d+) unread updates"/)).toBe("1");

    // The per-app chips are per room and still show the shared bot in each one.
    expect(html.split('title="Working: Builder"').length - 1).toBe(3);
  });
});
