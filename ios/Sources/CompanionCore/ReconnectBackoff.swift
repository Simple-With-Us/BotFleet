// How long the phone waits before retrying the event stream after it drops.
//
// Kept apart from `Session` so the schedule — including the escalation for
// a sustained run of gateway failures — is unit-testable without a socket.
// Plain jitter keeps every phone that lost the same Mac from retrying in
// lockstep; the raised ceiling after repeated 502/503/530-family responses
// (`ConnectionAdvice.isGatewayStatusCode` — Cloudflare's answer when the
// paired Mac's sidecar has nothing listening) stops a phone from hammering
// the tunnel every 15s for a Mac that is off for hours.  See IO11.
import Foundation

public struct ReconnectBackoff: Sendable {
    /// Consecutive gateway-class failures before the cap raises from
    /// `baseCap` to `escalatedCap` and the caller should show a distinct
    /// "Mac is offline" status instead of the ordinary retry banner.
    public static let gatewayEscalationThreshold = 6

    private let baseCap: TimeInterval
    private let escalatedCap: TimeInterval
    private let jitterFraction: Double
    private let randomUnit: @Sendable () -> Double

    /// Attempts since the last `reset()` — the exponential curve's input.
    public private(set) var attempt = 0
    /// Gateway-class failures in a row — resets on any other outcome, so a
    /// single application error in the middle of a run does not count
    /// toward the escalation.
    public private(set) var consecutiveGatewayFailures = 0

    /// - Parameters:
    ///   - baseCap: Ordinary reconnect ceiling in seconds — 15s, unchanged
    ///     from before this fix.
    ///   - escalatedCap: Ceiling once `isMacLikelyOffline` is true.
    ///   - jitterFraction: How far the delay may wander from the plain
    ///     exponential value, as a fraction of it (0.25 = ±25%).
    ///   - randomUnit: Returns a value in `-1...1`; injected so tests can
    ///     pin the jitter instead of asserting on a range.
    public init(
        baseCap: TimeInterval = 15,
        escalatedCap: TimeInterval = 60,
        jitterFraction: Double = 0.25,
        randomUnit: @escaping @Sendable () -> Double = { Double.random(in: -1...1) }
    ) {
        self.baseCap = baseCap
        self.escalatedCap = escalatedCap
        self.jitterFraction = jitterFraction
        self.randomUnit = randomUnit
    }

    /// True once a sustained run of gateway failures should read as "the
    /// Mac is offline" rather than an ordinary reconnect — `Session` uses
    /// this to pick `.macOffline` over `.offline(message)`.
    public var isMacLikelyOffline: Bool {
        consecutiveGatewayFailures >= Self.gatewayEscalationThreshold
    }

    /// Record one failed attempt and return the delay, in seconds, before
    /// the next.  `isGatewayFailure` marks a 502/503/530-family response —
    /// pass `ConnectionAdvice.isGatewayOutage(error)`.
    @discardableResult
    public mutating func recordFailure(isGatewayFailure: Bool) -> TimeInterval {
        attempt += 1
        consecutiveGatewayFailures = isGatewayFailure ? consecutiveGatewayFailures + 1 : 0
        let cap = isMacLikelyOffline ? escalatedCap : baseCap
        let exponential = min(pow(2.0, Double(attempt - 1)), cap)
        let jitter = exponential * jitterFraction * randomUnit()
        // Never let jitter push the delay to zero (a busy-retry loop) or
        // meaningfully past the cap the escalation just computed.
        return max(0.5, min(exponential + jitter, cap * (1 + jitterFraction)))
    }

    /// A frame arrived — the connection is genuinely live again.  An old
    /// run's bad luck must not carry forward into the next disconnect, the
    /// same reasoning `apns.ts`'s own `consecutiveTransportFailures` uses.
    public mutating func reset() {
        attempt = 0
        consecutiveGatewayFailures = 0
    }
}
