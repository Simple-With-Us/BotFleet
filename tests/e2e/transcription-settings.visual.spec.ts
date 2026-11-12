import { test, expect, type Page } from "@playwright/test";

// The real TranscriptionSettings component is mounted through
// /?fixture=transcription-settings (see src/main.tsx).  The screenshot pins
// the call-dictation selector, including providers whose streaming bridges
// will ship separately.
const stableShot = { animations: "disabled", caret: "hide", maxDiffPixelRatio: 0.02, threshold: 0.2 } as const;

async function pinFonts(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `*, *::before, *::after { font-family: "DejaVu Sans", sans-serif !important; }`,
  });
}

test.use({ viewport: { width: 800, height: 1000 }, locale: "en-US" });

test("visual: call dictation provider selector includes the full ladder", async ({ page }) => {
  await page.route("**/api/config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ callStt: { provider: null, keyterms: ["BotFleet", "MiniMax"] } }),
    });
  });

  await page.goto("/?fixture=transcription-settings");
  await pinFonts(page);

  const selector = page.getByRole("group", { name: "Voice call dictation provider" });
  await expect(selector.getByRole("radio")).toHaveCount(7);
  await expect(selector.getByRole("radio", { name: /Automatic/ })).toBeEnabled();
  await expect(selector.getByRole("radio", { name: /xAI Cloud Recognition/ })).toBeVisible();
  await expect(selector.getByRole("radio", { name: /Meta Muse Voice Transcribe/ })).toBeVisible();
  await expect(selector.getByRole("radio", { name: /Azure Speech/ })).toBeVisible();
  await expect(selector.getByRole("radio", { name: /Groq Whisper/ })).toBeVisible();
  await expect(selector).toHaveScreenshot("call-stt-provider-ladder.png", stableShot);
});
