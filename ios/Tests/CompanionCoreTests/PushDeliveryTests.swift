import XCTest
@testable import CompanionCore

final class PushDeliveryTests: XCTestCase {
    func testSuppressesTheReplayOfAFrameAlreadyDeliveredByPush() {
        // The whole point: one closed-app approval arrived by push, the wake
        // reconnected, and the harness replayed the same frame.  The second
        // copy must not become a second banner.
        var ledger = PushDeliveryLedger()
        ledger.record(41)
        XCTAssertTrue(ledger.isAlreadyDelivered(41))
        XCTAssertFalse(ledger.isAlreadyDelivered(42))
    }

    func testAFrameWithNoSequenceIsNeverSuppressed() {
        // An older harness stamps no sequence.  Nothing can be correlated,
        // and a missing banner is the worse of the two failures.
        var ledger = PushDeliveryLedger()
        ledger.record(41)
        XCTAssertFalse(ledger.isAlreadyDelivered(nil))
    }

    func testReadsTheSequenceFromAPushPayload() {
        // APNs hands JSON numbers back as NSNumber; the in-app path puts an
        // Int there.  Both are the same frame.
        XCTAssertEqual(PushDeliveryLedger.sequence(inPushUserInfo: ["seq": NSNumber(value: 77)]), 77)
        XCTAssertEqual(PushDeliveryLedger.sequence(inPushUserInfo: ["seq": 77]), 77)
        XCTAssertEqual(PushDeliveryLedger.sequence(inPushUserInfo: ["seq": "77"]), 77)
        XCTAssertNil(PushDeliveryLedger.sequence(inPushUserInfo: ["threadId": "t1"]))
        XCTAssertNil(PushDeliveryLedger.sequence(inPushUserInfo: ["seq": "not a number"]))
    }

    func testRecordingAPushPayloadRemembersItsFrame() {
        var ledger = PushDeliveryLedger()
        XCTAssertEqual(ledger.record(pushUserInfo: ["threadId": "t1", "seq": NSNumber(value: 9)]), 9)
        XCTAssertTrue(ledger.isAlreadyDelivered(9))
        // A payload from a sidecar too old to stamp one changes nothing.
        XCTAssertNil(ledger.record(pushUserInfo: ["threadId": "t1"]))
    }

    func testForgetsTheOldestOnceItIsFull() {
        // The ledger runs for as long as the app does, so it has to be
        // bounded; the oldest sequence is the one a replay is least likely
        // to still reach.
        var ledger = PushDeliveryLedger()
        for sequence in 1...(PushDeliveryLedger.capacity + 2) { ledger.record(sequence) }
        XCTAssertFalse(ledger.isAlreadyDelivered(1))
        XCTAssertFalse(ledger.isAlreadyDelivered(2))
        XCTAssertTrue(ledger.isAlreadyDelivered(3))
        XCTAssertTrue(ledger.isAlreadyDelivered(PushDeliveryLedger.capacity + 2))
    }

    func testRecordingTheSameFrameTwiceDoesNotConsumeTwoSlots() {
        // The same push can be observed more than once — a wake and then a
        // tap on the same banner.  It is still one frame.
        var ledger = PushDeliveryLedger()
        for _ in 0..<(PushDeliveryLedger.capacity + 5) { ledger.record(7) }
        ledger.record(8)
        XCTAssertTrue(ledger.isAlreadyDelivered(7))
        XCTAssertTrue(ledger.isAlreadyDelivered(8))
    }
}
