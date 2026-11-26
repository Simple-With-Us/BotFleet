import Foundation

/// How a native chat turn reads in the Mac app's window (`BF-2705`, slice 3).
///
/// The window folds `Frame`s into `CompanionState`, the same fold the Node
/// harness's event stream feeds.  This turns the native engine's
/// `TurnEvent`s into the frames that fold already understands, so the live
/// reply streams into the open thread exactly as a harness reply does:
/// answer text and reasoning arrive as `content.delta` runtime events, and
/// the turn's end clears the live bubble.  The settled messages themselves
/// are persisted by the coordinator's dispatcher and come from the native
/// store, not from here.
public enum NativeDesktopChatFrames {
    /// The frames one turn event becomes on `threadId`.  Events the window
    /// has no fold for yet (session start, tool calls and results,
    /// permission requests, config updates) become no frames rather than a
    /// guess at their shape.
    public static func frames(for event: TurnEvent, threadId: String) -> [Frame] {
        switch event {
        case .textDelta(let text):
            guard !text.isEmpty else { return [] }
            return [.runtime(RuntimeEvent(
                type: "content.delta", threadId: threadId, delta: text, streamKind: "assistant_text"
            ))]
        case .reasoningDelta(let text):
            guard !text.isEmpty else { return [] }
            return [.runtime(RuntimeEvent(
                type: "content.delta", threadId: threadId, delta: text, streamKind: "reasoning_text"
            ))]
        case .completed:
            return [.runtime(RuntimeEvent(type: "turn.completed", threadId: threadId, delta: nil, streamKind: nil))]
        case .error:
            return [.runtime(RuntimeEvent(type: "turn.failed", threadId: threadId, delta: nil, streamKind: nil))]
        case .sessionStarted, .toolCall, .toolResult, .permissionRequest, .configUpdated:
            return []
        }
    }

    /// A turn's whole event stream as window frames, in order.  Cancelling
    /// the returned stream cancels the turn's stream underneath it, which is
    /// what `NativeDesktopChatService` turns into cancelling the engine turn.
    public static func frames(from events: AsyncStream<TurnEvent>, threadId: String) -> AsyncStream<Frame> {
        AsyncStream(bufferingPolicy: .unbounded) { continuation in
            let relay = Task {
                for await event in events {
                    for frame in frames(for: event, threadId: threadId) {
                        continuation.yield(frame)
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in relay.cancel() }
        }
    }
}
