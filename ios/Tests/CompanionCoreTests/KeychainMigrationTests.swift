import XCTest
@testable import CompanionCore

final class KeychainMigrationTests: XCTestCase {
    private struct Locked: Error {}

    func testCurrentServiceIsTheBotFleetOne() {
        XCTAssertEqual(CompanionTokenService.current, "com.botfleet.companion.token")
    }

    func testLegacyListNamesThePredecessorAndNeverItself() {
        XCTAssertEqual(CompanionTokenService.legacy, ["com.openmausbot.companion.token"])
        XCTAssertFalse(CompanionTokenService.legacy.contains(CompanionTokenService.current))
    }

    func testTokenUnderCurrentServiceIsUsedWithoutLookingFurther() throws {
        var asked: [String] = []
        let resolution = try CompanionTokenMigration.resolve { service in
            asked.append(service)
            return service == CompanionTokenService.current ? "omb_current" : "omb_stale"
        }
        XCTAssertEqual(resolution, .current(token: "omb_current"))
        XCTAssertEqual(asked, [CompanionTokenService.current])
    }

    func testTokenLeftByAnOpenMausBotBuildIsMigrated() throws {
        let resolution = try CompanionTokenMigration.resolve { service in
            service == "com.openmausbot.companion.token" ? "omb_old" : nil
        }
        XCTAssertEqual(
            resolution,
            .migrate(token: "omb_old", fromService: "com.openmausbot.companion.token")
        )
    }

    func testNoTokenAnywhereMeansUnpaired() throws {
        var asked: [String] = []
        let resolution = try CompanionTokenMigration.resolve { service in
            asked.append(service)
            return nil
        }
        XCTAssertEqual(resolution, .unpaired)
        XCTAssertEqual(asked, [CompanionTokenService.current] + CompanionTokenService.legacy)
    }

    func testLockedKeychainIsNotMistakenForUnpaired() {
        XCTAssertThrowsError(try CompanionTokenMigration.resolve { _ in throw Locked() })
    }

    func testFailureReadingAPredecessorAlsoPropagates() {
        // current: no item; legacy: unreadable — that is not "unpaired" either
        XCTAssertThrowsError(try CompanionTokenMigration.resolve { service in
            if service == CompanionTokenService.current { return nil }
            throw Locked()
        })
    }
}
