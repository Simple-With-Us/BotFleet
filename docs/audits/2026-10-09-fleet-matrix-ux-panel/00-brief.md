# Panel Brief: Fleet Matrix, Kanban Command Center, And Workspace Arrangement

Status: open for positions until Fri, Oct 9, 11:00pm (owner's clock).  Moderator: the CLAUDE seat.  Board row: `b1c24947`.  Zulip: `#agent-sync` › `BF b1c24947 fleet-matrix ux panel`.

This folder holds the evidence packet for a cross-seat UI design panel on the BotFleet Mac app.  The owner asked for UI experts to debate whether the new overview layer (App Deck, Fleet Matrix, Kanban Command Center) was an improvement, whether the top of the app is the right home for it, which view options earn their place, how threads, bots and apps should be organized, and which new Workspace Arrangement options should exist.  Every seat that takes part reads the same three files and answers the same six questions.

Files beside this one:

- `01-evidence.md`: what shipped, who built it, where it lives, how it behaves, and what is already known to be wrong, with file:line citations.
- `02-candidate-arrangements.md`: a seed menu of new arrangement modes, each with its runtime toggles, its strongest objection, and a migration-safe way to add it.
- `screenshots/`: the owner's three captures from the installed build on Thu, Oct 8 (Settings, the Kanban board, the Matrix grid).
- `R<n>-<seat>-<lens>.md`: one position per seat, added by that seat's own docs-only PR.

Suggested lenses, so the panel does not get five copies of one view: the seat that built the deck, matrix and kanban takes Builder's Defense; the seat that wrote the arrangement axes takes Settings And Config Model; the seat that wrote the task-to-app binding takes Information Architecture.  Any seat may take a different lens if it has a stronger case there.  Say which one in your first line.

## The Prompt To Hand A Seat

Copy everything inside the block to the seat as its task.  Replace `<SEAT>` with the seat tag.

```
repo: BotFleet
[OWNER→<SEAT>] UX panel: Fleet Matrix, Kanban Command Center, and Workspace Arrangement

You are one voice on a cross-seat UI design panel for BotFleet.  This task is read-only
on product code.  Do not fix anything you find; the defects the evidence names already
have board rows and CLAUDE lanes: 6689e3f3 (overview auto-dismiss), fbd2be5e (kanban
card flood), 710979ea (fleet pill double count), 20725f10 (arrangement copy).

1. Read, from a fresh worktree off origin/main (never ~/Code/BotFleet):
   docs/audits/2026-10-09-fleet-matrix-ux-panel/00-brief.md
   docs/audits/2026-10-09-fleet-matrix-ux-panel/01-evidence.md  (file:line evidence; screenshots beside it)
   docs/audits/2026-10-09-fleet-matrix-ux-panel/02-candidate-arrangements.md
   and the code they cite.  Verify a claim before you lean on it; line numbers drift.

2. State your lens in your first line.  Pick the one you can argue best, or the one
   named when this was handed to you: Information Architecture; Mission-Control
   Operations; Chat-Product; Settings And Config Model; Builder's Defense (for the seat
   that built the deck, matrix or kanban).

3. Answer the six questions in order, each with a verdict and file:line evidence:
   Q1  Was the App Deck, Fleet Matrix and Kanban Command Center an improvement over the
       chat-first layout?  Better or worse at what, and for whom.
   Q2  Is the top of the main pane the right home for the deck, the header card and the
       stat pills, versus the sidebar, a separate Overview destination, or the command
       palette?
   Q3  Matrix Grid versus Kanban Board versus other views (a needs-you list, a timeline,
       a per-app list): which earn their place, which should be the default, and what
       is missing.
   Q4  How should threads, bots and apps (rooms) be organized: the primary axis,
       nesting, sections, naming.  Does the App Deck duplicate the sidebar?
   Q5  Should Workspace Arrangement grow new options, and which?  Argue for or against
       each candidate in 02, propose at most one of your own, and say whether the
       overview makes Simple versus Apps moot.
   Q6  What is misleading or broken today that must change whatever the design outcome.

4. Close with three ranked recommendations, each with effort (S, M, L), and the one
   decision only the owner can make.

5. Deliver at most 1,500 words as
   docs/audits/2026-10-09-fleet-matrix-ux-panel/R<n>-<seat>-<lens>.md
   (next free n, lowercase seat tag, for example R6-ag-builders-defense.md) by a
   docs-only PR titled "docs(panel): <seat> position on Fleet Matrix and arrangements",
   auto-merge armed.  If you cannot open a PR, post the full text in Zulip #agent-sync,
   topic "BF b1c24947 fleet-matrix ux panel", and the moderator (CLAUDE) mirrors it with
   your name on it.  Deadline: Fri, Oct 9, 11:00pm (owner's clock).  Late papers get an
   addendum, not a rewrite.

6. House rules: two spaces between sentences; Title Case headings; the product word is
   "bot", never "agent"; no seat names in proposed product copy; cite file:line for every
   claim about current behavior and mark anything unverified; quote at most ten lines of
   code at a time.  Do not open a new board row; comment on b1c24947 instead.
```

## What Happens After The Deadline

The moderator reads every position, writes the synthesis at `docs/audits/2026-10-09-fleet-matrix-ux-panel.md` (verdict, the debate by question, course corrections, findings, the ranked arrangement proposal, and the decisions only the owner can make) and the proposal at `docs/plans/2026-10-09-workspace-arrangements.md`.  Nothing is implemented from the proposal until the owner picks.
