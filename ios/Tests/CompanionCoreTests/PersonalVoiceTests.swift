import XCTest
@testable import CompanionCore

final class PersonalVoiceTests: XCTestCase {
    func testPersonalVoiceIdentifierFormatting() {
        XCTAssertTrue(PersonalVoiceContract.isPersonalVoice("personal:com.apple.voice.jay"))
        XCTAssertTrue(PersonalVoiceContract.isPersonalVoice("apple-personal:com.apple.voice.jay"))
        XCTAssertFalse(PersonalVoiceContract.isPersonalVoice("com.apple.voice.albert"))
        XCTAssertFalse(PersonalVoiceContract.isPersonalVoice(""))
        XCTAssertFalse(PersonalVoiceContract.isPersonalVoice(nil))

        XCTAssertEqual(
            PersonalVoiceContract.formattedIdentifier("com.apple.voice.jay"),
            "personal:com.apple.voice.jay"
        )
        XCTAssertEqual(
            PersonalVoiceContract.formattedIdentifier("personal:com.apple.voice.jay"),
            "personal:com.apple.voice.jay"
        )
        XCTAssertEqual(
            PersonalVoiceContract.rawIdentifier("personal:com.apple.voice.jay"),
            "com.apple.voice.jay"
        )
        XCTAssertEqual(
            PersonalVoiceContract.rawIdentifier("apple-personal:com.apple.voice.jay"),
            "com.apple.voice.jay"
        )
        XCTAssertEqual(
            PersonalVoiceContract.rawIdentifier("com.apple.voice.albert"),
            "com.apple.voice.albert"
        )
    }

    func testCanSpeakWithPersonalVoiceWithoutCloudTTS() throws {
        // Even when tts is not configured on the Mac server, an agent with Personal Voice can speak on-device!
        let unconfigured = try JSONDecoder().decode(ConfigStatus.self, from: Data(#"{"tts":{"configured":false}}"#.utf8))
        XCTAssertFalse(unconfigured.canSpeak(agentVoice: nil))
        XCTAssertFalse(unconfigured.canSpeak(agentVoice: "albert"))
        XCTAssertTrue(unconfigured.canSpeak(agentVoice: "personal:com.apple.voice.jay"))
        XCTAssertTrue(unconfigured.canSpeak(agentVoice: "apple-personal:com.apple.voice.jay"))
    }

    func testVoiceProviderClassificationIncludesPersonal() throws {
        let personalConfig = try JSONDecoder().decode(ConfigStatus.self, from: Data(#"{"tts":{"configured":true,"provider":"personal"}}"#.utf8))
        XCTAssertEqual(personalConfig.voiceProvider, .personal)
    }

    func testVoiceStructSupportsPersonalVoiceTrait() {
        let standard = Voice(id: "albert", label: "Albert", description: "en-US")
        XCTAssertNil(standard.isPersonalVoice)

        let personal = Voice(id: "personal:jay", label: "Jay's Voice", description: "Apple Personal Voice", isPersonalVoice: true)
        XCTAssertEqual(personal.isPersonalVoice, true)
    }
}
