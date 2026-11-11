import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("Electron main initializes @sentry/electron without a hardcoded DSN", () => {
  const main = readFileSync(join(ROOT, "electron/main.mjs"), "utf8");
  assert.match(main, /@sentry\/electron\/main/);
  assert.match(main, /function initDesktopSentry/);
  assert.match(main, /SENTRY_DSN \|\| process\.env\.VITE_SENTRY_DSN/);
  assert.doesNotMatch(main, /^\s*sendDefaultPii\s*:/m);
  assert.match(main, /dataCollection:\s*\{[\s\S]*?userInfo:\s*false/);
  assert.match(main, /cookies:\s*false/);
  assert.match(main, /httpHeaders:\s*\{\s*request:\s*false,\s*response:\s*false\s*\}/);
  assert.match(main, /httpBodies:\s*\[\]/);
  assert.match(main, /urlQueryParams:\s*false/);
  assert.match(main, /genAI:\s*\{\s*inputs:\s*false,\s*outputs:\s*false\s*\}/);
  assert.match(main, /databaseQueryData:\s*false/);
  assert.match(main, /queues:\s*false/);
  assert.match(main, /graphQL:\s*\{\s*document:\s*false,\s*variables:\s*false\s*\}/);
  assert.match(main, /stackFrameVariables:\s*false/);
  assert.match(main, /frameContextLines:\s*0/);
  assert.doesNotMatch(main, /ingest\.sentry\.io/);
  assert.doesNotMatch(main, /https:\/\/[a-z0-9]+@/i);
});

test("Vite plugin uploads source maps only when SENTRY_AUTH_TOKEN is set", () => {
  const vite = readFileSync(join(ROOT, "vite.config.ts"), "utf8");
  assert.match(vite, /@sentry\/vite-plugin/);
  assert.match(vite, /disable:\s*!sentryAuthToken/);
  assert.match(vite, /VITE_SENTRY_RELEASE/);
  assert.match(vite, /simple-with-us/);
  assert.match(vite, /project:\s*"botfleet"/);
});
