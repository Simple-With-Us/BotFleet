import Foundation
import Testing
@testable import CompanionCore

@Suite("The Mac chat window on the native engine (BF-2705)")
struct NativeDesktopChatTests {
    @Test("The host opens the store and runtime once and shares them")
    func hostOpensOnce() async throws {
        let counter = BuildCounter()
        let host = NativeMacRuntimeHost {
            counter.increment()
            let database = try DatabaseService(path: ":memory:")
            return (database, Self.runtime(over: database))
        }
        #expect(host.current == nil)

        let first = try host.open()
        let second = try host.open()

        #expect(counter.value == 1)
        #expect(first.database === second.database)
        #expect(host.current?.database === first.database)
        // The one registration ran over an empty store and found nothing.
        let report = await first.registration.value
        #expect(report.registered.isEmpty)
        #expect(report.loadFailure == nil)
    }

    @Test("A build that throws opens nothing, and the next open tries again")
    func hostRetriesAfterFailedBuild() throws {
        let counter = BuildCounter()
        let host = NativeMacRuntimeHost {
            counter.increment()
            if counter.value == 1 { throw HostFixtureError.storeUnavailable }
            let database = try DatabaseService(path: ":memory:")
            return (database, Self.runtime(over: database))
        }

        #expect(throws: HostFixtureError.storeUnavailable) { _ = try host.open() }
        #expect(host.current == nil)
        _ = try host.open()
        #expect(counter.value == 2)
        #expect(host.current != nil)
    }

    @Test("Start moves each registered bot onto the native runtime and reads the fleet")
    func startMovesRegisteredBots() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        try await fixture.register("bot-a", thread: "thread-a")

        let start = try await fixture.chat(registered: ["bot-a"]).start()

        #expect(start.nativeBots == ["bot-a"])
        #expect(start.cutoverSkipped.isEmpty)
        #expect(start.snapshot.fleet.bots.map(\.id).sorted() == ["bot-a", "bot-b"])
        #expect(await fixture.owner("bot-a") == .nativeSwift)
        // A stored bot that did not register is never moved.
        #expect(await fixture.owner("bot-b") == .nodeHarness)
    }

    @Test("A registered bot whose thread is missing stays fenced and is named")
    func botWithoutThreadStaysFenced() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        try await fixture.register("bot-a", thread: "thread-a")
        try await fixture.register("bot-b", thread: "thread-missing")

        let start = try await fixture.chat(registered: ["bot-a", "bot-b"]).start()

        #expect(start.nativeBots == ["bot-a"])
        #expect(start.cutoverSkipped == [
            NativeDesktopCutoverSkip(botId: "bot-b", reason: "its thread is not in the native store"),
        ])
        #expect(await fixture.owner("bot-b") == .nodeHarness)
    }

    @Test("A report naming a bot with no profile leaves it fenced")
    func reportedBotWithoutProfileStaysFenced() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }

        let start = try await fixture.chat(registered: ["bot-a"]).start()

        #expect(start.nativeBots.isEmpty)
        #expect(start.cutoverSkipped.map(\.botId) == ["bot-a"])
        #expect(await fixture.owner("bot-a") == .nodeHarness)
    }

    @Test("Starting twice keeps a moved bot on the native runtime")
    func startIsRepeatable() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        try await fixture.register("bot-a", thread: "thread-a")
        let chat = fixture.chat(registered: ["bot-a"])

        _ = try await chat.start()
        let again = try await chat.start()

        #expect(again.nativeBots == ["bot-a"])
        #expect(again.cutoverSkipped.isEmpty)
    }

    @Test("A message streams its reply and settles the stored transcript in the window")
    func sendStreamsAndSettles() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        try await fixture.register("bot-a", thread: "thread-a")
        let chat = fixture.chat(registered: ["bot-a"])
        var state = CompanionState()
        state.hydrate(try await chat.start().snapshot.fleet)

        var frames: [Frame] = []
        for await frame in try await chat.send(botId: "bot-a", threadId: "thread-a", text: "hello") {
            frames.append(frame)
            state.apply(frame)
        }

        #expect(frames.contains { frame in
            if case let .runtime(event) = frame { return event.type == "content.delta" && event.delta == "hi from native" }
            return false
        })
        if case let .runtime(event)? = frames.last {
            #expect(event.type == "turn.completed")
        } else {
            Issue.record("expected the turn's end last")
        }
        let transcript = try #require(state.messages["thread-a"])
        #expect(transcript.count == 2)
        #expect(transcript.first?.role == .user)
        #expect(transcript.first?.text == "hello")
        #expect(transcript.last?.role == .bot)
        #expect(state.streaming["thread-a"] == nil)
        #expect(await fixture.engine.prompts == ["hello"])
    }

    @Test("A message to a bot that was not moved is refused before any engine runs")
    func sendBeforeStartIsFenced() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        try await fixture.register("bot-a", thread: "thread-a")

        await #expect(throws: NativeDesktopChatError.runtimeNotNative(botId: "bot-a")) {
            _ = try await fixture.chat(registered: ["bot-a"]).send(botId: "bot-a", threadId: "thread-a", text: "hello")
        }
        #expect(await fixture.engine.prompts.isEmpty)
    }

    @Test("Clean install creates first native bot, sends a turn, and reopens with saved transcript")
    func cleanInstallCreateBotSendAndReopen() async throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("desktop-clean-install-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: base) }
        let dbPath = base.appendingPathComponent("companion.sqlite").path
        let workspacesRoot = base.appendingPathComponent("workspaces", isDirectory: true)

        let db1 = try DatabaseService(path: dbPath)
        let runtime1 = NativeMacCompanionRuntime(
            database: db1,
            workspacesRoot: workspacesRoot,
            credentials: DatabaseCliLoginCredentials(database: db1)
        )
        let chat1 = NativeDesktopChat(
            database: db1,
            runtime: runtime1,
            registration: { MacBotRegistrationReport() }
        )
        let initialStart = try await chat1.start()
        #expect(initialStart.snapshot.fleet.bots.isEmpty)

        // Warm the credential cache while the store is still empty.
        let creds = DatabaseCliLoginCredentials(database: db1)
        let missingCreds = try await creds.credentials(forBotId: "nonexistent")
        guard case .unavailable = missingCreds else {
            Issue.record("Expected unavailable credentials before any bot is stored")
            return
        }

        let engine1 = ChatFixtureEngine()
        let created = try await chat1.createBot(driver: engine1)
        #expect(created.name == "Bot 1")
        #expect(await runtime1.runtime.engineSwitch.owner(for: created.id) == .nativeSwift)

        let frames = try await chat1.send(botId: created.id, threadId: created.threadId, text: "first turn")
        var state1 = CompanionState()
        for await frame in frames {
            state1.apply(frame)
        }
        let settled = try await db1.loadRecentMessages(forThread: created.threadId, limit: 10).messages
        #expect(settled.map(\.content) == ["first turn", "hi from native"])

        // Reopen a fresh DatabaseService + runtime + NativeDesktopChat over the same SQLite file.
        let db2 = try DatabaseService(path: dbPath)
        let runtime2 = NativeMacCompanionRuntime(
            database: db2,
            workspacesRoot: workspacesRoot,
            credentials: DatabaseCliLoginCredentials(database: db2)
        )
        let engine2 = ChatFixtureEngine()
        let profile2 = MacBotExecutionProfile(
            id: created.id,
            threadId: created.threadId,
            engineId: engine2.engineId,
            modelId: created.modelSelection.model
        )
        try await runtime2.registerBot(profile2, driver: engine2)
        var report2 = MacBotRegistrationReport()
        report2.registered = [created.id]
        let chat2 = NativeDesktopChat(database: db2, runtime: runtime2, registration: { report2 })
        let reopened = try await chat2.start()

        #expect(reopened.nativeBots == [created.id])
        #expect(reopened.snapshot.fleet.bots.count == 1)
        #expect(reopened.snapshot.fleet.bots.first?.id == created.id)
        #expect(reopened.snapshot.fleet.bots.first?.messages?.map(\.text) == ["first turn", "hi from native"])
    }

    @Test("Default bot naming avoids collisions and unsupported engines leave SQLite untouched")
    func createBotNamingAndValidation() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        let chat = fixture.chat(registered: [])

        let first = try await chat.createBot(driver: fixture.engine)
        let second = try await chat.createBot(driver: fixture.engine)
        #expect(first.name == "Bot 1")
        #expect(second.name == "Bot 2")

        let countBeforeFailure = try await fixture.database.loadBots().count
        await #expect(throws: NativeDesktopCreateBotError.unsupportedEngine("unknown-engine")) {
            _ = try await chat.createBot(engineInstanceId: "unknown-engine", driver: fixture.engine)
        }
        let countAfterFailure = try await fixture.database.loadBots().count
        #expect(countAfterFailure == countBeforeFailure)
    }

    @Test("DatabaseCliLoginCredentials reloads on a cache miss after a new bot is stored")
    func credentialCacheReloadsOnNewBot() async throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("cred-cache-miss-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: base) }
        let database = try DatabaseService(path: ":memory:")
        let credentials = DatabaseCliLoginCredentials(database: database)

        // Populate cache with an empty table before inserting a bot.
        let beforeInsert = try await credentials.credentials(forBotId: "bot-new")
        guard case .unavailable = beforeInsert else {
            Issue.record("Expected unavailable credentials before inserting the bot")
            return
        }

        let record = StoredBotRecord(
            id: "bot-new",
            name: "Bot 1",
            threadId: "thread-new",
            createdAt: 1,
            rawJSON: Self.botJSON(id: "bot-new", threadId: "thread-new")
        )
        try await database.upsertBot(record)
        let result = try await credentials.credentials(forBotId: "bot-new")
        guard case .available = result else {
            Issue.record("Expected credentials to reload and resolve .available on cache miss")
            return
        }
    }

    // MARK: - Fixture

    private struct Fixture {
        let base: URL
        let database: DatabaseService
        let runtime: NativeMacCompanionRuntime
        let engine: ChatFixtureEngine

        func owner(_ botId: String) async -> BotRuntimeOwner {
            await runtime.runtime.engineSwitch.owner(for: botId)
        }

        func register(_ botId: String, thread threadId: String) async throws {
            try await runtime.registerBot(
                MacBotExecutionProfile(id: botId, threadId: threadId, engineId: ChatFixtureEngine.id),
                driver: engine
            )
        }

        func chat(registered: [String]) -> NativeDesktopChat {
            let report: MacBotRegistrationReport = {
                var report = MacBotRegistrationReport()
                report.registered = registered
                return report
            }()
            return NativeDesktopChat(database: database, runtime: runtime, registration: { report })
        }

        func cleanup() { try? FileManager.default.removeItem(at: base) }
    }

    private func makeFixture() async throws -> Fixture {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("desktop-chat-host-\(UUID().uuidString)", isDirectory: true)
        let database = try DatabaseService(path: ":memory:")
        for (botId, threadId) in [("bot-a", "thread-a"), ("bot-b", "thread-b")] {
            try await database.upsertBot(StoredBotRecord(
                id: botId, name: botId, createdAt: 1, rawJSON: Self.botJSON(id: botId, threadId: threadId)
            ))
            try await database.upsertThread(
                ThreadRecord(id: threadId, title: botId, botId: botId, createdAt: 1, updatedAt: 1)
            )
        }
        let runtime = NativeMacCompanionRuntime(
            database: database,
            workspacesRoot: base.appendingPathComponent("workspaces", isDirectory: true),
            credentials: ChatFixtureCredentials()
        )
        return Fixture(base: base, database: database, runtime: runtime, engine: ChatFixtureEngine())
    }

    private static func runtime(over database: DatabaseService) -> NativeMacCompanionRuntime {
        NativeMacCompanionRuntime(
            database: database,
            workspacesRoot: FileManager.default.temporaryDirectory
                .appendingPathComponent("desktop-chat-host-\(UUID().uuidString)", isDirectory: true)
        )
    }

    private static func botJSON(id: String, threadId: String) -> String {
        """
        {"id":"\(id)","threadId":"\(threadId)","name":"\(id)","title":"Assistant","description":"",
        "notifications":false,"color":"#3366ff","unread":false,
        "modelSelection":{"instanceId":"claude","model":"sonnet"},"createdAt":1}
        """
    }
}

private enum HostFixtureError: Error, Equatable {
    case storeUnavailable
}

private final class BuildCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func increment() {
        lock.lock()
        defer { lock.unlock() }
        count += 1
    }

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
}

private struct ChatFixtureCredentials: NativeServiceCredentialSource {
    func credentials(forBotId botId: String) async throws -> NativeServiceCredentialResult {
        .available(environment: ["FIXTURE_TOKEN": "present"])
    }
}

private actor ChatFixtureEngine: EngineDriver {
    static let id = "chat-host-fixture"
    nonisolated let engineId = ChatFixtureEngine.id
    private(set) var prompts: [String] = []

    func sendTurn(input: TurnInput) async throws -> AsyncStream<TurnEvent> {
        prompts.append(input.prompt)
        return AsyncStream { continuation in
            continuation.yield(.textDelta("hi from native"))
            continuation.yield(.completed(stopReason: "end_turn", inputTokens: 1, outputTokens: 1))
            continuation.finish()
        }
    }

    func cancelTurn(threadId: String) async {}
}
