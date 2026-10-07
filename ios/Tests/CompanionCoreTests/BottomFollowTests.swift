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
            userDriven: false,
            newestSettledId: "m9"
        )
        XCTAssertFalse(changed)
        XCTAssertTrue(follow.isFollowing)
    }

    func testAppScrollsAndLayoutShiftsNeverStopFollowing() {
        var follow = BottomFollow()
        // Keyboard hides, the settled bubble is shorter than the live one,
        // or the app's own scroll moves up: none of it is the reader.
        follow.observe(from: sample(offset: 1200, distance: 0), to: sample(offset: 1100, distance: 60), userDriven: false, newestSettledId: "m9")
        XCTAssertTrue(follow.isFollowing)
    }

    func testAnUpwardDragStopsFollowingAndRecordsTheAnchor() {
        var follow = BottomFollow()
        let changed = follow.observe(
            from: sample(offset: 1200, distance: 0),
            to: sample(offset: 1180, distance: 20),
            userDriven: true,
            newestSettledId: "m9"
        )
        XCTAssertTrue(changed)
        XCTAssertFalse(follow.isFollowing)
        XCTAssertEqual(follow.anchorMessageId, "m9")
    }

    func testJitterAndTheBounceFromPullingPastTheBottomDoNotStopFollowing() {
        var follow = BottomFollow()
        // One point of jitter.
        follow.observe(from: sample(offset: 1200, distance: 0), to: sample(offset: 1199, distance: 1), userDriven: true, newestSettledId: "m9")
        XCTAssertTrue(follow.isFollowing)
        // Pulled 40pt past the bottom, springing back: the offset falls, but
        // the reader never went above the bottom.
        follow.observe(from: sample(offset: 1240, distance: -40), to: sample(offset: 1220, distance: -20), userDriven: true, newestSettledId: "m9")
        follow.observe(from: sample(offset: 1220, distance: -20), to: sample(offset: 1200, distance: 0), userDriven: true, newestSettledId: "m9")
        XCTAssertTrue(follow.isFollowing)
    }

    func testDraggingAShortTranscriptDoesNotStopFollowing() {
        var follow = BottomFollow()
        follow.observe(from: sample(offset: 0, distance: 0, scrollable: false), to: sample(offset: -30, distance: 30, scrollable: false), userDriven: true, newestSettledId: "m1")
        XCTAssertTrue(follow.isFollowing)
        XCTAssertFalse(follow.dragged(towardOlder: 30, isScrollable: false, newestSettledId: "m1"))
        XCTAssertTrue(follow.isFollowing)
    }

    func testTheFirstSampleCannotStopFollowing() {
        var follow = BottomFollow()
        follow.observe(from: nil, to: sample(offset: 0, distance: 900), userDriven: true, newestSettledId: "m9")
        XCTAssertTrue(follow.isFollowing)
    }

    func testAnIOS17DragTowardOlderStopsFollowing() {
        var follow = BottomFollow()
        XCTAssertFalse(follow.dragged(towardOlder: 1, isScrollable: true, newestSettledId: "m9"))
        XCTAssertTrue(follow.isFollowing)
        XCTAssertTrue(follow.dragged(towardOlder: 12, isScrollable: true, newestSettledId: "m9"))
        XCTAssertFalse(follow.isFollowing)
        XCTAssertEqual(follow.anchorMessageId, "m9")
    }

    // MARK: - Coming back

    func testMovingDownWithinTheThresholdResumes() {
        var follow = BottomFollow()
        follow.leaveBottom(newestSettledId: "m9")
        let changed = follow.observe(from: sample(offset: 1100, distance: 100), to: sample(offset: 1160, distance: 40), userDriven: true, newestSettledId: "m9")
        XCTAssertTrue(changed)
        XCTAssertTrue(follow.isFollowing)
        XCTAssertNil(follow.anchorMessageId)
    }

    func testMovingUpInsideTheThresholdDoesNotResume() {
        var follow = BottomFollow()
        follow.leaveBottom(newestSettledId: "m9")
        follow.observe(from: sample(offset: 1190, distance: 10), to: sample(offset: 1170, distance: 30), userDriven: true, newestSettledId: "m9")
        XCTAssertFalse(follow.isFollowing)
    }

    func testMovingDownButStillFarAwayDoesNotResume() {
        var follow = BottomFollow()
        follow.leaveBottom(newestSettledId: "m9")
        follow.observe(from: sample(offset: 100, distance: 1100), to: sample(offset: 400, distance: 800), userDriven: true, newestSettledId: "m9")
        XCTAssertFalse(follow.isFollowing)
    }

    func testGrowthBelowAScrolledUpReaderDoesNotResume() {
        var follow = BottomFollow()
        follow.leaveBottom(newestSettledId: "m9")
        follow.observe(from: sample(offset: 400, distance: 30), to: sample(offset: 400, distance: 170), userDriven: false, newestSettledId: "m9")
        XCTAssertFalse(follow.isFollowing)
    }

    func testContentThatFitsResumes() {
        var follow = BottomFollow()
        follow.leaveBottom(newestSettledId: "m9")
        XCTAssertTrue(follow.observe(from: nil, to: sample(offset: 0, distance: 0, scrollable: false), userDriven: false, newestSettledId: "m9"))
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
