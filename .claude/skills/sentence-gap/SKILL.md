---
name: sentence-gap
description: >-
  Always put a visibly wider gap between sentences in every human-readable reply and file. Applies on every turn — Cursor desktop, Cursor cloud, CLI, Grok, chat, commits, PRs, and docs. Follows Monet's portable protocol. Mechanism by surface: type the literal &nbsp; entity plus a space in Markdown chat panes (Claude Code Code tab, owner-verified 2026-10-08); a real U+00A0 plus a space in GitHub PR and issue text and Zulip; two ASCII spaces in files, commits, terminals and Slack. The owner must never see the six characters &nbsp; as text. Use whenever writing any prose a human will read.
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

### The catch that wastes everyone's time

**Typing two literal spaces usually does nothing visible.**  HTML and most Markdown
renderers collapse runs of whitespace to a single space.  So the assistant "complies,"
the raw text really does contain two spaces, and the human still sees one.  Both sides
then argue about whether the instruction was followed.

**The gap must survive the renderer between you and the reader.**  Which mechanism works
depends on the surface, so pick by destination:

| Destination | Use | Why |
|---|---|---|
| **Cloud / BotFleet / OpenMausBot chat** | two literal ASCII spaces | Owner 2026-09-03: never display the six characters `&nbsp;` in cloud text.  The backend maps doubles (or the entity) to a real U+00A0 before paint. |
| **Claude Code — desktop app (Code tab)** | the literal entity text `&nbsp;` then a normal space after each sentence, outside code spans → `End.&nbsp; Next.` | Owner-verified 2026-10-08 with a screenshot.  The renderer decodes the entity into a real gap.  A raw U+00A0 from the model arrives as a plain space, and two ASCII spaces collapse.  Supersedes the 2026-09-04 ASCII ruling and the 2026-08-19 finding below for this surface — see History. |
| **Any other agent chat pane that renders Markdown** (Codex, Cursor, Antigravity, Grok, Kimi, MiniMax, DeepSeek, Fx, Muse, and similar) | the same: `&nbsp;` then a normal space, outside code spans | Owner ruling 2026-10-08: Markdown chat collapses ASCII doubles everywhere, so use the entity by default and do not ask first.  Only the Code tab is verified; none of these panes has been individually confirmed to decode it.  If the owner ever sees the six literal characters, stop using the entity on that surface and report it in #agent-sync — that surface then needs a different mechanism, and it is unknown until tested. |
| **Terminal TUI chat** (Claude Code CLI, Grok TUI, Codex CLI, opencode, kimi-code, mcode) | two literal ASCII spaces | Unverified.  A terminal prints the entity as the literal text `&nbsp;`, which the owner must never see.  Do not use the entity here. |
| **Plain-text chat (no Markdown rendering)** | two literal ASCII spaces | Nothing collapses them; an entity would show as the ugly text `&nbsp;` |
| **Files read as source** — repo docs, commit messages, code comments, config, diffs, terminal output, Slack posts | two literal ASCII spaces | Read in an editor/terminal/`git diff`, which preserve them verbatim; an entity would appear literally |
| **HTML / JSX / SwiftUI / any rendered product copy** | a real U+00A0 plus a space, or a shared `SENTENCE_GAP` constant | Raw double spaces collapse in HTML.  Source may use the entity only when the renderer expands it.  The owner must never see `&nbsp;` as text. |
| **GitHub PR and issue titles, bodies and comments, review comments, Zulip posts, and any text a tool writes that a Markdown or HTML renderer then displays** | a real U+00A0 plus a space | Owner ruling 2026-10-08.  Tools preserve the character, and the renderer shows a real gap.  Never use the `&nbsp;` entity here: GitHub can copy a PR body into a plain-text squash commit, where the entity would show literally.  Supersedes the 2026-10-07 finding that two ASCII spaces were enough in Zulip. |
| **Markdown source** | two literal spaces *between* sentences | ⚠️ Two spaces at the **end of a line** is the unrelated hard-line-break syntax — don't confuse the two |

**Producing U+00A0 through a tool.**  You cannot type a raw U+00A0 into your own chat reply,
but a shell step can produce one.  Write the text with two ASCII spaces after each sentence,
then convert it before it leaves your hands:
`perl -CSDA -pe 's/([.!?])  (?=\S)/$1\x{a0} /g' body.txt > body.nbsp.txt`.  Check that the
output holds at least one U+00A0 (`grep -c $'\xc2\xa0' body.nbsp.txt`) before passing it to
`gh pr create --body-file`, `gh pr comment --body-file`, or the text you hand to `agent-sync post`.

### Verify, don't assume — run this self-test only on a NEW, unlisted surface

The table above already answers every surface listed in it — follow the row, don't re-test
it.  For a surface the table does **not** cover, test it and ask the human what they
actually see before relying on either mechanism.

> Output these two lines verbatim, then ask which shows a wider gap:
>
> A. `Sentence one.&nbsp; Sentence two.`
> B. `Sentence one.  Sentence two.`
>
> If A looks wider → use the `&nbsp;` entity on this surface, and add the surface to the table.
>   Owner ruling 2026-10-08: when a surface collapses two typed spaces, use its working
>   mechanism without asking.
> If B looks wider, or they look identical → use two literal spaces.
> If neither shows a gap → say so plainly and ask how they want it handled.
> Then keep using whichever won, for that surface, for the rest of the session — and add
> the surface to the table above so nobody re-tests it.

### History — 2026-08-19/20 findings on Claude Code (terminal + desktop), do NOT re-run these tests

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
