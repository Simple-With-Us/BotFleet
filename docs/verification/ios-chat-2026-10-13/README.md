# iOS chat verification — 2026-10-13

Evidence for the conversation-screen work on `opencode/ios-chat-ux-pass`
(PR #1114). Captured on a dedicated simulator (`BF Scroll iPhone 17 Pro`,
iOS 27.0), launched with fixture data so every run is the same run:

    xcrun simctl launch booted app.botfleet.ios \
      -store-preview -open-first -chat-fixture-code

`-chat-fixture-code` seeds a short thread whose last message is a code block
with a line long enough to scroll sideways, plus a failed tool call. The full
`-chat-fixture` seeds a long markdown reply, a completed tool run, a failed
one and the retry that recovered it, a run still in flight, a permission card
waiting beside one already answered, and a mid-turn live reply.

| File | What it shows |
|---|---|
| `A-code-light.png` | Default text size, light. Connection mark (Connected), code block with BASH tag and Copy button, a failed tool receipt with its red edge and badge, the approval card, and the composer with an always-present microphone. |
| `B-a11y-light.png` | `accessibility-extra-large`, light. Every text scales; the receipt falls back to its two-row shape so the status badge reads "Failed" rather than truncating to "Fa…". |
| `C-dark.png` | Default text size, dark. The same screen with semantic colours; nothing depends on a hand-picked hex. |

## What these do not prove

A screenshot cannot show that a tap works. The microphone, the Stop control
and Copy are all verified by the code paths and the tests, not by these
images:

- **Copy** copies `text`, the whole fence — never `preview.text`. A paged
  block shows page one, so copying what is on screen would hand back a
  truncated file that looks complete and is not.
- **Stop** and **mic** are covered by their wiring in `ChatView`, not by the
  images. Stop only renders while `current.busy`; the fixture that shows it
  (`-chat-fixture`) leaves the bot mid-turn for exactly that reason.
- **VoiceOver** is not verified here at all. The labels and hints are in the
  code; nothing in this directory proves they are announced correctly.

## Reproducing

    cd ios
    xcodegen generate
    xcodebuild -project BotFleet.xcodeproj -scheme BotFleet \
      -destination 'platform=iOS Simulator,name=BF Scroll iPhone 17 Pro' \
      -configuration Debug CODE_SIGNING_ALLOWED=NO build
    swift test

See `ios/App/ChatFixture.swift` for the fixture text and every launch flag.