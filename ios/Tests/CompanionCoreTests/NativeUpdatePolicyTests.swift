import XCTest
@testable import CompanionCore

final class NativeUpdatePolicyTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    func testProbeRetriesOnlyTimeoutsAndOnlyOnce() {
        let timeout = NativeProbeEvidence(failure: .timeout)
        XCTAssertTrue(NativeProbePolicy.shouldRetry(after: timeout, attempt: 1))
        XCTAssertFalse(NativeProbePolicy.shouldRetry(after: timeout, attempt: 2))
        for failure in [NativeProbeFailure.spawn, .signal, .status, .version, .missingExecutable] {
            XCTAssertFalse(
                NativeProbePolicy.shouldRetry(after: NativeProbeEvidence(failure: failure), attempt: 1),
                "\(failure) must not retry"
            )
        }
    }

    func testProbeEvidenceExcerptsAreCapped() {
        let evidence = NativeProbeEvidence(
            failure: .status,
            status: 3,
            spawnError: String(repeating: "e", count: 500),
            output: String(repeating: "o", count: 500)
        )
        XCTAssertEqual(evidence.spawnError?.count, 160)
        XCTAssertEqual(evidence.outputExcerpt.count, 200)
        XCTAssertEqual(evidence.status, 3)
    }

    func testAutoCheckWaitsSixHoursAfterASuccess() {
        var throttle = NativeUpdateThrottle()
        throttle.recordCheck(now: t0, fingerprint: "app-a", failureClass: nil)
        XCTAssertFalse(throttle.shouldAutoCheck(now: t0.addingTimeInterval(5 * 3600), fingerprint: "app-a"))
        XCTAssertTrue(throttle.shouldAutoCheck(now: t0.addingTimeInterval(6 * 3600), fingerprint: "app-a"))
    }

    func testChangedFingerprintBypassesTheThrottle() {
        var throttle = NativeUpdateThrottle()
        throttle.recordCheck(now: t0, fingerprint: "app-a", failureClass: nil)
        XCTAssertTrue(throttle.shouldAutoCheck(now: t0.addingTimeInterval(60), fingerprint: "app-b"))
    }

    func testThreeSameClassFailuresBackOffToTwentyFourHours() {
        var throttle = NativeUpdateThrottle()
        for i in 0..<3 {
            throttle.recordCheck(
                now: t0.addingTimeInterval(TimeInterval(i * 6 * 3600)),
                fingerprint: "app-a",
                failureClass: "feed-5xx"
            )
        }
        let last = t0.addingTimeInterval(12 * 3600)
        XCTAssertFalse(throttle.shouldAutoCheck(now: last.addingTimeInterval(6 * 3600), fingerprint: "app-a"))
        XCTAssertTrue(throttle.shouldAutoCheck(now: last.addingTimeInterval(24 * 3600), fingerprint: "app-a"))
    }

    func testADifferentFailureClassBreaksTheStreak() {
        var throttle = NativeUpdateThrottle()
        throttle.recordCheck(now: t0, fingerprint: "app-a", failureClass: "feed-5xx")
        throttle.recordCheck(now: t0.addingTimeInterval(6 * 3600), fingerprint: "app-a", failureClass: "feed-5xx")
        throttle.recordCheck(now: t0.addingTimeInterval(12 * 3600), fingerprint: "app-a", failureClass: "dns")
        XCTAssertEqual(throttle.failureStreak, 1)
        // Six hours, not twenty-four: the streak never reached three.
        XCTAssertTrue(
            throttle.shouldAutoCheck(now: t0.addingTimeInterval(18 * 3600), fingerprint: "app-a")
        )
    }

    func testSuccessClearsTheStreak() {
        var throttle = NativeUpdateThrottle()
        throttle.recordCheck(now: t0, fingerprint: "app-a", failureClass: "feed-5xx")
        throttle.recordCheck(now: t0.addingTimeInterval(3600), fingerprint: "app-a", failureClass: nil)
        XCTAssertEqual(throttle.failureStreak, 0)
        XCTAssertNil(throttle.lastFailureClass)
    }
}
