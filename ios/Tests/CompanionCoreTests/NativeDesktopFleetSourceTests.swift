import Foundation
import Testing
@testable import CompanionCore

@Suite("The window's fleet from the native store (BF-2705)")
struct NativeDesktopFleetSourceTests {
    @Test("A stored bot decodes as the harness's Bot with its transcript in order")
    func snapshotReadsBotAndTranscript() async throws {
        let database = try await makeStore()
        try await database.insertMessage(record("m2", role: "assistant", content: "hi there", at: 11))
        try await database.insertMessage(record("m1", role: "user", content: "hello", at: 10))

        let snapshot = try await NativeDesktopFleetSource(database: database).snapshot()

        #expect(snapshot.skipped.isEmpty)
        #expect(snapshot.fleet.bots.map(\.id) == ["bot-a"])
        #expect(snapshot.fleet.groups.isEmpty)
        let bot = try #require(snapshot.fleet.bots.first)
        #expect(bot.name == "Ava")
        #expect(bot.threadId == "thread-a")
        #expect(bot.hasMore == false)
        let messages = try #require(bot.messages)
        #expect(messages.map(\.text) == ["hello", "hi there"])
        #expect(messages.map(\.role) == [.user, .bot])
        #expect(messages.first?.at == 10_000)
        #expect(messages.allSatisfy { $0.kind == .text })
    }

    @Test("A long thread opens on its newest page and says older messages exist")
    func longThreadShowsNewestPage() async throws {
        let database = try await makeStore()
        let total = NativeDesktopFleetSource.pageSize + 5
        for index in 0..<total {
            try await database.insertMessage(record(
                String(format: "m%03d", index), role: "user", content: "line \(index)", at: Double(index + 1)
            ))
        }

        let source = NativeDesktopFleetSource(database: database)
        let bot = try #require(try await source.snapshot().fleet.bots.first)
        let messages = try #require(bot.messages)

        #expect(messages.count == NativeDesktopFleetSource.pageSize)
        #expect(messages.first?.text == "line 5")
        #expect(messages.last?.text == "line \(total - 1)")
        #expect(bot.hasMore == true)
        // The settled hook reads the same newest page, so a just-stored reply is in it.
        let settled = await source.settledFrames(threadId: "thread-a")
        if case let .message(_, last)? = settled.last {
            #expect(last.text == "line \(total - 1)")
        } else {
            Issue.record("expected the newest message last")
        }
    }

    @Test("The newest page from the store is oldest-first with an exact older-messages flag")
    func recentMessagesPage() async throws {
        let database = try await makeStore()
        for index in 0..<3 {
            try await database.insertMessage(record("m\(index)", role: "user", content: "\(index)", at: Double(index + 1)))
        }
        let exact = try await database.loadRecentMessages(forThread: "thread-a", limit: 3)
        #expect(exact.messages.map(\.content) == ["0", "1", "2"])
        #expect(exact.hasMore == false)

        let short = try await database.loadRecentMessages(forThread: "thread-a", limit: 2)
        #expect(short.messages.map(\.content) == ["1", "2"])
        #expect(short.hasMore == true)
    }

    @Test("A record that does not decode as a bot is named, not shown")
    func undecodableBotSkipped() async throws {
        let database = try await makeStore()
        try await database.upsertBot(StoredBotRecord(id: "bot-b", name: "Broken", createdAt: 1, rawJSON: "{}"))

        let snapshot = try await NativeDesktopFleetSource(database: database).snapshot()

        #expect(snapshot.fleet.bots.map(\.id) == ["bot-a"])
        #expect(snapshot.skipped.map(\.botId) == ["bot-b"])
    }

    @Test("A record that names another bot's id is named, not shown")
    func mismatchedIdSkipped() async throws {
        let database = try await makeStore()
        try await database.upsertBot(StoredBotRecord(
            id: "bot-c", name: "Mismatch", createdAt: 1, rawJSON: Self.botJSON(id: "bot-z", threadId: "thread-c")
        ))

        let snapshot = try await NativeDesktopFleetSource(database: database).snapshot()

        #expect(snapshot.fleet.bots.map(\.id) == ["bot-a"])
        #expect(snapshot.skipped.map(\.botId) == ["bot-c"])
    }

    @Test("The snapshot hydrates CompanionState like a harness snapshot")
    func snapshotHydratesState() async throws {
        let database = try await makeStore()
        try await database.insertMessage(record("m1", role: "user", content: "hello", at: 10))

        var state = CompanionState()
        state.hydrate(try await NativeDesktopFleetSource(database: database).snapshot().fleet)

        #expect(state.bots.map(\.id) == ["bot-a"])
        #expect(state.messages["thread-a"]?.map(\.text) == ["hello"])
    }

    @Test("Settled frames land the stored reply and clear the live bubble")
    func settledFramesSettleTheReply() async throws {
        let database = try await makeStore()
        let source = NativeDesktopFleetSource(database: database)
        var state = CompanionState()
        state.hydrate(try await source.snapshot().fleet)
        for frame in NativeDesktopChatFrames.frames(for: .textDelta("hi th"), threadId: "thread-a") { state.apply(frame) }
        #expect(state.streaming["thread-a"] == "hi th")

        try await database.insertMessage(record("m1", role: "user", content: "hello", at: 10))
        try await database.insertMessage(record("m2", role: "assistant", content: "hi there", at: 11))
        for frame in await source.settledFrames(threadId: "thread-a") { state.apply(frame) }

        #expect(state.messages["thread-a"]?.map(\.text) == ["hello", "hi there"])
        #expect(state.streaming["thread-a"] == nil)
    }

    @Test("Stored roles read as the window's roles")
    func rolesMap() {
        #expect(NativeDesktopFleetSource.message(from: record("a", role: "user", content: "x", at: 1))?.role == .user)
        #expect(NativeDesktopFleetSource.message(from: record("b", role: "assistant", content: "x", at: 1))?.role == .bot)
        #expect(NativeDesktopFleetSource.message(from: record("c", role: "system", content: "x", at: 1))?.role == .system)
        #expect(NativeDesktopFleetSource.message(from: record("d", role: "tool", content: "x", at: 1))?.role == .bot)
    }

    @Test("An empty stored kind reads as text")
    func emptyKindReadsAsText() {
        let blank = MessageRecord(id: "k", threadId: "thread-a", role: "assistant", kind: " ", content: "x", createdAt: 1, model: nil)
        #expect(NativeDesktopFleetSource.message(from: blank)?.kind == .text)
    }

    // MARK: - Fixture

    private func makeStore() async throws -> DatabaseService {
        let database = try DatabaseService(path: ":memory:")
        try await database.upsertBot(StoredBotRecord(
            id: "bot-a", name: "Ava", createdAt: 1, rawJSON: Self.botJSON(id: "bot-a", threadId: "thread-a")
        ))
        try await database.upsertThread(
            ThreadRecord(id: "thread-a", title: "Ava", botId: "bot-a", createdAt: 1, updatedAt: 1)
        )
        return database
    }

    private func record(_ id: String, role: String, content: String, at seconds: Double) -> MessageRecord {
        MessageRecord(
            id: id, threadId: "thread-a", role: role, kind: "text", content: content, createdAt: seconds, model: nil
        )
    }

    private static func botJSON(id: String, threadId: String) -> String {
        """
        {"id":"\(id)","threadId":"\(threadId)","name":"Ava","title":"Assistant","description":"",
        "notifications":false,"color":"#3366ff","unread":false,
        "modelSelection":{"instanceId":"claude","model":"sonnet"},"createdAt":1}
        """
    }
}
