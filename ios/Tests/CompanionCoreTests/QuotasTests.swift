// `GET /api/quotas`, `GET /api/tts/usage` and `GET /api/qdrant/status` as the
// phone reads them: lenient decoding, the desktop's own filters and rules, and
// the owner's clock (12-hour, Central, no zone abbreviation).
import Foundation
import XCTest
@testable import CompanionCore

private final class QuotasRequestStub: URLProtocol {
    static var responseBody = Data()
    static var statusCode = 200
    static var capturedRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: Self.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class QuotasTests: XCTestCase {
    private func snapshot(_ json: String) throws -> QuotasSnapshot {
        try JSONDecoder().decode(QuotasSnapshot.self, from: Data(json.utf8))
    }

    private func window(
        provider: String,
        providerKey: String? = nil,
        label: String = "5-hour",
        sourceApp: String? = nil,
        via: String? = nil,
        skip: Bool = false
    ) -> QuotaWindow {
        QuotaWindow(id: "\(provider):\(label)", provider: provider, providerKey: providerKey, sourceApp: sourceApp, via: via, label: label, remainingPercent: 50, skip: skip)
    }

    // MARK: - Decoding

    func testTheWholePayloadDecodes() throws {
        let decoded = try snapshot("""
        {"ok":true,
         "cooldowns":[{"botId":"b1","instanceId":"claude","model":"opus","resetsAt":1900000000000,"error":"Session limit reached","recordedAt":5}],
         "doomed":[{"botId":"b1","instanceId":"codex","consecutiveFailures":3,"openedAt":1,"lastFailureAt":2,"lastError":"CLI missing","open":true,"holds":true}],
         "fallbackChains":[{"botId":"b1","name":"Scout","scope":"bot","threadId":null,"total":3,"effective":2,
           "redundant":[{"instanceId":"claude","model":"opus","reason":"same-as-primary"}]}],
         "windows":[{"id":"w1","provider":"Anthropic","providerKey":"anthropic","label":"5-hour","remainingPercent":62.4,"resetAt":"2026-10-09T20:00:00.000Z","skip":false}],
         "localQuota":{"state":"stale","generatedAt":"2026-10-09T20:15:00.000Z","producer":"codecaps"},
         "deepseek":{"balanceUsd":4.2,"grantedUsd":1,"toppedUpUsd":5,"availability":"available","fetchedAt":1,"error":null},
         "engineSpend":{"claudeAgent":{"spend5hUsd":0.5,"spend7dUsd":3.25,"unpricedTurns5h":0,"unpricedTurns7d":2}},
         "antigravity":{"models":[]},"grok":{"method":"no-source"}}
        """)
        XCTAssertEqual(decoded.cooldowns.count, 1)
        XCTAssertEqual(decoded.doomed.first?.consecutiveFailures, 3)
        XCTAssertEqual(decoded.fallbackChains.first?.redundant.first?.reason, "same-as-primary")
        XCTAssertEqual(decoded.windows.first?.remainingPercent, 62.4)
        XCTAssertEqual(decoded.localQuota?.state, "stale")
        XCTAssertEqual(decoded.deepseek?.balanceUsd, 4.2)
        XCTAssertEqual(decoded.engineSpend["claudeAgent"]?.spend7dUsd, 3.25)
        XCTAssertEqual(decoded.engineSpend["claudeAgent"]?.unpricedTurns, 2)
    }

    func testARowItCannotReadIsLeftOutAndTheRestStillShow() throws {
        let decoded = try snapshot("""
        {"cooldowns":[7,{"botId":"b1","instanceId":"claude","error":"x"}],
         "doomed":[{"instanceId":"no-bot"},{"botId":"b2","instanceId":"dsh"}],
         "windows":"nope","deepseek":"nope","engineSpend":{"a":"bad","b":{"spend5hUsd":"x","spend7dUsd":1}}}
        """)
        XCTAssertEqual(decoded.cooldowns.map(\.botId), ["b1"])
        XCTAssertEqual(decoded.doomed.map(\.botId), ["b2"])
        XCTAssertTrue(decoded.windows.isEmpty)
        XCTAssertNil(decoded.deepseek)
        XCTAssertNil(decoded.engineSpend["a"])
        XCTAssertEqual(decoded.engineSpend["b"]?.spend5hUsd, 0)
        XCTAssertEqual(decoded.engineSpend["b"]?.spend7dUsd, 1)
    }

    func testAnEmptyAnswerIsAnEmptySnapshot() throws {
        let decoded = try snapshot("{}")
        XCTAssertTrue(decoded.cooldowns.isEmpty && decoded.doomed.isEmpty && decoded.windows.isEmpty && decoded.engineSpend.isEmpty)
    }

    // MARK: - The desktop's rules

    func testOnlyAnEngineWithSpendOrUnpricedTurnsHasARow() {
        XCTAssertFalse(EngineSpend().hasActivity)
        XCTAssertTrue(EngineSpend(spend5hUsd: 0.01).hasActivity)
        XCTAssertTrue(EngineSpend(spend7dUsd: 1).hasActivity)
        XCTAssertTrue(EngineSpend(unpricedTurns7d: 2).hasActivity, "a blank row is not the same as no activity")
        XCTAssertEqual(EngineSpend(unpricedTurns5h: 1, unpricedTurns7d: 2).unpricedTurns, 3)
        XCTAssertNil(QuotaDisplay.unpricedNote(EngineSpend(spend7dUsd: 1)))
        XCTAssertEqual(QuotaDisplay.unpricedNote(EngineSpend(unpricedTurns7d: 4)), "4 could not be costed \u{2014} the totals above exclude them")
    }

    func testHeldMeansHoldsElseOpenElseTrue() {
        XCTAssertTrue(DoomedPair(botId: "b", instanceId: "i").isHolding, "absent means open, like a harness that predates the flag")
        XCTAssertFalse(DoomedPair(botId: "b", instanceId: "i", open: false).isHolding)
        XCTAssertFalse(DoomedPair(botId: "b", instanceId: "i", open: true, holds: false).isHolding, "an open fallback breaker holds nothing")
        XCTAssertTrue(DoomedPair(botId: "b", instanceId: "i", open: false, holds: true).isHolding)
        XCTAssertEqual(QuotaDisplay.heldHeading(botCount: 1), "1 Bot Is Being Held")
        XCTAssertEqual(QuotaDisplay.heldHeading(botCount: 3), "3 Bots Are Being Held")
        XCTAssertEqual(QuotaDisplay.redundantHeading(botCount: 1), "1 Bot's Fallback Chain Is Shorter Than It Looks")
        XCTAssertEqual(QuotaDisplay.redundantHeading(botCount: 2), "2 Bots' Fallback Chains Are Shorter Than They Look")
    }

    func testOnlyProvidersWithAnEngineAppear() {
        XCTAssertTrue(QuotaDisplay.isBotFleetWindow(window(provider: "Anthropic", providerKey: "anthropic")))
        XCTAssertTrue(QuotaDisplay.isBotFleetWindow(window(provider: "Claude")), "an alias folds onto its provider")
        XCTAssertTrue(QuotaDisplay.isBotFleetWindow(window(provider: "Grok Build")))
        XCTAssertTrue(QuotaDisplay.isBotFleetWindow(window(provider: "MiniMax Code")))
        XCTAssertTrue(QuotaDisplay.isBotFleetWindow(window(provider: "Whatever", via: "antigravity")), "via antigravity wins")
        XCTAssertFalse(QuotaDisplay.isBotFleetWindow(window(provider: "GitHub Copilot")))
        XCTAssertFalse(QuotaDisplay.isBotFleetWindow(window(provider: "Windsurf")))
        XCTAssertFalse(QuotaDisplay.isBotFleetWindow(window(provider: "Kimi")))
        // Grok Bot is another product from Grok CLI
        XCTAssertFalse(QuotaDisplay.isBotFleetWindow(window(provider: "xai", label: "Grok Bot weekly")))
        XCTAssertFalse(QuotaDisplay.isBotFleetWindow(window(provider: "xai", sourceApp: "grok_bot")))
    }

    func testABareOpenAIWindowNeedsCodexsOwnIdentity() {
        XCTAssertFalse(QuotaDisplay.isBotFleetWindow(window(provider: "OpenAI", providerKey: "openai")))
        XCTAssertTrue(QuotaDisplay.isBotFleetWindow(window(provider: "OpenAI", providerKey: "openai", sourceApp: "Codex CLI")))
        XCTAssertTrue(QuotaDisplay.isBotFleetWindow(window(provider: "OpenAI", providerKey: "openai", label: "ChatGPT weekly")))
        // a key that names the product outright is attributable on its own
        XCTAssertTrue(QuotaDisplay.isBotFleetWindow(window(provider: "OpenAI", providerKey: "codex")))
    }

    func testWindowsGroupUnderTheirProviderAndSkippedOnesAreHidden() {
        let groups = QuotaDisplay.groupedWindows([
            window(provider: "Anthropic", providerKey: "anthropic", label: "weekly"),
            window(provider: "Cursor", providerKey: "cursor", label: "monthly"),
            window(provider: "Anthropic", providerKey: "anthropic", label: "5-hour"),
            window(provider: "Anthropic", providerKey: "anthropic", label: "plan", skip: true),
            window(provider: "Windsurf"),
        ])
        XCTAssertEqual(groups.map { $0.title }, ["Anthropic", "Cursor"])
        XCTAssertEqual(groups[0].windows.map { $0.label }, ["5-hour", "weekly"])
    }

    func testPercentAndResetReadLikeTheMac() {
        func percent(_ value: Double?) -> String {
            QuotaDisplay.percentText(QuotaWindow(id: "i", provider: "p", label: "l", remainingPercent: value))
        }
        XCTAssertEqual(percent(62.4), "62% remaining")
        XCTAssertEqual(percent(0), "0% remaining")
        XCTAssertEqual(percent(100), "100% remaining")
        XCTAssertEqual(percent(nil), "not reported")
        XCTAssertEqual(percent(101), "not reported")
        XCTAssertEqual(percent(-1), "not reported")
        XCTAssertEqual(percent(.nan), "not reported")
    }

    func testResetCountdownsMatchFormatResetCountdown() {
        let now = 1_000_000_000_000.0
        func left(_ ms: Double) -> String { OwnerClock.countdown(untilMs: now + ms, nowMs: now) }
        XCTAssertEqual(left(-1), "resetting now")
        XCTAssertEqual(left(0), "resetting now")
        XCTAssertEqual(left(10_000), "1m", "never less than a minute")
        XCTAssertEqual(left(45 * 60_000), "45m")
        XCTAssertEqual(left(2 * 3_600_000), "2h")
        XCTAssertEqual(left(2 * 3_600_000 + 5 * 60_000), "2h 5m")
        XCTAssertEqual(left(3 * 86_400_000), "3d")
        XCTAssertEqual(left(3 * 86_400_000 + 4 * 3_600_000), "3d 4h")
        let w = QuotaWindow(id: "i", provider: "p", label: "l", resetAt: "not a date")
        XCTAssertEqual(QuotaDisplay.resetText(w, nowMs: now), "reset unknown")
        XCTAssertEqual(QuotaDisplay.resetText(QuotaWindow(id: "i", provider: "p", label: "l"), nowMs: now), "reset unknown")
    }

    func testCooldownsSayWhenTheEngineRefills() {
        let now = 1_000_000_000_000.0
        XCTAssertEqual(QuotaDisplay.cooldownCountdown(resetsAtMs: nil, nowMs: now), "Rolling refresh window")
        XCTAssertEqual(QuotaDisplay.cooldownCountdown(resetsAtMs: 0, nowMs: now), "Rolling refresh window")
        XCTAssertEqual(QuotaDisplay.cooldownCountdown(resetsAtMs: now - 1, nowMs: now), "Refreshing now")
        XCTAssertEqual(QuotaDisplay.cooldownCountdown(resetsAtMs: now + 5 * 60_000, nowMs: now), "Resets in 5m")
        XCTAssertEqual(QuotaDisplay.cooldownCountdown(resetsAtMs: now + 3_600_000 + 7 * 60_000, nowMs: now), "Resets in 1h 7m")
    }

    func testTheLocalHandoffExplainsAnEmptyOrStaleGrid() {
        func notice(_ state: String?, windows: Int = 0, generatedAt: String? = nil, producer: String? = nil) -> String? {
            QuotaDisplay.localQuotaNotice(LocalQuotaFreshness(state: state, generatedAt: generatedAt, producer: producer), botFleetWindowCount: windows)
        }
        XCTAssertNil(notice("fresh"))
        XCTAssertNil(notice(nil))
        XCTAssertNil(QuotaDisplay.localQuotaNotice(nil, botFleetWindowCount: 0))
        XCTAssertEqual(notice("missing"), "CodeCaps is not running, so no local subscription quota is available")
        XCTAssertEqual(notice("missing", producer: "usage-monitor"), "Usage Monitor is not running, so no local subscription quota is available")
        XCTAssertEqual(notice("stale", windows: 2, generatedAt: "2026-10-09T20:15:00.000Z"), "CodeCaps has not written quota since 3:15pm")
        XCTAssertEqual(notice("stale", windows: 2), "CodeCaps has not written quota recently")
        XCTAssertEqual(notice("unreadable", windows: 2), "CodeCaps's quota file could not be read")
        // a missing file is only news when there is nothing else to show
        XCTAssertNil(notice("missing", windows: 2))
    }

    func testDeepSeekBalanceReadsLikeTheDesktopChip() {
        XCTAssertEqual(DeepSeekBalance(balanceUsd: 4.2).line, "$4.20 remaining")
        XCTAssertEqual(DeepSeekBalance(balanceUsd: 0).line, "$0.00 remaining")
        XCTAssertEqual(DeepSeekBalance().line, "Balance unavailable")
    }

    // MARK: - Spend rows

    private func instance(_ id: String, driver: String, enabled: Bool? = nil, hidden: Bool? = nil) throws -> Instance {
        let hiddenField = hidden.map { #","hidden":\#($0)"# } ?? ""
        let enabledField = enabled.map { #","enabled":\#($0)"# } ?? ""
        let json = #"{"instanceId":"\#(id)","driverKind":"\#(driver)"\#(enabledField),"snapshot":{"state":"available"\#(hiddenField)},"models":{"default":"m","options":[]}}"#
        return try JSONDecoder().decode(Instance.self, from: Data(json.utf8))
    }

    func testSpendIsLookedUpPerEngineNotReadKeyByKey() throws {
        // The tracker books one turn under its provider AND its instance id, so
        // reading the table key by key would count each turn twice.
        let table: [String: EngineSpend] = [
            "claudeAgent": EngineSpend(spend5hUsd: 1, spend7dUsd: 4),
            "claude": EngineSpend(spend5hUsd: 1, spend7dUsd: 4),
            "codex": EngineSpend(spend7dUsd: 9),
        ]
        let rows = QuotaDisplay.spendRows(table, instances: [
            try instance("claude", driver: "claudeAgent"),
            try instance("codex", driver: "codex"),
        ])
        XCTAssertEqual(rows.map(\.id), ["codex", "claude"], "most spent this week first")
        XCTAssertEqual(rows.map(\.spend.spend7dUsd), [9, 4])
    }

    func testTwoConnectionsOfOneEngineDoNotPrintOneFigureTwice() throws {
        let table = ["minimax": EngineSpend(spend7dUsd: 2)]
        let rows = QuotaDisplay.spendRows(table, instances: [
            try instance("minimax", driver: "minimax"),
            try instance("custom-mm", driver: "minimax"),
        ])
        XCTAssertEqual(rows.count, 1)
    }

    func testDeepSeekFindsItsSpendUnderEitherAlias() throws {
        let rows = QuotaDisplay.spendRows(["deepseekAgent": EngineSpend(spend7dUsd: 1)], instances: [
            try instance("dsh-1", driver: "dshAgent"),
        ])
        XCTAssertEqual(rows.count, 1)
    }

    func testThePaceScalesAWeekToThirtyDaysAndCountsEachEngineOnce() throws {
        XCTAssertEqual(QuotaDisplay.monthlyPace(EngineSpend(spend7dUsd: 7)), 30, accuracy: 1e-9)
        XCTAssertEqual(QuotaDisplay.monthlyPace(EngineSpend(spend5hUsd: 99)), 0, "the 5-hour figure is not part of a weekly pace")
        let rows = QuotaDisplay.spendRows(
            ["claudeAgent": EngineSpend(spend7dUsd: 7), "claude": EngineSpend(spend7dUsd: 7), "codex": EngineSpend(spend7dUsd: 14)],
            instances: [try instance("claude", driver: "claudeAgent"), try instance("codex", driver: "codex")]
        )
        XCTAssertEqual(QuotaDisplay.monthlyPace(rows), 90, accuracy: 1e-9, "the doubled booking is not counted twice")
    }

    func testHiddenDisabledAndIdleEnginesHaveNoRow() throws {
        let table = [
            "kimi": EngineSpend(spend7dUsd: 5),
            "claude": EngineSpend(spend7dUsd: 5),
            "codex": EngineSpend(spend7dUsd: 5),
            "cursor": EngineSpend(),
            "grok": EngineSpend(spend7dUsd: 5),
        ]
        let rows = QuotaDisplay.spendRows(table, instances: [
            try instance("kimi", driver: "kimi"),
            try instance("claude", driver: "claude", enabled: false),
            try instance("codex", driver: "codex", hidden: true),
            try instance("cursor", driver: "cursor"),
            try instance("grok", driver: "grok"),
        ])
        XCTAssertEqual(rows.map(\.id), ["grok"])
    }

    // MARK: - Speech

    func testSpeechUsageReadsLikeTheDesktopLine() throws {
        let usage = try JSONDecoder().decode(
            SpeechUsage.self,
            from: Data(#"{"totals":{"minimax":{"characters":12400,"requests":31}},"unit":"characters","note":"x"}"#.utf8)
        )
        XCTAssertEqual(usage.line, "MiniMax: 12,400 characters (31 requests)")
        let one = try JSONDecoder().decode(SpeechUsage.self, from: Data(#"{"totals":{"minimax":{"characters":5,"requests":1}}}"#.utf8))
        XCTAssertEqual(one.line, "MiniMax: 5 characters (1 request)")
        let reshaped = try JSONDecoder().decode(SpeechUsage.self, from: Data(#"{"totals":{"elevenlabs":{}}}"#.utf8))
        XCTAssertEqual(reshaped.line, "MiniMax: 0 characters (0 requests)", "a reshaped table costs the counts, not the screen")
    }

    // MARK: - Clock

    func testTimesReadTwelveHourCentralWithNoZoneName() {
        // 2026-10-09 20:15:00 UTC is 3:15pm in Chicago (CDT)
        let ms = 1_791_576_900_000.0
        XCTAssertEqual(OwnerClock.stamp(ms: ms), "Oct 9, 2026, 3:15pm")
        XCTAssertEqual(OwnerClock.time(ms: ms), "3:15pm")
        // and through the winter, when the same instant reads an hour earlier
        XCTAssertEqual(OwnerClock.time(ms: 1_798_172_760_000), "10:26pm")
        XCTAssertEqual(OwnerClock.stamp(iso: "2026-10-09T20:15:00.000Z"), "Oct 9, 2026, 3:15pm")
        XCTAssertEqual(OwnerClock.stamp(iso: "2026-10-09T20:15:00Z"), "Oct 9, 2026, 3:15pm")
        XCTAssertNil(OwnerClock.stamp(iso: "yesterday"))
        for text in [OwnerClock.stamp(ms: ms), OwnerClock.time(ms: ms)] {
            XCTAssertFalse(text.contains("CDT") || text.contains("CST") || text.contains("AM") || text.contains("PM"))
        }
    }

    // MARK: - Requests

    private func client() -> CompanionClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [QuotasRequestStub.self]
        let connection = Connection(id: "c1", name: "Mac", host: "192.168.1.5", port: 4748)
        return CompanionClient(connection: connection, token: TestFixtures.fakeCompanionToken, session: URLSession(configuration: configuration))
    }

    override func setUp() {
        QuotasRequestStub.responseBody = Data()
        QuotasRequestStub.statusCode = 200
        QuotasRequestStub.capturedRequest = nil
    }

    func testTheThreeReadsAreGetsOnTheirOwnRoutes() async throws {
        QuotasRequestStub.responseBody = Data("{}".utf8)
        _ = try await client().quotas()
        XCTAssertEqual(QuotasRequestStub.capturedRequest?.httpMethod, "GET")
        XCTAssertEqual(QuotasRequestStub.capturedRequest?.url?.path, "/api/quotas")

        QuotasRequestStub.responseBody = Data(#"{"totals":{"minimax":{"characters":1,"requests":1}}}"#.utf8)
        _ = try await client().speechUsage()
        XCTAssertEqual(QuotasRequestStub.capturedRequest?.httpMethod, "GET")
        XCTAssertEqual(QuotasRequestStub.capturedRequest?.url?.path, "/api/tts/usage")

        QuotasRequestStub.responseBody = Data(#"{"ready":true,"configured":true}"#.utf8)
        _ = try await client().sharedMemoryStatus()
        XCTAssertEqual(QuotasRequestStub.capturedRequest?.httpMethod, "GET")
        XCTAssertEqual(QuotasRequestStub.capturedRequest?.url?.path, "/api/qdrant/status")
        XCTAssertEqual(QuotasRequestStub.capturedRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer \(TestFixtures.fakeCompanionToken)")
    }
}
