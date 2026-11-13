import XCTest
@testable import CompanionCore

/// The phone lowers a room word the way `lowerRoomLabels` does on the Mac
/// (shared/terminology.ts, pinned by server/terminology.test.ts), so a custom
/// acronym such as HUB reads the same in Settings on both.
final class RoomTerminologyTests: XCTestCase {
    func testAnOrdinaryWordLosesOnlyItsFirstCapital() {
        XCTAssertEqual(ConfigStatus.loweredRoomWord("Channel"), "channel")
        XCTAssertEqual(ConfigStatus.loweredRoomWord("Project"), "project")
        XCTAssertEqual(ConfigStatus.loweredRoomWord("Team Space"), "team Space")
        XCTAssertEqual(ConfigStatus.loweredRoomWord("A"), "a")
        XCTAssertEqual(ConfigStatus.loweredRoomWord(""), "")
    }

    func testAnAllCapsLabelIsLeftAlone() {
        XCTAssertEqual(ConfigStatus.loweredRoomWord("HUB"), "HUB")
        XCTAssertEqual(ConfigStatus.loweredRoomWord("Q&A"), "Q&A")
    }

    func testTheResolvedLabelFromTheHarnessIsUsedAndTheDefaultIsChannel() throws {
        let hub = try JSONDecoder().decode(
            ConfigStatus.self,
            from: Data(#"{"roomLabels":{"singular":"HUB","plural":"HUBS"}}"#.utf8)
        )
        XCTAssertEqual(hub.roomTerminologyLabelLowered, "HUB")

        let older = try JSONDecoder().decode(ConfigStatus.self, from: Data("{}".utf8))
        XCTAssertEqual(older.roomTerminologyLabelLowered, "channel")
    }
}
