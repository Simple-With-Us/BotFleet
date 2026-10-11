# Result: `beautiful-ui-swift` on the simulator (open follow-up 1)

**Date:** Sun, Oct 11, 2026 · **Seat:** MM · **Board:** `4904f628`
**Answers:** open follow-up 1 in [2026-10-11-ios-chat-library-options.md](2026-10-11-ios-chat-library-options.md)

Follow-up 1 asked for `beautiful-ui-swift` built at `dfd6da90` for the iOS simulator and compared
side by side with our `ApprovalCard` and `AgentThoughtChamberView`, in light and dark, at the
largest Dynamic Type size, and under VoiceOver.

## What was done

- Cloned at `dfd6da9` (2026-08-12), matching the pin in the survey.
- **Built for the iOS simulator: BUILD SUCCEEDED.**  This closes the survey's residual uncertainty
  that it "was compiled for macOS; the iOS/simulator build is unverified".
- Built a throwaway comparison app (`fleet.probe.CompareSimApp`) against the real library and
  installed it on an iPhone 18 Pro / iOS 27.0 simulator.  Screenshots are real simulator output.
- Traced the visual result back to source to explain it.

## The finding: the library has no appearance adaptation

`BeautifulTheme` (`Sources/BeautifulUI/Theme/BeautifulTheme.swift`) is a plain struct of fixed
`Color` values.  There is no `@Environment(\.colorScheme)` anywhere in the package, and no
`preferredColorScheme`.  The **default initializer is hard-coded dark**:

```swift
surface: Color = Color(red: 0.13, green: 0.13, blue: 0.15),   // near-black
canvas:  Color = Color(red: 0.09, green: 0.09, blue: 0.10),
```

`referenceLight` exists, but it is a *separate static* the host must inject — nothing switches to it
when the system is light.

The consequence on screen: with the simulator in **light** mode, `ApprovalCard` renders a near-black
surface with near-black body text.  The prompt "Allow the bot to run `pnpm deploy` on production?",
the two options, and the "Custom answer" placeholder are all effectively unreadable, and the Approve
button is dark-on-dark.  That is a straight failure of acceptance criterion 6 (contrast) and of
criterion 3's spirit (Dynamic Type is meaningless when the text cannot be read at any size).

`ThinkingTraceView` renders legibly in the same build — it inherits system text colour and does not
depend on `BeautifulSurface` the same way — so the failure is specific to the themed surfaces, not
to the library as a whole.

## What this changes about the recommendation

Nothing about the build-native destination, but the *reason* sharpens, and it is now measured rather
than argued:

- **It is not just a licensing and adoption question.**  Even setting aside MIT and the 2-star
  problem, the library does not do what BotFleet does on day one.  BotFleet's iOS app follows the
  system appearance, and the Mac app has `System Auto` (OS dark → Midnight, OS light → Studio)
  alongside `User Auto`.  Adopting `BeautifulSurface` unchanged would regress that on iOS, and
  fixing it means forking a theme struct in a package we do not control.
- **This is exactly the class of defect a screenshot finds and a source read does not.**  The
  survey read `ApprovalCard`'s implementation and judged it "ours richer, theirs one small win".
  It was correct about the *interaction* (select-then-approve vs our one-tap) and wrong about the
  *appearance*, because nothing in the source announces a fixed dark default — you have to notice
  that no colour-scheme query exists anywhere in the package.

## What is still unverified

- **The dark-mode screenshot did not land.**  The simulator install of the second build hung
  repeatedly and was not retried to exhaustion.  The light-mode screenshot is the decisive one and
  it is real simulator output; the dark capture is missing, not disproved.
- **AX5 was not captured.**  The app was not driven to the largest Dynamic Type size.
- **VoiceOver was not driven.**  No accessibility pass was performed on either side.

Those three are the remaining part of follow-up 1.  None of them can change the finding above —
a component that is unreadable in the default appearance is not rescued by rendering correctly at
AX5 in the other one — but the AX5 and VoiceOver checks are what would tell us whether the
*thinking trace* half is worth borrowing the shapes from.

## Recommendation, unchanged in destination

Build native, vendor the shapes.  The shape worth taking is `ThinkingStep`'s structure — a typed
`kind` (planning / reasoning / search / coding) with a per-step icon, a title, a detail line, and an
optional `Duration`.  Ours splits a reasoning string on newlines and has no per-step kind or
duration.  That is a genuine improvement, and it is a data-model change rather than a dependency.

`ApprovalCard` is not worth borrowing: it is a two-tap flow where ours is one-tap, and its themed
surface does not adapt to appearance.

## Reproducing

```bash
git clone --depth 1 https://github.com/unlocalhosted/beautiful-ui-swift.git
cd beautiful-ui
xcodebuild -scheme BeautifulUI -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' build      # BUILD SUCCEEDED
```

The comparison app is throwaway and lives outside the repo (`~/.cache/fleet-probe/CompareSimApp`);
nothing from the library is vendored into BotFleet, per the owner's ruling to read and never copy.

## Sources

- `unlocalhosted/beautiful-ui-swift` @ `dfd6da90` — `Package.swift`, `Theme/BeautifulTheme.swift`,
  `Components/ApprovalCard.swift`, `Components/ThinkingTraceView.swift`, `Models/ApprovalRequest.swift`,
  `Models/ThinkingStep.swift`
- Real simulator build and launch on iPhone 18 Pro, iOS 27.0