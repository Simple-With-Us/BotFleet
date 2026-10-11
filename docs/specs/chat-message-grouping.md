# Chat Message Grouping — Shared Spec (Mac + iOS)

**Date:** Sun, Oct 11, 2026 · **Seat:** MM · **Board:** `4904f628`
**Follows:** [2026-10-11-ios-chat-library-options.md](2026-10-11-ios-chat-library-options.md) open follow-up 3

Grouping is the one confirmed gap from the chat-surface survey.  This is the contract both
platforms implement, written before the spike so the spike implements a spec rather than
retro-fitting a document to whatever the spike happened to produce.

The two clients disagree on almost everything — Mac is Electron + React, iOS is SwiftUI — so the
only way the behaviour stays coherent is to fix the *rules* here and keep the code on each side
a translation of them.

## 0. What already exists (read this before implementing)

Grouping is **not** absent on iOS.  `ios/Sources/CompanionCore/ActivityRuns.swift` already has:

- `TranscriptItem` — `.message` or `.run(id:messages:)`, run id is its first message's id.
- `groupActivityRuns(_:)` — folds consecutive tool activities into runs.
- `isFoldableActivity(_:)` — excludes comm rows and `error:` tools from folding.
- `transcriptRowEndsRun(at:in:liveReply:liveSpeaker:)` — where a bubble run gets its tail and avatar.
- `transcriptRowStartsAStretch(at:in:)` + `transcriptStretchGap` — timestamp-at-break logic.
- `transcriptRowId(containing:in:)` — maps a message id to the row that shows it, so scroll survives folding.

So the "~40 lines" estimate was wrong, and this section says so plainly rather than leaving a
number nobody checked.  The real gaps are narrower and are what the spike should build:

| Spec clause | iOS today | Gap |
|---|---|---|
| 2.1 same-speaker + gap | `endsRun` decides *tails and avatars* per row; it does not build groups | Text bubbles do not form a group object, so a run has no header and no identity |
| 2.3 tool runs collapse | `groupActivityRuns` does this | Runs **only** cover tool activity.  A text run — several prose bubbles from one bot — is not a group |
| 2.4 timestamps at breaks | `transcriptStretchGap` = **30 min** | Spec says 10.  One of the two is wrong; see 2.4 |
| 3 accessibility | **Absent** — no group has an accessibility element or label | The real accessibility gap, and the one that must not ship without grouping |
| 4.9 both clients agree | Mac has **no grouping at all** (`groupActivityRuns` appears 0× in `src/`) | This is the largest gap by far |

The spike therefore does three things: extend folding from tool-runs to text-runs, add the group
accessibility label, and port the whole thing to Mac.  It does **not** rebuild `TranscriptItem`
or `groupActivityRuns`; it generalises them.

## 1. What grouping is for

A bot turn is not one message.  A single turn arrives as a run of messages: a tool chip, a
thought-chamber row, two text bubbles, another tool chip.  Rendered naively, that reads as a dozen
unrelated interruptions from the same speaker.  Grouping makes a run read as what it is: one turn,
with its parts nested under it.

The win is legibility, not density.  It must never hide a message, drop a tool chip, or reorder
anything.

## 2. Grouping rules

Given the ordered message list for a thread, walk it and assign each message a group.

### 2.1 Same-speaker rule

Two adjacent messages join the same group when **all** hold:

- same **speaker key** (see 2.2), and
- same **branch** — equal `parentId`, treating `nil`/`null` as one value, and
- the later message's `at` is within **GROUP_TIME_GAP_MS** of the earlier one.

`GROUP_TIME_GAP_MS` = **60_000** (60 seconds).

A 60-second gap is chosen deliberately.  It is long enough to cover a slow tool call inside one
turn, and short enough that a reply an hour later does not silently join the previous run.  A
turn where the bot pauses visibly while thinking can exceed it; the tail then splits into two
groups, which is honest — it *was* two stretches of activity.

Note this is a **different constant** from `transcriptStretchGap` (30 min) and they must not be
conflated: that one decides *stamping*, this one decides *membership*.  Merging them would mean a
group survives a 45-minute pause, which is not a group.

### 2.2 Speaker key

The speaker key is **not** `role`.  A `user` message from the human and a `user`-role message
mirrored from a peer bot both render on the same side, so `role` alone would merge them.

```
speakerKey(message) =
    role == "system"   ? "system:" + (automationSource ?? "unknown")
  : role == "bot"      ? "bot:" + (botId ?? threadBotId)
  : role == "user"     ? (from?.botId ? "bot:" + from.botId : "user:me")
  : "unknown"
```

`system` rows never group with anything, including each other.  An auto-delivered instruction is
its own event, and two routine rows arriving together are two events.  This matches existing
behaviour: `system` messages are never given the human's treatment on either platform.

### 2.3 Tool runs collapse

Consecutive **tool** messages from the same speaker inside the gap collapse into a single group
row that lists the steps in order, rather than one row per chip.

Two rules make this safe:

- **A tool group is bounded by non-tool messages.**  `tool, tool, text, tool` is
  `toolRun[2], text, toolRun[1]` — not one run of three.  The user asked a question mid-run; the
  run after it is a different run.
- **A run that fails is never merged away.**  A group whose steps are not all `ok` keeps each
  failing step individually visible.  Collapsing a failure into a count is how a user misses that
  their deploy broke.

### 2.4 Timestamps at group breaks

A group shows a timestamp **only at its first message** when:

- it is the last group in the thread, or
- the gap to the *previous* group exceeds **STAMP_GAP_MS** (10 minutes).

Otherwise the timestamp is suppressed and the bubble tightens.  Every suppressed timestamp is
still reachable: it appears in the row's accessibility label and in the hover/`formatHoverTime`
affordance that already exists on the Mac surface.

Rationale: an ungrouped transcript shows a timestamp on nearly every row, which is noise.  A
grouped one shows it at the start of a run and at any real pause — which is information.

### 2.5 Group continuity is not authority

Grouping changes **presentation only**.  Every message keeps its own identity, stays individually
addressable for copy, reaction, pin, edit, retry and request-ID, and remains in the transcript.
There is no "collapse the group" affordance in this spec; if a user needs the underlying rows,
they are already reachable.  Adding a real collapse toggle is a later decision, not part of v1.

## 3. Accessibility — the part that is easy to get wrong

Grouping is exactly where accessibility regresses if it is done only visually.

- **Each group is one accessibility element with a summary**, not a nest of focusable rows read
  one after another.  `"\(sender), \(count) messages, \(relative time)"` is the minimum.
- **A VoiceOver user must still reach every message in the group.**  The group exposes its
  members; it does not swallow them.  If the implementation cannot satisfy this, the group is
  wrong — do not ship the visual grouping without it.
- **Grouped runs keep per-step status in the label.**  A run reads as "3 steps, 2 succeeded, 1
  failed" rather than silently merging to "3 steps".
- **Dynamic Type.**  Grouping reduces vertical spacing, never text size.  At AX5 a group header
  wraps and the group grows; nothing truncates.

## 4. Acceptance criteria

A client implements this when:

1. Consecutive same-speaker text messages inside 60s render as one group with a single header.
2. A message outside the gap, from a different speaker, or on a different branch starts a new group.
3. `system` rows never group.
4. A tool run collapses into one row, is bounded by intervening non-tool messages, and keeps
   failures individually visible.
5. A group carries a timestamp at its start when it is the last group or the previous gap exceeds
   10 minutes; suppressed timestamps stay available on hover and in the accessibility label.
6. Every message in a group remains individually copyable, pinnable, and addressable by ID.
7. The group is a single accessibility element that can still reach each member message.
8. At AX5 nothing truncates and nothing reorders.
9. Mac and iOS, given the same message list, produce the **same groups** — same membership, same
   boundaries, same break timestamps.

Criterion 9 is the one that makes this a shared spec rather than two documents that happen to
agree.  It is checkable: run both implementations over a fixture and compare group membership.

## 5. Not decided here

- Whether a group can be collapsed by the user (2.5).
- Whether `kind: "screen"` rows group (they are media, not prose; deferred to the spike).
- Whether the Mac composer's steer-queue chips are part of a group (they are pending rows, not
  settled messages; deferred).

## 6. Sources

- `ios/Sources/CompanionCore/Models.swift:133` — iOS `Message` (`role`, `kind`, `at`, `tool`,
  `from`, `parentId`, `automationSource`)
- `src/state/store.tsx:99` — Mac `Message` (same field names, plus `connector`/`secret` kinds)
- `ios/App/ChatView.swift` — `MessageRow`, `endsRun` (visual grouping that exists today, applied
  per-message rather than per-run)