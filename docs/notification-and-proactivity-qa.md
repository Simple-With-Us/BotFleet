# Agent notifications and proactivity QA

BotFleet treats **proactivity as an explicit trigger**, not as a hidden
heartbeat. A bot may continue within an active task through Auto mode, may be
started by a Routine or Webhook, and may coordinate peers when its engine and
profile allow that. This change does not add background polling that invents
work or sends messages without one of those configured paths.

## Notification policy

The harness is the single owner of interruption policy. A bot with
notifications disabled remains quiet. Otherwise it may emit:

- **Needs approval** or **has a question** when the task is blocked on the user.
- **Needs your hands** when a computer task requires a takeover.
- **Finished** only when there is a non-empty result to summarize.
- **Routine failed** when a scheduled or manual routine run cannot complete.

Every notification carries both the bot ID and the exact task thread ID. A
click must select that bot **and switch to that task**, including a routine's
detached task; opening whichever task happens to be active is a failure.

Desktop notifications are suppressed while the window already has focus. The
iOS app can present live or replayed notifications while it is running and uses
the same bot/task target when the notification is tapped. The Mac sidecar
APNs-wakes a paired phone that is not streaming. Local network or VPN
connectivity alone cannot provide closed-app delivery.

### Snooze — bot-wide and per-thread

Two snoozes exist, and they are different sizes.  **Bot snooze**
(`server/routines.ts`, what "snooze bot on stop" leaves behind) stops routines
and webhooks restarting a bot at all.  **Thread snooze**
(`shared/thread-snooze.ts`) quiets one conversation while the bot keeps working
its other threads.

They compose in one direction only: a snoozed bot implies every thread under
it, because nothing may wake that bot; waking a thread never wakes the bot,
because the person who stopped a bot did not ask for it back.  `server/index.ts`
resolves both at the call site, so `buildNotification` stays a pure policy
function with no clock and no store of its own.

Only the **banner** is suppressed while a thread sleeps.  Unread still
accumulates, the transcript still fills, and a waiting approval card is still
there when the person looks — so a thread that wakes is loud again with no
backlog to replay.

The state is three values on the task record and nothing else: absent means
awake, `0` sleeps until the thread does anything again, and a timestamp sleeps
until that moment.  `PATCH /api/bots/:id/tasks/:threadId` takes JSON `null` to
wake a thread; an omitted field means "leave it alone", which is what lets a
rename on the same route not disturb a snooze.  The harness heals expired
deadlines on read and sweeps them every minute, so a desktop or phone left open
watches the row wake without anyone touching that bot.  A snoozed thread sinks
in the sidebar and in the phone's thread tabs rather than disappearing, and
returns to plain update order the moment it wakes — except the thread the
person currently has open, which stays where it is.

## Automated coverage

| Contract | Test |
|---|---|
| Per-agent off means quiet; empty completions stay quiet; summaries are bounded | `server/notify.test.ts` |
| Browser click returns the exact bot/task target | `src/lib/notify.test.ts` |
| Store navigation selects the bot and switches the task | `src/state/store.test.ts` |
| Routine failure receipt and callback occur once | `server/routines.test.ts` |
| Real failed routine emits one `routine-failed` notification and no duplicate `done` | `server/notification-wiring.test.ts` |
| iOS target parsing and detached-task decision | `ios/Tests/CompanionCoreTests/DecodingTests.swift` |
| Paired-device route policy remains default-deny | `companion/test/routes.test.ts` |
| APNs alert carries content-available; disconnected phones wake; 410 drops the token | `companion/src/apns.test.ts` |
| APNs and local notification userInfo both parse to a bot/task target | `ios/Tests/CompanionCoreTests/DecodingTests.swift` |
| Thread snooze rules — sentinel, deadline, labels, ordering | `shared/thread-snooze.test.ts` |
| Thread snooze persists, wakes on activity, sweeps, and silences banners | `server/thread-snooze.test.ts` |
| Thread snooze over HTTP: set, wake with null, heal an expired deadline | `server/index.test.ts` |
| Sidebar snooze badge, wake button, and row ordering | `src/components/SidebarThreadRow.test.tsx` |
| Phone snooze wire contract, presets, badge, and tab ordering | `ios/Tests/CompanionCoreTests/ThreadSnoozeTests.swift` |

## Manual release pass

Run these with two bots, notifications enabled on one and disabled on the
other:

1. Background the desktop window. Complete a normal task and confirm one
   result notification. Click it and verify the exact task opens.
2. Trigger an approval and a question. Confirm their copy, click targets, and
   that no duplicate completion notification appears before the task settles.
3. Run a routine manually, then create a controlled failing run. Confirm the
   receipt shows the detached task and the failure generates exactly one alert.
4. Repeat the above with notifications disabled for that bot; the chat and run
   receipt should update without a system alert.
5. On iOS, tap a live/replayed notification for a non-active routine task.
   Confirm the app switches the server-side active task before navigating.
6. Exercise Auto mode, a Routine, and a Webhook independently. Verify each has
   a visible initiating user/configured trigger and that no unconfigured
   heartbeat starts work.
7. Right-click a thread in the sidebar and snooze it for an hour.  Confirm the
   row dims, sinks below its awake siblings, shows the resolved wake time, and
   goes quiet — while its unread badge still counts a reply that lands.  Wake
   it from the row and confirm it returns to update order at once.
8. Snooze a thread until activity, then send it a message.  It must wake on
   that message alone, with no timer involved.
9. Snooze one thread of a bot and confirm the bot's OTHER threads still notify.
   Then snooze the whole bot and confirm every thread under it goes quiet,
   and that waking one thread does not restart the bot.
10. On iPhone, snooze a thread from the task sheet.  Confirm the moon badge and
    the same resolved deadline the Mac shows, that the tab sinks but the open
    tab does not move, and that Stop snoozing brings it straight back.

Live provider, OS-permission, backgrounding, and APNs behavior cannot be proven
by unit tests alone and remains part of the signed desktop/iPhone release pass.
