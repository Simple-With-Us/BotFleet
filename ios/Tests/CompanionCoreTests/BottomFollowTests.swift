import XCTest
@testable import CompanionCore

final class BottomFollowTests: XCTestCase {
    // MARK: - Fixtures

    private func text(_ id: String, _ role: Message.Role = .bot) -> Message {
        Message(id: id, role: role, kind: .text, at: 1000, text: "line \(id)")
    }

    private func tool(_ id: String) -> Message {
        Message(id: id, role: .bot, kind: .activity, at: 1000, tool: ToolActivity(name: "run_command", ok: true))
    }

    private func card(_ id: String) -> Message {
        Message(id: id, role: .bot, kind: .options, at: 1000)
    }

    /// A reader somewhere in a long transcript.
    private func sample(offset: Double, distance: Double, scrollable: Bool = true) -> TranscriptScrollSample {
        TranscriptScrollSample(offset: offset, distanceFromBottom: distance, isScrollable: scrollable)
    }

    // MARK: - Geometry

    func testGeometryAtTheBottomWithAHeaderInset() {
        // 2000pt of content, an 800pt scroll view, a 120pt header inset on
        // top: the bottom offset is 2000 - 800 = 1200.
        let atBottom = TranscriptScrollSample.geometry(
            contentOffsetY: 1200, contentHeight: 2000, containerHeight: 800, insetTop: 120, insetBottom: 0
        )
        XCTAssertEqual(atBottom.distanceFromBottom, 0)
        XCTAssertTrue(atBottom.isScrollable)

        let atTop = TranscriptScrollSample.geometry(
            contentOffsetY: -120, contentHeight: 2000, containerHeight: 800, insetTop: 120, insetBottom: 0
        )
        XCTAssertEqual(atTop.distanceFromBottom, 1320)
        XCTAssertLessThan(atTop.offset, atBottom.offset)
    }

    func testGeometryCountsTheHeaderInsetWhenDecidingWhetherContentFits() {
        // 700pt of content fits an 800pt container only if the 120pt header
        // is ignored.  It does not fit the 680pt readable area.
        let tall = TranscriptScrollSample.geometry(
            contentOffsetY: -100, contentHeight: 700, containerHeight: 800, insetTop: 120, insetBottom: 0
        )
        XCTAssertTrue(tall.isScrollable)

        let short = TranscriptScrollSample.geometry(
            contentOffsetY: -220, contentHeight: 300, containerHeight: 800, insetTop: 120, insetBottom: 0
        )
        XCTAssertFalse(short.isScrollable)
    }

    func testGeometryFromSwiftUIsVisibleRectUnderTheChatHeader() {
        // Recorded in the simulator after the 118pt header inset arrived:
        // visibleRect 4851.67...5599.33 over 5695.33pt of content, and the
        // screenshot showed the newest bubble cut off by about 96pt.
        let sample = TranscriptScrollSample.geometry(
            contentOffsetY: 4851.67, contentHeight: 5695.33, containerHeight: 5599.33 - 4851.67, insetTop: 118, insetBottom: 0
        )
        XCTAssertEqual(sample.distanceFromBottom, 96, accuracy: 0.5)
    }

    func testGeometryRoundsSubPointNoise() {
        let a = TranscriptScrollSample.geometry(
            contentOffsetY: 1200.1, contentHeight: 2000, containerHeight: 800, insetTop: 0, insetBottom: 0
        )
        let b = TranscriptScrollSample.geometry(
            contentOffsetY: 1199.9, contentHeight: 2000, containerHeight: 800, insetTop: 0, insetBottom: 0
        )
        XCTAssertEqual(a, b)
    }

    // MARK: - Leaving the bottom

    func testContentGrowthNeverStopsFollowing() {
        var follow = BottomFollow()
        // A streamed reply grows below a pinned reader: the distance jumps,
        // the offset does not move toward older content, and no finger is
        // involved.
        let changed = follow.observe(
            from: sample(offset: 1200, distance: 0),
            to: sample(offset: 1200, distance: 140),
            driver: .system,
            newestSettledId: "m9"
        )
        XCTAssertFalse(changed)
        XCTAssertTrue(follow.isFollowing)
    }

    func testAppScrollsAndLayoutShiftsNeverStopFollowing() {
        var follow = BottomFollow()
        // Keyboard hides, the settled bubble is shorter than the live one,
        // or the app's own scroll moves up: none of it is the reader.
        follow.observe(from: sample(offset: 1200, distance: 0), to: sample(offset: 1100, distance: 60), driver: .system, newestSettledId: "m9")
        XCTAssertTrue(follow.isFollowing)
    }

    func testAnUpwardDragStopsFollowingAndRecordsTheAnchor() {
        var follow = BottomFollow()
        let changed = follow.observe(
            from: sample(offset: 1200, distance: 0),
            to: sample(offset: 1180, distance: 20),
            driver: .finger,
            newestSettledId: "m9"
        )
        XCTAssertTrue(changed)
        XCTAssertFalse(follow.isFollowing)
        XCTAssertEqual(follow.anchorMessageId, "m9")
    }

    func testJitterAndTheBounceFromPullingPastTheBottomDoNotStopFollowing() {
        var follow = BottomFollow()
        // One point of jitter.
        follow.observe(from: sample(offset: 1200, distance: 0), to: sample(offset: 1199, distance: 1), driver: .finger, newestSettledId: "m9")
        XCTAssertTrue(follow.isFollowing)
        // Pulled 40pt past the bottom, springing back: the offset falls, but
        // the reader never went above the bottom.
        follow.observe(from: sample(offset: 1240, distance: -40), to: sample(offset: 1220, distance: -20), driver: .finger, newestSettledId: "m9")
        follow.observe(from: sample(offset: 1220, distance: -20), to: sample(offset: 1200, distance: 0), driver: .finger, newestSettledId: "m9")
        XCTAssertTrue(follow.isFollowing)
    }

    func testAFlingTowardOlderStopsFollowingDuringTheCoast() {
        var follow = BottomFollow()
        // A flick so short the finger barely moved; the coast carries it.
        follow.observe(from: sample(offset: 1200, distance: 0), to: sample(offset: 1199, distance: 1), driver: .finger, newestSettledId: "m9")
        XCTAssertTrue(follow.isFollowing)
        follow.observe(from: sample(offset: 1199, distance: 1), to: sample(offset: 1150, distance: 50), driver: .momentum, newestSettledId: "m9")
        XCTAssertFalse(follow.isFollowing)
    }

    func testTheReboundFromPullingPastTheBottomDoesNotStopFollowing() {
        // Recorded in the simulator: pulled 74pt past the bottom, and the
        // release sprang back with enough speed to coast 118pt above it.
        // The scroll phase reports the first spring-back frame late, while
        // it still says the finger is down.
        var follow = BottomFollow()
        var motion = TranscriptScrollMotion()
        let path: [(Double, Double, TranscriptScrollDriver)] = [
            (5060.5, 5.5, .finger), (5068.5, -2.5, .finger), (5143, -77.5, .finger),
            (5117.5, -52, .finger), (5095.5, -29.5, .momentum), (5076, -10.5, .momentum),
            (5059, 6.5, .momentum), (5009.5, 56.5, .momentum), (4950, 115.5, .momentum),
        ]
        var previous: TranscriptScrollSample?
        for (offset, distance, phase) in path {
            let current = sample(offset: offset, distance: distance)
            let driver = motion.classify(phase, from: previous, to: current)
            follow.observe(from: previous, to: current, driver: driver, newestSettledId: "m9")
            previous = current
        }
        XCTAssertTrue(follow.isFollowing)
        // The next deliberate drag toward older still counts.
        let drag = sample(offset: 4940, distance: 125.5)
        follow.observe(from: previous, to: drag, driver: motion.classify(.finger, from: previous, to: drag), newestSettledId: "m9")
        XCTAssertFalse(follow.isFollowing)
    }

    func testMotionReportsAFlingCoastAsMomentumButAReboundAsSystem() {
        var motion = TranscriptScrollMotion()
        XCTAssertEqual(motion.classify(.momentum, from: sample(offset: 1199, distance: 1), to: sample(offset: 1150, distance: 50)), .momentum)
        XCTAssertEqual(motion.classify(.momentum, from: sample(offset: 1250, distance: -50), to: sample(offset: 1230, distance: -30)), .system)
        // Still the rebound once it carries above the bottom...
        XCTAssertEqual(motion.classify(.momentum, from: sample(offset: 1230, distance: -30), to: sample(offset: 1190, distance: 10)), .system)
        // ...until a finger touches down or the scroll rests.
        XCTAssertEqual(motion.classify(.finger, from: sample(offset: 1190, distance: 10), to: sample(offset: 1180, distance: 20)), .finger)
        XCTAssertEqual(motion.classify(.momentum, from: sample(offset: 1180, distance: 20), to: sample(offset: 1150, distance: 50)), .momentum)
    }

    func testDraggingAShortTranscriptDoesNotStopFollowing() {
        var follow = BottomFollow()
        follow.observe(from: sample(offset: 0, distance: 0, scrollable: false), to: sample(offset: -30, distance: 30, scrollable: false), driver: .finger, newestSettledId: "m1")
        XCTAssertTrue(follow.isFollowing)
    }

    /// Feeds a path of (offset, distance, raw driver) through the motion
    /// classifier and the follow state, the way the scroll view glue does.
    private func play(
        _ path: [(Double, Double, TranscriptScrollDriver)],
        into follow: inout BottomFollow,
        motion: inout TranscriptScrollMotion,
        from start: TranscriptScrollSample? = nil
    ) -> TranscriptScrollSample? {
        var previous = start
        for (offset, distance, phase) in path {
            let current = sample(offset: offset, distance: distance)
            let driver = motion.classify(phase, from: previous, to: current)
            follow.observe(from: previous, to: current, driver: driver, gestureNewestOffset: motion.gestureNewestOffset, newestSettledId: "m9")
            previous = current
        }
        return previous
    }

    func testASlowDragTowardOlderStopsFollowing() {
        // About 60pt/s at 60Hz: one point per frame, under the per-frame
        // jitter threshold every time, but it adds up.
        var follow = BottomFollow()
        var motion = TranscriptScrollMotion()
        let path = (1...50).map { step in (1200 - Double(step), Double(step), TranscriptScrollDriver.finger) }
        _ = play(path, into: &follow, motion: &motion, from: sample(offset: 1200, distance: 0))
        XCTAssertFalse(follow.isFollowing)
        XCTAssertEqual(follow.anchorMessageId, "m9")
        // And nothing pulls the reader back when the finger lifts.
        XCTAssertFalse(follow.shouldRepin(at: sample(offset: 1150, distance: 50), driver: .system))
    }

    func testHoldingAFingerAtTheBottomWithJitterKeepsFollowing() {
        var follow = BottomFollow()
        var motion = TranscriptScrollMotion()
        let path: [(Double, Double, TranscriptScrollDriver)] = [
            (1199, 1, .finger), (1200, 0, .finger), (1199.5, 0.5, .finger), (1199, 1, .finger), (1200, 0, .finger),
        ]
        _ = play(path, into: &follow, motion: &motion, from: sample(offset: 1200, distance: 0))
        XCTAssertTrue(follow.isFollowing)
    }

    func testPullingPastTheBottomIsNotTravelTowardOlder() {
        // Pulled 60pt past the bottom, then eased back down slowly to rest
        // on it: the offset fell 60pt during the gesture, but none of it was
        // above the bottom.
        var follow = BottomFollow()
        var motion = TranscriptScrollMotion()
        var path: [(Double, Double, TranscriptScrollDriver)] = (1...60).map { step in (1200 + Double(step), -Double(step), .finger) }
        path += (0..<60).reversed().map { step in (1200 + Double(step), -Double(step), .finger) }
        let end = play(path, into: &follow, motion: &motion, from: sample(offset: 1200, distance: 0))
        XCTAssertTrue(follow.isFollowing)
        // Carrying on past the bottom toward older still counts from the
        // bottom edge.
        let more = (1...5).map { step in (1200 - Double(step), Double(step), TranscriptScrollDriver.finger) }
        _ = play(more, into: &follow, motion: &motion, from: end)
        XCTAssertFalse(follow.isFollowing)
    }

    func testANewTouchMeasuresFromWhereTheTranscriptSat() {
        // The spring back off the bottom edge coasts 80pt above it, and a
        // new touch catches it with a point of drift.  Only the new touch's
        // own travel counts, not the 80pt the rebound carried it.
        var follow = BottomFollow()
        var motion = TranscriptScrollMotion()
        let path: [(Double, Double, TranscriptScrollDriver)] = [
            (1230, -30, .finger), (1260, -60, .finger),
            (1240, -40, .momentum), (1210, -10, .momentum), (1180, 20, .momentum), (1120, 80, .momentum),
            (1119, 81, .finger),
        ]
        _ = play(path, into: &follow, motion: &motion, from: sample(offset: 1200, distance: 0))
        XCTAssertTrue(follow.isFollowing)
    }

    func testTheGestureEndsWhenTheScrollRests() {
        var motion = TranscriptScrollMotion()
        _ = motion.classify(.finger, from: sample(offset: 1200, distance: 0), to: sample(offset: 1199, distance: 1))
        XCTAssertEqual(motion.gestureNewestOffset, 1200)
        _ = motion.classify(.system, from: sample(offset: 1199, distance: 1), to: sample(offset: 1199, distance: 40))
        XCTAssertNil(motion.gestureNewestOffset)
    }

    func testTheFirstSampleCannotStopFollowing() {
        var follow = BottomFollow()
        follow.observe(from: nil, to: sample(offset: 0, distance: 900), driver: .finger, newestSettledId: "m9")
        XCTAssertTrue(follow.isFollowing)
    }

    // MARK: - iOS 17

    func testAnIOS17DragTowardOlderStopsFollowing() {
        var follow = BottomFollow()
        var motion = TranscriptScrollMotion()
        var activity = LegacyScrollActivity()
        activity.touched(at: 10)
        var previous = sample(offset: 1200, distance: 0)
        for (step, now) in [(1.0, 10.01), (2, 10.02), (6, 10.03), (12, 10.04)] {
            let current = sample(offset: 1200 - step, distance: step)
            let raw = activity.driver(at: now, fingerDown: true, scrolledOnly: true, appScrollUntil: 0)
            XCTAssertEqual(raw, .finger)
            let driver = motion.classify(raw, from: previous, to: current)
            follow.observe(from: previous, to: current, driver: driver, gestureNewestOffset: motion.gestureNewestOffset, newestSettledId: "m9")
            previous = current
        }
        XCTAssertFalse(follow.isFollowing)
        XCTAssertEqual(follow.anchorMessageId, "m9")
    }

    func testAnIOS17TouchThatDoesNotScrollNeverStopsFollowing() {
        // A finger resting on the transcript while it streams, drifting a
        // few points as a tap or a long press does: the drag gesture fires,
        // the scroll view does not move, and the only samples are growth.
        var follow = BottomFollow()
        var motion = TranscriptScrollMotion()
        var activity = LegacyScrollActivity()
        activity.touched(at: 10)
        var previous = sample(offset: 1200, distance: 0)
        for (distance, now) in [(40.0, 10.05), (80, 10.10), (120, 10.15)] {
            let current = sample(offset: 1200, distance: distance)
            let raw = activity.driver(at: now, fingerDown: true, scrolledOnly: false, appScrollUntil: 0)
            let driver = motion.classify(raw, from: previous, to: current)
            follow.observe(from: previous, to: current, driver: driver, gestureNewestOffset: motion.gestureNewestOffset, newestSettledId: "m9")
            XCTAssertFalse(follow.shouldRepin(at: current, driver: driver))
            previous = current
        }
        XCTAssertTrue(follow.isFollowing)
    }

    func testAnIOS17DragTheScrollViewTookOverStillStopsFollowing() {
        // The gesture reported one change and then nothing, not even its
        // end, once the scroll view claimed the touch.  The transcript kept
        // scrolling, and that keeps the reader's turn going.
        var follow = BottomFollow()
        var motion = TranscriptScrollMotion()
        var activity = LegacyScrollActivity()
        activity.touched(at: 10)
        var previous = sample(offset: 1200, distance: 0)
        for (step, now) in [(4.0, 10.1), (20, 10.3), (60, 10.5)] {
            let current = sample(offset: 1200 - step, distance: step)
            let raw = activity.driver(at: now, fingerDown: false, scrolledOnly: true, appScrollUntil: 0)
            XCTAssertEqual(raw, .momentum)
            let driver = motion.classify(raw, from: previous, to: current)
            follow.observe(from: previous, to: current, driver: driver, gestureNewestOffset: motion.gestureNewestOffset, newestSettledId: "m9")
            previous = current
        }
        XCTAssertFalse(follow.isFollowing)
    }

    func testAnIOS17ReadersTurnLapsesOnceTheTranscriptHoldsStill() {
        var activity = LegacyScrollActivity()
        activity.touched(at: 10)
        XCTAssertTrue(activity.readerActive(at: 10.2, fingerDown: false))
        // Growth does not keep the turn going...
        XCTAssertEqual(activity.driver(at: 10.2, fingerDown: false, scrolledOnly: false, appScrollUntil: 0), .momentum)
        XCTAssertEqual(activity.driver(at: 10.3, fingerDown: false, scrolledOnly: false, appScrollUntil: 0), .system)
        XCTAssertFalse(activity.readerActive(at: 10.3, fingerDown: false))
        // ...and a gesture state stuck on after a cancel is not consulted
        // here: only the live gesture state is.
        XCTAssertTrue(activity.readerActive(at: 99, fingerDown: true))
    }

    func testAnIOS17AppAnimationIsNotTheReaderButAFingerIs() {
        var activity = LegacyScrollActivity()
        XCTAssertEqual(activity.driver(at: 10, fingerDown: false, scrolledOnly: true, appScrollUntil: 10.4), .animation)
        XCTAssertEqual(activity.driver(at: 10.1, fingerDown: true, scrolledOnly: true, appScrollUntil: 10.4), .finger)
        XCTAssertEqual(activity.driver(at: 10.5, fingerDown: false, scrolledOnly: false, appScrollUntil: 10.4), .system)
    }

    // MARK: - Coming back

    func testMovingDownWithinTheThresholdResumes() {
        var follow = BottomFollow()
        follow.leaveBottom(newestSettledId: "m9")
        let changed = follow.observe(from: sample(offset: 1100, distance: 100), to: sample(offset: 1160, distance: 40), driver: .finger, newestSettledId: "m9")
        XCTAssertTrue(changed)
        XCTAssertTrue(follow.isFollowing)
        XCTAssertNil(follow.anchorMessageId)
    }

    func testMovingUpInsideTheThresholdDoesNotResume() {
        var follow = BottomFollow()
        follow.leaveBottom(newestSettledId: "m9")
        follow.observe(from: sample(offset: 1190, distance: 10), to: sample(offset: 1170, distance: 30), driver: .finger, newestSettledId: "m9")
        XCTAssertFalse(follow.isFollowing)
    }

    func testMovingDownButStillFarAwayDoesNotResume() {
        var follow = BottomFollow()
        follow.leaveBottom(newestSettledId: "m9")
        follow.observe(from: sample(offset: 100, distance: 1100), to: sample(offset: 400, distance: 800), driver: .finger, newestSettledId: "m9")
        XCTAssertFalse(follow.isFollowing)
    }

    func testGrowthBelowAScrolledUpReaderDoesNotResume() {
        var follow = BottomFollow()
        follow.leaveBottom(newestSettledId: "m9")
        follow.observe(from: sample(offset: 400, distance: 30), to: sample(offset: 400, distance: 170), driver: .system, newestSettledId: "m9")
        XCTAssertFalse(follow.isFollowing)
    }

    func testContentThatFitsResumes() {
        var follow = BottomFollow()
        follow.leaveBottom(newestSettledId: "m9")
        XCTAssertTrue(follow.observe(from: nil, to: sample(offset: 0, distance: 0, scrollable: false), driver: .system, newestSettledId: "m9"))
        XCTAssertTrue(follow.isFollowing)
    }

    func testSettlingOnTheBottomResumesButSettlingNearItDoesNot() {
        var follow = BottomFollow()
        follow.leaveBottom(newestSettledId: "m9")
        XCTAssertFalse(follow.settled(at: sample(offset: 1180, distance: 20)))
        XCTAssertFalse(follow.isFollowing)
        XCTAssertTrue(follow.settled(at: sample(offset: 1200, distance: 0)))
        XCTAssertTrue(follow.isFollowing)
    }

    func testResumeClearsTheAnchor() {
        var follow = BottomFollow()
        follow.leaveBottom(newestSettledId: "m9")
        follow.resume()
        XCTAssertTrue(follow.isFollowing)
        XCTAssertNil(follow.anchorMessageId)
    }

    func testLeavingTwiceKeepsTheFirstAnchor() {
        var follow = BottomFollow()
        follow.leaveBottom(newestSettledId: "m9")
        // A search jump after the reader had already scrolled up must not
        // reset how many messages they have missed.
        follow.leaveBottom(newestSettledId: "m12")
        XCTAssertEqual(follow.anchorMessageId, "m9")
    }

    // MARK: - Repinning

    func testRepinsWhenLayoutLeavesAFollowingReaderShortOfTheBottom() {
        let follow = BottomFollow()
        XCTAssertTrue(follow.shouldRepin(at: sample(offset: 4851.5, distance: 96), driver: .system))
        XCTAssertFalse(follow.shouldRepin(at: sample(offset: 4947.5, distance: 0), driver: .system))
        XCTAssertFalse(follow.shouldRepin(at: sample(offset: 4947.5, distance: 1), driver: .system))
    }

    func testNeverRepinsAgainstTheReaderOrTheAppsOwnAnimation() {
        let follow = BottomFollow()
        let short = sample(offset: 4851.5, distance: 96)
        XCTAssertFalse(follow.shouldRepin(at: short, driver: .finger))
        XCTAssertFalse(follow.shouldRepin(at: short, driver: .momentum))
        XCTAssertFalse(follow.shouldRepin(at: short, driver: .animation))
    }

    func testNeverRepinsAReaderWhoLeftOrATranscriptThatFits() {
        var follow = BottomFollow()
        XCTAssertFalse(follow.shouldRepin(at: sample(offset: 0, distance: 20, scrollable: false), driver: .system))
        follow.leaveBottom(newestSettledId: "m9")
        XCTAssertFalse(follow.shouldRepin(at: sample(offset: 4851.5, distance: 96), driver: .system))
    }

    func testTheAppsAnimatedScrollNeverStopsFollowing() {
        var follow = BottomFollow()
        follow.observe(from: sample(offset: 1200, distance: 0), to: sample(offset: 900, distance: 300), driver: .animation, newestSettledId: "m9")
        XCTAssertTrue(follow.isFollowing)
    }

    func testAnUnaskedScrollThatRestsAboveTheBottomStopsFollowing() {
        // A status-bar tap or a VoiceOver page took a following reader up
        // the thread: they stay there, with the pill, instead of being
        // pulled back.
        var follow = BottomFollow()
        XCTAssertTrue(follow.unaskedScrollEnded(at: sample(offset: -118, distance: 5000), newestSettledId: "m9"))
        XCTAssertFalse(follow.isFollowing)
        XCTAssertEqual(follow.anchorMessageId, "m9")
        XCTAssertFalse(follow.shouldRepin(at: sample(offset: -118, distance: 5000), driver: .system))
    }

    func testAnUnaskedScrollThatRestsOnTheBottomKeepsFollowing() {
        var follow = BottomFollow()
        XCTAssertFalse(follow.unaskedScrollEnded(at: sample(offset: 1200, distance: 1), newestSettledId: "m9"))
        XCTAssertFalse(follow.unaskedScrollEnded(at: sample(offset: 0, distance: 30, scrollable: false), newestSettledId: "m9"))
        XCTAssertTrue(follow.isFollowing)
        // Already away: the first anchor stays.
        follow.leaveBottom(newestSettledId: "m3")
        XCTAssertFalse(follow.unaskedScrollEnded(at: sample(offset: 100, distance: 1100), newestSettledId: "m9"))
        XCTAssertEqual(follow.anchorMessageId, "m3")
    }

    // MARK: - Unseen count

    func testUnseenCountIsZeroWhileFollowing() {
        let follow = BottomFollow()
        XCTAssertEqual(follow.unseenCount(in: [text("m1"), text("m2")]), 0)
    }

    func testUnseenCountCountsBotRepliesCardsAndNotToolStepsOrUserLines() {
        var follow = BottomFollow()
        follow.leaveBottom(newestSettledId: "m2")
        let messages = [
            text("m1", .user), text("m2"),
            tool("t1"), tool("t2"), tool("t3"), tool("t4"), tool("t5"),
            text("m3"), card("c1"), text("m4", .user), text("m5"),
        ]
        XCTAssertEqual(follow.unseenCount(in: messages), 3)
    }

    func testUnseenCountIsZeroWhenTheAnchorIsGone() {
        var follow = BottomFollow()
        follow.leaveBottom(newestSettledId: "replaced")
        XCTAssertEqual(follow.unseenCount(in: [text("m1"), text("m2")]), 0)
    }

    func testUnseenCountWithNoAnchorCountsEveryBotMessage() {
        var follow = BottomFollow()
        follow.leaveBottom(newestSettledId: nil)
        XCTAssertEqual(follow.unseenCount(in: [text("m1"), text("u1", .user), text("m2")]), 2)
    }

    func testOlderPagesLoadedAboveTheAnchorDoNotCount() {
        var follow = BottomFollow()
        follow.leaveBottom(newestSettledId: "m2")
        let messages = [text("old1"), text("old2"), text("m1"), text("m2"), text("m3")]
        XCTAssertEqual(follow.unseenCount(in: messages), 1)
    }

    // MARK: - Follow key and pending sends

    func testPendingSendPromotionDoesNotChangeTheFollowKey() {
        var state = CompanionState()
        let thread = "thread-1"
        state.messages[thread] = [text("u1", .user), text("b1")]
        state.rememberPendingSend(threadId: thread, id: "local-1", text: "hello", queued: false)
        let before = BottomFollow.followKey(for: state.visibleTranscript(forThread: thread), live: .typing)
        XCTAssertTrue(state.visibleTranscript(forThread: thread).last.map(BottomFollow.isPendingSend) == true)

        state.promotePendingSend(threadId: thread, from: "local-1", to: "q-202")
        XCTAssertEqual(state.visibleTranscript(forThread: thread).last?.id, "q-202")
        let after = BottomFollow.followKey(for: state.visibleTranscript(forThread: thread), live: .typing)
        XCTAssertEqual(before, after)
    }

    func testASendAndASettledReplyChangeTheFollowKey() {
        var state = CompanionState()
        let thread = "thread-1"
        state.messages[thread] = [text("u1", .user), text("b1")]
        let idle = BottomFollow.followKey(for: state.visibleTranscript(forThread: thread), live: .none)
        state.rememberPendingSend(threadId: thread, id: "local-1", text: "hello", queued: false)
        let sent = BottomFollow.followKey(for: state.visibleTranscript(forThread: thread), live: .none)
        XCTAssertNotEqual(idle, sent)
        state.messages[thread]?.append(text("b2"))
        let replied = BottomFollow.followKey(for: state.visibleTranscript(forThread: thread), live: .none)
        XCTAssertNotEqual(sent, replied)
    }

    func testBotMessagesAboveAQueuedChipStillChangeTheFollowKey() {
        var state = CompanionState()
        let thread = "thread-1"
        state.messages[thread] = [text("u1", .user), text("b1")]
        state.rememberPendingQueued(threadId: thread, queueId: "q-1", text: "later")
        let before = BottomFollow.followKey(for: state.visibleTranscript(forThread: thread), live: .text)
        state.messages[thread]?.append(text("b2"))
        // The chip is still last in the visible transcript...
        XCTAssertEqual(state.visibleTranscript(forThread: thread).last?.id, "q-1")
        // ...but the reply that landed above it is followed.
        XCTAssertNotEqual(before, BottomFollow.followKey(for: state.visibleTranscript(forThread: thread), live: .text))
        XCTAssertEqual(BottomFollow.newestSettledId(in: state.visibleTranscript(forThread: thread)), "b2")
    }

    func testTheLiveRowChangesTheFollowKey() {
        let messages = [text("u1", .user)]
        XCTAssertNotEqual(
            BottomFollow.followKey(for: messages, live: .typing),
            BottomFollow.followKey(for: messages, live: .text)
        )
    }

    func testASettledRowFromTheQueueIsNotPending() {
        var drained = text("server-id", .user)
        drained.queueId = "q-1"
        XCTAssertFalse(BottomFollow.isPendingSend(drained))
        var chip = text("q-1", .user)
        chip.queueId = "q-1"
        XCTAssertTrue(BottomFollow.isPendingSend(chip))
    }

    // MARK: - Streaming throttle

    func testTheFirstTokenScrollsAtOnce() {
        XCTAssertEqual(StreamingFollowThrottle.decide(now: 10, lastScroll: nil, trailingScheduled: false), .now)
        XCTAssertEqual(StreamingFollowThrottle.decide(now: 10.2, lastScroll: 10, trailingScheduled: false), .now)
    }

    func testTokensInsideTheIntervalScheduleOneTrailingScroll() {
        guard case let .after(delay) = StreamingFollowThrottle.decide(now: 10.03, lastScroll: 10, trailingScheduled: false) else {
            return XCTFail("expected a trailing scroll")
        }
        XCTAssertEqual(delay, 0.07, accuracy: 0.0001)
        XCTAssertEqual(StreamingFollowThrottle.decide(now: 10.05, lastScroll: 10, trailingScheduled: true), .skip)
    }

    func testTheAppsAnimationHoldsTheStreamingScrollUntilItEnds() {
        // Jump to Latest glides until 10.45.  A token at 10.1 must not cut it
        // short with an unanimated jump, but is still followed afterwards.
        guard case let .after(delay) = StreamingFollowThrottle.decide(now: 10.1, lastScroll: nil, trailingScheduled: false, notBefore: 10.45) else {
            return XCTFail("expected a held scroll")
        }
        XCTAssertEqual(delay, 0.35, accuracy: 0.0001)
        XCTAssertEqual(StreamingFollowThrottle.decide(now: 10.2, lastScroll: nil, trailingScheduled: true, notBefore: 10.45), .skip)
        XCTAssertEqual(StreamingFollowThrottle.decide(now: 10.5, lastScroll: 9, trailingScheduled: false, notBefore: 10.45), .now)
    }

    func testATokenBurstScrollsAtMostTenTimesASecond() {
        // 120 tokens over 1.2 seconds, one every 10ms.
        var lastScroll: Double?
        var trailingAt: Double?
        var scrolls: [Double] = []
        for step in 0..<120 {
            let now = Double(step) * 0.01
            if let due = trailingAt, due <= now {
                scrolls.append(due)
                lastScroll = due
                trailingAt = nil
            }
            switch StreamingFollowThrottle.decide(now: now, lastScroll: lastScroll, trailingScheduled: trailingAt != nil) {
            case .now:
                scrolls.append(now)
                lastScroll = now
            case let .after(delay):
                trailingAt = now + delay
            case .skip:
                break
            }
        }
        if let due = trailingAt { scrolls.append(due) }
        XCTAssertLessThanOrEqual(scrolls.count, 13)
        for (a, b) in zip(scrolls, scrolls.dropFirst()) {
            XCTAssertGreaterThanOrEqual(b - a, 0.1 - 0.0001)
        }
        // The burst's final tokens are still followed.
        XCTAssertGreaterThanOrEqual(scrolls.last ?? 0, 1.19 - 0.1)
    }
}
