import Foundation
import Testing
@testable import CompanionCore

@Suite("Native Mac Port-Inventory Services & Execution Context (BF-2689)")
struct NativeMacServicesParityTests {
    // MARK: - CostLedgerService (BF-2619)

    @Test("CostLedgerService records idempotently, rejects invalid numbers, enforces ceiling, and reloads 0600 JSON")
    func costLedgerLifecycleAndCeiling() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("cost-ledger-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let fileURL = dir.appendingPathComponent("cost-ledger.json")

        let ledger = try CostLedgerService(storageURL: fileURL)
        let t0 = Date(timeIntervalSince1970: 1_700_000_000)

        let entry1 = CostLedgerEntry(
            id: "call-1",
            botId: "bot-a",
            threadId: "thread-a",
            provider: "anthropic",
            model: "claude-sonnet",
            inputTokens: 1_000,
            outputTokens: 250,
            cachedInputTokens: 400,
            estimatedCostUSD: 1.50,
            recordedAt: t0.timeIntervalSince1970
        )
        try await ledger.record(entry1)
        // Idempotent duplicate ID does not double-count.
        try await ledger.record(entry1)

        try await ledger.record(CostLedgerEntry(
            id: "call-2",
            botId: "bot-b",
            threadId: "thread-b",
            provider: "openai",
            model: "gpt-5",
            inputTokens: 500,
            outputTokens: 100,
            estimatedCostUSD: 2.00,
            recordedAt: t0.addingTimeInterval(300).timeIntervalSince1970
        ))

        await #expect(throws: CostLedgerError.self) {
            try await ledger.record(CostLedgerEntry(
                id: "call-bad-cost",
                botId: "bot-a",
                threadId: "thread-a",
                provider: "anthropic",
                model: "claude-sonnet",
                inputTokens: 10,
                outputTokens: 5,
                estimatedCostUSD: -0.01,
                recordedAt: t0.timeIntervalSince1970
            ))
        }
        await #expect(throws: CostLedgerError.self) {
            try await ledger.record(CostLedgerEntry(
                id: "call-nan",
                botId: "bot-a",
                threadId: "thread-a",
                provider: "anthropic",
                model: "claude-sonnet",
                inputTokens: 10,
                outputTokens: 5,
                estimatedCostUSD: .nan,
                recordedAt: t0.timeIntervalSince1970
            ))
        }

        let botATotals = await ledger.totals(forBotId: "bot-a")
        #expect(botATotals.entryCount == 1)
        #expect(botATotals.inputTokens == 1_000)
        #expect(botATotals.outputTokens == 250)
        #expect(botATotals.cachedInputTokens == 400)
        #expect(abs(botATotals.totalCostUSD - 1.50) < 0.0001)

        let fleetTotals = await ledger.totals()
        #expect(fleetTotals.entryCount == 2)
        #expect(abs(fleetTotals.totalCostUSD - 3.50) < 0.0001)

        let now = t0.addingTimeInterval(600)
        let allowed = await ledger.checkAdmission(
            ceiling: RollingSpendCeiling(windowSeconds: 3_600, maxSpendUSD: 5.00),
            now: now
        )
        #expect(allowed == .allowed(remainingUSD: 1.50))

        let exceeded = await ledger.checkAdmission(
            ceiling: RollingSpendCeiling(windowSeconds: 3_600, maxSpendUSD: 3.00),
            now: now
        )
        #expect(exceeded == .exceeded(spentUSD: 3.50, ceilingUSD: 3.00))

        let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        let perms = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? -1
        #expect(perms == 0o600)

        let reloaded = try CostLedgerService(storageURL: fileURL)
        let reloadedTotals = await reloaded.totals()
        #expect(reloadedTotals == fleetTotals)
    }

    @Test("CostLedgerService keeps evicted IDs idempotent across reloads, counts future skew, and fails open on low priced share")
    func costLedgerRotationIdempotencyFutureSkewAndLowVisibility() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("cost-ledger-rot-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let fileURL = dir.appendingPathComponent("cost-ledger.json")

        let ledger = try CostLedgerService(storageURL: fileURL, maxEntries: 2, maxSeenIds: 10)
        let t0 = Date(timeIntervalSince1970: 1_700_000_500)

        for index in 1...3 {
            try await ledger.record(CostLedgerEntry(
                id: "turn-\(index)",
                botId: "bot-a",
                threadId: "thread-a",
                provider: "anthropic",
                model: "claude-sonnet",
                inputTokens: 100,
                outputTokens: 50,
                estimatedCostUSD: Double(index),
                isPriced: true,
                recordedAt: t0.addingTimeInterval(Double(index * 10)).timeIntervalSince1970
            ))
        }

        // turn-1 was evicted from retained storage (2, 3 remain), yet replay of turn-1 stays idempotent.
        try await ledger.record(CostLedgerEntry(
            id: "turn-1",
            botId: "bot-a",
            threadId: "thread-a",
            provider: "anthropic",
            model: "claude-sonnet",
            inputTokens: 100,
            outputTokens: 50,
            estimatedCostUSD: 99.0,
            isPriced: true,
            recordedAt: t0.addingTimeInterval(40).timeIntervalSince1970
        ))
        let afterReplay = await ledger.totals()
        #expect(afterReplay.entryCount == 2)
        #expect(abs(afterReplay.totalCostUSD - 5.0) < 0.0001)

        // Reload preserves seen-ID history across eviction too.
        let reloaded = try CostLedgerService(storageURL: fileURL, maxEntries: 2, maxSeenIds: 10)
        try await reloaded.record(CostLedgerEntry(
            id: "turn-1",
            botId: "bot-a",
            threadId: "thread-a",
            provider: "anthropic",
            model: "claude-sonnet",
            inputTokens: 100,
            outputTokens: 50,
            estimatedCostUSD: 99.0,
            isPriced: true,
            recordedAt: t0.addingTimeInterval(50).timeIntervalSince1970
        ))
        let reloadedTotals = await reloaded.totals()
        #expect(reloadedTotals.entryCount == 2)
        #expect(abs(reloadedTotals.totalCostUSD - 5.0) < 0.0001)

        // Overflow-safe init accepts Int.max without trapping.
        let unboundedLedger = CostLedgerService(maxEntries: .max)
        try await unboundedLedger.record(CostLedgerEntry(
            id: "max-bound-1",
            botId: "bot-a",
            threadId: "thread-a",
            provider: "anthropic",
            model: "claude-sonnet",
            inputTokens: 10,
            outputTokens: 5,
            estimatedCostUSD: 0.25,
            isPriced: true,
            recordedAt: t0.timeIntervalSince1970
        ), now: t0)
        #expect(await unboundedLedger.totals().entryCount == 1)

        // Small forward clock skew (<= 300 s) counts immediately and still ages out once now advances past window.
        let skewLedger = CostLedgerService(maxEntries: 10)
        await #expect(throws: CostLedgerError.self) {
            try await skewLedger.record(CostLedgerEntry(
                id: "skew-too-far",
                botId: "bot-a",
                threadId: "thread-a",
                provider: "anthropic",
                model: "claude-sonnet",
                inputTokens: 10,
                outputTokens: 5,
                estimatedCostUSD: 9.0,
                isPriced: true,
                recordedAt: t0.addingTimeInterval(CostLedgerService.defaultMaxFutureSkewSeconds + 1).timeIntervalSince1970
            ), now: t0)
        }
        try await skewLedger.record(CostLedgerEntry(
            id: "skew-1",
            botId: "bot-a",
            threadId: "thread-a",
            provider: "anthropic",
            model: "claude-sonnet",
            inputTokens: 10,
            outputTokens: 5,
            estimatedCostUSD: 4.0,
            isPriced: true,
            recordedAt: t0.addingTimeInterval(300).timeIntervalSince1970
        ), now: t0)
        let skewSpend = await skewLedger.rollingSpend(windowSeconds: 60, now: t0)
        #expect(abs(skewSpend - 4.0) < 0.0001)
        let expiredSkewSpend = await skewLedger.rollingSpend(windowSeconds: 60, now: t0.addingTimeInterval(361))
        #expect(abs(expiredSkewSpend - 0.0) < 0.0001)

        // Low priced share fails open (mirroring server/rolling-spend.ts spendCeilingDecision).
        try await skewLedger.record(CostLedgerEntry(
            id: "unpriced-1",
            botId: "bot-a",
            threadId: "thread-a",
            provider: "dsh",
            model: "dsh-1",
            inputTokens: 50,
            outputTokens: 20,
            estimatedCostUSD: 0.0,
            isPriced: false,
            recordedAt: t0.timeIntervalSince1970
        ))
        try await skewLedger.record(CostLedgerEntry(
            id: "unpriced-2",
            botId: "bot-a",
            threadId: "thread-a",
            provider: "dsh",
            model: "dsh-1",
            inputTokens: 50,
            outputTokens: 20,
            estimatedCostUSD: 0.0,
            isPriced: false,
            recordedAt: t0.addingTimeInterval(1).timeIntervalSince1970
        ))

        let lowVisibilityVerdict = await skewLedger.checkAdmission(
            ceiling: RollingSpendCeiling(windowSeconds: 600, maxSpendUSD: 3.0, minPricedShare: 0.5),
            now: t0.addingTimeInterval(10)
        )
        #expect(lowVisibilityVerdict.isAllowed == true)
        if case .allowedLowVisibility(let spent, let share, let unpricedTurns) = lowVisibilityVerdict {
            #expect(abs(spent - 4.0) < 0.0001)
            #expect(unpricedTurns == 2)
            #expect(share < 0.5)
        } else {
            Issue.record("Expected .allowedLowVisibility when pricedShare < 0.5")
        }

        let enforcedVerdict = await skewLedger.checkAdmission(
            ceiling: RollingSpendCeiling(windowSeconds: 600, maxSpendUSD: 3.0, minPricedShare: 0.25),
            now: t0.addingTimeInterval(10)
        )
        #expect(enforcedVerdict == .exceeded(spentUSD: 4.0, ceilingUSD: 3.0))
    }

    // MARK: - NativeFaultBannerStore (BF-2618)

    @Test("NativeFaultBannerStore redacts secrets, deduplicates within cooldown, acknowledges, and bounds retention")
    func faultBannerRedactionAndRetention() async {
        let store = NativeFaultBannerStore(maxEntries: 2, dedupWindowSeconds: 60)
        let t0 = Date(timeIntervalSince1970: 1_700_001_000)
        let xaiEnvKey = "XAI" + "_API_" + "KEY"
        let fakeClaude = "sk" + "-ant-" + String(repeating: "a", count: 24)
        let fakeXai = "xai" + "-" + String(repeating: "b", count: 24)

        let first = await store.record(
            source: "engine",
            code: "auth_failed",
            summary: "Rejected token \(fakeClaude)",
            detail: "\(xaiEnvKey)=\(fakeXai)",
            severity: .error,
            now: t0
        )
        #expect(!first.summary.contains(fakeClaude))
        #expect(first.summary.contains("«redacted"))
        #expect(!(first.detail ?? "").contains(fakeXai))
        #expect((first.detail ?? "").contains("«redacted"))

        // Duplicate within 60 s collapses to the existing banner.
        _ = await store.record(
            source: "engine",
            code: "auth_failed",
            summary: "Rejected token \(fakeClaude)",
            detail: "\(xaiEnvKey)=\(fakeXai)",
            severity: .error,
            now: t0.addingTimeInterval(15)
        )
        #expect(await store.activeBanners().count == 1)

        // Acknowledge first, add two more faults, verify maxEntries retention drops acknowledged first.
        #expect(await store.acknowledge(id: first.id))
        #expect(await store.activeBanners().isEmpty)

        let second = await store.record(source: "store", code: "wal_warn", summary: "WAL grew", now: t0.addingTimeInterval(70))
        let third = await store.record(source: "cua", code: "tcc_revoked", summary: "Capture stopped", severity: .critical, now: t0.addingTimeInterval(80))

        let all = await store.allFaults()
        #expect(all.count == 2)
        #expect(all.map(\.id) == [third.id, second.id])

        // Future-dated banner must not suppress a new fault recorded earlier.
        let skewStore = NativeFaultBannerStore(maxEntries: 5, dedupWindowSeconds: 60)
        let futureEntry = await skewStore.record(source: "net", code: "skew", summary: "Skewed", now: t0.addingTimeInterval(200))
        let earlierEntry = await skewStore.record(source: "net", code: "skew", summary: "Skewed", now: t0.addingTimeInterval(170))
        #expect(futureEntry.id != earlierEntry.id)
        #expect(await skewStore.activeBanners().count == 2)
    }

    // MARK: - PluginSandboxHost & NativeRecallClient (BF-2620)

    @Test("PluginSandboxHost confines directories and strips credential env keys case-insensitively")
    func pluginSandboxConfinementAndEnvScrub() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("plugin-sandbox-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let host = PluginSandboxHost(policy: PluginSandboxPolicy(sandboxRoot: root))
        let pluginDir = try await host.pluginDirectory(for: "zulip-wake")
        let canonicalRoot = root.standardizedFileURL.resolvingSymlinksInPath()
        #expect(pluginDir.path == canonicalRoot.path + "/zulip-wake")

        await #expect(throws: PluginSandboxError.self) {
            _ = try await host.pluginDirectory(for: "../escape")
        }
        await #expect(throws: PluginSandboxError.self) {
            _ = try await host.pluginDirectory(for: "")
        }

        let xaiUpper = "XAI" + "_API_" + "KEY"
        let xaiLower = "xai" + "_api_" + "key"
        let infisicalKey = "INFISICAL" + "_" + "TOKEN"
        let customSecretKey = "CUSTOM" + "_" + "SECRET"
        let nulValue = "abc" + String(UnicodeScalar(UInt8(0))) + "def"

        let env = await host.sanitizedEnvironment(
            from: [
                "PATH": "/usr/bin:/bin",
                "HOME": "/tmp/plugin-home",
                xaiUpper: "fixture-1",
                xaiLower: "fixture-2",
                infisicalKey: "fixture-3",
                "MY_CUSTOM_FLAG": "ok",
                customSecretKey: "fixture-4",
                "BAD_NUL": nulValue,
            ],
            additionalAllowedKeys: [xaiUpper, xaiLower, "MY_CUSTOM_FLAG", customSecretKey, "BAD_NUL"]
        )
        #expect(env["PATH"] == "/usr/bin:/bin")
        #expect(env["HOME"] == "/tmp/plugin-home")
        #expect(env["MY_CUSTOM_FLAG"] == "ok")
        #expect(env[xaiUpper] == nil)
        #expect(env[xaiLower] == nil)
        #expect(env[infisicalKey] == nil)
        #expect(env[customSecretKey] == nil)
        #expect(env["BAD_NUL"] == nil)
    }

    @Test("NativeRecallClient blocks suspected secrets preflight and tags hits untrusted")
    func recallClientSecretPreflightAndUntrustedTags() async throws {
        let transport = SpyRecallTransport()
        let client = NativeRecallClient(transport: transport)

        let fakeGitHub = "ghp" + "_" + String(repeating: "c", count: 24)
        await #expect(throws: NativeRecallError.suspectedSecretRefused(field: "query")) {
            _ = try await client.search(query: "lookup \(fakeGitHub)")
        }
        #expect(await transport.callCount == 0)

        let fakeServiceToken = ["st", ".", String(repeating: "d", count: 22), ".", String(repeating: "e", count: 18)].joined()
        await #expect(throws: NativeRecallError.suspectedSecretRefused(field: "app")) {
            _ = try await client.search(query: "botfleet architecture", app: fakeServiceToken)
        }
        #expect(await transport.callCount == 0)

        let oversizedQuery = String(repeating: "q", count: NativeRecallClient.maxQueryLength + 1)
        await #expect(throws: NativeRecallError.queryTooLong(maxLength: NativeRecallClient.maxQueryLength)) {
            _ = try await client.search(query: oversizedQuery)
        }
        #expect(await transport.callCount == 0)

        let oversizedApp = String(repeating: "a", count: NativeRecallClient.maxAppFilterLength + 1)
        await #expect(throws: NativeRecallError.appFilterTooLong(maxLength: NativeRecallClient.maxAppFilterLength)) {
            _ = try await client.search(query: "botfleet architecture", app: oversizedApp)
        }
        #expect(await transport.callCount == 0)

        let hits = try await client.search(query: "P-BF-6 hard cutover", app: "botfleet", limit: 99)
        #expect(await transport.callCount == 1)
        #expect(await transport.lastLimit == 10)
        #expect(hits.count == 1)
        #expect(hits[0].isUntrusted == true)
    }

    // MARK: - MacExecutionContext & NativeMacCompanionRuntime (BF-2689)

    @Test("MacExecutionContext fails closed without profile/credentials and dispatches registered turns end-to-end")
    func macExecutionContextAndRuntimeDispatch() async throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("mac-exec-ctx-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: base) }
        let workspacesRoot = base.appendingPathComponent("workspaces", isDirectory: true)

        let database = try DatabaseService(path: ":memory:")
        try await database.upsertBot(StoredBotRecord(id: "bot-a", name: "Bot A", createdAt: 1, rawJSON: "{}"))
        let thread = ThreadRecord(id: "thread-a", title: "Main", botId: "bot-a", createdAt: 1, updatedAt: 1)
        try await database.upsertThread(thread)

        let creds = StaticMacCredentialSource(result: .available(environment: ["CUSTOM_BOT_ENV": "1"]))
        let graph = NativeMacCompanionRuntime(
            database: database,
            workspacesRoot: workspacesRoot,
            credentials: creds
        )

        let sampleWait = NativeEventWait(
            botId: "bot-a",
            threadId: "thread-a",
            prompt: "run native check",
            predicate: .fileExists(relativePath: "done.flag"),
            createdAt: 1,
            deadlineAt: 600
        )

        // Before profile registration, admission stays held (fail closed).
        let beforeProfile = try await graph.macExecutionContext.resolve(wait: sampleWait)
        if case .held(.credentialsUnavailable) = beforeProfile {} else {
            Issue.record("Expected .held(.credentialsUnavailable) before profile registration")
        }

        // Register profile + engine driver, switch bot to nativeSwift, and verify end-to-end wait dispatch.
        let engine = SpyMacEngineDriver()
        try await graph.registerBot(
            MacBotExecutionProfile(id: "bot-a", threadId: "thread-a", engineId: "spy", modelId: "spy-1"),
            driver: engine
        )
        _ = try await graph.runtime.engineSwitch.switchToNativeSwift(
            botId: "bot-a",
            historySnapshot: BotHistoryImportSnapshot(botId: "bot-a", threads: [thread], messagesByThread: [:])
        )

        let afterProfile = try await graph.macExecutionContext.resolve(wait: sampleWait)
        if case .ready(let turnInput) = afterProfile {
            #expect(turnInput.modelId == "spy-1")
            #expect(turnInput.environment["CUSTOM_BOT_ENV"] == "1")
            #expect(turnInput.workingDirectory?.hasSuffix("/bot-a") == true)
        } else {
            Issue.record("Expected .ready admission once profile and credentials are registered")
        }

        try await graph.runtime.activate()
        let registeredWait = try await graph.runtime.registerWait(
            botId: "bot-a",
            threadId: "thread-a",
            prompt: "run native check",
            predicate: .fileExists(relativePath: "ready.txt")
        )
        let botWorkspace = workspacesRoot.appendingPathComponent("bot-a", isDirectory: true)
        try FileManager.default.createDirectory(at: botWorkspace, withIntermediateDirectories: true)
        try Data("ok".utf8).write(to: botWorkspace.appendingPathComponent("ready.txt"))

        #expect(try await graph.runtime.tick() == [registeredWait.id])
        await graph.runtime.waitRegistry.waitForDispatches()
        #expect(await engine.callCount == 1)
        #expect(await graph.runtime.waitRegistry.wait(id: registeredWait.id)?.status == .completed)

        await graph.runtime.shutdown()
    }

    @Test("MacExecutionContext holds on workspace errors or concurrent re-registration, and external override blocks registerBot")
    func macExecutionContextResilienceAndExternalOverride() async throws {
        let sampleWait = NativeEventWait(
            botId: "bot-a",
            threadId: "thread-a",
            prompt: "check",
            predicate: .fileExists(relativePath: "done.flag"),
            createdAt: 1,
            deadlineAt: 600
        )

        // Throwing workspace source fails closed with .held(.credentialsUnavailable), not a propagated error.
        let throwingCtx = MacExecutionContext(
            workspaceSource: ThrowingWorkspaceSource(),
            credentials: StaticMacCredentialSource(result: .available(environment: [:]))
        )
        try await throwingCtx.register(MacBotExecutionProfile(id: "bot-a", threadId: "thread-a", engineId: "spy"))
        let workspaceErrorAdmission = try await throwingCtx.resolve(wait: sampleWait)
        if case .held(.credentialsUnavailable) = workspaceErrorAdmission {} else {
            Issue.record("Expected .held(.credentialsUnavailable) when workspaceSource throws")
        }

        // Concurrent re-registration during credentials await returns .held instead of throwing .stopped.
        let suspendingCreds = SuspendingCredentialSource()
        let racingCtx = MacExecutionContext(
            workspaceSource: ThrowingWorkspaceSource(),
            credentials: suspendingCreds
        )
        try await racingCtx.register(MacBotExecutionProfile(id: "bot-a", threadId: "thread-a", engineId: "spy", modelId: "m1"))
        let resolveTask = Task {
            try await racingCtx.resolve(wait: sampleWait)
        }
        await suspendingCreds.waitUntilEntered()
        try await racingCtx.register(MacBotExecutionProfile(id: "bot-a", threadId: "thread-a", engineId: "spy", modelId: "m2"))
        await suspendingCreds.resume(with: .available(environment: [:]))
        let racingAdmission = try await resolveTask.value
        if case .held(.credentialsUnavailable) = racingAdmission {} else {
            Issue.record("Expected .held(.credentialsUnavailable) on concurrent profile replacement")
        }

        // External NativeExecutionContextSource injection rejects registerBot so active runtime stays consistent.
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("mac-exec-ext-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: base) }
        let database = try DatabaseService(path: ":memory:")
        let runtime = NativeMacCompanionRuntime(
            database: database,
            workspacesRoot: base,
            executionContext: ExternalStubExecutionContext()
        )
        await #expect(throws: MacExecutionContextError.externalExecutionContextActive) {
            try await runtime.registerBot(
                MacBotExecutionProfile(id: "bot-a", threadId: "thread-a", engineId: "spy"),
                driver: SpyMacEngineDriver()
            )
        }
    }
}

private enum WorkspaceStubError: Error {
    case unavailable
}

private struct ThrowingWorkspaceSource: NativeEventWaitWorkspaceSource {
    func workspaceRoot(forRegisteredBotId botId: String) async throws -> URL? {
        throw WorkspaceStubError.unavailable
    }
}

private struct ExternalStubExecutionContext: NativeExecutionContextSource {
    func resolve(wait: NativeEventWait) async throws -> NativeExecutionAdmission {
        .held(.credentialsUnavailable)
    }
}

private actor SuspendingCredentialSource: NativeServiceCredentialSource {
    private var entered = false
    private var enteredWaiters: [CheckedContinuation<Void, Never>] = []
    private var resultWaiter: CheckedContinuation<NativeServiceCredentialResult, Never>?

    func credentials(forBotId botId: String) async throws -> NativeServiceCredentialResult {
        entered = true
        let waiters = enteredWaiters
        enteredWaiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }
        return await withCheckedContinuation { continuation in
            resultWaiter = continuation
        }
    }

    func waitUntilEntered() async {
        if entered { return }
        await withCheckedContinuation { continuation in
            enteredWaiters.append(continuation)
        }
    }

    func resume(with result: NativeServiceCredentialResult) {
        resultWaiter?.resume(returning: result)
        resultWaiter = nil
    }
}

private actor SpyRecallTransport: RecallSearchTransport {
    private(set) var callCount = 0
    private(set) var lastLimit = 0

    func search(query: String, app: String?, limit: Int) async throws -> [RecallSearchHit] {
        callCount += 1
        lastLimit = limit
        return [
            RecallSearchHit(
                title: "Hit for \(query)",
                source: "linear",
                score: 0.99,
                snippet: "Verified snippet",
                url: "https://linear.app/simple-with-us/issue/BF-2689",
                isUntrusted: false
            ),
        ]
    }
}

private struct StaticMacCredentialSource: NativeServiceCredentialSource {
    let result: NativeServiceCredentialResult

    func credentials(forBotId botId: String) async throws -> NativeServiceCredentialResult {
        result
    }
}

private actor SpyMacEngineDriver: EngineDriver {
    nonisolated let engineId = "spy"
    private(set) var callCount = 0

    func sendTurn(input: TurnInput) async throws -> AsyncStream<TurnEvent> {
        callCount += 1
        return AsyncStream { continuation in
            continuation.yield(.textDelta("ok"))
            continuation.yield(.completed(stopReason: "end_turn", inputTokens: 2, outputTokens: 1))
            continuation.finish()
        }
    }

    func cancelTurn(threadId: String) async {}
}
