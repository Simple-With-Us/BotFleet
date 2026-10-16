import XCTest
@testable import CompanionCore

/// The On/Off switch on the phone: what turning it does to a bot that is
/// already working, and the inverse that a SwiftUI `Binding` depends on.
final class BotPowerToggleTests: XCTestCase {

    // MARK: - An idle bot just flips

    func testTurningOffAnIdleBotPowersItOff() {
        XCTAssertEqual(botPowerToggleAction(turnedOn: false, isOff: false, isBusy: false), .setOff(true))
    }

    func testTurningOnABotPowersItOn() {
        XCTAssertEqual(botPowerToggleAction(turnedOn: true, isOff: true, isBusy: false), .setOff(false))
    }

    // MARK: - A working bot is asked

    func testTurningOffAWorkingBotAsksRatherThanFlipping() {
        XCTAssertEqual(botPowerToggleAction(turnedOn: false, isOff: false, isBusy: true), .askAboutRunningTurn)
    }

    func testAskingLeavesTheBotOnUntilItIsAnswered() {
        // The person is being asked what should happen to the turn, and the
        // answer has not arrived — so the switch must still read on.
        XCTAssertFalse(BotPowerToggleAction.askAboutRunningTurn.resultingIsOff)
    }

    func testTurningOnAWorkingBotIsNeverInQuestion() {
        // There is nothing to stop when you are turning a bot ON, so it never
        // interrupts a person who is mid-turn.
        XCTAssertEqual(botPowerToggleAction(turnedOn: true, isOff: false, isBusy: true), .setOff(false))
    }

    // MARK: - The binding's inverse

    /// The switch reads `!isOff` and writes whatever the setter computes, so a
    /// setter that stores what it was handed leaves the switch reporting the
    /// value it already had — SwiftUI snaps it back and the tap does nothing.
    /// This walks the pair the way the view does and pins that each flip ends
    /// up where the person asked for.
    private func switchReports(isOff: Bool, afterTurningOnTurnedOn: Bool) -> Bool {
        let action = botPowerToggleAction(turnedOn: afterTurningOnTurnedOn, isOff: isOff, isBusy: false)
        return !action.resultingIsOff
    }

    func testAnIdleBotRoundTripsBothWaysThroughTheSwitch() {
        XCTAssertEqual(switchReports(isOff: false, afterTurningOnTurnedOn: false), false)
        XCTAssertEqual(switchReports(isOff: true, afterTurningOnTurnedOn: true), true)
    }

    func testAFlipAlwaysEndsUpWhereThePersonAskedFor() {
        // The switch shows the inverse of the stored state, so a real flip is
        // a tap that reports the stored value itself — tapping a switch to the
        // position it is already showing is not a tap, it is a no-op, and this
        // does not demand that one move anything.
        for starting in [true, false] {
            let wasShowing = !starting
            let tapped = starting
            XCTAssertEqual(
                switchReports(isOff: starting, afterTurningOnTurnedOn: tapped),
                tapped,
                "the switch was showing \(wasShowing ? "on" : "off"), so tapping it must leave it showing \(wasShowing ? "off" : "on")"
            )
        }
    }
}