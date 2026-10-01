// What choosing an effort in the chat model menu actually saves, reached
// through the picker's own wiring rather than by reading its source.
//
// The Vite test environment is `node` and the repo carries no DOM library, so
// there is no click to make.  Instead the three hooks `ModelPicker` calls are
// stubbed (state stays at its initial value, effects never run) so the
// component function can be called directly.  It returns its element tree, and
// the Effort section's `onPick` in that tree is the very handler a click on a
// choice reaches: it runs the picker's real `commit`, which dispatches the
// store's `updateBot` action, the same one Settings' Reasoning control sends.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo, ModelSelection } from "@/state/store";

const harness = vi.hoisted(() => ({ dispatch: vi.fn(), instances: [] as unknown[] }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, () => {}],
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: () => {},
  };
});

vi.mock("@/state/store", () => ({
  useStore: () => ({
    state: { instances: harness.instances },
    dispatch: harness.dispatch,
    refreshInstances: async () => {},
  }),
}));

// Imported after the mocks are registered (vitest hoists vi.mock above imports).
import { EffortSection, ModelPicker } from "./ModelPicker";

const CLAUDE = {
  instanceId: "claude",
  driverKind: "claudeAgent",
  displayName: "Claude",
  snapshot: { state: "available", version: "1.0.0" },
  models: { default: "sonnet", options: [{ id: "sonnet", label: "Claude Sonnet" }] },
  capabilities: { effortLevels: ["low", "medium", "high"] },
} as unknown as InstanceInfo;

const FALLBACKS: ModelSelection["fallbacks"] = [{ instanceId: "codex", model: "gpt-5.4" }];

/** A bot floating on "Latest Sonnet" at low effort, with a fallback chain. */
const SELECTION: ModelSelection = {
  instanceId: "claude",
  model: "sonnet",
  latest: "sonnet",
  effort: "low",
  fallbacks: FALLBACKS,
};

function effortSectionProps(bot: Bot) {
  harness.instances = [CLAUDE];
  const tree = ModelPicker({ bot, initialOpen: true });
  const found = findElements(tree, (element) => element.type === EffortSection);
  expect(found, "the chat menu's Effort section").toHaveLength(1);
  return found[0].props as Parameters<typeof EffortSection>[0];
}

function findElements(node: ReactNode, match: (element: ReactElement) => boolean): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap((child) => findElements(child, match));
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [...(match(element) ? [element] : []), ...findElements(element.props.children, match)];
}

describe("Choosing an effort in the chat model menu", () => {
  it("saves an effort-only update that keeps a Latest selection floating and its fallbacks", () => {
    harness.dispatch.mockClear();
    const props = effortSectionProps({ id: "bot-1", modelSelection: SELECTION } as Bot);
    expect(props.current).toBe("low");
    expect(props.levels).toEqual(["low", "medium", "high"]);

    props.onPick("high");

    expect(harness.dispatch).toHaveBeenCalledTimes(1);
    const action = harness.dispatch.mock.calls[0][0];
    expect(action.type).toBe("updateBot");
    expect(action.botId).toBe("bot-1");
    expect(Object.keys(action.patch)).toEqual(["modelSelection"]);
    expect(action.patch.modelSelection).toMatchObject({
      instanceId: "claude",
      model: "sonnet",
      latest: "sonnet",
      effort: "high",
      fallbacks: FALLBACKS,
    });
  });

  it("saves Default as no effort, with the rest of the selection untouched", () => {
    harness.dispatch.mockClear();
    effortSectionProps({ id: "bot-1", modelSelection: SELECTION } as Bot).onPick(undefined);

    const saved = harness.dispatch.mock.calls[0][0].patch.modelSelection as ModelSelection;
    expect(saved.effort).toBeUndefined();
    expect(saved).toMatchObject({ model: "sonnet", latest: "sonnet", fallbacks: FALLBACKS });
  });

  it("does not touch the bot's stored selection object", () => {
    harness.dispatch.mockClear();
    const stored = { ...SELECTION };
    effortSectionProps({ id: "bot-1", modelSelection: stored } as Bot).onPick("medium");
    expect(stored.effort).toBe("low");
  });

  it("holds the choices only while the bot is working", () => {
    expect(effortSectionProps({ id: "bot-1", modelSelection: SELECTION } as Bot).disabled).toBe(false);
    expect(effortSectionProps({ id: "bot-1", modelSelection: SELECTION, busy: true } as Bot).disabled).toBe(true);
  });
});
