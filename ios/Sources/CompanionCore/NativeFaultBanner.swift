import Foundation

/// Severity level for surfaced native runtime fault banners (`BF-2618`).
public enum NativeFaultSeverity: String, Codable, Equatable, Sendable {
    case warning
    case error
    case critical
}

/// Redacted, user-visible fault banner entry derived from native crash/span/data faults.
public struct NativeFaultRecord: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let source: String
    public let code: String
    public let summary: String
    public let detail: String?
    public let severity: NativeFaultSeverity
    public var recordedAt: Double
    public var acknowledged: Bool

    public init(
        id: String = UUID().uuidString,
        source: String,
        code: String,
        summary: String,
        detail: String? = nil,
        severity: NativeFaultSeverity = .error,
        recordedAt: Double = Date().timeIntervalSince1970,
        acknowledged: Bool = false
    ) {
        self.id = id
        self.source = source
        self.code = code
        self.summary = summary
        self.detail = detail
        self.severity = severity
        self.recordedAt = recordedAt
        self.acknowledged = acknowledged
    }
}

/// Thread-safe store surfacing redacted runtime faults as dismissible native banners
/// (`server/data-faults.ts` port for `BF-2618`).
public actor NativeFaultBannerStore {
    private var records: [NativeFaultRecord] = []
    private let maxEntries: Int
    private let dedupWindowSeconds: TimeInterval

    public init(maxEntries: Int = 100, dedupWindowSeconds: TimeInterval = 60) {
        self.maxEntries = max(1, maxEntries)
        self.dedupWindowSeconds = max(0, dedupWindowSeconds)
    }

    /// Records a runtime fault after scrubbing all text fields through `DiagnosticsReporter.redactSecrets`.
    /// Duplicate unacknowledged faults within `dedupWindowSeconds` update in place instead of spamming banners.
    @discardableResult
    public func record(
        source: String,
        code: String,
        summary: String,
        detail: String? = nil,
        severity: NativeFaultSeverity = .error,
        now: Date = Date()
    ) -> NativeFaultRecord {
        let redactedSource = DiagnosticsReporter.redactSecrets(in: source.trimmingCharacters(in: .whitespacesAndNewlines))
        let redactedCode = DiagnosticsReporter.redactSecrets(in: code.trimmingCharacters(in: .whitespacesAndNewlines))
        let redactedSummary = DiagnosticsReporter.redactSecrets(in: summary.trimmingCharacters(in: .whitespacesAndNewlines))
        let redactedDetail = detail.map { DiagnosticsReporter.redactSecrets(in: $0.trimmingCharacters(in: .whitespacesAndNewlines)) }

        let normalizedSource = redactedSource.isEmpty ? "unknown" : redactedSource
        let normalizedCode = redactedCode.isEmpty ? "fault" : redactedCode
        let normalizedSummary = redactedSummary.isEmpty ? "An internal runtime fault was recorded." : redactedSummary
        let normalizedDetail = (redactedDetail?.isEmpty == true) ? nil : redactedDetail
        let nowEpoch = now.timeIntervalSince1970

        if dedupWindowSeconds > 0,
           let existingIndex = records.lastIndex(where: { entry in
               !entry.acknowledged &&
                   entry.source == normalizedSource &&
                   entry.code == normalizedCode &&
                   entry.summary == normalizedSummary &&
                   entry.detail == normalizedDetail &&
                   entry.severity == severity &&
                   abs(nowEpoch - entry.recordedAt) <= dedupWindowSeconds
           }) {
            records[existingIndex].recordedAt = nowEpoch
            return records[existingIndex]
        }

        let entry = NativeFaultRecord(
            source: normalizedSource,
            code: normalizedCode,
            summary: normalizedSummary,
            detail: normalizedDetail,
            severity: severity,
            recordedAt: nowEpoch,
            acknowledged: false
        )
        records.append(entry)
        enforceRetention()
        return entry
    }

    /// Returns unacknowledged banners ordered newest first.
    public func activeBanners() -> [NativeFaultRecord] {
        Array(records.filter { !$0.acknowledged }.reversed())
    }

    /// Returns all retained fault records ordered newest first.
    public func allFaults() -> [NativeFaultRecord] {
        Array(records.reversed())
    }

    /// Marks the banner with `id` as acknowledged; returns whether an entry matched.
    @discardableResult
    public func acknowledge(id: String) -> Bool {
        guard let index = records.firstIndex(where: { $0.id == id }) else {
            return false
        }
        records[index].acknowledged = true
        return true
    }

    /// Removes acknowledged banners from retained history.
    public func clearAcknowledged() {
        records.removeAll(where: \.acknowledged)
    }

    private func enforceRetention() {
        while records.count > maxEntries {
            if let ackIndex = records.firstIndex(where: \.acknowledged) {
                records.remove(at: ackIndex)
            } else {
                records.removeFirst()
            }
        }
    }
}
