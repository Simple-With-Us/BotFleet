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
  assert.match(main, /sendDefaultPii:\s*false/);
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
