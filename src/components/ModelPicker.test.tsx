// What the model picker draws, rendered from a stubbed store.
//
// SSR style, like the rest of this repo's component tests: the Vite test
// environment is `node`, so `renderToStaticMarkup` is the DOM-free path and
// there are no clicks.  The picker is therefore started open (`initialOpen`,
// `initialRailId`) and what a click would do is asserted where it lives: the
// panel's own rows call `onPick` with the engine and model they belong to, and
// `selectionForPick` (src/lib/model-pick.test.ts) turns that into the saved
// selection.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";
import { LOCAL_MODELS_RAIL_ID } from "@/lib/local-models";
import { BoxAgentDriver } from "../../server/drivers/boxagent.ts";

const store = vi.hoisted(() => ({ instances: [] as unknown[] }));

vi.mock("@/state/store", () => ({
  useStore: () => ({
    state: { instances: store.instances },
    dispatch: () => {},
    refreshInstances: async () => {},
  }),
}));

// Imported after the mock is registered (vitest hoists vi.mock above imports).
import { LocalModelsPanel, ModelPicker } from "./ModelPicker";

type Option = InstanceInfo["models"]["options"][number];

const QWEN: Option = { id: "ollama::qwen3:8b", label: "qwen3:8b (Ollama)", custom: true };
const LLAMA: Option = { id: "omlx::llama-3.3-70b", label: "llama-3.3-70b (oMLX)", custom: true, loaded: true };
const CLOUD_CUSTOM: Option = { id: "openrouter::acme/frontier", label: "Acme Frontier", custom: true };

function engine(
  instanceId: string,
  driverKind: string,
  displayName: string,
  options: Option[],
  extra: Partial<InstanceInfo> = {},
): InstanceInfo {
  return {
    instanceId,
    driverKind,
    displayName,
    snapshot: { state: "available", version: "1.0.0" },
    models: { default: options[0]?.id ?? "", options },
    ...extra,
  } as InstanceInfo;
}

const claude = (extra: Option[] = []) =>
  engine("claude", "claudeAgent", "Claude", [{ id: "sonnet", label: "Claude Sonnet" }, ...extra]);
const codex = (extra: Option[] = []) =>
  engine("codex", "codex", "Codex", [{ id: "gpt-5.4", label: "GPT-5.4" }, ...extra]);
const box = () =>
  engine("computer", "boxAgent", "ASCII.dev Box", [{ id: "claude-fable-5", label: "Claude Fable 5 · on the box" }]);

const BOT = {
  id: "bot-1",
  modelSelection: { instanceId: "claude", model: "sonnet" },
} as unknown as Bot;

function render(
  instances: InstanceInfo[],
  props: { initialRailId?: string | null; selection?: Bot["modelSelection"] } = {},
): string {
  store.instances = instances;
  return renderToStaticMarkup(
    createElement(ModelPicker, { bot: BOT, initialOpen: true, contained: true, ...props }),
  );
}

/** The open menu, without the trigger chip above it (which names the bot's
 * current model and would make a "not on this panel" check meaningless). */
function menu(html: string): string {
  return html.slice(html.indexOf('role="dialog"'));
}

/** Visible words only, so a failed assertion prints a sentence rather than a
 * page of SVG path data. */
function words(html: string): string {
  return html
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every element in a returned tree that satisfies `match`, without rendering
 * it — enough to reach the props a click handler would be invoked through. */
function findElements(node: ReactNode, match: (element: ReactElement) => boolean): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap((child) => findElements(child, match));
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [...(match(element) ? [element] : []), ...findElements(element.props.children, match)];
}

describe("Use a Local Model footer", () => {
  it("is gone, whether or not the engine is installed and whether or not local models exist", () => {
    const withoutLocal = render([claude(), codex()]);
    const withLocal = render([claude([QWEN]), codex([QWEN])]);
    const notInstalled = render(
      [engine("claude", "claudeAgent", "Claude", [], { snapshot: { state: "unavailable", reason: "not installed" } })],
      { selection: { instanceId: "claude", model: "sonnet" } },
    );
    for (const html of [withoutLocal, withLocal, notInstalled]) {
      expect(words(html).toLowerCase()).not.toContain("use a local model");
      expect(html).not.toContain("Use a Local Model");
    }
  });

  it("leaves the engine's model list as the whole of its panel", () => {
    const text = words(menu(render([claude([QWEN])])));
    expect(text).toContain("Claude Sonnet");
    // the injected model is listed on Local Models, not repeated under Claude
    expect(text).not.toContain("qwen3:8b");
  });
});

describe("Local Models rail entry", () => {
  it("does not exist when no local model is configured", () => {
    const html = render([claude(), codex(), box()]);
    expect(words(menu(html))).not.toContain("Local Models");
    expect(html).not.toContain('aria-label="Local Models"');
    expect(words(menu(html))).not.toMatch(/\bLocal\b/);
  });

  it("appears when an injected model is available, with the monitor icon", () => {
    const html = render([claude([QWEN])]);
    const button = html.match(/<button[^>]*aria-label="Local Models"[^>]*>.*?<\/button>/s)?.[0];
    expect(button, "Local Models rail button").toBeDefined();
    expect(button).toContain("lucide-monitor");
    expect(words(menu(html))).toMatch(/\bLocal\b/);
  });

  it("appears when a Local-group engine has configured models", () => {
    const ollamaLocal = engine(
      "ollama-local",
      "openai-compat",
      "Ollama Local",
      [{ id: "llama3.2", label: "llama3.2", custom: true }],
      { access: "custom" },
    );
    expect(render([claude(), ollamaLocal])).toContain('aria-label="Local Models"');
  });

  it("does not appear for a cloud provider configured in a subscription engine", () => {
    expect(render([codex([CLOUD_CUSTOM])])).not.toContain('aria-label="Local Models"');
  });

  it("is not highlighted as some engine when it is the open entry", () => {
    const html = render([claude([QWEN]), codex()], { initialRailId: LOCAL_MODELS_RAIL_ID });
    const pressed = [...html.matchAll(/aria-label="([^"]+)" aria-pressed="true"/g)].map((match) => match[1]);
    expect(pressed).toEqual(["Local Models"]);
  });
});

describe("Local Models panel", () => {
  it("lists every configured local model under Local Models, in place of a footer", () => {
    const text = words(menu(render([claude([QWEN, LLAMA])], { initialRailId: LOCAL_MODELS_RAIL_ID })));
    expect(text).toContain("Local Models 2 models");
    expect(text).toContain("qwen3:8b (Ollama)");
    expect(text).toContain("llama-3.3-70b (oMLX)");
    expect(text).toContain("Runs On Claude");
    // the engine's own cloud models are not on this panel
    expect(text).not.toContain("Claude Sonnet");
  });

  it("lists a model offered by several engines once", () => {
    const html = render([claude([QWEN]), codex([QWEN])], { initialRailId: LOCAL_MODELS_RAIL_ID });
    expect(words(menu(html)).match(/qwen3:8b \(Ollama\)/g)).toHaveLength(1);
    expect(words(menu(html))).toContain("1 model");
  });

  it("opens on Local Models for a bot that is already on an injected model", () => {
    const text = words(menu(render([claude([QWEN])], { selection: { instanceId: "claude", model: QWEN.id } })));
    expect(text).toContain("Local Models 1 model");
    expect(text).toContain("Runs On Claude");
    expect(text).not.toContain("Choose a model for this bot");
  });

  it("opens on the engine itself for a bot on a cloud model, even with local models configured", () => {
    const text = words(menu(render([claude([QWEN])])));
    expect(text).toContain("Choose a model for this bot");
    expect(text).not.toContain("Runs On Claude");
  });

  it("wires each row to the engine and model it belongs to", () => {
    const pi = engine("pi", "piAgent", "pi", [{ id: "mine", label: "mine", custom: true }], { access: "custom" });
    const groups = [
      { instance: claude([QWEN, LLAMA]), options: [LLAMA, QWEN] },
      { instance: pi, options: [{ id: "mine", label: "mine", custom: true }] },
    ];
    const onPick = vi.fn();
    const tree = LocalModelsPanel({
      groups,
      selection: { instanceId: "claude", model: "sonnet" },
      query: "",
      onQueryChange: () => {},
      onPick,
    });
    const rows = findElements(
      tree,
      (element) => "option" in (element.props as object) && "onPick" in (element.props as object),
    );
    expect(rows).toHaveLength(3);
    const byId = new Map(rows.map((row) => [(row.props as { option: Option }).option.id, row]));
    (byId.get(QWEN.id)!.props as { onPick: () => void }).onPick();
    (byId.get("mine")!.props as { onPick: () => void }).onPick();
    expect(onPick).toHaveBeenNthCalledWith(1, groups[0].instance, QWEN.id);
    expect(onPick).toHaveBeenNthCalledWith(2, pi, "mine");
  });

  it("hands the picker the same pick() every engine's list uses", () => {
    // The panel is given ModelPicker's own pick(), which builds the selection
    // with selectionForPick and either calls onChange or updates the bot.
    const source = readFileSync(join(__dirname, "ModelPicker.tsx"), "utf8");
    expect(source).toMatch(/<LocalModelsPanel[\s\S]*?onPick=\{pick\}/);
    expect(source).toContain("selectionForPick(selection, instance, model)");
  });

  it("marks the bot's current model", () => {
    const html = renderToStaticMarkup(
      createElement(LocalModelsPanel, {
        groups: [{ instance: claude([QWEN, LLAMA]), options: [LLAMA, QWEN] }],
        selection: { instanceId: "claude", model: QWEN.id },
        query: "",
        onQueryChange: () => {},
        onPick: () => {},
      }),
    );
    expect(html.match(/lucide-check/g)).toHaveLength(1);
    expect(words(html)).toContain("Loaded");
  });

  it("says so when a search matches nothing", () => {
    const text = words(
      renderToStaticMarkup(
        createElement(LocalModelsPanel, {
          groups: [{ instance: claude([QWEN]), options: [QWEN] }],
          selection: { instanceId: "claude", model: "sonnet" },
          query: "zzz",
          onQueryChange: () => {},
          onPick: () => {},
        }),
      ),
    );
    expect(text).toContain("Nothing matches");
    expect(text).not.toContain("qwen3:8b");
  });
});

describe("engines keep the custom rows that are not local", () => {
  it("lists a configured cloud provider under Custom on its own engine", () => {
    const text = words(menu(render([codex([CLOUD_CUSTOM, QWEN])], { selection: { instanceId: "codex", model: "gpt-5.4" } })));
    expect(text).toContain("Custom Acme Frontier");
    expect(text).not.toContain("qwen3:8b");
  });
});

describe("ASCII.dev Box engine", () => {
  const onBox = { selection: { instanceId: "computer", model: "claude-fable-5" } };

  it("is named after where it runs, not Computer", () => {
    expect(BoxAgentDriver.metadata.displayName).toBe("ASCII.dev Box");
    const html = render([claude(), box()], onBox);
    expect(html).toContain('aria-label="ASCII.dev Box"');
    expect(html).not.toContain('aria-label="Computer"');
    expect(words(menu(html))).toContain("ASCII.dev Box");
  });

  it("wears a box, never the monitor that Local Models uses", () => {
    const html = render([claude(), box()], onBox);
    const button = html.match(/<button[^>]*aria-label="ASCII\.dev Box"[^>]*>.*?<\/button>/s)?.[0];
    expect(button, "ASCII.dev Box rail button").toBeDefined();
    expect(button).toContain("lucide-box");
    expect(button).not.toContain("lucide-monitor");
  });

  it("does not share its icon with Local Models when both are on the rail", () => {
    const html = render([claude([QWEN]), box()], onBox);
    const boxButton = html.match(/<button[^>]*aria-label="ASCII\.dev Box"[^>]*>.*?<\/button>/s)?.[0] ?? "";
    const localButton = html.match(/<button[^>]*aria-label="Local Models"[^>]*>.*?<\/button>/s)?.[0] ?? "";
    expect(boxButton).toContain("lucide-box");
    expect(localButton).toContain("lucide-monitor");
  });
});
