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
