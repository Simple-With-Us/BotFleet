// The SwiftUI half of transcript bottom-follow.  The decisions live in
// CompanionCore's `BottomFollow`; this file only turns scroll-view events into
// samples for it and applies the answer.
//
// Two paths, because the APIs that tell a person's scroll apart from content
// growth are iOS 18 only:
// - iOS 18 and later: `onScrollPhaseChange` says when a finger is behind the
//   movement, `onScrollGeometryChange` gives the distance from the bottom, and
//   the size-change anchor is split from the initial one, so content added
//   below a reader who scrolled up leaves them where they are.
// - iOS 17: a simultaneous drag gesture says when a finger is down, a
//   geometry probe on the content measures the distance from the bottom and
//   decides when the reader has scrolled away, and the single bottom anchor
//   is dropped while the reader is away from the bottom, for the same
//   reason.  This path has not been run on an iOS 17 runtime or device; see
//   docs/verification/ios-companion.md.
import SwiftUI
import CompanionCore
#if DEBUG
import os
#endif

/// Per-frame scroll bookkeeping.  A plain class on purpose: these values
/// change on every scrolled frame, and holding them in `@State` would rebuild
/// the whole transcript each time.
@MainActor
final class TranscriptScrollTracker {
    /// The last sample folded into the follow state.
    var lastSample: TranscriptScrollSample?
    /// What is moving the transcript, from the iOS 18 scroll phase.
    var driver: TranscriptScrollDriver = .system
    /// Tells a fling's coast from the spring back off the bottom edge, and
    /// measures how far the reader's gesture has gone.
    var motion = TranscriptScrollMotion()
    /// iOS 17: a drag is under way.  Mirrored from gesture state, which
    /// also resets when the drag is cancelled.
    var dragActive = false
    /// iOS 17: what is moving the transcript, from the drag and the probe.
    var legacy = LegacyScrollActivity()
    /// iOS 17: the probe's last reading, to tell a scroll from growth.
    var legacyGeometry: LegacyContentGeometry?
    /// The app's own animated scroll (Jump to Latest) runs until this
    /// `systemUptime`.  Follow scrolls wait for it, and on iOS 18 the
    /// `.animating` phase it causes is known to be the app's.
    var appScrollUntil: Double = 0
    /// iOS 18: the animated scroll now running was not started by the app.
    var animationUnasked = false
    /// A scroll back to the newest message is already queued.
    var repinScheduled = false
    /// When the transcript last followed a streaming reply.
    var lastStreamingScroll: Double?
    /// A trailing follow scroll is already scheduled.
    var trailingScrollScheduled = false

    func reset() {
        lastSample = nil
        driver = .system
        motion = TranscriptScrollMotion()
        dragActive = false
        legacy = LegacyScrollActivity()
        legacyGeometry = nil
        appScrollUntil = 0
        animationUnasked = false
        repinScheduled = false
        lastStreamingScroll = nil
        trailingScrollScheduled = false
    }

    static var now: Double { ProcessInfo.processInfo.systemUptime }

    /// A finger, its coast, or an animated scroll is moving the transcript,
    /// so a follow scroll would pull the content out from under the reader
    /// or cut the animation short.  Follow scrolls wait until it ends.
    func holdsFollow(at now: Double) -> Bool {
        switch driver {
        case .finger, .momentum, .animation: return true
        case .system: break
        }
        return legacy.readerActive(at: now, fingerDown: dragActive)
    }

    /// The app is about to glide to the newest message.
    func appScrollStarted(duration: Double) {
        appScrollUntil = Self.now + duration
    }

    /// Queue one scroll back to the newest message, outside the current
    /// layout pass, however many samples ask for it.
    func scheduleRepin(_ repin: @escaping () -> Void) {
        guard !repinScheduled else { return }
        repinScheduled = true
        DispatchQueue.main.async { [weak self] in
            self?.repinScheduled = false
            repin()
        }
    }
}

@available(iOS 18.0, *)
extension TranscriptScrollSample {
    /// `visibleRect` is the whole frame in content coordinates, header area
    /// included, which is what `geometry` expects.  `containerSize` is not:
    /// it leaves out the top inset.
    init(_ geometry: ScrollGeometry) {
        self = .geometry(
            contentOffsetY: geometry.visibleRect.minY,
            contentHeight: geometry.contentSize.height,
            containerHeight: geometry.visibleRect.height,
            insetTop: geometry.contentInsets.top,
            insetBottom: geometry.contentInsets.bottom
        )
    }
}

/// Applied to the transcript `ScrollView`: the anchors, and the iOS 18
/// phase and geometry observers (or the iOS 17 drag observer).
struct TranscriptFollowModifier: ViewModifier {
    @Binding var follow: BottomFollow
    let tracker: TranscriptScrollTracker
    let newestSettledId: String?
    let legacy: Bool
    /// Older messages are being added above.
    let prepending: Bool
    /// Scroll to the newest message, unanimated.
    let repin: () -> Void
    /// iOS 17: a drag is under way.  Gesture state resets on cancel as well
    /// as on end, where `onEnded` alone would leave it stuck on.
    @GestureState private var dragging = false

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *), !legacy {
            modern(content)
        } else {
            legacyBody(content)
        }
    }

    @available(iOS 18.0, *)
    private func modern(_ content: Content) -> some View {
        content
            // Open on the newest message, and rest a short transcript at the
            // bottom, as before.
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.bottom, for: .alignment)
            // Growth keeps the bottom in view only while following.  A reader
            // who scrolled up keeps the top-relative position, so text added
            // below them does not slide what they are reading.
            // Older messages loading above keep the rows on screen where
            // they are only with the bottom anchor, so it holds while they
            // land.
            .defaultScrollAnchor(follow.isFollowing || prepending ? .bottom : .top, for: .sizeChanges)
            .onScrollPhaseChange { oldPhase, phase, context in
                switch phase {
                case .tracking, .interacting: tracker.driver = .finger
                case .decelerating: tracker.driver = .momentum
                case .animating:
                    tracker.driver = .animation
                    if oldPhase != .animating {
                        tracker.animationUnasked = TranscriptScrollTracker.now >= tracker.appScrollUntil
                    }
                default: tracker.driver = .system
                }
                TranscriptScrollLog.note("phase \(oldPhase) -> \(phase)")
                guard phase == .idle else { return }
                let sample = TranscriptScrollSample(context.geometry)
                // A status-bar tap, a VoiceOver page or a keyboard scroll is
                // the reader moving, even with no finger on the transcript.
                let unasked = oldPhase == .animating && tracker.animationUnasked
                tracker.animationUnasked = false
                if oldPhase == .animating { tracker.appScrollUntil = 0 }
                var next = follow
                if next.settled(at: sample) {
                    follow = next
                    TranscriptScrollLog.event("settled on bottom, following", sample)
                } else if unasked, next.unaskedScrollEnded(at: sample, newestSettledId: newestSettledId) {
                    follow = next
                    TranscriptScrollLog.event("scroll the app did not start rested above the bottom, stopped following", sample)
                } else if next.shouldRepin(at: sample, driver: .system) {
                    TranscriptScrollLog.event("settled short of bottom while following, repinning", sample)
                    tracker.scheduleRepin(repin)
                }
            }
            .onScrollGeometryChange(for: TranscriptScrollSample.self) { geometry in
                TranscriptScrollLog.raw(geometry)
                return TranscriptScrollSample(geometry)
            } action: { previous, current in
                let driver = tracker.motion.classify(tracker.driver, from: previous, to: current)
                fold(previous: previous, current: current, driver: driver)
            }
    }

    @ViewBuilder
    private func legacyBody(_ content: Content) -> some View {
        content
            // iOS 17 has one anchor for every role.  Keep it while following
            // (open at the bottom, follow growth); drop it while the reader
            // is away, so growth below them keeps their position.
            .defaultScrollAnchor(follow.isFollowing || prepending ? .bottom : nil)
            // Only says a finger is down.  Whether the reader left the
            // bottom is the probe's call, from how far the transcript
            // actually moved, so a tap or a long press that drifts a few
            // points without scrolling never stops following.
            .simultaneousGesture(
                DragGesture(minimumDistance: 2)
                    .updating($dragging) { _, state, _ in state = true }
                    .onChanged { _ in
                        tracker.dragActive = true
                        tracker.legacy.touched(at: TranscriptScrollTracker.now)
                    }
            )
            .onChange(of: dragging) { _, isDragging in
                tracker.dragActive = isDragging
            }
    }

    private func fold(previous: TranscriptScrollSample, current: TranscriptScrollSample, driver: TranscriptScrollDriver) {
        tracker.lastSample = current
        var next = follow
        if next.observe(
            from: previous,
            to: current,
            driver: driver,
            gestureNewestOffset: tracker.motion.gestureNewestOffset,
            newestSettledId: newestSettledId
        ) {
            follow = next
            TranscriptScrollLog.event(next.isFollowing ? "following" : "stopped following", current)
        }
        if next.shouldRepin(at: current, driver: driver) {
            TranscriptScrollLog.event("layout left the bottom while following, repinning", current)
            tracker.scheduleRepin(repin)
        }
        TranscriptScrollLog.sample(current, following: follow.isFollowing, driver: driver)
    }
}

/// The iOS 17 probe's reading of the content inside the scroll view.
struct LegacyContentGeometry: Equatable {
    var visibleMinY: Double
    var visibleHeight: Double
    var contentHeight: Double

    /// Only the offset changed: a scroll, not growth or a viewport change.
    func scrolledOnly(to next: LegacyContentGeometry) -> Bool {
        abs(next.contentHeight - contentHeight) < 0.5
            && abs(next.visibleHeight - visibleHeight) < 0.5
            && abs(next.visibleMinY - visibleMinY) >= 0.5
    }
}

/// Applied to the transcript's content on iOS 17: measures where the reader
/// is from the content's frame inside the scroll view, so scrolling toward
/// older messages stops following, reaching the bottom again resumes it, and
/// layout that leaves a following reader short of the bottom is put right.
struct LegacyTranscriptProbe: ViewModifier {
    let enabled: Bool
    @Binding var follow: BottomFollow
    let tracker: TranscriptScrollTracker
    let newestSettledId: String?
    /// Scroll to the newest message, unanimated.
    let repin: () -> Void

    func body(content: Content) -> some View {
        if enabled {
            content.onGeometryChange(for: LegacyContentGeometry.self) { proxy in
                // The scroll view's bounds in the content's own coordinates.
                // These are the readable area, below the header inset, so no
                // inset is added back.
                let visible = proxy.bounds(of: .scrollView) ?? CGRect(origin: .zero, size: proxy.size)
                return LegacyContentGeometry(
                    visibleMinY: Double(visible.minY),
                    visibleHeight: Double(visible.height),
                    contentHeight: Double(proxy.size.height)
                )
            } action: { geometry in
                let current = TranscriptScrollSample.geometry(
                    contentOffsetY: geometry.visibleMinY,
                    contentHeight: geometry.contentHeight,
                    containerHeight: geometry.visibleHeight,
                    insetTop: 0,
                    insetBottom: 0
                )
                let scrolledOnly = tracker.legacyGeometry?.scrolledOnly(to: geometry) ?? false
                tracker.legacyGeometry = geometry
                guard current != tracker.lastSample else { return }
                let previous = tracker.lastSample
                tracker.lastSample = current
                // No scroll phases: a finger, the coast it leaves, and the
                // app's own glide come from the drag gesture and the clock.
                let raw = tracker.legacy.driver(
                    at: TranscriptScrollTracker.now,
                    fingerDown: tracker.dragActive,
                    scrolledOnly: scrolledOnly,
                    appScrollUntil: tracker.appScrollUntil
                )
                let driver = tracker.motion.classify(raw, from: previous, to: current)
                var next = follow
                if next.observe(
                    from: previous,
                    to: current,
                    driver: driver,
                    gestureNewestOffset: tracker.motion.gestureNewestOffset,
                    newestSettledId: newestSettledId
                ) {
                    follow = next
                    TranscriptScrollLog.event(next.isFollowing ? "following" : "stopped following", current)
                }
                if next.shouldRepin(at: current, driver: driver) {
                    TranscriptScrollLog.event("layout left the bottom while following, repinning", current)
                    tracker.scheduleRepin(repin)
                }
                TranscriptScrollLog.sample(current, following: follow.isFollowing, driver: driver)
            }
        } else {
            content
        }
    }
}

/// Floats above the composer while the reader is away from the newest
/// message.  The count is new bot messages since they left.
struct JumpToLatestPill: View {
    let count: Int
    let action: () -> Void

    private var accessibilityText: String {
        guard count > 0 else { return "Jump to Latest" }
        return "Jump to Latest, \(count) new \(count == 1 ? "message" : "messages")"
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.down")
                    .font(.system(size: 13, weight: .semibold))
                Text("Jump to Latest")
                    .font(.system(size: 14, weight: .semibold))
                if count > 0 {
                    Text(count > 99 ? "99+" : "\(count)")
                        .font(.system(size: 12, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(Color.white)
                        .padding(.horizontal, 6)
                        .frame(minWidth: 20, minHeight: 20)
                        .background(Capsule().fill(Color.accentColor))
                }
            }
            .foregroundStyle(Color.primary)
            .padding(.leading, 14)
            .padding(.trailing, count > 0 ? 8 : 14)
            .frame(minHeight: 44)
            // Glass alone lets the bubble text behind it read through the
            // label; a nearly solid base keeps the pill legible over prose.
            .background(Capsule().fill(Color(uiColor: .systemBackground).opacity(0.88)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassCapsule()
        .shadow(color: Color.black.opacity(0.12), radius: 8, y: 2)
        .accessibilityLabel(accessibilityText)
        .accessibilityIdentifier("jump-to-latest")
        // The pill sits after the whole transcript in reading order, so a
        // VoiceOver reader would not otherwise hear that replies arrived.
        .onChange(of: count) { old, new in
            guard new > old else { return }
            AccessibilityNotification.Announcement(new == 1 ? "1 new message" : "\(new) new messages").post()
        }
    }
}

/// DEBUG-only trace of follow decisions, for the scripted simulator check
/// (`-scroll-demo`).  Read it with
/// `xcrun simctl spawn booted log show --predicate 'category == "transcript-scroll"'`.
enum TranscriptScrollLog {
#if DEBUG
    static let enabled = ProcessInfo.processInfo.arguments.contains("-scroll-demo")
    private static let logger = Logger(subsystem: "app.botfleet", category: "transcript-scroll")
#endif

    static func event(_ what: String, _ sample: TranscriptScrollSample?) {
#if DEBUG
        guard enabled else { return }
        let detail = sample.map { "offset=\($0.offset) distance=\($0.distanceFromBottom) scrollable=\($0.isScrollable)" } ?? "no sample"
        logger.notice("follow: \(what, privacy: .public) \(detail, privacy: .public)")
#endif
    }

    static func sample(_ sample: TranscriptScrollSample, following: Bool, driver: TranscriptScrollDriver) {
#if DEBUG
        guard enabled else { return }
        logger.debug("sample offset=\(sample.offset) distance=\(sample.distanceFromBottom) following=\(following) driver=\(String(describing: driver), privacy: .public)")
#endif
    }

    @available(iOS 18.0, *)
    static func raw(_ g: ScrollGeometry) {
#if DEBUG
        guard enabled else { return }
        logger.debug("raw offset=\(g.contentOffset.y) size=\(g.contentSize.height) container=\(g.containerSize.height) insets=\(g.contentInsets.top),\(g.contentInsets.bottom) visible=\(g.visibleRect.minY),\(g.visibleRect.maxY) bounds=\(g.bounds.minY),\(g.bounds.maxY)")
#endif
    }

    static func note(_ what: String) {
#if DEBUG
        guard enabled else { return }
        logger.notice("\(what, privacy: .public)")
#endif
    }
}
