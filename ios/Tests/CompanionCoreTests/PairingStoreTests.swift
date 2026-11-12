import XCTest
@testable import CompanionCore

final class PairingStoreTests: XCTestCase {
    func testAppGroupConstants() {
        XCTAssertEqual(CompanionAppGroup.suiteName, "group.app.botfleet")
        XCTAssertEqual(CompanionAppGroup.keychainAccessGroup, "CC8UTF7ATG.group.app.botfleet")
    }

    func testURLSchemePrimaryAndLegacy() {
        XCTAssertEqual(CompanionURLScheme.primary, "botfleet-ios")
        XCTAssertEqual(CompanionURLScheme.legacy, "botfleet")
        XCTAssertTrue(CompanionURLScheme.accepts("botfleet-ios"))
        XCTAssertTrue(CompanionURLScheme.accepts("BotFleet"))
        XCTAssertTrue(CompanionURLScheme.accepts("BOTFLEET-IOS"))
        XCTAssertFalse(CompanionURLScheme.accepts("https"))
        XCTAssertFalse(CompanionURLScheme.accepts(nil))
    }

    func testLoadPrefersSharedSuiteOverStandard() throws {
        let suiteName = "PairingStoreTests.shared.\(UUID().uuidString)"
        let standardName = "PairingStoreTests.standard.\(UUID().uuidString)"
        defer {
            UserDefaults().removePersistentDomain(forName: suiteName)
            UserDefaults().removePersistentDomain(forName: standardName)
        }
        let shared = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        let standard = try XCTUnwrap(UserDefaults(suiteName: standardName))
        let sharedData = Data("shared-blob".utf8)
        let standardData = Data("standard-blob".utf8)
        shared.set(sharedData, forKey: CompanionConnectionStore.connectionKey)
        standard.set(standardData, forKey: CompanionConnectionStore.connectionKey)

        let loaded = try XCTUnwrap(
            CompanionConnectionStore.loadConnectionData(shared: shared, standard: standard)
        )
        XCTAssertEqual(loaded.source, .shared)
        XCTAssertEqual(loaded.data, sharedData)
    }

    func testLoadFallsBackToStandardAndPromoteCopiesIntoShared() throws {
        let suiteName = "PairingStoreTests.promote.\(UUID().uuidString)"
        let standardName = "PairingStoreTests.promoteStd.\(UUID().uuidString)"
        defer {
            UserDefaults().removePersistentDomain(forName: suiteName)
            UserDefaults().removePersistentDomain(forName: standardName)
        }
        let shared = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        let standard = try XCTUnwrap(UserDefaults(suiteName: standardName))
        let standardData = Data("only-standard".utf8)
        standard.set(standardData, forKey: CompanionConnectionStore.connectionKey)

        let loaded = try XCTUnwrap(
            CompanionConnectionStore.loadConnectionData(shared: shared, standard: standard)
        )
        XCTAssertEqual(loaded.source, .standard)
        CompanionConnectionStore.promoteStandardToSharedIfNeeded(
            source: loaded.source,
            data: loaded.data,
            shared: shared
        )
        XCTAssertEqual(shared.data(forKey: CompanionConnectionStore.connectionKey), standardData)
    }

    func testSaveWritesBothStoresAndNilClearsBoth() throws {
        let suiteName = "PairingStoreTests.save.\(UUID().uuidString)"
        let standardName = "PairingStoreTests.saveStd.\(UUID().uuidString)"
        defer {
            UserDefaults().removePersistentDomain(forName: suiteName)
            UserDefaults().removePersistentDomain(forName: standardName)
        }
        let shared = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        let standard = try XCTUnwrap(UserDefaults(suiteName: standardName))
        let payload = Data("paired".utf8)
        CompanionConnectionStore.saveConnectionData(payload, shared: shared, standard: standard)
        XCTAssertEqual(shared.data(forKey: CompanionConnectionStore.connectionKey), payload)
        XCTAssertEqual(standard.data(forKey: CompanionConnectionStore.connectionKey), payload)
        CompanionConnectionStore.saveConnectionData(nil, shared: shared, standard: standard)
        XCTAssertNil(shared.data(forKey: CompanionConnectionStore.connectionKey))
        XCTAssertNil(standard.data(forKey: CompanionConnectionStore.connectionKey))
    }

    func testExportCopiesStandardIntoEmptySharedAndDoesNotOverwrite() throws {
        let suiteName = "PairingStoreTests.export.\(UUID().uuidString)"
        let standardName = "PairingStoreTests.exportStd.\(UUID().uuidString)"
        defer {
            UserDefaults().removePersistentDomain(forName: suiteName)
            UserDefaults().removePersistentDomain(forName: standardName)
        }
        let shared = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        let standard = try XCTUnwrap(UserDefaults(suiteName: standardName))
        let legacy = Data("legacy-pairing".utf8)
        standard.set(legacy, forKey: CompanionConnectionStore.connectionKey)

        XCTAssertTrue(
            CompanionConnectionStore.exportLegacyPairingToSharedStorage(shared: shared, standard: standard)
        )
        XCTAssertEqual(shared.data(forKey: CompanionConnectionStore.connectionKey), legacy)

        standard.set(Data("newer-private".utf8), forKey: CompanionConnectionStore.connectionKey)
        XCTAssertFalse(
            CompanionConnectionStore.exportLegacyPairingToSharedStorage(shared: shared, standard: standard)
        )
        XCTAssertEqual(shared.data(forKey: CompanionConnectionStore.connectionKey), legacy)
    }
}
