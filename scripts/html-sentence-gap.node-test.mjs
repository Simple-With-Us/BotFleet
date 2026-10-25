import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ELECTRON_MAIN = join(ROOT, "electron/main.mjs");
const COMPANION_CONTROL = join(ROOT, "companion/src/control.ts");

// The packs in this repo that state the sentence-gap rule.  Every one of them
// has to name the one chat-pane exception, because a seat that reads only one
// pack must still learn that its own chat pane takes the `&nbsp;` entity.
const RULE_STATING_PACKS = [
  ".claude/skills/sentence-gap/SKILL.md",
  ".claude/skills/fleet-coordination/SKILL.md",
  ".claude/skills/owner-copy/SKILL.md",
  ".claude/skills/land-lane/SKILL.md",
];

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

// The owner rule of 2026-10-25 named one exception to the one mechanism:  the chat
// panes of Claude Code (the Code tab) and MiniMax Code (the MiniMax Code pane) take
// the `&nbsp;` entity plus a normal space, because those panes normalize a raw
// U+00A0 away and collapse two ASCII spaces.  Every other surface takes the real
// U+00A0.  The portable packs are what the cloud agents read, so a copy that still
// says "never write the entity" with no exception sends every seat down the wrong
// path, which is exactly what it did until 2026-10-25.
//
// The gate covers every pack that states the rule, not only the gap skill:  a seat
// that opens owner-copy or land-lane instead of sentence-gap must learn the same
// exception from it.

test("every pack that states the gap rule names the one chat-pane exception", () => {
  for (const rel of RULE_STATING_PACKS) {
    const source = read(join(ROOT, rel));
    assert.ok(
      source.includes("MiniMax Code"),
      `${rel} must name the MiniMax Code chat pane as an exception`,
    );
    assert.ok(
      source.includes("Claude Code"),
      `${rel} must name the Claude Code Code tab as an exception`,
    );
    assert.ok(
      source.includes("one exception"),
      `${rel} must state that there is one exception`,
    );
    assert.ok(source.includes("U+00A0"), `${rel} must state the real U+00A0 rule`);
    assert.ok(source.includes("`&nbsp;`"), `${rel} must name the entity`);
  }
});

test("no pack bans the entity everywhere without the two chat panes", () => {
  // The blanket bans that the exception contradicts.  Each is the pre-2026-10-25
  // wording, where the entity was refused on every surface including the two
  // panes that need it.
  const blanketBans = [
    "- **Never write the `&nbsp;` entity.**",
    "- **Never the `&nbsp;` entity.**",
  ];
  for (const rel of RULE_STATING_PACKS) {
    const source = read(join(ROOT, rel));
    for (const ban of blanketBans) {
      assert.ok(
        !source.includes(ban),
        `${rel} must not ban the entity everywhere; the two chat panes take it`,
      );
    }
  }
});

test("no pack claims every chat pane takes the real U+00A0", () => {
  // A blanket claim here contradicts the two panes, so a pack that still makes
  // it has not absorbed the exception.
  const blanketClaims = ["chat replies in every pane", "chat replies in any pane"];
  for (const rel of RULE_STATING_PACKS) {
    const source = read(join(ROOT, rel));
    for (const claim of blanketClaims) {
      assert.ok(
        !source.includes(claim),
        `${rel} must not claim "${claim}" takes the real U+00A0; the two panes take the entity`,
      );
    }
  }
});
