import { test, expect } from '@playwright/test';

// Fleet rollout scaffold: one smoke test. Visits /, expects HTTP 200 and a
// non-empty <title>. Expand into a real suite as the app needs it.
test('homepage smoke: HTTP 200 and non-empty title', async ({ page, request }) => {
  const response = await request.get('/');
  expect(response.status(), 'GET / should return HTTP 200').toBe(200);
  await page.goto('/');
  await expect(page, 'page should have a non-empty <title>').toHaveTitle(/.+/);
});
