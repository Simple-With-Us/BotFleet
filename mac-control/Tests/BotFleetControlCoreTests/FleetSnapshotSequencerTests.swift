import XCTest
@testable import BotFleetControlCore

final class FleetSnapshotSequencerTests: XCTestCase {
    func testTheNewestReadIsTheCurrentOne() {
        let sequencer = FleetSnapshotSequencer()
        let first = sequencer.begin()
        XCTAssertTrue(sequencer.isCurrent(first))
        let second = sequencer.begin()
        XCTAssertFalse(sequencer.isCurrent(first))
        XCTAssertTrue(sequencer.isCurrent(second))
    }

    func testEveryReadGetsItsOwnNumber() {
        // Two reads that share a number could not tell which of them is the
        // newer one.
        let sequencer = FleetSnapshotSequencer()
        let numbers = (0..<8).map { _ in sequencer.begin() }
        XCTAssertEqual(Set(numbers).count, numbers.count)
    }

    func testALateReadIsDropped() {
        // The slow read that finishes after a newer one has already landed
        // must not write its result.
        let sequencer = FleetSnapshotSequencer()
        let slow = sequencer.begin()
        let fast = sequencer.begin()
        XCTAssertFalse(sequencer.isCurrent(slow))
        XCTAssertTrue(sequencer.isCurrent(fast))
    }
}
