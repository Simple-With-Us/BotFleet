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

    func testEffectiveSpeechDevicesFiltersUnknownIds() {
        let devices = CrossPlatformProfileSettings.effectiveSpeechDevices(
            speakReplies: nil,
            speechDevices: ["mac", "watch", "iphone"]
        )
        XCTAssertEqual(devices, Set(["mac", "iphone"]))
    }

    func testEffectiveSpeechDevicesTreatsExplicitEmptyAsOff() {
        let devices = CrossPlatformProfileSettings.effectiveSpeechDevices(
            speakReplies: true,
            speechDevices: []
        )
        XCTAssertEqual(devices, [])
    }

    func testSpeechDeviceRowKeepsMacPlaybackEditableForPersonalVoiceOnPhone() {
        let row = CrossPlatformProfileSettings.speechDeviceRow(
            device: "mac",
            voice: "personal:pv-1",
            speechDevices: ["mac"],
            agentVoiceCanSpeakOnClient: true,
            personalVoicePlaybackAllowed: true
        )
        XCTAssertTrue(row.selected)
        XCTAssertTrue(row.editable)
        XCTAssertNil(row.disabledReason)
    }

    func testSpeechDeviceRowGreysMacWhenPersonalVoiceNotAllowedOnComputer() {
        let row = CrossPlatformProfileSettings.speechDeviceRow(
            device: "mac",
            voice: "personal:pv-1",
            speechDevices: ["mac"],
            agentVoiceCanSpeakOnClient: true,
            personalVoicePlaybackAllowed: false
        )
        XCTAssertFalse(row.editable)
        XCTAssertNotNil(row.disabledReason)
    }
}
