# Addendum: iOS Chat Library Options

**Date:** Sun, Oct 11, 2026 · **Seat:** MM · **Board:** `3c30a404`
**Supersedes:** the iOS next-step in [2026-10-10-chat-ui-libraries.md](2026-10-10-chat-ui-libraries.md)

The main decision doc answered "should we adopt Exyte Chat for iOS?" with "borrow its patterns."
The owner's follow-up was sharper: *what other options would be an actual upgrade and well suited?*

This records a survey against explicit acceptance criteria rather than by impression.

## Acceptance criteria

A candidate must be:

1. **SwiftUI-native container** — the message list must be a real SwiftUI stack
   (`ScrollView`/`LazyVStack`) so it can host Liquid Glass materials.  A `UITableView`-backed list
   disqualifies it.
2. **Backend-agnostic** — must run against BotFleet's own local harness.  Routing traffic through a
   hosted service disqualifies it.
3. **Open-source** — MIT / Apache-2.0 / BSD.  Proprietary or source-available disqualifies.
4. **Agent-oriented** — streaming turns, reasoning display, tool-call cards, approval prompts.
5. **Custom message types** — native rendering of arbitrary content (tool cards, SQL tables, PR diffs).
6. **Maintained** — activity within roughly the last year.
7. **CI-safe** — builds with Swift tools 6.0+ / Xcode 16+ without dependency pins that break the build.

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

BotFleet is messaging over its own backend — squarely inside §2's excluded scope and contestable under
§3(e) and §6.  **Not adoptable.**  A free Maker tier exists (<5 team members, <$10k monthly revenue),
but pricing is moot: a UI-only build costs nothing in API usage while still requiring Stream customer
status.

Requirements, for the record: `swift-tools-version:6.0`, iOS 15+, Xcode 16+ (so not the Swift 6.2
hazard from the Kingfisher lesson).  The only iOS 26 gate is `AIOnDeviceModel`, behind
`canImport(FoundationModels)`.

### SwiftyChat — best structural fit, not agent-oriented

`EnesKaraosman/SwiftyChat`, Apache-2.0, 354 stars, last commit 2026-10-07, 60 files / 4,673 lines.

It clears the objection that disqualified Exyte:

- **Pure SwiftUI.**  `ChatView.swift` is `ScrollView(.vertical)` + `LazyVStack`.  The only UIKit in the
  package is a `VideoPlayerRepresentable` for video playback.  So it *can* host Liquid Glass.
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
translation layer, and it pulls Kingfisher `from: 8.5.0` — where ≥8.13 needs Swift 6.2 and breaks CI
(lesson 2026-09-28), so it needs a pin and a guard.

## Correction: the falsification pass found two libraries the first survey missed

A second pass was commissioned specifically to **break** the conclusion above, on the grounds that a
conclusion reached by one search is worth very little.  It succeeded.  Two candidates exist:

### `unlocalhosted/beautiful-ui-swift` — passes all seven criteria

MIT licence (full text, GitHub reports `licenseInfo.key = mit`).  Verified:

- **Pure SwiftUI container** — `ChatPanel.swift` is `ScrollView { LazyVStack { ForEach } }`, no
  `UIViewRepresentable` anywhere.  So it can host Liquid Glass.
- **Backend-agnostic** — `Package.swift` declares **zero dependencies** and there is no networking
  code.  Pure UI.
- **Agent-oriented** — this is what the first survey missed entirely.  It ships `ApprovalCard` +
  `ApprovalOptionList`, `ToolCallGroup` + `ToolCallRow`, `ThinkingTraceView` + `ThinkingStepRow`,
  and `StreamingResponseView`.  `ApprovalCard` was read and is a real implementation (bound
  selection, custom response, `ApprovalDecision` callback), not a stub.
- **Custom content** — unrestricted composition; ships `RecordTable`, `ChangeTable`, `CodeBlock`.  No
  closed enum.
- **Maintained** — last push 2026-08-12.
- **CI-safe** — `swift build` exits 0 in 136s on Swift 6.4 / Xcode 27.  Its manifest floor is
  `swift-tools-version: 6.3` and `.iOS(.v26)`, both *below* BotFleet's own (iOS 27.0, Swift 6.4), so
  it does not break our CI.

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

- **Vendor the shapes, not the package.**  `beautiful-ui-swift`'s `ApprovalCard` and `ThinkingTraceView`
  are worth reading closely — a second opinion on components we wrote ourselves, from an author who
  approached them fresh.  Reading is free and carries no dependency risk.
- **Still build grouping natively.**  Unchanged.
- **Do not depend on either library.**  Single-author, sub-3★, no adoption history.  A production
  dependency on that is a supply-chain risk, and MIT grants from a sole author can be relicensed.

### Honest accounting of the error

The first survey concluded "no candidate passes" from three candidates.  It searched for messengers
and an agent SDK, and did not search component libraries, GitHub topic pages, or Swift Package Index
systematically.  It also did not notice that "open + agent-oriented" was an unfalsifiable-sounding
claim until something was found.  The lesson is procedural: **for a "nothing exists" claim, the
search has to be as adversarial as the claim**, and a second pass should be commissioned *before*
the conclusion is recorded, not after.

### Residual uncertainty

- **No visual side-by-side.**  Everything here is source and licences.  Whether anyone's bubbles
  actually *look* better on a simulator is unverified.
- `beautiful-ui-swift` was compiled for **macOS**; the iOS/simulator build is unverified.  Its
  maintainer identity and whether the MIT grant would survive relicensing are unverified.
- "No *major* project provides an agent-oriented SwiftUI chat UI" still appears to hold — both
  counter-examples are single-author and sub-3★.  That weaker claim is the one I would defend.

## Sources

- `GetStream/stream-chat-swift-ai` (cloned, `main` @ Oct 8 2026) — LICENSE, Package.swift, README, sources, tests
- `GetStream/stream-core-swift` (cloned) — Package.swift, LICENSE, full file listing
- `GetStream/stream-chat-swiftui` — Package.swift (dependency on `stream-chat-swift`)
- <https://getstream.io/chat/docs/sdk/ios/guides/ai-integrations/> — `StreamChatAI` component list
- `EnesKaraosman/SwiftyChat` (cloned, `08661b8`) — Package.swift, LICENSE, `ChatMessage.swift`, `ChatMessageKind.swift`, `ChatView.swift`
- `exyte/Chat` @ `49bf1f3` (cloned) — `UIList.swift`, `Message.swift`, `ChatView.swift`
- `CherryHQ/hanlin-ai` — README (agent-oriented but a whole application, not a library)
- `unlocalhosted/beautiful-ui-swift` — LICENSE, Package.swift, `ChatPanel.swift`, `ApprovalCard.swift`, models; `swift build` exit 0
- `NerdSnipe-Inc/AIChatKit` — LICENSE, Package.swift, `ChatMessage.swift`, `ChatProvider.swift`, `ConversationView.swift`
- `euforicio/streamdown-swift`, `unionst/swift-chat`, `BBC6BAE9/a2ui-swift`, `FluidGroup/swiftui-messaging-ui` — LICENSE / Package.swift
- <https://swiftpackageindex.com/packages?q=chat> (its search API now returns HTML, not JSON — a gap that contributed to the first pass missing these)