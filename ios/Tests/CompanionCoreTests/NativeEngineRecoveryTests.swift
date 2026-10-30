import Foundation
import Testing
@testable import CompanionCore

@Suite("Native Usage Limit Recovery")
struct NativeEngineRecoveryTests {
    @Test("Concurrency has a short retry while explicit quota retains its reset")
    func classification() {
        #expect(NativeEngineLimitClassifier.classify(code: "rpc_error", message: "HTTP 429: concurrency limit reached; retry after 120 seconds") ==
                NativeEngineLimit(kind: .capacity, retryAfterSeconds: 120))
        #expect(NativeEngineLimitClassifier.classify(code: "rate_limited", message: "retry-after: 0")?.retryAfterSeconds == 1)
        #expect(NativeEngineLimitClassifier.classify(code: "rpc_error", message: "Weekly usage limit reached; resets in 2 hours") ==
                NativeEngineLimit(kind: .quota, retryAfterSeconds: 7_200))
        #expect(NativeEngineLimitClassifier.classify(code: "rpc_error", message: "Session limit reached; resets in 1 minute")?.kind == .capacity)
        #expect(NativeEngineLimitClassifier.classify(code: "rate_limited", message: "retry-after: 120.")?.retryAfterSeconds == 120)
        #expect(NativeEngineLimitClassifier.classify(code: "rate_limited", message: "retry after 120 requests")?.retryAfterSeconds == 5)
        #expect(NativeEngineLimitClassifier.classify(code: "auth_required", message: "Sign in required") == nil)
        for token in ["quota_exceeded", "usage_limit_exceeded", "enforced_spend_limit_reached", "insufficient_quota", "insufficient_balance", "insufficient_funds"] {
            #expect(NativeEngineLimitClassifier.classify(code: "rate_limited", message: "HTTP 429: \(token)")?.kind == .quota)
            #expect(NativeEngineLimitClassifier.classify(code: token, message: "Provider refused the request")?.kind == .quota)
        }
        #expect(!NativeEngineLimitClassifier.isWorkTool("hookRun: inProgress"))
        #expect(!NativeEngineLimitClassifier.isWorkTool("reminderChild"))
        #expect(!NativeEngineLimitClassifier.isWorkTool("subagent"))
        #expect(!NativeEngineLimitClassifier.isWorkTool("subagent: completed"))
        #expect(!NativeEngineLimitClassifier.isWorkTool("spawn_agent"))
        #expect(NativeEngineLimitClassifier.isWorkTool("workflowSearch"))
        #expect(NativeEngineLimitClassifier.isWorkTool("bash"))
    }

    @Test("Only another active bot on the exact model route suppresses a capacity hold")
    func healthySibling() async {
        let recovery = NativeEngineRecoveryActor()
        let now = Date()
        let route = NativeEngineRoute(botId: "a", engineId: "muse", modelId: "wonder")
        let peer = NativeEngineRoute(botId: "b", engineId: "muse", modelId: "wonder")
        let otherModel = NativeEngineRoute(botId: "c", engineId: "muse", modelId: "spark")
        let capacity = NativeEngineLimit(kind: .capacity, retryAfterSeconds: 120)
        await recovery.markHealthy(route: otherModel, now: now)
        #expect(await recovery.recordFailure(route: route, limit: capacity, activeSiblingBots: ["c"], now: now) != nil)
        await recovery.markHealthy(route: peer, now: now.addingTimeInterval(1))
        #expect(await recovery.hold(for: route, now: now.addingTimeInterval(1)) == nil)
        #expect(await recovery.recordFailure(route: route, limit: capacity, activeSiblingBots: ["b"], now: now.addingTimeInterval(2)) == nil)
        #expect(await recovery.recordFailure(route: route, limit: capacity, activeSiblingBots: [], now: now.addingTimeInterval(3)) != nil)
        #expect(await recovery.hold(for: route, now: now.addingTimeInterval(124)) == nil)
    }

    @Test("Own stale activity cannot clear quota, and only quota survives restart")
    func persistedQuota() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("bf-recovery-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storage = directory.appendingPathComponent("holds.json")
        let recovery = NativeEngineRecoveryActor(storageURL: storage)
        let route = NativeEngineRoute(botId: "a", engineId: "muse", modelId: "wonder")
        await recovery.markHealthy(route: route)
        #expect(await recovery.recordFailure(route: route, limit: .init(kind: .capacity, retryAfterSeconds: 120), activeSiblingBots: ["a"]) != nil)
        await recovery.recordFailure(route: route, limit: .init(kind: .quota, retryAfterSeconds: 3_600))
        await recovery.markHealthy(route: .init(botId: "b", engineId: "muse", modelId: "wonder"))
        #expect(await recovery.hold(for: route)?.kind == .quota)
        await recovery.recordFailure(route: route, limit: .init(kind: .capacity, retryAfterSeconds: 1))
        #expect(await recovery.hold(for: route)?.kind == .quota)
        await recovery.recordFailure(route: .init(botId: "c", engineId: "grok", modelId: nil), limit: .init(kind: .capacity, retryAfterSeconds: 120))
        let restored = NativeEngineRecoveryActor(storageURL: storage)
        #expect(await restored.snapshot().count == 1)
        #expect(await restored.hold(for: route)?.kind == .quota)
        #expect(await recovery.persistenceFailed == false)
    }

    @Test("A repeated unnamed quota refusal never shortens an existing longer reset")
    func quotaResetCannotShorten() async {
        let recovery = NativeEngineRecoveryActor()
        let now = Date()
        let route = NativeEngineRoute(botId: "a", engineId: "claude", modelId: "opus")
        let first = await recovery.recordFailure(route: route, limit: .init(kind: .quota, retryAfterSeconds: 21_600), now: now)
        let unnamed = await recovery.recordFailure(route: route,
            limit: NativeEngineLimitClassifier.classify(code: "quota_exceeded", message: "Usage limit reached")!, now: now.addingTimeInterval(60))
        #expect(unnamed?.retryAt == first?.retryAt)
        let later = await recovery.recordFailure(route: route, limit: .init(kind: .quota, retryAfterSeconds: 43_200), now: now.addingTimeInterval(120))
        #expect(later?.retryAt == now.addingTimeInterval(43_320))
    }

    @Test("Usage refusal advances once, skips the held route next turn, and uses the backup's own defaults")
    func dispatcherRecovery() async throws {
        let primary = RecoveryFixtureEngine(id: "muse", turns: [[
            .error(code: "quota_exceeded", message: "Weekly usage limit reached"),
            .completed(stopReason: "error", inputTokens: nil, outputTokens: nil)
        ]])
        let backup = RecoveryFixtureEngine(id: "grok", turns: [[.textDelta("done"), .completed(stopReason: "end_turn", inputTokens: nil, outputTokens: nil)]])
        let dispatcher = TurnDispatcherActor(stallTimeoutSeconds: 1, retryDelaySeconds: 0)
        let coordinator = EngineCoordinatorActor(drivers: [primary, backup], botFallbackChains: ["bot": ["muse", "grok"]], dispatcher: dispatcher)
        for index in 0..<2 {
            let stream = try await coordinator.sendTurn(input: .init(threadId: "t\(index)", botId: "bot", prompt: "act", modelId: "muse-wonder", resumeSessionId: "muse-session"))
            var events: [TurnEvent] = []
            for await event in stream { events.append(event) }
            #expect(events.filter { if case .completed = $0 { return true }; return false }.count == 1)
        }
        #expect(await primary.recordedInputs().count == 1)
        let inputs = await backup.recordedInputs()
        #expect(inputs.count == 2)
        #expect(inputs.allSatisfy { $0.modelId == nil && $0.resumeSessionId == nil })
    }

    @Test("A quota error after a tool never replays the action on a fallback")
    func sideEffectsStaySingle() async throws {
        let primary = RecoveryFixtureEngine(id: "codex", turns: [[
            .toolCall(id: "effect", name: "write_file", argumentsJSON: "{}"),
            .error(code: "quota_exceeded", message: "Usage limit reached"),
            .completed(stopReason: "error", inputTokens: nil, outputTokens: nil)
        ]])
        let backup = RecoveryFixtureEngine(id: "grok", turns: [])
        let dispatcher = TurnDispatcherActor(retryDelaySeconds: 0)
        let stream = try await dispatcher.dispatchTurn(input: .init(threadId: "effect", botId: "bot", prompt: "write"), fallbackChain: [primary, backup])
        for await _ in stream {}
        #expect(await primary.recordedInputs().count == 1)
        #expect(await backup.recordedInputs().isEmpty)
    }

    @Test("A cancelled completion neither clears hard quota nor supplies sibling health or fallback")
    func cancelledCompletionIsNotHealthy() async throws {
        let recovery = NativeEngineRecoveryActor()
        let primary = RecoveryControlledEngine()
        let backup = RecoveryFixtureEngine(id: "backup", turns: [])
        let dispatcher = TurnDispatcherActor(stallTimeoutSeconds: 1, retryDelaySeconds: 0, recovery: recovery)
        let input = TurnInput(threadId: "cancelled", botId: "bot", prompt: "work", modelId: "model")
        let stream = try await dispatcher.dispatchTurn(input: input, fallbackChain: [primary, backup])
        let collected = Task { () -> [TurnEvent] in var events: [TurnEvent] = []; for await event in stream { events.append(event) }; return events }
        try await primary.waitForInputs(1)
        let own = NativeEngineRoute(botId: "bot", engineId: "controlled", modelId: "model")
        let peer = NativeEngineRoute(botId: "peer", engineId: "controlled", modelId: "model")
        await recovery.recordFailure(route: own, limit: .init(kind: .quota, retryAfterSeconds: 3_600))
        await recovery.recordFailure(route: peer, limit: .init(kind: .capacity, retryAfterSeconds: 120))
        await primary.finish(index: 0, reason: "cancelled")
        let events = await collected.value
        #expect(await recovery.hold(for: own)?.kind == .quota)
        #expect(await recovery.hold(for: peer)?.kind == .capacity)
        #expect(await backup.recordedInputs().isEmpty)
        #expect(events == [.error(code: "cancelled", message: "Engine turn was cancelled")])
    }

    @Test("A cancelled old dispatch cannot finish or cancel its replacement on the same thread")
    func dispatchGenerationOwnership() async throws {
        let primary = RecoveryControlledEngine(holdFirstStart: true)
        let dispatcher = TurnDispatcherActor(stallTimeoutSeconds: 1, retryDelaySeconds: 0)
        let input = TurnInput(threadId: "same-thread", botId: "bot", prompt: "old")
        let oldStream = try await dispatcher.dispatchTurn(input: input, fallbackChain: [primary])
        let oldReader = Task { for await _ in oldStream {} }
        try await primary.waitForInputs(1)
        await dispatcher.cancelTurn(threadId: input.threadId)
        let newStream = try await dispatcher.dispatchTurn(input: .init(threadId: input.threadId, botId: "bot", prompt: "new"), fallbackChain: [primary])
        let newReader = Task { for await _ in newStream {} }
        try await primary.waitForInputs(2)
        oldReader.cancel()
        await oldReader.value
        for _ in 0..<10 { await Task.yield() }
        #expect(await primary.cancellations == 1)
        await primary.releaseFirstStart()
        try await primary.waitForFirstStartReleased()
        for _ in 0..<10 { await Task.yield() }
        #expect(await dispatcher.isTurnActive(threadId: input.threadId))
        #expect(await dispatcher.isBotActive(botId: input.botId))
        do {
            _ = try await dispatcher.dispatchTurn(input: input, fallbackChain: [primary])
            Issue.record("An old dispatch removed its replacement's active-turn guard")
        } catch {
            guard let engineError = error as? EngineDriverError, case .turnAlreadyActive(let thread) = engineError else { Issue.record("Unexpected active-turn error"); return }
            #expect(thread == input.threadId)
        }
        await primary.finish(index: 1)
        await newReader.value
        #expect(await dispatcher.isTurnActive(threadId: input.threadId) == false)
    }
}

private actor RecoveryControlledEngine: EngineDriver {
    nonisolated let engineId = "controlled"
    private let holdFirstStart: Bool
    private var starts: [AsyncStream<TurnEvent>.Continuation] = []
    private var firstRelease: CheckedContinuation<Void, Never>?
    private var firstReleased = false
    private(set) var cancellations = 0
    init(holdFirstStart: Bool = false) { self.holdFirstStart = holdFirstStart }
    func sendTurn(input: TurnInput) async throws -> AsyncStream<TurnEvent> {
        let (stream, continuation) = AsyncStream<TurnEvent>.makeStream()
        starts.append(continuation)
        if starts.count == 1, holdFirstStart {
            await withCheckedContinuation { firstRelease = $0 }
            firstReleased = true
        }
        return stream
    }
    func cancelTurn(threadId: String) async { cancellations += 1 }
    func releaseFirstStart() { firstRelease?.resume(); firstRelease = nil }
    func finish(index: Int, reason: String = "end_turn") {
        starts[index].yield(.completed(stopReason: reason, inputTokens: nil, outputTokens: nil))
        starts[index].finish()
    }
    func waitForInputs(_ count: Int) async throws {
        for _ in 0..<300 {
            if starts.count >= count { return }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        Issue.record("A fixture dispatch did not start")
    }
    func waitForFirstStartReleased() async throws {
        for _ in 0..<300 {
            if firstReleased { return }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        Issue.record("The old dispatch did not release")
    }
}

private actor RecoveryFixtureEngine: EngineDriver {
    nonisolated let engineId: String
    private var turns: [[TurnEvent]]
    private var inputs: [TurnInput] = []
    init(id: String, turns: [[TurnEvent]]) { engineId = id; self.turns = turns }
    func sendTurn(input: TurnInput) async throws -> AsyncStream<TurnEvent> {
        inputs.append(input)
        let events = turns.isEmpty ? [.completed(stopReason: "end_turn", inputTokens: nil, outputTokens: nil)] : turns.removeFirst()
        return AsyncStream { continuation in
            for event in events { continuation.yield(event) }
            continuation.finish()
        }
    }
    func cancelTurn(threadId: String) async {}
    func recordedInputs() -> [TurnInput] { inputs }
}
