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
        let events = AsyncStream<TurnEvent> { continuation in
            continuation.yield(.sessionStarted(sessionId: "s"))
            continuation.yield(.textDelta("a"))
            continuation.yield(.textDelta("b"))
            continuation.yield(.completed(stopReason: "end_turn", inputTokens: nil, outputTokens: nil))
            continuation.finish()
        }
        var state = CompanionState()
        var sawText = false
        for await frame in NativeDesktopChatFrames.frames(from: events, threadId: "thread-a") {
            state.apply(frame)
            if state.streaming["thread-a"] == "ab" { sawText = true }
        }
        #expect(sawText)
        #expect(state.streaming["thread-a"] == nil)
    }
}
