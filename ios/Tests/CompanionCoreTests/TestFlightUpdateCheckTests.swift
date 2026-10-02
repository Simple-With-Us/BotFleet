// The "a newer TestFlight build exists" banner: manifest decoding, the
// comparison against the running build, and the once-an-hour throttle.
// None of this touches the paired Mac, so none of it needs a `Connection` —
// only the manifest shape, captured 2026-09-13 from the real
// https://jaywedgeworth22.github.io/ai-fleet-coordinator/ios-versions.json.
import XCTest
@testable import CompanionCore

final class TestFlightUpdateCheckTests: XCTestCase {
    // MARK: - Manifest decoding

    /// The real published manifest, verbatim, minus unrelated apps. Proves
    /// this app's bundle id (`app.botfleet`) round-trips through the shape
    /// the fleet actually serves, not a shape invented for this test.
    private let realManifestJSON = Data(#"""
    {
      "schemaVersion": 1,
      "updatedAt": "2026-09-04T03:58:13Z",
      "apps": {
        "app.botfleet": {
          "marketingVersion": "1.0.29",
          "build": "202609032050",
          "appleId": 6806379515,
          "displayName": "BotFleet"
        },
        "trade.socratic.app": {
          "displayName": "Socratic.Trade",
          "marketingVersion": "1.0.72",
          "appleId": 6799238379,
          "build": "202608250600"
        }
      }
    }
    """#.utf8)

    func testDecodesThisAppsEntryFromTheRealManifestShape() throws {
        let manifest = try JSONDecoder().decode(VersionManifest.self, from: realManifestJSON)
        let entry = try XCTUnwrap(manifest.apps[TestFlightUpdateCheck.bundleId])
        XCTAssertEqual(entry.marketingVersion, "1.0.29")
        XCTAssertEqual(entry.build, "202609032050")
        XCTAssertEqual(entry.appleId, 6_806_379_515)
    }

    func testAnUnlistedBundleIdOffersNoUpdateRatherThanThrowing() throws {
        let manifest = try JSONDecoder().decode(VersionManifest.self, from: realManifestJSON)
        let running = AppBuildInfo(marketingVersion: "1.0.1", build: "1")
        // Real manifest keyed by a different bundle id than a hypothetical
        // one this test does not run as — exercise the "not found" path
        // directly rather than assuming today's bundle id stays unlisted.
        var noEntry = manifest
        noEntry.apps.removeValue(forKey: TestFlightUpdateCheck.bundleId)
        XCTAssertNil(TestFlightUpdateCheck.availableUpdate(in: noEntry, running: running))
    }

    // MARK: - Comparison

    func testNewerBuildNumberIsAnUpdate() {
        let running = AppBuildInfo(marketingVersion: "1.0.29", build: "202609032050")
        let candidate = AppBuildInfo(marketingVersion: "1.0.30", build: "202609130933")
        XCTAssertTrue(TestFlightUpdateCheck.isNewer(candidate, than: running))
    }

    func testEqualOrOlderBuildIsNotAnUpdate() {
        let running = AppBuildInfo(marketingVersion: "1.0.30", build: "202609130933")
        XCTAssertFalse(TestFlightUpdateCheck.isNewer(running, than: running))
        let older = AppBuildInfo(marketingVersion: "1.0.29", build: "202609032050")
        XCTAssertFalse(TestFlightUpdateCheck.isNewer(older, than: running))
    }

    /// The whole reason the build (not the marketing version) drives the
    /// comparison: a marketing bump to "1.0.9" must not lose to a
    /// numerically-earlier-looking "1.0.30" once builds sort correctly.
    func testMarketingVersionStringOrderDoesNotFoolTheComparison() {
        let running = AppBuildInfo(marketingVersion: "1.0.9", build: "202609010000")
        let candidate = AppBuildInfo(marketingVersion: "1.0.30", build: "202609130000")
        XCTAssertTrue(TestFlightUpdateCheck.isNewer(candidate, than: running))
    }

    func testAvailableUpdateReturnsTheManifestsOfferWhenItIsNewer() throws {
        var manifest = VersionManifest()
        manifest.apps[TestFlightUpdateCheck.bundleId] = VersionManifestEntry(
            marketingVersion: "1.0.31",
            build: "202609140000"
        )
        let running = AppBuildInfo(marketingVersion: "1.0.30", build: "202609130933")
        let available = try XCTUnwrap(TestFlightUpdateCheck.availableUpdate(in: manifest, running: running))
        XCTAssertEqual(available.marketingVersion, "1.0.31")
        XCTAssertEqual(available.build, "202609140000")
    }

    func testAvailableUpdateIsNilWhenRunningIsAlreadyCurrent() {
        var manifest = VersionManifest()
        manifest.apps[TestFlightUpdateCheck.bundleId] = VersionManifestEntry(
            marketingVersion: "1.0.30",
            build: "202609130933"
        )
        let running = AppBuildInfo(marketingVersion: "1.0.30", build: "202609130933")
        XCTAssertNil(TestFlightUpdateCheck.availableUpdate(in: manifest, running: running))
    }

    func testAnEntryMissingBuildOrVersionOffersNoUpdate() {
        var manifest = VersionManifest()
        manifest.apps[TestFlightUpdateCheck.bundleId] = VersionManifestEntry(marketingVersion: "1.0.31", build: nil)
        let running = AppBuildInfo(marketingVersion: "1.0.30", build: "202609130933")
        XCTAssertNil(TestFlightUpdateCheck.availableUpdate(in: manifest, running: running))
    }

    // MARK: - Dismissal survives a relaunch

    func testACandidateMatchingTheRecordedDismissalIsDismissed() {
        XCTAssertTrue(TestFlightUpdateCheck.isDismissed(candidateBuild: "202609130933", dismissedBuild: "202609130933"))
    }

    func testNothingRecordedIsNotDismissed() {
        XCTAssertFalse(TestFlightUpdateCheck.isDismissed(candidateBuild: "202609130933", dismissedBuild: nil))
    }

    /// The point of the whole comparison: a build that supersedes the one
    /// dismissed must reopen the banner rather than inheriting its dismissal.
    func testANewerCandidateThanTheRecordedDismissalIsNotDismissed() {
        XCTAssertFalse(TestFlightUpdateCheck.isDismissed(candidateBuild: "202609140000", dismissedBuild: "202609130933"))
    }

    // MARK: - Throttle

    func testFirstCheckEverIsAlwaysDue() {
        XCTAssertTrue(TestFlightCheckThrottle.isDue(lastCheckedAt: nil))
    }

    func testACheckInsideTheHourIsNotDue() {
        let now = Date()
        let fortyMinutesAgo = now.addingTimeInterval(-40 * 60)
        XCTAssertFalse(TestFlightCheckThrottle.isDue(lastCheckedAt: fortyMinutesAgo, now: now))
    }

    func testACheckPastTheHourIsDueAgain() {
        let now = Date()
        let overAnHourAgo = now.addingTimeInterval(-3_601)
        XCTAssertTrue(TestFlightCheckThrottle.isDue(lastCheckedAt: overAnHourAgo, now: now))
    }

    func testExactlyAtTheIntervalCountsAsDue() {
        let now = Date()
        let exactlyAnHourAgo = now.addingTimeInterval(-3_600)
        XCTAssertTrue(TestFlightCheckThrottle.isDue(lastCheckedAt: exactlyAnHourAgo, now: now))
    }
}
