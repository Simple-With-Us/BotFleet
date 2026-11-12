import XCTest
@testable import CompanionCore

final class BotConversationModelSelectionTests: XCTestCase {
    func testTaskOverrideWinsOverBotWideActiveSelection() throws {
        let bot = try decodeBot(
            #","modelSelection":{"instanceId":"claude","model":"sonnet"},"activeModelSelection":{"instanceId":"grok","model":"grok-4"},"tasks":[{"threadId":"task-a","title":"A","createdAt":1,"modelSelection":{"instanceId":"gemini","model":"gemini-2.5"}}]"#
        )
        let selection = BotConversationModelSelection.selection(for: bot, inThread: "task-a")
        XCTAssertEqual(selection?.instanceId, "gemini")
        XCTAssertEqual(selection?.model, "gemini-2.5")
    }

    func testInheritingTaskDoesNotReadBotWideActiveSelection() throws {
        let bot = try decodeBot(
            #","modelSelection":{"instanceId":"claude","model":"sonnet"},"activeModelSelection":{"instanceId":"grok","model":"grok-4"},"tasks":[{"threadId":"task-a","title":"A","createdAt":1}]"#
        )
        let selection = BotConversationModelSelection.selection(for: bot, inThread: "task-a")
        XCTAssertEqual(selection?.instanceId, "claude")
        XCTAssertEqual(selection?.model, "sonnet")
    }

    private func decodeBot(_ extra: String) throws -> Bot {
        try JSONDecoder().decode(Bot.self, from: Data("""
        {"id":"b1","threadId":"main","name":"Scout","title":"","description":"",
         "notifications":true,"color":"blue","unread":false,"createdAt":1\(extra)}
        """.utf8))
    }
}
