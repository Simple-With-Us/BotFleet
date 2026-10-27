// When BotFleetMac may look for an update, and how a failed version probe
// is retried and reported.  BF-2486 (Phase 6) acceptance, recorded on the
// issue 2026-10-23: the native updater reproduces the Electron updater's
// behaviour deliberately rather than inheriting it by accident — the probe
// rules from electron/native-version-probe.mjs and the throttle rules from
// electron/updater-throttle.mjs, with their constants resolved here so the
// implementer of the Sparkle controller (BF-2486 follow-up, once the owner
// provisions the EdDSA key) does not re-derive them.
//
// Pure value logic with the clock injected, so the schedule is testable
// without Sparkle, the network, or a signed bundle.
import Foundation

/// Why a native-binary version probe failed, in the classes the Electron
/// probe could tell apart.  A timeout is a statement about the host, never
/// about the binary; the other classes are deterministic, so retrying them
/// only delays the same answer.
public enum NativeProbeFailure: String, Sendable, Equatable {
    case timeout
    case spawn
    case signal
    case status
    case version
    case missingExecutable

    /// Only a timeout can succeed a second later.
    public var isRetryable: Bool { self == .timeout }
}

/// The evidence a probe failure carries, with the Electron probe's excerpt
/// caps (error 160 chars, output 200) so a failure message stays one line
/// a person can act on instead of a tool inventory.
public struct NativeProbeEvidence: Sendable, Equatable {
    public let failure: NativeProbeFailure
    public let status: Int32?
    public let signal: Int32?
    public let spawnError: String?
    public let outputExcerpt: String

    public init(
        failure: NativeProbeFailure,
        status: Int32? = nil,
        signal: Int32? = nil,
        spawnError: String? = nil,
        output: String = ""
    ) {
        self.failure = failure
        self.status = status
        self.signal = signal
        self.spawnError = spawnError.map { String($0.prefix(160)) }
        self.outputExcerpt = String(output.prefix(200))
    }
}

/// The probe retry decision: two attempts, sixty seconds each, and a retry
/// only when the first failure was a timeout.
public enum NativeProbePolicy {
    public static let maxAttempts = 2
    public static let timeoutSeconds: TimeInterval = 60

    public static func shouldRetry(after evidence: NativeProbeEvidence, attempt: Int) -> Bool {
        attempt < maxAttempts && evidence.failure.isRetryable
    }
}

/// The automatic update-check throttle.
///
/// - Six hours between automatic checks.
/// - Three failures of the SAME class in a row back off to twenty-four
///   hours; a different class breaks the streak, because a feed having a
///   bad minute and a feed being broken are different things.
/// - A changed bundle fingerprint counts as never checked, so a build that
///   landed on disk outside the updater's own path surfaces immediately.
/// - Manual checks bypass the throttle entirely.
public struct NativeUpdateThrottle: Sendable, Equatable {
    public static let autoCheckInterval: TimeInterval = 6 * 60 * 60
    public static let failureStreakThreshold = 3
    public static let failureBackoff: TimeInterval = 24 * 60 * 60

    public private(set) var lastCheck: Date?
    public private(set) var lastFailureClass: String?
    public private(set) var failureStreak = 0
    public private(set) var bundleFingerprint: String?

    public init() {}

    /// Whether an automatic check may run at `now`.  Pass the fingerprint
    /// of the bundle on disk; a new fingerprint is a new app for throttle
    /// purposes.
    public func shouldAutoCheck(now: Date, fingerprint: String) -> Bool {
        guard let lastCheck, bundleFingerprint == fingerprint else { return true }
        let interval = failureStreak >= Self.failureStreakThreshold
            ? Self.failureBackoff
            : Self.autoCheckInterval
        return now.timeIntervalSince(lastCheck) >= interval
    }

    /// Record an automatic check's outcome.  A success clears the streak;
    /// a failure extends it only when the class repeats.
    public mutating func recordCheck(
        now: Date,
        fingerprint: String,
        failureClass: String?
    ) {
        lastCheck = now
        bundleFingerprint = fingerprint
        guard let failureClass else {
            lastFailureClass = nil
            failureStreak = 0
            return
        }
        failureStreak = failureClass == lastFailureClass ? failureStreak + 1 : 1
        lastFailureClass = failureClass
    }
}
