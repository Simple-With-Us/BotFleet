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


Canonical detail: `/Users/jay/apps/FLEET-UI-COPY.md`.  Policy: `/Users/jay/apps/AG***-S**C.md` § Two spaces, timestamps, TestFlight metadata.

## Two spaces between sentences

Full protocol (always follow, do not weaken): skill `sentence-gap`
(`~/Desktop/fleet-skills/sentence-gap/SKILL.md` — Monet portable paste).

Binding for every paragraph a human reads — in-app UI, ASC description / promotional text / What’s New / review notes, push, email, help, Apple Notes, effort boards, **chat replies**, PR titles/bodies, commit messages, Slack.

- **Files** (repo docs, commit/PR/Slack/Notes source): two literal ASCII spaces after `.` / `!` / `?` before the next sentence.  Do not write `&nbsp;` into files.
- **Chat replies** (Claude/Monet transcript): type the HTML entity `&nbsp;` right after the period, then a normal space — `Sentence one.&nbsp; Sentence two.`  Two literal spaces collapse in the renderer.  A raw U+00A0 also disappears.  Verified ST PR #2893.

Single space stays correct after non-terminal abbreviations (`e.g.`, `v1.2.3`).  Two trailing spaces at the **end** of a Markdown line are a hard break — a different rule.

HTML/JSX/SwiftUI that collapse spaces: NBSP+space or `SENTENCE_GAP`.  Do not "fix" `Congress.Trade`, `Socratic.Trade`, URLs, emails, or `U.S.`.

Does not apply: identifiers, log lines, API enums, commit **subjects** that are fragments with no terminator.

## Theme default = light

First visit / no stored preference = **light**.  Do not boot dark from `prefers-color-scheme` unless the user chose System or Dark.  Dark is optional.  Screenshots, ASC, marketing: light unless the owner asked for dark.

## Headings vs values

- Headings / titles / buttons: **Title Case**.
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
- `/Users/jay/apps/AG***-S**C.md` § Two spaces; Theme via FLEET-UI-COPY; TestFlight template
- Skills: `apple-notes`, `sentence-gap`, `closeout`
