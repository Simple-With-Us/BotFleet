// The Usage summary the phone adds up from the bots it already holds, pinned
// to the cases `src/lib/usage.test.ts` pins for the desktop, plus the part the
// desktop never needed: a ledger this build cannot read must cost a figure,
// never the bot.
import Foundation
import XCTest
@testable import CompanionCore

final class UsageTests: XCTestCase {
    private func makeBot(selection: String = "claude-3-7-sonnet", _ fields: String) throws -> Bot {
        let json = """
        {"bots":[{"id":"b1","threadId":"t1","name":"Scout","title":"","description":"","notifications":false,
        "color":"green","unread":false,"modelSelection":{"instanceId":"claude","model":"\(selection)"},"createdAt":1\(fields)}],"groups":[]}
        """
        let fleet = try JSONDecoder().decode(Fleet.self, from: Data(json.utf8))
        return try XCTUnwrap(fleet.bots.first)
    }

    private func close(_ a: Double?, _ b: Double, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
        guard let a else { return XCTFail("nil, expected \(b) \(message)", file: file, line: line) }
        XCTAssertEqual(a, b, accuracy: 1e-9, message, file: file, line: line)
    }

    // MARK: - Formatting (usage.test.ts)

    func testTokensFormatCompactly() {
        XCTAssertEqual(UsageMath.formatTokens(950), "950")
        XCTAssertEqual(UsageMath.formatTokens(12_400), "12.4k")
        XCTAssertEqual(UsageMath.formatTokens(120_000), "120k")
        XCTAssertEqual(UsageMath.formatTokens(2_300_000), "2.3M")
        XCTAssertEqual(UsageMath.formatTokens(.nan), "0")
        XCTAssertEqual(UsageMath.formatTokens(.infinity), "0")
    }

    func testSmallDollarAmountsStayVisible() {
        XCTAssertEqual(UsageMath.formatUsd(0), "$0")
        XCTAssertEqual(UsageMath.formatUsd(0.004), "$0.004")
        XCTAssertEqual(UsageMath.formatUsd(0.31), "$0.31")
        XCTAssertEqual(UsageMath.formatUsd(.nan), "")
        XCTAssertEqual(UsageMath.formatUsd(.infinity), "")
    }

    func testSpendLinesUseTheEngineQuotaFormat() {
        XCTAssertEqual(UsageMath.formatSpendUsd(0), "$0.00")
        XCTAssertEqual(UsageMath.formatSpendUsd(0.004), "<$0.01 ($0.0040)")
        XCTAssertEqual(UsageMath.formatSpendUsd(12.5), "$12.50")
    }

    func testTheBreakdownNamesTheCachedShare() {
        XCTAssertEqual(
            UsageMath.usageDetail(UsageTotals(input: 88_200, output: 1_200, turns: 5, cachedInput: 79_000)),
            "88.2k in (79k cached) \u{00B7} 1.2k out"
        )
        XCTAssertEqual(UsageMath.usageDetail(UsageTotals(input: 900, output: 50, turns: 1)), "900 in \u{00B7} 50 out")
        XCTAssertEqual(UsageMath.usageDetail(UsageTotals(input: 900, output: 50, turns: 1, cachedInput: 0)), "900 in \u{00B7} 50 out")
        // a cached figure can never exceed the input it is part of, or go negative
        XCTAssertEqual(UsageMath.cachedInput(UsageTotals(input: 100, turns: 1, cachedInput: 250)), 100)
        XCTAssertEqual(UsageMath.cachedInput(UsageTotals(input: 100, turns: 1, cachedInput: -3)), 0)
        XCTAssertEqual(UsageMath.cachedInput(UsageTotals(input: 100, turns: 1, cachedInput: .nan)), 0)
    }

    func testCostIsCaptionedByBilling() {
        XCTAssertTrue(UsageMath.costCaption(billing: "subscription").contains("not billed"))
        XCTAssertTrue(UsageMath.costCaption(billing: "metered").contains("API key"))
        XCTAssertTrue(UsageMath.costCaption(billing: nil).contains("reported"))
    }

    // MARK: - Sums

    func testSumsLeaveCostNilUntilOneReportsIt() {
        let none = UsageMath.sum([UsageTotals(input: 1, output: 1, turns: 1), UsageTotals(input: 2, output: 2, turns: 1)])
        XCTAssertEqual(none, UsageTotals(input: 3, output: 3, turns: 2))
        XCTAssertNil(none.costUsd)
        XCTAssertNil(none.cachedInput)
    }

    func testNonFiniteCostCountsAsMissing() {
        let sum = UsageMath.sum([
            UsageTotals(input: 1, output: 1, turns: 1, costUsd: .nan),
            UsageTotals(input: 2, output: 2, turns: 1, costUsd: 0.01),
        ])
        XCTAssertEqual(sum, UsageTotals(input: 3, output: 3, turns: 2, costUsd: 0.01))
    }

    func testTheCachedShareCarriesThroughSums() {
        let sum = UsageMath.sum([
            UsageTotals(input: 100, output: 10, turns: 1),
            UsageTotals(input: 200, output: 20, turns: 1, cachedInput: 150),
        ])
        XCTAssertEqual(sum, UsageTotals(input: 300, output: 30, turns: 2, cachedInput: 150))
    }

    func testABotsUsageSumsItsTasksAndLeavesCostNilUntilOneReportsIt() throws {
        let one = try makeBot(#"""
,"tasks":[
        {"threadId":"a","title":"","createdAt":0,"usage":{"input":5,"output":5,"costUsd":0.01,"turns":1}},
        {"threadId":"b","title":"","createdAt":0},
        {"threadId":"c","title":"","createdAt":0,"usage":{"input":5,"output":5,"costUsd":null,"turns":2}}]
"""#)
        XCTAssertEqual(UsageMath.botUsage(one), UsageTotals(input: 10, output: 10, turns: 3, costUsd: 0.01))
    }

    // MARK: - By model (usage.test.ts)

    func testUsageBreaksDownByTheModelThatRanEachTurn() throws {
        let bot = try makeBot(#"""
,"tasks":[{"threadId":"task-1","title":"Task 1","createdAt":100,
        "usage":{"input":1000,"output":200,"cachedInput":500,"costUsd":0.05,"turns":5},
        "usageByInstance":{"claude":{"input":1000,"output":200,"costUsd":0.05,"turns":5,"byModel":{
          "claude-3-7-sonnet":{"input":600,"output":120,"cachedInput":300,"costUsd":0.03,"turns":3},
          "claude-3-5-haiku":{"input":400,"output":80,"cachedInput":200,"costUsd":0.02,"turns":2}}}}}]
"""#)
        let breakdown = UsageMath.botUsageByModel(bot)
        XCTAssertEqual(breakdown.map(\.model), ["claude-3-7-sonnet", "claude-3-5-haiku"])
        XCTAssertEqual(breakdown[0].usage.input, 600)
        XCTAssertEqual(breakdown[0].usage.output, 120)
        XCTAssertEqual(breakdown[0].usage.cachedInput, 300)
        XCTAssertEqual(breakdown[0].usage.turns, 3)
        close(breakdown[0].usage.costUsd, 0.03)
        close(breakdown[0].perTurnCost, 0.01)
        close(breakdown[1].perTurnCost, 0.01)
        // and the models add back up to the bot
        let total = UsageMath.sum(breakdown.map(\.usage))
        let whole = UsageMath.botUsage(bot)
        XCTAssertEqual(total.input, whole.input)
        XCTAssertEqual(total.output, whole.output)
        XCTAssertEqual(total.turns, whole.turns)
        close(total.costUsd, whole.costUsd ?? -1)
    }

    func testTurnsBankedBeforeTheSplitGoToTheConfiguredModel() throws {
        let bot = try makeBot(selection: "MiniMax-M3", #"""
,"tasks":[{"threadId":"legacy-task","title":"Legacy Task","createdAt":100,
        "usage":{"input":800,"output":100,"cachedInput":400,"costUsd":0.04,"turns":4},
        "modelSelection":{"instanceId":"minimax","model":"MiniMax-M3"}}]
"""#)
        let breakdown = UsageMath.botUsageByModel(bot)
        XCTAssertEqual(breakdown.count, 1)
        XCTAssertEqual(breakdown[0].model, "MiniMax-M3")
        XCTAssertEqual(breakdown[0].usage.input, 800)
        XCTAssertEqual(breakdown[0].usage.cachedInput, 400)
        XCTAssertEqual(breakdown[0].usage.turns, 4)
        close(breakdown[0].perTurnCost, 0.01)
    }

    func testOneHarnessEngineKeepsItsModelsApart() throws {
        let bot = try makeBot(selection: "deepseek-chat", #"""
,"tasks":[{"threadId":"dsh-task","title":"DSH Multi-Model Task","createdAt":100,
        "usage":{"input":1500,"output":300,"cachedInput":600,"costUsd":0.03,"turns":3},
        "usageByInstance":{"dsh":{"engineId":"deepseek-harness","input":1500,"output":300,"costUsd":0.03,"turns":3,"byModel":{
          "MiniMax-M3":{"input":1000,"output":200,"cachedInput":400,"costUsd":0.02,"turns":2},
          "deepseek-chat":{"input":500,"output":100,"cachedInput":200,"costUsd":0.01,"turns":1}}}}}]
"""#)
        let breakdown = UsageMath.botUsageByModel(bot)
        XCTAssertEqual(breakdown.map(\.model), ["MiniMax-M3", "deepseek-chat"])
        XCTAssertEqual(breakdown.map(\.usage.turns), [2, 1])
    }

    func testSharedRoomTurnsCountForTheBotThatSpokeThem() throws {
        let bot = try makeBot(selection: "MiniMax-M3", #"""
,"tasks":[],"roomUsageByInstance":{"minimax":{
        "input":300,"output":50,"costUsd":0.01,"turns":2,"lastAt":200,"byModel":{"MiniMax-M3":{"input":300,"output":50,"costUsd":0.01,"turns":2}}}}
"""#)
        let breakdown = UsageMath.botUsageByModel(bot)
        XCTAssertEqual(breakdown.map(\.model), ["MiniMax-M3"])
        XCTAssertEqual(breakdown[0].usage.turns, 2)
        XCTAssertEqual(UsageMath.botUsage(bot).turns, 2)
    }

    func testARoomBucketWithoutAModelSplitFallsBackToItsEngine() throws {
        let bot = try makeBot(#"""
,"roomUsageByInstance":{"custom-1":{"input":10,"output":5,"turns":1,"engineId":"minimax"},
        "custom-2":{"input":4,"output":1,"turns":1}}
"""#)
        XCTAssertEqual(UsageMath.botUsageByModel(bot).map(\.model).sorted(), ["custom-2", "minimax"])
    }

    func testModelsSortByCostThenVolumeThenTurnsThenName() throws {
        let bot = try makeBot(#"""
,"tasks":[{"threadId":"t","title":"","createdAt":0,
        "usage":{"input":30,"output":0,"costUsd":0.3,"turns":3},
        "usageByInstance":{"x":{"input":30,"output":0,"turns":3,"byModel":{
          "free-big":{"input":20,"output":0,"turns":1},
          "free-small":{"input":5,"output":0,"turns":1},
          "paid":{"input":5,"output":0,"costUsd":0.3,"turns":1}}}}}]
"""#)
        XCTAssertEqual(UsageMath.botUsageByModel(bot).map(\.model), ["paid", "free-big", "free-small"])
    }

    // MARK: - The summary and a bot's sessions

    private func fleet(_ bots: String) throws -> [Bot] {
        let json = #"{"bots":[\#(bots)],"groups":[]}"#
        return try JSONDecoder().decode(Fleet.self, from: Data(json.utf8)).bots
    }

    private func botJSON(_ id: String, name: String, extra: String) -> String {
        #"{"id":"\#(id)","threadId":"t-\#(id)","name":"\#(name)","title":"","description":"","notifications":false,"color":"green","unread":false,"modelSelection":{"instanceId":"claude","model":"m"},"createdAt":1\#(extra)}"#
    }

    func testTheSummaryListsBotsThatSpentMoneyFirstThenVolume() throws {
        let bots = try fleet([
            botJSON("free", name: "Free", extra: #","tasks":[{"threadId":"a","title":"","createdAt":0,"usage":{"input":900,"output":100,"costUsd":null,"turns":2}}]"#),
            botJSON("paid", name: "Paid", extra: #","tasks":[{"threadId":"b","title":"","createdAt":0,"usage":{"input":10,"output":10,"costUsd":1.5,"turns":1}}]"#),
            botJSON("idle", name: "Idle", extra: ""),
            botJSON("hid", name: "Hidden", extra: #","hidden":true,"tasks":[{"threadId":"c","title":"","createdAt":0,"usage":{"input":1,"output":1,"costUsd":9,"turns":1}}]"#),
            botJSON("busy", name: "Busy", extra: #","tasks":[{"threadId":"d","title":"","createdAt":0,"usage":{"input":5000,"output":5000,"costUsd":null,"turns":9}}]"#),
        ].joined(separator: ","))
        let rows = UsageMath.summaryRows(bots)
        XCTAssertEqual(rows.map(\.botId), ["paid", "busy", "free"], "money first, then volume; idle and hidden bots have no row")
        let total = UsageMath.total(rows)
        XCTAssertEqual(total.turns, 12)
        close(total.costUsd, 1.5)
    }

    func testTheCostCaptionNamesTheBillingOrSaysTheyDiffer() {
        XCTAssertEqual(UsageMath.summaryCostCaption(billings: ["metered"]), "billed to your API key")
        XCTAssertTrue(UsageMath.summaryCostCaption(billings: ["subscription"]).contains("not billed"))
        XCTAssertTrue(UsageMath.summaryCostCaption(billings: [nil]).contains("reported"))
        XCTAssertTrue(UsageMath.summaryCostCaption(billings: ["metered", "subscription"]).hasPrefix("as each engine reports it"))
        XCTAssertTrue(UsageMath.summaryCostCaption(billings: []).hasPrefix("as each engine reports it"))
    }

    func testSessionsRunNewestFirstWithTotalsThatGrowOldestFirst() throws {
        let bot = try XCTUnwrap(fleet(botJSON("b", name: "B", extra: #"""
        ,"tasks":[
          {"threadId":"new","title":"Newest","createdAt":1,"lastActivity":300,"usage":{"input":30,"output":0,"costUsd":0.3,"turns":3}},
          {"threadId":"old","title":"","createdAt":1,"lastActivity":100,"usage":{"input":10,"output":0,"costUsd":0.1,"turns":1}},
          {"threadId":"mid","title":"Middle","createdAt":1,"lastActivity":200,"usage":{"input":20,"output":0,"turns":2}},
          {"threadId":"none","title":"Unused","createdAt":1,"lastActivity":400}],
        "roomUsageByInstance":{"minimax":{"input":5,"output":5,"costUsd":0.05,"turns":1,"lastAt":250,"byModel":{"MiniMax-M3":{"input":5,"output":5,"turns":1}}}}
        """#)).first)
        let rows = UsageMath.sessionRows(bot)
        XCTAssertEqual(rows.map(\.id), ["new", "room:minimax", "mid", "old"])
        XCTAssertEqual(rows.map(\.title), ["Newest", "Shared rooms", "Middle", "old"], "an untitled task shows its id")
        // oldest first: old 10 -> mid 30 -> room 40 -> new 70
        XCTAssertEqual(rows.map(\.cumulativeTokens), [70, 40, 30, 10])
        close(rows[0].cumulativeCost, 0.1 + 0.05 + 0.3)
        close(rows[3].cumulativeCost, 0.1)
        close(rows[0].perTurnCost, 0.1)
        XCTAssertNil(rows[2].perTurnCost, "no cost, no per-turn cost")
        XCTAssertTrue(rows[1].isRoom)
        XCTAssertEqual(rows[1].model, "MiniMax-M3")
    }

    func testASessionIsLabelledByTheModelThatRanItAndSaysWhenHistoryIsIncomplete() throws {
        let bot = try XCTUnwrap(fleet(botJSON("b", name: "B", extra: #"""
        ,"tasks":[
          {"threadId":"whole","title":"Whole","createdAt":1,"usage":{"input":10,"output":0,"turns":2},
           "modelSelection":{"instanceId":"claude","model":"configured"},
           "usageByInstance":{"x":{"turns":2,"byModel":{"opus":{"input":6,"turns":1},"haiku":{"input":4,"turns":1}}}}},
          {"threadId":"partial","title":"Partial","createdAt":2,"usage":{"input":10,"output":0,"turns":5},
           "modelSelection":{"instanceId":"claude","model":"configured"},
           "usageByInstance":{"x":{"turns":1,"byModel":{"haiku":{"input":2,"turns":1}}}}},
          {"threadId":"legacy","title":"Legacy","createdAt":3,"usage":{"input":10,"output":0,"turns":1}}]
        """#)).first)
        let rows = Dictionary(uniqueKeysWithValues: UsageMath.sessionRows(bot).map { ($0.id, $0.model) })
        XCTAssertEqual(rows["whole"], "haiku, opus")
        XCTAssertEqual(rows["partial"], "haiku, configured + earlier usage")
        XCTAssertEqual(rows["legacy"], "m", "falls back to the bot's own model")
    }

    // MARK: - A ledger the phone cannot read costs the figure, not the bot

    func testAMalformedLedgerLeavesTheBotInTheFleet() throws {
        let json = """
        {"bots":[
          {"id":"b1","threadId":"t1","name":"Broken ledgers","title":"","description":"","notifications":false,"color":"green","unread":false,
           "modelSelection":{"instanceId":"claude","model":"m"},"createdAt":1,
           "roomUsageByInstance":"nonsense",
           "tasks":[{"threadId":"a","title":"","createdAt":0,"usageByInstance":[1,2,3]},
                    {"threadId":"b","title":"","createdAt":0,"usageByInstance":{"x":"not a bucket","y":{"input":"many","turns":"two","byModel":7}}}]},
          {"id":"b2","threadId":"t2","name":"Fine","title":"","description":"","notifications":false,"color":"blue","unread":false,
           "modelSelection":{"instanceId":"claude","model":"m"},"createdAt":1}
        ],"groups":[]}
        """
        let fleet = try JSONDecoder().decode(Fleet.self, from: Data(json.utf8))
        XCTAssertEqual(fleet.bots.map(\.id), ["b1", "b2"], "a bad ledger must never drop a bot")
        let broken = try XCTUnwrap(fleet.bots.first)
        XCTAssertEqual(broken.roomUsageByInstance?.byKey.count, 0)
        XCTAssertEqual(broken.tasks?.first?.usageByInstance?.byKey.count, 0)
        // the one readable-enough bucket survives with zeroes in place of what was wrong
        XCTAssertEqual(broken.tasks?.last?.usageByInstance?.byKey["y"]?.input, 0)
        XCTAssertEqual(UsageMath.botUsage(broken), UsageTotals(input: 0, output: 0, turns: 0))
    }

    func testABotFromAnOlderHarnessHasNoLedgersAndStillTotals() throws {
        let bot = try makeBot("")
        XCTAssertNil(bot.roomUsageByInstance)
        XCTAssertEqual(UsageMath.botUsage(bot), .empty)
        XCTAssertTrue(UsageMath.botUsageByModel(bot).isEmpty)
    }

    func testTheLedgersRoundTripThroughEncoding() throws {
        let bot = try makeBot(#","roomUsageByInstance":{"minimax":{"input":3,"output":2,"turns":1,"lastAt":9}}"#)
        let data = try JSONEncoder().encode(bot)
        let again = try JSONDecoder().decode(Bot.self, from: data)
        XCTAssertEqual(again.roomUsageByInstance?.byKey["minimax"]?.lastAt, 9)
        XCTAssertEqual(again, bot)
    }
}
