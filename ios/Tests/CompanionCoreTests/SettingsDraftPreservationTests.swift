import XCTest
@testable import CompanionCore

final class SettingsDraftPreservationTests: XCTestCase {
    func testTextKeepsDirtyDraftAndAdoptsCleanServer() {
        XCTAssertEqual(
            SettingsDraftPreservation.text(draft: "Alice", previousSaved: "", server: "Server"),
            "Alice",
            "typing before the first seed must survive the load"
        )
        XCTAssertEqual(
            SettingsDraftPreservation.text(draft: "", previousSaved: "", server: "Server"),
            "Server",
            "an untouched draft matching the previous baseline takes the server value"
        )
        XCTAssertEqual(
            SettingsDraftPreservation.text(draft: "Old", previousSaved: "Old", server: "New"),
            "New"
        )
        XCTAssertEqual(
            SettingsDraftPreservation.text(draft: "Edited", previousSaved: "Old", server: "New"),
            "Edited"
        )
    }

    func testTimeoutKeepsDirtyDraftAndAdoptsCleanServer() {
        XCTAssertEqual(
            SettingsDraftPreservation.timeoutMinutes(draft: "12", previousSaved: 5, server: 10),
            "12"
        )
        XCTAssertEqual(
            SettingsDraftPreservation.timeoutMinutes(draft: "5", previousSaved: 5, server: 10),
            "10"
        )
        XCTAssertEqual(
            SettingsDraftPreservation.timeoutMinutes(draft: " 5 ", previousSaved: 5, server: 10),
            "10"
        )
        XCTAssertEqual(
            SettingsDraftPreservation.timeoutMinutes(draft: "abc", previousSaved: 5, server: 10),
            "abc",
            "unparseable drafts stay dirty"
        )
    }
}
