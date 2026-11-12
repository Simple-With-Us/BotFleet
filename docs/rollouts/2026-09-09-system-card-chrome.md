# 2026-09-09 — System-Instruction Card Chrome

## Context & Objective

Fixer PR #299 stores auto-delivered routine / webhook / iMessage prompts as `role=system` and renders them as a left-edge work card (`WebhookCard` / `ChannelEventCard`), not a blue user bubble.  Designer UI-pass: Title Case chrome, no coordinator-speak, light-first surfaces.

Stacked on `fixer/thread-append-auto-role`.  Extra-ship no.  No TestFlight.  Do not bounce live BotFleet.

## Changes Made

- Desktop `WebhookCard`: always-padded inset card (`bg-card` + hairline), Details/Collapse Title Case accent, non-expandable is a div not a disabled button, payload recessed `bg-inset`.
- Routine fallback headline names what actually fired it — **Scheduled Run**, **Run Now**, **Webhook**, or **Resource Alert** (`automationSourceLabel`, `src/lib/replies.ts`) — not a hardcoded "Scheduled Run" regardless of trigger (fixed post-review: a manual Run Now or a resource-pressure alert is neither scheduled nor a routine).  Subtitle is the instruction's first non-blank line.  Details noun is **Run Details**.
- Reply quote author for `role=system` uses the same `automationSourceLabel`, not a hardcoded "Scheduled Run".
- iOS `ChannelEventCard`: skip avatar on `.system`, light `secondarySystemBackground` fill, accent Details (no capsule chip), non-expandable is not a disabled button, maxWidth 580; headline/icon mirror the desktop fix (gauge icon for a resource alert).
- Merged `fixer/thread-append-auto-role` (post-review fixes landed on #299) into this branch; resolved the resulting headline/subtitle conflict by keeping the accurate-label logic as headline and the instruction text as subtitle, per the above.

## Verification

```
pnpm typecheck        # tsc -b (frontend) + tsc -p tsconfig.server.json (server) — clean
pnpm exec vitest run   # full suite: 3338 passed, 9 skipped, 1 pre-existing failure unrelated
                        # to this change (server/checkpoints.test.ts's chmod-0000 permission
                        # test — sandbox runs as root, which bypasses Unix permission bits;
                        # confirmed identical on origin/main before this branch)
```

iOS: could not run `xcodebuild` or capture a screenshot in this environment (no Xcode/simulator available — this is a cloud sandbox, not the Mac this repo's AGENTS.md assumes).  The iOS `ChannelEventCard` / `Models.swift` changes went through Swift-side code review only (no compile check), flagged explicitly in the PR thread reply.  A human on the Mac should build and screenshot before this ships to TestFlight, per AGENTS.md's UI verification gate.  No TestFlight.  Live BotFleet was not rebuilt.

## Next

Fixer: merge `grok/system-card-chrome` into `fixer/thread-append-auto-role` so #299 ships with this chrome.  Mac app still needs `update-botfleet.sh` after #299 lands; ask Jay first.
