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

## Result: no candidate passes all seven

The landscape splits, and the two halves never meet.

**Agent-oriented libraries are proprietary and backend-locked.  Open SwiftUI libraries are generic
messengers.**  There is no third option.

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

## Recommendation

**Build the missing pieces natively.  Do not take a dependency.**

The one concrete gap this survey confirmed is **message grouping** — consecutive messages from the
same speaker do not cluster (`grep` for `grouped|isGrouped|consecutive|sameSender` in `ChatView.swift`
returns nothing).  It is roughly 40 lines of SwiftUI against a `ChatView.swift` already at 2,644.

The 2026-09-30 audit framed this as "borrow vs polish," which implied borrowing was broadly available.
For the agent-specific parts it is not.  That is a correction worth recording, and it is the reason the
original audit's premise had to be corrected in the first place.

### One design worth stealing — the schema, not the code

Stream's `ai_reasoning` / `ai_tool_call` attachment schema is a clean, consistent wire shape for tool
cards: a typed part with a payload, which `AIMessagePart.parts(from: [(type: String, payload: Data)])`
decodes from plain tuples.  BotFleet's tool cards could adopt that shape **without the dependency** —
it is a data convention, not code.  Worth considering if the harness's card payloads need a consistent
form.

## Residual uncertainty

- **No visual side-by-side.**  Everything above is from source and licences.  Whether Exyte's or
  Stream's bubbles actually *look* better than ours on a simulator is unverified, and if that is the
  real appeal, code reading will not settle it.
- **Pricing tier numbers are unverified** beyond Stream's stated Maker eligibility — the pricing tables
  are JS-rendered.  Moot given the licence blocker.
- **An independent falsification pass was commissioned** to try to break the "nobody is agent-oriented
  and open" conclusion, since a conclusion reached by one search is worth little.  Its result is
  recorded in the board row `3c30a404`.

## Sources

- `GetStream/stream-chat-swift-ai` (cloned, `main` @ Oct 8 2026) — LICENSE, Package.swift, README, sources, tests
- `GetStream/stream-core-swift` (cloned) — Package.swift, LICENSE, full file listing
- `GetStream/stream-chat-swiftui` — Package.swift (dependency on `stream-chat-swift`)
- <https://getstream.io/chat/docs/sdk/ios/guides/ai-integrations/> — `StreamChatAI` component list
- `EnesKaraosman/SwiftyChat` (cloned, `08661b8`) — Package.swift, LICENSE, `ChatMessage.swift`, `ChatMessageKind.swift`, `ChatView.swift`
- `exyte/Chat` @ `49bf1f3` (cloned) — `UIList.swift`, `Message.swift`, `ChatView.swift`
- `CherryHQ/hanlin-ai` — README (agent-oriented but a whole application, not a library)