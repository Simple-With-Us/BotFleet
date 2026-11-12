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

    @Test("Injected coordinator and supervisor counts feed the runtime drain counters")
    func runtimeExposesDrainCounters() async throws {
        let fixture = try await makeFixture()
        defer { fixture.cleanup() }
        let gate = TurnGate()
        let gatedEngine = GatedFixtureEngine(gate: gate)
        let turnCoordinator = EngineCoordinatorActor(
            drivers: [gatedEngine], botFallbackChains: ["bot-a": ["gated"]]
        )
        let supervisor = ProcessSupervisorActor(config: .testing)
        let graph = NativeMacCompanionRuntime(
            database: fixture.database,
            workspacesRoot: fixture.workspacesRoot,
            engineCoordinator: turnCoordinator,
            engineSwitch: fixture.engineSwitch,
            processSupervisor: supervisor
        )
        // Idle counters read zero: the drain path skips waiting when idle.
        #expect(await graph.activeEngineTurnCount() == 0)
        #expect(await graph.activeProcessCount() == 0)
        #expect(await turnCoordinator.activeTurnCount() == 0)

        // A dispatched turn holds its count until its stream is consumed.
        let stream = try await turnCoordinator.sendTurn(
            input: TurnInput(threadId: "thread-a", botId: "bot-a", prompt: "hold the turn open")
        )
        #expect(await turnCoordinator.activeTurnCount() == 1)
        #expect(await graph.activeEngineTurnCount() == 1)
        await gate.open()
        for await _ in stream {}
        #expect(await turnCoordinator.activeTurnCount() == 0)
        #expect(await graph.activeEngineTurnCount() == 0)

        #if os(macOS)
        // A supervised process feeds the same counters through the runtime.
        let session = try await supervisor.launch(
            spec: EngineSpawnSpec(executable: "/bin/sh", arguments: ["-c", "echo READY; /bin/sleep 30"]),
            threadId: "drain-counter-thread",
            engineId: "drain-counter"
        )
        var iterator = session.stdoutLines.makeAsyncIterator()
        _ = await iterator.next()
        #expect(await supervisor.activeProcessCount() == 1)
        #expect(await graph.activeProcessCount() == 1)
        await supervisor.cancel(threadId: "drain-counter-thread")
        _ = await session.waitForExit()
        #expect(await supervisor.activeProcessCount() == 0)
        #expect(await graph.activeProcessCount() == 0)
        #endif

        await graph.runtime.shutdown()
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

/// One-shot gate holding a turn open until the test lets it finish.
/// Opening before the engine waits still releases it, so no rendezvous
/// with the dispatch pipeline is needed.
private actor TurnGate {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var opened = false

    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        opened = true
        let pending = waiters
        waiters.removeAll()
        for waiter in pending { waiter.resume(returning: ()) }
    }
}

private actor GatedFixtureEngine: EngineDriver {
    nonisolated let engineId = "gated"
    let gate: TurnGate

    init(gate: TurnGate) {
        self.gate = gate
    }

    func sendTurn(input: TurnInput) async throws -> AsyncStream<TurnEvent> {
        await gate.wait()
        return AsyncStream { continuation in
            continuation.yield(.completed(stopReason: "end_turn", inputTokens: 1, outputTokens: 1))
            continuation.finish()
        }
    }

    func cancelTurn(threadId: String) async {}
}
