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
/// store through the caller's `settled` hook, not from here.
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
            return [turnEnd("turn.completed", threadId: threadId)]
        case .error:
            return [turnEnd("turn.failed", threadId: threadId)]
        case .sessionStarted, .toolCall, .toolResult, .permissionRequest, .configUpdated:
            return []
        }
    }

    /// A turn's whole event stream as window frames, in order.
    ///
    /// The first terminal event (`.completed` or `.error`) ends the turn:
    /// anything the stream yields after it is dropped, so a late or
    /// duplicate delta never streams into a turn that has already ended.
    /// Its frame (`turn.completed` or `turn.failed`) is held until the
    /// stream ends, and the frames `settled` returns go out before it: the
    /// settled reply lands in the transcript first, so the live bubble is
    /// never cleared while nothing has replaced it.  A stream that ends
    /// without either terminal event (the engine dropped it) ends with
    /// `turn.aborted`, so a partial reply never stays on screen as if it
    /// were still coming.
    ///
    /// `settled` runs on every ending, aborted included, because it reads
    /// only what the dispatcher durably wrote to the native store: on a
    /// dropped turn that is still the person's own prompt, which must not
    /// vanish from the window.
    ///
    /// Cancelling the returned stream cancels the turn's stream underneath
    /// it, which `NativeDesktopChatService` turns into cancelling the engine
    /// turn.  A window that cancels has stopped listening, so it clears its
    /// own live bubble rather than waiting for frames from here.
    public static func frames(
        from events: AsyncStream<TurnEvent>,
        threadId: String,
        settled: (@Sendable () async -> [Frame])? = nil
    ) -> AsyncStream<Frame> {
        AsyncStream(bufferingPolicy: .unbounded) { continuation in
            let relay = Task {
                var ending: Frame?
                for await event in events {
                    guard ending == nil else { continue }
                    switch event {
                    case .completed, .error:
                        ending = NativeDesktopChatFrames.frames(for: event, threadId: threadId).first
                    default:
                        for frame in NativeDesktopChatFrames.frames(for: event, threadId: threadId) {
                            continuation.yield(frame)
                        }
                    }
                }
                if let settled {
                    for frame in await settled() {
                        continuation.yield(frame)
                    }
                }
                continuation.yield(ending ?? turnEnd("turn.aborted", threadId: threadId))
                continuation.finish()
            }
            continuation.onTermination = { _ in relay.cancel() }
        }
    }

    private static func turnEnd(_ type: String, threadId: String) -> Frame {
        .runtime(RuntimeEvent(type: type, threadId: threadId, delta: nil, streamKind: nil))
    }
}
