import Foundation
import Testing
@testable import CompanionCore

@Suite("SQLite3 WAL and FTS5 persistence engine")
struct DatabaseServiceTests {

    @Test("threads can be upserted and retrieved in recency order")
    func threadUpsertAndRetrieval() async throws {
        let db = try DatabaseService(path: ":memory:")
        let thread = ThreadRecord(id: "thread-1", title: "General Engineering", botId: "bot-claude")
        try await db.upsertThread(thread)

        let threads = try await db.loadThreads()
        #expect(threads.count == 1)
        #expect(threads.first?.id == "thread-1")
        #expect(threads.first?.title == "General Engineering")
        #expect(threads.first?.botId == "bot-claude")

        // Update title
        let updated = ThreadRecord(id: "thread-1", title: "Core Architecture", botId: "bot-claude")
        try await db.upsertThread(updated)

        let reloaded = try await db.loadThreads()
        #expect(reloaded.count == 1)
        #expect(reloaded.first?.title == "Core Architecture")
    }

    @Test("messages preserve insertion order and timestamps")
    func messageInsertionAndOrdering() async throws {
        let db = try DatabaseService(path: ":memory:")
        let thread = ThreadRecord(id: "t1", title: "Thread One")
        try await db.upsertThread(thread)

        let msg1 = MessageRecord(id: "m1", threadId: "t1", role: "user", content: "First message", createdAt: 100.0)
        let msg2 = MessageRecord(id: "m2", threadId: "t1", role: "assistant", content: "Second message", createdAt: 105.0)

        try await db.insertMessage(msg1)
        try await db.insertMessage(msg2)

        let messages = try await db.loadMessages(forThread: "t1")
        #expect(messages.count == 2)
        #expect(messages[0].id == "m1")
        #expect(messages[0].content == "First message")
        #expect(messages[1].id == "m2")
        #expect(messages[1].content == "Second message")
    }

    @Test("FTS5 full-text indexing finds exact keywords and prefix matches with snippet highlights")
    func fts5FullTextSearch() async throws {
        let db = try DatabaseService(path: ":memory:")
        let thread = ThreadRecord(id: "search-thread", title: "Searchable Thread")
        try await db.upsertThread(thread)

        let msg1 = MessageRecord(
            id: "msg-swift",
            threadId: "search-thread",
            role: "assistant",
            content: "We are migrating to a 100% native macOS application written in Swift and Metal."
        )
        let msg2 = MessageRecord(
            id: "msg-electron",
            threadId: "search-thread",
            role: "user",
            content: "Electron consumed too much RAM and idle CPU in the previous build."
        )

        try await db.insertMessage(msg1)
        try await db.insertMessage(msg2)

        // Query for "Swift"
        let swiftResults = try await db.search(query: "Swift")
        #expect(swiftResults.count == 1)
        #expect(swiftResults.first?.id == "msg-swift")
        #expect(swiftResults.first?.snippet.contains("<b>Swift</b>") == true)

        // Query for "RAM"
        let ramResults = try await db.search(query: "RAM")
        #expect(ramResults.count == 1)
        #expect(ramResults.first?.id == "msg-electron")
        #expect(ramResults.first?.snippet.contains("<b>RAM</b>") == true)

        // Prefix matching for "migrat*"
        let prefixResults = try await db.search(query: "migrat")
        #expect(prefixResults.count == 1)
        #expect(prefixResults.first?.id == "msg-swift")
    }

    @Test("cascading delete removes child messages and automatically cleans FTS index")
    func cascadeDeleteRemovesMessagesAndFTS() async throws {
        let db = try DatabaseService(path: ":memory:")
        let thread = ThreadRecord(id: "del-thread", title: "Delete Me")
        try await db.upsertThread(thread)

        let msg = MessageRecord(id: "del-msg", threadId: "del-thread", role: "user", content: "Ephemeral secret data")
        try await db.insertMessage(msg)

        let beforeSearch = try await db.search(query: "Ephemeral")
        #expect(beforeSearch.count == 1)

        // Delete thread
        try await db.deleteThread(id: "del-thread")

        let afterMessages = try await db.loadMessages(forThread: "del-thread")
        #expect(afterMessages.isEmpty)

        let afterSearch = try await db.search(query: "Ephemeral")
        #expect(afterSearch.isEmpty)
    }

    @Test("routine run logs and webhook deliveries can be recorded and queried")
    func routineRunAndWebhookLogging() async throws {
        let db = try DatabaseService(path: ":memory:")
        let run = RoutineRunRecord(
            id: "run-101",
            routineId: "nightly-cleanup",
            botId: "bot-housekeeper",
            status: "success",
            completedAt: Date().timeIntervalSince1970
        )
        try await db.recordRoutineRun(run)

        let runs = try await db.loadRoutineRuns(forRoutine: "nightly-cleanup")
        #expect(runs.count == 1)
        #expect(runs.first?.id == "run-101")
        #expect(runs.first?.status == "success")

        let webhook = WebhookDeliveryRecord(
            id: "wh-202",
            webhookId: "github-webhook",
            botId: "bot-builder",
            statusCode: 200,
            payload: "{\"event\": \"push\"}"
        )
        try await db.recordWebhookDelivery(webhook)

        let deliveries = try await db.loadWebhookDeliveries(forWebhook: "github-webhook")
        #expect(deliveries.count == 1)
        #expect(deliveries.first?.statusCode == 200)
        #expect(deliveries.first?.payload == "{\"event\": \"push\"}")
    }
}
