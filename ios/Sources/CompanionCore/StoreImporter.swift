import CryptoKit
import Foundation
import SQLite3

public enum StoreImportError: LocalizedError, Equatable {
    case sourceDirectoryMissing(String)
    case sourceDatabaseOpenFailed(String)
    case sourceQueryFailed(String)
    case invalidJSONFormat(file: String, reason: String)
    case unknownSourceColumns(source: String, columns: [String])
    case interruptedAfterBatch(completedBatches: Int)
    case parityMismatch(reasons: [String])

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
        }
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
    public let perThreadMessageCountsMatch: Bool
    public let orphanedMessageCount: Int
    public let sourceBodyDigestSHA256: String
    public let targetBodyDigestSHA256: String
    public let newlyInsertedMessages: Int
    public let mismatches: [String]

    public var isParityVerified: Bool {
        mismatches.isEmpty &&
        sourceBotCount == targetBotCount &&
        sourceThreadCount == targetThreadCount &&
        sourceMessageCount == targetMessageCount &&
        sourceRoutineCount == targetRoutineCount &&
        sourceRoutineRunCount == targetRoutineRunCount &&
        sourceWebhookCount == targetWebhookCount &&
        sourceWebhookDeliveryCount == targetWebhookDeliveryCount &&
        perThreadMessageCountsMatch &&
        orphanedMessageCount == 0 &&
        sourceBodyDigestSHA256 == targetBodyDigestSHA256
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

    public static let knownBotKeys: Set<String> = [
        "activeModelSelection", "activity", "activityStartedAt", "alwaysAllow",
        "approvePeerComms", "autoApprove", "autoReview", "autoStartVps",
        "avatarCrop", "avatarUrl", "busy", "bypassLocalComputer",
        "bypassPermissions", "chiefOfStaff", "cloudBackend", "color",
        "composio", "computer", "computers", "connectorGrants", "createdAt",
        "cwd", "description", "extraCwds", "hidden", "id", "inflightThreadId",
        "mascotExpression", "maxOutputTokens", "maxToolRounds", "modelSelection",
        "name", "nativeEngine", "notifications", "off", "peerApprovals",
        "pinned", "pinnedCwd", "pronunciations", "resumeCursors", "rewound",
        "roomUsageByInstance", "section", "snoozedUntil", "speakReplies",
        "speechDevices", "systemPrompt", "tasks", "threadId", "title",
        "toolPolicy", "unread", "updatedAt", "userNotes", "voice",
        "voiceSummaryMode"
    ]

    public static let knownGroupKeys: Set<String> = [
        "avatarCrop", "avatarUrl", "bulletin", "createdAt", "cwd",
        "defaultResponder", "dm", "extraCwds", "id", "memberIds",
        "name", "pinned", "pinnedCwd", "section", "setupCompletedAt",
        "setupSkippedAt", "tasks", "threadId", "unread", "updatedAt"
    ]

    public static let knownRoutinesRootKeys: Set<String> = [
        "botSnoozes", "routineRequestReceipts", "routines", "runs", "version"
    ]

    public static let knownRoutineKeys: Set<String> = [
        "botId", "createdAt", "description", "durationMinutes", "enabled",
        "id", "lastRunAt", "lastRunId", "name", "nextRunAt", "prompt",
        "runOn", "schedule", "threadId", "timezone", "updatedAt"
    ]

    public static let knownRoutineRunKeys: Set<String> = [
        "botId", "coalescedInto", "completedAt", "cost", "createdAt",
        "deliveryId", "driver", "durationMinutes", "engineId", "error",
        "failurePhase", "finishedAt", "id", "manual", "model",
        "outcomeCode", "output", "ownerThreadId", "prompt", "routineId",
        "routineName", "runOn", "scheduledFor", "seenAt", "sentryCheckInId",
        "setupFailed", "startedAt", "status", "threadId", "triggerSource",
        "webhookId"
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
        let botsSnapshot = try loadAndValidateBots(from: sourceDirectory, filterBotId: filterBotId)
        let groupsSnapshot = try loadAndValidateGroups(from: sourceDirectory)
        let routinesSnapshot = try loadAndValidateRoutines(from: sourceDirectory, filterBotId: filterBotId)
        let webhooksSnapshot = try loadAndValidateWebhooks(from: sourceDirectory, filterBotId: filterBotId)

        // 2. Open messages.db strictly read-only and read thread/message rows.
        let messagesDBURL = sourceDirectory.appendingPathComponent("messages.db")
        let sqlSnapshot = try readSourceMessagesDatabase(
            at: messagesDBURL,
            knownThreadsFromJSON: botsSnapshot.threadsById.merging(groupsSnapshot.threadsById) { first, _ in first },
            filterBotId: filterBotId
        )

        // 3. Upsert bots, routines, webhooks, and threads into target DatabaseService.
        for bot in botsSnapshot.bots {
            try await targetDatabase.upsertBot(bot)
        }
        for routine in routinesSnapshot.routines {
            try await targetDatabase.upsertRoutine(routine)
        }
        for run in routinesSnapshot.runs {
            try await targetDatabase.recordRoutineRun(run)
        }
        for webhook in webhooksSnapshot.webhooks {
            try await targetDatabase.upsertWebhook(webhook)
        }
        for delivery in webhooksSnapshot.deliveries {
            try await targetDatabase.recordWebhookDelivery(delivery)
        }
        for thread in sqlSnapshot.threads {
            try await targetDatabase.upsertThread(thread)
        }

        // 4. Import messages in resumable transactional batches.
        var newlyInserted = 0
        var completedBatches = 0
        var index = 0
        while index < sqlSnapshot.messages.count {
            if let limit = maxBatchesBeforeInterrupt, completedBatches >= limit {
                throw StoreImportError.interruptedAfterBatch(completedBatches: completedBatches)
            }
            let end = min(index + batchSize, sqlSnapshot.messages.count)
            let slice = Array(sqlSnapshot.messages[index..<end])
            let changed = try await targetDatabase.insertMessagesBatch(slice, skipIdentical: true)
            newlyInserted += changed
            completedBatches += 1
            index = end
        }

        // 5. Compute parity report comparing source snapshot against target DatabaseService.
        return try await buildParityReport(
            botsSnapshot: botsSnapshot,
            routinesSnapshot: routinesSnapshot,
            webhooksSnapshot: webhooksSnapshot,
            sqlSnapshot: sqlSnapshot,
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
    }

    private struct WebhooksSnapshot {
        let webhooks: [StoredWebhookRecord]
        let deliveries: [WebhookDeliveryRecord]
    }

    private struct SQLMessagesSnapshot {
        let threads: [ThreadRecord]
        let messages: [MessageRecord]
        let perThreadCounts: [String: Int]
        let bodyDigestSHA256: String
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
                        threadsById[taskThreadId] = ThreadRecord(
                            id: taskThreadId,
                            title: taskTitle,
                            botId: nil,
                            createdAt: taskCreated,
                            updatedAt: taskCreated
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
            return RoutinesSnapshot(routines: [], runs: [])
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

        return RoutinesSnapshot(routines: routines, runs: runs)
    }

    private func loadAndValidateWebhooks(from dir: URL, filterBotId: String?) throws -> WebhooksSnapshot {
        let url = dir.appendingPathComponent("webhooks.json")
        guard FileManager.default.fileExists(atPath: url.path) else {
            return WebhooksSnapshot(webhooks: [], deliveries: [])
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
            if let filter = filterBotId, botId != filter {
                continue
            }
            let endpointId = (item["endpointId"] as? String) ?? id
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

        let rawAttempts = (root["attempts"] as? [[String: Any]]) ?? []
        var deliveries: [WebhookDeliveryRecord] = []
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

            deliveries.append(WebhookDeliveryRecord(
                id: id,
                webhookId: webhookId,
                botId: botId,
                statusCode: statusCode,
                deliveredAt: deliveredAt,
                payload: payload,
                response: response
            ))
        }

        return WebhooksSnapshot(webhooks: webhooks, deliveries: deliveries)
    }

    // MARK: - Read-Only SQLite Source Reader

    private func readSourceMessagesDatabase(
        at dbURL: URL,
        knownThreadsFromJSON: [String: ThreadRecord],
        filterBotId: String?
    ) throws -> SQLMessagesSnapshot {
        guard FileManager.default.fileExists(atPath: dbURL.path) else {
            let filteredThreads = knownThreadsFromJSON.values
                .filter { filterBotId == nil || $0.botId == filterBotId }
                .sorted { $0.id < $1.id }
            let emptyDigest = SHA256.hash(data: Data()).map { String(format: "%02x", $0) }.joined()
            return SQLMessagesSnapshot(threads: filteredThreads, messages: [], perThreadCounts: [:], bodyDigestSHA256: emptyDigest)
        }

        var db: OpaquePointer?
        let flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX
        if sqlite3_open_v2(dbURL.path, &db, flags, nil) != SQLITE_OK {
            let msg = db.map { String(cString: sqlite3_errmsg($0)) } ?? "Unknown error"
            sqlite3_close(db)
            throw StoreImportError.sourceDatabaseOpenFailed(msg)
        }
        defer { sqlite3_close(db) }

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

        var messages: [MessageRecord] = []
        var perThreadCounts: [String: Int] = [:]
        var hasher = SHA256()

        let msgSQL = "SELECT thread_id, id, at, role, kind, text, json FROM messages ORDER BY thread_id ASC, id ASC;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, msgSQL, -1, &stmt, nil) == SQLITE_OK else {
            throw StoreImportError.sourceQueryFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let cThreadId = sqlite3_column_text(stmt, 0),
                  let cId = sqlite3_column_text(stmt, 1),
                  let cRole = sqlite3_column_text(stmt, 3),
                  let cKind = sqlite3_column_text(stmt, 4) else {
                continue
            }
            let threadId = String(cString: cThreadId)
            if let allowed = allowedBotThreads, !allowed.contains(threadId) {
                continue
            }
            let id = String(cString: cId)
            let rawAt = sqlite3_column_double(stmt, 2)
            let createdAt = rawAt > 10_000_000_000 ? rawAt / 1_000.0 : rawAt
            let role = String(cString: cRole)
            let kind = String(cString: cKind)
            let textCol = sqlite3_column_type(stmt, 5) != SQLITE_NULL ? String(cString: sqlite3_column_text(stmt, 5)) : nil
            let jsonCol = sqlite3_column_type(stmt, 6) != SQLITE_NULL ? String(cString: sqlite3_column_text(stmt, 6)) : "{}"

            let content = textCol ?? jsonCol
            let model = Self.extractModel(fromJSON: jsonCol)
            let activeLeafId = activeLeafByThread[threadId]

            messages.append(MessageRecord(
                id: id,
                threadId: threadId,
                role: role,
                kind: kind,
                content: content,
                createdAt: createdAt,
                model: model,
                activeLeafId: activeLeafId
            ))

            perThreadCounts[threadId, default: 0] += 1
            Self.feedDigest(hasher: &hasher, threadId: threadId, id: id, content: content)

            // Ensure every message's thread_id has a parent row in `threads` so
            // foreign key constraints are satisfied and zero messages are orphaned.
            if let existing = threadsById[threadId] {
                if createdAt > existing.updatedAt || createdAt < existing.createdAt {
                    threadsById[threadId] = ThreadRecord(
                        id: existing.id,
                        title: existing.title,
                        botId: existing.botId,
                        createdAt: min(existing.createdAt, createdAt),
                        updatedAt: max(existing.updatedAt, createdAt)
                    )
                }
            } else {
                let inferredBotId: String? = threadId.hasPrefix("routine:") || threadId.hasPrefix("webhook:") ? nil : filterBotId
                threadsById[threadId] = ThreadRecord(
                    id: threadId,
                    title: threadId,
                    botId: inferredBotId,
                    createdAt: createdAt,
                    updatedAt: createdAt
                )
            }
        }

        let sortedThreads = threadsById.values.sorted { $0.id < $1.id }
        let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        return SQLMessagesSnapshot(
            threads: sortedThreads,
            messages: messages,
            perThreadCounts: perThreadCounts,
            bodyDigestSHA256: digest
        )
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
        sqlSnapshot: SQLMessagesSnapshot,
        targetDatabase: DatabaseService,
        newlyInsertedMessages: Int
    ) async throws -> StoreImportParityReport {
        let targetBotCount = try await targetDatabase.countRows(inTable: "bots")
        let targetThreadCount = try await targetDatabase.countRows(inTable: "threads")
        let targetMessageCount = try await targetDatabase.countRows(inTable: "messages")
        let targetRoutineCount = try await targetDatabase.countRows(inTable: "routines")
        let targetRoutineRunCount = try await targetDatabase.countRows(inTable: "routine_runs")
        let targetWebhookCount = try await targetDatabase.countRows(inTable: "webhooks")
        let targetWebhookDeliveryCount = try await targetDatabase.countRows(inTable: "webhook_deliveries")
        let orphanedMessageCount = try await targetDatabase.countOrphanedMessages()
        let targetThreadMessageCounts = try await targetDatabase.messageCountsByThread()

        var targetHasher = SHA256()
        try await targetDatabase.streamMessageDigestElements { threadId, id, content in
            Self.feedDigest(hasher: &targetHasher, threadId: threadId, id: id, content: content)
        }
        let targetDigest = targetHasher.finalize().map { String(format: "%02x", $0) }.joined()

        let perThreadMatch = (sqlSnapshot.perThreadCounts == targetThreadMessageCounts)
        var mismatches: [String] = []

        if botsSnapshot.bots.count != targetBotCount {
            mismatches.append("bot count \(botsSnapshot.bots.count) != \(targetBotCount)")
        }
        if sqlSnapshot.threads.count != targetThreadCount {
            mismatches.append("thread count \(sqlSnapshot.threads.count) != \(targetThreadCount)")
        }
        if sqlSnapshot.messages.count != targetMessageCount {
            mismatches.append("message count \(sqlSnapshot.messages.count) != \(targetMessageCount)")
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
        if webhooksSnapshot.deliveries.count != targetWebhookDeliveryCount {
            mismatches.append("webhook_delivery count \(webhooksSnapshot.deliveries.count) != \(targetWebhookDeliveryCount)")
        }
        if !perThreadMatch {
            mismatches.append("per-thread message counts differ")
        }
        if orphanedMessageCount != 0 {
            mismatches.append("found \(orphanedMessageCount) orphaned messages")
        }
        if sqlSnapshot.bodyDigestSHA256 != targetDigest {
            mismatches.append("SHA-256 body digest mismatch (\(sqlSnapshot.bodyDigestSHA256) != \(targetDigest))")
        }

        return StoreImportParityReport(
            sourceBotCount: botsSnapshot.bots.count,
            targetBotCount: targetBotCount,
            sourceThreadCount: sqlSnapshot.threads.count,
            targetThreadCount: targetThreadCount,
            sourceMessageCount: sqlSnapshot.messages.count,
            targetMessageCount: targetMessageCount,
            sourceRoutineCount: routinesSnapshot.routines.count,
            targetRoutineCount: targetRoutineCount,
            sourceRoutineRunCount: routinesSnapshot.runs.count,
            targetRoutineRunCount: targetRoutineRunCount,
            sourceWebhookCount: webhooksSnapshot.webhooks.count,
            targetWebhookCount: targetWebhookCount,
            sourceWebhookDeliveryCount: webhooksSnapshot.deliveries.count,
            targetWebhookDeliveryCount: targetWebhookDeliveryCount,
            perThreadMessageCountsMatch: perThreadMatch,
            orphanedMessageCount: orphanedMessageCount,
            sourceBodyDigestSHA256: sqlSnapshot.bodyDigestSHA256,
            targetBodyDigestSHA256: targetDigest,
            newlyInsertedMessages: newlyInsertedMessages,
            mismatches: mismatches
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

    private static func extractModel(fromJSON jsonString: String) -> String? {
        guard let data = jsonString.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        if let model = obj["model"] as? String, !model.isEmpty {
            return model
        }
        return nil
    }

    private static func feedDigest(hasher: inout SHA256, threadId: String, id: String, content: String) {
        let record = "\(threadId)\u{001F}\(id)\u{001F}\(content)\u{001E}"
        if let data = record.data(using: .utf8) {
            hasher.update(data: data)
        }
    }
}
