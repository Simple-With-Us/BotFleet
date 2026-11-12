import XCTest
@testable import CompanionCore

final class LiveActivityLifecycleTests: XCTestCase {
    func testBackgroundEndsAmbientActivitiesAndRejectsOldForegroundWork() {
        var lifecycle = LiveActivityLifecycle()
        XCTAssertFalse(lifecycle.updatesEnabled)

        XCTAssertEqual(lifecycle.transition(to: .active), .resetAndAwaitFreshState)
        let foregroundGeneration = lifecycle.generation
        XCTAssertFalse(lifecycle.permitsUpdates(from: foregroundGeneration))
        XCTAssertTrue(lifecycle.acceptFreshState(for: foregroundGeneration))
        XCTAssertTrue(lifecycle.permitsUpdates(from: foregroundGeneration))

        XCTAssertNil(lifecycle.transition(to: .inactive))
        XCTAssertTrue(lifecycle.permitsUpdates(from: foregroundGeneration))

        XCTAssertEqual(lifecycle.transition(to: .background), .endAmbient)
        XCTAssertFalse(lifecycle.permitsUpdates(from: foregroundGeneration))
        XCTAssertFalse(lifecycle.acceptFreshState(for: foregroundGeneration))
        XCTAssertNil(lifecycle.transition(to: .background), "repeat notifications must not enqueue duplicate teardown")
    }

    /// Backgrounding must never be a blanket teardown: that is what makes an
    /// approval unanswerable from the Lock Screen.
    func testBackgroundNeverEndsEverythingTheWaySignOutDoes() {
        var lifecycle = LiveActivityLifecycle()
        XCTAssertEqual(lifecycle.transition(to: .active), .resetAndAwaitFreshState)
        XCTAssertEqual(lifecycle.transition(to: .background), .endAmbient)
        XCTAssertNotEqual(LiveActivityLifecycleAction.endAmbient, .endAll)

        // A fresh lifecycle that never had a pairing still tears everything
        // down on the way out, which is the sign-out path.
        var signingOut = LiveActivityLifecycle()
        XCTAssertEqual(signingOut.transition(to: .active), .resetAndAwaitFreshState)
        XCTAssertEqual(signingOut.pairingChanged(isPaired: false), .endAll)
    }

    func testForegroundReturnAcceptsOnlyItsOwnFreshSnapshot() {
        var lifecycle = LiveActivityLifecycle()
        XCTAssertEqual(lifecycle.transition(to: .active), .resetAndAwaitFreshState)
        let staleResumeGeneration = lifecycle.generation
        XCTAssertEqual(lifecycle.transition(to: .background), .endAmbient)

        XCTAssertNil(lifecycle.transition(to: .inactive))
        XCTAssertEqual(lifecycle.transition(to: .active), .awaitFreshState)
        let currentResumeGeneration = lifecycle.generation
        XCTAssertFalse(lifecycle.permitsUpdates(from: lifecycle.generation))
        XCTAssertFalse(lifecycle.acceptFreshState(for: staleResumeGeneration))
        XCTAssertTrue(lifecycle.acceptFreshState(for: currentResumeGeneration))
        XCTAssertTrue(lifecycle.permitsUpdates(from: currentResumeGeneration))
        XCTAssertFalse(lifecycle.permitsUpdates(from: staleResumeGeneration))
    }

    func testInactiveOnlyInterruptionRetainsCurrentUpdatePolicy() {
        var lifecycle = LiveActivityLifecycle()
        XCTAssertEqual(lifecycle.transition(to: .active), .resetAndAwaitFreshState)
        let foregroundGeneration = lifecycle.generation

        XCTAssertNil(lifecycle.transition(to: .inactive))
        XCTAssertTrue(lifecycle.acceptFreshState(for: foregroundGeneration))
        XCTAssertNil(lifecycle.transition(to: .active))
        XCTAssertEqual(lifecycle.generation, foregroundGeneration)
        XCTAssertTrue(lifecycle.permitsUpdates(from: foregroundGeneration))
    }

    func testForegroundRepairingResetsActivitiesAndRestartsFreshHydration() {
        var lifecycle = LiveActivityLifecycle()
        XCTAssertEqual(lifecycle.transition(to: .active), .resetAndAwaitFreshState)
        let oldPairingGeneration = lifecycle.generation
        XCTAssertTrue(lifecycle.acceptFreshState(for: oldPairingGeneration))

        XCTAssertEqual(lifecycle.pairingChanged(isPaired: false), .endAll)
        XCTAssertFalse(lifecycle.permitsUpdates(from: oldPairingGeneration))
        XCTAssertEqual(lifecycle.pairingChanged(isPaired: true), .resetAndAwaitFreshState)
        let newPairingGeneration = lifecycle.generation
        XCTAssertFalse(lifecycle.acceptFreshState(for: oldPairingGeneration))
        XCTAssertTrue(lifecycle.acceptFreshState(for: newPairingGeneration))
        XCTAssertTrue(lifecycle.permitsUpdates(from: newPairingGeneration))
    }

    func testSnapshotRevisionConflictsUseBoundedExponentialBackoff() {
        var backoff = LiveActivityRefreshBackoff(
            initialNanoseconds: 1,
            maximumNanoseconds: 15
        )

        XCTAssertEqual(
            (0..<7).map { _ in backoff.takeNextDelay() },
            [1, 2, 4, 8, 15, 15, 15]
        )
    }
}

/// The rule that decides what stays on the Lock Screen once the app is gone.
final class LiveActivityRetentionTests: XCTestCase {
    func testAnUnansweredAskWithRealChoicesSurvivesBackground() {
        XCTAssertTrue(
            LiveActivityRetention.shouldRetain(
                kind: "needsYou", requestId: "req-1", options: ["Allow", "Deny"]
            )
        )
    }

    /// Ambient work cannot be kept honest by a stream that is not running, and
    /// an unread thread dismisses itself as soon as it is read.
    func testWorkingAndUnreadActivitiesAreNotRetained() {
        XCTAssertFalse(
            LiveActivityRetention.shouldRetain(
                kind: "working", requestId: "req-1", options: ["Allow", "Deny"]
            ),
            "a working bot's face is stale the moment the stream stops"
        )
        XCTAssertFalse(
            LiveActivityRetention.shouldRetain(kind: "toReview", requestId: nil, options: [])
        )
    }

    /// Retaining a card with nothing to tap strands it on the Lock Screen
    /// forever, and a `needsYou` with no request behind it is exactly that.
    func testACardWithNoRequestOrNoChoicesIsNotRetained() {
        XCTAssertFalse(
            LiveActivityRetention.shouldRetain(kind: "needsYou", requestId: nil, options: ["Allow"])
        )
        XCTAssertFalse(
            LiveActivityRetention.shouldRetain(kind: "needsYou", requestId: "", options: ["Allow"])
        )
        XCTAssertFalse(
            LiveActivityRetention.shouldRetain(kind: "needsYou", requestId: "req-1", options: []),
            "answered cards clear their request id; one with no choices cannot be approved from the island"
        )
    }

    /// The answer clears `requestId` on the next sync, which is what lets an
    /// answered card retire on its own without a separate expiry rule.
    func testAnAnsweredCardIsNoLongerRetained() {
        XCTAssertFalse(
            LiveActivityRetention.shouldRetain(kind: "needsYou", requestId: nil, options: [])
        )
    }
}
