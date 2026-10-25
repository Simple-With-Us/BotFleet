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
// U+00A0.
//
// The gate covers every copy in this repo that states the rule, not only the gap
// skill:  a seat that opens owner-copy or land-lane instead of sentence-gap must
// learn the same exception from it, and AGENTS.md is the repo's own
// agent-instruction file, read by the very seats the exception names.
//
// Each copy is read through an *operative* region, bounded by the heading that
// carries the live rule and the next one.  Without that bound the assertions
// could be satisfied by a History block or a changelog while the live rule still
// banned the entity everywhere, and a wrong mechanism could be reintroduced
// without a red build.

const RULE_STATING_COPIES = [
  {
    path: ".claude/skills/sentence-gap/SKILL.md",
    start: "### Current rule",
    end: "### History",
  },
  {
    path: ".claude/skills/fleet-coordination/SKILL.md",
    start: "## 5. Sentence Gap Protocol",
    end: "\n## ",
  },
  {
    path: ".claude/skills/owner-copy/SKILL.md",
    start: "## Two spaces between sentences",
    end: "\n## ",
  },
  {
    path: ".claude/skills/land-lane/SKILL.md",
    start: "## Docs before the PR",
    end: "\n## ",
  },
  {
    path: "AGENTS.md",
    start: "**HOW to emit it",
    end: "\n## ",
  },
];

/**
 * The operative rule region of one copy:  from its start anchor to its end
 * anchor.  Fails loudly when an anchor is missing, so a renamed heading cannot
 * silently turn the gate into a no-op.
 */
const operativeRule = (source, copy) => {
  const start = source.indexOf(copy.start);
  assert.notEqual(
    start,
    -1,
    `${copy.path} must contain its rule anchor ${JSON.stringify(copy.start)}`,
  );
  const end = source.indexOf(copy.end, start + copy.start.length);
  assert.notEqual(
    end,
    -1,
    `${copy.path} must contain its rule end anchor ${JSON.stringify(copy.end)}`,
  );
  return source.slice(start, end);
};

test("every copy that states the gap rule names the one chat-pane exception", () => {
  for (const copy of RULE_STATING_COPIES) {
    const rule = operativeRule(read(join(ROOT, copy.path)), copy);
    assert.ok(
      rule.includes("MiniMax Code"),
      `${copy.path} must name the MiniMax Code chat pane as an exception`,
    );
    assert.ok(
      rule.includes("Claude Code"),
      `${copy.path} must name the Claude Code Code tab as an exception`,
    );
    assert.ok(
      /one exception/i.test(rule),
      `${copy.path} must state that there is one exception`,
    );
    assert.ok(rule.includes("U+00A0"), `${copy.path} must state the real U+00A0 rule`);
  }
});

test("the operative rule pins the entity as the two chat panes' mechanism", () => {
  // Naming the exception is not enough:  the operative rule has to say which
  // mechanism the two panes take, so a different one cannot slip through.
  for (const copy of RULE_STATING_COPIES) {
    const rule = operativeRule(read(join(ROOT, copy.path)), copy);
    assert.ok(
      /`&nbsp;` entity plus a normal space/i.test(rule),
      `${copy.path} must say the two chat panes take the entity plus a normal space`,
    );
  }
});

test("no operative rule bans the entity everywhere", () => {
  // A blanket ban refuses the entity without the "anywhere else" qualifier, so
  // it contradicts the two chat panes that need it.  The qualifier is what
  // makes the canonical wording legal, so the ban is matched up to it.
  const blanketBan = /never (?:write )?the `&nbsp;` entity(?!\s+anywhere else)/i;
  for (const copy of RULE_STATING_COPIES) {
    const rule = operativeRule(read(join(ROOT, copy.path)), copy);
    assert.ok(
      !blanketBan.test(rule),
      `${copy.path} must not ban the entity everywhere; the two chat panes take it`,
    );
  }
});

test("no operative rule claims every chat pane takes the real U+00A0", () => {
  // A blanket claim here contradicts the two panes, so a copy that still makes
  // it has not absorbed the exception.
  const blanketClaims = ["chat replies in every pane", "chat replies in any pane"];
  for (const copy of RULE_STATING_COPIES) {
    const rule = operativeRule(read(join(ROOT, copy.path)), copy);
    for (const claim of blanketClaims) {
      assert.ok(
        !rule.includes(claim),
        `${copy.path} must not claim "${claim}" takes the real U+00A0; the two panes take the entity`,
      );
    }
  }
});

test("no operative rule closes the chat panes out of the exception", () => {
  // The pre-2026-10-25 wording claimed the entity rule was replaced outright,
  // which is exactly what sends a seat down the wrong path.
  const closedClaims = [
    "This replaces the earlier per-surface rules (the entity in chat panes or on GitHub, and two plain ASCII spaces in files, commits and terminals).",
  ];
  for (const copy of RULE_STATING_COPIES) {
    const rule = operativeRule(read(join(ROOT, copy.path)), copy);
    for (const claim of closedClaims) {
      assert.ok(
        !rule.includes(claim),
        `${copy.path} must not claim the entity rule is replaced with no exception`,
      );
    }
  }
});
