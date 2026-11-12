import XCTest
@testable import CompanionCore

final class WebhookMessageTests: XCTestCase {
    func testParsesAnAuthenticatedWebhookTask() {
        let payload = """
        {"task":"Summarize the failed deploy","service":"checkout-api"}
        """
        let text = [
            "[AUTHENTICATED WEBHOOK TASK]",
            "Summarize the failed deploy and suggest the first check.",
            "[/AUTHENTICATED WEBHOOK TASK]",
            "",
            "[UNTRUSTED WEBHOOK EVENT DATA]",
            "Received: 2026-08-16T12:47:58.969Z",
            "Delivery ID: deploy-418",
            "Event: deployment.failed",
            "",
            payload,
            "[/UNTRUSTED WEBHOOK EVENT DATA]",
        ].joined(separator: "\n")

        let view = WebhookMessageView.parse(text)
        XCTAssertEqual(view?.task, "Summarize the failed deploy and suggest the first check.")
        XCTAssertEqual(view?.payload, payload)
        XCTAssertEqual(view?.event, "deployment.failed")
        XCTAssertEqual(view?.headline, "deployment.failed")
    }

    func testLeavesOrdinaryChatAlone() {
        XCTAssertNil(WebhookMessageView.parse("hello from a person"))
        XCTAssertNil(WebhookMessageView.parse(nil))
    }

    func testUsesTheSentryIssueTitleAsTheHeadline() {
        let payload = """
        {"action":"unresolved","data":{"issue":{"title":"Cron failure: ci-usage-monitor-ci","project":{"slug":"fleet-infra"}}}}
        """
        let text = [
            "[USER-CONFIGURED WEBHOOK INSTRUCTIONS]",
            "You are BF-Fixer. A Sentry webhook fired.",
            "[/USER-CONFIGURED WEBHOOK INSTRUCTIONS]",
            "",
            "[UNTRUSTED WEBHOOK EVENT DATA]",
            "Event: issue",
            "",
            payload,
            "[/UNTRUSTED WEBHOOK EVENT DATA]",
        ].joined(separator: "\n")

        let view = WebhookMessageView.parse(text)
        XCTAssertEqual(view?.headline, "Cron failure: ci-usage-monitor-ci")
        XCTAssertEqual(view?.project, "fleet-infra")
        XCTAssertEqual(view?.subtitle, "fleet-infra · issue")
        XCTAssertEqual(view?.event, "issue")
    }
}
