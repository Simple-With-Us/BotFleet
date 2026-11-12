import { expect, test, type Page } from "@playwright/test";

const stableShot = { animations: "disabled", caret: "hide", maxDiffPixelRatio: 0.02, threshold: 0.2 } as const;

async function pinFonts(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after { font-family: "DejaVu Sans", sans-serif !important; }
      code, kbd, pre, samp, tt { font-family: "DejaVu Sans Mono", monospace !important; }
    `,
  });
}

test.use({ viewport: { width: 720, height: 420 }, locale: "en-US" });

test("visual: local model wait is saved per OpenAI-compatible server", async ({ page }) => {
  await page.goto("/?fixture=local-model-wait");
  await pinFonts(page);

  const board = page.getByTestId("local-model-wait-board");
  const wait = board.getByRole("combobox", { name: "How long to wait for Ollama Local to reply" });
  await expect(board).toBeVisible();
  await expect(wait).toHaveValue("20");
  await expect(wait.locator("option")).toHaveText(["Default (3 min)", "5 min", "10 min", "20 min", "30 min", "60 min"]);
  await expect(board).toHaveScreenshot("local-model-wait.png", stableShot);

  await wait.selectOption("30");
  await expect(page.getByTestId("local-model-wait-state")).toHaveText("30");
  await wait.selectOption("");
  await expect(page.getByTestId("local-model-wait-state")).toHaveText("default");
});
