import Foundation
import Testing
@testable import CompanionCore

@Suite("Native runtime services composition")
struct NativeRuntimeServicesTests {
    @Test("The durable wait claim admits one dispatcher and stores acceptance first")
    func durableClaimHasOneWinner() async throws {
        let database = try DatabaseService(path: ":memory:")
        let dispatching = NativeEventWait(
            id: "wait-claim",
            botId: "bot-a",
            threadId: "thread-a",
            prompt: "continue",
            predicate: .botIdle,
            createdAt: 1,
            deadlineAt: 500,
            status: .dispatching,
            revision: 2
        )
        try await database.saveNativeEventWait(dispatching)

        #expect(try await database.claimNativeEventWaitDispatch(dispatching))
        try await database.replaceNativeEventWaitSnapshot([dispatching])
        #expect(try await database.loadNativeEventWaits().first?.status == .accepted)
        #expect(try await database.claimNativeEventWaitDispatch(dispatching) == false)
        #expect(try await database.loadNativeEventWaits().first?.status == .accepted)
    }

    @Test("A false local predicate never starts model work")
    func falsePredicateNeverDispatches() async throws {
        let database = try DatabaseService(path: ":memory:")
        try await insertBotAndThread(database)
        let engine = RuntimeServicesFixtureEngine()
        let coordinator = EngineCoordinatorActor(drivers: [engine], botFallbackChains: ["bot-a": ["fixture"]])
        let engineSwitch = BotNativeEngineSwitchActor(database: database)
        let runtime = NativeRuntimeServices(
            database: database,
            engineCoordinator: coordinator,
            engineSwitch: engineSwitch,
            workspaceSource: EmptyRuntimeWorkspaceSource(),
            processOwnershipSource: EmptyRuntimeProcessSource()
        )
        try await runtime.activate()
        _ = try await runtime.registerWait(
            botId: "bot-a",
            threadId: "thread-a",
            prompt: "continue only after file exists",
            predicate: .fileExists(relativePath: "output/complete.json")
        )

        #expect(try await runtime.tick().isEmpty)
        #expect(await engine.callCount == 0)
        await runtime.shutdown()
    }

    @Test("A matched durable wait dispatches once through the native coordinator")
    func composedWaitDispatchesOnce() async throws {
        let database = try DatabaseService(path: ":memory:")
        try await insertBotAndThread(database)
        let engine = RuntimeServicesFixtureEngine()
        let coordinator = EngineCoordinatorActor(drivers: [engine], botFallbackChains: ["bot-a": ["fixture"]])
        let engineSwitch = BotNativeEngineSwitchActor(database: database)
        try await switchBotToNative(engineSwitch: engineSwitch)
        let runtime = NativeRuntimeServices(
            database: database,
            engineCoordinator: coordinator,
            engineSwitch: engineSwitch,
            workspaceSource: EmptyRuntimeWorkspaceSource(),
            processOwnershipSource: EmptyRuntimeProcessSource()
        )
        try await runtime.activate()
        let wait = try await runtime.registerWait(
            botId: "bot-a",
            threadId: "thread-a",
            prompt: "continue",
            predicate: .botIdle
        )

        #expect(try await runtime.tick() == [wait.id])
        #expect(try await runtime.tick().isEmpty)
        await runtime.waitRegistry.waitForDispatches()
        #expect(await engine.callCount == 1)
        #expect(await runtime.waitRegistry.wait(id: wait.id)?.status == .completed)
        await runtime.shutdown()
    }

    @Test("An accepted dispatch recovered after restart stays held and is never replayed")
    func acceptedDispatchRecoversHeld() async throws {
        let database = try DatabaseService(path: ":memory:")
        try await insertBotAndThread(database)
        let accepted = NativeEventWait(
            id: "wait-accepted",
            botId: "bot-a",
            threadId: "thread-a",
            prompt: "already accepted",
            predicate: .botIdle,
            createdAt: 1,
            deadlineAt: Date().timeIntervalSince1970 + 600,
            status: .accepted,
            revision: 3
        )
        try await database.saveNativeEventWait(accepted)
        let engine = RuntimeServicesFixtureEngine()
        let coordinator = EngineCoordinatorActor(drivers: [engine], botFallbackChains: ["bot-a": ["fixture"]])
        let engineSwitch = BotNativeEngineSwitchActor(database: database)
        try await switchBotToNative(engineSwitch: engineSwitch)
        let runtime = NativeRuntimeServices(
            database: database,
            engineCoordinator: coordinator,
            engineSwitch: engineSwitch,
            workspaceSource: EmptyRuntimeWorkspaceSource(),
            processOwnershipSource: EmptyRuntimeProcessSource()
        )

        try await runtime.activate()
        let waits = try await runtime.listWaits(botId: "bot-a")
        #expect(waits.first?.status == .held)
        #expect(waits.first?.holdReason == "Dispatch outcome unknown after restart")
        #expect(await engine.callCount == 0)
        await runtime.shutdown()
    }

    @Test("Cancellation and shutdown prevent new wait dispatch")
    func cancellationAndShutdownFenceDispatch() async throws {
        let database = try DatabaseService(path: ":memory:")
        try await insertBotAndThread(database)
        let engine = RuntimeServicesFixtureEngine()
        let coordinator = EngineCoordinatorActor(drivers: [engine], botFallbackChains: ["bot-a": ["fixture"]])
        let engineSwitch = BotNativeEngineSwitchActor(database: database)
        try await switchBotToNative(engineSwitch: engineSwitch)
        let runtime = NativeRuntimeServices(
            database: database,
            engineCoordinator: coordinator,
            engineSwitch: engineSwitch,
            workspaceSource: EmptyRuntimeWorkspaceSource(),
            processOwnershipSource: EmptyRuntimeProcessSource()
        )
        try await runtime.activate()
        let cancelled = try await runtime.registerWait(
            botId: "bot-a", threadId: "thread-a", prompt: "cancel me", predicate: .botIdle
        )
        #expect(try await runtime.cancelWait(id: cancelled.id).status == .cancelled)
        #expect(try await runtime.tick().isEmpty)
        #expect(await engine.callCount == 0)
        await runtime.shutdown()
        await #expect(throws: NativeRuntimeServicesError.self) { try await runtime.tick() }
        #expect(await engine.callCount == 0)
    }

    @Test("Concurrent tick and cancel only returns a confirmed cancellation or conflict")
    func concurrentTickAndCancelKeepsDurableOutcome() async throws {
        let database = try DatabaseService(path: ":memory:")
        try await insertBotAndThread(database)
        let engine = RuntimeServicesFixtureEngine()
        let coordinator = EngineCoordinatorActor(drivers: [engine], botFallbackChains: ["bot-a": ["fixture"]])
        let engineSwitch = BotNativeEngineSwitchActor(database: database)
        try await switchBotToNative(engineSwitch: engineSwitch)
        let runtime = NativeRuntimeServices(
            database: database,
            engineCoordinator: coordinator,
            engineSwitch: engineSwitch,
            workspaceSource: EmptyRuntimeWorkspaceSource(),
            processOwnershipSource: EmptyRuntimeProcessSource()
        )
        try await runtime.activate()
        let wait = try await runtime.registerWait(
            botId: "bot-a", threadId: "thread-a", prompt: "continue", predicate: .botIdle
        )
        let token = "bf_tok_wait_race"
        let server = NativeCompanionServer(database: database, pairedTokens: [token], nativeRuntime: runtime)
        let deleteTask = Task {
            await server.handleRequest(CompanionHTTPRequest(
                method: "DELETE",
                path: "/api/waits/\(wait.id)",
                headers: ["Authorization": "Bearer \(token)"]
            ))
        }
        let tickTask = Task { try await runtime.tick() }

        _ = try await tickTask.value
        let response = await deleteTask.value
        await runtime.waitRegistry.waitForDispatches()
        let responseWait = try? response.decodeJSON(NativeEventWait.self)
        let finalWait = await runtime.waitRegistry.wait(id: wait.id)
        let persistedWait = try await database.loadNativeEventWaits().first { $0.id == wait.id }

        #expect(response.statusCode == 409 || (response.statusCode == 200 && responseWait?.status == .cancelled))
        #expect(finalWait != nil)
        #expect(persistedWait == finalWait)
        await server.stopListening()
        await runtime.shutdown()
    }

    @Test("Wait routes retain auth and stay absent when runtime composition is not injected")
    func waitRoutesRequireInjectedRuntimeAndBearer() async throws {
        let database = try DatabaseService(path: ":memory:")
        try await insertBotAndThread(database)
        let token = "bf_tok_wait_route"
        let engine = RuntimeServicesFixtureEngine()
        let coordinator = EngineCoordinatorActor(drivers: [engine], botFallbackChains: ["bot-a": ["fixture"]])
        let engineSwitch = BotNativeEngineSwitchActor(database: database)
        let runtime = NativeRuntimeServices(
            database: database,
            engineCoordinator: coordinator,
            engineSwitch: engineSwitch,
            workspaceSource: EmptyRuntimeWorkspaceSource(),
            processOwnershipSource: EmptyRuntimeProcessSource()
        )
        let server = NativeCompanionServer(database: database, pairedTokens: [token], nativeRuntime: runtime)
        let path = "/api/waits?botId=bot-a"
        let unauthorized = await server.handleRequest(CompanionHTTPRequest(method: "GET", path: path))
        #expect(unauthorized.statusCode == 401)
        let absentRuntime = NativeCompanionServer(database: database, pairedTokens: [token])
        let absent = await absentRuntime.handleRequest(
            CompanionHTTPRequest(method: "GET", path: path, headers: ["Authorization": "Bearer \(token)"])
        )
        #expect(absent.statusCode == 404)
        #expect(absent.bodyString.contains("no_route"))

        #expect(try await server.startListening(port: 0) != nil)

        let headers = ["Authorization": "Bearer \(token)"]
        let created = await server.handleRequest(CompanionHTTPRequest(
            method: "POST",
            path: "/api/waits",
            headers: headers,
            jsonString: "{\"botId\":\"bot-a\",\"threadId\":\"thread-a\",\"prompt\":\"continue\",\"predicate\":{\"kind\":\"fileExists\",\"relativePath\":\"output/complete.json\"}}"
        ))
        #expect(created.statusCode == 201)
        let wait = try created.decodeJSON(NativeEventWait.self)
        let listed = await server.handleRequest(CompanionHTTPRequest(method: "GET", path: path, headers: headers))
        #expect(try listed.decodeJSON([NativeEventWait].self).map(\.id) == [wait.id])
        let cancelled = await server.handleRequest(CompanionHTTPRequest(method: "DELETE", path: "/api/waits/\(wait.id)", headers: headers))
        #expect(cancelled.statusCode == 200)
        #expect(try cancelled.decodeJSON(NativeEventWait.self).status == .cancelled)

        await server.stopListening()
        #expect(try await server.startListening(port: 0) != nil)
        let afterRestart = await server.handleRequest(CompanionHTTPRequest(
            method: "POST",
            path: "/api/waits",
            headers: headers,
            jsonString: "{\"botId\":\"bot-a\",\"threadId\":\"thread-a\",\"prompt\":\"continue after listener restart\",\"predicate\":{\"kind\":\"fileExists\",\"relativePath\":\"output/complete.json\"}}"
        ))
        #expect(afterRestart.statusCode == 201)
        #expect(try afterRestart.decodeJSON(NativeEventWait.self).status == .pending)

        await server.stopListening()
        await runtime.shutdown()
    }

    private func insertBotAndThread(_ database: DatabaseService) async throws {
        try await database.upsertBot(StoredBotRecord(id: "bot-a", name: "Fixture", createdAt: 1, rawJSON: "{}"))
        try await database.upsertThread(ThreadRecord(id: "thread-a", title: "Fixture", botId: "bot-a", createdAt: 1, updatedAt: 1))
    }

    private func switchBotToNative(engineSwitch: BotNativeEngineSwitchActor) async throws {
        let thread = ThreadRecord(id: "thread-a", title: "Fixture", botId: "bot-a", createdAt: 1, updatedAt: 1)
        _ = try await engineSwitch.switchToNativeSwift(
            botId: "bot-a",
            historySnapshot: BotHistoryImportSnapshot(botId: "bot-a", threads: [thread], messagesByThread: [:])
        )
    }
}

private actor RuntimeServicesFixtureEngine: EngineDriver {
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

private struct EmptyRuntimeWorkspaceSource: NativeEventWaitWorkspaceSource {
    func workspaceRoot(forRegisteredBotId botId: String) async throws -> URL? { nil }
}

private struct EmptyRuntimeProcessSource: NativeEventWaitProcessOwnershipSource {
    func hasFinishedProcess(pid: Int32, startTime: Double, ownedByBotId botId: String) async -> Bool { false }
}
