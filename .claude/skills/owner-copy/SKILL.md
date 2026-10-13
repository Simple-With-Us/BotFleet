---
name: owner-copy
description: Fleet human-facing prose — two spaces between sentences, light theme default, Title Case headings, no agent names in App Store/TestFlight notes, Central Time labels. Use when writing UI strings, ASC listing fields, PR/commit/Slack/Notes prose, release notes, or any paragraph a human will read. Also when changing theme defaults or taking screenshots.
---

# Owner-facing copy (MONET)

> **Shared `~/.claude/skills`.** Monet, Claude/Fable, and (when active) Renoir all load this directory.  Do not treat the word Monet in examples as proof of your seat.  Pin `AGENT_SEAT` / `AGENT_TAG` from the logged-in account before Slack or `board --by`:
> - Monet → `MONET`, Notes `Monet`, `monet/`, `~/apps/<app>-monet`
> - Claude / Fable → `CLAUDE`, Notes `Claude`, `claude/`, `~/apps/<app>-claude`
> - Renoir → `RENOIR`, Notes `Renoir`, `renoir/`, `~/apps/<app>-renoir`
> Cursor, Grok, Grok Bot, Codex, AG, DeepSeek, Kimi, and Fx have their own skill dirs and must not take identity from here.


Canonical detail: `/Users/jay/apps/FLEET-UI-COPY.md`.  Policy: `/Users/jay/apps/AGENT-SYNC.md` § Two spaces, timestamps, TestFlight metadata.

## Two spaces between sentences

Full protocol (always follow, do not weaken): skill `sentence-gap`
(`~/Desktop/fleet-skills/sentence-gap/SKILL.md` — Monet portable paste).

Binding for every paragraph a human reads — in-app UI, ASC description / promotional text / What’s New / review notes, push, email, help, Apple Notes, effort boards, **chat replies**, PR titles/bodies, commit messages, Zulip.

- **Files** (repo docs, commit messages, code comments, config, terminal output, Slack posts): two literal ASCII spaces after `.` / `!` / `?` before the next sentence.  Do not write `&nbsp;` into files.
- **GitHub PR and issue titles, bodies and comments, and Zulip posts:** a real U+00A0 plus a space after each sentence (owner ruling 2026-10-08).  Never the `&nbsp;` entity there: GitHub can copy a PR body into a plain-text squash commit, where it would show literally.
- **BotFleet / OpenMausBot / cloud chat:** two ASCII spaces.  Never display the six characters `&nbsp;` (owner 2026-09-03).  Backend inserts a real U+00A0 if the renderer would collapse the gap.
- **Claude Code desktop app (Code tab) chat replies:** type the `&nbsp;` entity plus a normal space after each sentence, outside code spans (owner-verified 2026-10-08; the renderer decodes it, a raw U+00A0 from the model arrives as a plain space, and ASCII doubles collapse).  The 2026-09-04 ASCII ruling is withdrawn.
- **Any other Markdown-rendering agent chat pane** (Codex, Cursor, Antigravity, Grok, Kimi, MiniMax, DeepSeek, Fx, Muse): the same entity plus a space (owner ruling 2026-10-08), not individually verified.  If the six literal characters ever show, stop and report it in #agent-sync.  **Terminal TUIs** (Claude Code CLI, Grok TUI, Codex CLI): two ASCII spaces, unverified.

Headings / titles / buttons: **Title Case**.
- Values / secondary status: sentence case or lowercase (`not reported`, `ask-first`).
- Congress and Congressional take a capital C.  Brand **Congress.Trade**, **DealDex**, **Socratic.Trade**.
- Compact money suffixes lowercase (`$99.8k`).  Do not say “Live” on account rows; paper is `Alpaca (paper)`.
- CT latency: never print `+`/`−` on lead/lag.  Say **earlier** (green) or **later** (red).
- No All-Assets dropdown on CT web/iOS.

## Product truth in listing copy

- Congress.Trade corpus is House, Senate, **and Executive Branch** (OGE 278-T) — never "Congress-only."
- Premium trial length must match the live ASC intro offer (**2 weeks** as of 2026-08-14), never a leftover 1-month.
- **No internal agent names** in TestFlight / App Store / public release notes.

## Timestamps (owner-facing agent writing)

When you tell the owner a time, say it in Central Time.  Write `Sat, Aug 22, 2026 at 7:00 PM CT`.  Always label `CT` / `CDT` / `CST`.  Never UTC-only in chat, Notes, Slack, boards, or PRs.  UTC may follow in parentheses after the Central stamp.  `00:00 UTC` is 7:00 PM CT the previous calendar day in CDT (6:00 PM CT in CST).  Convert with `TZ=America/Chicago date` or Python `ZoneInfo("America/Chicago")`.  Unlabeled local time is the failure mode.

Product UI times are the **viewer's** timezone except market-day accounting (Chicago) and session bells (`9:30 AM ET`).

## Canon

- `/Users/jay/apps/FLEET-UI-COPY.md`
- `/Users/jay/apps/AGENT-SYNC.md` § Two spaces; Theme via FLEET-UI-COPY; TestFlight template
- Skills: `apple-notes`, `sentence-gap`, `closeout`
