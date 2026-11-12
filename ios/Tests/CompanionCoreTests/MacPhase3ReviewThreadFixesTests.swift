import XCTest
@testable import CompanionCore

/// The Phase 3 review threads that landed on PR #1360.
///
/// Each test here is the regression guard for one review finding, so the
/// behavior the finding describes can never quietly go back.
final class MacPhase3ReviewThreadFixesTests: XCTestCase {

    // MARK: - Notify kinds

    /// A takeover frame asks for the person's hands, so it has to reach them.
    ///
    /// The harness's notify kinds are `approval`, `question`, `done`,
    /// `routine-failed` and `takeover`:  there is no `call` or `mention`
    /// kind on the wire.  `takeover` is the third person-blocking kind, and
    /// folding it into the normal-completion bucket meant a bot asking for
    /// the person's hands never showed a banner at all.
    func testTakeoverNotifyFramesReachThePersonAsAnOrdinaryBanner() {
        let takeover = NotificationFrame(
            kind: "takeover",
            botId: "b1",
            botName: "Monet",
            threadId: "t1",
            title: "Monet needs your hands",
            body: "asked you to take over"
        )
        let event = MacCandidateNotificationEvent(notificationFrame: takeover)
        XCTAssertEqual(
            event,
            .callOrMentionNeedsPerson(
                botId: "b1",
                botName: "Monet",
                threadId: "t1",
                message: "asked you to take over"
            )
        )
        XCTAssertTrue(event.requiresPersonAttention)

        // The two quiet kinds stay quiet.
        let done = NotificationFrame(
            kind: "done",
            botId: "b1",
            botName: "Monet",
            threadId: "t1",
            title: "Monet finished",
            body: "All done"
        )
        XCTAssertFalse(MacCandidateNotificationEvent(notificationFrame: done).requiresPersonAttention)
        let routineFailure = NotificationFrame(
            kind: "routine-failed",
            botId: "b1",
            botName: "Monet",
            threadId: "t1",
            title: "Monet's routine failed",
            body: "step 3 failed"
        )
        XCTAssertFalse(MacCandidateNotificationEvent(notificationFrame: routineFailure).requiresPersonAttention)

        // The banner is an ordinary one, the way the paired phone delivers a
        // takeover:  it asks for hands, not for an answer.
        let coordinator = MacNotificationCoordinator(initialPermission: .authorized)
        let decision = coordinator.handleEvent(event)
        guard case .deliver(let payload) = decision else {
            return XCTFail("Expected the takeover notification to be delivered")
        }
        XCTAssertEqual(payload.interruptionLevel, .active)
        XCTAssertEqual(payload.actionTitles, ["Open"])
        XCTAssertEqual(payload.threadId, "t1")
    }

    // MARK: - Composer dictation

    /// The composer is live while dictation runs, and the stop never
    /// overwrites what the user has.
    func testComposerDictationMirrorsPartialsAndStopKeepsTheUsersEdits() {
        let engine = MacVoiceEngine()
        let attempt = engine.beginStart(mode: .composerDictation, currentDraft: "Hello")
        engine.completeStartPermissionGrant(attemptId: attempt, micGranted: true, speechGranted: true)
        engine.receivePartialTranscript("world", audioLevel: 0.5)

        // The live draft is what the composer shows:  the text typed before
        // the microphone went on, then the latest partial.
        XCTAssertEqual(engine.liveComposerDraft, "Hello world")

        engine.receivePartialTranscript("world how are you", audioLevel: 0.5)
        XCTAssertEqual(engine.liveComposerDraft, "Hello world how are you")

        // The user keeps typing after the last partial.
        let liveText = "Hello world how are you and a typed edit"
        XCTAssertEqual(
            engine.tapMicrophoneButtonReportingOutcome(
                mode: .composerDictation,
                currentDraft: liveText
            ),
            .stoppedCapture
        )
        XCTAssertEqual(engine.state, .idle)

        // The stop never writes the engine's rebased draft over the text the
        // user actually has.
        XCTAssertEqual(engine.composerDraftAfterTap(incomingDraft: liveText), liveText)

        // Nothing is live once the capture stopped.
        XCTAssertNil(engine.liveComposerDraft)
    }

    /// A recognizer that fails or finishes ends the capture on its own, so
    /// the engine has to leave the recording state by itself.
    func testACaptureThatEndsOnItsOwnLeavesTheRecordingState() {
        let engine = MacVoiceEngine()
        let attempt = engine.beginStart(mode: .composerDictation, currentDraft: "Keep this text")
        engine.completeStartPermissionGrant(attemptId: attempt, micGranted: true, speechGranted: true)
        engine.receivePartialTranscript("discarded partial", audioLevel: 0.5)
        XCTAssertTrue(engine.isMicrophoneHardwareOpen)

        engine.handleCaptureEnded(.recognitionFailed)
        XCTAssertEqual(engine.state, .failed(.recognitionFailedMidSession))
        XCTAssertFalse(engine.isMicrophoneHardwareOpen)
        // The failure restores the draft the user had before dictating.
        XCTAssertEqual(engine.currentDraft, "Keep this text")

        // A completed capture keeps its transcript and returns to idle.
        let completed = MacVoiceEngine()
        let completedAttempt = completed.beginStart(mode: .composerDictation, currentDraft: "Hello")
        completed.completeStartPermissionGrant(
            attemptId: completedAttempt,
            micGranted: true,
            speechGranted: true
        )
        completed.receivePartialTranscript("world", audioLevel: 0.5)
        completed.handleCaptureEnded(.completed)
        XCTAssertEqual(completed.state, .idle)
        XCTAssertFalse(completed.isMicrophoneHardwareOpen)
        XCTAssertEqual(completed.currentDraft, "Hello world")
    }

    // MARK: - System surface throttle

    /// A deferred rebuild advances the throttle, so the next frame does not
    /// schedule another rebuild straight away.
    func testTheSurfaceSyncThrottleAdvancesOnADeferredRebuild() {
        let start = Date(timeIntervalSince1970: 1_000)
        var throttle = MacSystemSurfaceSyncThrottle()

        // Nothing has been rebuilt yet, so the first request runs now.
        XCTAssertEqual(throttle.action(for: start, force: false), .syncNow)
        throttle.recordSync(at: start)

        // Inside the throttle window the request is deferred.
        XCTAssertEqual(
            throttle.action(for: start.addingTimeInterval(0.1), force: false),
            .scheduleDeferred
        )

        // The deferred rebuild advances the throttle as well, so the next
        // frame does not schedule another rebuild straight away.
        throttle.recordSync(at: start.addingTimeInterval(0.2))
        XCTAssertEqual(
            throttle.action(for: start.addingTimeInterval(0.25), force: false),
            .scheduleDeferred
        )
        // Once the window has passed, the next frame rebuilds again.
        XCTAssertEqual(
            throttle.action(for: start.addingTimeInterval(0.45), force: false),
            .syncNow
        )

        // A forced rebuild always runs now.
        XCTAssertEqual(throttle.action(for: start, force: true), .syncNow)
    }

    // MARK: - Menubar thread pin

    /// A menubar pick pins its thread until the sidebar moves on.
    func testAMenubarThreadPinIsDroppedWhenTheSidebarMovesOn() {
        var pin = MacWaitingThreadPin()
        pin.pin(threadId: "thread-a", botId: "bot-a")
        XCTAssertEqual(pin.threadId, "thread-a")

        // Picking the same bot again keeps the pin.
        XCTAssertFalse(pin.dropIfSelectionMoved(toBotId: "bot-a"))
        XCTAssertEqual(pin.threadId, "thread-a")

        // Picking another bot releases it.
        XCTAssertTrue(pin.dropIfSelectionMoved(toBotId: "bot-b"))
        XCTAssertNil(pin.threadId)
        XCTAssertNil(pin.botId)

        // A room pick releases it as well.
        pin.pin(threadId: "thread-c", botId: "bot-c")
        XCTAssertTrue(pin.dropIfSelectionMoved(toBotId: nil))
        XCTAssertNil(pin.threadId)
    }

    // MARK: - On-screen suppression

    /// A banner is only suppressed for the thread on screen while the app is
    /// actually in front.
    func testTheOnScreenThreadIsOnlySuppressedWhileTheAppIsInFront() {
        let coordinator = MacNotificationCoordinator(initialPermission: .authorized)
        coordinator.activeOnScreenThreadId = "thread-on-screen"

        // The app is in the background, so the banner still arrives.
        coordinator.isMainWindowVisibleAndFocused = false
        let backgroundDecision = coordinator.handleEvent(
            .botNeedsApproval(
                botId: "b1",
                botName: "Monet",
                threadId: "thread-on-screen",
                requestId: "req-1",
                summary: "Run git push"
            )
        )
        guard case .deliver = backgroundDecision else {
            return XCTFail("Expected the banner to be delivered while the app is in the background")
        }

        // The app is in front with that thread on screen, so the banner
        // would be noise on top of the card.
        coordinator.isMainWindowVisibleAndFocused = true
        XCTAssertEqual(
            coordinator.handleEvent(
                .botNeedsApproval(
                    botId: "b1",
                    botName: "Monet",
                    threadId: "thread-on-screen",
                    requestId: "req-2",
                    summary: "Run git push"
                )
            ),
            .suppressedAlreadyOnScreen
        )
    }

    /// The on-screen flag needs both the window on screen and the app in
    /// front.
    func testTheOnScreenFlagNeedsBothTheWindowAndTheApp() {
        XCTAssertTrue(
            MacMainWindowFocus.isVisibleAndFocused(windowIsVisible: true, applicationIsActive: true)
        )
        XCTAssertFalse(
            MacMainWindowFocus.isVisibleAndFocused(windowIsVisible: true, applicationIsActive: false)
        )
        XCTAssertFalse(
            MacMainWindowFocus.isVisibleAndFocused(windowIsVisible: false, applicationIsActive: true)
        )
        XCTAssertFalse(
            MacMainWindowFocus.isVisibleAndFocused(windowIsVisible: false, applicationIsActive: false)
        )
    }
}
