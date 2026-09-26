import XCTest
@testable import CompanionCore

final class DelegationMessageTests: XCTestCase {
    func testParsesDelegationWithReason() {
        let text = "[Delegated by @Compiler, another bot in this BotFleet workspace. Do the work and reply directly.]\n\nRun the test suite\n\n[Reason: User requested build verification]"
        let view = DelegationMessageView.parse(text, role: .system)
        XCTAssertNotNil(view)
        XCTAssertEqual(view?.senderName, "Compiler")
        XCTAssertEqual(view?.reason, "User requested build verification")
        XCTAssertEqual(view?.payload, "Run the test suite")
        XCTAssertEqual(view?.headline, "Delegated by @Compiler")
        XCTAssertEqual(view?.subtitle, "Reason: User requested build verification")
    }

    func testParsesDelegationWithoutReason() {
        let text = "[Delegated by @Fixer, another bot in this BotFleet workspace. Do the work and reply directly.]\n\nInvestigate outage"
        let view = DelegationMessageView.parse(text, role: .system)
        XCTAssertNotNil(view)
        XCTAssertEqual(view?.senderName, "Fixer")
        XCTAssertNil(view?.reason)
        XCTAssertEqual(view?.payload, "Investigate outage")
        XCTAssertEqual(view?.headline, "Delegated by @Fixer")
        XCTAssertEqual(view?.subtitle, "Investigate outage")
    }

    func testParsesAutomationSourceDelegation() {
        let text = "Investigate error logs"
        let view = DelegationMessageView.parse(text, role: .system, fromName: "Monitor", automationSource: "delegation")
        XCTAssertNotNil(view)
        XCTAssertEqual(view?.senderName, "Monitor")
        XCTAssertEqual(view?.headline, "Delegated by @Monitor")
        XCTAssertEqual(view?.subtitle, "Investigate error logs")
    }

    func testIgnoresOrdinaryChat() {
        XCTAssertNil(DelegationMessageView.parse("Hello world", role: .user))
        XCTAssertFalse(DelegationMessageView.isDelegation("Hello world", role: .user))
        let quote = "[Delegated by @Compiler, another bot in this BotFleet workspace. Do the work and reply directly.]\n\nQuoted reply"
        XCTAssertNil(DelegationMessageView.parse(quote, role: .bot))
        XCTAssertFalse(DelegationMessageView.isDelegation(quote, role: .bot))
    }
}
