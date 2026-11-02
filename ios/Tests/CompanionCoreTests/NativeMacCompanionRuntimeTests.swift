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
            engineSwitch: fixture.engineSwitch,
            executionContext: MacRuntimeReadyExecutionContext()
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

    @Test("The production Mac graph admission-holds a satisfied wait without claiming it")
    func productionGraphHoldsUnclaimed() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        // Exactly the MacSession composition: no injected coordinator,
        // engine switch or execution context, so no driver can run a turn.
        let graph = NativeMacCompanionRuntime(
            database: fixture.database,
            workspacesRoot: fixture.workspacesRoot
        )
        let token = "bf_tok_mac_runtime_held"
        let server = NativeCompanionServer(
            database: fixture.database, pairedTokens: [token], nativeRuntime: graph.runtime
        )
        #expect(try await server.startListening(port: 0) != nil)

        let created = await server.handleRequest(CompanionHTTPRequest(
            method: "POST",
            path: "/api/waits",
            headers: ["Authorization": "Bearer \(token)"],
            jsonString: "{\"botId\":\"bot-a\",\"threadId\":\"thread-a\",\"prompt\":\"continue\",\"predicate\":{\"kind\":\"fileExists\",\"relativePath\":\"output/complete.json\"}}"
        ))
        #expect(created.statusCode == 201)
        let wait = try created.decodeJSON(NativeEventWait.self)

        #expect(try await graph.runtime.tick().isEmpty)
        let outputFile = fixture.workspacesRoot
            .appendingPathComponent("bot-a", isDirectory: true)
            .appendingPathComponent("output", isDirectory: true)
            .appendingPathComponent("complete.json")
        try FileManager.default.createDirectory(
            at: outputFile.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try Data("{}".utf8).write(to: outputFile)

        #expect(try await graph.runtime.tick() == [wait.id])
        await graph.runtime.waitRegistry.waitForDispatches()
        // Held at admission as typed, unclaimed work: no dispatch claim was
        // written, so a later composition with real drivers can resume it.
        let held = await graph.runtime.waitRegistry.wait(id: wait.id)
        #expect(held?.status == .held)
        #expect(held?.admissionHold == .credentialsUnavailable)
        #expect(try await !fixture.database.hasNativeEventWaitDispatchClaim(id: wait.id))
        #expect(try await graph.runtime.tick().isEmpty)
        #expect(await graph.runtime.waitRegistry.wait(id: wait.id)?.status == .held)

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

    @Test("The workspace source caches registered bots and refreshes only on a miss")
    func workspaceSourceCachesBotTable() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        let source = DatabaseBotWorkspaceSource(database: fixture.database, workspacesRoot: fixture.workspacesRoot)

        #expect(try await source.workspaceRoot(forRegisteredBotId: "bot-a") != nil)
        // A bot registered after the first load resolves via the miss refresh.
        try await fixture.database.upsertBot(StoredBotRecord(id: "bot-b", name: "Second", createdAt: 1, rawJSON: "{}"))
        #expect(try await source.workspaceRoot(forRegisteredBotId: "bot-b") != nil)

        // Cached hits need no database at all; a miss still reloads (and so
        // surfaces the closed database instead of serving from the cache).
        try await fixture.database.checkpointAndClose()
        #expect(try await source.workspaceRoot(forRegisteredBotId: "bot-a") != nil)
        await #expect(throws: (any Error).self) {
            _ = try await source.workspaceRoot(forRegisteredBotId: "bot-unknown")
        }
    }

    @Test("An expired bot-id cache entry revalidates against the database")
    func workspaceSourceCacheExpires() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        let source = DatabaseBotWorkspaceSource(
            database: fixture.database,
            workspacesRoot: fixture.workspacesRoot,
            botIdCacheTTL: 0
        )

        #expect(try await source.workspaceRoot(forRegisteredBotId: "bot-a") != nil)
        // With a zero TTL the next probe must reload, surfacing the closed
        // database instead of serving the stale cached hit forever.
        try await fixture.database.checkpointAndClose()
        await #expect(throws: (any Error).self) {
            _ = try await source.workspaceRoot(forRegisteredBotId: "bot-a")
        }
    }

    @Test("Deactivating polling is not terminal: activate can restart it")
    func pollingDeactivateIsNotTerminal() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        let graph = NativeMacCompanionRuntime(
            database: fixture.database,
            workspacesRoot: fixture.workspacesRoot,
            engineCoordinator: fixture.coordinator,
            engineSwitch: fixture.engineSwitch
        )
        try await graph.runtime.activate(pollIntervalSeconds: 1)
        await graph.runtime.deactivatePolling()
        try await graph.runtime.activate(pollIntervalSeconds: 1)
        await graph.runtime.shutdown()
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

/// Admits every wait as a bare turn, mirroring a future Mac execution
/// context that resolves ready work for its registered drivers.
private struct MacRuntimeReadyExecutionContext: NativeExecutionContextSource {
    func resolve(wait: NativeEventWait) async throws -> NativeExecutionAdmission {
        .ready(TurnInput(threadId: wait.threadId ?? "", botId: wait.botId, prompt: wait.prompt ?? ""))
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
