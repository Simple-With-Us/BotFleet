import XCTest
@testable import CompanionCore

final class ChatDeepLinkTests: XCTestCase {
    func testBuildsAndParsesABotThreadURL() throws {
        let url = try XCTUnwrap(ChatDeepLink.url(botId: "bot-1", threadId: "thread-9"))
        XCTAssertEqual(url.scheme, "botfleet-ios")
        XCTAssertEqual(url.host, "chat")
        let parsed = try XCTUnwrap(ChatDeepLink.parse(url))
        XCTAssertEqual(parsed.botId, "bot-1")
        XCTAssertEqual(parsed.threadId, "thread-9")
    }

    func testAcceptsBotIdQueryAliases() throws {
        let url = try XCTUnwrap(URL(string: "botfleet://chat?botId=b2&threadId=t2"))
        let parsed = try XCTUnwrap(ChatDeepLink.parse(url))
        XCTAssertEqual(parsed.botId, "b2")
        XCTAssertEqual(parsed.threadId, "t2")
    }

    func testAcceptsLegacySchemeAndParsesPrimaryScheme() throws {
        let legacy = try XCTUnwrap(URL(string: "botfleet://chat?bot=b3&thread=t3"))
        let legacyParsed = try XCTUnwrap(ChatDeepLink.parse(legacy))
        XCTAssertEqual(legacyParsed.botId, "b3")
        XCTAssertEqual(legacyParsed.threadId, "t3")

        let primary = try XCTUnwrap(URL(string: "botfleet-ios://chat?bot=b4&thread=t4"))
        let primaryParsed = try XCTUnwrap(ChatDeepLink.parse(primary))
        XCTAssertEqual(primaryParsed.botId, "b4")
        XCTAssertEqual(primaryParsed.threadId, "t4")
    }

    func testRejectsPairingURLs() throws {
        let url = try XCTUnwrap(URL(string: "botfleet://pair?address=mac.local&code=004209"))
        XCTAssertNil(ChatDeepLink.parse(url))
    }

    func testRejectsIncompleteChatURLs() throws {
        XCTAssertNil(ChatDeepLink.parse(try XCTUnwrap(URL(string: "botfleet://chat?bot=only-bot"))))
        XCTAssertNil(ChatDeepLink.parse(try XCTUnwrap(URL(string: "https://chat?bot=b&thread=t"))))
    }

    func testDecodesTaskLastActivity() throws {
        let data = Data(#"{"threadId":"t","title":"Work","createdAt":1,"lastActivity":99}"#.utf8)
        let task = try JSONDecoder().decode(BotTask.self, from: data)
        XCTAssertEqual(task.lastActivity, 99)
        let legacy = Data(#"{"threadId":"t","title":"Work","createdAt":1}"#.utf8)
        let old = try JSONDecoder().decode(BotTask.self, from: legacy)
        XCTAssertNil(old.lastActivity)
    }
}
