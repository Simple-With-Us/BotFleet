// The sentence gap on outbound Zulip text (server/zulip/sentence-gap.ts).
import { describe, expect, it } from "vitest";

import { sentenceGap } from "./sentence-gap.ts";

const G = "\u00a0 ";

describe("the sentence gap", () => {
  it.each([
    ["two spaces after a period", "Done.  Next.", `Done.${G}Next.`],
    ["three or more spaces", "Done.    Next.", `Done.${G}Next.`],
    ["after ! and ?", "Ready!  Go?  Yes.", `Ready!${G}Go?${G}Yes.`],
    ["after a closing quote", 'He said "go."  Then left.', `He said "go."${G}Then left.`],
    ["after curly quotes", "It is “done.”  Next ‘one.’  Last.", `It is “done.”${G}Next ‘one.’${G}Last.`],
    ["after a parenthesis and a bracket", "(See above.)  Next [one.]  Last.", `(See above.)${G}Next [one.]${G}Last.`],
    ["after a chain of closers", "**Bold.**  Next _it._  Last.", `**Bold.**${G}Next _it._${G}Last.`],
    ["before an inline code span", "Done.  `npm test` passes.", `Done.${G}\`npm test\` passes.`],
    ["on every line of a paragraph", "One.  Two.\nThree!  Four.", `One.${G}Two.\nThree!${G}Four.`],
    ["a single space", "Done. Next.", "Done. Next."],
    ["spaces at a line end", "Done.  \nNext.", "Done.  \nNext."],
    ["spaces at the end of the text", "Done.  ", "Done.  "],
    ["no terminator", "word  word", "word  word"],
    ["a brace, which is not a closer", "Done.}  Next", "Done.}  Next"],
    ["an existing gap", `Done.${G}Next.`, `Done.${G}Next.`],
    ["a numbered-list marker", "1.  First item.  More.\n  12.  Second.", `1.  First item.${G}More.\n  12.  Second.`],
    ["inside an inline code span", "Run `a.  b` now.  Then stop.", `Run \`a.  b\` now.${G}Then stop.`],
    ["inside a double-backtick span", "Use ``x.  `y` `` here.  Ok.", `Use \`\`x.  \`y\` \`\` here.${G}Ok.`],
    ["inside a code span over two lines", "See `a.\nb.  c` here.  Ok.", `See \`a.\nb.  c\` here.${G}Ok.`],
    ["after a backtick with no closer", "A ` tick.  Then text.", `A \` tick.${G}Then text.`],
    ["inside a ``` block", "Intro.  Code:\n```\na.  b\n```\nAfter.  End.", `Intro.${G}Code:\n\`\`\`\na.  b\n\`\`\`\nAfter.${G}End.`],
    ["inside a ~~~ block", "~~~ts\nx.  y\n~~~\nOk.  Done.", `~~~ts\nx.  y\n~~~\nOk.${G}Done.`],
    ["inside a block behind a list marker", "- ```\n  a.  b\n  ```\nOk.  Done.", `- \`\`\`\n  a.  b\n  \`\`\`\nOk.${G}Done.`],
    ["inside a block a shorter fence does not close", "````\na.  b\n```\nc.  d\n````\nOk.  Done.", `\`\`\`\`\na.  b\n\`\`\`\nc.  d\n\`\`\`\`\nOk.${G}Done.`],
    ["inside an unclosed block", "Intro.  Code:\n```\na.  b", `Intro.${G}Code:\n\`\`\`\na.  b`],
    ["inside $$math$$", "$$x.  y$$ holds.  Next.", `$$x.  y$$ holds.${G}Next.`],
    ["inside multi-line $$math$$", "$$\na.  b\n$$\nOk.  Done.", `$$\na.  b\n$$\nOk.${G}Done.`],
    ["inside an @-mention", "@**J. R.  Bot** hi.  Ok.", `@**J. R.  Bot** hi.${G}Ok.`],
  ])("%s", (_name, input, expected) => {
    expect(sentenceGap(input)).toBe(expected);
    // idempotent: a second pass changes nothing
    expect(sentenceGap(expected)).toBe(expected);
  });
});
