import XCTest
@testable import CompanionCore

final class ImessageMessageTests: XCTestCase {
    func testParsesAWrappedInbound() {
        let text = [
            "[IMESSAGE INBOUND]",
            "[from iMessage]",
            "Need a summary",
            "More context here",
            "[/IMESSAGE INBOUND]",
        ].joined(separator: "\n")

        let view = ImessageMessageView.parse(text)
        XCTAssertEqual(view?.headline, "Need a summary")
        XCTAssertEqual(view?.subtitle, "iMessage")
        XCTAssertEqual(view?.payload, "More context here")
        XCTAssertEqual(view?.body, "Need a summary\nMore context here")
    }

    func testParsesABarePrefixAndLeavesOrdinaryChatAlone() {
        let view = ImessageMessageView.parse("[from iMessage] short ping")
        XCTAssertEqual(view?.headline, "short ping")
        XCTAssertNil(view?.payload)
        XCTAssertNil(ImessageMessageView.parse("hello from a person"))
        XCTAssertNil(ImessageMessageView.parse(nil))
    }

    func testStripsToImessagePrefix() {
        XCTAssertEqual(ImessageMessageView.stripToImessagePrefix("[to iMessage]\nShip it."), "Ship it.")
        XCTAssertEqual(ImessageMessageView.stripToImessagePrefix("[to iMessage] Ship it."), "Ship it.")
        XCTAssertNil(ImessageMessageView.stripToImessagePrefix("Working on the deploy in BotFleet."))
    }
}
