import Foundation
import Testing
@testable import CompanionCore

@Suite("Mac runtime desktop chat factory (BF-2705)")
struct NativeMacDesktopChatFactoryTests {
    @Test("The runtime's desktop chat service runs a turn on the runtime's own graph")
    func factoryRunsTurnOnRuntimeGraph() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        try await fixture.switchBotToNative()
        let engine = FactoryFixtureEngine()
        try await fixture.macRuntime.registerBot(
            MacBotExecutionProfile(id: "bot-a", threadId: "thread-a", engineId: "factory-fixture"),
            driver: engine
        )

        let service = fixture.macRuntime.makeDesktopChatService()
        var events: [TurnEvent] = []
        for await event in try await service.send(botId: "bot-a", threadId: "thread-a", text: "hello") {
            events.append(event)
        }

        #expect(events.contains(.textDelta("hi from the runtime graph")))
        #expect(await engine.prompts == ["hello"])
        let messages = try await fixture.database.loadMessages(forThread: "thread-a")
        #expect(messages.contains { $0.role == "user" && $0.content == "hello" })
        #expect(messages.contains { $0.role == "assistant" })
        // The turn ran on the runtime's coordinator and released its slot.
        #expect(await fixture.macRuntime.activeEngineTurnCount() == 0)
    }

    @Test("A bot the runtime has not registered is refused, not run elsewhere")
    func unregisteredBotRefused() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        try await fixture.switchBotToNative()

        let service = fixture.macRuntime.makeDesktopChatService()
        await #expect(throws: NativeDesktopChatError.botNotRegistered(botId: "bot-a")) {
            _ = try await service.send(botId: "bot-a", threadId: "thread-a", text: "hello")
        }
    }

    @Test("The factory never switches a Node-owned bot to the native runtime")
    func nodeOwnedBotStaysFenced() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        let engine = FactoryFixtureEngine()
        try await fixture.macRuntime.registerBot(
            MacBotExecutionProfile(id: "bot-a", threadId: "thread-a", engineId: "factory-fixture"),
            driver: engine
        )

        let service = fixture.macRuntime.makeDesktopChatService()
        await #expect(throws: NativeDesktopChatError.runtimeNotNative(botId: "bot-a")) {
            _ = try await service.send(botId: "bot-a", threadId: "thread-a", text: "hello")
        }
        #expect(await fixture.macRuntime.runtime.engineSwitch.owner(for: "bot-a") == .nodeHarness)
        #expect(await engine.prompts.isEmpty)
    }

    // MARK: - Fixture

    private struct Fixture {
        let base: URL
        let database: DatabaseService
        let thread: ThreadRecord
        let macRuntime: NativeMacCompanionRuntime

        func switchBotToNative() async throws {
            _ = try await macRuntime.runtime.engineSwitch.switchToNativeSwift(
                botId: "bot-a",
                historySnapshot: BotHistoryImportSnapshot(botId: "bot-a", threads: [thread], messagesByThread: [:])
            )
        }

        func cleanup() { try? FileManager.default.removeItem(at: base) }
    }

    private func makeFixture() async throws -> Fixture {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("desktop-factory-\(UUID().uuidString)", isDirectory: true)
        let database = try DatabaseService(path: ":memory:")
        try await database.upsertBot(StoredBotRecord(id: "bot-a", name: "Fixture", createdAt: 1, rawJSON: "{}"))
        let thread = ThreadRecord(id: "thread-a", title: "Fixture", botId: "bot-a", createdAt: 1, updatedAt: 1)
        try await database.upsertThread(thread)
        let macRuntime = NativeMacCompanionRuntime(
            database: database,
            workspacesRoot: base.appendingPathComponent("workspaces", isDirectory: true),
            credentials: FactoryFixtureCredentials()
        )
        return Fixture(base: base, database: database, thread: thread, macRuntime: macRuntime)
    }
}

private struct FactoryFixtureCredentials: NativeServiceCredentialSource {
    func credentials(forBotId botId: String) async throws -> NativeServiceCredentialResult {
        .available(environment: ["FIXTURE_TOKEN": "present"])
    }
}

private actor FactoryFixtureEngine: EngineDriver {
    nonisolated let engineId = "factory-fixture"
    private(set) var prompts: [String] = []

    func sendTurn(input: TurnInput) async throws -> AsyncStream<TurnEvent> {
        prompts.append(input.prompt)
        return AsyncStream { continuation in
            continuation.yield(.textDelta("hi from the runtime graph"))
            continuation.yield(.completed(stopReason: "end_turn", inputTokens: 1, outputTokens: 1))
            continuation.finish()
        }
    }

    func cancelTurn(threadId: String) async {}
}
