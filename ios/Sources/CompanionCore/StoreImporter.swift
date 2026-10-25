import CryptoKit
import Foundation
import SQLite3

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

public enum StoreImportError: LocalizedError, Equatable {
    case sourceDirectoryMissing(String)
    case sourceDatabaseOpenFailed(String)
    case sourceQueryFailed(String)
    case invalidJSONFormat(file: String, reason: String)
    case unknownSourceColumns(source: String, columns: [String])
    case interruptedAfterBatch(completedBatches: Int)
    case parityMismatch(reasons: [String])
    /// A message id in the source belongs to two different threads.
    ///
    /// The native store keys a message on its id alone, so the same id can
    /// only live in one thread there.  The import refuses the whole batch
    /// rather than dropping one of the two messages.
    case messageThreadConflict(id: String, existingThreadId: String, incomingThreadId: String)

    public var errorDescription: String? {
        switch self {
        case .sourceDirectoryMissing(let path):
            return "Source store directory does not exist: \(path)"
        case .sourceDatabaseOpenFailed(let msg):
            return "Failed to open source SQLite store read-only: \(msg)"
        case .sourceQueryFailed(let msg):
            return "Source SQLite query failed: \(msg)"
        case .invalidJSONFormat(let file, let reason):
            return "Invalid JSON in \(file): \(reason)"
        case .unknownSourceColumns(let source, let columns):
            return "Unknown source columns in \(source): \(columns.joined(separator: ", ")).  Refusing to drop unmapped columns silently."
        case .interruptedAfterBatch(let batches):
            return "Import interrupted after \(batches) batch(es) for resumability verification."
        case .parityMismatch(let reasons):
            return "Import parity verification failed: \(reasons.joined(separator: "; "))"
        case .messageThreadConflict(let id, let existingThreadId, let incomingThreadId):
            return "Message '\(id)' belongs to thread '\(existingThreadId)' in the source and cannot be written to thread '\(incomingThreadId)'."
        }
    }
}

/// One durable routine-request commit receipt carried over from the legacy
/// `routines.json` ledger (BF-2495).
///
/// The receipt is the legacy store's record that a confirmed routine-request
/// card was already applied, so a re-issued card cannot apply the same change
/// twice.  The native store holds them in `routine_request_receipts`, keyed
/// on the request id, so the idempotency survives the migration.  The import
/// persists every receipt and also carries them in the parity report.
public struct RoutineRequestReceiptRecord: Equatable, Sendable, Codable {
    public let requestId: String
    public let messageId: String
    public let botId: String
    public let threadId: String
    public let action: String
    public let fingerprintVersion: Int
    public let fingerprint: String
    public let resultId: String
    public let appliedAt: Double

    public init(
        requestId: String,
        messageId: String,
        botId: String,
        threadId: String,
        action: String,
        fingerprintVersion: Int,
        fingerprint: String,
        resultId: String,
        appliedAt: Double
    ) {
        self.requestId = requestId
        self.messageId = messageId
        self.botId = botId
        self.threadId = threadId
        self.action = action
        self.fingerprintVersion = fingerprintVersion
        self.fingerprint = fingerprint
        self.resultId = resultId
        self.appliedAt = appliedAt
    }
}

public struct StoreImportParityReport: Equatable, Sendable, Codable {
    public let sourceBotCount: Int
    public let targetBotCount: Int
    public let sourceThreadCount: Int
    public let targetThreadCount: Int
    public let sourceMessageCount: Int
    public let targetMessageCount: Int
    public let sourceRoutineCount: Int
    public let targetRoutineCount: Int
    public let sourceRoutineRunCount: Int
    public let targetRoutineRunCount: Int
    public let sourceWebhookCount: Int
    public let targetWebhookCount: Int
    public let sourceWebhookDeliveryCount: Int
    public let targetWebhookDeliveryCount: Int
    /// The `webhooks.json` idempotency ledger (`deliveries`): the receipts that
    /// make a redelivered webhook a duplicate instead of a second bot run.
    public let sourceWebhookDeliveryLedgerCount: Int
    public let targetWebhookDeliveryLedgerCount: Int
    /// The `routines.json` commit receipts.  They land in the native
    /// `routine_request_receipts` table, so the target count is the number of
    /// receipts the store holds.
    public let sourceRoutineRequestReceiptCount: Int
    public let targetRoutineRequestReceiptCount: Int
    /// Source messages whose JSON carries metadata the native `messages` table
    /// has no column for (`parentId`, `reactions`, `audio`, `card`, `tool`, …).
    public let sourceMessageMetadataDroppedCount: Int
    /// The distinct JSON keys that were dropped, sorted.
    public let sourceMessageMetadataDroppedFields: [String]
    /// A fingerprint of exactly what was dropped, so the loss is verifiable
    /// instead of silent and a future native column can be checked against it.
    public let sourceMessageMetadataDigestSHA256: String
    /// Every routine-request receipt read from the source.  They are also
    /// persisted in the native `routine_request_receipts` table, so the
    /// idempotency key survives the migration.
    public let routineRequestReceipts: [RoutineRequestReceiptRecord]
    public let perThreadMessageCountsMatch: Bool
    public let orphanedMessageCount: Int
    public let sourceBodyDigestSHA256: String
    public let targetBodyDigestSHA256: String
    public let newlyInsertedMessages: Int
    public let mismatches: [String]
    /// Known schema-limitation gaps: state the native store cannot hold yet.
    /// They are reported, never dropped silently, and never hidden from
    /// `isFullyVerified`.
    public let warnings: [String]

    public var isParityVerified: Bool {
        mismatches.isEmpty &&
        sourceBotCount == targetBotCount &&
        sourceThreadCount == targetThreadCount &&
        sourceMessageCount == targetMessageCount &&
        sourceRoutineCount == targetRoutineCount &&
        sourceRoutineRunCount == targetRoutineRunCount &&
        sourceRoutineRequestReceiptCount == targetRoutineRequestReceiptCount &&
        sourceWebhookCount == targetWebhookCount &&
        sourceWebhookDeliveryCount == targetWebhookDeliveryCount &&
        sourceWebhookDeliveryLedgerCount == targetWebhookDeliveryLedgerCount &&
        perThreadMessageCountsMatch &&
        orphanedMessageCount == 0 &&
        sourceBodyDigestSHA256 == targetBodyDigestSHA256
    }

    /// Parity plus no known gaps: the migration carried every byte it could
    /// and named everything it could not.
    public var isFullyVerified: Bool {
        isParityVerified && warnings.isEmpty
    }
}

/// Canonical location choices for the native SQLite store (BF-2495).
/// Until the Phase 5 single-writer cutover, imports always write to a separate
/// native database file so the Node harness remains the sole writer of `messages.db`.
public enum NativeStoreLocation: Equatable, Sendable {
    case applicationSupport(baseDir: URL? = nil)
    case botfleetDirectoryCopy(baseDir: URL)
    case customFile(URL)

    public func resolvedDatabaseURL() -> URL {
        switch self {
        case .applicationSupport(let base):
            let root = base ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
            return root
                .appendingPathComponent("BotFleet", isDirectory: true)
                .appendingPathComponent("botfleet-native.sqlite3")
        case .botfleetDirectoryCopy(let baseDir):
            return baseDir.appendingPathComponent("botfleet-native.sqlite3")
        case .customFile(let url):
            return url
        }
    }
}

/// One-way, idempotent, resumable importer from the Electron/Node stores under `~/.botfleet`
/// (`messages.db`, `bots.json`, `groups.json`, `routines.json`, `webhooks.json`) into the
/// Swift `DatabaseService` store (BF-2495).
///
/// Sources are opened strictly read-only (`SQLITE_OPEN_READONLY`) and are never modified.
/// Unknown source columns or JSON fields fail loudly so schema drift on the Node side is
/// caught immediately instead of silently dropping data.
///
/// The legacy `messages` table is read one bounded page at a time and each page is
/// handed straight to `insertMessagesBatch`, so a production transcript (58,000 rows,
/// 251 MB) never has to fit in memory and an interrupted import resumes from the
/// transactional batch boundary it stopped at.
public struct StoreImporter: Sendable {
    public static let knownMessagesColumns: Set<String> = [
        "thread_id", "id", "at", "role", "kind", "text", "json"
    ]

    public static let knownThreadStateColumns: Set<String> = [
        "thread_id", "active_leaf_id"
    ]

    public static let knownRunningHelpersColumns: Set<String> = [
        "thread_id", "message_id", "started_at"
    ]

    /// Every key `server/store.ts` persists on a bot record.
    public static let knownBotKeys: Set<String> = [
        "activeModelSelection", "activity", "activityStartedAt", "alwaysAllow",
        "approvePeerComms", "autoApprove", "autoReview", "autoStartVps",
        "avatarCrop", "avatarUrl", "busy", "bypassLocalComputer",
        "bypassPermissions", "chiefOfStaff", "cloudBackend", "color",
        "composio", "computer", "computers", "connectorGrants", "connectorTools",
        "createdAt", "cwd", "description", "extraCwds", "gitWorktreeLeases",
        "hidden", "historySummaryModel", "id", "inflightThreadId",
        "installedPackage", "mascotExpression", "maxHistoryTurns",
        "maxOutputTokens", "maxToolRounds", "mcpServers", "modelSelection",
        "name", "nativeEngine", "notifications", "off", "peerApprovals",
        "pinned", "pinnedCwd", "pinnedMessageId", "playbooks",
        "pronunciations", "resumeCursors", "rewound", "roomUsageByInstance",
        "section", "snoozedUntil", "speakReplies", "speechDevices",
        "systemPrompt", "tasks", "threadId", "title", "toolPolicy", "unread",
        "updatedAt", "userNotes", "voice", "voiceSummaryMode", "voices"
    ]

    /// Every key `server/store.ts` persists on a group record.
    public static let knownGroupKeys: Set<String> = [
        "avatarCrop", "avatarUrl", "bulletin", "createdAt", "cwd",
        "defaultResponder", "dm", "extraCwds", "id", "memberIds",
        "name", "pinned", "pinnedCwd", "pinnedMessageId", "section",
        "setupCompletedAt", "setupSkippedAt", "tasks", "threadId", "unread",
        "updatedAt"
    ]

    public static let knownRoutinesRootKeys: Set<String> = [
        "botSnoozes", "routineRequestReceipts", "routines", "runs", "version"
    ]

    /// Every key `server/routines.ts` persists on a routine definition.
    public static let knownRoutineKeys: Set<String> = [
        "botId", "createdAt", "description", "durationMinutes", "enabled",
        "id", "lastRunAt", "lastRunId", "name", "nextRunAt", "oneShotWake",
        "prompt", "runOn", "schedule", "scheduleTimeZoneSource", "threadId",
        "timezone", "toolPolicy", "updatedAt"
    ]

    /// Every key `server/routines.ts` persists on a routine run.
    public static let knownRoutineRunKeys: Set<String> = [
        "botId", "coalescedInto", "completedAt", "cost", "createdAt",
        "deliveryId", "denials", "driver", "durationMinutes", "engineId",
        "error", "failurePhase", "finishedAt", "holdReason", "hotDeferredAt",
        "id", "manual", "model", "outcomeCode", "output", "ownerThreadId",
        "prompt", "routineId", "routineName", "runOn", "scheduledFor",
        "seenAt", "sentryCheckInId", "setupFailed", "startedAt", "status",
        "threadId", "toolPolicy", "triggerSource", "webhookId"
    ]

    /// Every key `server/routines.ts` persists on a routine-request receipt.
    public static let knownRoutineRequestReceiptKeys: Set<String> = [
        "action", "appliedAt", "botId", "fingerprint", "fingerprintVersion",
        "messageId", "requestId", "resultId", "threadId"
    ]

    public static let knownWebhooksRootKeys: Set<String> = [
        "attempts", "deliveries", "version", "webhooks"
    ]

    public static let knownWebhookKeys: Set<String> = [
        "botId", "createdAt", "deliveryCount", "enabled", "endpointId",
        "eventTypes", "id", "ignoredCount", "lastIgnoredAt", "lastReceivedAt",
        "lastRunId", "mergedPullRequestsOnly", "minGapMinutes", "name",
        "oneShotWake", "prompt", "runOn", "secretHash", "updatedAt",
        "verificationPending", "verificationSample", "verifiedAt"
    ]

    public static let knownWebhookAttemptKeys: Set<String> = [
        "contentType", "deliveryId", "eventName", "id", "outcome",
        "payload", "preview", "reason", "receivedAt", "response",
        "runId", "statusCode", "webhookId"
    ]

    /// Every key `server/webhooks.ts` persists on a delivery receipt (the
    /// durable idempotency ledger).
    public static let knownWebhookDeliveryReceiptKeys: Set<String> = [
        "at", "key", "runId"
    ]

    /// The JSON keys a native `messages` row carries in full.  Every other key
    /// on a legacy row is metadata the native schema has no column for, so the
    /// import reports it instead of dropping it silently.
    public static let nativelyCarriedMessageKeys: Set<String> = [
        "at", "id", "kind", "model", "modelSelection", "role", "text"
    ]

    public let batchSize: Int

    public init(batchSize: Int = 2_000) {
        self.batchSize = max(1, batchSize)
    }

    /// Imports all Electron-era stores under `sourceDirectory` into `targetDatabase`
    /// and returns a complete parity report.
    ///
    /// - Parameters:
    ///   - sourceDirectory: Directory containing `messages.db`, `bots.json`, `routines.json`, `webhooks.json`.
    ///   - targetDatabase: Target `DatabaseService` actor instance.
    ///   - filterBotId: Optional bot ID when importing a single bot's history for the Phase 4 per-bot switch.
    ///   - maxBatchesBeforeInterrupt: Optional test hook to simulate a mid-import crash/kill after N batches.
    public func importStore(
        from sourceDirectory: URL,
        into targetDatabase: DatabaseService,
        filterBotId: String? = nil,
        maxBatchesBeforeInterrupt: Int? = nil
    ) async throws -> StoreImportParityReport {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: sourceDirectory.path, isDirectory: &isDir), isDir.boolValue else {
            throw StoreImportError.sourceDirectoryMissing(sourceDirectory.path)
        }

        // 1. Parse and validate JSON stores first (failing loudly on unknown keys).
        let routinesSnapshot = try loadAndValidateRoutines(from: sourceDirectory, filterBotId: filterBotId)
        let botsSnapshot = try loadAndValidateBots(from: sourceDirectory, filterBotId: filterBotId)
        let groupsSnapshot = try loadAndValidateGroups(from: sourceDirectory)
        let webhooksSnapshot = try loadAndValidateWebhooks(from: sourceDirectory, filterBotId: filterBotId)

        // 2. Upsert bots, routines, webhooks, and the durable delivery ledgers.
        for bot in botsSnapshot.bots {
            try await targetDatabase.upsertBot(bot)
        }
        for routine in routinesSnapshot.routines {
            try await targetDatabase.upsertRoutine(routine)
        }
        for run in routinesSnapshot.runs {
            try await targetDatabase.recordRoutineRun(run)
        }
        // The routine-request receipts are the durable idempotency keys that
        // let a confirmed routine request be confirmed again after a crash
        // without applying its change twice, so they are persisted rather
        // than only carried in the report.
        for receipt in routinesSnapshot.requestReceipts {
            try await targetDatabase.recordRoutineRequestReceipt(receipt)
        }
        for webhook in webhooksSnapshot.webhooks {
            try await targetDatabase.upsertWebhook(webhook)
        }
        // The idempotency ledger first, then the UI history: both land in the
        // native `webhook_deliveries` table, and the ledger row is the one whose
        // id is the legacy delivery key.
        for delivery in webhooksSnapshot.deliveryLedger {
            try await targetDatabase.recordWebhookDelivery(delivery)
        }
        for attempt in webhooksSnapshot.attempts {
            try await targetDatabase.recordWebhookDelivery(attempt)
        }

        // 3. Open messages.db strictly read-only and page through it.
        let source = try openSourceMessagesDatabase(
            at: sourceDirectory.appendingPathComponent("messages.db"),
            knownThreadsFromJSON: botsSnapshot.threadsById.merging(groupsSnapshot.threadsById) { first, _ in first },
            filterBotId: filterBotId
        )

        // Threads known from the JSON stores are the parents of every imported
        // message, so they go in before the first batch.
        var threadsById: [String: ThreadRecord] = [:]
        for thread in source.knownThreads {
            threadsById[thread.id] = thread
            try await targetDatabase.upsertThread(thread)
        }

        // 4. Import messages in resumable transactional batches.  Each page of
        //    the source is one batch, so the read stays bounded the same way
        //    the write already was.
        var newlyInserted = 0
        var completedBatches = 0
        var sourceMessageCount = 0
        var perThreadCounts: [String: Int] = [:]
        var sourceHasher = SHA256()
        var metadataHasher = SHA256()
        var metadataDroppedCount = 0
        var metadataDroppedFields: Set<String> = []

        while true {
            if let limit = maxBatchesBeforeInterrupt, completedBatches >= limit {
                throw StoreImportError.interruptedAfterBatch(completedBatches: completedBatches)
            }
            let page = try source.nextPage(limit: batchSize)
            if page.isEmpty {
                break
            }

            var batch: [MessageRecord] = []
            batch.reserveCapacity(page.count)
            var widenedThreads: [String: ThreadRecord] = [:]

            for row in page {
                sourceMessageCount += 1
                perThreadCounts[row.threadId, default: 0] += 1
                Self.feedDigest(hasher: &sourceHasher, threadId: row.threadId, id: row.id, content: row.content)

                if !row.unmappedMetadataFragment.isEmpty {
                    metadataDroppedCount += 1
                    metadataDroppedFields.formUnion(row.unmappedMetadataKeys)
                    Self.feedDigest(
                        hasher: &metadataHasher,
                        threadId: row.threadId,
                        id: row.id,
                        content: row.unmappedMetadataFragment
                    )
                }

                // Keep every message's thread_id backed by a parent row so the
                // foreign key holds and zero messages end up orphaned.
                if let existing = threadsById[row.threadId] {
                    let widened = ThreadRecord(
                        id: existing.id,
                        title: existing.title,
                        botId: existing.botId,
                        createdAt: min(existing.createdAt, row.createdAt),
                        updatedAt: max(existing.updatedAt, row.createdAt)
                    )
                    if widened != existing {
                        threadsById[row.threadId] = widened
                        widenedThreads[row.threadId] = widened
                    }
                } else {
                    let inferredBotId: String? = row.threadId.hasPrefix("routine:") || row.threadId.hasPrefix("webhook:") ? nil : filterBotId
                    let inferred = ThreadRecord(
                        id: row.threadId,
                        title: row.threadId,
                        botId: inferredBotId,
                        createdAt: row.createdAt,
                        updatedAt: row.createdAt
                    )
                    threadsById[row.threadId] = inferred
                    widenedThreads[row.threadId] = inferred
                }

                batch.append(MessageRecord(
                    id: row.id,
                    threadId: row.threadId,
                    role: row.role,
                    kind: row.kind,
                    content: row.content,
                    createdAt: row.createdAt,
                    model: row.model,
                    activeLeafId: row.activeLeafId
                ))
            }

            for thread in widenedThreads.values {
                try await targetDatabase.upsertThread(thread)
            }
            // A cross-thread message id is a property of the source, not of
            // this import, so it is translated into the importer's own error
            // type.  The caller sees why the import stopped instead of an
            // untranslated storage error that names no thread.
            let changed: Int
            do {
                changed = try await targetDatabase.insertMessagesBatch(batch, skipIdentical: true)
            } catch DatabaseError.messageThreadConflict(let id, let existingThreadId, let incomingThreadId) {
                throw StoreImportError.messageThreadConflict(
                    id: id,
                    existingThreadId: existingThreadId,
                    incomingThreadId: incomingThreadId
                )
            }
            newlyInserted += changed
            completedBatches += 1
        }

        // 5. Compute parity report comparing source snapshot against target DatabaseService.
        return try await buildParityReport(
            botsSnapshot: botsSnapshot,
            routinesSnapshot: routinesSnapshot,
            webhooksSnapshot: webhooksSnapshot,
            sourceThreadCount: threadsById.count,
            sourceMessageCount: sourceMessageCount,
            perThreadCounts: perThreadCounts,
            sourceBodyDigestSHA256: sourceHasher.finalize().map { String(format: "%02x", $0) }.joined(),
            metadataDroppedCount: metadataDroppedCount,
            metadataDroppedFields: metadataDroppedFields.sorted(),
            metadataDigestSHA256: metadataHasher.finalize().map { String(format: "%02x", $0) }.joined(),
            targetDatabase: targetDatabase,
            newlyInsertedMessages: newlyInserted
        )
    }

    // MARK: - JSON Loaders & Schema Validators

    private struct BotsSnapshot {
        let bots: [StoredBotRecord]
        let threadsById: [String: ThreadRecord]
    }

    private struct GroupsSnapshot {
        let threadsById: [String: ThreadRecord]
    }

    private struct RoutinesSnapshot {
        let routines: [StoredRoutineRecord]
        let runs: [RoutineRunRecord]
        /// Durable commit receipts for cross-file confirmation recovery.
        let requestReceipts: [RoutineRequestReceiptRecord]
        /// Manual bot snoozes, which the native schema cannot hold yet.
        let botSnoozeCount: Int
    }

    private struct WebhooksSnapshot {
        let webhooks: [StoredWebhookRecord]
        /// The durable idempotency ledger: one row per accepted delivery.
        let deliveryLedger: [WebhookDeliveryRecord]
        /// UI history, not idempotency state.
        let attempts: [WebhookDeliveryRecord]
        /// Ledger rows whose endpoint no longer resolves to a webhook.
        let unmappedDeliveryCount: Int
    }

    private func loadAndValidateBots(from dir: URL, filterBotId: String?) throws -> BotsSnapshot {
        let url = dir.appendingPathComponent("bots.json")
        guard FileManager.default.fileExists(atPath: url.path) else {
            return BotsSnapshot(bots: [], threadsById: [:])
        }
        let data = try Data(contentsOf: url)
        guard let rawArray = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            throw StoreImportError.invalidJSONFormat(file: "bots.json", reason: "Expected top-level JSON array")
        }

        var bots: [StoredBotRecord] = []
        var threadsById: [String: ThreadRecord] = [:]

        for item in rawArray {
            let unknown = Set(item.keys).subtracting(Self.knownBotKeys).sorted()
            if !unknown.isEmpty {
                throw StoreImportError.unknownSourceColumns(source: "bots.json", columns: unknown)
            }
            guard let id = item["id"] as? String, !id.isEmpty else {
                throw StoreImportError.invalidJSONFormat(file: "bots.json", reason: "Bot record missing string id")
            }
            if let filter = filterBotId, id != filter {
                continue
            }
            let name = (item["name"] as? String) ?? (item["title"] as? String) ?? id
            let threadId = item["threadId"] as? String
            let createdAt = Self.normalizeSeconds(item["createdAt"])
            let updatedAt = Self.normalizeSeconds(item["updatedAt"]) > 0 ? Self.normalizeSeconds(item["updatedAt"]) : createdAt
            let rawJSONData = try JSONSerialization.data(withJSONObject: item, options: [.sortedKeys])
            let rawJSON = String(data: rawJSONData, encoding: .utf8) ?? "{}"

            bots.append(StoredBotRecord(id: id, name: name, threadId: threadId, createdAt: createdAt, rawJSON: rawJSON))

            if let mainThreadId = threadId, !mainThreadId.isEmpty {
                threadsById[mainThreadId] = ThreadRecord(
                    id: mainThreadId,
                    title: name,
                    botId: id,
                    createdAt: createdAt,
                    updatedAt: updatedAt
                )
            }

            if let tasks = item["tasks"] as? [[String: Any]] {
                for task in tasks {
                    if let taskThreadId = (task["threadId"] as? String) ?? (task["id"] as? String), !taskThreadId.isEmpty {
                        let taskTitle = (task["title"] as? String) ?? (task["name"] as? String) ?? name
                        let taskCreated = Self.normalizeSeconds(task["createdAt"], fallback: createdAt)
                        let taskUpdated = Self.normalizeSeconds(task["updatedAt"], fallback: taskCreated)
                        threadsById[taskThreadId] = ThreadRecord(
                            id: taskThreadId,
                            title: taskTitle,
                            botId: id,
                            createdAt: taskCreated,
                            updatedAt: taskUpdated
                        )
                    }
                }
            }
        }

        return BotsSnapshot(bots: bots, threadsById: threadsById)
    }

    private func loadAndValidateGroups(from dir: URL) throws -> GroupsSnapshot {
        let url = dir.appendingPathComponent("groups.json")
        guard FileManager.default.fileExists(atPath: url.path) else {
            return GroupsSnapshot(threadsById: [:])
        }
        let data = try Data(contentsOf: url)
        guard let rawArray = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            throw StoreImportError.invalidJSONFormat(file: "groups.json", reason: "Expected top-level JSON array")
        }

        var threadsById: [String: ThreadRecord] = [:]
        for item in rawArray {
            let unknown = Set(item.keys).subtracting(Self.knownGroupKeys).sorted()
            if !unknown.isEmpty {
                throw StoreImportError.unknownSourceColumns(source: "groups.json", columns: unknown)
            }
            let groupName = (item["name"] as? String) ?? "Room"
            let createdAt = Self.normalizeSeconds(item["createdAt"])
            if let threadId = item["threadId"] as? String, !threadId.isEmpty {
                threadsById[threadId] = ThreadRecord(
                    id: threadId,
                    title: groupName,
                    botId: nil,
                    createdAt: createdAt,
                    updatedAt: createdAt
                )
            }
            if let tasks = item["tasks"] as? [[String: Any]] {
                for task in tasks {
                    if let taskThreadId = (task["threadId"] as? String) ?? (task["id"] as? String), !taskThreadId.isEmpty {
                        let taskTitle = (task["title"] as? String) ?? (task["name"] as? String) ?? groupName
                        let taskCreated = Self.normalizeSeconds(task["createdAt"], fallback: createdAt)
                        let taskUpdated = Self.normalizeSeconds(task["updatedAt"], fallback: taskCreated)
                        threadsById[taskThreadId] = ThreadRecord(
                            id: taskThreadId,
                            title: taskTitle,
                            botId: nil,
                            createdAt: taskCreated,
                            updatedAt: taskUpdated
                        )
                    }
                }
            }
        }
        return GroupsSnapshot(threadsById: threadsById)
    }

    private func loadAndValidateRoutines(from dir: URL, filterBotId: String?) throws -> RoutinesSnapshot {
        let url = dir.appendingPathComponent("routines.json")
        guard FileManager.default.fileExists(atPath: url.path) else {
            return RoutinesSnapshot(routines: [], runs: [], requestReceipts: [], botSnoozeCount: 0)
        }
        let data = try Data(contentsOf: url)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw StoreImportError.invalidJSONFormat(file: "routines.json", reason: "Expected top-level JSON object")
        }
        let unknownRoot = Set(root.keys).subtracting(Self.knownRoutinesRootKeys).sorted()
        if !unknownRoot.isEmpty {
            throw StoreImportError.unknownSourceColumns(source: "routines.json", columns: unknownRoot)
        }

        let rawRoutines = (root["routines"] as? [[String: Any]]) ?? []
        var routines: [StoredRoutineRecord] = []
        for item in rawRoutines {
            let unknown = Set(item.keys).subtracting(Self.knownRoutineKeys).sorted()
            if !unknown.isEmpty {
                throw StoreImportError.unknownSourceColumns(source: "routines.json.routines", columns: unknown)
            }
            guard let id = item["id"] as? String, !id.isEmpty,
                  let botId = item["botId"] as? String else {
                throw StoreImportError.invalidJSONFormat(file: "routines.json", reason: "Routine missing id or botId")
            }
            if let filter = filterBotId, botId != filter {
                continue
            }
            let name = (item["name"] as? String) ?? id
            let scheduleStr: String
            if let s = item["schedule"] as? String {
                scheduleStr = s
            } else if let sObj = item["schedule"] {
                let sData = try JSONSerialization.data(withJSONObject: sObj, options: [.sortedKeys])
                scheduleStr = String(data: sData, encoding: .utf8) ?? "{}"
            } else {
                scheduleStr = ""
            }
            let enabled = (item["enabled"] as? Bool) ?? true
            let createdAt = Self.normalizeSeconds(item["createdAt"])
            let updatedAt = Self.normalizeSeconds(item["updatedAt"], fallback: createdAt)
            let rawData = try JSONSerialization.data(withJSONObject: item, options: [.sortedKeys])
            let rawJSON = String(data: rawData, encoding: .utf8) ?? "{}"

            routines.append(StoredRoutineRecord(
                id: id,
                name: name,
                botId: botId,
                schedule: scheduleStr,
                enabled: enabled,
                createdAt: createdAt,
                updatedAt: updatedAt,
                rawJSON: rawJSON
            ))
        }

        let rawRuns = (root["runs"] as? [[String: Any]]) ?? []
        var runs: [RoutineRunRecord] = []
        for item in rawRuns {
            let unknown = Set(item.keys).subtracting(Self.knownRoutineRunKeys).sorted()
            if !unknown.isEmpty {
                throw StoreImportError.unknownSourceColumns(source: "routines.json.runs", columns: unknown)
            }
            guard let id = item["id"] as? String, !id.isEmpty else {
                throw StoreImportError.invalidJSONFormat(file: "routines.json", reason: "Routine run missing id")
            }
            let routineId = (item["routineId"] as? String) ?? (item["webhookId"] as? String) ?? "unknown"
            let botId = (item["botId"] as? String) ?? "unknown"
            if let filter = filterBotId, botId != filter {
                continue
            }
            let status = (item["status"] as? String) ?? "completed"
            let startedAt = Self.normalizeSeconds(item["startedAt"] ?? item["createdAt"] ?? item["scheduledFor"])
            let completedAt: Double? = (item["finishedAt"] ?? item["completedAt"]).map { Self.normalizeSeconds($0) }
            let error = item["error"] as? String

            runs.append(RoutineRunRecord(
                id: id,
                routineId: routineId,
                botId: botId,
                status: status,
                startedAt: startedAt,
                completedAt: completedAt,
                error: error
            ))
        }

        // The commit receipts are durable recovery state: a receipt records that
        // a confirmed routine-request card was already applied, so the same
        // card cannot apply its change twice after the migration.
        var requestReceipts: [RoutineRequestReceiptRecord] = []
        if let rawReceipts = root["routineRequestReceipts"] as? [[String: Any]] {
            for item in rawReceipts {
                let unknown = Set(item.keys).subtracting(Self.knownRoutineRequestReceiptKeys).sorted()
                if !unknown.isEmpty {
                    throw StoreImportError.unknownSourceColumns(source: "routines.json.routineRequestReceipts", columns: unknown)
                }
                guard let requestId = item["requestId"] as? String, !requestId.isEmpty,
                      let messageId = item["messageId"] as? String,
                      let botId = item["botId"] as? String,
                      let threadId = item["threadId"] as? String,
                      let action = item["action"] as? String,
                      let fingerprint = item["fingerprint"] as? String,
                      let resultId = item["resultId"] as? String,
                      let fingerprintVersion = item["fingerprintVersion"] as? Int,
                      item["appliedAt"] as? NSNumber != nil else {
                    throw StoreImportError.invalidJSONFormat(file: "routines.json", reason: "Routine request receipt is missing a required field")
                }
                if let filter = filterBotId, botId != filter {
                    continue
                }
                requestReceipts.append(RoutineRequestReceiptRecord(
                    requestId: requestId,
                    messageId: messageId,
                    botId: botId,
                    threadId: threadId,
                    action: action,
                    fingerprintVersion: fingerprintVersion,
                    fingerprint: fingerprint,
                    resultId: resultId,
                    appliedAt: Self.normalizeSeconds(item["appliedAt"])
                ))
            }
        }

        // Manual snoozes survive restarts in the legacy store.  The native
        // schema has no column for them, so they are reported, not dropped
        // silently.
        let botSnoozeCount = (root["botSnoozes"] as? [String: Any])?.count ?? 0

        return RoutinesSnapshot(
            routines: routines,
            runs: runs,
            requestReceipts: requestReceipts,
            botSnoozeCount: botSnoozeCount
        )
    }

    private func loadAndValidateWebhooks(from dir: URL, filterBotId: String?) throws -> WebhooksSnapshot {
        let url = dir.appendingPathComponent("webhooks.json")
        guard FileManager.default.fileExists(atPath: url.path) else {
            return WebhooksSnapshot(webhooks: [], deliveryLedger: [], attempts: [], unmappedDeliveryCount: 0)
        }
        let data = try Data(contentsOf: url)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw StoreImportError.invalidJSONFormat(file: "webhooks.json", reason: "Expected top-level JSON object")
        }
        let unknownRoot = Set(root.keys).subtracting(Self.knownWebhooksRootKeys).sorted()
        if !unknownRoot.isEmpty {
            throw StoreImportError.unknownSourceColumns(source: "webhooks.json", columns: unknownRoot)
        }

        let rawWebhooks = (root["webhooks"] as? [[String: Any]]) ?? []
        var webhooks: [StoredWebhookRecord] = []
        var webhookBotMap: [String: String] = [:]
        var endpointOwners: [String: (webhookId: String, botId: String)] = [:]

        for item in rawWebhooks {
            let unknown = Set(item.keys).subtracting(Self.knownWebhookKeys).sorted()
            if !unknown.isEmpty {
                throw StoreImportError.unknownSourceColumns(source: "webhooks.json.webhooks", columns: unknown)
            }
            guard let id = item["id"] as? String, !id.isEmpty,
                  let botId = item["botId"] as? String else {
                throw StoreImportError.invalidJSONFormat(file: "webhooks.json", reason: "Webhook missing id or botId")
            }
            webhookBotMap[id] = botId
            let endpointId = (item["endpointId"] as? String) ?? id
            endpointOwners[endpointId] = (webhookId: id, botId: botId)
            if let filter = filterBotId, botId != filter {
                continue
            }
            let name = (item["name"] as? String) ?? id
            let enabled = (item["enabled"] as? Bool) ?? true
            let createdAt = Self.normalizeSeconds(item["createdAt"])
            let updatedAt = Self.normalizeSeconds(item["updatedAt"], fallback: createdAt)
            let rawData = try JSONSerialization.data(withJSONObject: item, options: [.sortedKeys])
            let rawJSON = String(data: rawData, encoding: .utf8) ?? "{}"

            webhooks.append(StoredWebhookRecord(
                id: id,
                endpointId: endpointId,
                name: name,
                botId: botId,
                enabled: enabled,
                createdAt: createdAt,
                updatedAt: updatedAt,
                rawJSON: rawJSON
            ))
        }

        // The delivery ledger is the durable idempotency state: one receipt per
        // accepted delivery, keyed "<endpointId>:<deliveryId>".  Dropping it
        // would let a redelivered webhook run the bot a second time.
        var deliveryLedger: [WebhookDeliveryRecord] = []
        var unmappedDeliveryCount = 0
        if let rawDeliveries = root["deliveries"] as? [[String: Any]] {
            for item in rawDeliveries {
                let unknown = Set(item.keys).subtracting(Self.knownWebhookDeliveryReceiptKeys).sorted()
                if !unknown.isEmpty {
                    throw StoreImportError.unknownSourceColumns(source: "webhooks.json.deliveries", columns: unknown)
                }
                guard let key = item["key"] as? String, !key.isEmpty,
                      let runId = item["runId"] as? String, !runId.isEmpty else {
                    throw StoreImportError.invalidJSONFormat(file: "webhooks.json", reason: "Webhook delivery receipt missing key or runId")
                }
                let endpointId = String(key.prefix(while: { $0 != ":" }))
                guard let owner = endpointOwners[endpointId] else {
                    unmappedDeliveryCount += 1
                    continue
                }
                if let filter = filterBotId, owner.botId != filter {
                    continue
                }
                deliveryLedger.append(WebhookDeliveryRecord(
                    id: key,
                    webhookId: owner.webhookId,
                    botId: owner.botId,
                    statusCode: nil,
                    deliveredAt: Self.normalizeSeconds(item["at"]),
                    payload: nil,
                    response: nil
                ))
            }
        }

        // The attempts are UI history, not idempotency state, but they are the
        // only record of what a webhook returned, so they are migrated too.
        let rawAttempts = (root["attempts"] as? [[String: Any]]) ?? []
        var attempts: [WebhookDeliveryRecord] = []
        for item in rawAttempts {
            let unknown = Set(item.keys).subtracting(Self.knownWebhookAttemptKeys).sorted()
            if !unknown.isEmpty {
                throw StoreImportError.unknownSourceColumns(source: "webhooks.json.attempts", columns: unknown)
            }
            guard let id = item["id"] as? String, !id.isEmpty,
                  let webhookId = item["webhookId"] as? String else {
                throw StoreImportError.invalidJSONFormat(file: "webhooks.json", reason: "Webhook attempt missing id or webhookId")
            }
            let botId = webhookBotMap[webhookId]
            if let filter = filterBotId, botId != filter {
                continue
            }
            let statusCode = item["statusCode"] as? Int
            let deliveredAt = Self.normalizeSeconds(item["receivedAt"])
            let payload = (item["payload"] as? String) ?? (item["preview"] as? String)
            let response = (item["response"] as? String) ?? (item["reason"] as? String) ?? (item["outcome"] as? String)

            attempts.append(WebhookDeliveryRecord(
                id: id,
                webhookId: webhookId,
                botId: botId,
                statusCode: statusCode,
                deliveredAt: deliveredAt,
                payload: payload,
                response: response
            ))
        }

        return WebhooksSnapshot(
            webhooks: webhooks,
            deliveryLedger: deliveryLedger,
            attempts: attempts,
            unmappedDeliveryCount: unmappedDeliveryCount
        )
    }

    // MARK: - Read-Only SQLite Source Reader

    /// One legacy message row, already mapped onto the native shape.
    private struct SourceMessageRow {
        let threadId: String
        let id: String
        let createdAt: Double
        let role: String
        let kind: String
        let content: String
        let model: String?
        /// The thread's active leaf, only on the message that IS the leaf.
        let activeLeafId: String?
        /// The JSON keys the native `messages` row cannot carry.
        let unmappedMetadataKeys: [String]
        /// A canonical fragment of the dropped metadata, for the loss digest.
        let unmappedMetadataFragment: String
    }

    /// A read-only cursor over the legacy `messages` table.
    ///
    /// The cursor yields one bounded page at a time, so the whole transcript
    /// never has to fit in memory: each page goes straight into
    /// `insertMessagesBatch` and is released.  The cursor is a keyset cursor
    /// on `(thread_id, id)`, which keeps the read order identical to the
    /// target's digest order (`ORDER BY thread_id, id`) so parity still holds.
    private final class SourceMessagesReader {
        private static let firstPageSQL = """
        SELECT thread_id, id, at, role, kind, text, json
        FROM messages
        ORDER BY thread_id ASC, id ASC
        LIMIT ?1;
        """

        private static let nextPageSQL = """
        SELECT thread_id, id, at, role, kind, text, json
        FROM messages
        WHERE (thread_id, id) > (?1, ?2)
        ORDER BY thread_id ASC, id ASC
        LIMIT ?3;
        """

        private let db: OpaquePointer?
        private var firstStatement: OpaquePointer?
        private var cursorStatement: OpaquePointer?
        private let activeLeafByThread: [String: String]
        private let allowedThreadIds: Set<String>?
        private var lastThreadId: String?
        private var lastMessageId: String?
        private var isExhausted = false

        let knownThreads: [ThreadRecord]

        init(
            db: OpaquePointer?,
            knownThreads: [ThreadRecord],
            activeLeafByThread: [String: String],
            allowedThreadIds: Set<String>?
        ) throws {
            self.db = db
            self.knownThreads = knownThreads
            self.activeLeafByThread = activeLeafByThread
            self.allowedThreadIds = allowedThreadIds

            guard let db else { return }
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, Self.firstPageSQL, -1, &stmt, nil) == SQLITE_OK else {
                throw StoreImportError.sourceQueryFailed(String(cString: sqlite3_errmsg(db)))
            }
            firstStatement = stmt
        }

        deinit {
            if let firstStatement {
                sqlite3_finalize(firstStatement)
            }
            if let cursorStatement {
                sqlite3_finalize(cursorStatement)
            }
            if let db {
                sqlite3_close(db)
            }
        }

        /// Reads the next bounded page of source rows.  An empty page means the
        /// source is exhausted.
        func nextPage(limit: Int) throws -> [SourceMessageRow] {
            guard !isExhausted, let db else { return [] }
            let pageSize = max(1, limit)

            let stmt: OpaquePointer
            if lastThreadId == nil {
                guard let firstStatement else { return [] }
                sqlite3_reset(firstStatement)
                sqlite3_clear_bindings(firstStatement)
                sqlite3_bind_int(firstStatement, 1, Int32(pageSize))
                stmt = firstStatement
            } else {
                if cursorStatement == nil {
                    var prepared: OpaquePointer?
                    guard sqlite3_prepare_v2(db, Self.nextPageSQL, -1, &prepared, nil) == SQLITE_OK else {
                        throw StoreImportError.sourceQueryFailed(String(cString: sqlite3_errmsg(db)))
                    }
                    cursorStatement = prepared
                }
                guard let cursorStatement else { return [] }
                sqlite3_reset(cursorStatement)
                sqlite3_clear_bindings(cursorStatement)
                sqlite3_bind_text(cursorStatement, 1, (lastThreadId! as NSString).utf8String, -1, SQLITE_TRANSIENT)
                sqlite3_bind_text(cursorStatement, 2, (lastMessageId! as NSString).utf8String, -1, SQLITE_TRANSIENT)
                sqlite3_bind_int(cursorStatement, 3, Int32(pageSize))
                stmt = cursorStatement
            }

            var rows: [SourceMessageRow] = []
            var readCount = 0
            var step = sqlite3_step(stmt)
            while step == SQLITE_ROW {
                readCount += 1
                guard let cThreadId = sqlite3_column_text(stmt, 0),
                      let cId = sqlite3_column_text(stmt, 1),
                      let cRole = sqlite3_column_text(stmt, 3),
                      let cKind = sqlite3_column_text(stmt, 4) else {
                    // Advance the cursor even for a row that cannot be read,
                    // otherwise the same row would be offered forever.
                    step = sqlite3_step(stmt)
                    continue
                }
                let threadId = String(cString: cThreadId)
                let id = String(cString: cId)
                lastThreadId = threadId
                lastMessageId = id

                if let allowed = allowedThreadIds, !allowed.contains(threadId) {
                    step = sqlite3_step(stmt)
                    continue
                }

                let rawAt = sqlite3_column_double(stmt, 2)
                let createdAt = rawAt > 10_000_000_000 ? rawAt / 1_000.0 : rawAt
                let role = String(cString: cRole)
                let kind = String(cString: cKind)
                let textCol = sqlite3_column_type(stmt, 5) != SQLITE_NULL ? String(cString: sqlite3_column_text(stmt, 5)) : nil
                let jsonCol = sqlite3_column_type(stmt, 6) != SQLITE_NULL ? String(cString: sqlite3_column_text(stmt, 6)) : "{}"

                // A NULL text column means the JSON IS the message, so nothing
                // is lost.  Otherwise the JSON-only keys are metadata the
                // native row has no column for.
                let facts = textCol == nil
                    ? StoreImporter.MessageJSONFacts(model: StoreImporter.analyzeMessageJSON(jsonCol).model, unmappedKeys: [], unmappedFragment: "")
                    : StoreImporter.analyzeMessageJSON(jsonCol)

                // `active_leaf_id` is a per-thread value: it belongs on the one
                // message that IS the thread's active leaf, not on every row.
                let activeLeafId = activeLeafByThread[threadId] == id ? activeLeafByThread[threadId] : nil

                rows.append(SourceMessageRow(
                    threadId: threadId,
                    id: id,
                    createdAt: createdAt,
                    role: role,
                    kind: kind,
                    content: textCol ?? jsonCol,
                    model: facts.model,
                    activeLeafId: activeLeafId,
                    unmappedMetadataKeys: facts.unmappedKeys,
                    unmappedMetadataFragment: facts.unmappedFragment
                ))

                step = sqlite3_step(stmt)
            }
            // A page that filled its limit may be followed by more source rows,
            // so the source is only exhausted when the page came back short.
            if step == SQLITE_DONE && readCount < pageSize {
                isExhausted = true
            }
            return rows
        }
    }

    private func openSourceMessagesDatabase(
        at dbURL: URL,
        knownThreadsFromJSON: [String: ThreadRecord],
        filterBotId: String?
    ) throws -> SourceMessagesReader {
        // Determine allowed thread IDs when filtering by bot.
        let allowedBotThreads: Set<String>? = filterBotId.map { targetBot in
            Set(knownThreadsFromJSON.values.filter { $0.botId == targetBot }.map(\.id))
        }

        var threadsById: [String: ThreadRecord] = [:]
        for (threadId, thread) in knownThreadsFromJSON {
            if let allowed = allowedBotThreads, !allowed.contains(threadId) {
                continue
            }
            threadsById[threadId] = thread
        }
        let knownThreads = threadsById.values.sorted { $0.id < $1.id }

        guard FileManager.default.fileExists(atPath: dbURL.path) else {
            return try SourceMessagesReader(
                db: nil,
                knownThreads: knownThreads,
                activeLeafByThread: [:],
                allowedThreadIds: allowedBotThreads
            )
        }

        var db: OpaquePointer?
        let flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX
        if sqlite3_open_v2(dbURL.path, &db, flags, nil) != SQLITE_OK {
            let msg = db.map { String(cString: sqlite3_errmsg($0)) } ?? "Unknown error"
            sqlite3_close(db)
            throw StoreImportError.sourceDatabaseOpenFailed(msg)
        }
        guard let db else {
            throw StoreImportError.sourceDatabaseOpenFailed("Unknown error")
        }

        do {
            // Validate table columns against known schema.
            try validateTableColumns(db: db, table: "messages", allowed: Self.knownMessagesColumns)
            if try tableExists(db: db, table: "thread_state") {
                try validateTableColumns(db: db, table: "thread_state", allowed: Self.knownThreadStateColumns)
            }
            if try tableExists(db: db, table: "running_helpers") {
                try validateTableColumns(db: db, table: "running_helpers", allowed: Self.knownRunningHelpersColumns)
            }

            // Load thread_state active_leaf_id mapping if present.
            var activeLeafByThread: [String: String] = [:]
            if try tableExists(db: db, table: "thread_state") {
                var leafStmt: OpaquePointer?
                let leafSQL = "SELECT thread_id, active_leaf_id FROM thread_state;"
                guard sqlite3_prepare_v2(db, leafSQL, -1, &leafStmt, nil) == SQLITE_OK else {
                    throw StoreImportError.sourceQueryFailed(String(cString: sqlite3_errmsg(db)))
                }
                defer { sqlite3_finalize(leafStmt) }
                while sqlite3_step(leafStmt) == SQLITE_ROW {
                    guard let cThread = sqlite3_column_text(leafStmt, 0) else { continue }
                    let threadId = String(cString: cThread)
                    if sqlite3_column_type(leafStmt, 1) != SQLITE_NULL, let cLeaf = sqlite3_column_text(leafStmt, 1) {
                        activeLeafByThread[threadId] = String(cString: cLeaf)
                    }
                }
            }

            return try SourceMessagesReader(
                db: db,
                knownThreads: knownThreads,
                activeLeafByThread: activeLeafByThread,
                allowedThreadIds: allowedBotThreads
            )
        } catch {
            sqlite3_close(db)
            throw error
        }
    }

    private func tableExists(db: OpaquePointer?, table: String) throws -> Bool {
        let sql = "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw StoreImportError.sourceQueryFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        sqlite3_bind_text(stmt, 1, (table as NSString).utf8String, -1, transient)
        return sqlite3_step(stmt) == SQLITE_ROW
    }

    private func validateTableColumns(db: OpaquePointer?, table: String, allowed: Set<String>) throws {
        let sql = "PRAGMA table_info(\(table));"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw StoreImportError.sourceQueryFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        var foundColumns: Set<String> = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let cName = sqlite3_column_text(stmt, 1) {
                foundColumns.insert(String(cString: cName))
            }
        }
        let unknown = foundColumns.subtracting(allowed).sorted()
        if !unknown.isEmpty {
            throw StoreImportError.unknownSourceColumns(source: "messages.db.\(table)", columns: unknown)
        }
    }

    // MARK: - Parity Verification

    private func buildParityReport(
        botsSnapshot: BotsSnapshot,
        routinesSnapshot: RoutinesSnapshot,
        webhooksSnapshot: WebhooksSnapshot,
        sourceThreadCount: Int,
        sourceMessageCount: Int,
        perThreadCounts: [String: Int],
        sourceBodyDigestSHA256: String,
        metadataDroppedCount: Int,
        metadataDroppedFields: [String],
        metadataDigestSHA256: String,
        targetDatabase: DatabaseService,
        newlyInsertedMessages: Int
    ) async throws -> StoreImportParityReport {
        let targetBotCount = try await targetDatabase.countRows(inTable: "bots")
        let targetThreadCount = try await targetDatabase.countRows(inTable: "threads")
        let targetMessageCount = try await targetDatabase.countRows(inTable: "messages")
        let targetRoutineCount = try await targetDatabase.countRows(inTable: "routines")
        let targetRoutineRunCount = try await targetDatabase.countRows(inTable: "routine_runs")
        let targetRoutineRequestReceiptCount = try await targetDatabase.countRoutineRequestReceipts()
        let targetWebhookCount = try await targetDatabase.countRows(inTable: "webhooks")
        let targetWebhookDeliveryCount = try await targetDatabase.countRows(inTable: "webhook_deliveries")
        let orphanedMessageCount = try await targetDatabase.countOrphanedMessages()
        let targetThreadMessageCounts = try await targetDatabase.messageCountsByThread()

        // The ledger rows are the ones whose id is the legacy delivery key, so
        // they are counted by looking for those keys in the target.
        var targetLedgerCount = 0
        let ledgerKeys = Set(webhooksSnapshot.deliveryLedger.map(\.id))
        if !ledgerKeys.isEmpty {
            for webhook in webhooksSnapshot.webhooks {
                let stored = try await targetDatabase.loadWebhookDeliveries(forWebhook: webhook.id, limit: 100_000)
                targetLedgerCount += stored.filter { ledgerKeys.contains($0.id) }.count
            }
        }

        var targetHasher = SHA256()
        try await targetDatabase.streamMessageDigestElements { threadId, id, content in
            Self.feedDigest(hasher: &targetHasher, threadId: threadId, id: id, content: content)
        }
        let targetDigest = targetHasher.finalize().map { String(format: "%02x", $0) }.joined()

        let perThreadMatch = (perThreadCounts == targetThreadMessageCounts)
        var mismatches: [String] = []
        var warnings: [String] = []

        if botsSnapshot.bots.count != targetBotCount {
            mismatches.append("bot count \(botsSnapshot.bots.count) != \(targetBotCount)")
        }
        if sourceThreadCount != targetThreadCount {
            mismatches.append("thread count \(sourceThreadCount) != \(targetThreadCount)")
        }
        if sourceMessageCount != targetMessageCount {
            mismatches.append("message count \(sourceMessageCount) != \(targetMessageCount)")
        }
        if routinesSnapshot.routines.count != targetRoutineCount {
            mismatches.append("routine count \(routinesSnapshot.routines.count) != \(targetRoutineCount)")
        }
        if routinesSnapshot.runs.count != targetRoutineRunCount {
            mismatches.append("routine_run count \(routinesSnapshot.runs.count) != \(targetRoutineRunCount)")
        }
        if webhooksSnapshot.webhooks.count != targetWebhookCount {
            mismatches.append("webhook count \(webhooksSnapshot.webhooks.count) != \(targetWebhookCount)")
        }
        let sourceDeliveryCount = webhooksSnapshot.deliveryLedger.count + webhooksSnapshot.attempts.count
        if sourceDeliveryCount != targetWebhookDeliveryCount {
            mismatches.append("webhook_delivery count \(sourceDeliveryCount) != \(targetWebhookDeliveryCount)")
        }
        if webhooksSnapshot.deliveryLedger.count != targetLedgerCount {
            mismatches.append("webhook delivery ledger count \(webhooksSnapshot.deliveryLedger.count) != \(targetLedgerCount)")
        }
        if !perThreadMatch {
            mismatches.append("per-thread message counts differ")
        }
        if orphanedMessageCount != 0 {
            mismatches.append("found \(orphanedMessageCount) orphaned messages")
        }
        if sourceBodyDigestSHA256 != targetDigest {
            mismatches.append("SHA-256 body digest mismatch (\(sourceBodyDigestSHA256) != \(targetDigest))")
        }

        // Known schema limitations: state the native store cannot hold yet.
        // They are named, counted, and fingerprinted so the loss is verified
        // rather than silent.
        if metadataDroppedCount > 0 {
            warnings.append(
                "\(metadataDroppedCount) source message(s) carry JSON metadata the native messages table has no column for (fields: \(metadataDroppedFields.joined(separator: ", "))).  Fingerprint: \(metadataDigestSHA256)."
            )
        }
        if webhooksSnapshot.unmappedDeliveryCount > 0 {
            warnings.append(
                "\(webhooksSnapshot.unmappedDeliveryCount) webhook delivery receipt(s) name an endpoint that no longer resolves to a webhook, so they could not be migrated."
            )
        }
        if routinesSnapshot.botSnoozeCount > 0 {
            warnings.append(
                "\(routinesSnapshot.botSnoozeCount) manual bot snooze(s) have no native column yet, so they were not migrated."
            )
        }

        return StoreImportParityReport(
            sourceBotCount: botsSnapshot.bots.count,
            targetBotCount: targetBotCount,
            sourceThreadCount: sourceThreadCount,
            targetThreadCount: targetThreadCount,
            sourceMessageCount: sourceMessageCount,
            targetMessageCount: targetMessageCount,
            sourceRoutineCount: routinesSnapshot.routines.count,
            targetRoutineCount: targetRoutineCount,
            sourceRoutineRunCount: routinesSnapshot.runs.count,
            targetRoutineRunCount: targetRoutineRunCount,
            sourceWebhookCount: webhooksSnapshot.webhooks.count,
            targetWebhookCount: targetWebhookCount,
            sourceWebhookDeliveryCount: sourceDeliveryCount,
            targetWebhookDeliveryCount: targetWebhookDeliveryCount,
            sourceWebhookDeliveryLedgerCount: webhooksSnapshot.deliveryLedger.count,
            targetWebhookDeliveryLedgerCount: targetLedgerCount,
            sourceRoutineRequestReceiptCount: routinesSnapshot.requestReceipts.count,
            targetRoutineRequestReceiptCount: targetRoutineRequestReceiptCount,
            sourceMessageMetadataDroppedCount: metadataDroppedCount,
            sourceMessageMetadataDroppedFields: metadataDroppedFields,
            sourceMessageMetadataDigestSHA256: metadataDigestSHA256,
            routineRequestReceipts: routinesSnapshot.requestReceipts,
            perThreadMessageCountsMatch: perThreadMatch,
            orphanedMessageCount: orphanedMessageCount,
            sourceBodyDigestSHA256: sourceBodyDigestSHA256,
            targetBodyDigestSHA256: targetDigest,
            newlyInsertedMessages: newlyInsertedMessages,
            mismatches: mismatches,
            warnings: warnings
        )
    }

    // MARK: - Helpers

    private static func normalizeSeconds(_ value: Any?, fallback: Double = 0) -> Double {
        if let num = value as? NSNumber {
            let d = num.doubleValue
            return d > 10_000_000_000 ? d / 1_000.0 : d
        }
        if let str = value as? String, let d = Double(str) {
            return d > 10_000_000_000 ? d / 1_000.0 : d
        }
        return fallback
    }

    /// What a legacy message JSON carries: the model the native row keeps, and
    /// the keys the native row cannot keep.
    private struct MessageJSONFacts {
        let model: String?
        let unmappedKeys: [String]
        let unmappedFragment: String
    }

    private static func analyzeMessageJSON(_ jsonString: String) -> MessageJSONFacts {
        guard let data = jsonString.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return MessageJSONFacts(model: nil, unmappedKeys: [], unmappedFragment: "")
        }

        var model: String?
        if let direct = obj["model"] as? String, !direct.isEmpty {
            model = direct
        } else if let selection = obj["modelSelection"] as? [String: Any],
                  let selected = selection["model"] as? String, !selected.isEmpty {
            model = selected
        }

        let unmapped = obj.keys.filter { !Self.nativelyCarriedMessageKeys.contains($0) }.sorted()
        guard !unmapped.isEmpty else {
            return MessageJSONFacts(model: model, unmappedKeys: [], unmappedFragment: "")
        }
        var subset: [String: Any] = [:]
        for key in unmapped {
            subset[key] = obj[key] ?? NSNull()
        }
        let fragment = (try? JSONSerialization.data(withJSONObject: subset, options: [.sortedKeys]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? ""
        return MessageJSONFacts(model: model, unmappedKeys: unmapped, unmappedFragment: fragment)
    }

    private static func feedDigest(hasher: inout SHA256, threadId: String, id: String, content: String) {
        let record = "\(threadId)\u{001F}\(id)\u{001F}\(content)\u{001E}"
        if let data = record.data(using: .utf8) {
            hasher.update(data: data)
        }
    }
}
