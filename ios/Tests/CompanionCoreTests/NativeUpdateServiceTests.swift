import XCTest
@testable import CompanionCore

@MainActor
final class NativeUpdateServiceTests: XCTestCase {
    private let key = Data(repeating: 7, count: 32).base64EncodedString()
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    func testMissingOrUnsafeReleaseMetadataIsRejected() throws {
        for feed in [nil, "", "$(UNRESOLVED)", "http://updates.invalid/appcast.xml", "https://user:token@updates.invalid/appcast.xml", "https://updates.invalid/appcast.xml#fragment"] {
            XCTAssertThrowsError(try NativeUpdateConfiguration(feedURL: feed, publicKey: key))
        }
        for badKey in [nil, "", "$(UNRESOLVED)", "not-base64", Data(repeating: 7, count: 31).base64EncodedString(), key + "\n"] {
            XCTAssertThrowsError(try NativeUpdateConfiguration(feedURL: "https://updates.invalid/appcast.xml", publicKey: badKey))
        }
        let configuration = try NativeUpdateConfiguration(feedURL: "https://updates.invalid/appcast.xml", publicKey: key)
        XCTAssertEqual(configuration.feedURL.scheme, "https")
        XCTAssertEqual(configuration.publicKey, key)
    }

    func testUnavailableConfigurationNeverConstructsOrStartsDriver() {
        var created = false
        let service = NativeUpdateService(configuration: nil, store: MemoryStore(), fingerprint: { "bundle" }) { _ in
            created = true; return Driver()
        }
        service.start(); service.checkForUpdates(); service.setAutomaticChecksEnabled(true)
        XCTAssertFalse(created)
        XCTAssertEqual(service.state, .unavailable)
        XCTAssertFalse(service.canCheckForUpdates)
    }

    func testFailedStartCanRetrySameDriverWithoutRetainingAnActiveCheck() throws {
        let driver = Driver(); driver.startFails = true
        let service = try make(driver)
        driver.onStart = { XCTAssertTrue(driver.begin(automatic: true)) }
        service.start(); service.checkForUpdates()
        driver.onEvent?(.availabilityChanged(true))
        XCTAssertEqual(driver.starts, 1)
        XCTAssertEqual(driver.manualRequests, 0)
        XCTAssertEqual(service.state, .failed)
        XCTAssertFalse(service.canCheckForUpdates)
        driver.startFails = false; driver.onStart = nil
        service.start(); service.start()
        XCTAssertEqual(driver.starts, 2)
        XCTAssertEqual(service.state, .idle)
        XCTAssertTrue(service.canCheckForUpdates)
        service.checkForUpdates()
        XCTAssertEqual(driver.manualRequests, 1)
        XCTAssertEqual(service.state, .checking)
    }

    func testUnstartedAndFailedStartupIgnoreSpuriousProgressAndCancellation() throws {
        let driver = Driver(), service = try make(driver)
        let events: [NativeUpdateEvent] = [.availabilityChanged(true), .found(version: "0.1.0"),
            .downloading(version: "0.1.0"), .downloaded(version: "0.1.0"), .downloadCancelled,
            .finished(failureClass: nil)]
        for event in events {
            driver.onEvent?(event)
            XCTAssertEqual(service.state, .unavailable)
            XCTAssertFalse(service.canCheckForUpdates)
        }
        driver.startFails = true
        service.start()
        for event in events {
            driver.onEvent?(event)
            XCTAssertEqual(service.state, .failed)
            XCTAssertFalse(service.canCheckForUpdates)
        }
        XCTAssertFalse(driver.begin(automatic: true))
        XCTAssertFalse(driver.begin(automatic: false))
        XCTAssertEqual(service.state, .failed)
    }

    func testSynchronousStartupAdmissionPreservesReentrantAndBusyGuards() throws {
        let driver = Driver(), service = try make(driver)
        driver.onStart = { [weak service] in
            service?.start()
            XCTAssertTrue(driver.begin(automatic: true))
            XCTAssertFalse(driver.begin(automatic: true))
            driver.onEvent?(.found(version: "0.1.0"))
        }
        service.start()
        XCTAssertEqual(driver.starts, 1)
        XCTAssertEqual(driver.launchRequests, 0)
        XCTAssertEqual(service.state, .available("0.1.0"))
        driver.onEvent?(.finished(failureClass: nil))
        service.checkForUpdates()
        XCTAssertEqual(service.state, .checking)
    }

    func testInitializedDriverProgressDoesNotRequireAnActiveAdmission() throws {
        let driver = Driver(), service = try make(driver)
        service.start()
        driver.onEvent?(.found(version: "0.1.0"))
        XCTAssertEqual(service.state, .available("0.1.0"))
        driver.onEvent?(.downloading(version: "0.1.0"))
        XCTAssertEqual(service.state, .downloading("0.1.0"))
        driver.onEvent?(.downloaded(version: "0.1.0"))
        XCTAssertEqual(service.state, .downloaded("0.1.0"))
        driver.onEvent?(.downloadCancelled)
        XCTAssertEqual(service.state, .idle)
    }

    func testAutomaticCheckRespectsPreferenceAndManualBypassesThrottle() throws {
        let driver = Driver(); let clock = Clock(t0)
        let service = try make(driver, clock: clock)
        service.start()
        XCTAssertTrue(driver.begin(automatic: true))
        driver.onEvent?(.finished(failureClass: nil))
        clock.date.addTimeInterval(60)
        XCTAssertFalse(driver.begin(automatic: true))
        service.checkForUpdates()
        XCTAssertEqual(driver.manualRequests, 1)
        XCTAssertEqual(service.state, .checking)
        driver.onEvent?(.finished(failureClass: nil))
        service.setAutomaticChecksEnabled(false)
        clock.date.addTimeInterval(24 * 3600)
        XCTAssertFalse(driver.begin(automatic: true))
        XCTAssertFalse(service.automaticChecksEnabled)
        service.checkForUpdates()
        XCTAssertEqual(driver.manualRequests, 2)
    }

    func testRestartClearsThreeFailureBackoffButPreservesAutomaticClock() throws {
        let driver = Driver(), store = MemoryStore(), clock = Clock(t0)
        let service = try make(driver, store: store, clock: clock)
        service.start()
        for _ in 0..<3 {
            XCTAssertTrue(driver.begin(automatic: true))
            driver.onEvent?(.finished(failureClass: "feed"))
            if driver.checkInterval != NativeUpdateThrottle.failureBackoff {
                clock.date.addTimeInterval(6 * 3600)
            }
        }
        XCTAssertEqual(service.state, .failed)
        XCTAssertEqual(driver.checkInterval, NativeUpdateThrottle.failureBackoff)
        service.start()
        XCTAssertEqual(driver.checkInterval, NativeUpdateThrottle.failureBackoff)
        clock.date.addTimeInterval(3600)
        let restartedDriver = Driver()
        let restarted = try make(restartedDriver, store: store, clock: clock)
        restarted.start()
        XCTAssertEqual(restartedDriver.checkInterval, NativeUpdateThrottle.autoCheckInterval)
        XCTAssertEqual(restartedDriver.launchRequests, 0)
        XCTAssertFalse(restartedDriver.begin(automatic: true))
        // A refused scheduler cycle cannot reset the last genuine attempt.
        restartedDriver.onEvent?(.finished(failureClass: "policy-refusal"))
        clock.date = t0.addingTimeInterval(18 * 3600)
        XCTAssertTrue(restartedDriver.begin(automatic: true))
        restartedDriver.onEvent?(.finished(failureClass: nil))
        XCTAssertEqual(restartedDriver.checkInterval, NativeUpdateThrottle.autoCheckInterval)
    }

    func testFailureClassChangeAndBundleChangeDoNotRemainStuckInBackoff() throws {
        let driver = Driver(), clock = Clock(t0)
        var bundle = "a"
        let configuration = try NativeUpdateConfiguration(feedURL: "https://updates.invalid/appcast.xml", publicKey: key)
        let service = NativeUpdateService(configuration: configuration, store: MemoryStore(), now: { clock.date }, fingerprint: { bundle }) { _ in driver }
        service.start()
        for failure in ["feed", "feed", "network"] {
            XCTAssertTrue(driver.begin(automatic: true))
            driver.onEvent?(.finished(failureClass: failure))
            clock.date.addTimeInterval(6 * 3600)
        }
        XCTAssertEqual(driver.checkInterval, NativeUpdateThrottle.autoCheckInterval)
        XCTAssertTrue(driver.begin(automatic: true)); driver.onEvent?(.finished(failureClass: nil))
        bundle = "b"
        XCTAssertTrue(driver.begin(automatic: true))
    }

    func testManualFailureClearsBackoffWithoutMovingAutomaticClock() throws {
        let driver = Driver(), clock = Clock(t0), store = MemoryStore()
        let service = try make(driver, store: store, clock: clock)
        service.start()
        for _ in 0..<3 {
            XCTAssertTrue(driver.begin(automatic: true))
            driver.onEvent?(.finished(failureClass: "feed"))
            clock.date.addTimeInterval(6 * 3600)
        }
        service.checkForUpdates()
        driver.onEvent?(.finished(failureClass: "network"))
        XCTAssertEqual(driver.checkInterval, NativeUpdateThrottle.autoCheckInterval)
        let saved = try JSONDecoder().decode(NativeUpdateThrottle.self, from: XCTUnwrap(store.data))
        XCTAssertEqual(saved.lastCheck, t0.addingTimeInterval(12 * 3600))
        XCTAssertEqual(saved.failureStreak, 0)
        XCTAssertTrue(driver.begin(automatic: true))
        XCTAssertFalse(driver.begin(automatic: false))
    }

    func testAvailabilityAndDownloadEventsReachPublishedState() throws {
        let driver = Driver(); let service = try make(driver)
        service.start()
        driver.onEvent?(.availabilityChanged(false))
        service.checkForUpdates()
        XCTAssertEqual(driver.manualRequests, 0)
        driver.onEvent?(.availabilityChanged(true))
        XCTAssertTrue(driver.begin(automatic: false))
        driver.onEvent?(.found(version: "0.1.0")); XCTAssertEqual(service.state, .available("0.1.0"))
        driver.onEvent?(.downloading(version: "0.1.0")); XCTAssertEqual(service.state, .downloading("0.1.0"))
        driver.onEvent?(.downloaded(version: "0.1.0")); XCTAssertEqual(service.state, .downloaded("0.1.0"))
        driver.onEvent?(.finished(failureClass: nil)); XCTAssertEqual(service.state, .downloaded("0.1.0"))
    }

    func testCorruptStoredPolicyDoesNotDisableManualChecks() throws {
        let driver = Driver(), store = MemoryStore(); store.data = Data("invalid".utf8)
        let service = try make(driver, store: store)
        service.start(); service.checkForUpdates()
        XCTAssertEqual(driver.manualRequests, 1)
    }

    func testLegacyExtremeFailureCountsCannotPoisonClockOrManualRecovery() throws {
        for count in [Int.max, -1] {
            var previous = NativeUpdateThrottle()
            previous.recordCheck(now: t0, fingerprint: "bundle", failureClass: "feed")
            let encoded = try JSONEncoder().encode(previous)
            var legacy = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
            legacy["failureStreak"] = count
            legacy["lastFailureClass"] = "feed"
            let store = MemoryStore(); store.data = try JSONSerialization.data(withJSONObject: legacy)
            let driver = Driver(), clock = Clock(t0.addingTimeInterval(3600))
            let service = try make(driver, store: store, clock: clock)
            service.start()
            XCTAssertEqual(driver.checkInterval, NativeUpdateThrottle.autoCheckInterval)
            XCTAssertFalse(driver.begin(automatic: true))
            service.checkForUpdates()
            XCTAssertEqual(driver.manualRequests, 1)
            driver.onEvent?(.finished(failureClass: nil))
            clock.date = t0.addingTimeInterval(6 * 3600)
            XCTAssertTrue(driver.begin(automatic: true))
            driver.onEvent?(.finished(failureClass: "feed"))
            let saved = try JSONDecoder().decode(NativeUpdateThrottle.self, from: XCTUnwrap(store.data))
            XCTAssertEqual(saved.lastCheck, clock.date)
            XCTAssertEqual(saved.bundleFingerprint, "bundle")
            XCTAssertEqual(saved.failureStreak, 0)
            XCTAssertNil(saved.lastFailureClass)
        }
    }

    func testCancelledDownloadDoesNotLeaveProgressVisible() throws {
        let driver = Driver(); let service = try make(driver)
        service.start()
        XCTAssertTrue(driver.begin(automatic: false))
        driver.onEvent?(.downloading(version: "0.1.0"))
        driver.onEvent?(.downloadCancelled)
        driver.onEvent?(.finished(failureClass: nil))
        XCTAssertEqual(service.state, .idle)
        service.checkForUpdates()
        XCTAssertEqual(driver.manualRequests, 1)
    }

    func testLaunchCheckHonorsRecentBundleAndPreferenceButChecksChangedBundle() throws {
        let store = MemoryStore(), clock = Clock(t0), firstDriver = Driver()
        let first = try make(firstDriver, store: store, clock: clock)
        first.start()
        XCTAssertEqual(firstDriver.launchRequests, 1)
        XCTAssertTrue(firstDriver.begin(automatic: true))
        firstDriver.onEvent?(.finished(failureClass: nil))
        clock.date.addTimeInterval(60)
        let sameDriver = Driver()
        let same = try make(sameDriver, store: store, clock: clock)
        same.start()
        XCTAssertEqual(sameDriver.launchRequests, 0)
        let configuration = try NativeUpdateConfiguration(feedURL: "https://updates.invalid/appcast.xml", publicKey: key)
        let changedDriver = Driver()
        let changed = NativeUpdateService(configuration: configuration, store: store, now: { clock.date }, fingerprint: { "replaced-bundle" }) { _ in changedDriver }
        changed.start()
        XCTAssertEqual(changedDriver.launchRequests, 1)
        let disabledDriver = Driver(); disabledDriver.automaticChecksEnabled = false
        let disabled = NativeUpdateService(configuration: configuration, store: store, now: { clock.date }, fingerprint: { "replaced-bundle" }) { _ in disabledDriver }
        disabled.start()
        XCTAssertEqual(disabledDriver.launchRequests, 0)
    }

    private func make(_ driver: Driver, store: MemoryStore? = nil, clock: Clock? = nil) throws -> NativeUpdateService {
        let clock = clock ?? Clock(t0)
        let configuration = try NativeUpdateConfiguration(feedURL: "https://updates.invalid/appcast.xml", publicKey: key)
        return NativeUpdateService(configuration: configuration, store: store ?? MemoryStore(), now: { clock.date }, fingerprint: { "bundle" }) { _ in driver }
    }

    private final class Clock { var date: Date; init(_ date: Date) { self.date = date } }
    private final class MemoryStore: NativeUpdateStateStore {
        var data: Data?
        func load() -> Data? { data }
        func save(_ data: Data) { self.data = data }
    }
    private final class Driver: NativeUpdateDriver {
        var canCheckForUpdates = true
        var automaticChecksEnabled = true
        var checkInterval: TimeInterval = 86400
        var onEvent: ((NativeUpdateEvent) -> Void)?
        var mayPerformCheck: ((Bool) -> Bool)?
        var starts = 0, manualRequests = 0, launchRequests = 0
        var startFails = false
        var onStart: (() -> Void)?
        func start() throws {
            starts += 1; onStart?()
            if startFails { throw NSError(domain: "fixture", code: 1) }
        }
        func checkForUpdates() { manualRequests += 1; _ = begin(automatic: false) }
        func checkForUpdatesOnLaunch() { launchRequests += 1 }
        func begin(automatic: Bool) -> Bool { mayPerformCheck?(automatic) ?? false }
    }
}
