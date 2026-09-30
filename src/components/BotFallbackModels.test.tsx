// What the per-bot settings panel draws for a bot's fallbacks.  The panel has
// always listed every stored entry; what changes with the shared cap is only
// when the Add control appears.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./ModelPicker", async () => {
  const { createElement: h } = await import("react");
  return {
    ModelPicker: (props: { selection: { model: string } }) =>
      h("span", { "data-picker": props.selection.model }),
  };
});

import { BotFallbackModels } from "./BotFallbackModels";
import type { Bot } from "@/state/store";

function bot(fallbackModels: string[]): Bot {
  return {
    id: "b1",
    name: "Bot One",
    modelSelection: {
      instanceId: "claude",
      model: "primary-model",
      fallbacks: fallbackModels.map((model) => ({ instanceId: "codex", model })),
    },
  } as unknown as Bot;
}

const render = (fallbackModels: string[]) =>
  renderToStaticMarkup(createElement(BotFallbackModels, { bot: bot(fallbackModels), onChange: () => {} }));

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("BotFallbackModels", () => {
  it("offers Add and draws nothing else when there are no fallbacks", () => {
    const html = render([]);
    expect(html).toContain("Add Fallback Model");
    expect(html).not.toContain("Fallback #1");
  });

  it("still offers Add at two fallbacks", () => {
    const html = render(["m1", "m2"]);
    expect(count(html, "Remove</button>")).toBe(2);
    expect(html).toContain("Add Fallback Model");
  });

  it("draws three fallbacks and stops offering Add at the cap", () => {
    const html = render(["m1", "m2", "m3"]);
    for (const n of [1, 2, 3]) expect(html).toContain(`Fallback #${n}`);
    expect(html).not.toContain("Fallback #4");
    expect(html).not.toContain("Add Fallback Model");
  });

  it("draws every entry of a chain stored past the cap, each removable", () => {
    const html = render(["m1", "m2", "m3", "m4"]);
    for (const n of [1, 2, 3, 4]) expect(html).toContain(`Fallback #${n}`);
    expect(count(html, "Remove</button>")).toBe(4);
    expect(html).not.toContain("Add Fallback Model");
  });
});
