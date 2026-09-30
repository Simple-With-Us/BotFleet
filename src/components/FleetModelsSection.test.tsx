// What the Models page draws for a bot's fallbacks, and for the Apply to All
// Bots block.  SSR style, as the rest of this repo's component tests do: the
// store and the model picker are stubbed so the test sees only this file's
// own layout decisions.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ bots: [] as unknown[] }));

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: { bots: hoisted.bots, instances: [] },
      dispatch: vi.fn(),
    }),
  };
});

vi.mock("./ModelPicker", async () => {
  const { createElement: h } = await import("react");
  return {
    ModelPicker: (props: { selection: { model: string } }) =>
      h("span", { "data-picker": props.selection.model }),
  };
});

vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

import { FleetModelsSection } from "./FleetModelsSection";
import { MAX_MODEL_FALLBACKS } from "../../shared/model-limits";
import type { Bot } from "@/state/store";

const FILTER_MARKER = 'aria-label="Filter Bots by Name or Model"';

function bot(id: string, fallbackModels: string[]): Bot {
  return {
    id,
    name: `Bot ${id}`,
    modelSelection: {
      instanceId: "claude",
      model: "primary-model",
      fallbacks: fallbackModels.map((model) => ({ instanceId: "codex", model })),
    },
  } as unknown as Bot;
}

/** The Apply to All Bots block, and the per-bot rows beneath the filter. */
function render(bots: Bot[]): { block: string; rows: string } {
  hoisted.bots = bots;
  const html = renderToStaticMarkup(createElement(FleetModelsSection));
  const [block, rows] = html.split(FILTER_MARKER);
  return { block: block ?? "", rows: rows ?? "" };
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

beforeEach(() => {
  hoisted.bots = [];
});

describe("Models page fallback rows", () => {
  it("offers Add for the first place when a bot has no fallbacks", () => {
    const { rows } = render([bot("a", [])]);
    expect(count(rows, "Add Fallback")).toBe(1);
    expect(rows).toContain(">Fallback 1<");
    expect(rows).not.toContain(">Fallback 2<");
  });

  it("draws the stored entries and then the next place to add", () => {
    const { rows } = render([bot("a", ["m1", "m2"])]);
    expect(rows).toContain('data-picker="m1"');
    expect(rows).toContain('data-picker="m2"');
    expect(rows).toContain(">Fallback 3<");
    expect(count(rows, "Add Fallback")).toBe(1);
  });

  it("draws all three stored fallbacks and stops offering Add", () => {
    // This is the owner's Deployer: a third fallback that used to be hidden
    // because the row only ever drew two places.
    const { rows } = render([bot("a", ["m1", "m2", "m3"])]);
    for (const model of ["m1", "m2", "m3"]) expect(rows).toContain(`data-picker="${model}"`);
    expect(rows).toContain(">Fallback 3<");
    expect(rows).not.toContain(">Fallback 4<");
    expect(rows).not.toContain("Add Fallback");
  });

  it("still draws every entry of a chain stored past the cap", () => {
    const { rows } = render([bot("a", ["m1", "m2", "m3", "m4", "m5"])]);
    for (const model of ["m1", "m2", "m3", "m4", "m5"]) expect(rows).toContain(`data-picker="${model}"`);
    expect(rows).toContain(">Fallback 5<");
    expect(rows).not.toContain("Add Fallback");
  });

  it("gives every stored fallback its own Remove control", () => {
    const { rows } = render([bot("a", ["m1", "m2", "m3", "m4"])]);
    for (let n = 1; n <= 4; n++) expect(rows).toContain(`Remove Fallback ${n} from Bot a`);
  });

  it("uses the shared cap rather than a number of its own", () => {
    expect(MAX_MODEL_FALLBACKS).toBe(3);
    const { rows } = render([bot("a", []), bot("b", ["m1", "m2", "m3"])]);
    // One Add pill for the empty bot; none for the bot that is full.
    expect(count(rows, "Add Fallback")).toBe(1);
  });
});

describe("Apply to All Bots block", () => {
  it("is named for what it does, not as a stored default", () => {
    const { block } = render([bot("a", [])]);
    expect(block).toContain("Apply to All Bots");
    expect(block).not.toContain("Workspace Default");
    expect(block).toContain("not a saved default");
  });

  it("draws Primary and one picker per fallback place, in order", () => {
    const { block } = render([bot("a", [])]);
    const order = ["Primary", "Fallback 1", "Fallback 2", "Fallback 3"].map((label) =>
      block.indexOf(`>${label}<`),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(block).not.toContain(">Fallback 4<");
    expect(count(block, "Set Default")).toBe(1 + MAX_MODEL_FALLBACKS);
  });

  it("says a bot with a gap before a chosen fallback is skipped, not shifted", () => {
    const { block } = render([bot("a", [])]);
    expect(block).toContain("Fallbacks fill in order");
    expect(block).toContain("skipped and named below");
    // The two-space gap survives as a real U+00A0 plus a space, never as the entity.
    expect(block).toContain("current model.\u00A0 Fallbacks fill in order");
    expect(block).not.toContain("&nbsp;");
  });

  it("keeps the apply button, disabled until something is chosen", () => {
    const { block } = render([bot("a", [])]);
    expect(block).toContain("Set All Bots To Default");
    expect(block).toMatch(/<button[^>]*disabled[^>]*>Set All Bots To Default/);
  });

  it("says so when there is no bot to apply to", () => {
    const { block } = render([]);
    expect(block).toContain("Add a bot first to apply models to every bot.");
    expect(block).not.toContain("Set All Bots To Default");
  });
});
