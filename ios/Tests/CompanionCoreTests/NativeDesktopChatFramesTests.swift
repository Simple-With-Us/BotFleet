import Foundation
import Testing
@testable import CompanionCore

@Suite("Native chat turns as window frames (BF-2705)")
struct NativeDesktopChatFramesTests {
    @Test("Answer text streams into the thread's live bubble and the turn's end clears it")
    func textStreamsThenClears() {
        var state = CompanionState()
        for frame in NativeDesktopChatFrames.frames(for: .textDelta("hi "), threadId: "thread-a") { state.apply(frame) }
        for frame in NativeDesktopChatFrames.frames(for: .textDelta("there"), threadId: "thread-a") { state.apply(frame) }
        #expect(state.streaming["thread-a"] == "hi there")

        let done = NativeDesktopChatFrames.frames(
            for: .completed(stopReason: "end_turn", inputTokens: 1, outputTokens: 1), threadId: "thread-a"
        )
        for frame in done { state.apply(frame) }
        #expect(state.streaming["thread-a"] == nil)
    }

    @Test("Reasoning streams apart from the answer")
    func reasoningStreamsSeparately() {
        var state = CompanionState()
        for frame in NativeDesktopChatFrames.frames(for: .reasoningDelta("thinking"), threadId: "thread-a") {
            state.apply(frame)
        }
        #expect(state.reasoning["thread-a"] == "thinking")
        #expect(state.streaming["thread-a"] == nil)
    }

    @Test("A failed turn clears the live bubble instead of leaving a half answer")
    func errorClears() {
        var state = CompanionState()
        for frame in NativeDesktopChatFrames.frames(for: .textDelta("partial"), threadId: "thread-a") { state.apply(frame) }
        for frame in NativeDesktopChatFrames.frames(for: .error(code: "x", message: "boom"), threadId: "thread-a") {
            state.apply(frame)
        }
        #expect(state.streaming["thread-a"] == nil)
    }

    @Test("Events the window has no fold for become no frames")
    func unfoldedEventsAreDropped() {
        let events: [TurnEvent] = [
            .sessionStarted(sessionId: "s"),
            .toolCall(id: "t", name: "Read", argumentsJSON: "{}"),
            .toolResult(id: "t", output: "ok", isError: false),
            .permissionRequest(id: "p", tool: "Bash", description: "run"),
            .configUpdated(key: "k", value: "v"),
            .textDelta(""),
            .reasoningDelta("")
        ]
        for event in events {
            #expect(NativeDesktopChatFrames.frames(for: event, threadId: "thread-a").isEmpty)
        }
    }

    @Test("Frames stay on the thread they were made for")
    func framesKeepTheirThread() {
        let frames = NativeDesktopChatFrames.frames(for: .textDelta("hi"), threadId: "thread-b")
        #expect(frames.count == 1)
        #expect(frames.first?.threadId == "thread-b")
    }

    @Test("A whole turn stream becomes the same frames in order")
    func streamMapsInOrder() async {
        let events = stream([
            .sessionStarted(sessionId: "s"),
            .textDelta("a"),
            .textDelta("b"),
            .completed(stopReason: "end_turn", inputTokens: nil, outputTokens: nil)
        ])
        var state = CompanionState()
        var sawText = false
        for await frame in NativeDesktopChatFrames.frames(from: events, threadId: "thread-a") {
            state.apply(frame)
            if state.streaming["thread-a"] == "ab" { sawText = true }
        }
        #expect(sawText)
        #expect(state.streaming["thread-a"] == nil)
    }

    @Test("The settled reply's frames land before the frame that ends the turn")
    func settledFramesPrecedeTurnEnd() async {
        let events = stream([
            .textDelta("a"),
            .completed(stopReason: "end_turn", inputTokens: nil, outputTokens: nil)
        ])
        let settled: @Sendable () async -> [Frame] = { () async -> [Frame] in
            [Self.settledMarker]
        }
        var types: [String] = []
        for await frame in NativeDesktopChatFrames.frames(from: events, threadId: "thread-a", settled: settled) {
            if case let .runtime(event) = frame { types.append(event.type) }
        }
        #expect(types == ["content.delta", "test.settled", "turn.completed"])
    }

    @Test("A stream that ends with no terminal event ends the turn as aborted")
    func droppedStreamEndsAborted() async {
        let events = stream([.textDelta("partial")])
        var state = CompanionState()
        var types: [String] = []
        for await frame in NativeDesktopChatFrames.frames(from: events, threadId: "thread-a") {
            state.apply(frame)
            if case let .runtime(event) = frame { types.append(event.type) }
        }
        #expect(types == ["content.delta", "turn.aborted"])
        #expect(state.streaming["thread-a"] == nil)
    }

    @Test("A failed stream ends with turn.failed, after the settled frames")
    func failedStreamEndsFailed() async {
        let events = stream([.textDelta("partial"), .error(code: "x", message: "boom")])
        let settled: @Sendable () async -> [Frame] = { () async -> [Frame] in
            [Self.settledMarker]
        }
        var types: [String] = []
        for await frame in NativeDesktopChatFrames.frames(from: events, threadId: "thread-a", settled: settled) {
            if case let .runtime(event) = frame { types.append(event.type) }
        }
        #expect(types == ["content.delta", "test.settled", "turn.failed"])
    }

    @Test("Deltas after the turn has ended are dropped, not streamed")
    func postTerminalDeltasDropped() async {
        let events = stream([
            .textDelta("a"),
            .completed(stopReason: "end_turn", inputTokens: nil, outputTokens: nil),
            .textDelta("late"),
            .reasoningDelta("late")
        ])
        var state = CompanionState()
        var types: [String] = []
        for await frame in NativeDesktopChatFrames.frames(from: events, threadId: "thread-a") {
            state.apply(frame)
            if case let .runtime(event) = frame { types.append(event.type) }
        }
        #expect(types == ["content.delta", "turn.completed"])
        #expect(state.streaming["thread-a"] == nil)
    }

    @Test("A persistence failure after completion ends the turn as failed")
    func persistenceFailureAfterCompletionFails() async {
        // TurnDispatcherActor forwards .completed, then writes the reply, and
        // yields .error(persistence_failed) when that write fails.
        let events = stream([
            .textDelta("a"),
            .completed(stopReason: "end_turn", inputTokens: nil, outputTokens: nil),
            .error(code: "persistence_failed", message: "Native turn output could not be persisted")
        ])
        var types: [String] = []
        for await frame in NativeDesktopChatFrames.frames(from: events, threadId: "thread-a") {
            if case let .runtime(event) = frame { types.append(event.type) }
        }
        #expect(types == ["content.delta", "turn.failed"])
    }

    @Test("The settled hook runs only after the whole stream has ended")
    func settledWaitsForStreamEnd() async {
        // The reply is durable only once the dispatcher's stream ends, so the
        // hook must not run at .completed while the stream is still open.
        let (events, input) = AsyncStream<TurnEvent>.makeStream()
        let probe = SettledProbe()
        let settled: @Sendable () async -> [Frame] = { () async -> [Frame] in
            await probe.markRan()
            return []
        }
        let frames = NativeDesktopChatFrames.frames(from: events, threadId: "thread-a", settled: settled)
        let consumer = Task { () -> [String] in
            var types: [String] = []
            for await frame in frames {
                if case let .runtime(event) = frame { types.append(event.type) }
            }
            return types
        }
        input.yield(.completed(stopReason: "end_turn", inputTokens: nil, outputTokens: nil))
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(await probe.ran == false)
        input.finish()
        #expect(await consumer.value == ["turn.completed"])
        #expect(await probe.ran == true)
    }

    private static let settledMarker = Frame.runtime(
        RuntimeEvent(type: "test.settled", threadId: "thread-a", delta: nil, streamKind: nil)
    )

    private func stream(_ events: [TurnEvent]) -> AsyncStream<TurnEvent> {
        AsyncStream { continuation in
            for event in events { continuation.yield(event) }
            continuation.finish()
        }
    }
}

private actor SettledProbe {
    private(set) var ran = false
    func markRan() { ran = true }
}
