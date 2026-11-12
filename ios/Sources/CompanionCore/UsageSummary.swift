// What each bot has spent, added up on the phone from the bots it already
// holds.
//
// Mirrors `src/lib/usage.ts` (and the cases in `src/lib/usage.test.ts`): the
// desktop computes its Usage summary client-side from each bot's tasks and
// shared-room ledger, and so does the phone, because the harness already
// sends both on every bot.  Nothing here is fetched.
//
// The per-instance buckets (`BotTask.usageByInstance`,
// `Bot.roomUsageByInstance`) are decoded as leniently as anything in this
// package: a bucket the phone cannot read loses that figure, never the bot.
// `Fleet` decodes bots through `Lossy`, so a throwing field here would drop
// the whole bot from the phone, which is a far worse result than a number
// that reads zero.
import Foundation

// MARK: - Wire shapes

/// One usage ledger entry: a task's per-engine bucket, one model inside it, or
/// a shared-room bucket (`lastAt` set).  Every field is optional on the wire
/// and defaults to zero here.
public struct UsageBucket: Codable, Hashable, Sendable {
    public var input: Double
    public var output: Double
    /// The part of `input` the provider served from its prompt cache.
    public var cachedInput: Double?
    /// Nil until any turn reports a cost; most engines never do.
    public var costUsd: Double?
    public var turns: Double
    /// The registry engine resolved when the turn banked.
    public var engineId: String?
    /// Per-model split of this bucket.
    public var byModel: [String: UsageBucket]?
    /// Room buckets only: the most recent turn in the bucket.
    public var lastAt: Double?

    private enum CodingKeys: String, CodingKey {
        case input, output, cachedInput, costUsd, turns, engineId, byModel, lastAt
    }

    public init(
        input: Double = 0,
        output: Double = 0,
        cachedInput: Double? = nil,
        costUsd: Double? = nil,
        turns: Double = 0,
        engineId: String? = nil,
        byModel: [String: UsageBucket]? = nil,
        lastAt: Double? = nil
    ) {
        self.input = input
        self.output = output
        self.cachedInput = cachedInput
        self.costUsd = costUsd
        self.turns = turns
        self.engineId = engineId
        self.byModel = byModel
        self.lastAt = lastAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // Each read is `try?`: one wrong-typed field costs that field only.
        input = (try? container.decodeIfPresent(Double.self, forKey: .input)) ?? 0
        output = (try? container.decodeIfPresent(Double.self, forKey: .output)) ?? 0
        cachedInput = try? container.decodeIfPresent(Double.self, forKey: .cachedInput)
        costUsd = try? container.decodeIfPresent(Double.self, forKey: .costUsd)
        turns = (try? container.decodeIfPresent(Double.self, forKey: .turns)) ?? 0
        engineId = try? container.decodeIfPresent(String.self, forKey: .engineId)
        byModel = (try? container.decodeIfPresent(UsageBuckets.self, forKey: .byModel))?.byKey
        lastAt = try? container.decodeIfPresent(Double.self, forKey: .lastAt)
    }
}

/// A dictionary of buckets that cannot fail to decode.  It is the type a `Bot`
/// or `BotTask` holds, so that a malformed ledger is an empty ledger and not a
/// bot that vanishes from the phone.
public struct UsageBuckets: Codable, Hashable, Sendable {
    public var byKey: [String: UsageBucket]

    public init(_ byKey: [String: UsageBucket] = [:]) {
        self.byKey = byKey
    }

    private struct LossyBucket: Decodable {
        let value: UsageBucket?
        init(from decoder: Decoder) throws {
            value = try? UsageBucket(from: decoder)
        }
    }

    public init(from decoder: Decoder) throws {
        let raw = try? decoder.singleValueContainer().decode([String: LossyBucket].self)
        byKey = raw?.compactMapValues(\.value) ?? [:]
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(byKey)
    }
}

// MARK: - Totals

/// A sum of usage: tokens, turns, and a cost that stays nil until something
/// reports one.
public struct UsageTotals: Hashable, Sendable {
    public var input: Double
    public var output: Double
    public var turns: Double
    public var cachedInput: Double?
    public var costUsd: Double?

    public init(input: Double = 0, output: Double = 0, turns: Double = 0, cachedInput: Double? = nil, costUsd: Double? = nil) {
        self.input = input
        self.output = output
        self.turns = turns
        self.cachedInput = cachedInput
        self.costUsd = costUsd
    }

    public init(_ usage: TaskUsage) {
        self.init(
            input: Double(usage.input),
            output: Double(usage.output),
            turns: Double(usage.turns),
            cachedInput: usage.cachedInput.map { Double($0) },
            costUsd: usage.costUsd
        )
    }

    public init(_ bucket: UsageBucket) {
        self.init(
            input: bucket.input,
            output: bucket.output,
            turns: bucket.turns,
            cachedInput: bucket.cachedInput,
            costUsd: bucket.costUsd
        )
    }

    public static let empty = UsageTotals()

    /// Everything the model read and wrote.
    public var tokens: Double { input + output }
}

/// One model's slice of a bot's lifetime usage.
public struct ModelUsageSummary: Hashable, Sendable, Identifiable {
    public var model: String
    public var usage: UsageTotals
    public var perTurnCost: Double?
    public var id: String { model }
}

public enum UsageMath {
    /// True when a stored cost is a real number.
    public static func hasFiniteCost(_ value: Double?) -> Bool {
        guard let value else { return false }
        return value.isFinite
    }

    /// Sum a set of usages; cost stays nil until any of them has one.
    public static func sum(_ items: [UsageTotals]) -> UsageTotals {
        var out = UsageTotals.empty
        for item in items {
            out.input += item.input
            out.output += item.output
            out.turns += item.turns
            if let cached = item.cachedInput, cached.isFinite { out.cachedInput = (out.cachedInput ?? 0) + cached }
            if let cost = item.costUsd, cost.isFinite { out.costUsd = (out.costUsd ?? 0) + cost }
        }
        return out
    }

    /// How much of `input` the provider served from its prompt cache, clamped
    /// to `input` so a provider that reports cache reads outside its input
    /// figure can never produce a negative "fresh" number.
    public static func cachedInput(_ usage: UsageTotals) -> Double {
        guard let cached = usage.cachedInput, cached.isFinite else { return 0 }
        return min(max(0, cached), usage.input)
    }

    /// A bot's lifetime usage: every task, plus the shared-room turns it spoke
    /// (banked per engine on the bot, since room threads are not tasks).
    public static func botUsage(_ bot: Bot) -> UsageTotals {
        var items: [UsageTotals] = []
        for task in bot.tasks ?? [] {
            if let usage = task.usage { items.append(UsageTotals(usage)) }
        }
        for key in (bot.roomUsageByInstance?.byKey ?? [:]).keys.sorted() {
            if let bucket = bot.roomUsageByInstance?.byKey[key] { items.append(UsageTotals(bucket)) }
        }
        return sum(items)
    }

    private static func firstNonEmpty(_ values: [String?]) -> String? {
        for value in values {
            if let value, !value.isEmpty { return value }
        }
        return nil
    }

    /// Break a bot's lifetime usage down by the model that actually ran each
    /// turn.  Prefers the per-instance banked `byModel` splits and falls back
    /// to the task or bot's configured model for turns banked before the split
    /// existed, so all history is accounted for.  Port of `botUsageByModel`.
    public static func botUsageByModel(_ bot: Bot) -> [ModelUsageSummary] {
        var byModel: [String: UsageTotals] = [:]

        func record(_ model: String, _ delta: UsageTotals) {
            if delta.turns <= 0 && delta.input + delta.output <= 0 { return }
            if var existing = byModel[model] {
                existing.input += delta.input
                existing.output += delta.output
                existing.turns += delta.turns
                if let cached = delta.cachedInput, cached.isFinite { existing.cachedInput = (existing.cachedInput ?? 0) + cached }
                if let cost = delta.costUsd, cost.isFinite { existing.costUsd = (existing.costUsd ?? 0) + cost }
                byModel[model] = existing
            } else {
                byModel[model] = UsageTotals(
                    input: delta.input,
                    output: delta.output,
                    turns: delta.turns,
                    cachedInput: hasFiniteCost(delta.cachedInput) ? delta.cachedInput : nil,
                    costUsd: hasFiniteCost(delta.costUsd) ? delta.costUsd : nil
                )
            }
        }

        // 1. Every task, and its per-instance `byModel` splits.
        for task in bot.tasks ?? [] {
            guard let taskUsage = task.usage else { continue }
            let total = UsageTotals(taskUsage)
            if total.turns <= 0 && total.input + total.output <= 0 { continue }
            var bankedTurns = 0.0
            var bankedInput = 0.0
            var bankedOutput = 0.0
            var bankedCached = 0.0
            var bankedCost = 0.0
            let buckets = task.usageByInstance?.byKey ?? [:]
            for key in buckets.keys.sorted() {
                let models = buckets[key]?.byModel ?? [:]
                for name in models.keys.sorted() {
                    guard let bucket = models[name] else { continue }
                    let part = UsageTotals(bucket)
                    if part.turns <= 0 && part.input + part.output <= 0 { continue }
                    record(name, part)
                    bankedTurns += part.turns
                    bankedInput += part.input
                    bankedOutput += part.output
                    bankedCached += cachedInput(part)
                    if let cost = part.costUsd, cost.isFinite { bankedCost += cost }
                }
            }
            // The remainder not banked per model (turns from before the split).
            if bankedTurns < total.turns || bankedInput + bankedOutput < total.input + total.output {
                let remainderCached = max(0, cachedInput(total) - bankedCached)
                let remainderCost: Double? = hasFiniteCost(total.costUsd) ? max(0, (total.costUsd ?? 0) - bankedCost) : nil
                let fallback = firstNonEmpty([
                    task.modelSelection?.model,
                    bot.modelSelection.model,
                ]) ?? "default"
                record(fallback, UsageTotals(
                    input: max(0, total.input - bankedInput),
                    output: max(0, total.output - bankedOutput),
                    turns: max(0, total.turns - bankedTurns),
                    cachedInput: remainderCached > 0 ? remainderCached : nil,
                    costUsd: remainderCost
                ))
            }
        }

        // 2. Shared-room turns.
        let rooms = bot.roomUsageByInstance?.byKey ?? [:]
        for instanceId in rooms.keys.sorted() {
            guard let roomBucket = rooms[instanceId] else { continue }
            let total = UsageTotals(roomBucket)
            if total.turns <= 0 && total.input + total.output <= 0 { continue }
            var bankedTurns = 0.0
            var bankedInput = 0.0
            var bankedOutput = 0.0
            var bankedCached = 0.0
            var bankedCost = 0.0
            let models = roomBucket.byModel ?? [:]
            for name in models.keys.sorted() {
                guard let bucket = models[name] else { continue }
                let part = UsageTotals(bucket)
                if part.turns <= 0 && part.input + part.output <= 0 { continue }
                record(name, part)
                bankedTurns += part.turns
                bankedInput += part.input
                bankedOutput += part.output
                bankedCached += cachedInput(part)
                if let cost = part.costUsd, cost.isFinite { bankedCost += cost }
            }
            if bankedTurns < total.turns || bankedInput + bankedOutput < total.input + total.output {
                let remainderCached = max(0, cachedInput(total) - bankedCached)
                let remainderCost: Double? = hasFiniteCost(total.costUsd) ? max(0, (total.costUsd ?? 0) - bankedCost) : nil
                let fallback = firstNonEmpty([roomBucket.engineId, instanceId]) ?? "room"
                record(fallback, UsageTotals(
                    input: max(0, total.input - bankedInput),
                    output: max(0, total.output - bankedOutput),
                    turns: max(0, total.turns - bankedTurns),
                    cachedInput: remainderCached > 0 ? remainderCached : nil,
                    costUsd: remainderCost
                ))
            }
        }

        let summaries = byModel.map { model, usage -> ModelUsageSummary in
            let perTurn: Double? = hasFiniteCost(usage.costUsd) && usage.turns > 0 ? (usage.costUsd ?? 0) / usage.turns : nil
            return ModelUsageSummary(model: model, usage: usage, perTurnCost: perTurn)
        }
        return summaries.sorted { a, b in
            let aCost = hasFiniteCost(a.usage.costUsd) ? (a.usage.costUsd ?? 0) : -Double.infinity
            let bCost = hasFiniteCost(b.usage.costUsd) ? (b.usage.costUsd ?? 0) : -Double.infinity
            if aCost != bCost { return aCost > bCost }
            if a.usage.tokens != b.usage.tokens { return a.usage.tokens > b.usage.tokens }
            if a.usage.turns != b.usage.turns { return a.usage.turns > b.usage.turns }
            return a.model < b.model
        }
    }

    // MARK: Formatting

    private static func trimmed(_ value: Double) -> String {
        if value >= 100 { return String(Int(value.rounded())) }
        var text = String(format: "%.1f", value)
        if text.hasSuffix(".0") { text.removeLast(2) }
        return text
    }

    /// 950 -> "950", 12_400 -> "12.4k", 2_300_000 -> "2.3M"
    public static func formatTokens(_ value: Double) -> String {
        guard value.isFinite else { return "0" }
        if value < 1000 { return String(Int(value.rounded())) }
        if value < 1_000_000 { return "\(trimmed(value / 1000))k" }
        return "\(trimmed(value / 1_000_000))M"
    }

    /// Dollars, with enough precision that a cheap turn is not "$0.00".
    public static func formatUsd(_ value: Double) -> String {
        guard value.isFinite else { return "" }
        if value == 0 { return "$0" }
        if value < 0.01 { return String(format: "$%.3f", value) }
        return String(format: "$%.2f", value)
    }

    /// A spend line's dollars: a bare "$0.00", and a sub-cent amount with its
    /// fraction in parentheses.  Port of `formatSpendUsd` in `UsageSection.tsx`.
    public static func formatSpendUsd(_ value: Double) -> String {
        if value == 0 || !value.isFinite { return "$0.00" }
        if value < 0.01 { return "<$0.01 ($\(String(format: "%.4f", value)))" }
        return String(format: "$%.2f", value)
    }

    /// "88.2k in (79k cached) · 1.2k out": the split behind a headline figure.
    public static func usageDetail(_ usage: UsageTotals) -> String {
        let cached = cachedInput(usage)
        let input = cached > 0
            ? "\(formatTokens(usage.input)) in (\(formatTokens(cached)) cached)"
            : "\(formatTokens(usage.input)) in"
        return "\(input) \u{00B7} \(formatTokens(usage.output)) out"
    }

    /// How to caption a cost figure given how the engine is billed.
    public static func costCaption(billing: String?) -> String {
        switch billing {
        case "subscription": return "equivalent \u{2014} on your subscription, not billed"
        case "metered": return "billed to your API key"
        default: return "as reported by the engine"
        }
    }
}

// MARK: - The summary's rows

/// One bot's line in the summary.
public struct BotUsageRow: Hashable, Identifiable, Sendable {
    public var botId: String
    public var name: String
    public var instanceId: String
    public var usage: UsageTotals
    public var id: String { botId }
}

/// One session (task) of a bot, or its shared-room turns, in the detail.
public struct UsageSessionRow: Hashable, Identifiable, Sendable {
    public var id: String
    public var title: String
    /// Last activity, epoch milliseconds.
    public var at: Double
    public var usage: UsageTotals
    /// The model that produced the usage, or the configured one for history
    /// banked before per-model splits existed.
    public var model: String
    public var isRoom: Bool
    public var perTurnCost: Double?
    /// Running totals, oldest first, so the figures grow down the page the
    /// way a ledger does.
    public var cumulativeTokens: Double
    public var cumulativeCost: Double

    /// Whether the running cost belongs on the line.  It is the ledger total
    /// up to and including this session, so it is worth showing whenever any
    /// session so far reported a cost, even when this one reported none.
    public var showsCumulativeCost: Bool { cumulativeCost > 0 }
}

extension UsageMath {
    /// Every visible bot that has spent anything: money first, then volume.
    /// Non-finite and missing costs sort last.
    public static func summaryRows(_ bots: [Bot]) -> [BotUsageRow] {
        let rows = bots
            .filter { $0.hidden != true }
            .map { BotUsageRow(botId: $0.id, name: $0.name, instanceId: $0.modelSelection.instanceId, usage: botUsage($0)) }
            .filter { $0.usage.turns > 0 }
        func cost(_ row: BotUsageRow) -> Double {
            hasFiniteCost(row.usage.costUsd) ? (row.usage.costUsd ?? 0) : -Double.infinity
        }
        return rows.sorted { a, b in
            let aCost = cost(a)
            let bCost = cost(b)
            if aCost != bCost { return aCost > bCost }
            if a.usage.tokens != b.usage.tokens { return a.usage.tokens > b.usage.tokens }
            return a.name < b.name
        }
    }

    /// The "All bots" line.
    public static func total(_ rows: [BotUsageRow]) -> UsageTotals {
        sum(rows.map(\.usage))
    }

    /// A bot's sessions, newest first, each with a running total taken
    /// oldest first.  Shared-room turns bank per engine on the bot rather than
    /// on a task, so each bucket becomes one "Shared rooms" row, or the detail
    /// would disagree with the header total.
    public static func sessionRows(_ bot: Bot) -> [UsageSessionRow] {
        struct Entry {
            var id: String
            var title: String
            var at: Double
            var usage: UsageTotals
            var model: String
            var isRoom: Bool
        }
        func spent(_ usage: UsageTotals) -> Bool {
            usage.turns > 0 || usage.input + usage.output > 0
        }
        var entries: [Entry] = []
        for task in bot.tasks ?? [] {
            guard let taskUsage = task.usage else { continue }
            let usage = UsageTotals(taskUsage)
            guard spent(usage) else { continue }
            // The model that PRODUCED the usage when per-instance buckets
            // banked one; the configured selection is only the fallback for
            // history from before, since it is the task's current setting and
            // not necessarily what ran.
            var ran: [String] = []
            var bankedTurns = 0.0
            let buckets = task.usageByInstance?.byKey ?? [:]
            for key in buckets.keys.sorted() {
                let models = buckets[key]?.byModel ?? [:]
                for name in models.keys.sorted() {
                    if !ran.contains(name) { ran.append(name) }
                    bankedTurns += models[name]?.turns ?? 0
                }
            }
            let configured = task.modelSelection?.model ?? bot.modelSelection.model
            // A session that mostly ran before per-model banking has only its
            // newest turns in the split, so labelling it by those alone would
            // hide the model that produced the bulk.
            let incomplete = !ran.isEmpty && bankedTurns < usage.turns
            var labelled = ran
            if incomplete, !configured.isEmpty, !ran.contains(configured) { labelled.append(configured) }
            let model = labelled.isEmpty
                ? configured
                : labelled.joined(separator: ", ") + (incomplete ? " + earlier usage" : "")
            entries.append(Entry(
                id: task.threadId,
                title: task.title.isEmpty ? String(task.threadId.prefix(12)) : task.title,
                at: task.lastActivity ?? task.createdAt,
                usage: usage,
                model: model,
                isRoom: false
            ))
        }
        let rooms = bot.roomUsageByInstance?.byKey ?? [:]
        for instanceId in rooms.keys.sorted() {
            guard let bucket = rooms[instanceId] else { continue }
            let usage = UsageTotals(bucket)
            guard spent(usage) else { continue }
            let split = (bucket.byModel ?? [:]).keys.sorted().joined(separator: ", ")
            entries.append(Entry(
                id: "room:\(instanceId)",
                title: "Shared rooms",
                at: bucket.lastAt ?? 0,
                usage: usage,
                model: split.isEmpty ? (instanceId.isEmpty ? "room" : instanceId) : split,
                isRoom: true
            ))
        }
        // Oldest first for the running totals; ties keep their order.
        let chronological = entries.enumerated().sorted { a, b in
            a.element.at != b.element.at ? a.element.at < b.element.at : a.offset < b.offset
        }.map { $0.element }
        var tokens = 0.0
        var cost = 0.0
        var running: [String: (tokens: Double, cost: Double)] = [:]
        for entry in chronological {
            tokens += entry.usage.tokens
            if hasFiniteCost(entry.usage.costUsd) { cost += entry.usage.costUsd ?? 0 }
            running[entry.id] = (tokens, cost)
        }
        let newestFirst = entries.enumerated().sorted { a, b in
            a.element.at != b.element.at ? a.element.at > b.element.at : a.offset < b.offset
        }.map { $0.element }
        return newestFirst.map { entry in
            let totals = running[entry.id] ?? (0, 0)
            let perTurn: Double? = hasFiniteCost(entry.usage.costUsd) && entry.usage.turns > 0
                ? (entry.usage.costUsd ?? 0) / entry.usage.turns
                : nil
            return UsageSessionRow(
                id: entry.id,
                title: entry.title,
                at: entry.at,
                usage: entry.usage,
                model: entry.model,
                isRoom: entry.isRoom,
                perTurnCost: perTurn,
                cumulativeTokens: totals.tokens,
                cumulativeCost: totals.cost
            )
        }
    }

    /// The caption under the summary's cost column.  One billing mode across
    /// every engine in play captions it by that mode; a mix says each engine
    /// reports its own, and that a subscription's figure is an equivalent.
    public static func summaryCostCaption(billings: Set<String?>) -> String {
        if billings.count == 1, let only = billings.first {
            return costCaption(billing: only)
        }
        return "as each engine reports it \u{2014} on a subscription it's an equivalent, not a charge"
    }
}
