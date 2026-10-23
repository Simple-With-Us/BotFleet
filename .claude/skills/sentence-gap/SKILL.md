---
name: sentence-gap
description: >-
  Always put a visibly wider gap between sentences in every human-readable reply and file. Applies on every turn — Cursor desktop, Cursor cloud, CLI, Grok, chat, commits, PRs, and docs. Follows Monet's portable protocol. Mechanism (owner ruling 2026-10-23, the same on every surface): a real U+00A0 plus a normal space between sentences; never the &nbsp; entity, and never two plain ASCII spaces, which collapse on rendered surfaces. Use whenever writing any prose a human will read.
---

# Sentence gap (portable — always on)

> **Shared `~/.claude/skills`.** Monet, Claude/Fable, and (when active) Renoir all load this directory.  Do not treat the word Monet in examples as proof of your seat.  Pin `AGENT_SEAT` / `AGENT_TAG` from the logged-in account before Slack or `board --by`:
> - Monet → `MONET`, Notes `Monet`, `monet/`, `~/apps/<app>-monet`
> - Claude / Fable → `CLAUDE`, Notes `Claude`, `claude/`, `~/apps/<app>-claude`
> - Renoir → `RENOIR`, Notes `Renoir`, `renoir/`, `~/apps/<app>-renoir`
> Cursor, Grok, Grok Bot, Codex, AG, DeepSeek, Kimi, and Fx have their own skill dirs and must not take identity from here.


Source of truth: `/Users/jay/Code/AI-Fleet-Coordinator/docs/SENTENCE-GAP-PORTABLE-SKILL.md`

The block below is Monet's protocol, pasted verbatim. Follow it exactly. Do not weaken it. Cloud agents without the Mac filesystem still have the full protocol in this file.

### Rule: two visible spaces between sentences

Put a **visibly wider gap** between sentences — after `.` `!` `?` when a new sentence
follows — in every piece of prose a human reads.  Not just product copy: chat replies,
commit messages, PR titles and bodies, code comments, docs, tickets, Zulip posts, release
notes, design docs.

Do **not** add a gap after a non-terminal abbreviation (`e.g.`, `i.e.`, `Dr.`, `v1.2.3`),
inside a URL, email, filename, or a brand name containing a period.

### Current rule (owner ruling 2026-10-23) — one mechanism on every surface

Jay, Fri, Oct 23:  update the rule everywhere, so it is the same on every surface.  Between
sentences, write a **real U+00A0 (no-break space) followed by a normal space**.  That covers
chat replies in every pane, Zulip, GitHub PR and issue text and review comments, Linear,
Slack, commit messages, repo docs and Markdown, skills, agent instructions, and UI copy.

- **Never write the `&nbsp;` entity.**  It shows up as literal text in squash-merge commits,
  plain-text email and many APIs.
- **Two plain ASCII spaces are not enough.**  Rendered surfaces (Zulip, GitHub, Linear, HTML,
  Markdown chat panes) collapse them to one.
- **Generate the U+00A0 in the shell** (the converter below, or `printf '\302\240'`) rather
  than typing it, because a model-typed U+00A0 can be normalized to a plain space.  Check the
  bytes before you post.
- In HTML, JSX and Swift source, write it as `\u00A0 ` or use a shared `SENTENCE_GAP` constant.
- Code, identifiers and machine-readable config never get a U+00A0.
- If a surface strips U+00A0, leave the text as it is rather than switching to the entity, and
  report the surface in #Work-In-Progress.

This replaces every earlier per-surface rule:  the entity in chat panes (2026-10-08, 2026-10-18)
and on GitHub (2026-10-22), and two ASCII spaces in files, commits, terminals and untested
surfaces (2026-10-20).  Where older text below disagrees, this section wins.

### The catch that wastes everyone's time

**Typing two literal spaces usually does nothing visible.**  HTML and most Markdown
renderers collapse runs of whitespace to a single space.  So the assistant "complies,"
the raw text really does contain two spaces, and the human still sees one.  Both sides
then argue about whether the instruction was followed.

**The gap must survive the renderer between you and the reader.**  Which mechanism works
depends on the surface, so pick by destination:

| Destination | Use | Why |
|---|---|---|
| **Every surface** — chat replies in any pane, Zulip, GitHub PR and issue titles, bodies and comments, review comments, Linear, Slack, commit messages, repo docs and Markdown, skills and agent instructions, rendered product copy | a real U+00A0 plus a normal space | Owner ruling 2026-10-23:  one rule everywhere.  Two ASCII spaces collapse on rendered surfaces, and the `&nbsp;` entity shows as literal text in squash commits, plain-text email and many APIs.  This replaces every earlier per-surface row. |
| **HTML / JSX / Swift source for product copy** | `\u00A0 ` in source, or a shared `SENTENCE_GAP` constant | The rendered result is the same U+00A0 plus a space.  Never `&nbsp; `. |
| **Code, identifiers and machine-readable config** | no gap character | Never put U+00A0 into code, identifiers or config. |
| **A surface that strips U+00A0** | leave the text as it is | Do not switch to the `&nbsp;` entity.  Report the surface in #Work-In-Progress. |
| **Markdown source** | the same U+00A0 plus a space *between* sentences | ⚠️ Two spaces at the **end of a line** is the unrelated hard-line-break syntax — don't confuse the two |

**Producing U+00A0 through a tool.**  You cannot type a raw U+00A0 into your own chat reply,
but a shell step can produce one.  Write the text with two ASCII spaces after each sentence,
then convert it before it leaves your hands:
`perl -CSDA -pe 's/([.!?])  (?=\S)/$1\x{a0} /g' body.txt > body.nbsp.txt`.  Check that the
output holds at least one U+00A0 (`grep -c $'\xc2\xa0' body.nbsp.txt`) before passing it to
`gh pr create --body-file`, `gh pr comment --body-file`, or the text you hand to `agent-sync post`.

### Verify, don't assume — run this self-test only on a NEW, unlisted surface

Since 2026-10-23 every surface takes a real U+00A0 plus a normal space, so there is nothing to
choose.  On a surface nobody has checked yet, post one test line with the gap generated in the
shell and ask the human whether they see a wider gap.  If the surface strips the U+00A0, leave
the text as it is, never switch to the `&nbsp;` entity, and report the surface in
#Work-In-Progress.

### History — 2026-08-19/20 findings on Claude Code (terminal + desktop), do NOT re-run these tests

**2026-10-23 update — one mechanism everywhere.**  The owner replaced every per-surface rule
with one:  a real U+00A0 plus a normal space on every surface, never the `&nbsp;` entity, and
never two plain ASCII spaces.  The entity rows (chat panes 2026-10-08 and 2026-10-18, GitHub
2026-10-22) and the two-ASCII-space rows (files, commits, terminals, untested surfaces) below
are history only.

**2026-09-04 update — desktop app superseded.**  The entity finding below for the desktop
app (Code tab) was superseded by an owner-verified ruling on 2026-09-04: use **two literal
ASCII spaces** there.  The 2026-08-19 entity advice for the desktop app was withdrawn.

**2026-10-08 update — desktop app superseded again.**  On the Code tab, type the `&nbsp;`
entity plus a space after each sentence (outside code spans); the renderer decodes it.  A raw
U+00A0 from the model arrives as a plain space (0 NBSPs in the verified reply), and two
ASCII spaces collapse.  Owner-verified 2026-10-08 with a screenshot.  The 2026-09-04 ASCII
ruling is withdrawn.

**Terminal CLI — no newer ruling.**  Last checked 2026-08-19/20; not re-verified since.
Default to two literal ASCII spaces there, and do not use the `&nbsp;` entity on a terminal
TUI, which would print it literally.

What was found 2026-08-19/20:

- ❌ **Two literal ASCII spaces in chat** — collapsed by the Markdown renderer.  Invisible.
- ❌ **A raw U+00A0 character typed directly into chat** — normalized away in the
  transcript view.  **Especially deceptive: copy-pasting the reply out can still show two
  spaces, so it looks fixed when the human still sees one.**  Do not trust copy-paste as
  proof.
- ❌ **App/output settings** — no toggle governs inter-sentence spacing.  Output-style
  settings change tone only; headless output-format flags don't apply to interactive chat;
  screen-reader modes only drop borders.
- ❌ **Patching the client** — compiled and signed; breaks code signing and is wiped by
  auto-update.  Never attempt.
- ✅ The literal entity text `&nbsp;` + a space rendered as a visibly wider gap, and does
  again on the desktop app (re-verified 2026-10-08, see above).  Not re-verified on the
  terminal CLI since, so use two ASCII spaces there.
- ✅ **Two literal ASCII spaces in files** — correct and simplest; leave file content alone.

### The transferable lesson

When an instruction *appears* not to take effect, **stop repeating the promise and
diagnose the rendering layer between you and the reader** — then ask them what is on their
screen.  Four rounds of "fixed it!" were spent here before anyone checked whether the
change could be seen at all.  Intent is not output; output is not what is displayed.
