// Closed-app wake: how healthy the sidecar's APNs sender looks right now.
//
// Mirrors `PushSenderHealth` in `companion/src/apns.ts`.  The shape lives
// here rather than in Models.swift because it is a sidecar-owned route,
// not a harness one — the harness has no concept of push delivery.  Counts
// and Apple's own status strings only; nothing derived from the signing key.
import Foundation

public struct PushSenderHealth: Codable, Hashable, Sendable {
    /// Whether a usable .p8 has been found yet.
    public let configured: Bool
    /// Production or sandbox APNs, once configured.
    public let production: Bool?
    /// Paired devices holding a push token right now.
    public let tokensRegistered: Int
    public let sent: Int
    public let failed: Int
    /// Milliseconds since the Unix epoch; matches what the sidecar emits.
    public let lastSentAt: Double?
    public let lastErrorAt: Double?
    /// Apple's status plus its reason, e.g. `403 ExpiredProviderToken`.
    public let lastError: String?
    /// Set when Apple refused the signing key itself.  Sending is off until
    /// the key file changes — a fresh signature from the same key cannot
    /// help.
    public let keyRejected: String?
    /// Notifications dropped because a device's queue was already full.
    public let dropped: Int
    /// Notifications skipped while the sidecar's circuit breaker was open —
    /// Apple's push service was unreachable, not a full queue.  Optional so
    /// an older sidecar that does not send the field still decodes.
    public let circuitDropped: Int?
    /// The bucketed shape of the last failure — `"transport"`, `"key_fault"`,
    /// `"none"`, etc.  Mirrors `ApnsFailureKind` in `companion/src/apns.ts`
    /// as a raw string rather than a Swift enum, so a sidecar that adds a
    /// new kind still decodes instead of the row going blank.  Optional: an
    /// older sidecar sends no such field.
    public let failureKind: String?
    /// Transport failures (DNS / TCP / TLS / HTTP-2 socket drop, timeout) in
    /// a row.  Resets to zero the moment a send lands, so a recovered
    /// network does not carry an old run's bad luck forward.  Optional for
    /// the same reason as `failureKind`.
    public let consecutiveTransportFailures: Int?
    /// `err.code` / HTTP-2 code from the last failure, surfaced verbatim
    /// from Node.  Optional for the same reason as `failureKind`.
    public let lastErrorCode: String?
    /// Epoch ms; non-nil and in the future means the sidecar's circuit
    /// breaker is open and sends are being skipped outright, not attempted
    /// and failing one at a time.  Optional for the same reason as
    /// `failureKind`.
    public let circuitOpenUntil: Double?
    /// Set when the sidecar has latched sending off entirely — for example
    /// after Apple refused the signing key on every device.  Optional and
    /// forward-compatible: no sidecar sends this field yet.
    public let pushesOff: Bool?
    /// Plain-English reason for `pushesOff`, when the sidecar has one.
    public let pushesOffReason: String?

    public init(
        configured: Bool,
        production: Bool?,
        tokensRegistered: Int,
        sent: Int,
        failed: Int,
        lastSentAt: Double?,
        lastErrorAt: Double?,
        lastError: String?,
        keyRejected: String?,
        dropped: Int,
        circuitDropped: Int? = nil,
        failureKind: String? = nil,
        consecutiveTransportFailures: Int? = nil,
        lastErrorCode: String? = nil,
        circuitOpenUntil: Double? = nil,
        pushesOff: Bool? = nil,
        pushesOffReason: String? = nil
    ) {
        self.configured = configured
        self.production = production
        self.tokensRegistered = tokensRegistered
        self.sent = sent
        self.failed = failed
        self.lastSentAt = lastSentAt
        self.lastErrorAt = lastErrorAt
        self.lastError = lastError
        self.keyRejected = keyRejected
        self.dropped = dropped
        self.circuitDropped = circuitDropped
        self.failureKind = failureKind
        self.consecutiveTransportFailures = consecutiveTransportFailures
        self.lastErrorCode = lastErrorCode
        self.circuitOpenUntil = circuitOpenUntil
        self.pushesOff = pushesOff
        self.pushesOffReason = pushesOffReason
    }
}

/// Renders `PushSenderHealth` as the Settings row the issue calls for.
///
/// Pure: takes a clock so tests do not need to freeze the system date.
/// Strings follow the copy in #389 — what a non-technical owner can act
/// on without a sentence about Apple's status codes.
public enum PushSenderHealthView {
    /// The primary status line for the Settings row.
    ///
    /// `now` lets tests pin time, and `relativeDescription` lets them
    /// pin the locale-dependent phrase — production callers omit both.
    public static func summary(
        _ health: PushSenderHealth,
        now: Date = Date(),
        relativeDescription: (Date, Date) -> String = defaultRelativeDescription
    ) -> String {
        // No key: a closed app will not be woken.  This is the one state
        // the user can actually fix by themselves, so it gets its own line.
        if !health.configured {
            return "No signing key on your computer — a closed app will not be woken."
        }
        if let rejected = health.keyRejected, !rejected.isEmpty {
            // Apple's reason is technical, but it tells the owner whether
            // to ask Apple or rotate the key, so surface it verbatim and
            // explain the fix in plain English below.
            return "\(rejected) — the key file needs replacing."
        }
        // A latched-off sender is a real "not woken" state that `lastSentAt`
        // alone cannot see — a past successful send says nothing about
        // right now.  Checked ahead of `lastSentAt` so a total outage never
        // reads as "On" just because sending worked at some point in the
        // past (IO2, IO5).
        if health.pushesOff == true {
            if let description = Self.pushesOffDescription(health.pushesOffReason) {
                return "Closed-app notifications: Off — \(description)"
            }
            return "Closed-app notifications: Off"
        }
        // An open circuit breaker or a real run of transport failures is a
        // degraded sender, not a dead one — the sidecar is still trying and
        // a send may still land, unlike the latched-off states above.
        if let circuitOpenUntil = health.circuitOpenUntil,
           circuitOpenUntil > now.timeIntervalSince1970 * 1000 {
            return "Closed-app notifications: Degraded — Apple's push service is " +
                "temporarily unreachable from your computer; retrying automatically"
        }
        if let failures = health.consecutiveTransportFailures,
           failures >= degradedTransportFailureThreshold {
            if let lastError = health.lastError, !lastError.isEmpty {
                return "Closed-app notifications: Degraded — \(failures) failed attempts in a row; last error \(lastError)"
            }
            return "Closed-app notifications: Degraded — \(failures) failed attempts in a row"
        }
        if let sentAt = health.lastSentAt {
            let sentDate = Date(timeIntervalSince1970: sentAt / 1000)
            let relative = relativeDescription(sentDate, now)
            if let lastError = health.lastError, !lastError.isEmpty {
                return "Closed-app notifications: On — last push \(relative); last error \(lastError)"
            }
            return "Closed-app notifications: On — last push \(relative)"
        }
        if let lastError = health.lastError, !lastError.isEmpty {
            return "Closed-app notifications: configured — last error \(lastError)"
        }
        return "Closed-app notifications: configured — no pushes sent yet"
    }

    /// `pushesOffReason`'s three known codes (`companion/src/apns.ts`,
    /// merged in PR #597), mapped to plain English.  `nil` for a missing or
    /// future/unrecognized code — a machine code (or a stale mapping once
    /// the sidecar adds a fourth reason) is worse to show verbatim than to
    /// fall back to the plain "Off" line above.
    private static func pushesOffDescription(_ reason: String?) -> String? {
        switch reason {
        case "no-key": return "no signing key on your computer"
        case "key-rejected": return "Apple refused the signing key"
        case "unreachable": return "your computer cannot reach Apple"
        default: return nil
        }
    }

    /// Consecutive transport failures (DNS / TCP / TLS / HTTP-2 drop,
    /// timeout) before the row reads "Degraded" instead of "On".  Well
    /// below the sidecar's own circuit-breaker trip threshold
    /// (`APNS_TRANSPORT_THRESHOLD = 20` in `apns.ts`) — this is the early
    /// warning; `circuitOpenUntil` above already covers the tripped state
    /// on its own.
    public static let degradedTransportFailureThreshold = 5

    /// Secondary line for `dropped`, `circuitDropped` and a recent `failed`
    /// count.  Returns nil when there is nothing worth surfacing beyond the
    /// primary line.  Queue-full drops and circuit-breaker skips get their
    /// own wording: an APNs outage must not read as a full local queue.
    public static func detail(_ health: PushSenderHealth) -> String? {
        var parts: [String] = []
        if health.dropped > 0 {
            parts.append("\(health.dropped) dropped (queue full)")
        }
        if let skipped = health.circuitDropped, skipped > 0 {
            parts.append("\(skipped) skipped (Apple push service unreachable)")
        }
        if health.failed > 0 {
            parts.append("\(health.failed) failed")
        }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    /// The "not reported by this computer" line for an older sidecar.
    public static let notReported = "Closed-app notifications: status not reported by this computer."

    public static let defaultRelativeDescription: (Date, Date) -> String = { past, now in
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: past, relativeTo: now)
    }
}
