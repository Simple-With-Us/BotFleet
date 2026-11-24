import Foundation

/// Errors emitted by `CostLedgerService` on invalid entries or persistence failures.
public enum CostLedgerError: LocalizedError, Equatable, Sendable {
    case invalidEntry(String)
    case persistenceFailed(String)

    public var errorDescription: String? {
        switch self {
        case .invalidEntry(let detail):
            return "Invalid cost ledger entry: \(detail)"
        case .persistenceFailed(let detail):
            return "Cost ledger persistence failed: \(detail)"
        }
    }
}

/// Single billed or metered model invocation stored by `CostLedgerService` (BF-2619).
public struct CostLedgerEntry: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let botId: String
    public let threadId: String
    public let provider: String
    public let model: String
    public let inputTokens: Int
    public let outputTokens: Int
    public let cachedInputTokens: Int
    public let estimatedCostUSD: Double
    public let isPriced: Bool
    public let recordedAt: Double

    private enum CodingKeys: String, CodingKey {
        case id, botId, threadId, provider, model
        case inputTokens, outputTokens, cachedInputTokens
        case estimatedCostUSD, isPriced, recordedAt
    }

    public init(
        id: String = UUID().uuidString,
        botId: String,
        threadId: String,
        provider: String,
        model: String,
        inputTokens: Int,
        outputTokens: Int,
        cachedInputTokens: Int = 0,
        estimatedCostUSD: Double,
        isPriced: Bool = true,
        recordedAt: Double = Date().timeIntervalSince1970
    ) {
        self.id = id
        self.botId = botId
        self.threadId = threadId
        self.provider = provider
        self.model = model
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cachedInputTokens = cachedInputTokens
        self.estimatedCostUSD = estimatedCostUSD
        self.isPriced = isPriced
        self.recordedAt = recordedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        botId = try container.decode(String.self, forKey: .botId)
        threadId = try container.decode(String.self, forKey: .threadId)
        provider = try container.decode(String.self, forKey: .provider)
        model = try container.decode(String.self, forKey: .model)
        inputTokens = try container.decode(Int.self, forKey: .inputTokens)
        outputTokens = try container.decode(Int.self, forKey: .outputTokens)
        cachedInputTokens = try container.decode(Int.self, forKey: .cachedInputTokens)
        estimatedCostUSD = try container.decode(Double.self, forKey: .estimatedCostUSD)
        isPriced = try container.decodeIfPresent(Bool.self, forKey: .isPriced) ?? true
        recordedAt = try container.decode(Double.self, forKey: .recordedAt)
    }
}

/// Rolling spend ceiling checked before admitting unattended or background work.
/// Mirrors `spendCeilingDecision` in `server/rolling-spend.ts` (`DEFAULT_MIN_PRICED_SHARE = 0.5`).
public struct RollingSpendCeiling: Codable, Equatable, Sendable {
    public static let defaultMinPricedShare: Double = 0.5

    public let windowSeconds: TimeInterval
    public let maxSpendUSD: Double
    public let minPricedShare: Double

    public init(
        windowSeconds: TimeInterval,
        maxSpendUSD: Double,
        minPricedShare: Double = Self.defaultMinPricedShare
    ) {
        self.windowSeconds = windowSeconds
        self.maxSpendUSD = maxSpendUSD
        self.minPricedShare = minPricedShare
    }
}

/// Admission verdict returned by `CostLedgerService.checkAdmission`.
public enum SpendAdmissionVerdict: Equatable, Sendable {
    case allowed(remainingUSD: Double)
    case allowedLowVisibility(spentUSD: Double, pricedShare: Double, unpricedTurns: Int)
    case exceeded(spentUSD: Double, ceilingUSD: Double)

    /// True when the verdict permits starting unattended work.
    public var isAllowed: Bool {
        switch self {
        case .allowed, .allowedLowVisibility:
            return true
        case .exceeded:
            return false
        }
    }
}

/// Aggregated token and USD spend totals across recorded ledger entries.
public struct CostLedgerTotals: Equatable, Sendable {
    public let entryCount: Int
    public let unpricedEntryCount: Int
    public let inputTokens: Int
    public let outputTokens: Int
    public let cachedInputTokens: Int
    public let totalCostUSD: Double

    public init(
        entryCount: Int,
        unpricedEntryCount: Int = 0,
        inputTokens: Int,
        outputTokens: Int,
        cachedInputTokens: Int,
        totalCostUSD: Double
    ) {
        self.entryCount = entryCount
        self.unpricedEntryCount = unpricedEntryCount
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cachedInputTokens = cachedInputTokens
        self.totalCostUSD = totalCostUSD
    }
}

private struct PersistedCostLedgerState: Codable {
    let entries: [CostLedgerEntry]
    let seenEntryIds: [String]
}

/// Swift spend and quota ledger actor replacing the Node harness cost tracking
/// (`server/gen-ai-cost.ts`, `server/rolling-spend.ts`, `BF-2619`).
public actor CostLedgerService {
    /// Maximum allowed forward clock skew on `recordedAt` (`5 minutes`).
    public static let defaultMaxFutureSkewSeconds: TimeInterval = 300

    private let storageURL: URL?
    private let maxEntries: Int
    private let maxSeenIds: Int
    private var entriesStorage: [CostLedgerEntry]
    private var retainedEntryIds: Set<String>
    private var seenIdOrder: [String]
    private var seenEntryIds: Set<String>

    /// Creates an in-memory cost ledger with bounded entry retention and idempotency history.
    public init(maxEntries: Int = 10_000, maxSeenIds: Int? = nil) {
        let resolvedEntries = max(1, maxEntries)
        self.storageURL = nil
        self.maxEntries = resolvedEntries
        self.maxSeenIds = Self.resolveSeenHistoryLimit(maxEntries: resolvedEntries, maxSeenIds: maxSeenIds)
        self.entriesStorage = []
        self.retainedEntryIds = []
        self.seenIdOrder = []
        self.seenEntryIds = []
    }

    /// Creates a durable cost ledger backed by a `0600` JSON file.
    /// Existing corrupt files fail closed rather than silently resetting spend history.
    public init(storageURL: URL, maxEntries: Int = 10_000, maxSeenIds: Int? = nil) throws {
        guard storageURL.isFileURL, storageURL.path.hasPrefix("/"), storageURL.path != "/" else {
            throw CostLedgerError.persistenceFailed("storageURL must be an absolute non-root file URL.")
        }
        let resolvedEntries = max(1, maxEntries)
        let resolvedSeen = Self.resolveSeenHistoryLimit(maxEntries: resolvedEntries, maxSeenIds: maxSeenIds)
        self.storageURL = storageURL
        self.maxEntries = resolvedEntries
        self.maxSeenIds = resolvedSeen
        if FileManager.default.fileExists(atPath: storageURL.path) {
            let data = try Data(contentsOf: storageURL)
            let decoder = JSONDecoder()
            if let envelope = try? decoder.decode(PersistedCostLedgerState.self, from: data) {
                let clamped = Array(envelope.entries.suffix(resolvedEntries))
                let retained = Set(clamped.map(\.id))
                var combinedOrder = envelope.seenEntryIds
                var combinedSet = Set(combinedOrder)
                for item in clamped where !combinedSet.contains(item.id) {
                    combinedOrder.append(item.id)
                    combinedSet.insert(item.id)
                }
                if combinedOrder.count > resolvedSeen {
                    let overflow = combinedOrder.count - resolvedSeen
                    for evictedId in combinedOrder.prefix(overflow) where !retained.contains(evictedId) {
                        combinedSet.remove(evictedId)
                    }
                    combinedOrder.removeFirst(overflow)
                }
                self.entriesStorage = clamped
                self.retainedEntryIds = retained
                self.seenIdOrder = combinedOrder
                self.seenEntryIds = combinedSet
            } else {
                let decoded = try decoder.decode([CostLedgerEntry].self, from: data)
                let clamped = Array(decoded.suffix(resolvedEntries))
                let order = clamped.map(\.id)
                let retained = Set(order)
                self.entriesStorage = clamped
                self.retainedEntryIds = retained
                self.seenIdOrder = order
                self.seenEntryIds = retained
            }
        } else {
            self.entriesStorage = []
            self.retainedEntryIds = []
            self.seenIdOrder = []
            self.seenEntryIds = []
        }
    }

    private static func resolveSeenHistoryLimit(maxEntries: Int, maxSeenIds: Int?) -> Int {
        if let maxSeenIds {
            return max(maxEntries, maxSeenIds)
        }
        let scaled = maxEntries.multipliedReportingOverflow(by: 10)
        let tenX = scaled.overflow ? Int.max : scaled.partialValue
        return max(maxEntries, max(tenX, 100_000))
    }

    /// Records a single metered call idempotently by `entry.id`.
    public func record(_ entry: CostLedgerEntry, now: Date = Date()) throws {
        guard !entry.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw CostLedgerError.invalidEntry("entry.id must not be empty.")
        }
        guard !entry.botId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !entry.threadId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !entry.provider.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !entry.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw CostLedgerError.invalidEntry("botId, threadId, provider, and model must not be empty.")
        }
        guard entry.inputTokens >= 0, entry.outputTokens >= 0, entry.cachedInputTokens >= 0 else {
            throw CostLedgerError.invalidEntry("token counts must be non-negative.")
        }
        guard entry.estimatedCostUSD.isFinite, entry.estimatedCostUSD >= 0 else {
            throw CostLedgerError.invalidEntry("estimatedCostUSD must be finite and non-negative.")
        }
        guard entry.recordedAt.isFinite else {
            throw CostLedgerError.invalidEntry("recordedAt must be finite.")
        }
        guard entry.recordedAt <= now.timeIntervalSince1970 + Self.defaultMaxFutureSkewSeconds else {
            throw CostLedgerError.invalidEntry("recordedAt exceeds maximum allowed future clock skew.")
        }
        if seenEntryIds.contains(entry.id) {
            return
        }

        var nextEntries = entriesStorage
        nextEntries.append(entry)
        var nextRetainedIds = retainedEntryIds
        nextRetainedIds.insert(entry.id)
        if nextEntries.count > maxEntries {
            let overflow = nextEntries.count - maxEntries
            for dropped in nextEntries.prefix(overflow) {
                nextRetainedIds.remove(dropped.id)
            }
            nextEntries.removeFirst(overflow)
        }

        var nextSeenOrder = seenIdOrder
        nextSeenOrder.append(entry.id)
        var nextSeenSet = seenEntryIds
        nextSeenSet.insert(entry.id)
        if nextSeenOrder.count > maxSeenIds {
            let overflow = nextSeenOrder.count - maxSeenIds
            for evictedId in nextSeenOrder.prefix(overflow) where !nextRetainedIds.contains(evictedId) {
                nextSeenSet.remove(evictedId)
            }
            nextSeenOrder.removeFirst(overflow)
        }

        try persistIfConfigured(entries: nextEntries, seenIds: nextSeenOrder)

        entriesStorage = nextEntries
        retainedEntryIds = nextRetainedIds
        seenIdOrder = nextSeenOrder
        seenEntryIds = nextSeenSet
    }

    /// Returns recorded entries in insertion order, optionally filtered by bot.
    public func entries(forBotId botId: String? = nil) -> [CostLedgerEntry] {
        guard let botId else { return entriesStorage }
        return entriesStorage.filter { $0.botId == botId }
    }

    /// Computes aggregate tokens, unpriced turn count, and USD spend across recorded entries.
    public func totals(forBotId botId: String? = nil) -> CostLedgerTotals {
        let filtered = entries(forBotId: botId)
        var unpriced = 0
        var input = 0
        var output = 0
        var cached = 0
        var cost = 0.0
        for item in filtered {
            if !item.isPriced {
                unpriced += 1
            }
            input += item.inputTokens
            output += item.outputTokens
            cached += item.cachedInputTokens
            cost += item.estimatedCostUSD
        }
        return CostLedgerTotals(
            entryCount: filtered.count,
            unpricedEntryCount: unpriced,
            inputTokens: input,
            outputTokens: output,
            cachedInputTokens: cached,
            totalCostUSD: cost
        )
    }

    /// Computes spend inside `[now - windowSeconds, now + defaultMaxFutureSkewSeconds]` for rolling budget checks.
    /// Small forward clock skew counts immediately without letting far-future timestamps stay in the window forever.
    public func rollingSpend(
        windowSeconds: TimeInterval,
        now: Date = Date(),
        forBotId botId: String? = nil
    ) -> Double {
        let windowEntries = rollingWindowEntries(windowSeconds: windowSeconds, now: now, forBotId: botId)
        return windowEntries.reduce(0.0) { $0 + $1.estimatedCostUSD }
    }

    /// Checks whether current rolling spend stays strictly below `ceiling.maxSpendUSD`,
    /// mirroring `spendCeilingDecision` (`server/rolling-spend.ts`): when `pricedShare` falls
    /// below `ceiling.minPricedShare`, refuses to block on a known floor total and returns
    /// `.allowedLowVisibility(...)`.  Non-finite or invalid ceilings fail closed.
    public func checkAdmission(
        ceiling: RollingSpendCeiling,
        now: Date = Date(),
        forBotId botId: String? = nil
    ) -> SpendAdmissionVerdict {
        let windowEntries = rollingWindowEntries(windowSeconds: ceiling.windowSeconds, now: now, forBotId: botId)
        let spent = windowEntries.reduce(0.0) { $0 + $1.estimatedCostUSD }
        guard ceiling.windowSeconds.isFinite,
              ceiling.windowSeconds > 0,
              ceiling.maxSpendUSD.isFinite,
              ceiling.maxSpendUSD > 0,
              ceiling.minPricedShare.isFinite,
              ceiling.minPricedShare >= 0,
              ceiling.minPricedShare <= 1 else {
            let safeCeiling = (ceiling.maxSpendUSD.isFinite && ceiling.maxSpendUSD >= 0) ? ceiling.maxSpendUSD : 0
            return .exceeded(spentUSD: spent, ceilingUSD: safeCeiling)
        }

        let totalTurns = windowEntries.count
        let unpricedTurns = windowEntries.reduce(0) { $0 + ($1.isPriced ? 0 : 1) }
        let pricedShare = totalTurns > 0
            ? max(0.0, min(1.0, Double(totalTurns - unpricedTurns) / Double(totalTurns)))
            : 1.0

        if pricedShare < ceiling.minPricedShare {
            return .allowedLowVisibility(
                spentUSD: spent,
                pricedShare: pricedShare,
                unpricedTurns: unpricedTurns
            )
        }

        let remaining = ceiling.maxSpendUSD - spent
        if remaining > 0 {
            return .allowed(remainingUSD: remaining)
        }
        return .exceeded(spentUSD: spent, ceilingUSD: ceiling.maxSpendUSD)
    }

    private func rollingWindowEntries(
        windowSeconds: TimeInterval,
        now: Date,
        forBotId botId: String?
    ) -> [CostLedgerEntry] {
        guard windowSeconds.isFinite, windowSeconds > 0 else { return [] }
        let nowEpoch = now.timeIntervalSince1970
        let cutoff = nowEpoch - windowSeconds
        let upperBound = nowEpoch + Self.defaultMaxFutureSkewSeconds
        return entries(forBotId: botId).filter { $0.recordedAt >= cutoff && $0.recordedAt <= upperBound }
    }

    private func persistIfConfigured(entries: [CostLedgerEntry], seenIds: [String]) throws {
        guard let storageURL else { return }
        let parent = storageURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: parent,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let payload = PersistedCostLedgerState(entries: entries, seenEntryIds: seenIds)
        let data = try encoder.encode(payload)

        let tempURL = parent.appendingPathComponent(".\(storageURL.lastPathComponent).\(UUID().uuidString).tmp")
        let created = FileManager.default.createFile(
            atPath: tempURL.path,
            contents: data,
            attributes: [.posixPermissions: 0o600]
        )
        guard created else {
            throw CostLedgerError.persistenceFailed("could not create temp ledger file with 0600 permissions.")
        }
        do {
            if FileManager.default.fileExists(atPath: storageURL.path) {
                _ = try FileManager.default.replaceItemAt(storageURL, withItemAt: tempURL)
            } else {
                try FileManager.default.moveItem(at: tempURL, to: storageURL)
            }
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: storageURL.path)
        } catch {
            try? FileManager.default.removeItem(at: tempURL)
            throw error
        }
    }
}
