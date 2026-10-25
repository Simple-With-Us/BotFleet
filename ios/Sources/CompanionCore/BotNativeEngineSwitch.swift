import Foundation

/// Authoritative runtime owner for a specific bot during the incremental Phase 4–5 cutover.
public enum BotRuntimeOwner: String, Codable, Equatable, Sendable {
    case nodeHarness = "node-harness"
    case nativeSwift = "native-swift"
}

/// Snapshot of a bot's threads and messages exported from the Node store or native SQLite store.
public struct BotHistoryImportSnapshot: Equatable, Sendable {
    public let botId: String
    public let threads: [ThreadRecord]
    public let messagesByThread: [String: [MessageRecord]]

    public init(
        botId: String,
        threads: [ThreadRecord],
        messagesByThread: [String: [MessageRecord]]
    ) {
        self.botId = botId
        self.threads = threads
        self.messagesByThread = messagesByThread
    }

    public var totalThreadCount: Int {
        threads.count
    }

    public var totalMessageCount: Int {
        messagesByThread.values.reduce(0) { $0 + $1.count }
    }
}

/// Parity report produced when a bot switches between `.nodeHarness` and `.nativeSwift`.
public struct BotSwitchVerificationReport: Equatable, Sendable {
    public let botId: String
    public let previousOwner: BotRuntimeOwner
    public let newOwner: BotRuntimeOwner
    public let verifiedThreadCount: Int
    public let verifiedMessageCount: Int
    public let flushedPendingTurnCount: Int

    public init(
        botId: String,
        previousOwner: BotRuntimeOwner,
        newOwner: BotRuntimeOwner,
        verifiedThreadCount: Int,
        verifiedMessageCount: Int,
        flushedPendingTurnCount: Int
    ) {
        self.botId = botId
        self.previousOwner = previousOwner
        self.newOwner = newOwner
        self.verifiedThreadCount = verifiedThreadCount
        self.verifiedMessageCount = verifiedMessageCount
        self.flushedPendingTurnCount = flushedPendingTurnCount
    }
}

/// Errors thrown by `BotNativeEngineSwitchActor` when enforcing the single-runtime invariant.
public enum BotEngineSwitchError: LocalizedError, Equatable, Sendable {
    case runtimeFenced(botId: String, activeOwner: BotRuntimeOwner, attemptedBy: BotRuntimeOwner)
    case transitionInProgress(botId: String)
    case activeNodeTurnBlocksSwitch(botId: String, turnIds: [String])
    case parityMismatch(botId: String, expectedThreads: Int, actualThreads: Int, expectedMessages: Int, actualMessages: Int)

    public var errorDescription: String? {
        switch self {
        case .runtimeFenced(let botId, let activeOwner, let attemptedBy):
            return "Turn dispatch refused for bot '\(botId)': owned by \(activeOwner.rawValue), so \(attemptedBy.rawValue) is fenced."
        case .transitionInProgress(let botId):
            return "Runtime switch is already in progress for bot '\(botId)'."
        case .activeNodeTurnBlocksSwitch(let botId, let turnIds):
            return "Cannot switch bot '\(botId)' while Node turns are still running: \(turnIds.joined(separator: ", "))."
        case .parityMismatch(let botId, let expT, let actT, let expM, let actM):
            return "History import parity check failed for bot '\(botId)': expected \(expT) threads / \(expM) messages, got \(actT) threads / \(actM) messages."
        }
    }
}

/// Per-bot native engine cutover coordinator enforcing the single-writer / single-runtime invariant.
///
/// Guarantees:
/// 1. Two runtimes (`.nodeHarness` and `.nativeSwift`) never answer the same bot concurrently.
/// 2. Switching a bot to `.nativeSwift` fences incoming Node turns, runs an idempotent import
///    into `DatabaseService`, and verifies thread/message count parity before flipping ownership.
/// 3. Once on `.nativeSwift`, full-text search queries route through `DatabaseService.search` (`messages_fts`).
/// 4. Switching back to `.nodeHarness` flushes any buffered native turn messages into `DatabaseService`
///    and returns a complete snapshot so zero messages are lost across the handback.
public actor BotNativeEngineSwitchActor {
    private struct PendingNativeTurnWrite: Sendable {
        let thread: ThreadRecord
        let message: MessageRecord
    }

    private let database: DatabaseService
    private var owners: [String: BotRuntimeOwner] = [:]
    private var transitioningBots: Set<String> = []
    private var activeTurnsByBot: [String: Set<String>] = [:]
    private var pendingNativeWritesByBot: [String: [PendingNativeTurnWrite]] = [:]

    public init(database: DatabaseService) {
        self.database = database
    }

    /// Returns the current authoritative runtime owner for `botId` (defaults to `.nodeHarness`).
    public func owner(for botId: String) -> BotRuntimeOwner {
        owners[botId] ?? .nodeHarness
    }

    /// Admits a turn only when `callerRuntime` is the current owner for `botId` and no
    /// ownership transition is in progress.  Throws `BotEngineSwitchError.runtimeFenced` otherwise.
    public func beginTurn(botId: String, callerRuntime: BotRuntimeOwner, turnId: String) throws {
        if transitioningBots.contains(botId) {
            throw BotEngineSwitchError.transitionInProgress(botId: botId)
        }
        let currentOwner = owner(for: botId)
        guard currentOwner == callerRuntime else {
            throw BotEngineSwitchError.runtimeFenced(
                botId: botId,
                activeOwner: currentOwner,
                attemptedBy: callerRuntime
            )
        }
        activeTurnsByBot[botId, default: []].insert(turnId)
    }

    /// Marks an in-flight turn as finished for `botId`.
    public func endTurn(botId: String, turnId: String) {
        activeTurnsByBot[botId]?.remove(turnId)
        if activeTurnsByBot[botId]?.isEmpty == true {
            activeTurnsByBot.removeValue(forKey: botId)
        }
    }

    /// Buffers a native turn message to be flushed on turn completion or before a switch-back.
    public func stagePendingNativeTurnWrite(
        botId: String,
        thread: ThreadRecord,
        message: MessageRecord
    ) throws {
        let currentOwner = owner(for: botId)
        guard currentOwner == .nativeSwift else {
            throw BotEngineSwitchError.runtimeFenced(
                botId: botId,
                activeOwner: currentOwner,
                attemptedBy: .nativeSwift
            )
        }
        let normalizedThread = ThreadRecord(
            id: thread.id,
            title: thread.title,
            botId: botId,
            createdAt: thread.createdAt,
            updatedAt: max(thread.updatedAt, message.createdAt)
        )
        pendingNativeWritesByBot[botId, default: []].append(
            PendingNativeTurnWrite(thread: normalizedThread, message: message)
        )
    }

    /// Flushes any staged native turn writes for `botId` into `DatabaseService`.
    @discardableResult
    public func flushPendingNativeWrites(for botId: String) async throws -> Int {
        guard let pending = pendingNativeWritesByBot.removeValue(forKey: botId), !pending.isEmpty else {
            return 0
        }
        for item in pending {
            try await database.upsertThread(item.thread)
            try await database.insertMessage(item.message)
        }
        return pending.count
    }

    /// Switches `botId` from `.nodeHarness` to `.nativeSwift`.
    ///
    /// Fences incoming Node turns, idempotently imports `historySnapshot` into `DatabaseService`,
    /// and verifies thread/message parity before flipping runtime ownership.
    @discardableResult
    public func switchToNativeSwift(
        botId: String,
        historySnapshot: BotHistoryImportSnapshot
    ) async throws -> BotSwitchVerificationReport {
        if transitioningBots.contains(botId) {
            throw BotEngineSwitchError.transitionInProgress(botId: botId)
        }
        let previousOwner = owner(for: botId)
        if previousOwner == .nodeHarness, let running = activeTurnsByBot[botId], !running.isEmpty {
            throw BotEngineSwitchError.activeNodeTurnBlocksSwitch(botId: botId, turnIds: running.sorted())
        }

        transitioningBots.insert(botId)
        defer { transitioningBots.remove(botId) }

        // Idempotent upsert of all threads and messages for this bot
        var uniqueThreadIds = Set<String>()
        var uniqueMessageIds = Set<String>()

        for thread in historySnapshot.threads {
            let normalizedThread = ThreadRecord(
                id: thread.id,
                title: thread.title,
                botId: botId,
                createdAt: thread.createdAt,
                updatedAt: thread.updatedAt
            )
            try await database.upsertThread(normalizedThread)
            uniqueThreadIds.insert(normalizedThread.id)

            let messages = historySnapshot.messagesByThread[normalizedThread.id] ?? []
            for message in messages {
                try await database.insertMessage(message)
                uniqueMessageIds.insert(message.id)
            }
        }

        // Verify parity in DatabaseService before flipping ownership
        let storedThreads = try await database.loadThreads(forBot: botId, limit: max(100, uniqueThreadIds.count + 10))
        let storedThreadIds = Set(storedThreads.map(\.id))
        let verifiedThreads = uniqueThreadIds.intersection(storedThreadIds).count

        var verifiedMessages = 0
        for threadId in uniqueThreadIds {
            let storedMessages = try await database.loadMessages(
                forThread: threadId,
                limit: max(500, (historySnapshot.messagesByThread[threadId]?.count ?? 0) + 10)
            )
            let storedIds = Set(storedMessages.map(\.id))
            let expectedForThread = Set((historySnapshot.messagesByThread[threadId] ?? []).map(\.id))
            verifiedMessages += expectedForThread.intersection(storedIds).count
        }

        guard verifiedThreads == uniqueThreadIds.count && verifiedMessages == uniqueMessageIds.count else {
            throw BotEngineSwitchError.parityMismatch(
                botId: botId,
                expectedThreads: uniqueThreadIds.count,
                actualThreads: verifiedThreads,
                expectedMessages: uniqueMessageIds.count,
                actualMessages: verifiedMessages
            )
        }

        owners[botId] = .nativeSwift
        return BotSwitchVerificationReport(
            botId: botId,
            previousOwner: previousOwner,
            newOwner: .nativeSwift,
            verifiedThreadCount: storedThreads.count,
            verifiedMessageCount: verifiedMessages,
            flushedPendingTurnCount: 0
        )
    }

    /// Switches `botId` back from `.nativeSwift` to `.nodeHarness`, flushing all pending native
    /// writes first and exporting the complete transcript snapshot without data loss.
    public func switchBackToNodeHarness(
        botId: String
    ) async throws -> (report: BotSwitchVerificationReport, exportedSnapshot: BotHistoryImportSnapshot) {
        if transitioningBots.contains(botId) {
            throw BotEngineSwitchError.transitionInProgress(botId: botId)
        }
        let previousOwner = owner(for: botId)
        transitioningBots.insert(botId)
        defer { transitioningBots.remove(botId) }

        let flushedCount = try await flushPendingNativeWrites(for: botId)
        activeTurnsByBot.removeValue(forKey: botId)

        let storedThreads = try await database.loadThreads(forBot: botId, limit: 10_000)
        var messagesByThread: [String: [MessageRecord]] = [:]
        var totalMessages = 0
        for thread in storedThreads {
            let messages = try await database.loadMessages(forThread: thread.id, limit: 100_000)
            messagesByThread[thread.id] = messages
            totalMessages += messages.count
        }

        owners[botId] = .nodeHarness
        let snapshot = BotHistoryImportSnapshot(
            botId: botId,
            threads: storedThreads,
            messagesByThread: messagesByThread
        )
        let report = BotSwitchVerificationReport(
            botId: botId,
            previousOwner: previousOwner,
            newOwner: .nodeHarness,
            verifiedThreadCount: storedThreads.count,
            verifiedMessageCount: totalMessages,
            flushedPendingTurnCount: flushedCount
        )
        return (report, snapshot)
    }

    /// Routes search for a native-switched bot through `DatabaseService.search` (`messages_fts`),
    /// returning results scoped to `botId`'s threads and the measured query latency in milliseconds.
    public func searchMessages(
        forBot botId: String,
        query: String,
        limit: Int = 50
    ) async throws -> (results: [DatabaseSearchResult], elapsedMs: Double) {
        let startNs = DispatchTime.now().uptimeNanoseconds
        let botThreads = try await database.loadThreads(forBot: botId, limit: 10_000)
        let botThreadIds = Set(botThreads.map(\.id))
        let allMatches = try await database.search(query: query, inThread: nil, limit: max(limit * 2, 100))
        let filtered = Array(allMatches.filter { botThreadIds.contains($0.threadId) }.prefix(limit))
        let endNs = DispatchTime.now().uptimeNanoseconds
        let elapsedMs = Double(endNs - startNs) / 1_000_000.0
        return (filtered, elapsedMs)
    }
}
