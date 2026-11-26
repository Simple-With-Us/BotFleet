import Foundation
import Testing
@testable import CompanionCore

@Suite("Desktop chat on the native engine (BF-2705)")
struct NativeDesktopChatServiceTests {
    @Test("A registered native bot runs the chat message as a turn and the transcript holds both sides")
    func registeredBotRunsTurn() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        try await fixture.switchBotToNative()
        try await fixture.context.register(
            MacBotExecutionProfile(id: "bot-a", threadId: "thread-a", engineId: "desktop-fixture")
        )

        let stream = try await fixture.service.send(botId: "bot-a", threadId: "thread-a", text: "  hello there  ")
        var events: [TurnEvent] = []
        for await event in stream { events.append(event) }

        #expect(events.contains(.textDelta("hi from the native engine")))
        #expect(events.contains { if case .completed = $0 { return true } else { return false } })
        let prompts = await fixture.engine.prompts
        #expect(prompts == ["hello there"])
        let workingDirectories = await fixture.engine.workingDirectories
        #expect(workingDirectories.count == 1)
        #expect(workingDirectories.first??.hasSuffix("/bot-a") == true)

        let messages = try await fixture.database.loadMessages(forThread: "thread-a")
        #expect(messages.contains { $0.role == "user" && $0.content == "hello there" })
        #expect(messages.contains { $0.role == "assistant" })
        // The switch admission is released once the stream ends.
        #expect(await fixture.coordinator.activeTurnCount() == 0)
    }

    @Test("An empty message is refused before any engine runs")
    func emptyMessageRefused() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        await #expect(throws: NativeDesktopChatError.emptyMessage) {
            _ = try await fixture.service.send(botId: "bot-a", threadId: "thread-a", text: " \n ")
        }
        #expect(await fixture.engine.prompts.isEmpty)
    }

    @Test("A bot with no native profile is refused as not registered")
    func unregisteredBotRefused() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        try await fixture.switchBotToNative()
        await #expect(throws: NativeDesktopChatError.botNotRegistered(botId: "bot-a")) {
            _ = try await fixture.service.send(botId: "bot-a", threadId: "thread-a", text: "hello")
        }
        #expect(await fixture.engine.prompts.isEmpty)
    }

    @Test("A thread owned by another bot is refused")
    func foreignThreadRefused() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        try await fixture.database.upsertBot(StoredBotRecord(id: "bot-b", name: "Other", createdAt: 1, rawJSON: "{}"))
        try await fixture.database.upsertThread(
            ThreadRecord(id: "thread-b", title: "Other", botId: "bot-b", createdAt: 1, updatedAt: 1)
        )
        try await fixture.context.register(
            MacBotExecutionProfile(id: "bot-a", threadId: "thread-a", engineId: "desktop-fixture")
        )
        await #expect(throws: NativeDesktopChatError.threadNotOwned(threadId: "thread-b")) {
            _ = try await fixture.service.send(botId: "bot-a", threadId: "thread-b", text: "hello")
        }
    }

    @Test("Missing engine credentials hold the message instead of running it")
    func missingCredentialsHeld() async throws {
        let fixture = try await makeFixture(credentials: UnavailableNativeServiceCredentials())
        defer { fixture.cleanup() }
        try await fixture.switchBotToNative()
        try await fixture.context.register(
            MacBotExecutionProfile(id: "bot-a", threadId: "thread-a", engineId: "desktop-fixture")
        )
        await #expect(throws: NativeDesktopChatError.held(.credentialsUnavailable)) {
            _ = try await fixture.service.send(botId: "bot-a", threadId: "thread-a", text: "hello")
        }
        #expect(await fixture.engine.prompts.isEmpty)
    }

    @Test("A bot the Node harness still owns is fenced, never switched")
    func nodeOwnedBotFenced() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        try await fixture.context.register(
            MacBotExecutionProfile(id: "bot-a", threadId: "thread-a", engineId: "desktop-fixture")
        )
        await #expect(throws: NativeDesktopChatError.runtimeNotNative(botId: "bot-a")) {
            _ = try await fixture.service.send(botId: "bot-a", threadId: "thread-a", text: "hello")
        }
        #expect(await fixture.engineSwitch.owner(for: "bot-a") == .nodeHarness)
        #expect(await fixture.engine.prompts.isEmpty)
    }

    @Test("Wait admission still resolves through the shared turn rule")
    func waitAdmissionUnchanged() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        try await fixture.context.register(
            MacBotExecutionProfile(id: "bot-a", threadId: "thread-a", engineId: "desktop-fixture")
        )
        let ready = try await fixture.context.resolveTurn(botId: "bot-a", threadId: "thread-a", prompt: "go")
        guard case .ready(let input) = ready else {
            Issue.record("expected a ready admission")
            return
        }
        #expect(input.botId == "bot-a")
        #expect(input.threadId == "thread-a")
        #expect(input.prompt == "go")
        #expect(input.environment["FIXTURE_TOKEN"] == "present")

        let wrongThread = try await fixture.context.resolveTurn(botId: "bot-a", threadId: "thread-x", prompt: "go")
        guard case .held(.credentialsUnavailable) = wrongThread else {
            Issue.record("a thread other than the registered one must be held")
            return
        }
    }

    // MARK: - Fixture

    private struct Fixture {
        let base: URL
        let database: DatabaseService
        let engine: DesktopFixtureEngine
        let coordinator: EngineCoordinatorActor
        let engineSwitch: BotNativeEngineSwitchActor
        let context: MacExecutionContext
        let service: NativeDesktopChatService

        func switchBotToNative() async throws {
            let thread = ThreadRecord(id: "thread-a", title: "Fixture", botId: "bot-a", createdAt: 1, updatedAt: 1)
            _ = try await engineSwitch.switchToNativeSwift(
                botId: "bot-a",
                historySnapshot: BotHistoryImportSnapshot(botId: "bot-a", threads: [thread], messagesByThread: [:])
            )
        }

        func cleanup() { try? FileManager.default.removeItem(at: base) }
    }

    private func makeFixture(
        credentials: any NativeServiceCredentialSource = FixtureCredentials()
    ) async throws -> Fixture {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("desktop-chat-\(UUID().uuidString)", isDirectory: true)
        let workspacesRoot = base.appendingPathComponent("workspaces", isDirectory: true)
        let database = try DatabaseService(path: ":memory:")
        try await database.upsertBot(StoredBotRecord(id: "bot-a", name: "Fixture", createdAt: 1, rawJSON: "{}"))
        try await database.upsertThread(
            ThreadRecord(id: "thread-a", title: "Fixture", botId: "bot-a", createdAt: 1, updatedAt: 1)
        )
        let engine = DesktopFixtureEngine()
        let coordinator = EngineCoordinatorActor(
            drivers: [engine],
            botFallbackChains: ["bot-a": ["desktop-fixture"]],
            dispatcher: TurnDispatcherActor(database: database, maxRetriesPerEngine: 0, requiresDurablePersistence: true)
        )
        let engineSwitch = BotNativeEngineSwitchActor(database: database)
        let context = MacExecutionContext(
            workspaceSource: DatabaseBotWorkspaceSource(database: database, workspacesRoot: workspacesRoot),
            credentials: credentials
        )
        let service = NativeDesktopChatService(
            database: database,
            executionContext: context,
            engineCoordinator: coordinator,
            engineSwitch: engineSwitch
        )
        return Fixture(
            base: base, database: database, engine: engine, coordinator: coordinator,
            engineSwitch: engineSwitch, context: context, service: service
        )
    }
}

private struct FixtureCredentials: NativeServiceCredentialSource {
    func credentials(forBotId botId: String) async throws -> NativeServiceCredentialResult {
        .available(environment: ["FIXTURE_TOKEN": "present"])
    }
}

private actor DesktopFixtureEngine: EngineDriver {
    nonisolated let engineId = "desktop-fixture"
    private(set) var prompts: [String] = []
    private(set) var workingDirectories: [String?] = []

    func sendTurn(input: TurnInput) async throws -> AsyncStream<TurnEvent> {
        prompts.append(input.prompt)
        workingDirectories.append(input.workingDirectory)
        return AsyncStream { continuation in
            continuation.yield(.textDelta("hi from the native engine"))
            continuation.yield(.completed(stopReason: "end_turn", inputTokens: 1, outputTokens: 1))
            continuation.finish()
        }
    }

    func cancelTurn(threadId: String) async {}
}
