// Renders the APNs sender's health as a one-line Settings row.
//
// Pin the copy in #389: what an owner can act on, not a paragraph of
// Apple's status codes.  Every state has a single, distinct line so a
// regression that turns "no key" into "configured" surfaces here
// instead of as a silent failure on someone's locked screen.
import XCTest
@testable import CompanionCore

final class PushSenderHealthTests: XCTestCase {
    /// Reference moment used by every test that pins relative-time text.
    /// Picked to be unambiguous: it is 1 700 000 000 s after the epoch,
    /// long after any reasonable lastSentAt we craft below.
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    /// The formatter default depends on the user's locale and unit-style;
    /// production uses `RelativeDateTimeFormatter` and we do not pin
    /// locale here.  Tests inject a deterministic closure so the only
    /// thing this asserts is that the right "last push …" text is
    /// produced, with the relative phrase deterministically replaced.
    private static let fixedRelative: (Date, Date) -> String = { _, _ in
        "5 minutes ago"
    }

    func testReportsNoSigningKeyWhenTheSidecarIsNotConfigured() {
        let health = PushSenderHealth(
            configured: false,
            production: nil,
            tokensRegistered: 0,
            sent: 0,
            failed: 0,
            lastSentAt: nil,
            lastErrorAt: nil,
            lastError: nil,
            keyRejected: nil,
            dropped: 0
        )
        XCTAssertEqual(
            PushSenderHealthView.summary(health, now: now, relativeDescription: Self.fixedRelative),
            "No signing key on your computer — a closed app will not be woken."
        )
        XCTAssertNil(PushSenderHealthView.detail(health))
    }

    /// `lastSentAt` is set but `configured` is false: the no-key line
    /// wins because the sidecar cannot actually have sent anything.
    /// This is also the state where the user must replace the key —
    /// the copy says so plainly, no jargon.
    func testNoKeyLineWinsOverAnyLastSentTimestamps() {
        let health = PushSenderHealth(
            configured: false,
            production: nil,
            tokensRegistered: 0,
            sent: 0,
            failed: 0,
            lastSentAt: 1_600_000_000,
            lastErrorAt: nil,
            lastError: nil,
            keyRejected: nil,
            dropped: 0
        )
        XCTAssertTrue(
            PushSenderHealthView.summary(health, now: now, relativeDescription: Self.fixedRelative)
                .hasPrefix("No signing key")
        )
    }

    /// Apple refused the signing key itself.  We surface Apple's verbatim
    /// reason so a support engineer knows what to look for, plus the
    /// plain-English fix: the key file needs replacing.  Without
    /// surfacing the reason the user has to dig through logs.
    func testKeyRejectedSurfacesAppleReasonAndTheFix() {
        let health = PushSenderHealth(
            configured: true,
            production: true,
            tokensRegistered: 1,
            sent: 12,
            failed: 1,
            lastSentAt: now.timeIntervalSince1970 * 1000,
            lastErrorAt: nil,
            lastError: nil,
            keyRejected: "InvalidProviderToken",
            dropped: 0
        )
        XCTAssertEqual(
            PushSenderHealthView.summary(health, now: now, relativeDescription: Self.fixedRelative),
            "InvalidProviderToken — the key file needs replacing."
        )
    }

    /// Healthy path: key is configured, no rejection, last send recent.
    func testHealthyReportsOnWithLastPushRelativeTime() {
        let fiveMinutesAgo = now.timeIntervalSince1970 - 300
        let health = PushSenderHealth(
            configured: true,
            production: true,
            tokensRegistered: 1,
            sent: 7,
            failed: 0,
            lastSentAt: fiveMinutesAgo * 1000,
            lastErrorAt: nil,
            lastError: nil,
            keyRejected: nil,
            dropped: 0
        )
        XCTAssertEqual(
            PushSenderHealthView.summary(health, now: now, relativeDescription: Self.fixedRelative),
            "Closed-app notifications: On — last push 5 minutes ago"
        )
        XCTAssertNil(PushSenderHealthView.detail(health))
    }

    /// Recent error alongside a recent send — both must be visible, the
    /// error inline with the relative time so an owner can correlate
    /// the two at a glance.
    func testRecentErrorIsSurfacedAlongsideTheLastPush() {
        let fiveMinutesAgo = now.timeIntervalSince1970 - 300
        let health = PushSenderHealth(
            configured: true,
            production: true,
            tokensRegistered: 1,
            sent: 7,
            failed: 1,
            lastSentAt: fiveMinutesAgo * 1000,
            lastErrorAt: now.timeIntervalSince1970 * 1000,
            lastError: "403 ExpiredProviderToken",
            keyRejected: nil,
            dropped: 0
        )
        XCTAssertEqual(
            PushSenderHealthView.summary(health, now: now, relativeDescription: Self.fixedRelative),
            "Closed-app notifications: On — last push 5 minutes ago; last error 403 ExpiredProviderToken"
        )
    }

    /// Configured but never sent — no relative-time to quote, but the
    /// error has to remain visible.  Without this, "configured, no
    /// pushes yet" hides the real status behind an encouraging line.
    func testConfiguredButNeverSentStillSurfacesAnyLastError() {
        let health = PushSenderHealth(
            configured: true,
            production: false,
            tokensRegistered: 1,
            sent: 0,
            failed: 1,
            lastSentAt: nil,
            lastErrorAt: now.timeIntervalSince1970 * 1000,
            lastError: "400 BadDeviceToken",
            keyRejected: nil,
            dropped: 0
        )
        XCTAssertEqual(
            PushSenderHealthView.summary(health, now: now, relativeDescription: Self.fixedRelative),
            "Closed-app notifications: configured — last error 400 BadDeviceToken"
        )
    }

    func testConfiguredWithoutAnySendsOrErrorsIsStillCalm() {
        let health = PushSenderHealth(
            configured: true,
            production: true,
            tokensRegistered: 0,
            sent: 0,
            failed: 0,
            lastSentAt: nil,
            lastErrorAt: nil,
            lastError: nil,
            keyRejected: nil,
            dropped: 0
        )
        XCTAssertEqual(
            PushSenderHealthView.summary(health, now: now, relativeDescription: Self.fixedRelative),
            "Closed-app notifications: configured — no pushes sent yet"
        )
    }

    /// `dropped` only becomes the secondary line once it is non-zero —
    /// showing "(0 dropped)" would be noise.  `failed` likewise: only
    /// when there is something to report.
    func testDetailHidesZeroCounts() {
        let healthy = PushSenderHealth(
            configured: true,
            production: true,
            tokensRegistered: 1,
            sent: 7,
            failed: 0,
            lastSentAt: now.timeIntervalSince1970 * 1000,
            lastErrorAt: nil,
            lastError: nil,
            keyRejected: nil,
            dropped: 0
        )
        XCTAssertNil(PushSenderHealthView.detail(healthy))
    }

    func testDetailSurfacesDroppedAndFailedCounts() {
        let health = PushSenderHealth(
            configured: true,
            production: true,
            tokensRegistered: 2,
            sent: 10,
            failed: 2,
            lastSentAt: now.timeIntervalSince1970 * 1000,
            lastErrorAt: nil,
            lastError: nil,
            keyRejected: nil,
            dropped: 3
        )
        XCTAssertEqual(PushSenderHealthView.detail(health), "3 dropped (queue full), 2 failed")
    }

    /// Only one of dropped/failed present: still shown, no trailing
    /// separator or "(0 failed)" padding.
    func testDetailWithOnlyDroppedIsNotZeroPadded() {
        let health = PushSenderHealth(
            configured: true,
            production: true,
            tokensRegistered: 1,
            sent: 5,
            failed: 0,
            lastSentAt: now.timeIntervalSince1970 * 1000,
            lastErrorAt: nil,
            lastError: nil,
            keyRejected: nil,
            dropped: 1
        )
        XCTAssertEqual(PushSenderHealthView.detail(health), "1 dropped (queue full)")
    }

    /// Circuit-breaker skips are an APNs outage, not a full queue: they get
    /// their own wording and never borrow the "queue full" copy.
    func testDetailLabelsCircuitDropsAsAnOutageNotAFullQueue() {
        let health = PushSenderHealth(
            configured: true,
            production: true,
            tokensRegistered: 1,
            sent: 5,
            failed: 20,
            lastSentAt: now.timeIntervalSince1970 * 1000,
            lastErrorAt: nil,
            lastError: nil,
            keyRejected: nil,
            dropped: 0,
            circuitDropped: 4
        )
        XCTAssertEqual(
            PushSenderHealthView.detail(health),
            "4 skipped (Apple push service unreachable), 20 failed"
        )
    }

    func testDetailShowsQueueFullAndCircuitDropsSeparately() {
        let health = PushSenderHealth(
            configured: true,
            production: true,
            tokensRegistered: 1,
            sent: 5,
            failed: 0,
            lastSentAt: now.timeIntervalSince1970 * 1000,
            lastErrorAt: nil,
            lastError: nil,
            keyRejected: nil,
            dropped: 2,
            circuitDropped: 3
        )
        XCTAssertEqual(
            PushSenderHealthView.detail(health),
            "2 dropped (queue full), 3 skipped (Apple push service unreachable)"
        )
    }

    func testDecodesCircuitDroppedFromANewerSidecar() throws {
        let json = #"""
        {
          "configured": true,
          "production": true,
          "tokensRegistered": 1,
          "sent": 3,
          "failed": 20,
          "lastSentAt": null,
          "lastErrorAt": null,
          "lastError": null,
          "keyRejected": null,
          "dropped": 0,
          "circuitDropped": 7
        }
        """#
        let health = try JSONDecoder().decode(PushSenderHealth.self, from: Data(json.utf8))
        XCTAssertEqual(health.dropped, 0)
        XCTAssertEqual(health.circuitDropped, 7)
    }

    /// Decoding the JSON the sidecar emits.  Pinned here so a future
    /// field rename on the server is a test failure, not a runtime
    /// "the row went blank" report.
    func testDecodesTheExactJsonTheSidecarReturns() throws {
        let json = #"""
        {
          "configured": true,
          "production": true,
          "tokensRegistered": 2,
          "sent": 14,
          "failed": 0,
          "lastSentAt": 1699990000000,
          "lastErrorAt": null,
          "lastError": null,
          "keyRejected": null,
          "dropped": 0
        }
        """#
        let health = try JSONDecoder().decode(PushSenderHealth.self, from: Data(json.utf8))
        XCTAssertTrue(health.configured)
        XCTAssertEqual(health.production, true)
        XCTAssertEqual(health.tokensRegistered, 2)
        XCTAssertEqual(health.sent, 14)
        XCTAssertEqual(health.failed, 0)
        XCTAssertEqual(health.lastSentAt, 1_699_990_000_000)
        XCTAssertNil(health.lastErrorAt)
        XCTAssertNil(health.lastError)
        XCTAssertNil(health.keyRejected)
        XCTAssertEqual(health.dropped, 0)
        // An older sidecar sends no circuitDropped field; it decodes as nil.
        XCTAssertNil(health.circuitDropped)
    }

    func testDecodesASenderWithNoSends() throws {
        let json = #"""
        {
          "configured": true,
          "production": false,
          "tokensRegistered": 1,
          "sent": 0,
          "failed": 0,
          "lastSentAt": null,
          "lastErrorAt": null,
          "lastError": null,
          "keyRejected": null,
          "dropped": 0
        }
        """#
        let health = try JSONDecoder().decode(PushSenderHealth.self, from: Data(json.utf8))
        XCTAssertEqual(health.production, false)
        XCTAssertNil(health.lastSentAt)
    }

    // MARK: - Off / Degraded (IO2, IO5)

    /// The exact bug: a sidecar that latched sending off after Apple
    /// refused the key must not still read "On" just because it sent
    /// successfully before the fault.  `pushesOffReason` is one of three
    /// known codes from the sidecar (`companion/src/apns.ts`, PR #597);
    /// each maps to plain English rather than showing the raw code.
    func testSummaryMapsKeyRejectedPushesOffReasonToPlainEnglish() {
        let health = PushSenderHealth(
            configured: true,
            production: true,
            tokensRegistered: 1,
            sent: 12,
            failed: 5,
            lastSentAt: now.timeIntervalSince1970 * 1000 - 60_000,
            lastErrorAt: nil,
            lastError: nil,
            keyRejected: nil,
            dropped: 0,
            pushesOff: true,
            pushesOffReason: "key-rejected"
        )
        XCTAssertEqual(
            PushSenderHealthView.summary(health, now: now, relativeDescription: Self.fixedRelative),
            "Closed-app notifications: Off — Apple refused the signing key"
        )
    }

    func testSummaryMapsNoKeyPushesOffReasonToPlainEnglish() {
        let health = PushSenderHealth(
            configured: true,
            production: true,
            tokensRegistered: 1,
            sent: 0,
            failed: 0,
            lastSentAt: nil,
            lastErrorAt: nil,
            lastError: nil,
            keyRejected: nil,
            dropped: 0,
            pushesOff: true,
            pushesOffReason: "no-key"
        )
        XCTAssertEqual(
            PushSenderHealthView.summary(health, now: now, relativeDescription: Self.fixedRelative),
            "Closed-app notifications: Off — no signing key on your computer"
        )
    }

    func testSummaryMapsUnreachablePushesOffReasonToPlainEnglish() {
        let health = PushSenderHealth(
            configured: true,
            production: true,
            tokensRegistered: 1,
            sent: 12,
            failed: 5,
            lastSentAt: now.timeIntervalSince1970 * 1000 - 60_000,
            lastErrorAt: nil,
            lastError: nil,
            keyRejected: nil,
            dropped: 0,
            pushesOff: true,
            pushesOffReason: "unreachable"
        )
        XCTAssertEqual(
            PushSenderHealthView.summary(health, now: now, relativeDescription: Self.fixedRelative),
            "Closed-app notifications: Off — your computer cannot reach Apple"
        )
    }

    func testSummaryReportsOffWithNoReasonWhenPushesOffReasonIsMissing() {
        let health = PushSenderHealth(
            configured: true,
            production: true,
            tokensRegistered: 1,
            sent: 12,
            failed: 0,
            lastSentAt: now.timeIntervalSince1970 * 1000,
            lastErrorAt: nil,
            lastError: nil,
            keyRejected: nil,
            dropped: 0,
            pushesOff: true
        )
        XCTAssertEqual(
            PushSenderHealthView.summary(health, now: now, relativeDescription: Self.fixedRelative),
            "Closed-app notifications: Off"
        )
    }

    /// A future sidecar reason this build does not recognize yet must fall
    /// back to the plain line rather than leak a raw machine code.
    func testSummaryFallsBackToPlainOffForAnUnrecognizedPushesOffReason() {
        let health = PushSenderHealth(
            configured: true,
            production: true,
            tokensRegistered: 1,
            sent: 12,
            failed: 0,
            lastSentAt: now.timeIntervalSince1970 * 1000,
            lastErrorAt: nil,
            lastError: nil,
            keyRejected: nil,
            dropped: 0,
            pushesOff: true,
            pushesOffReason: "some-future-reason"
        )
        XCTAssertEqual(
            PushSenderHealthView.summary(health, now: now, relativeDescription: Self.fixedRelative),
            "Closed-app notifications: Off"
        )
    }

    /// An open circuit breaker is degraded, not dead — the sidecar is still
    /// trying and a send may still land, unlike the latched-off states
    /// above, so it reads "Degraded" rather than "Off".
    func testSummaryReportsDegradedWhileTheCircuitBreakerIsOpen() {
        let health = PushSenderHealth(
            configured: true,
            production: true,
            tokensRegistered: 1,
            sent: 12,
            failed: 20,
            lastSentAt: now.timeIntervalSince1970 * 1000 - 60_000,
            lastErrorAt: nil,
            lastError: nil,
            keyRejected: nil,
            dropped: 0,
            circuitOpenUntil: now.timeIntervalSince1970 * 1000 + 30_000
        )
        XCTAssertEqual(
            PushSenderHealthView.summary(health, now: now, relativeDescription: Self.fixedRelative),
            "Closed-app notifications: Degraded — Apple's push service is " +
                "temporarily unreachable from your computer; retrying automatically"
        )
    }

    /// A `circuitOpenUntil` timestamp that has already passed is a closed
    /// breaker, not an open one — must not still read as "Degraded".
    func testSummaryDoesNotReportDegradedWhenCircuitOpenUntilIsInThePast() {
        let health = PushSenderHealth(
            configured: true,
            production: true,
            tokensRegistered: 1,
            sent: 12,
            failed: 0,
            lastSentAt: now.timeIntervalSince1970 * 1000,
            lastErrorAt: nil,
            lastError: nil,
            keyRejected: nil,
            dropped: 0,
            circuitOpenUntil: now.timeIntervalSince1970 * 1000 - 30_000
        )
        XCTAssertEqual(
            PushSenderHealthView.summary(health, now: now, relativeDescription: Self.fixedRelative),
            "Closed-app notifications: On — last push 5 minutes ago"
        )
    }

    func testSummaryReportsDegradedAtTheTransportFailureThreshold() {
        let health = PushSenderHealth(
            configured: true,
            production: true,
            tokensRegistered: 1,
            sent: 12,
            failed: 5,
            lastSentAt: now.timeIntervalSince1970 * 1000 - 60_000,
            lastErrorAt: now.timeIntervalSince1970 * 1000,
            lastError: "ECONNRESET",
            keyRejected: nil,
            dropped: 0,
            consecutiveTransportFailures: PushSenderHealthView.degradedTransportFailureThreshold
        )
        XCTAssertEqual(
            PushSenderHealthView.summary(health, now: now, relativeDescription: Self.fixedRelative),
            "Closed-app notifications: Degraded — 5 failed attempts in a row; last error ECONNRESET"
        )
    }

    func testSummaryStaysOnBelowTheDegradedTransportFailureThreshold() {
        let health = PushSenderHealth(
            configured: true,
            production: true,
            tokensRegistered: 1,
            sent: 12,
            failed: 1,
            lastSentAt: now.timeIntervalSince1970 * 1000 - 60_000,
            lastErrorAt: nil,
            lastError: nil,
            keyRejected: nil,
            dropped: 0,
            consecutiveTransportFailures: PushSenderHealthView.degradedTransportFailureThreshold - 1
        )
        XCTAssertEqual(
            PushSenderHealthView.summary(health, now: now, relativeDescription: Self.fixedRelative),
            "Closed-app notifications: On — last push 5 minutes ago"
        )
    }

    /// Priority sanity: a key rejection is the most specific, most
    /// actionable state and must keep winning over the newer fault fields.
    func testKeyRejectedStillWinsOverPushesOffAndCircuitOpen() {
        let health = PushSenderHealth(
            configured: true,
            production: true,
            tokensRegistered: 1,
            sent: 12,
            failed: 5,
            lastSentAt: now.timeIntervalSince1970 * 1000,
            lastErrorAt: nil,
            lastError: nil,
            keyRejected: "InvalidProviderToken",
            dropped: 0,
            circuitOpenUntil: now.timeIntervalSince1970 * 1000 + 30_000,
            pushesOff: true,
            pushesOffReason: "should not be shown"
        )
        XCTAssertEqual(
            PushSenderHealthView.summary(health, now: now, relativeDescription: Self.fixedRelative),
            "InvalidProviderToken — the key file needs replacing."
        )
    }

    // MARK: - Decoding the new breaker fields (IO5)

    func testDecodesTheNewBreakerFieldsFromANewerSidecar() throws {
        let json = #"""
        {
          "configured": true,
          "production": true,
          "tokensRegistered": 1,
          "sent": 3,
          "failed": 20,
          "lastSentAt": null,
          "lastErrorAt": 1699990000000,
          "lastError": "socket hang up",
          "keyRejected": null,
          "dropped": 0,
          "circuitDropped": 4,
          "failureKind": "transport",
          "consecutiveTransportFailures": 20,
          "lastErrorCode": "ECONNRESET",
          "circuitOpenUntil": 1699990060000
        }
        """#
        let health = try JSONDecoder().decode(PushSenderHealth.self, from: Data(json.utf8))
        XCTAssertEqual(health.failureKind, "transport")
        XCTAssertEqual(health.consecutiveTransportFailures, 20)
        XCTAssertEqual(health.lastErrorCode, "ECONNRESET")
        XCTAssertEqual(health.circuitOpenUntil, 1_699_990_060_000)
        XCTAssertNil(health.pushesOff)
        XCTAssertNil(health.pushesOffReason)
    }

    func testDecodesPushesOffFieldsWhenPresent() throws {
        let json = #"""
        {
          "configured": true,
          "production": true,
          "tokensRegistered": 1,
          "sent": 0,
          "failed": 0,
          "lastSentAt": null,
          "lastErrorAt": null,
          "lastError": null,
          "keyRejected": null,
          "dropped": 0,
          "pushesOff": true,
          "pushesOffReason": "disabled after repeated key faults"
        }
        """#
        let health = try JSONDecoder().decode(PushSenderHealth.self, from: Data(json.utf8))
        XCTAssertEqual(health.pushesOff, true)
        XCTAssertEqual(health.pushesOffReason, "disabled after repeated key faults")
    }

    /// An older sidecar sends none of the breaker fields; every one of them
    /// must decode as nil rather than throwing and blanking the whole row.
    func testOlderSidecarPayloadDecodesEveryNewFieldAsNil() throws {
        let json = #"""
        {
          "configured": true,
          "production": true,
          "tokensRegistered": 2,
          "sent": 14,
          "failed": 0,
          "lastSentAt": 1699990000000,
          "lastErrorAt": null,
          "lastError": null,
          "keyRejected": null,
          "dropped": 0
        }
        """#
        let health = try JSONDecoder().decode(PushSenderHealth.self, from: Data(json.utf8))
        XCTAssertNil(health.failureKind)
        XCTAssertNil(health.consecutiveTransportFailures)
        XCTAssertNil(health.lastErrorCode)
        XCTAssertNil(health.circuitOpenUntil)
        XCTAssertNil(health.pushesOff)
        XCTAssertNil(health.pushesOffReason)
    }

    func testDecodesAKeyRejectedSender() throws {
        let json = #"""
        {
          "configured": true,
          "production": true,
          "tokensRegistered": 1,
          "sent": 0,
          "failed": 0,
          "lastSentAt": null,
          "lastErrorAt": 1699990000000,
          "lastError": "InvalidProviderToken",
          "keyRejected": "InvalidProviderToken",
          "dropped": 0
        }
        """#
        let health = try JSONDecoder().decode(PushSenderHealth.self, from: Data(json.utf8))
        XCTAssertEqual(health.keyRejected, "InvalidProviderToken")
        XCTAssertEqual(health.lastError, "InvalidProviderToken")
    }
}
