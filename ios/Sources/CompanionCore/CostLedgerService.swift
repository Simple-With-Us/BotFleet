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
    public let recordedAt: Double

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
        self.recordedAt = recordedAt
    }
}

/// Rolling spend ceiling checked before admitting unattended or background work.
public struct RollingSpendCeiling: Codable, Equatable, Sendable {
    public let windowSeconds: TimeInterval
    public let maxSpendUSD: Double

    public init(windowSeconds: TimeInterval, maxSpendUSD: Double) {
        self.windowSeconds = windowSeconds
        self.maxSpendUSD = maxSpendUSD
    }
}

/// Admission verdict returned by `CostLedgerService.checkAdmission`.
public enum SpendAdmissionVerdict: Equatable, Sendable {
    case allowed(remainingUSD: Double)
    case exceeded(spentUSD: Double, ceilingUSD: Double)
}

/// Aggregated token and USD spend totals across recorded ledger entries.
public struct CostLedgerTotals: Equatable, Sendable {
    public let entryCount: Int
    public let inputTokens: Int
    public let outputTokens: Int
    public let cachedInputTokens: Int
    public let totalCostUSD: Double

    public init(
        entryCount: Int,
        inputTokens: Int,
        outputTokens: Int,
        cachedInputTokens: Int,
        totalCostUSD: Double
    ) {
        self.entryCount = entryCount
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cachedInputTokens = cachedInputTokens
        self.totalCostUSD = totalCostUSD
    }
}

/// Swift spend and quota ledger actor replacing the Node harness cost tracking
/// (`server/gen-ai-cost.ts`, `server/rolling-spend.ts`, `BF-2619`).
public actor CostLedgerService {
    private let storageURL: URL?
    private let maxEntries: Int
    private var entriesStorage: [CostLedgerEntry]
    private var seenEntryIds: Set<String>

    /// Creates an in-memory cost ledger with bounded entry retention.
    public init(maxEntries: Int = 10_000) {
        self.storageURL = nil
        self.maxEntries = max(1, maxEntries)
        self.entriesStorage = []
        self.seenEntryIds = []
    }

    /// Creates a durable cost ledger backed by a `0600` JSON file.
    /// Existing corrupt files fail closed rather than silently resetting spend history.
    public init(storageURL: URL, maxEntries: Int = 10_000) throws {
        guard storageURL.isFileURL, storageURL.path.hasPrefix("/"), storageURL.path != "/" else {
            throw CostLedgerError.persistenceFailed("storageURL must be an absolute non-root file URL.")
        }
        self.storageURL = storageURL
        self.maxEntries = max(1, maxEntries)
        if FileManager.default.fileExists(atPath: storageURL.path) {
            let data = try Data(contentsOf: storageURL)
            let decoded = try JSONDecoder().decode([CostLedgerEntry].self, from: data)
            let clamped = Array(decoded.suffix(self.maxEntries))
            self.entriesStorage = clamped
            self.seenEntryIds = Set(clamped.map(\.id))
        } else {
            self.entriesStorage = []
            self.seenEntryIds = []
        }
    }

    /// Records a single metered call idempotently by `entry.id`.
    public func record(_ entry: CostLedgerEntry) throws {
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
        if seenEntryIds.contains(entry.id) {
            return
        }

        var nextEntries = entriesStorage
        nextEntries.append(entry)
        if nextEntries.count > maxEntries {
            nextEntries.removeFirst(nextEntries.count - maxEntries)
        }
        try persistIfConfigured(nextEntries)

        entriesStorage = nextEntries
        seenEntryIds = Set(nextEntries.map(\.id))
    }

    /// Returns recorded entries in insertion order, optionally filtered by bot.
    public func entries(forBotId botId: String? = nil) -> [CostLedgerEntry] {
        guard let botId else { return entriesStorage }
        return entriesStorage.filter { $0.botId == botId }
    }

    /// Computes aggregate tokens and USD spend across recorded entries.
    public func totals(forBotId botId: String? = nil) -> CostLedgerTotals {
        let filtered = entries(forBotId: botId)
        var input = 0
        var output = 0
        var cached = 0
        var cost = 0.0
        for item in filtered {
            input += item.inputTokens
            output += item.outputTokens
            cached += item.cachedInputTokens
            cost += item.estimatedCostUSD
        }
        return CostLedgerTotals(
            entryCount: filtered.count,
            inputTokens: input,
            outputTokens: output,
            cachedInputTokens: cached,
            totalCostUSD: cost
        )
    }

    /// Computes spend inside `[now - windowSeconds, now]` for rolling budget checks.
    public func rollingSpend(
        windowSeconds: TimeInterval,
        now: Date = Date(),
        forBotId botId: String? = nil
    ) -> Double {
        guard windowSeconds.isFinite, windowSeconds > 0 else { return 0 }
        let nowEpoch = now.timeIntervalSince1970
        let cutoff = nowEpoch - windowSeconds
        return entries(forBotId: botId)
            .filter { $0.recordedAt >= cutoff && $0.recordedAt <= nowEpoch }
            .reduce(0.0) { $0 + $1.estimatedCostUSD }
    }

    /// Checks whether current rolling spend stays strictly below `ceiling.maxSpendUSD`.
    /// Non-finite or non-positive ceilings fail closed.
    public func checkAdmission(
        ceiling: RollingSpendCeiling,
        now: Date = Date(),
        forBotId botId: String? = nil
    ) -> SpendAdmissionVerdict {
        let spent = rollingSpend(windowSeconds: ceiling.windowSeconds, now: now, forBotId: botId)
        guard ceiling.windowSeconds.isFinite,
              ceiling.windowSeconds > 0,
              ceiling.maxSpendUSD.isFinite,
              ceiling.maxSpendUSD > 0 else {
            let safeCeiling = (ceiling.maxSpendUSD.isFinite && ceiling.maxSpendUSD >= 0) ? ceiling.maxSpendUSD : 0
            return .exceeded(spentUSD: spent, ceilingUSD: safeCeiling)
        }
        let remaining = ceiling.maxSpendUSD - spent
        if remaining > 0 {
            return .allowed(remainingUSD: remaining)
        }
        return .exceeded(spentUSD: spent, ceilingUSD: ceiling.maxSpendUSD)
    }

    private func persistIfConfigured(_ items: [CostLedgerEntry]) throws {
        guard let storageURL else { return }
        let parent = storageURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: parent,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(items)

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
