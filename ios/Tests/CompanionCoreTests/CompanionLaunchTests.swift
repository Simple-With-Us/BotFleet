import Foundation
import XCTest
@testable import CompanionCore

final class CompanionLaunchTests: XCTestCase {
    func testMainThreadLaunchLaneStaysSmall() {
        let beforeFirstFrame = CompanionLaunchWork.allCases.filter {
            CompanionLaunchSchedule.lane($0) == .beforeFirstFrame
        }
        XCTAssertEqual(
            beforeFirstFrame,
            [.liveActivityRoute, .notificationDelegate, .sentry]
        )
    }

    func testPairingRestoreStaysOffTheMainThread() {
        XCTAssertEqual(CompanionLaunchSchedule.lane(.pairingBlob), .offMainThread)
        XCTAssertEqual(CompanionLaunchSchedule.lane(.keychainToken), .offMainThread)
        XCTAssertEqual(CompanionLaunchSchedule.lane(.connectionDecode), .offMainThread)
    }

    func testNetworkAndNotificationWorkWaitsUntilAfterTheFirstFrame() {
        let afterFirstFrame = CompanionLaunchWork.allCases.filter {
            CompanionLaunchSchedule.lane($0) == .afterFirstFrame
        }
        XCTAssertEqual(
            afterFirstFrame,
            [
                .notificationCategories,
                .voiceSessionObservers,
                .streamConnect,
                .testFlightCheck,
                .notificationAuthorization,
            ]
        )
    }

    func testAppHangWatchdogStaysAtTwoSeconds() {
        XCTAssertEqual(CompanionLaunchSchedule.appHangTimeoutInterval, 2)
        XCTAssertTrue(CompanionLaunchSchedule.tracksFullyBlockingAppHangs)
    }

    func testUnsettledLaunchDoesNotShowWelcomeOrPairing() {
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .unpaired,
                hasSeenWelcome: false,
                pairingRequested: true,
                hasPendingPairingInvite: true,
                launchRestoreSettled: false
            )),
            .restoring
        )
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .revoked,
                hasSeenWelcome: false,
                launchRestoreSettled: false
            )),
            .restoring
        )
    }

    func testMissingOrUndecodableBlobStaysUnpaired() throws {
        let standardName = suiteName("standard")
        let sharedName = suiteName("shared")
        let standard = try XCTUnwrap(UserDefaults(suiteName: standardName))
        let shared = try XCTUnwrap(UserDefaults(suiteName: sharedName))
        defer { forget(standardName, sharedName) }

        XCTAssertNil(CompanionLaunchRestore.loadDecoded(shared: shared, standard: standard))

        standard.set(Data("not json".utf8), forKey: CompanionConnectionStore.connectionKey)
        XCTAssertNil(CompanionLaunchRestore.loadDecoded(shared: shared, standard: standard))
        XCTAssertEqual(
            CompanionLaunchRestore.decide(saved: nil, token: .token("secret")),
            .unpaired
        )
    }

    func testSavedConnectionDecodesOffTheMainThreadAndExportsToTheAppGroup() async throws {
        let standardName = suiteName("standard")
        let sharedName = suiteName("shared")
        defer { forget(standardName, sharedName) }
        let saved = Connection(
            id: "conn-1",
            name: String(repeating: "BotFleet", count: 1024),
            host: "mac.tail.ts.net",
            port: 8810
        )
        let data = try JSONEncoder().encode(saved)
        let standard = try XCTUnwrap(UserDefaults(suiteName: standardName))
        standard.set(data, forKey: CompanionConnectionStore.connectionKey)

        let loaded = await Task.detached(priority: .userInitiated) { () -> (id: String?, onMain: Bool) in
            let shared = UserDefaults(suiteName: sharedName)
            guard let standard = UserDefaults(suiteName: standardName) else {
                return (nil, Thread.isMainThread)
            }
            let decoded = CompanionLaunchRestore.loadDecoded(shared: shared, standard: standard)
            return (decoded?.connection.id, Thread.isMainThread)
        }.value

        XCTAssertFalse(loaded.onMain)
        XCTAssertEqual(loaded.id, "conn-1")
        let shared = try XCTUnwrap(UserDefaults(suiteName: sharedName))
        XCTAssertNil(
            shared.data(forKey: CompanionConnectionStore.connectionKey),
            "the off-main read must not write the app group"
        )
        CompanionConnectionStore.promoteStandardToSharedIfNeeded(
            source: .standard,
            data: data,
            shared: shared
        )
        XCTAssertEqual(shared.data(forKey: CompanionConnectionStore.connectionKey), data)
    }

    func testUnpairedRestoreDropsAQueuedNotification() {
        let saved = Connection(id: "conn-1", name: "Mac", host: "mac.tail.ts.net", port: 8810)
        XCTAssertFalse(CompanionLaunchRestore.retainsQueuedNotification(.unpaired))
        XCTAssertTrue(
            CompanionLaunchRestore.retainsQueuedNotification(.connect(saved, token: "device-token"))
        )
        XCTAssertTrue(
            CompanionLaunchRestore.retainsQueuedNotification(
                .waitForKeychain(saved, message: CompanionLaunchRestore.keychainLockedMessage)
            )
        )
    }

    func testRestoreDecisionKeepsALockedKeychainDistinctFromNoToken() {
        let saved = Connection(id: "conn-1", name: "Mac", host: "mac.tail.ts.net", port: 8810)
        XCTAssertEqual(
            CompanionLaunchRestore.decide(saved: saved, token: .missing),
            .unpaired
        )
        XCTAssertEqual(
            CompanionLaunchRestore.decide(saved: saved, token: .token("device-token")),
            .connect(saved, token: "device-token")
        )
        XCTAssertEqual(
            CompanionLaunchRestore.decide(
                saved: saved,
                token: .unavailable(isLocked: true, message: "raw keychain text")
            ),
            .waitForKeychain(saved, message: CompanionLaunchRestore.keychainLockedMessage)
        )
        XCTAssertEqual(
            CompanionLaunchRestore.decide(
                saved: saved,
                token: .unavailable(isLocked: false, message: "Couldn't access the pairing securely: status 1")
            ),
            .waitForKeychain(saved, message: "Couldn't access the pairing securely: status 1")
        )
    }

    private func suiteName(_ role: String) -> String {
        "companion.launch.\(role).\(UUID().uuidString)"
    }

    private func forget(_ names: String...) {
        for name in names {
            UserDefaults.standard.removePersistentDomain(forName: name)
            UserDefaults(suiteName: name)?.removePersistentDomain(forName: name)
        }
    }
}
