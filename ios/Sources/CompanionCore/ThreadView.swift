// Browsing a retained thread while the bot works (Slice 0 iOS).
//
// Mirrors the web Slice 0 (`src/state/store.tsx` `viewThread` /
// `threadPickIntent`): viewing is passive. It moves only the read pin,
// never the bot's active thread, so the running turn keeps its execution
// target. The transcript comes from the existing
// `GET /api/threads/:threadId/messages` route — which serves any known
// thread, active or not — plus the same SSE message frames, applied by
// threadId into the per-thread pages this store already keeps.
import Foundation

/// What picking a thread row or tab means. Browsing is passive: while the
/// bot works, picking another thread only *views* it — becoming the
/// execution target (`switchTo`) stays gated on the turn finishing, and
/// picking the active thread while a view is in effect returns to it
/// (`viewActive`). Without a view affordance (`canView` false) a busy pick
/// stays `none`, exactly as before.
public enum ThreadViewIntent: Sendable, Equatable {
    case switchTo
    case view
    case viewActive
    case none
}

public func threadPickIntent(busy: Bool, active: Bool, viewing: Bool, canView: Bool) -> ThreadViewIntent {
    if active { return canView && viewing ? .viewActive : .none }
    if busy { return canView ? .view : .none }
    return .switchTo
}

/// What sits after the last settled row for the thread on screen while the
/// bot works. The streaming/reasoning text is already keyed by the displayed
/// thread, but the `busy` fallback is the *active* bot's flag — while
/// browsing a retained thread (`viewingOther`) it must stay `.none`, or an
/// idle page shows false activity for the thread that is actually working.
public func bottomLiveRow(
    streaming: String?, reasoning: String?, viewingOther: Bool, busy: Bool
) -> BottomFollow.LiveRow {
    if let streaming, !streaming.isEmpty { return .text }
    if let reasoning, !reasoning.isEmpty { return .reasoning }
    if viewingOther { return .none }
    return busy ? .typing : .none
}
