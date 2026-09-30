import XCTest
@testable import CompanionCore

/// The delegate callbacks in these tests stand in for AVSpeechSynthesizer:
/// didCancel for a stopped utterance arrives asynchronously and can land
/// after the next speak() has already begun a new turn.
final class SpeechTurnGuardTests: XCTestCase {
    private final class FakeUtterance {}

    func testLateCancelFromSupersededUtteranceIsIgnored() {
        var turnGuard = SpeechTurnGuard()
        let first = FakeUtterance()
        let second = FakeUtterance()

        turnGuard.begin(utterance: first)
        // The next speak() supersedes the first utterance.
        turnGuard.begin(utterance: second)

        // The delayed didCancel for the first utterance must not finish
        // the second turn...
        XCTAssertFalse(turnGuard.finish(utterance: first))
        XCTAssertNotNil(turnGuard.activeUtteranceID)
        // ...and the second turn finishes on its own callback.
        XCTAssertTrue(turnGuard.finish(utterance: second))
        XCTAssertNil(turnGuard.activeUtteranceID)
    }

    func testStopInvalidatesPendingCallbacks() {
        var turnGuard = SpeechTurnGuard()
        let utterance = FakeUtterance()

        turnGuard.begin(utterance: utterance)
        turnGuard.stop()

        XCTAssertFalse(turnGuard.finish(utterance: utterance))
    }

    func testDoubleFinishIsRejected() {
        var turnGuard = SpeechTurnGuard()
        let utterance = FakeUtterance()

        turnGuard.begin(utterance: utterance)

        XCTAssertTrue(turnGuard.finish(utterance: utterance))
        XCTAssertFalse(turnGuard.finish(utterance: utterance))
    }

    func testFinishWithoutAnActiveTurnIsRejected() {
        var turnGuard = SpeechTurnGuard()
        XCTAssertFalse(turnGuard.finish(utterance: FakeUtterance()))
    }
}
