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
        #expect(await fixture.engineSwitch.owner(for: "bot-a") == .nativeSwift)
        // A stored bot that did not register is never moved.
        #expect(await fixture.engineSwitch.owner(for: "bot-b") == .nodeHarness)
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
        #expect(await fixture.engineSwitch.owner(for: "bot-b") == .nodeHarness)
    }

    @Test("A report naming a bot with no profile leaves it fenced")
    func reportedBotWithoutProfileStaysFenced() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }

        let start = try await fixture.chat(registered: ["bot-a"]).start()

        #expect(start.nativeBots.isEmpty)
        #expect(start.cutoverSkipped.map(\.botId) == ["bot-a"])
        #expect(await fixture.engineSwitch.owner(for: "bot-a") == .nodeHarness)
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

    // MARK: - Fixture

    private struct Fixture {
        let base: URL
        let database: DatabaseService
        let runtime: NativeMacCompanionRuntime
        let engine: ChatFixtureEngine

        var engineSwitch: BotNativeEngineSwitchActor { runtime.runtime.engineSwitch }

        func register(_ botId: String, thread threadId: String) async throws {
            try await runtime.registerBot(
                MacBotExecutionProfile(id: botId, threadId: threadId, engineId: ChatFixtureEngine.id),
                driver: engine
            )
        }

        func chat(registered: [String]) -> NativeDesktopChat {
            var report = MacBotRegistrationReport()
            report.registered = registered
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
