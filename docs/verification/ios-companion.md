# iOS companion pairing and stream resume

The iOS companion fixture verifies server QR confirmation, manual pairing codes, stream recovery after network interruption, and hidden activity isolation using disposable simulators and offline fixtures.

## Setup

```sh
cd ios && swift test
```

Or run a specific companion test:

```sh
xcodebuild -scheme BotFleet -destination 'platform=iOS Simulator,name=iPhone 15' test
```

The test suite:

1. Starts an isolated BotFleet server
2. Launches a simulator instance
3. Runs pairing flows (QR code and manual codes)
4. Simulates stream interruption and recovery
5. Verifies transcript folds and Hidden activity markers

## Steps

```sh
# 1. Run the iOS test suite
cd ios && swift test

# 2. Expected assertions:
# - QR code generation succeeds and encodes the server URL
# - Manual pairing codes are displayed and accepted
# - Stream reconnects after network dropout without losing messages
# - Completed turns fold in the transcript
# - Hidden reasoning is marked but not displayed
# - Message rendering matches the server's turn structure
```

## Expected Evidence

A passing run shows:

- **Test output:** All iOS tests pass on the simulator
- **Simulator logs:** Connection logs show successful pairing and reconnection
- **Transcript folds:** Completed turns display as collapsed rows
- **Activity log:** Hidden reasoning entries appear with the Hidden marker

## Key Behaviors Verified

- **QR pairing:** The companion generates and validates QR codes server-side
- **Manual codes:** Fallback pairing codes are numeric and single-use
- **Stream resume:** After Ctrl-C or network delay, the client reconnects and receives pending messages
- **Transcript folds:** Turns marked complete fold automatically
- **Hidden activity:** Reasoning marked hidden does not display in the main transcript

## Cleanup

The simulator session closes automatically.  Temporary data is removed.

## Transcript Bottom-Follow

The chat thread follows new text only while the reader sits on the newest message.  Once they scroll toward older messages it holds still, shows a Jump to Latest pill with a count of new bot messages, and a streamed reply settles without moving the rows around it.

### Unit Tests

The policy lives in `ios/Sources/CompanionCore/BottomFollow.swift` and the row rules in `ActivityRuns.swift`, so it runs without a simulator:

```sh
cd ios && swift test --filter 'BottomFollowTests|ActivityRunsTests'
```

They cover a slow drag adding up across frames, the spring back off the bottom edge, a status-bar tap that reports no scroll phase, the app's own stale scroll to the bottom, the iOS 17 drag and coast rules, the streaming throttle and its hold during Jump to Latest, the unseen count, and the live row's run tail and stretch stamp matching the settled row's.

### Simulator Check

```sh
IOS_LOCK=/path/to/shared.lock scripts/ios-scroll-demo.sh --wait-for-scroll 45
```

The script builds the DEBUG app, launches `-store-preview -open-first -scroll-demo -scroll-demo-manual`, and plays streamed turns with `notifyutil -p app.botfleet.scroll-demo.turn`.  Screenshots and the `transcript-scroll` log land in the printed folder.

1. Pinned: a turn plays while the reader sits on the newest message.  It fails if the log shows `follow: stopped following`.
2. Scrolled: during the wait, scroll the transcript up with a swipe or a tap on the status bar (the iOS Simulator tool's `touch_path` or `tap` works).  A turn then plays.  It fails if the log shows the transcript returning to the bottom, or the reader's offset changing.

Gestures worth trying by hand, with the log line each should produce:

| Gesture | Expected log |
|---|---|
| Drag or fling toward older | `follow: stopped following`, then no `repinning` |
| Status-bar tap while following | `follow: stopped following` with `driver=momentum`, and the reader stays at the top |
| Pull past the bottom and let go | samples with `driver=system` during the spring back, still `following=true` |
| Tap Jump to Latest | `phase idle -> animating`, then `animating -> idle` on the bottom with `following=true` |

Evidence from the iOS 27 simulator on an iPhone 17 Pro:

- `docs/screenshots/ios-scroll-pinned-after-turn.png`: a turn followed to its last line.
- `docs/screenshots/ios-scroll-scrolled-after-turn.png`: the reader held at the top through a turn, the pill counting 2.
- `docs/screenshots/ios-scroll-status-bar-tap.png`: a status-bar tap left at the top instead of being pulled back.
- `docs/screenshots/ios-scroll-fling-up.png`: a fling toward older, held, with the pill.

### Not Yet Verified

- **iOS 17 path.**  The deployment floor is now iOS 27, so release builds never take the drag-and-probe path.  It survives only behind the DEBUG `-legacy-follow` flag and in the unit tests, and it has never run on an iOS 17 runtime or device.  From iOS 18 on, that flag's simultaneous drag gesture stops the scroll view itself, so only the opening position and the repin can be checked with it.  Deleting the path is a follow-up.
- **VoiceOver.**  A VoiceOver scroll should look like a status-bar tap (only the offset moves), but it has not been driven.
- **iPad regular width, Reduce Motion, and a room's live speaker row** have not been captured.

The simulator's injected touches can arrive late or not at all on a loaded Mac.  Check the log for the gesture's phase lines before reading a missing event as a failure.
