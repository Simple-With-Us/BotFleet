import XCTest
@testable import CompanionCore

/// BF-2608 / BF-2609: the delta coalescer must be indistinguishable from the
/// unbatched fold except in how many publishes it causes, and the transcript
/// grouping the eager `VStack` pays per publish must stay cheap at the
/// 50-message default page. Publish counts here are state mutations: in
/// `Session` each one is an `@Published` emission.
final class StreamingBatchTests: XCTestCase {
    private func delta(_ text: String, thread: String = "t1", kind: String = "assistant_text") -> RuntimeEvent {
        RuntimeEvent(type: "content.delta", threadId: thread, delta: text, streamKind: kind)
    }

    func testCoalescedTextMatchesUnbatchedFoldExactly() {
        let pieces = ["Hel", "lo, ", "w", "orld", "!", " How", " are", " you?"]
        var unbatched = CompanionState()
        for piece in pieces { unbatched.apply(.runtime(delta(piece))) }

        var buffer = StreamingDeltaBuffer()
        var batched = CompanionState()
        for piece in pieces { XCTAssertEqual(buffer.enqueue(delta(piece)), .buffered) }
        XCTAssertEqual(buffer.bufferedDeltaCount, pieces.count)
        XCTAssertEqual(buffer.coalescedCount, 1)
        batched.applyCoalesced(buffer.drain())
        XCTAssertEqual(batched.streaming["t1"], unbatched.streaming["t1"])
        XCTAssertEqual(batched.streaming["t1"], "Hello, world! How are you?")
        XCTAssertTrue(buffer.isEmpty)
    }

    func testAnswerAndReasoningNeverShareABuffer() {
        var buffer = StreamingDeltaBuffer()
        XCTAssertEqual(buffer.enqueue(delta("thinking", kind: "reasoning_text")), .buffered)
        XCTAssertEqual(buffer.enqueue(delta("answer")), .buffered)
        XCTAssertEqual(buffer.enqueue(delta(" more", kind: "reasoning_text")), .buffered)
        let events = buffer.drain()
        XCTAssertEqual(events.count, 2)
        var state = CompanionState()
        state.applyCoalesced(events)
        XCTAssertEqual(state.reasoning["t1"], "thinking more")
        XCTAssertEqual(state.streaming["t1"], "answer")
    }

    func testThreadsCoalesceIndependentlyAndDrainInFirstSeenOrder() {
        var buffer = StreamingDeltaBuffer()
        _ = buffer.enqueue(delta("for two ", thread: "t2"))
        _ = buffer.enqueue(delta("for one", thread: "t1"))
        _ = buffer.enqueue(delta("only", thread: "t2"))
        let events = buffer.drain()
        XCTAssertEqual(events.map(\.threadId), ["t2", "t1"])
        XCTAssertEqual(events.first?.delta, "for two only")
        var state = CompanionState()
        state.applyCoalesced(events)
        XCTAssertEqual(state.streaming["t1"], "for one")
        XCTAssertEqual(state.streaming["t2"], "for two only")
    }

    func testUnknownKindsAndEmptyDeltasDropLikeTheUnbatchedFold() {
        var buffer = StreamingDeltaBuffer()
        XCTAssertEqual(buffer.enqueue(delta("???", kind: "some_future_kind")), .dropped)
        XCTAssertEqual(buffer.enqueue(delta("")), .dropped)
        XCTAssertEqual(buffer.enqueue(RuntimeEvent(type: "content.delta", threadId: "t1", delta: nil, streamKind: "assistant_text")), .dropped)
        XCTAssertTrue(buffer.isEmpty)
    }

    func testNonDeltaEventsAreNeverBuffered() {
        var buffer = StreamingDeltaBuffer()
        for ending in ["turn.completed", "turn.failed", "turn.aborted"] {
            let event = RuntimeEvent(type: ending, threadId: "t1", delta: nil, streamKind: nil)
            XCTAssertEqual(buffer.enqueue(event), .applyNow)
            XCTAssertTrue(StreamingDeltaBuffer.isTurnEnding(event))
        }
        XCTAssertEqual(buffer.enqueue(RuntimeEvent(type: "turn.started", threadId: "t1", delta: nil, streamKind: nil)), .applyNow)
    }

    /// The Session contract in miniature: drain before the turn ends, so the
    /// clear sees complete text; drain before a settled message, so it
    /// supersedes complete text. Final state must equal the unbatched fold.
    func testFlushBeforeTurnEndAndSettledMessageMatchesUnbatched() {
        let frames: [Frame] = [
            .runtime(delta("partial ")),
            .runtime(delta("answer")),
            .message(threadId: "t1", message: Message(id: "m1", role: .bot, kind: .text, at: 1, text: "partial answer, completed")),
            .runtime(delta("next ")),
            .runtime(delta("turn")),
            .runtime(RuntimeEvent(type: "turn.completed", threadId: "t1", delta: nil, streamKind: nil)),
        ]
        var unbatched = CompanionState()
        for frame in frames { unbatched.apply(frame) }

        var buffer = StreamingDeltaBuffer()
        var batched = CompanionState()
        for frame in frames {
            if case let .runtime(event) = frame, buffer.enqueue(event) == .buffered { continue }
            batched.applyCoalesced(buffer.drain())
            batched.apply(frame)
        }
        batched.applyCoalesced(buffer.drain())
        XCTAssertEqual(batched.streaming, unbatched.streaming)
        XCTAssertEqual(batched.reasoning, unbatched.reasoning)
        XCTAssertEqual(batched.transcript(forThread: "t1").map(\.id), ["m1"])
        XCTAssertNil(batched.streaming["t1"])
    }

    func testBoundsTripAtDeltaAndCharacterCaps() {
        var byCount = StreamingDeltaBuffer()
        for _ in 0..<StreamingDeltaBuffer.maxBufferedDeltas { _ = byCount.enqueue(delta("x")) }
        XCTAssertTrue(byCount.shouldFlush)
        XCTAssertEqual(byCount.coalescedCount, 1)

        var byChars = StreamingDeltaBuffer()
        _ = byChars.enqueue(delta(String(repeating: "y", count: StreamingDeltaBuffer.maxBufferedCharacters)))
        XCTAssertTrue(byChars.shouldFlush)

        var small = StreamingDeltaBuffer()
        _ = small.enqueue(delta("hi"))
        XCTAssertFalse(small.shouldFlush)
    }

    /// The saving, counted the way Session pays it: one mutation per drain
    /// instead of one per token.
    func testPublishCountCollapsesAtTokenRate() {
        var buffer = StreamingDeltaBuffer()
        var mutations = 0
        var state = CompanionState()
        // 2,000 tokens in burst windows of 40: the shape a fast provider
        // produces against a 50 ms drain.
        for index in 0..<2_000 {
            _ = buffer.enqueue(delta("tok\(index % 10) "))
            if buffer.bufferedDeltaCount == 40 {
                state.applyCoalesced(buffer.drain())
                mutations += 1
            }
        }
        if !buffer.isEmpty { state.applyCoalesced(buffer.drain()); mutations += 1 }
        XCTAssertEqual(mutations, 50)
        XCTAssertEqual(state.streaming["t1"]?.count, 2_000 * 5)
    }

    /// BF-2609 companion probe: the per-publish grouping cost the eager
    /// stack pays at the default page. Generous bound — this guards against
    /// an accidental quadratic, it is not a device benchmark.
    func testGroupingStaysCheapAtDefaultAndExpandedSizes() {
        for count in [50, 200, 500] {
            let messages = (0..<count).map { index in
                Message(id: "m\(index)", role: index.isMultiple(of: 2) ? .user : .bot, kind: .text, at: Double(index), text: "line \(index)")
            }
            let start = ContinuousClock.now
            for _ in 0..<20 { _ = groupMessageRuns(messages) }
            let elapsed = ContinuousClock.now - start
            let millis = Double(elapsed.components.seconds) * 1_000
                + Double(elapsed.components.attoseconds) / 1e15
            XCTAssertLessThan(millis / 20, 5.0, "grouping \(count) messages took \(millis / 20) ms per pass")
        }
    }
}
