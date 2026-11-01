import Foundation
import Testing
@testable import CompanionCore

@Suite("Mac companion listener runtime composition")
struct NativeMacCompanionRuntimeTests {
    @Test("The MacSession-built graph registers, polls and dispatches a file wait exactly once")
    func macCompositionDispatchesOnce() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        let graph = NativeMacCompanionRuntime(
            database: fixture.database,
            workspacesRoot: fixture.workspacesRoot,
            engineCoordinator: fixture.coordinator,
            engineSwitch: fixture.engineSwitch
        )
        let token = "bf_tok_mac_runtime"
        let server = NativeCompanionServer(
            database: fixture.database, pairedTokens: [token], nativeRuntime: graph.runtime
        )
        // Listening activates the runtime, as in the Mac listener backend.
        #expect(try await server.startListening(port: 0) != nil)

        let headers = ["Authorization": "Bearer \(token)"]
        let created = await server.handleRequest(CompanionHTTPRequest(
            method: "POST",
            path: "/api/waits",
            headers: headers,
            jsonString: "{\"botId\":\"bot-a\",\"threadId\":\"thread-a\",\"prompt\":\"continue\",\"predicate\":{\"kind\":\"fileExists\",\"relativePath\":\"output/complete.json\"}}"
        ))
        // The injected runtime serves the route: neither the absent-runtime
        // no_route (404) nor the inactive-runtime 503.
        #expect(created.statusCode == 201)
        let wait = try created.decodeJSON(NativeEventWait.self)

        // Poll before the file exists: the production workspace source
        // confines the probe to the bot's workspace and finds nothing.
        #expect(try await graph.runtime.tick().isEmpty)
        #expect(await fixture.engine.callCount == 0)

        let outputFile = fixture.workspacesRoot
            .appendingPathComponent("bot-a", isDirectory: true)
            .appendingPathComponent("output", isDirectory: true)
            .appendingPathComponent("complete.json")
        try FileManager.default.createDirectory(
            at: outputFile.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try Data("{}".utf8).write(to: outputFile)

        #expect(try await graph.runtime.tick() == [wait.id])
        #expect(try await graph.runtime.tick().isEmpty)
        await graph.runtime.waitRegistry.waitForDispatches()
        #expect(await fixture.engine.callCount == 1)
        #expect(await graph.runtime.waitRegistry.wait(id: wait.id)?.status == .completed)

        await server.stopListening()
        await graph.runtime.shutdown()
    }

    @Test("The production workspace source only serves registered bots inside its root")
    func workspaceSourceConfinesToRegisteredBots() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        let source = DatabaseBotWorkspaceSource(database: fixture.database, workspacesRoot: fixture.workspacesRoot)

        let root = try await source.workspaceRoot(forRegisteredBotId: "bot-a")
        let resolvedRoot = fixture.workspacesRoot.standardizedFileURL.resolvingSymlinksInPath().path
        #expect(root?.path == resolvedRoot + "/bot-a")
        #expect(try await source.workspaceRoot(forRegisteredBotId: "bot-unknown") == nil)
        #expect(try await source.workspaceRoot(forRegisteredBotId: "../escape") == nil)
    }

    private struct Fixture {
        let base: URL
        let workspacesRoot: URL
        let database: DatabaseService
        let engine: MacRuntimeFixtureEngine
        let coordinator: EngineCoordinatorActor
        let engineSwitch: BotNativeEngineSwitchActor

        func cleanup() { try? FileManager.default.removeItem(at: base) }
    }

    private func makeFixture() async throws -> Fixture {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("mac-companion-runtime-\(UUID().uuidString)", isDirectory: true)
        let workspacesRoot = base.appendingPathComponent("workspaces", isDirectory: true)
        let database = try DatabaseService(path: ":memory:")
        try await database.upsertBot(StoredBotRecord(id: "bot-a", name: "Fixture", createdAt: 1, rawJSON: "{}"))
        let thread = ThreadRecord(id: "thread-a", title: "Fixture", botId: "bot-a", createdAt: 1, updatedAt: 1)
        try await database.upsertThread(thread)
        let engine = MacRuntimeFixtureEngine()
        let coordinator = EngineCoordinatorActor(drivers: [engine], botFallbackChains: ["bot-a": ["fixture"]])
        let engineSwitch = BotNativeEngineSwitchActor(database: database)
        _ = try await engineSwitch.switchToNativeSwift(
            botId: "bot-a",
            historySnapshot: BotHistoryImportSnapshot(botId: "bot-a", threads: [thread], messagesByThread: [:])
        )
        return Fixture(
            base: base, workspacesRoot: workspacesRoot, database: database,
            engine: engine, coordinator: coordinator, engineSwitch: engineSwitch
        )
    }
}

private actor MacRuntimeFixtureEngine: EngineDriver {
    nonisolated let engineId = "fixture"
    private(set) var callCount = 0

    func sendTurn(input: TurnInput) async throws -> AsyncStream<TurnEvent> {
        callCount += 1
        return AsyncStream { continuation in
            continuation.yield(.textDelta("done"))
            continuation.yield(.completed(stopReason: "end_turn", inputTokens: 1, outputTokens: 1))
            continuation.finish()
        }
    }

    func cancelTurn(threadId: String) async {}
}
