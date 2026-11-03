import { test, expect, type Page } from "@playwright/test";

const stableShot = { animations: "disabled" as const, caret: "hide" as const };
const LINUX_CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function pinFonts(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `*, *::before, *::after { font-family: "DejaVu Sans", sans-serif !important; }`,
  });
}

test.use({ viewport: { width: 820, height: 1160 }, locale: "en-US", timezoneId: "UTC", userAgent: LINUX_CHROME_UA });

test("visual: optional Infisical with explicit auth and scoped service-token sources", async ({ page }) => {
  await page.route("**/api/infisical/status", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      infisical: {
        configured: false,
        enabled: false,
        writeThrough: false,
        authMethod: "service-token",
        source: "none",
        siteUrl: "https://app.infisical.com",
        projectId: "fixture-project",
        environment: "prod",
        secretPath: "/",
        hasClientId: false,
        hasClientSecret: false,
        hasToken: false,
        hasWriteToken: false,
        refreshMinutes: 15,
        lastSyncAt: null,
        lastAttemptAt: null,
        lastSyncMs: null,
        lastError: null,
        stale: false,
        pendingProviderReload: false,
        vaultCount: 0,
        vaultNames: [],
        appliedCount: 0,
        appliedFields: [],
        unusedVaultNames: [],
        readSources: [{
          name: "fleet-ops-cli-logins",
          projectId: "fixture-fleet-ops",
          environment: "prod",
          secretPath: "/cli-logins/CODEX",
          tokenEnv: "BOTFLEET_CLI_LOGINS_READ_TOKEN",
          writeTokenFile: "/fixture/write-token",
          hasReadToken: true,
          hasWriteToken: true,
          ok: true,
          error: null,
        }],
      },
      fields: [],
    }),
  }));
  await page.goto("/?fixture=infisical-auth");
  await pinFonts(page);

  const fixture = page.getByTestId("secrets-section-fixture");
  await expect(fixture).toBeVisible();
  await expect(fixture.getByRole("radio", { name: /Service Tokens/ })).toBeChecked();
  await expect(fixture.getByLabel("Primary Read Token")).toBeVisible();
  await expect(fixture.getByLabel("Source Name")).toHaveValue("fleet-ops-cli-logins");
  await expect(fixture.getByText("Read configured · Write configured")).toBeVisible();
  await expect(fixture.getByLabel("Client Secret")).toHaveCount(0);
  await expect(fixture).toHaveScreenshot("infisical-auth-service-tokens.png", {
    ...stableShot,
    maxDiffPixelRatio: 0.02,
    threshold: 0.2,
  });
});
