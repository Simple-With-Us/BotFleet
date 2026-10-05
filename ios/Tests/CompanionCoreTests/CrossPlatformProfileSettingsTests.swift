import XCTest
@testable import CompanionCore

final class CrossPlatformProfileSettingsTests: XCTestCase {
    func testComputerGrantRowsAreReadOnlyOnPhone() {
        let rows = CrossPlatformProfileSettings.computerGrantRows(computers: ["local", "cloud"])
        XCTAssertEqual(rows.count, 3)
        XCTAssertTrue(rows.allSatisfy { !$0.editable })
        XCTAssertEqual(rows.first(where: { $0.id == "local" })?.selected, true)
        XCTAssertEqual(rows.first?.disabledReason, CrossPlatformProfileSettings.computersMacOnlyReason)
    }

    func testSpeechDeviceRowGreysMacForPersonalVoiceOnPhone() {
        let row = CrossPlatformProfileSettings.speechDeviceRow(
            device: "mac",
            voice: "personal:pv-1",
            speakReplies: nil,
            speechDevices: ["mac"],
            agentVoiceCanSpeakOnClient: true,
            personalVoiceSelected: true
        )
        XCTAssertTrue(row.selected)
        XCTAssertFalse(row.editable)
        XCTAssertNotNil(row.disabledReason)
    }
}
