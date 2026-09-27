// The reconnect schedule, including the gateway-outage escalation (IO11).
import XCTest
@testable import CompanionCore

final class ReconnectBackoffTests: XCTestCase {
    private func noJitter() -> ReconnectBackoff {
        ReconnectBackoff(randomUnit: { 0 })
    }

    func testJitterlessScheduleMatchesTheOldExponentialCurveUpToTheFifteenSecondCap() {
        var backoff = noJitter()
        let delays = (0..<6).map { _ in backoff.recordFailure(isGatewayFailure: false) }
        XCTAssertEqual(delays, [1, 2, 4, 8, 15, 15])
    }

    func testPositiveJitterAddsUpToTwentyFivePercent() {
        var backoff = ReconnectBackoff(randomUnit: { 1 })
        // attempt 1: exponential = 1, jitter = 1 * 0.25 * 1 = 0.25
        XCTAssertEqual(backoff.recordFailure(isGatewayFailure: false), 1.25, accuracy: 0.0001)
    }

    func testNegativeJitterSubtractsUpToTwentyFivePercent() {
        var backoff = ReconnectBackoff(randomUnit: { -1 })
        // attempt 1: exponential = 1, jitter = 1 * 0.25 * -1 = -0.25
        XCTAssertEqual(backoff.recordFailure(isGatewayFailure: false), 0.75, accuracy: 0.0001)
    }

    func testDelayNeverDropsToZeroOrNegativeUnderMaximumNegativeJitter() {
        var backoff = ReconnectBackoff(randomUnit: { -1 })
        for _ in 0..<10 {
            XCTAssertGreaterThanOrEqual(backoff.recordFailure(isGatewayFailure: false), 0.5)
        }
    }

    func testCapStaysAtFifteenSecondsBelowTheGatewayEscalationThreshold() {
        var backoff = noJitter()
        for _ in 0..<(ReconnectBackoff.gatewayEscalationThreshold - 1) {
            _ = backoff.recordFailure(isGatewayFailure: true)
        }
        XCTAssertFalse(backoff.isMacLikelyOffline)
    }

    func testCapRaisesToSixtySecondsAfterSixConsecutiveGatewayFailures() {
        var backoff = noJitter()
        var lastDelay: TimeInterval = 0
        for _ in 0..<ReconnectBackoff.gatewayEscalationThreshold {
            lastDelay = backoff.recordFailure(isGatewayFailure: true)
        }
        XCTAssertTrue(backoff.isMacLikelyOffline)
        // attempt 6: exponential = 2^5 = 32, still under the raised 60s cap
        XCTAssertEqual(lastDelay, 32, accuracy: 0.0001)

        // attempt 7: 2^6 = 64, now clamped to the raised cap
        let seventh = backoff.recordFailure(isGatewayFailure: true)
        XCTAssertEqual(seventh, 60, accuracy: 0.0001)
    }

    func testANonGatewayFailureResetsTheConsecutiveGatewayCounterAndDropsTheCap() {
        var backoff = noJitter()
        for _ in 0..<ReconnectBackoff.gatewayEscalationThreshold {
            _ = backoff.recordFailure(isGatewayFailure: true)
        }
        XCTAssertTrue(backoff.isMacLikelyOffline)

        // A single application error in the middle of a gateway-failure run
        // must not count toward the escalation, and drops it immediately —
        // "consecutive" is meant literally.
        _ = backoff.recordFailure(isGatewayFailure: false)
        XCTAssertFalse(backoff.isMacLikelyOffline)
        XCTAssertEqual(backoff.consecutiveGatewayFailures, 0)
    }

    func testResetClearsBothCounters() {
        var backoff = noJitter()
        for _ in 0..<ReconnectBackoff.gatewayEscalationThreshold {
            _ = backoff.recordFailure(isGatewayFailure: true)
        }
        backoff.reset()
        XCTAssertEqual(backoff.attempt, 0)
        XCTAssertEqual(backoff.consecutiveGatewayFailures, 0)
        XCTAssertFalse(backoff.isMacLikelyOffline)
        XCTAssertEqual(backoff.recordFailure(isGatewayFailure: false), 1, accuracy: 0.0001)
    }
}
