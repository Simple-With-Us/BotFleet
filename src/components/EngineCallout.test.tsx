import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EngineCallout } from "./EngineCallout.tsx";
import { ENGINE_CAPABILITIES, ENGINE_DISPLAY_ORDER, engineIdFromDriverKind } from "@/lib/engine-capabilities.tsx";

describe("EngineCallout", () => {
  it("shows the same neutral facts for every registered engine", () => {
    for (const id of ENGINE_DISPLAY_ORDER) {
      const entry = ENGINE_CAPABILITIES[id];
      const html = renderToStaticMarkup(createElement(EngineCallout, { engineId: id }));
      expect(html).toContain("Access:");
      expect(html).toContain("Billing:");
      expect(html).toContain("Models:");
      expect(html).not.toContain("More Info");
      expect(html).not.toContain(entry.whyThisEngine.headline);
      expect(html).not.toContain("aria-expanded");
    }
  });

  it("uses the live instance model ids when supplied", () => {
    const html = renderToStaticMarkup(
      createElement(EngineCallout, {
        engineId: "openai-compat",
        models: ["vendor/model-a", "vendor/model-b"],
      }),
    );
    expect(html).toContain("vendor/model-a, vendor/model-b");
    expect(html).not.toContain("meta-llama/llama-3.3-70b-instruct");
  });

  it("keeps a long catalog compact while stating how many ids remain", () => {
    const models = Array.from({ length: 8 }, (_, index) => `model-${index + 1}`);
    const html = renderToStaticMarkup(createElement(EngineCallout, { engineId: "grok", models }));
    expect(html).toContain("model-1, model-2, model-3, model-4, model-5, model-6 +2 more");
    expect(html).not.toContain("model-7");
  });

  it("resolves runtime driver kinds to registry ids", () => {
    const html = renderToStaticMarkup(createElement(EngineCallout, { driverKind: "grokAgent" }));
    expect(html).toContain("Access:");
    expect(engineIdFromDriverKind("dshAgent")).toBe("deepseek-harness");
  });
});
