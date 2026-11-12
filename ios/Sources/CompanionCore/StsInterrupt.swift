// What a barge-in tells the vendor.
//
// A port of the `interrupt` closure in src/lib/sts/xai-realtime.ts.  It lives
// in CompanionCore rather than in the session because `swift test` only builds
// CompanionCore: a rule that decides how much of a reply the caller actually
// heard would otherwise be untestable on the phone and could only be judged by
// watching the bot talk over itself.
import Foundation

/// One frame of an interrupt, as the session serialises it onto the wire.
public enum StsInterruptFrame: Hashable, Sendable {
    /// `conversation.item.truncate` -- the caller heard this much of the reply,
    /// so the model discards everything after it.
    case truncate(itemId: String, contentIndex: Int, audioEndMs: Int)
    /// `response.cancel` -- stop generating.  Always last.
    case cancel
}

public enum StsInterrupt {
    /// The frames one barge-in sends, in order.
    ///
    /// The truncate is what makes an interruption land correctly: without it the
    /// model keeps generating the tail of a reply the caller cut off, and talks
    /// over itself for the rest of the turn.  It needs the item id of the reply
    /// in flight and the milliseconds of it that were actually audible, because
    /// the model's transcript and the room's audio have to agree on where the
    /// sentence stopped.
    ///
    /// The cancel goes out even with no item in flight.  A caller who interrupts
    /// during silence, or after the reply already finished, still means "stop";
    /// skipping the frame because there was nothing to truncate would leave a
    /// response free to start at us.
    ///
    /// `playedMs` is floored at zero rather than trusted: a playback clock read
    /// can come back negative or slightly over, and a truncate that claims the
    /// caller heard audio they did not is worse than one that under-claims.
    public static func frames(itemId: String, playedMs: Int) -> [StsInterruptFrame] {
        let heard = max(0, playedMs)
        var frames: [StsInterruptFrame] = []
        if !itemId.isEmpty {
            frames.append(.truncate(itemId: itemId, contentIndex: 0, audioEndMs: heard))
        }
        frames.append(.cancel)
        return frames
    }
}