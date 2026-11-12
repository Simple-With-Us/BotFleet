import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { initialState, StoreContext } from "@/state/store";
import { SecretsSection } from "./SecretsSection";

describe("SecretsSection authentication choices", () => {
  it("defaults to explicit service-token mode and renders no machine identity input", () => {
    const html = renderToStaticMarkup(createElement(
      StoreContext.Provider,
      {
        value: {
          state: initialState,
          dispatch: () => {},
          flushBotPatches: async () => {},
          refreshInstances: async () => {},
        },
      },
      createElement(SecretsSection),
    ));

    expect(html).toMatch(/name="infisical-auth-method" checked="" value="service-token"/);
    expect(html).toContain('value="machine-identity"');
    expect(html).toContain('id="infisical-read-token" type="password"');
    expect(html).toContain('id="infisical-write-token" type="password"');
    expect(html).toContain("Add Source");
    expect(html).not.toContain('id="infisical-client-secret"');
    expect(html).toContain("BotFleet never picks a machine identity from an inherited environment.");
  });
});
