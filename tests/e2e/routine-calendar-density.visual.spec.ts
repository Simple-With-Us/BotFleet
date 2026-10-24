import { expect, test, type Page } from "@playwright/test";

const FIXED_NOW = new Date("2026-10-13T15:00:00.000Z");

async function pinFonts(page: Page): Promise<void> {
  await page.addStyleTag({ content: `*, *::before, *::after { font-family: "DejaVu Sans", sans-serif !important; }` });
}

test.use({ viewport: { width: 1500, height: 900 }, locale: "en-US", timezoneId: "UTC" });

test("visual: dense routine collisions become one readable stack", async ({ page }) => {
  await page.clock.install({ time: FIXED_NOW });
  await page.goto("/?fixture=routine-calendar-density");
  await pinFonts(page);

  const stack = page.getByTestId("routine-collision-stack");
  await expect(stack).toHaveCount(1);
  await expect(stack).toContainText("18 Overlapping");
  const box = await stack.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeLessThanOrEqual(105);

  await stack.click();
  const panel = page.getByTestId("routine-collision-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("18 Overlapping Items");
  await expect(panel.getByText("Compile gates", { exact: true })).toHaveCount(4);

  await expect(page).toHaveScreenshot("routine-calendar-density.png", {
    animations: "disabled",
    caret: "hide",
  });
});
