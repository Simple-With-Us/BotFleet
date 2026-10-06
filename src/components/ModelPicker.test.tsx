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
import { EffortSection, LocalModelsPanel, ModelPicker } from "./ModelPicker";

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
  props: {
    initialRailId?: string | null;
    selection?: Bot["modelSelection"];
    contained?: boolean;
    bot?: Bot;
  } = {},
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
    // with pickedSelection (selectionForPick plus the Latest flag) and either
    // calls onChange or updates the bot.
    const source = readFileSync(join(__dirname, "ModelPicker.tsx"), "utf8");
    expect(source).toMatch(/<LocalModelsPanel[\s\S]*?onPick=\{pick\}/);
    expect(source).toContain("pickedSelection(selection, instance, model, latest)");
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

// ── Effort in the chat model menu ─────────────────────────────────────────
// The chat header's picker (not `contained`) offers the effort the bot's own
// model takes, as Settings' Reasoning control does.  The fixtures need engine
// `capabilities`: without them no model offers any level.

const withEffort = (levels: Array<"none" | "low" | "medium" | "high" | "xhigh" | "max">): Partial<InstanceInfo> =>
  ({ capabilities: { effortLevels: levels } }) as Partial<InstanceInfo>;

const effortClaude = (options: Option[] = [], levels: Array<"low" | "medium" | "high" | "xhigh" | "max"> = ["low", "medium", "high"]) =>
  engine("claude", "claudeAgent", "Claude", [{ id: "sonnet", label: "Claude Sonnet" }, ...options], withEffort(levels));
const effortCodex = () =>
  engine("codex", "codex", "Codex", [{ id: "gpt-5.4", label: "GPT-5.4" }], withEffort(["low", "medium", "high"]));

/** The Effort group's markup, or "" when the menu has none.  It ends at the
 *  choices' wrapper closing, or at the busy hint's paragraph when there is one. */
function effortSection(html: string): string {
  const start = html.indexOf("data-effort-section");
  if (start === -1) return "";
  const ends = ["</div></div>", "</p></div>"].map((marker) => html.indexOf(marker, start)).filter((i) => i !== -1);
  return html.slice(start, Math.min(...ends));
}

/** Each choice's visible label and whether it carries the check. */
function effortChoices(html: string): Array<{ label: string; checked: boolean }> {
  return [...effortSection(html).matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([\s\S]*?)<\/button>/g)].map(
    (match) => ({ label: words(match[2]), checked: match[1] === "true" }),
  );
}

describe("Effort section in the chat model menu", () => {
  const chat = { contained: false } as const;

  it("lists Default and the model's levels with a check on the bot's current one", () => {
    const html = render([effortClaude()], {
      ...chat,
      selection: { instanceId: "claude", model: "sonnet", effort: "high" },
    });
    expect(words(menu(html))).toContain("Effort");
    expect(effortChoices(html)).toEqual([
      { label: "Default", checked: false },
      { label: "Low", checked: false },
      { label: "Medium", checked: false },
      { label: "High", checked: true },
    ]);
    expect(effortSection(html).match(/lucide-check/g)).toHaveLength(1);
  });

  it("checks Default when the bot has no saved effort", () => {
    const choices = effortChoices(render([effortClaude()], chat));
    expect(choices.find((choice) => choice.checked)?.label).toBe("Default");
  });

  it("labels levels the way Settings' Reasoning control does", () => {
    const html = render([effortClaude([], ["low", "xhigh", "max"])], {
      ...chat,
      selection: { instanceId: "claude", model: "sonnet", effort: "xhigh" },
    });
    expect(effortChoices(html)).toEqual([
      { label: "Default", checked: false },
      { label: "Low", checked: false },
      { label: "X-High", checked: true },
      { label: "Max", checked: false },
    ]);
    const none = engine("codex", "codex", "Codex", [{ id: "gpt-5.4", label: "GPT-5.4" }], withEffort(["none", "low"]));
    expect(effortChoices(render([none], { ...chat, selection: { instanceId: "codex", model: "gpt-5.4" } })).map((c) => c.label)).toEqual([
      "Default",
      "None",
      "Low",
    ]);
  });

  it("is a footer outside the scrolling model list, so Show All never pushes it away", () => {
    const html = menu(render([effortClaude()], chat));
    expect(html.indexOf("overflow-y-auto px-2 pb-2")).toBeGreaterThan(-1);
    expect(html.indexOf("data-effort-section")).toBeGreaterThan(html.lastIndexOf("Claude Sonnet"));
    expect(effortSection(html)).not.toBe("");
  });

  it("is absent for a model that takes no effort", () => {
    const html = render(
      [effortClaude([{ id: "plain", label: "Plain Model", effortLevels: [] }])],
      { ...chat, selection: { instanceId: "claude", model: "plain" } },
    );
    expect(html).not.toContain("data-effort-section");
    expect(words(menu(html))).not.toContain("Effort");
  });

  it("is absent for a Claude Haiku model, which has no extended thinking", () => {
    const html = render(
      [effortClaude([{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }])],
      { ...chat, selection: { instanceId: "claude", model: "claude-haiku-4-5" } },
    );
    expect(html).not.toContain("data-effort-section");
  });

  it("is absent when the engine declares no effort levels at all", () => {
    expect(render([claude()], chat)).not.toContain("data-effort-section");
  });

  it("is absent from Settings pickers, where the Reasoning control sits beside them", () => {
    const html = render([effortClaude()], {
      contained: true,
      selection: { instanceId: "claude", model: "sonnet", effort: "high" },
    });
    expect(html).not.toContain("data-effort-section");
  });

  it("is absent while browsing an engine other than the bot's own", () => {
    // The bot is on Claude; Codex's panel must not show Claude's effort.
    const html = render([effortClaude(), effortCodex()], { ...chat, initialRailId: "codex" });
    expect(words(menu(html))).toContain("GPT-5.4");
    expect(html).not.toContain("data-effort-section");
  });

  it("is absent while the bot's engine needs setup", () => {
    const blocked = engine(
      "claude",
      "claudeAgent",
      "Claude",
      [{ id: "sonnet", label: "Claude Sonnet" }],
      { ...withEffort(["low", "high"]), snapshot: { state: "unavailable", reason: "Sign-in required" } } as Partial<InstanceInfo>,
    );
    expect(render([blocked], chat)).not.toContain("data-effort-section");
  });

  it("is offered to a Latest selection, with its saved effort checked", () => {
    const html = render([effortClaude()], {
      ...chat,
      selection: { instanceId: "claude", model: "sonnet", latest: "sonnet", effort: "medium" },
    });
    expect(effortChoices(html).find((choice) => choice.checked)?.label).toBe("Medium");
  });

  it("is offered on Local Models when the bot is on a local model that takes effort", () => {
    const selection = { instanceId: "claude", model: QWEN.id, effort: "low" as const };
    const html = render([effortClaude([QWEN])], { ...chat, selection });
    expect(words(menu(html))).toContain("Local Models");
    expect(effortChoices(html).find((choice) => choice.checked)?.label).toBe("Low");
    // …and not when the local row declares it takes none.
    const none = render([effortClaude([{ ...QWEN, effortLevels: [] }])], { ...chat, selection });
    expect(none).not.toContain("data-effort-section");
  });

  it("is absent on Local Models while the bot is on a cloud model", () => {
    const html = render([effortClaude([QWEN])], { ...chat, initialRailId: LOCAL_MODELS_RAIL_ID });
    expect(words(menu(html))).toContain("Local Models");
    expect(html).not.toContain("data-effort-section");
  });

  it("names the level in the chip's tooltip, in the chat header only", () => {
    const selection = { instanceId: "claude", model: "sonnet", effort: "high" as const };
    expect(render([effortClaude()], { ...chat, selection })).toContain("High effort");
    expect(render([effortClaude()], { contained: true, selection })).not.toContain("High effort");
    // …and nothing is said when the bot has none saved.
    expect(render([effortClaude()], chat)).not.toMatch(/title="[^"]*effort/);
  });

  it("hands each choice's level to onPick, Default as undefined", () => {
    const onPick = vi.fn();
    const tree = EffortSection({ levels: ["low", "high"], current: "low", onPick });
    const choices = findElements(tree, (element) => element.type === "button");
    expect(choices).toHaveLength(3);
    for (const choice of choices) (choice.props as { onClick: () => void }).onClick();
    expect(onPick.mock.calls).toEqual([[undefined], ["low"], ["high"]]);
  });

  it("renders nothing for a model with no levels", () => {
    expect(EffortSection({ levels: [], current: undefined, onPick: () => {} })).toBeNull();
  });

  it("holds the choices while the bot is working, and says why", () => {
    const html = render([effortClaude()], { ...chat, bot: { ...BOT, busy: true } as Bot });
    const section = effortSection(html);
    expect(section.match(/<button[^>]*\sdisabled=""/g)).toHaveLength(4);
    expect(words(section)).toContain("Stop the bot to change effort.");
  });

  it("leaves the choices open, with no hint, while the bot is idle", () => {
    const section = effortSection(render([effortClaude()], chat));
    expect(section).not.toMatch(/\sdisabled=""/);
    expect(words(section)).not.toContain("Stop the bot");
  });
});
