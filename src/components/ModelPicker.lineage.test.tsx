// Static-markup tests for the model picker's lineage surfaces: the chip that
// names the model actually running, the Retired badge with its one-click
// switch, and the "Latest <Class>" rows.  Same approach as the other
// component tests here (renderToStaticMarkup, no DOM).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";
import { latestRows, savedModelStatus } from "@/lib/model-lineage-view";

const EFFORT = ["low", "medium", "high", "xhigh", "max"] as const;

const claude = {
  instanceId: "claude",
  driverKind: "claudeAgent",
  displayName: "Claude",
  snapshot: { state: "available", authenticated: true, version: "2.1.284" },
  capabilities: { effortLevels: [...EFFORT] },
  models: {
    default: "claude-sonnet-5-5",
    options: [
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-opus-5", label: "Claude Opus 5" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ],
  },
} as unknown as InstanceInfo;

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: { instances: [claude] },
      dispatch: vi.fn(),
      refreshInstances: vi.fn(),
    }),
  };
});

const { ModelPicker, LatestModelRows, SavedModelNotice } = await import("./ModelPicker");

function bot(modelSelection: Bot["modelSelection"]): Bot {
  return { id: "b1", threadId: "t1", name: "Deployer", modelSelection } as unknown as Bot;
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("ModelPicker chip", () => {
  it("shows the resolved model in the chat header and records the slug in the tooltip", () => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, { bot: bot({ instanceId: "claude", model: "claude-sonnet-5-5", latest: "sonnet" }) }),
    );
    expect(text(html)).toContain("Claude Sonnet 5.5");
    expect(text(html)).not.toContain("Latest Sonnet ·");
    expect(html).toContain("Claude · Latest Sonnet · Claude Sonnet 5.5 (claude-sonnet-5-5)");
  });

  it("says Latest in settings", () => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        bot: bot({ instanceId: "claude", model: "claude-sonnet-5-5", latest: "sonnet" }),
        contained: true,
      }),
    );
    expect(text(html)).toContain("Latest Sonnet · Claude Sonnet 5.5");
  });

  it("badges a retired saved model and offers a one-click switch in settings", () => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        bot: bot({ instanceId: "claude", model: "claude-3-7-sonnet" }),
        contained: true,
      }),
    );
    const visible = text(html);
    expect(visible).toContain("Claude Sonnet 3.7");
    expect(visible).toContain("Retired");
    expect(visible).toContain("Claude Sonnet 3.7 is retired.");
    expect(visible).toContain("Switch To Latest Sonnet");
    expect(visible).not.toContain("claude-3-7-sonnet");
  });

  it("shows no badge for a current model", () => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, { bot: bot({ instanceId: "claude", model: "claude-opus-5-5" }), contained: true }),
    );
    expect(text(html)).not.toMatch(/Retired|Superseded|Switch To/);
  });
});

describe("LatestModelRows", () => {
  it("lists one Latest row per class with the model it runs now, checking the saved one", () => {
    const html = renderToStaticMarkup(
      createElement(LatestModelRows, { rows: latestRows(claude), currentClass: "sonnet", onPick: () => {} }),
    );
    const visible = text(html);
    expect(visible).toContain("Latest Fable Claude Fable 5.1");
    expect(visible).toContain("Latest Opus Claude Opus 5.5");
    expect(visible).toContain("Latest Sonnet Claude Sonnet 5.5");
    expect(visible).toContain("Latest Haiku Claude Haiku 4.5");
    // Exactly one row is current.
    expect(html.match(/bg-control"/g)?.length ?? 0).toBe(1);
  });
});

describe("SavedModelNotice", () => {
  it("renders nothing for a model the catalog offers", () => {
    const status = savedModelStatus(claude, { instanceId: "claude", model: "claude-sonnet-5-5" });
    expect(renderToStaticMarkup(createElement(SavedModelNotice, { status, modelName: "x", onSwitch: () => {} }))).toBe("");
  });

  it("names a superseded model and its switch target", () => {
    const status = savedModelStatus(claude, { instanceId: "claude", model: "claude-opus-5" });
    const html = renderToStaticMarkup(
      createElement(SavedModelNotice, { status, modelName: "Claude Opus 5", onSwitch: () => {} }),
    );
    expect(text(html)).toBe("Superseded Claude Opus 5 has a newer version. Switch To Latest Opus");
  });
});
