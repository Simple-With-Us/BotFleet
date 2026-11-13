// Bounded client-side coalescing for streamed reply deltas (BF-2608).
//
// The harness relays one `content.delta` frame per provider token. Folding
// each one straight into `CompanionState` made every token one `@Published`
// emission in `Session`, and therefore one SwiftUI invalidation of the whole
// chat screen — grouping, markdown and scroll bookkeeping included — at full
// token rate. The fold itself is cheap; the publish is not.
//
// This buffer is the client half of that fix, kept pure and free of timers
// so `swift test` can pin it: it concatenates deltas per (thread, stream
// kind) in arrival order and hands them back as one event per key. `Session`
// owns the clock — it drains at most once per `flushInterval`, drains before
// any non-delta frame, and drains on turn end — so ordering, the settled
// text, the reasoning/answer split and the completion flush are all exactly
// what the unbatched fold produced, with at most one publish per window.
//
// Measurement that sized this (Mac bench, 2,000 deltas, this tree): the raw
// append costs ~0.6 ms unbatched; coalescing does not speed the append up.
// What it cuts is the publish count — 2,000 emissions to 50 in burst shape,
// and at steady token rates a 50 ms window caps emissions at 20/s (2x fewer
// at 40 tok/s, 4x at 80 tok/s, 8x at 160 tok/s). Each avoided emission is a
// whole-transcript regroup plus view diff that no longer happens.
import Foundation

/// One buffered stream: a thread plus which live string its deltas feed.
/// The answer and the reasoning must never share a buffer — running them
/// together reads as the bot contradicting itself mid-sentence, which is
/// why `CompanionState` keeps the two strings apart in the first place.
public struct StreamingDeltaKey: Hashable, Sendable {
    public var threadId: String
    public var streamKind: String

    public init(threadId: String, streamKind: String) {
        self.threadId = threadId
        self.streamKind = streamKind
    }
}

/// What should happen to one incoming runtime event.
public enum StreamingDeltaDisposition: Equatable, Sendable {
    /// A `content.delta` for a known stream kind; held for the next drain.
    case buffered
    /// Not coalescable. Apply it now — after draining, so nothing it must
    /// observe or clear is still sitting in the buffer.
    case applyNow
    /// An unknown stream kind. The unbatched fold drops these rather than
    /// guessing whether they are answer or reasoning; the buffer does too.
    case dropped
}

/// Accumulates streamed deltas until the owner drains them.
///
/// Deliberately not a timer and not an actor: `Session` is already on the
/// main actor and owns every other flush decision in the stream loop, and a
/// clock in here would make the ordering rules untestable. The bounds are
/// the owner's backstop, not the policy — `shouldFlush` tells it when the
/// buffer has grown past what one window should hold, so a fast provider
/// cannot trade publish savings for unbounded latency or memory.
public struct StreamingDeltaBuffer: Equatable, Sendable {
    /// How often `Session` drains at most. 20 publishes a second is well
    /// above what a reader can follow as text growth, matches the cadence
    /// the follow-scroll already throttles to (100 ms in `BottomFollow`),
    /// and keeps the first token of a reply on screen within one frame or
    /// two of when it would have appeared unbatched.
    public static let flushInterval: Double = 0.05
    /// Drain early past this many held deltas, whatever the clock says.
    public static let maxBufferedDeltas = 64
    /// Drain early past this many held characters, whatever the clock says.
    public static let maxBufferedCharacters = 4_096

    private var pending: [StreamingDeltaKey: String] = [:]
    /// First-seen order of the keys, so a drain applies streams in the order
    /// they started rather than in dictionary order. Per-key text order is
    /// arrival order regardless; this only keeps multi-thread drains
    /// deterministic.
    private var keyOrder: [StreamingDeltaKey] = []
    /// Raw deltas held, before coalescing. The publish saving in one drain
    /// is this number becoming `coalescedCount`.
    public private(set) var bufferedDeltaCount = 0
    /// Characters held across every key.
    public private(set) var bufferedCharacterCount = 0

    public init() {}

    public var isEmpty: Bool { pending.isEmpty }

    /// Events a drain would emit: one per key, deltas concatenated.
    public var coalescedCount: Int { pending.count }

    /// True when the bounds say to drain now rather than at the interval.
    public var shouldFlush: Bool {
        bufferedDeltaCount >= Self.maxBufferedDeltas
            || bufferedCharacterCount >= Self.maxBufferedCharacters
    }

    /// Classify and, when it is a delta for a known stream, hold one event.
    ///
    /// Mirrors the fold in `CompanionState.apply(runtime:)` exactly: an
    /// empty delta folds to nothing there, so it buffers to nothing here;
    /// `assistant_text` feeds the answer, `reasoning_text` the reasoning,
    /// and anything else is dropped, never guessed at.
    public mutating func enqueue(_ event: RuntimeEvent) -> StreamingDeltaDisposition {
        guard event.type == "content.delta" else { return .applyNow }
        guard let delta = event.delta, !delta.isEmpty else { return .dropped }
        guard event.streamKind == "assistant_text" || event.streamKind == "reasoning_text" else {
            return .dropped
        }
        let key = StreamingDeltaKey(threadId: event.threadId, streamKind: event.streamKind ?? "")
        if pending[key] == nil { keyOrder.append(key) }
        pending[key, default: ""] += delta
        bufferedDeltaCount += 1
        bufferedCharacterCount += delta.count
        return .buffered
    }

    /// Whether this event ends a turn. The owner drains before applying one,
    /// so the live text it clears is the complete text, never a prefix still
    /// missing its buffered tail.
    public static func isTurnEnding(_ event: RuntimeEvent) -> Bool {
        event.type == "turn.completed" || event.type == "turn.failed" || event.type == "turn.aborted"
    }

    /// Take every held delta as one event per key, in first-seen key order.
    public mutating func drain() -> [RuntimeEvent] {
        guard !pending.isEmpty else { return [] }
        let events = keyOrder.compactMap { key -> RuntimeEvent? in
            guard let text = pending[key] else { return nil }
            return RuntimeEvent(
                type: "content.delta",
                threadId: key.threadId,
                delta: text,
                streamKind: key.streamKind
            )
        }
        pending.removeAll()
        keyOrder.removeAll()
        bufferedDeltaCount = 0
        bufferedCharacterCount = 0
        return events
    }
}

extension CompanionState {
    /// Fold events the buffer already coalesced. Each one lands through the
    /// ordinary `apply`, so a drained event can never behave differently
    /// from the same text arriving unbatched — the batching is in how many
    /// times the owner publishes, not in what the fold does.
    public mutating func applyCoalesced(_ events: [RuntimeEvent]) {
        for event in events { apply(.runtime(event)) }
    }
}
