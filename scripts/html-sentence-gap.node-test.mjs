import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ELECTRON_MAIN = join(ROOT, "electron/main.mjs");
const COMPANION_CONTROL = join(ROOT, "companion/src/control.ts");

/** Read a repo source file as text, with line endings normalised. */
const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/** Count non-overlapping occurrences of a literal substring. */
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

// The owner rule of 2026-10-23 puts a real U+00A0 plus a normal space between
// sentences on every surface a person reads.
// In HTML markup the no-break space is written as the numeric reference
// `&#160;`, never the named `&nbsp;` entity.
// The named entity shows up as literal text wherever the markup is not
// parsed as HTML (plain-text copies, logs, commits), so it is kept out of source.
// Two files here build user-visible HTML as strings rather than as markup
// files, so they are where the entity can leak.

test("no user-visible HTML builder uses the named &nbsp; entity", () => {
  for (const path of [ELECTRON_MAIN, COMPANION_CONTROL]) {
    const source = read(path);
    assert.equal(countOf(source, "&nbsp;"), 0, `${path} must not contain the named &nbsp; entity`);
  }
});

test("the bot-server error page uses the numeric no-break space reference", () => {
  const source = read(ELECTRON_MAIN);
  assert.ok(
    source.includes("&#160; If it keeps happening"),
    "electron/main.mjs must write the error page sentence gap as &#160;",
  );
});

test("the companion control page uses the numeric no-break space reference", () => {
  const source = read(COMPANION_CONTROL);
  const gaps = countOf(source, "&#160; ");
  assert.ok(gaps >= 6, `companion/src/control.ts must hold at least 6 "&#160; " sentence gaps, found ${gaps}`);
});

test("the companion control page does not hang a sentence gap off a non-sentence", () => {
  const source = read(COMPANION_CONTROL);
  assert.ok(!source.includes("&nbsp; in a row"), "companion/src/control.ts must not use &nbsp; in a row");
  assert.ok(!source.includes("&#160; in a row"), "companion/src/control.ts must not use &#160; in a row");
});
