// Honest controls in the native macOS app.
//
// A control that is in the window but does nothing reads as a working
// control, and a person clicking it has no way to tell the difference.  These
// cases pin the honest shapes:  the fleet-wide pause row keeps its place in
// the menubar and says it cannot act, and a Settings section with no screen
// behind it says so instead of showing a version stamp.
//
// The macOS app itself cannot be built on this host, so the copy and the
// rules live in the shared core, where they are testable, and the app reads
// them.
import XCTest

@testable import CompanionCore

final class MacHonestControlsTests: XCTestCase {
    // MARK: - The fleet-wide pause row

    func testThePauseRowKeepsItsPlaceAndCannotAct() {
        let state = MacMenubarState(
            isConnected: true,
            workingBotCount: 1,
            waitingBots: [],
            allBotsPaused: false,
            reduceMotion: false
        )

        let items = state.menuItems
        //  The row keeps its place:  the menubar order is a contract, and
        //  removing a row moves every row under it.  With no bot waiting the
        //  menu has eleven rows and the pause row is the eighth.
        XCTAssertEqual(items.count, 11)
        XCTAssertEqual(items[7].title, "Pause All Bots")
        XCTAssertEqual(items[8].title, "Settings")

        //  It cannot act, and it says why:  pausing every bot is a
        //  fleet-wide behaviour change and the wake path is not allowed to
        //  change under it.
        XCTAssertFalse(items[7].isActionable)
        let reason = items[7].unavailableReason
        XCTAssertNotNil(reason)
        XCTAssertEqual(reason, MacMenubarState.pauseResumeUnavailableCopy)
        XCTAssertTrue(reason?.contains("not available yet") == true, reason ?? "")
        XCTAssertTrue(reason?.contains("keep running") == true, reason ?? "")

        //  The rows around it still act:  only the pause row is unavailable.
        XCTAssertTrue(items[0].isActionable)
        XCTAssertTrue(items[8].isActionable)
        XCTAssertNil(items[8].unavailableReason)
    }

    func testThePauseRowKeepsItsPlaceWhenABotIsWaiting() {
        //  A waiting bot adds its own row, so the pause row moves down by
        //  one.  It still cannot act and still says why.
        let waiting = MacWaitingBotItem(
            id: "bot-1",
            botName: "Monet",
            threadId: "thread-1",
            needDescription: "Approve a change"
        )
        let state = MacMenubarState(
            isConnected: true,
            workingBotCount: 3,
            waitingBots: [waiting],
            allBotsPaused: false,
            reduceMotion: false
        )

        let items = state.menuItems
        XCTAssertEqual(items.count, 12)
        XCTAssertEqual(items[6].title, "Monet — Approve a change")
        XCTAssertEqual(items[8].title, "Pause All Bots")
        XCTAssertEqual(items[9].title, "Settings")
        XCTAssertFalse(items[8].isActionable)
        XCTAssertEqual(items[8].unavailableReason, MacMenubarState.pauseResumeUnavailableCopy)
    }

    func testThePausedStateAlsoCannotAct() {
        //  A paused-looking state is the state that would have been a lie:
        //  the flag flipped, nothing consumed it.
        let state = MacMenubarState(
            isConnected: true,
            workingBotCount: 0,
            waitingBots: [],
            allBotsPaused: true,
            reduceMotion: false
        )
        XCTAssertEqual(state.menuItems[7].title, "Resume All Bots")
        XCTAssertFalse(state.menuItems[7].isActionable)
        XCTAssertEqual(state.menuItems[7].unavailableReason, MacMenubarState.pauseResumeUnavailableCopy)
    }

    // MARK: - The Settings sections with no screen behind them

    func testTheSectionsWithoutAScreenSaySo() {
        //  These three render nothing but the version stamp, so they are not
        //  available yet.  Lifecycle used to be on this list and is not any
        //  more:  BF-2688 gave it a screen, and the honest contract for a
        //  section that gets one is the screen itself, not a stamp.
        for section in [MacSettingsSection.models, .voice, .shortcuts] {
            XCTAssertFalse(section.isImplemented, section.displayTitle)
            XCTAssertFalse(section.unavailableCopy.isEmpty, section.displayTitle)
            XCTAssertTrue(
                section.unavailableCopy.contains("not available yet"),
                section.unavailableCopy
            )
        }
    }

    func testTheLifecycleSectionHasAScreenBehindItNow() {
        //  The Lifecycle section stopped being a placeholder when it took the
        //  product controls over:  harness status, Local VM start and stop,
        //  and the startup policy.  Its copy is empty because it has nothing
        //  to apologise for.
        let section = MacSettingsSection.lifecycle
        XCTAssertTrue(section.isImplemented, section.displayTitle)
        XCTAssertEqual(section.unavailableCopy, "", section.displayTitle)
        XCTAssertEqual(section.displayTitle, "Lifecycle")
    }

    func testTheSectionsWithAScreenAreUnchanged() {
        for section in [
            MacSettingsSection.general, .servers, .resources, .secrets, .permissions, .phone,
        ] {
            XCTAssertTrue(section.isImplemented, section.displayTitle)
            XCTAssertEqual(section.unavailableCopy, "", section.displayTitle)
        }
        XCTAssertEqual(MacSettingsSection.allCases.count, 10)
    }
}
