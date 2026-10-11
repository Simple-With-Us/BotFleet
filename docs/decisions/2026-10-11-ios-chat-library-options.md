# Addendum: iOS Chat Library Options

**Date:** Sun, Oct 11, 2026 · **Seat:** MM · **Board:** `3c30a404`
**Supersedes:** the iOS next-step in [2026-10-10-chat-ui-libraries.md](2026-10-10-chat-ui-libraries.md)
**Corrected:** Sun, Oct 11, 2026, after the design review on PR #1068 (issue comment `6110970373`).  Docs only.  The simulator comparison and the grouping spike listed under Open Follow-Ups were not done.

The main decision doc answered "should we adopt Exyte Chat for iOS?" with "borrow its patterns."
The owner's follow-up was sharper: *what other options would be an actual upgrade and well suited?*

This records a survey against explicit acceptance criteria rather than by impression.

**Expected behavior after this correction:** the answer to "should BotFleet adopt a third-party iOS chat UI library?" remains *build native, do not depend on one*.  Any candidate must clear the nine criteria below, no surveyed library does, and adopting a sub-3★ single-author package to obtain components BotFleet already owns (`ApprovalCard`, `AgentThoughtChamberView`) is a bad trade.  Action: read `beautiful-ui-swift` and the Stream Chat `StreamChatAI` docs as a second opinion, never copy their source; spike message grouping natively; do not depend on either.  Out of scope: the simulator visual comparison and the grouping spike, both deferred to Open Follow-Ups.

## Acceptance criteria

A candidate must be:

1. **SwiftUI-native container** — the message list must be a real SwiftUI stack
   (`ScrollView`/`LazyVStack`) so it can host Liquid Glass materials.  A `UITableView`-backed list
   was treated as a disqualification.  **To verify:** that glass clause is untested.  A UIKit cell
   can host glass, so "only SwiftUI can host Liquid Glass" is an assumption, not a result.  Keep
   the SwiftUI preference, because our cards are SwiftUI and a wrapped table is a different
   architecture, but do not disqualify a candidate on glass until someone hosts `Glass.swift`
   inside a cell and records what happens.
2. **Backend-agnostic** — must run against BotFleet's own local harness.  Routing traffic through a
   hosted service disqualifies it.
3. **Open-source** — MIT / Apache-2.0 / BSD.  Proprietary or source-available disqualifies.
4. **Agent-oriented** — streaming turns, reasoning display, tool-call cards, approval prompts.
5. **Custom message types** — native rendering of arbitrary content (tool cards, SQL tables, PR diffs).
6. **Maintained** — activity within roughly the last year.  That bar is thin.  Two days of commits
   clear it, and `beautiful-ui-swift` does exactly that (tip `dfd6da90`, committer date
   2026-08-12, nothing since).  "Maintained" here is a minimum, not evidence that anyone else
   depends on the project.
7. **CI-safe** — builds on the toolchain CI actually uses.  The old wording ("Swift tools 6.0+ /
   Xcode 16+") was a candidate floor, and it does not describe CI.  Checked in this correction
   on Sun, Oct 11, 2026:

   - `.github/workflows/ci.yml` job `ios` ("Swift tests + iOS build") and
     `.github/workflows/ios-ship.yml` use `runs-on: xcode-27` with
     `DEVELOPER_DIR: /Applications/Xcode_27.0.app/Contents/Developer`.
   - `scripts/ios-assert-xcode.sh 27.0` fails the job unless `xcodebuild -version` reports
     exactly 27.0 and the selected directory is not a beta.
   - GitHub's `xcode-27-arm64` image readme (actions/runner-images, image version
     `20261006.0244.1`, readme commit `f48e4841ef50c318129122988d426608c79a7122`, updated 2026-10-09) lists Xcode 27.0 build
     `27A266a` as the default, at `/Applications/Xcode_27.app`, with symlinks
     `/Applications/Xcode_27.0.app` and `/Applications/Xcode.app`.  The same image also carries
     Xcode 27.1 and an Xcode 27.2 beta.  The workflow pins 27.0, so those are not what CI builds
     with.  The readme does not print a Swift version.
   - Apple's Xcode 27 release notes, Overview: "Xcode 27 includes Swift 6.4 and SDKs for iOS 27,
     iPadOS 27, tvOS 27, watchOS 27, macOS 27, and visionOS 27."
     <https://developer.apple.com/documentation/xcode-release-notes/xcode-27-release-notes>
   - This correction did not run `swift --version` on a runner.  Swift 6.4 is that release-note
     sentence, plus the comment in `ios/Package.swift` that tools 6.4 is the first
     PackageDescription with `.iOS(.v27)`.
   - The iOS deployment floor is 27.0 (`ios/project.yml` `deploymentTarget.iOS` and
     `IPHONEOS_DEPLOYMENT_TARGET`, `ios/Package.swift` `.iOS(.v27)`).
   - The language mode is Swift 5, not Swift 6: `ios/project.yml` sets `SWIFT_VERSION: '5.9'`
     and `ios/Package.swift` sets `swiftLanguageModes: [.v5]`.

   A candidate that needs a tools version newer than 6.4, or an Xcode older than 27.0, does not
   clear this criterion.  The 2026-09-28 Kingfisher lesson (a break on Xcode 16.4) describes a
   runner CI no longer uses.
8. **Accessible** — all of the following, not a general "supports accessibility" claim:
   - VoiceOver order and grouping per bubble.
   - Streamed text announced without a flood of updates.
   - Dynamic Type up to AX5.
   - Reduce Motion, including a `letterInterval` typewriter where the library has one.
   - Reduce Transparency, and contrast over Liquid Glass.
9. **Streaming performance** — all of the following, measured rather than inferred from "it has
   a streaming view":
   - Re-render cost at token rate.
   - Staying pinned to the bottom while text streams in.
   - `LazyVStack` behaviour in a thread of 1,000 or more messages.
   - Memory use.

## Result: the first survey was wrong — see the correction below

My first pass concluded "no candidate passes all seven; the landscape splits cleanly and the halves
never meet."  That was **falsified** by an independent pass asked to break it.  Two libraries exist
that the first survey missed.  The correction is in the next section; the candidate-by-candidate
findings from the first pass are kept below because they are still accurate.

### First-pass candidates (all three genuinely ruled out)

**Agent-oriented libraries are proprietary and backend-locked.  Open SwiftUI libraries are generic
messengers.**  As a description of *those three*, that holds.  It is not a description of the whole
field.

### Stream Chat `StreamChatAI` — near-perfect match, ruled out on licence

This is the notable find.  The component list maps almost 1:1 onto what BotFleet hand-built:

| Stream component | BotFleet equivalent |
|---|---|
| `StreamingReasoningView` | reasoning tail, folds into "Thought for 12s" |
| `AIMessagePartsView` | `AgentThoughtChamberView` — "rounds of reasoning and tool calls, in order" |
| `AIToolApprovalView` | `ApprovalCard` |
| `AITypingIndicatorView` | `TypingIndicatorView` |
| `StreamingMessageView` | streaming bubble |

And it is genuinely backend-free, which was the deciding technical question.  Verified in the source:
zero references to `StreamChat`, `ChatClient`, `ChatChannelController`, or any controller.  Package
dependencies are `stream-core-swift`, Splash, and MarkdownUI; `StreamCoreUI` is imported in three files
for design tokens only.  Views take plain value types:

```swift
public init(content: String, isGenerating: Bool, letterInterval: TimeInterval = 0.005)  // StreamingMessageView
init(parts: [AIMessagePart], approver: AIToolApprover? = nil, font: Font? = nil)          // AIMessagePartsView
```

`AIToolApprover` is a caller-supplied closure whose own documentation says the answer reaches *your
backend*.  The README states "any custom backend," and the tests construct views with no client setup.
There is no install/configure/bootstrap call anywhere in the package.

**The blocker is the licence, and only the licence.**  It is proprietary, not open source:

- Preamble: you must be a current Stream.io customer **and** not a competitor.
- §2 scopes the grant to building in-app messaging *via Stream's API*.
- §3(e) forbids use that competes with Stream.io.
- §6 forbids any complete **or partial** functional or commercial alternative to Stream's products.
- §10 lets either party terminate on notice, and auto-terminates if the customer becomes a competitor.

BotFleet is messaging over its own backend.  That sits outside the grant quoted below, and it is
contestable under the compete clauses.  **Not adoptable, and not a source port.**  Screenshots and
the public docs are the only reference for how it looks.  Its source is not copied.

**Licence text, pinned.**  `GetStream/stream-chat-swift-ai` `LICENSE` blob
`49088d477f5fe01d0086109d0465168dc84e1d43`.  That blob was introduced in
`97c030d4faaeff5a2b13fd3fd57e327f645f787f` ("Added License", 2024-12-02) and is unchanged at
`f1f4fd7874625ba134a33b991ad0891b5378039b` ("Clean up and improvements", committer
2026-10-08T08:02:52Z).  That second commit is the tip of `main` on Oct 8, 2026, and it was still
the tip on Oct 11 when this correction resolved it.  The survey wrote "main @ Oct 8" and did not
record a SHA.  The previous commit on `main` is `d862fe39` (2026-10-05).  A clone taken on Oct 8
before 08:02 UTC would be that parent, not `f1f4fd7`.  This correction did not retrieve the
survey's clone, so `f1f4fd7` is the commit whose `LICENSE` was quoted, not a proof of which tree
the survey had checked out.  The blob identity above is only for `LICENSE`.

The file uses curly quotes.  They are kept below.  §3 numbers two different restrictions as
"(e)".  Both are quoted.

Preamble, the conditions the survey paraphrased:

> CONDITIONS: (1) YOU ARE A CURRENT CUSTOMER OF STREAM.IO; (2) YOU ARE NOT A COMPETITOR OF STREAM.IO; AND (3) THAT YOU ACCEPT ALL THE TERMS IN THIS AGREEMENT.

§2, the grant.  Letters (b) and (c) are the "via Stream's API" limit.  Letters (a) and (d)–(f) are the rest of the same grant (install, internal use, distribute the executable, backups), still subject to the agreement:

> 2. LICENSE GRANT. Subject to the terms and conditions of this Agreement, in consideration for the representations, warranties, and covenants made by Customer in this Agreement, Stream.io grants to Customer, during the term of this Agreement, a personal, non-exclusive, non-transferable, non-sublicensable license to:
>
> a. install and use Software Source Code on password protected computers at a Site, restricted to Authorized Users;
>
> b. create derivative works, improvements (whether or not patentable), extensions and other modifications to the Software Source Code (“Modifications”) to build unique scalable newsfeeds, activity streams, and in-app messaging via Stream’s application program interface (“API”);
>
> c. compile the Software Source Code to create Executable Object Code versions of the Software Source Code and Modifications to build such newsfeeds, activity streams, and in-app messaging via the API;
>
> d. install, execute and use such Executable Object Code versions solely for Customer’s internal business use (including development of websites through which data generated by Stream services will be streamed (“Apps”));
>
> e. use and distribute such Executable Object Code as part of Customer’s Apps; and
>
> f. make electronic copies of the Software and Modifications as required for backup or archival purposes.

§3, including both clauses labeled (e):

> 3. RESTRICTIONS. Customer is responsible for all activities that occur in connection with the Software. Customer will not, and will not attempt to: (a) sublicense or transfer the Software or any Source Code related to the Software or any of Customer’s rights under this Agreement, except as otherwise provided in this Agreement, (b) use the Software Source Code for the benefit of a third party or to operate a service; (c) allow any third party to access or use the Software Source Code; (d) sublicense or distribute the Software Source Code or any Modifications in Source Code or other derivative works based on any part of the Software Source Code; (e) use the Software in any manner that competes with Stream.io or its business; or (e) otherwise use the Software in any manner that exceeds the scope of use permitted in this Agreement. Customer shall use the Software in compliance with any accompanying documentation any laws applicable to Customer.

§6:

> 6. COMPETITIVE PRODUCT DEVELOPMENT. Customer shall not use the Software in any way to engage in the development of products or services which could be reasonably construed to provide a complete or partial functional or commercial alternative to Stream.io’s products or services (a “Competitive Product”). Customer shall ensure that there is no direct or indirect use of, or sharing of, Software source code, or other information based upon or derived from the Software to develop such products or services. Without derogating from the generality of the foregoing, development of Competitive Products shall include having direct or indirect access to, supervising, consulting or assisting in the development of, or producing any specifications, documentation, object code or source code for, all or part of a Competitive Product.

§10:

> 10. TERM AND TERMINATION. The term of this Agreement begins when the Software is downloaded or accessed and shall continue until terminated. Either party may terminate this Agreement upon written notice. This Agreement shall automatically terminate if Customer is or becomes a competitor of Stream.io or makes or sells any Competitive Products. Upon termination of this Agreement for any reason, (a) all rights granted to Customer in this Agreement immediately cease to exist, (b) Customer must promptly discontinue all use of the Software and return to Stream.io or destroy all copies of the Software in Customer’s possession or control. Any continued use of the Software by Customer or attempt by Customer to exercise any rights under this Agreement after this Agreement has terminated shall be considered copyright infringement and subject Customer to applicable remedies for copyright infringement. Sections 2, 5, 6, 8 and 9 shall survive expiration or termination of this Agreement for any reason.

**Maker-tier terms, read Sun, Oct 11, 2026.**  This correction did not retrieve an Oct 8 archive, so it does not prove the pages said this on the day of the survey.  Two Stream pages disagreed with each other on the day they were read:

- <https://getstream.io/maker-account/> : "If your company has five or less team members, less than $10k in monthly revenue and has taken less than $100k in funding, Stream is free/gratis/complimentary."  The requirements list is five or less team members, less than $100k in funding, and less than $10k/mo revenue.  The Chat notice on that page: a modified Chat Start Plan limited to 2,000 monthly active users and 100 concurrent connections.
- <https://getstream.io/chat/pricing/>, the "Free for Maker" blurb the same day: "If your project/company has less than 5 team members and less than $10k in monthly revenue, Stream is free/gratis/complimentary."  That blurb does not mention funding, and "less than 5" is not the same as "five or less."

The survey's "<5 team members, <$10k monthly revenue" matches the shape of the pricing blurb and omits the funding cap on the Maker page.  Pricing stays moot for adoption either way: the licence requires current customer status and the non-compete quoted above, and a UI-only build does not satisfy that grant.

Requirements, read from `Package.swift` and `README.md` at `f1f4fd7`: `swift-tools-version:6.0`,
iOS 15+, and the README's "Xcode 16 or later".  That Xcode 16 floor is the package's own floor.
It is not our CI, which is Xcode 27.0 (criterion 7).  The only iOS 26 gate called out in the
README is `AIOnDeviceModel`, behind `canImport(FoundationModels)`.

### SwiftyChat — best structural fit, not agent-oriented

`EnesKaraosman/SwiftyChat`, Apache-2.0, 354 stars, last commit 2026-10-07, 60 files / 4,673 lines.

It clears the objection that disqualified Exyte:

- **Pure SwiftUI.**  `ChatView.swift` is `ScrollView(.vertical)` + `LazyVStack`.  The only UIKit in the
  package is a `VideoPlayerRepresentable` for video playback.  Whether that SwiftUI list is
  required to host Liquid Glass is unverified (criterion 1).
- **Generic over a protocol**, not a concrete struct — our model conforms directly:

```swift
public protocol ChatMessage: Identifiable {
    associatedtype User: ChatUser
    var user: User { get }
    var messageKind: ChatMessageKind { get }   // includes case custom(Any)
    var isSender: Bool { get }
    var date: Date { get }
    var replyPreview: ChatMessageQuote? { get }
    var replyToMessageID: ID? { get }
    var deliveryStatus: MessageDeliveryStatus? { get }
}
```

- iOS 17+ / macOS 14+ from one codebase — relevant, since BotFleet also has a macOS companion.
- Apache-2.0, so no licence problem.

It fails on criterion 4.  Message kinds are `text`, `image`, `imageText`, `location`, `contact`,
`quickReply`, `carousel`, `video`, `custom` — **zero occurrences of reasoning, tool call, or thought.**
It is generic messaging.  It also has **no message grouping**, so it does not even offer the one
concrete gap we identified.

### Exyte Chat — unchanged, still the weakest fit

`UIList` is a `UIViewRepresentable` (criterion 1), `Message` is a concrete struct requiring a
translation layer, and it pulls Kingfisher `from: 8.5.0`.  Kingfisher ≥ 8.13 needs Swift 6.2.
The 2026-09-28 lesson records a break when CI was Xcode 16.4.  Current CI is Xcode 27.0 with
Swift 6.4 (criterion 7), so that lesson does not describe today's runner.  A pin is still the
right guard.

## Correction: the falsification pass found two libraries the first survey missed

A second pass was commissioned specifically to **break** the conclusion above, on the grounds that a
conclusion reached by one search is worth very little.  It succeeded.  Two candidates exist:

### `unlocalhosted/beautiful-ui-swift` — passes all seven criteria

The seven are the original list, as written before criteria 8 and 9.  Those two are scored below
and are not a pass.  Criterion 7's toolchain wording is corrected above; the build evidence here
is the survey's macOS `swift build`, not an iOS CI log.

MIT licence (full text, GitHub reports `licenseInfo.key = mit`).  Verified:

- **Pure SwiftUI container** — `ChatPanel.swift` is `ScrollView { LazyVStack { ForEach } }`, no
  `UIViewRepresentable` anywhere.  Whether a SwiftUI stack is required to host Liquid Glass is
  unverified (criterion 1).
- **Backend-agnostic** — `Package.swift` declares **zero dependencies** and there is no networking
  code.  Pure UI.
- **Agent-oriented** — this is what the first survey missed entirely.  It ships `ApprovalCard` +
  `ApprovalOptionList`, `ToolCallGroup` + `ToolCallRow`, `ThinkingTraceView` + `ThinkingStepRow`,
  and `StreamingResponseView`.  `ApprovalCard` was read and is a real implementation (bound
  selection, custom response, `ApprovalDecision` callback), not a stub.
- **Custom content** — unrestricted composition; ships `RecordTable`, `ChangeTable`, `CodeBlock`.  No
  closed enum.
- **Maintained** — last push 2026-08-12.
- **CI-safe on the compiler the survey used** — the survey reports `swift build` exits 0 in 136s
  on Swift 6.4 / Xcode 27.  This correction did not re-run that build.  It was a macOS package
  build, not the CI iOS job.  `Package.swift` at `dfd6da90` says `swift-tools-version: 6.3` and
  `.iOS(.v26)`.  Criterion 7, as restated above, is Xcode 27.0 with Swift 6.4 tools, the Swift 5
  language mode, and an iOS 27 deployment floor.  The macOS `swift build` is evidence about that
  compiler.  An iOS build of this package on the CI job is **unknown**.  The old "Xcode 16"
  wording of criterion 7 is not what CI runs.

**The caveat that limits adoption** is adoption, not fitness: 10 commits, 0 forks, 2 stars, activity
confined to 2026-08-11/12.  Depending on it as a package means depending on a single author with no
track record.  *Reading it* costs nothing and is worth doing.

### `NerdSnipe-Inc/AIChatKit` — MIT, real SwiftUI, but fails two criteria

- **Passes** container (real `ScrollView` / `LazyVStack`), licence (MIT), and is agent-oriented
  enough to ship `ToolCallView` and `ThinkingTileView`.  `ChatProvider` is a public protocol, so a
  harness provider is implementable.  `swift-tools-version:5.10`, iOS 17+.
- **Fails approvals** — grep for `approval|approve|permission|human-in-the-loop` across `Sources/`
  returns **zero hits**.
- **Fails custom content** — `ChatMessage.ContentBlock` is a *closed* enum (text / image / toolCall /
  toolResult / thinking / redactedThinking).  That is the same defect that disqualified Exyte: our
  tool cards could not be expressed.

### Also checked and rejected

- `euforicio/streamdown-swift` — **FSL-1.1, source-available**, not open source; requires iOS/macOS 26.
- `unionst/swift-chat` — the LICENSE says "free to use and **closed source**"; `binaryTarget`
  xcframework, no-redistribute and no-compete clauses.
- `BBC6BAE9/a2ui-swift` — MIT and agent-oriented (A2UI renderer), but no chat list / tool / approval
  model; it generates forms and UI.
- `FluidGroup/swiftui-messaging-ui` — Apache-2.0, pure SwiftUI, but scroll primitives only, zero agent
  concepts.
- `CherryHQ/hanlin-ai` — agent-oriented and MIT, but a whole application, not a reusable library.
- `sozercan/ayna` — `products: [.executable]`; an app.

## Revised recommendation

**Still build native — but for a different reason than the first pass gave.**

The first pass said borrowing was unavailable.  That is wrong; it is available and one library
(`beautiful-ui-swift`) even clears every criterion.  The real reason to stay native is that
**BotFleet already owns these components.**  We have `ApprovalCard` and `AgentThoughtChamberView`
on iOS, exactly what that library ships.  Taking a dependency on a 2-star package to obtain things we
already have, in order to gain message grouping (roughly 40 lines), is a bad trade.

So the action changes, not the destination:

- **Read the shapes.  Do not copy them into the tree.**  `beautiful-ui-swift`'s `ApprovalCard` and
  `ThinkingTraceView` are worth reading as a second opinion on components we already wrote.
  That is the stance.  "Vendor the shapes" is withdrawn.  Reading does not bring a dependency.
  If a later change copies MIT source, or a substantial portion of it, the copyright notice and
  the permission notice go into `NOTICE` with the copy.  The MIT text at `dfd6da90` requires
  that: "The above copyright notice and this permission notice shall be included in all copies
  or substantial portions of the Software."  The copyright line there is "Copyright (c) 2026
  BeautifulUI contributors."
- **Stream Chat `StreamChatAI` is a look reference only.**  Screenshots and the public docs may
  inform our own components.  Its source is never ported.  The licence quotes above are why.
- **Still build grouping natively.**  The "~40 lines" figure is still an estimate.  Backing it
  up, including VoiceOver labels, is an open follow-up, not a result.
- **Do not depend on either library.**  Single-author, sub-3★, no adoption history.  A production
  dependency on that is a supply-chain risk.  A sole copyright holder can relicense future
  versions only.  Released MIT code stays MIT, so relicensing is not a risk of pinning
  `dfd6da90` and not a residual uncertainty.

### Honest accounting of the error

The first survey concluded "no candidate passes" from three candidates.  It searched for messengers
and an agent SDK, and did not search component libraries, GitHub topic pages, or Swift Package Index
systematically.  It also did not notice that "open + agent-oriented" was an unfalsifiable-sounding
claim until something was found.  The lesson is procedural: **for a "nothing exists" claim, the
search has to be as adversarial as the claim**, and a second pass should be commissioned *before*
the conclusion is recorded, not after.

### Residual uncertainty

- **No visual side-by-side.**  Everything here is source and licences.  Whether anyone's bubbles
  actually *look* better on a simulator is unverified.  That comparison is an open follow-up.
- `beautiful-ui-swift` was compiled for **macOS**; the iOS/simulator build is unverified.
  This correction did not identify the person behind the `unlocalhosted` GitHub account.
- "No *major* project provides an open SwiftUI chat UI with streaming, tool cards, and approval
  prompts" still appears to hold.  Both counter-examples are single-author and sub-3★.  That
  weaker claim is the one to defend.

## Criteria 8 And 9, Scored From Source

Scored Sun, Oct 11, 2026, by reading the pinned trees.  Nothing here was run in a simulator, under
VoiceOver, at AX5, or under Instruments.  Where the source does not show the behavior, the score
is **unknown**.  "Not present" means the library has no such path to score.

`beautiful-ui-swift` still passes the original seven criteria as that survey wrote them, with the
criterion 7 caveat above (macOS `swift build` only).  It does not pass criteria 8 and 9 on this
evidence.

### Stream Chat `StreamChatAI` at `f1f4fd7`

- **VoiceOver grouping.**  Partial.  `AIToolApprovalCard` uses `.accessibilityElement(children: .contain)`.
  `AIToolCallView` uses `.combine`.  `StreamingReasoningView` uses `.ignore` plus one label, a
  hint, and the button trait.  There is no message list, so order and grouping per bubble in a
  thread were not run.  Transcript grouping is **unknown**.
- **Streamed announcements.**  **Unknown.**  `StreamingMessageView` appends one character to
  `displayedText` on a `letterInterval` timer (default 0.005s) and renders `Markdown(displayedText)`.
  No `AccessibilityNotification` and no coalescing.  Whether VoiceOver re-announces each character
  was not measured.  The update rate is a flood risk, not a measured flood.
- **Dynamic Type to AX5.**  **Unknown.**  No `dynamicTypeSize` use under `Sources/`.  Not run at AX5.
- **Reduce Motion.**  Partial, and the typewriter fails the source check.  `StreamingReasoningView`,
  `ThinkingIcon`, and `Shimmer` read `accessibilityReduceMotion`.  `StreamingMessageView` does not.
  The typewriter timer always runs while generating.
- **Reduce Transparency and contrast over Liquid Glass.**  **Unknown.**  No
  `accessibilityReduceTransparency` or `accessibilityContrast`.  The package does not draw Liquid
  Glass.  One comment mentions `.ultraThinMaterial`.  Nothing here was placed on our glass.
- **Re-render cost at token rate.**  **Unknown** as a measurement.  The source rebuilds `Markdown`
  as each character is appended.  That is a per-character body update, not a profile.
- **Bottom pin while streaming.**  Partial, and only for reasoning.  `ReasoningPanel` calls
  `proxy.scrollTo` toward the bottom while live.  `StreamingMessageView` has no scroll pin.  A
  transcript pin is **unknown** because there is no transcript.
- **`LazyVStack` at 1,000 or more messages.**  **Unknown.**  `LazyVStack` appears in the options
  list and the reasoning panel, not in a message history.
- **Memory.**  **Unknown.**

### SwiftyChat at `08661b87`

- **VoiceOver grouping.**  Partial.  `ChatView` labels the scroll-to-latest control.  A reply quote
  has an explicit "Go to original message" label.  Text bubbles were not run in VoiceOver, so
  order and grouping per bubble are **unknown** at runtime.
- **Streamed announcements.**  Not present.  There is no streamed-text path (criterion 4).
- **Dynamic Type to AX5.**  Partial, and AX5 itself is **unknown**.  Commit `08661b87` is "fix:
  improve accessibility at large text sizes".  Carousel, contact, link preview, and quick reply
  read `dynamicTypeSize.isAccessibilitySize`.  The default `CommonTextStyle.font` is `Font.body`,
  which scales.  Some styles use `Font.custom` at a fixed size, which does not.  Not run at AX5.
- **Reduce Motion.**  Not implemented in source.  `Sources/` never reads `accessibilityReduceMotion`.
  `ChatView.scrollToLatest` and the video and input views call `withAnimation`.  The on-screen
  result with Reduce Motion on is **unknown**.
- **Reduce Transparency and contrast over Liquid Glass.**  **Unknown.**  No Liquid Glass and no
  `accessibilityReduceTransparency`.  The views were not placed on our glass.
- **Re-render cost at token rate.**  Not present.  There is no token stream.
- **Bottom pin while streaming.**  The list can follow the latest message (`followsLatest`,
  `scrollToLatest`).  Behavior while a bubble's text grows is **unknown**, because text does not
  stream.
- **`LazyVStack` at 1,000 or more messages.**  `ChatView` lays messages out in a `LazyVStack`.
  Behavior at 1,000 messages is **unknown**.  Not measured.
- **Memory.**  **Unknown.**

### `beautiful-ui-swift` at `dfd6da90`

- **VoiceOver grouping.**  Partial.  `ChatMessageBubble` uses `.accessibilityElement(children: .combine)`.
  `ThinkingStepRow` and `ToolCallRow` combine as well.  Order inside a combined bubble, and how a
  tool group is announced, were not run in VoiceOver.  Runtime order is **unknown**.
- **Streamed announcements.**  **Unknown.**  `StreamingResponseView` is a `Text` of the string the
  caller passes.  No announcement API.  Whether a caller that updates `text` per token floods
  VoiceOver was not run.
- **Dynamic Type to AX5.**  The library does not opt in.  Bubbles, the streaming view, thinking
  rows, tool rows, and approval cards use fixed `.font(.system(size:))` values (bubble body 12.5,
  streaming text 13).  Fixed sizes do not track Dynamic Type.  The visual result at AX5 is
  **unknown** because it was not run.  The source does not satisfy the criterion.
- **Reduce Motion.**  Partial.  Button styles, shimmer, and the loading view read
  `accessibilityReduceMotion`.  There is no `letterInterval` typewriter in this package.
  `ThinkingTraceView` is a `DisclosureGroup` and does not read the flag.  A full pass over every
  animation was not done.
- **Reduce Transparency and contrast over Liquid Glass.**  **Unknown.**  `Sources/BeautifulUI` has
  no `glassEffect`, no material, and no `accessibilityReduceTransparency` or
  `accessibilityContrast`.  The package does not draw Liquid Glass, and these views were not
  placed on ours.
- **Re-render cost at token rate.**  **Unknown.**  `StreamingResponseView` replaces `Text(text)`
  when the caller passes a new string.  Cost at token rate was not measured.
- **Bottom pin while streaming.**  Not present in `ChatPanel`.  That view is a `ScrollView` of a
  `LazyVStack` with `minHeight: 180` and `idealHeight: 280`, and it does not pin to the bottom.
- **`LazyVStack` at 1,000 or more messages.**  The stack exists.  Behavior at 1,000 messages is
  **unknown**.  The panel's fixed ideal height is a short preview, not a transcript.
- **Memory.**  **Unknown.**

## Open Follow-Ups

Not done in this correction.  Recorded so they are not mistaken for results.

1. Build `beautiful-ui-swift` at `dfd6da90` for the iOS simulator and compare it side by side with
   our `ApprovalCard` and `AgentThoughtChamberView`.  Light and dark, the largest Dynamic Type
   size, and VoiceOver.
2. Spike the grouping work and back up the "~40 lines" estimate, including VoiceOver labels for
   grouped runs.
3. Message grouping belongs in a shared Mac and iOS chat spec: the same sender within a time gap,
   tool runs collapsing, and timestamps at group breaks.  That spec is not written here.

## Sources

SHAs below were resolved on Sun, Oct 11, 2026.  Where the survey had already recorded a short SHA, it is expanded.  Where it had not, the pin is the default-branch tip on that date, and this correction says so when it did not re-read the tree.  The survey's clone was not recovered.

- `GetStream/stream-chat-swift-ai` @ `f1f4fd7874625ba134a33b991ad0891b5378039b` (tip of `main` on Oct 8, 2026, and still the tip on Oct 11).  `LICENSE` blob `49088d477f5fe01d0086109d0465168dc84e1d43`, same blob as the adding commit `97c030d4faaeff5a2b13fd3fd57e327f645f787f`.  This correction re-read `LICENSE`, `Package.swift`, `README.md`, and the accessibility and streaming sources named above.  An Oct 8 clone taken before 08:02 UTC would instead be parent `d862fe39b781ef80872816e734f87d6c6982b20e`.  That parent was not re-read.
- `GetStream/stream-core-swift` default branch is `develop`, not `main`.  Tip on Oct 11: `3b230fb6a5544f1108916e0526ecee8415e8916c` (2026-10-09, "Update release version to snapshot").  Last commit before Oct 9, which is the latest an Oct 8 clone could have been: `70dd8d08571e766a41c91643e4c0f5f8cb1e71db` (2026-10-07).  This correction did not re-read `Package.swift` or `LICENSE`.  GitHub reports `license.spdx_id` as `NOASSERTION` for the repo.  That is not a substitute for the file.
- `GetStream/stream-chat-swiftui` default branch is `develop`.  Tip on Oct 11: `9ed86dbaa4af8385855a777eb1a3c499bb9920ed` (2026-10-09, "Update release version to snapshot").  Tip as of end of Oct 8: `3290aa74b1678abef4779685d33cfd5388950627` (2026-10-08, "Show every level in the demo app's initial log filter").  This correction did not re-read `Package.swift`.  The survey's claim of a dependency on `stream-chat-swift` was not re-checked.
- <https://getstream.io/chat/docs/sdk/ios/guides/ai-integrations/> — component list, as cited by the survey.  This correction did not re-fetch that page.
- Maker terms, read Oct 11, 2026, with no Oct 8 archive: <https://getstream.io/maker-account/> and <https://getstream.io/chat/pricing/>.
- `EnesKaraosman/SwiftyChat` @ `08661b87d5254a2b99625fdc13cfea88f5bbbc74` (2026-10-07, "fix: improve accessibility at large text sizes").  This correction re-read `Package.swift` and the accessibility and list sources named above.
- `exyte/Chat` @ `49bf1f37606e60a44972fa72f2693b62236b7c57` (2026-10-01).  This correction did not re-read `UIList.swift` or `Message.swift`.
- `CherryHQ/hanlin-ai` @ `f3782a7b0e2542bda6a66066b820141416c2c8a7` (2026-01-24, tip of `main` on Oct 11).  This correction did not re-read the README.
- `unlocalhosted/beautiful-ui-swift` @ `dfd6da90c16b0f2b9e421383f89ffc2fbab936f2` (2026-08-12, tip of `main`, unchanged since).  This correction re-read `LICENSE`, `Package.swift`, `ChatPanel.swift`, `ChatMessageBubble.swift`, `StreamingResponseView.swift`, and the accessibility sources named above.  The survey's `swift build` was not re-run.
- `NerdSnipe-Inc/AIChatKit` @ `be527c0228faf415bde9968a189fa9dbcd959a75` (2026-10-05, tip of `main` on Oct 11).  This correction did not re-read `LICENSE`, `Package.swift`, or the message types.
- `euforicio/streamdown-swift` @ `22981ab9a35c86bd69e275e48f26488c38bc9cdf` (2026-07-29, tip of `main` on Oct 11).  Not re-read.
- `unionst/swift-chat` @ `4bbe30e53e3c8e4e34a618c3f8a0df1ea7122463` (2026-10-10, tip of `main` on Oct 11).  Not re-read.  The survey's licence paraphrase was not re-checked against this commit.
- `BBC6BAE9/a2ui-swift` @ `16476ba2cb3fcb4c4bcb141dfa4c2804adbdedb0` (2026-09-24, tip of `main` on Oct 11).  Not re-read.
- `FluidGroup/swiftui-messaging-ui` @ `1ec611adfb17c74075239565273f6902cdf77db6` (2026-06-24, tip of `main` on Oct 11).  Not re-read.
- `sozercan/ayna` @ `c9b1d713691d6e83b745a8eec8ce845b9f432633` (2026-08-15, tip of `main` on Oct 11).  `Package.swift` at that commit has an `.executable` product named `Ayna`.  The rest of the manifest was not re-read.
- Xcode 27 release notes, read Oct 11, 2026: <https://developer.apple.com/documentation/xcode-release-notes/xcode-27-release-notes>
- GitHub `xcode-27-arm64` image readme, image version `20261006.0244.1`, commit `f48e4841ef50c318129122988d426608c79a7122` (2026-10-09): <https://github.com/actions/runner-images/blob/f48e4841ef50c318129122988d426608c79a7122/images/macos/xcode-27-arm64-Readme.md>
- <https://swiftpackageindex.com/packages?q=chat> (its search API now returns HTML, not JSON — a gap that contributed to the first pass missing these).  This correction did not re-fetch that page.
