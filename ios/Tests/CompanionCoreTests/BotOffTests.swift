import XCTest
@testable import CompanionCore

/// The bot On/Off switch (`shared/bot-power.ts`) as the phone sees it: the
/// field decodes from the roster, an older harness without it reads as on, and
/// the profile save sends it only when the person changed it.
final class BotOffTests: XCTestCase {
    private func fleet(_ botFields: String) throws -> Fleet {
        let json = """
        {"bots":[{"id":"b1","threadId":"t1","name":"Scout","title":"Sentry","description":"",
        "notifications":false,"color":"green","unread":false,
        "modelSelection":{"instanceId":"dsh","model":"deepseek-v4"},"createdAt":1\(botFields)}],"groups":[]}
        """
        return try JSONDecoder().decode(Fleet.self, from: Data(json.utf8))
    }

    private func body(_ patch: BotProfilePatch) throws -> [String: Any] {
        let data = try JSONEncoder().encode(patch)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - Decoding

    func testAnOffBotKeepsItsPlaceInTheRosterAndReadsAsOff() throws {
        let bot = try XCTUnwrap(fleet(#","off":true"#).bots.first)
        XCTAssertEqual(bot.off, true)
        XCTAssertTrue(bot.isOff)
    }

    func testAnOlderHarnessWithoutTheFieldReadsAsOn() throws {
        let bot = try XCTUnwrap(fleet("").bots.first)
        XCTAssertNil(bot.off)
        XCTAssertFalse(bot.isOff)
    }

    func testAnExplicitFalseIsOn() throws {
        // The harness stores an explicit false after a Turn On so every frame
        // carries the field and a merged frame cannot keep a stale `true`.
        let bot = try XCTUnwrap(fleet(#","off":false"#).bots.first)
        XCTAssertEqual(bot.off, false)
        XCTAssertFalse(bot.isOff)
    }

    // MARK: - Profile PATCH

    func testTurnOnSendsOnlyTheSwitch() throws {
        let sent = try body(BotProfilePatch(off: false))
        XCTAssertEqual(sent.keys.sorted(), ["off"])
        XCTAssertEqual(sent["off"] as? Bool, false)
    }

    func testTurnOffSendsOnlyTheSwitch() throws {
        let sent = try body(BotProfilePatch(off: true))
        XCTAssertEqual(sent.keys.sorted(), ["off"])
        XCTAssertEqual(sent["off"] as? Bool, true)
    }

    func testAnUnrelatedProfileSaveNeverTouchesTheSwitch() throws {
        // `nil` means "leave it alone": renaming a bot must not flip a bot
        // another device just switched off.
        XCTAssertNil(try body(BotProfilePatch(name: "Scout 2"))["off"])
        XCTAssertNil(try body(BotProfilePatch())["off"])
    }
}
