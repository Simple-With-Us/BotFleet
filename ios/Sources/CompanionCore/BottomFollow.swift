// When the chat transcript may move on its own, and when it must hold still.
//
// The rule is the desktop's (src/lib/bottom-follow.ts and ChatView.tsx):
// follow the newest message only while the reader is at the bottom, stop
// the moment the reader scrolls toward older messages, and start again when
// they come back down or ask for it.  The phone used to scroll to the bottom
// on every token and every settled message, which made catching up on a
// busy thread impossible: the text being read kept sliding away.
//
// This is policy only, kept free of SwiftUI so it can be tested with
// `swift test`.  ChatView feeds it scroll samples and explicit actions and
// asks it two questions: may the transcript follow, and how many bot
// messages has the reader not seen yet.
import Foundation

/// Where the reader is in the transcript, reduced to what the follow policy
/// needs.
public struct TranscriptScrollSample: Equatable, Sendable {
    /// Content offset along the vertical axis.  It grows as the reader moves
    /// toward newer messages and does not change when content is added below
    /// a reader who holds still.
    public var offset: Double
    /// Points of content below the visible area.  Zero at the bottom, and
    /// negative while the reader pulls past the bottom edge.
    public var distanceFromBottom: Double
    /// Whether the content is taller than the visible area.  A transcript
    /// that fits on screen cannot be scrolled away from.
    public var isScrollable: Bool

    public init(offset: Double, distanceFromBottom: Double, isScrollable: Bool) {
        self.offset = offset
        self.distanceFromBottom = distanceFromBottom
        self.isScrollable = isScrollable
    }

    /// Build a sample from scroll-view geometry in UIKit's terms: the
    /// container is the whole frame, including the parts under insets, and
    /// the offset is `-insetTop` at the top of the content and
    /// `contentHeight + insetBottom - containerHeight` at the bottom.  The
    /// chat header is a top safe-area inset, so it shows up in `insetTop` and
    /// is not part of the readable area.
    ///
    /// SwiftUI's `ScrollGeometry` matches this when fed `visibleRect`
    /// (`minY` and `height`).  Its `containerSize` is not the whole frame:
    /// it leaves out the top inset, and using it put the bottom 118pt (the
    /// header's height) away from where it really was.
    public static func geometry(
        contentOffsetY: Double,
        contentHeight: Double,
        containerHeight: Double,
        insetTop: Double,
        insetBottom: Double
    ) -> TranscriptScrollSample {
        let bottomOffset = contentHeight + insetBottom - containerHeight
        let readableHeight = containerHeight - insetTop - insetBottom
        // Rounded to the pixel grid so sub-point layout noise does not count
        // as movement.
        return TranscriptScrollSample(
            offset: (contentOffsetY * 2).rounded() / 2,
            distanceFromBottom: ((bottomOffset - contentOffsetY) * 2).rounded() / 2,
            isScrollable: contentHeight > readableHeight + 0.5
        )
    }
}

/// What is moving the transcript when a scroll sample is taken.
public enum TranscriptScrollDriver: Equatable, Sendable {
    /// A finger is on the screen (tracking or dragging).
    case finger
    /// The coast after the finger lifted, including the spring back from
    /// pulling past an edge.
    case momentum
    /// Nobody: content growth, keyboard and layout changes, the app's own
    /// unanimated `scrollTo` calls, or a system without scroll phases
    /// (iOS 17) when no drag is under way.
    case system
    /// The app's own animated scroll, such as Jump to Latest.
    case animation
}

/// Per-gesture bookkeeping that turns a raw scroll phase into a driver.
///
/// Pulling past the bottom and letting go springs the content back, and the
/// spring can carry it well above the bottom (recorded in the simulator: 77pt
/// past, coasting to 115pt above).  That coast is the edge pushing back, not
/// the reader leaving, so it is reported as `.system`.  Kept apart from
/// `BottomFollow` because it changes on every scrolled frame and must not
/// live in view state.
public struct TranscriptScrollMotion: Equatable, Sendable {
    private var reboundingFromBottom = false

    public init() {}

    public mutating func classify(
        _ driver: TranscriptScrollDriver,
        from previous: TranscriptScrollSample?,
        to current: TranscriptScrollSample
    ) -> TranscriptScrollDriver {
        switch driver {
        case .momentum:
            if current.distanceFromBottom < 0 || (previous?.distanceFromBottom ?? 0) < 0 {
                reboundingFromBottom = true
            }
            return reboundingFromBottom ? .system : .momentum
        case .finger, .system, .animation:
            // A new touch, the scroll came to rest, or the app took over: the
            // rebound is over.
            reboundingFromBottom = false
            return driver
        }
    }
}

/// Whether the transcript follows the newest message, and what the reader
/// has missed while it did not.
public struct BottomFollow: Equatable, Sendable {
    /// Within this many points of the bottom, a reader moving down is back.
    /// The same number as the desktop's `BOTTOM_FOLLOW_THRESHOLD`.
    public static let resumeDistance: Double = 48
    /// Movement toward older messages smaller than this is jitter, not a
    /// reader leaving the bottom.
    public static let leaveDistance: Double = 2
    /// The bottom itself, with room for rounding.
    public static let bottomTolerance: Double = 1
    /// The fastest the transcript may follow a streaming reply.
    public static let streamingScrollInterval: Double = 0.1

    /// True while new content may scroll the transcript.
    public private(set) var isFollowing: Bool
    /// The newest settled message when following stopped.  Bot messages
    /// after it are the ones the reader has not seen.  `nil` while following,
    /// and also when following stopped on a transcript with nothing settled.
    public private(set) var anchorMessageId: String?

    public init(isFollowing: Bool = true) {
        self.isFollowing = isFollowing
    }

    /// Fold one scroll sample into the follow state.  Returns true when
    /// `isFollowing` changed.
    ///
    /// - Parameter driver: what is moving the transcript, as classified by
    ///   `TranscriptScrollMotion`.  Only a person scrolling away from the
    ///   bottom stops following: a finger dragging toward older messages, or
    ///   the coast of a fling that did.  Content growth, layout changes, the
    ///   app's own scrolls and the spring back after pulling past the bottom
    ///   (all `.system`) never do.
    @discardableResult
    public mutating func observe(
        from previous: TranscriptScrollSample?,
        to current: TranscriptScrollSample,
        driver: TranscriptScrollDriver,
        newestSettledId: String?
    ) -> Bool {
        if isFollowing {
            guard let previous, driver == .finger || driver == .momentum, current.isScrollable else { return false }
            // Moved toward older messages and is actually above the bottom.
            // The second half matters while pulling past the bottom edge:
            // the offset falls back, but nobody left.
            let movedUp = previous.offset - current.offset > Self.leaveDistance
            guard movedUp, current.distanceFromBottom > Self.bottomTolerance else { return false }
            stop(newestSettledId: newestSettledId)
            return true
        }
        // A transcript that fits has no "scrolled up" to protect.
        if !current.isScrollable {
            resume()
            return true
        }
        guard let previous else { return false }
        // Desktop parity: come back only while moving toward the newest
        // message.  An upward move that happens to sit near the bottom must
        // never re-pin the reader.
        let movedDown = current.offset > previous.offset
        if movedDown, current.distanceFromBottom < Self.resumeDistance {
            resume()
            return true
        }
        return false
    }

    /// Whether to scroll back to the newest message without anyone asking.
    ///
    /// Following means staying on the newest message.  The anchors keep it
    /// there as content grows, but some changes still leave it short: the
    /// header's inset arriving after the opening position was set (measured:
    /// 96pt short), a coast that stops just above the bottom, a composer
    /// that grows.  When nobody is scrolling (`.system`) and the bottom is out
    /// of view, put it back.  Never during a finger, a coast, or the app's
    /// own animated scroll.
    public func shouldRepin(at sample: TranscriptScrollSample, driver: TranscriptScrollDriver) -> Bool {
        isFollowing
            && driver == .system
            && sample.isScrollable
            && sample.distanceFromBottom > Self.bottomTolerance
    }

    /// The reader stopped scrolling.  Resting on the bottom itself counts as
    /// being back, however they got there.  Returns true when `isFollowing`
    /// changed.
    @discardableResult
    public mutating func settled(at sample: TranscriptScrollSample) -> Bool {
        guard !isFollowing else { return false }
        guard !sample.isScrollable || sample.distanceFromBottom <= Self.bottomTolerance else { return false }
        resume()
        return true
    }

    /// A drag toward older messages, for systems without scroll phases
    /// (iOS 17).  `towardOlder` is how far the finger moved down since the
    /// last report.  Returns true when `isFollowing` changed.
    @discardableResult
    public mutating func dragged(towardOlder: Double, isScrollable: Bool, newestSettledId: String?) -> Bool {
        guard isFollowing, isScrollable, towardOlder > Self.leaveDistance else { return false }
        stop(newestSettledId: newestSettledId)
        return true
    }

    /// The app moved the reader somewhere other than the bottom: a search hit
    /// or Load Earlier.  Following stops; an anchor already recorded is kept,
    /// so the unseen count does not reset.
    public mutating func leaveBottom(newestSettledId: String?) {
        guard isFollowing else { return }
        stop(newestSettledId: newestSettledId)
    }

    /// Follow again: the reader sent a message, tapped Jump to Latest, came
    /// back to the bottom, or switched threads.
    public mutating func resume() {
        isFollowing = true
        anchorMessageId = nil
    }

    private mutating func stop(newestSettledId: String?) {
        isFollowing = false
        anchorMessageId = newestSettledId
    }

    /// Bot messages that arrived after following stopped: replies, cards
    /// and screens.  Tool activity is context, not something to read, so it
    /// does not count.  Zero while following, and zero when the anchor is no
    /// longer in the transcript (a branch switch or a replaced thread), since
    /// "everything" is not a useful number.
    public func unseenCount(in messages: [Message]) -> Int {
        guard !isFollowing else { return 0 }
        let start: Int
        if let anchorMessageId {
            guard let index = messages.lastIndex(where: { $0.id == anchorMessageId }) else { return 0 }
            start = index + 1
        } else {
            start = 0
        }
        guard start < messages.count else { return 0 }
        return messages[start...].reduce(0) { count, message in
            message.role == .bot && message.kind != .activity ? count + 1 : count
        }
    }

    /// A user line the phone is showing before the server has it: the
    /// optimistic row for an idle send, or a 202 queued chip.  The store
    /// synthesizes these with `id == queueId`; a settled server row that came
    /// from the queue carries the `queueId` but has its own id.
    public static func isPendingSend(_ message: Message) -> Bool {
        guard let queueId = message.queueId else { return false }
        return queueId == message.id
    }

    /// The newest message the server has settled, skipping pending sends.
    public static func newestSettledId(in messages: [Message]) -> String? {
        messages.last(where: { !isPendingSend($0) })?.id
    }

    /// What the transcript follows: changes when a message settles, when a
    /// send is added or retired, and when the live row appears or changes
    /// kind.  A pending send's id changing from the local id to the server's
    /// queue id does not change it, so that swap never scrolls on its own.
    /// It also ignores the queued chip that always sits last, so bot messages
    /// landing above a queued line still count.
    public static func followKey(for messages: [Message], live: LiveRow) -> String {
        let pending = messages.reduce(0) { isPendingSend($1) ? $0 + 1 : $0 }
        return "\(newestSettledId(in: messages) ?? "")|\(pending)|\(live.rawValue)"
    }

    /// What sits after the last settled row while a bot works.
    public enum LiveRow: String, Sendable {
        case none
        case typing
        case reasoning
        case text
    }
}

/// Rate-limits the scroll that follows a streaming reply.  Tokens arrive one
/// frame at a time; scrolling on each one interrupts the last scroll and
/// stutters.  At most one scroll per interval, plus one trailing scroll so
/// the final tokens of a burst are not left below the fold.
public enum StreamingFollowThrottle {
    public enum Action: Equatable, Sendable {
        /// Scroll now.
        case now
        /// Schedule one scroll this many seconds from now.
        case after(Double)
        /// A trailing scroll is already scheduled and will cover this.
        case skip
    }

    public static func decide(
        now: Double,
        lastScroll: Double?,
        trailingScheduled: Bool,
        interval: Double = BottomFollow.streamingScrollInterval
    ) -> Action {
        guard let lastScroll, now - lastScroll < interval else { return .now }
        if trailingScheduled { return .skip }
        return .after(max(0, interval - (now - lastScroll)))
    }
}
