import XCTest
@testable import CompanionCore

final class ChatAccessibilityTests: XCTestCase {
    private let gap = ".\u{00A0} "

    func testInstructionCardSaysWhatFiredAndTheFirstLine() {
        XCTAssertEqual(
            ChatAccessibility.instructionCardLabel(
                headline: "Scheduled Run",
                subtitle: "Check the nightly deploy"
            ),
            "Scheduled Run\(gap)Check the nightly deploy"
        )
    }

    func testInstructionCardNamesWebhookEventDetailAndTime() {
        XCTAssertEqual(
            ChatAccessibility.instructionCardLabel(
                name: "Webhook",
                headline: "deployment.failed",
                subtitle: "ci",
                when: "3 minutes ago"
            ),
            "Webhook\(gap)deployment.failed\(gap)ci\(gap)3 minutes ago"
        )
    }

    func testInstructionCardDoesNotRepeatTheHeadline() {
        XCTAssertEqual(
            ChatAccessibility.instructionCardLabel(
                name: "Scheduled Run",
                headline: "Scheduled Run",
                subtitle: "  Scheduled Run  "
            ),
            "Scheduled Run"
        )
    }

    func testBlankInstructionCardHasAPlainName() {
        XCTAssertEqual(
            ChatAccessibility.instructionCardLabel(headline: "  ", subtitle: ""),
            "Automated instruction"
        )
    }
}
