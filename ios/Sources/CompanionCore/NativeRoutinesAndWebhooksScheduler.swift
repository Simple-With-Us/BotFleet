import CryptoKit
import Foundation

// MARK: - Routine Scheduling Models

/// Configuration for a scheduled bot routine backed by `DatabaseService` (`routine_runs`).
public struct ScheduledRoutine: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let botId: String
    public var title: String
    public var intervalSeconds: TimeInterval
    public var resumable: Bool
    public var enabled: Bool

    public init(
        id: String,
        botId: String,
        title: String,
        intervalSeconds: TimeInterval = 3600,
        resumable: Bool = false,
        enabled: Bool = true
    ) {
        self.id = id
        self.botId = botId
        self.title = title
        self.intervalSeconds = intervalSeconds
        self.resumable = resumable
        self.enabled = enabled
    }
}

/// Time-based retention policy for `routine_runs` (addresses BF-2478).
/// Retains terminal runs by age (default 7 days) up to a high safety ceiling rather than a blind 2,000-count cap.
public struct RoutineRetentionPolicy: Sendable, Equatable {
    public let maxAgeSeconds: TimeInterval
    public let safetyCeiling: Int

    public init(
        maxAgeSeconds: TimeInterval = 7 * 24 * 3600,
        safetyCeiling: Int = 50_000
    ) {
        self.maxAgeSeconds = max(60, maxAgeSeconds)
        self.safetyCeiling = max(1, safetyCeiling)
    }
}

/// Summary returned after applying time-based retention to `routine_runs`.
public struct RoutineRetentionReport: Sendable, Equatable {
    public let retainedRuns: [RoutineRunRecord]
    public let evictedRuns: [RoutineRunRecord]

    public init(retainedRuns: [RoutineRunRecord], evictedRuns: [RoutineRunRecord]) {
        self.retainedRuns = retainedRuns
        self.evictedRuns = evictedRuns
    }
}

/// Errors thrown by `NativeRoutinesSchedulerActor`.
public enum RoutineSchedulerError: LocalizedError, Sendable, Equatable {
    case routineNotFound(String)
    case routineDisabled(String)
    case duplicateRunExecutionRefused(String)
    case executionFailed(String)

    public var errorDescription: String? {
        switch self {
        case .routineNotFound(let id):
            return "Routine '\(id)' is not registered."
        case .routineDisabled(let id):
            return "Routine '\(id)' is currently disabled."
        case .duplicateRunExecutionRefused(let runId):
            return "Refused duplicate execution of routine run '\(runId)'."
        case .executionFailed(let reason):
            return "Routine execution failed: \(reason)"
        }
    }
}

// MARK: - NativeRoutinesSchedulerActor

/// Actor that schedules and executes bot routines backed directly by `DatabaseService` (`routine_runs`),
/// eliminating synchronous 5.3 MB `fsyncSync` JSON rewrites on every state transition.
/// Provides deterministic crash recovery (`recoverInterruptedRuns`) and time-based retention (`BF-2478`).
public actor NativeRoutinesSchedulerActor {
    public static let restartInterruptionReason = "Interrupted by application restart"

    private let database: DatabaseService
    public var retentionPolicy: RoutineRetentionPolicy

    private var routinesById: [String: ScheduledRoutine] = [:]
    private var defaultExecutor: (@Sendable (ScheduledRoutine, RoutineRunRecord) async throws -> Void)?
    /// Tracks run IDs that have already executed or been settled by crash recovery so no run ever executes twice.
    private var executedRunIds: Set<String> = []

    public init(
        database: DatabaseService,
        retentionPolicy: RoutineRetentionPolicy = RoutineRetentionPolicy(),
        defaultExecutor: (@Sendable (ScheduledRoutine, RoutineRunRecord) async throws -> Void)? = nil
    ) {
        self.database = database
        self.retentionPolicy = retentionPolicy
        self.defaultExecutor = defaultExecutor
    }

    public func registerRoutine(_ routine: ScheduledRoutine) {
        routinesById[routine.id] = routine
    }

    public func registeredRoutine(id: String) -> ScheduledRoutine? {
        routinesById[id]
    }

    /// Fires a routine immediately, recording the `"running"` -> `"success"`/`"failed"` transitions in `DatabaseService`.
    /// Enforces an idempotency guard on `runId` so the same run can never execute twice.
    @discardableResult
    public func fireRoutine(
        id routineId: String,
        runId: String? = nil,
        now: Double = Date().timeIntervalSince1970,
        executor: (@Sendable (ScheduledRoutine, RoutineRunRecord) async throws -> Void)? = nil
    ) async throws -> RoutineRunRecord {
        guard let routine = routinesById[routineId] else {
            throw RoutineSchedulerError.routineNotFound(routineId)
        }
        guard routine.enabled else {
            throw RoutineSchedulerError.routineDisabled(routineId)
        }

        let resolvedRunId = runId ?? "run_\(UUID().uuidString.lowercased())"
        guard !executedRunIds.contains(resolvedRunId) else {
            throw RoutineSchedulerError.duplicateRunExecutionRefused(resolvedRunId)
        }
        executedRunIds.insert(resolvedRunId)

        let runningRecord = RoutineRunRecord(
            id: resolvedRunId,
            routineId: routine.id,
            botId: routine.botId,
            status: "running",
            startedAt: now,
            completedAt: nil,
            error: nil
        )
        try await database.recordRoutineRun(runningRecord)

        let runner = executor ?? defaultExecutor
        do {
            try await runner?(routine, runningRecord)
            let finishedRecord = RoutineRunRecord(
                id: resolvedRunId,
                routineId: routine.id,
                botId: routine.botId,
                status: "success",
                startedAt: now,
                completedAt: max(now, Date().timeIntervalSince1970),
                error: nil
            )
            try await database.recordRoutineRun(finishedRecord)
            return finishedRecord
        } catch {
            let failedRecord = RoutineRunRecord(
                id: resolvedRunId,
                routineId: routine.id,
                botId: routine.botId,
                status: "failed",
                startedAt: now,
                completedAt: max(now, Date().timeIntervalSince1970),
                error: error.localizedDescription
            )
            try await database.recordRoutineRun(failedRecord)
            return failedRecord
        }
    }

    /// Crash recovery on launch: scans `routine_runs` for any run left in `"running"` state when the app exited mid-routine.
    /// - Non-resumable routines have their interrupted runs marked `"failed"` with `error = "Interrupted by application restart"`.
    /// - Resumable routines (`resumable == true`) have their interrupted runs transitioned to `"queued"` (and optionally resumed
    ///   exactly once if `resumeImmediately` is provided), never silently lost and never executed twice.
    @discardableResult
    public func recoverInterruptedRuns(
        routineIds: [String]? = nil,
        now: Double = Date().timeIntervalSince1970,
        resumeExecutor: (@Sendable (ScheduledRoutine, RoutineRunRecord) async throws -> Void)? = nil
    ) async throws -> [RoutineRunRecord] {
        var targetRoutineIds = Set(routinesById.keys)
        for extra in routineIds ?? [] {
            targetRoutineIds.insert(extra)
        }

        var recovered: [RoutineRunRecord] = []
        for routineId in targetRoutineIds.sorted() {
            let runs = try await database.loadRoutineRuns(forRoutine: routineId, limit: 10_000)
            let routine = routinesById[routineId]
            let isResumable = routine?.resumable ?? false

            for run in runs where run.status == "running" {
                if isResumable, let routine {
                    let queuedRun = RoutineRunRecord(
                        id: run.id,
                        routineId: run.routineId,
                        botId: run.botId,
                        status: "queued",
                        startedAt: run.startedAt,
                        completedAt: nil,
                        error: Self.restartInterruptionReason
                    )
                    try await database.recordRoutineRun(queuedRun)

                    if let resumeExecutor {
                        let resumed = try await resumeQueuedRun(queuedRun, routine: routine, now: now, executor: resumeExecutor)
                        recovered.append(resumed)
                    } else {
                        recovered.append(queuedRun)
                    }
                } else {
                    executedRunIds.insert(run.id)
                    let failedRun = RoutineRunRecord(
                        id: run.id,
                        routineId: run.routineId,
                        botId: run.botId,
                        status: "failed",
                        startedAt: run.startedAt,
                        completedAt: now,
                        error: Self.restartInterruptionReason
                    )
                    try await database.recordRoutineRun(failedRun)
                    recovered.append(failedRun)
                }
            }
        }
        return recovered
    }

    /// Resumes a `"queued"` run that was recovered after an application restart, guaranteeing single execution.
    public func resumeQueuedRun(
        _ queuedRun: RoutineRunRecord,
        routine: ScheduledRoutine? = nil,
        now: Double = Date().timeIntervalSince1970,
        executor: (@Sendable (ScheduledRoutine, RoutineRunRecord) async throws -> Void)? = nil
    ) async throws -> RoutineRunRecord {
        guard !executedRunIds.contains(queuedRun.id) else {
            throw RoutineSchedulerError.duplicateRunExecutionRefused(queuedRun.id)
        }
        guard let resolvedRoutine = routine ?? routinesById[queuedRun.routineId] else {
            throw RoutineSchedulerError.routineNotFound(queuedRun.routineId)
        }
        executedRunIds.insert(queuedRun.id)

        let runner = executor ?? defaultExecutor
        do {
            try await runner?(resolvedRoutine, queuedRun)
            let completed = RoutineRunRecord(
                id: queuedRun.id,
                routineId: queuedRun.routineId,
                botId: queuedRun.botId,
                status: "success",
                startedAt: queuedRun.startedAt,
                completedAt: now,
                error: nil
            )
            try await database.recordRoutineRun(completed)
            return completed
        } catch {
            let failed = RoutineRunRecord(
                id: queuedRun.id,
                routineId: queuedRun.routineId,
                botId: queuedRun.botId,
                status: "failed",
                startedAt: queuedRun.startedAt,
                completedAt: now,
                error: error.localizedDescription
            )
            try await database.recordRoutineRun(failed)
            return failed
        }
    }

    /// Applies time-based retention with a configurable safety ceiling (`BF-2478`).
    /// Active runs (`"running"`, `"queued"`) are never evicted.  Terminal runs (`"success"`, `"failed"`, `"cancelled"`)
    /// younger than `retentionPolicy.maxAgeSeconds` and within `retentionPolicy.safetyCeiling` are retained;
    /// older or excess terminal runs are marked `"expired"` in `DatabaseService`.
    @discardableResult
    public func applyRetentionPolicy(
        forRoutine routineId: String? = nil,
        now: Double = Date().timeIntervalSince1970
    ) async throws -> RoutineRetentionReport {
        let targetIds = routineId.map { [$0] } ?? Array(routinesById.keys).sorted()
        let cutoffTimestamp = now - retentionPolicy.maxAgeSeconds

        var retained: [RoutineRunRecord] = []
        var evicted: [RoutineRunRecord] = []

        for id in targetIds {
            let runs = try await database.loadRoutineRuns(
                forRoutine: id,
                limit: max(retentionPolicy.safetyCeiling * 2, 10_000)
            )
            var terminalCountForRoutine = 0
            for run in runs {
                if run.status == "expired" {
                    continue
                }
                if run.status == "running" || run.status == "queued" {
                    retained.append(run)
                    continue
                }

                let referenceTime = run.completedAt ?? run.startedAt
                let withinAgeWindow = referenceTime >= cutoffTimestamp
                let withinSafetyCeiling = terminalCountForRoutine < retentionPolicy.safetyCeiling

                if withinAgeWindow && withinSafetyCeiling {
                    terminalCountForRoutine += 1
                    retained.append(run)
                } else {
                    let expiredRun = RoutineRunRecord(
                        id: run.id,
                        routineId: run.routineId,
                        botId: run.botId,
                        status: "expired",
                        startedAt: run.startedAt,
                        completedAt: run.completedAt,
                        error: run.error
                    )
                    try await database.recordRoutineRun(expiredRun)
                    evicted.append(expiredRun)
                }
            }
        }
        return RoutineRetentionReport(retainedRuns: retained, evictedRuns: evicted)
    }

    /// Loads all non-expired runs for a routine from `DatabaseService`.
    public func loadRetainedRuns(forRoutine routineId: String, limit: Int = 500) async throws -> [RoutineRunRecord] {
        let all = try await database.loadRoutineRuns(forRoutine: routineId, limit: limit)
        return all.filter { $0.status != "expired" }
    }
}

// MARK: - Webhook Ingress Models & NativeWebhookIngressActor

/// Configuration for a registered webhook endpoint.
public struct WebhookEndpointConfig: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let botId: String
    public let secret: String
    public let eventTypes: Set<String>
    public let mergedPullRequestsOnly: Bool
    public let maxRetries: Int
    public let baseBackoffSeconds: TimeInterval

    public init(
        id: String,
        botId: String,
        secret: String,
        eventTypes: Set<String> = [],
        mergedPullRequestsOnly: Bool = false,
        maxRetries: Int = 3,
        baseBackoffSeconds: TimeInterval = 1.0
    ) {
        self.id = id
        self.botId = botId
        self.secret = secret
        self.eventTypes = eventTypes
        self.mergedPullRequestsOnly = mergedPullRequestsOnly
        self.maxRetries = max(0, maxRetries)
        self.baseBackoffSeconds = max(0.01, baseBackoffSeconds)
    }
}

/// Outcome of an incoming webhook delivery processed by `NativeWebhookIngressActor`.
public enum WebhookIngressOutcome: Sendable, Equatable {
    case delivered(deliveryId: String, runId: String, attempts: Int, response: String)
    case filtered(deliveryId: String, reason: String)
    case rejected(deliveryId: String, statusCode: Int, reason: String)
    case failedAfterRetries(deliveryId: String, attempts: Int, lastError: String)
}

/// Actor that verifies HMAC-SHA256 webhook signatures in constant time, applies `eventTypes` and
/// `mergedPullRequestsOnly` pre-filters at ingress before creating a run, records every delivery attempt
/// in `DatabaseService` (`webhook_deliveries`), and retries transient dispatch failures with exponential backoff.
public actor NativeWebhookIngressActor {
    private let database: DatabaseService
    private let sleepHandler: @Sendable (TimeInterval) async -> Void
    private var endpointsById: [String: WebhookEndpointConfig] = [:]

    public private(set) var recordedBackoffDelays: [TimeInterval] = []

    public init(
        database: DatabaseService,
        sleepHandler: @escaping @Sendable (TimeInterval) async -> Void = { seconds in
            try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
        }
    ) {
        self.database = database
        self.sleepHandler = sleepHandler
    }

    public func registerEndpoint(_ config: WebhookEndpointConfig) {
        endpointsById[config.id] = config
    }

    /// Computes the GitHub-compatible `sha256=<hex>` HMAC-SHA256 signature for a payload and secret.
    public static func computeHMACSignature(payload: Data, secret: String) -> String {
        let key = SymmetricKey(data: Data(secret.utf8))
        let mac = HMAC<SHA256>.authenticationCode(for: payload, using: key)
        let hex = mac.map { String(format: "%02x", $0) }.joined()
        return "sha256=\(hex)"
    }

    /// Verifies `X-Hub-Signature-256` against the webhook secret using constant-time byte comparison.
    public static func verifyHMACSignature(payload: Data, secret: String, signatureHeader: String?) -> Bool {
        guard let rawHeader = signatureHeader?.trimmingCharacters(in: .whitespacesAndNewlines),
              !rawHeader.isEmpty,
              !secret.isEmpty else {
            return false
        }
        let expected = computeHMACSignature(payload: payload, secret: secret)
        let normalizedCandidate = rawHeader.lowercased().hasPrefix("sha256=")
            ? rawHeader.lowercased()
            : "sha256=\(rawHeader.lowercased())"
        return NativeCompanionServer.constantTimeEquals(normalizedCandidate, expected)
    }

    /// Processes an incoming webhook delivery, enforcing HMAC verification, ingress pre-filters,
    /// exponential backoff retries on transient dispatch errors, and `webhook_deliveries` persistence.
    public func handleWebhook(
        webhookId: String,
        eventType: String,
        signatureHeader: String?,
        payload: Data,
        deliveryId: String? = nil,
        now: Double = Date().timeIntervalSince1970,
        dispatchHandler: @Sendable (WebhookEndpointConfig, String, Data) async throws -> String
    ) async throws -> WebhookIngressOutcome {
        let baseDeliveryId = deliveryId ?? "wh_\(UUID().uuidString.lowercased())"
        let payloadText = String(data: payload, encoding: .utf8) ?? ""

        guard let endpoint = endpointsById[webhookId] else {
            let record = WebhookDeliveryRecord(
                id: baseDeliveryId,
                webhookId: webhookId,
                botId: nil,
                statusCode: 404,
                deliveredAt: now,
                payload: payloadText,
                response: "{\"error\":\"unknown_webhook\"}"
            )
            try await database.recordWebhookDelivery(record)
            return .rejected(deliveryId: baseDeliveryId, statusCode: 404, reason: "unknown_webhook")
        }

        // 1. Constant-time HMAC-SHA256 signature check
        guard Self.verifyHMACSignature(payload: payload, secret: endpoint.secret, signatureHeader: signatureHeader) else {
            let record = WebhookDeliveryRecord(
                id: baseDeliveryId,
                webhookId: webhookId,
                botId: endpoint.botId,
                statusCode: 401,
                deliveredAt: now,
                payload: payloadText,
                response: "{\"error\":\"invalid_signature\"}"
            )
            try await database.recordWebhookDelivery(record)
            return .rejected(deliveryId: baseDeliveryId, statusCode: 401, reason: "invalid_signature")
        }

        // 2. Event-type pre-filter at ingress (before creating a bot run)
        if !endpoint.eventTypes.isEmpty && !endpoint.eventTypes.contains(eventType) {
            let record = WebhookDeliveryRecord(
                id: baseDeliveryId,
                webhookId: webhookId,
                botId: endpoint.botId,
                statusCode: 202,
                deliveredAt: now,
                payload: payloadText,
                response: "{\"skipped\":\"event_type_filtered\"}"
            )
            try await database.recordWebhookDelivery(record)
            return .filtered(deliveryId: baseDeliveryId, reason: "event_type_filtered")
        }

        // 3. Merged pull request pre-filter at ingress
        if endpoint.mergedPullRequestsOnly && eventType == "pull_request" {
            if !Self.isMergedPullRequestPayload(payload) {
                let record = WebhookDeliveryRecord(
                    id: baseDeliveryId,
                    webhookId: webhookId,
                    botId: endpoint.botId,
                    statusCode: 202,
                    deliveredAt: now,
                    payload: payloadText,
                    response: "{\"skipped\":\"pull_request_not_merged\"}"
                )
                try await database.recordWebhookDelivery(record)
                return .filtered(deliveryId: baseDeliveryId, reason: "pull_request_not_merged")
            }
        }

        // 4. Dispatch with exponential backoff retry on transient failures
        let totalAllowedAttempts = endpoint.maxRetries + 1
        var lastErrorText = "unknown_dispatch_error"

        for attempt in 0..<totalAllowedAttempts {
            let attemptRecordId = attempt == 0 ? baseDeliveryId : "\(baseDeliveryId)_retry\(attempt)"
            do {
                let responseBody = try await dispatchHandler(endpoint, eventType, payload)
                let runId = "run_\(baseDeliveryId)"

                let deliveryRecord = WebhookDeliveryRecord(
                    id: attemptRecordId,
                    webhookId: webhookId,
                    botId: endpoint.botId,
                    statusCode: 200,
                    deliveredAt: now + Double(attempt),
                    payload: payloadText,
                    response: responseBody
                )
                try await database.recordWebhookDelivery(deliveryRecord)

                let runRecord = RoutineRunRecord(
                    id: runId,
                    routineId: "webhook:\(webhookId)",
                    botId: endpoint.botId,
                    status: "success",
                    startedAt: now,
                    completedAt: now + Double(attempt),
                    error: nil
                )
                try await database.recordRoutineRun(runRecord)

                return .delivered(
                    deliveryId: attemptRecordId,
                    runId: runId,
                    attempts: attempt + 1,
                    response: responseBody
                )
            } catch {
                lastErrorText = error.localizedDescription
                let failedAttemptRecord = WebhookDeliveryRecord(
                    id: attemptRecordId,
                    webhookId: webhookId,
                    botId: endpoint.botId,
                    statusCode: 502,
                    deliveredAt: now + Double(attempt),
                    payload: payloadText,
                    response: "{\"error\":\"\(lastErrorText)\",\"attempt\":\(attempt + 1)}"
                )
                try await database.recordWebhookDelivery(failedAttemptRecord)

                if attempt + 1 < totalAllowedAttempts {
                    let backoff = min(60.0, endpoint.baseBackoffSeconds * pow(2.0, Double(attempt)))
                    recordedBackoffDelays.append(backoff)
                    await sleepHandler(backoff)
                }
            }
        }

        return .failedAfterRetries(
            deliveryId: baseDeliveryId,
            attempts: totalAllowedAttempts,
            lastError: lastErrorText
        )
    }

    private static func isMergedPullRequestPayload(_ payload: Data) -> Bool {
        guard let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
            return false
        }
        let action = (json["action"] as? String)?.lowercased()
        guard action == "closed" else { return false }
        if let pr = json["pull_request"] as? [String: Any],
           let merged = pr["merged"] as? Bool {
            return merged
        }
        return false
    }
}
