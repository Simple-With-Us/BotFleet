import Foundation
import XCTest
@testable import CompanionCore

/// The Swift half of `Fixtures/bot-voice.json`.  `shared/bot-voice.test.ts`
/// asserts the same cases against the TypeScript rules, so a change to one
/// side that the other does not make fails here or there.
final class BotVoiceTests: XCTestCase {
    private struct Fixture: Decodable {
        struct VoiceCase: Decodable {
            struct PartialBot: Decodable {
                var voice: String?
                var voices: BotVoices?
            }

            var name: String
            var bot: PartialBot
            var device: SpeechDevice
            var expected: String?
        }

        struct PersonalCase: Decodable {
            var id: String?
            var expected: Bool
        }

        struct LabelCase: Decodable {
            struct ListedVoice: Decodable {
                var id: String
                var label: String
            }

            var name: String
            var defaultVoice: String?
            var voices: [ListedVoice]?
            var expected: String
        }

        struct Strings: Decodable {
            var noDefaultVoice: String
            var personalVoiceNotDefault: String
        }

        var voiceForDevice: [VoiceCase]
        var isPersonalVoiceId: [PersonalCase]
        var defaultVoiceOptionLabel: [LabelCase]
        var strings: Strings
    }

    func testTheSharedCopyMatchesTheFixture() throws {
        let strings = try fixture().strings
        XCTAssertEqual(BotVoice.noDefaultVoice, strings.noDefaultVoice)
        XCTAssertEqual(BotVoice.personalVoiceNotDefault, strings.personalVoiceNotDefault)
    }

    private func fixture() throws -> Fixture {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "bot-voice", withExtension: "json", subdirectory: "Fixtures")
                ?? Bundle.module.url(forResource: "bot-voice", withExtension: "json"),
            "missing Fixtures/bot-voice.json"
        )
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func testVoiceForDeviceMatchesTheSharedFixture() throws {
        let cases = try fixture().voiceForDevice
        XCTAssertGreaterThanOrEqual(cases.count, 16)
        for item in cases {
            XCTAssertEqual(
                BotVoice.resolve(voice: item.bot.voice, voices: item.bot.voices, device: item.device),
                item.expected,
                item.name
            )
        }
    }

    func testIsPersonalVoiceIdMatchesTheSharedFixture() throws {
        let cases = try fixture().isPersonalVoiceId
        XCTAssertGreaterThanOrEqual(cases.count, 8)
        for item in cases {
            XCTAssertEqual(BotVoice.isPersonalVoiceId(item.id), item.expected, String(describing: item.id))
        }
    }

    func testDefaultVoiceOptionLabelMatchesTheSharedFixture() throws {
        let cases = try fixture().defaultVoiceOptionLabel
        XCTAssertGreaterThanOrEqual(cases.count, 8)
        for item in cases {
            let voices = item.voices?.map { Voice(id: $0.id, label: $0.label) }
            XCTAssertEqual(BotVoice.defaultOptionLabel(item.defaultVoice, voices: voices), item.expected, item.name)
        }
    }

    private func botJSON(_ extra: String) -> Data {
        Data("""
        {"id":"b1","threadId":"t1","name":"Scout","title":"","description":"","notifications":true,
         "color":"cyan","unread":false,"modelSelection":{"instanceId":"i","model":"m"},"createdAt":1\(extra)}
        """.utf8)
    }

    func testBotDecodesPerDeviceVoicesAndResolvesThem() throws {
        let bot = try JSONDecoder().decode(
            Bot.self,
            from: botJSON(#","voice":"English_Graceful_Lady","voices":{"mac":"personal:mac-1"}"#)
        )
        XCTAssertEqual(bot.voices, BotVoices(mac: "personal:mac-1"))
        XCTAssertEqual(bot.voice(for: .mac), "personal:mac-1")
        XCTAssertEqual(bot.voice(for: .iphone), "English_Graceful_Lady")
    }

    func testBotDecodesWireNullVoicesAndOlderHarnesses() throws {
        let null = try JSONDecoder().decode(Bot.self, from: botJSON(#","voice":"vx","voices":null"#))
        XCTAssertNil(null.voices)
        XCTAssertEqual(null.voice(for: .iphone), "vx")

        let old = try JSONDecoder().decode(Bot.self, from: botJSON(#","voice":"vx""#))
        XCTAssertNil(old.voices)
        XCTAssertEqual(old.voice(for: .mac), "vx")
    }

    func testAMalformedVoicesValueNeverDropsTheBot() throws {
        let odd = try JSONDecoder().decode(Bot.self, from: botJSON(#","voice":"vx","voices":{"mac":7,"iphone":"vy"}"#))
        XCTAssertEqual(odd.voices, BotVoices(iphone: "vy"))
        XCTAssertEqual(odd.voice(for: .mac), "vx")

        let notAnObject = try JSONDecoder().decode(Bot.self, from: botJSON(#","voice":"vx","voices":"mac""#))
        XCTAssertEqual(notAnObject.voice(for: .iphone), "vx")
    }

    // MARK: - Profile PATCH

    private func body(_ patch: BotProfilePatch) throws -> [String: Any] {
        let data = try JSONEncoder().encode(patch)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testVoicesPatchSendsOnlyTheDeviceItChanges() throws {
        let sent = try body(BotProfilePatch(voices: .init(iphone: .set("English_Persuasive_Man"))))
        XCTAssertEqual(sent.keys.sorted(), ["voices"])
        let voices = try XCTUnwrap(sent["voices"] as? [String: Any])
        XCTAssertEqual(voices.keys.sorted(), ["iphone"])
        XCTAssertEqual(voices["iphone"] as? String, "English_Persuasive_Man")
    }

    func testVoicesPatchClearsOneDeviceWithNull() throws {
        let sent = try body(BotProfilePatch(voices: .init(mac: .clear)))
        let voices = try XCTUnwrap(sent["voices"] as? [String: Any])
        XCTAssertEqual(voices.keys.sorted(), ["mac"])
        XCTAssertTrue(voices["mac"] is NSNull)
    }

    func testVoicesPatchNeverSendsATopLevelNull() throws {
        XCTAssertNil(try body(BotProfilePatch(voices: .init()))["voices"])
        XCTAssertNil(try body(BotProfilePatch())["voices"])
    }

    // MARK: - Per-device picker saves

    func testUnchangedPickersSendNothing() {
        XCTAssertEqual(
            BotVoiceEdit.plan(sharedVoice: "vx", voices: BotVoices(mac: "personal:m"), iphone: "vx", mac: "personal:m"),
            BotVoiceEdit()
        )
    }

    func testPickingAnIphoneVoiceSetsOnlyTheIphoneOverride() {
        XCTAssertEqual(
            BotVoiceEdit.plan(sharedVoice: "vx", voices: nil, iphone: "personal:phone", mac: "vx"),
            BotVoiceEdit(voices: .init(iphone: .set("personal:phone")))
        )
    }

    func testPickingTheSharedVoiceAgainClearsTheOverride() {
        XCTAssertEqual(
            BotVoiceEdit.plan(sharedVoice: "vx", voices: BotVoices(mac: "vy"), iphone: "vx", mac: "vx"),
            BotVoiceEdit(voices: .init(mac: .clear))
        )
    }

    func testWorkspaceDefaultWithAnEmptySharedVoiceClearsTheOverride() {
        XCTAssertEqual(
            BotVoiceEdit.plan(sharedVoice: "", voices: BotVoices(iphone: "vy"), iphone: "", mac: ""),
            BotVoiceEdit(voices: .init(iphone: .clear))
        )
    }

    func testWorkspaceDefaultWithASharedVoicePinsTheOtherDevice() {
        // The Mac keeps the voice it already used; the iPhone goes to the
        // workspace default, which an empty override alone cannot express.
        XCTAssertEqual(
            BotVoiceEdit.plan(sharedVoice: "vx", voices: nil, iphone: "", mac: "vx"),
            BotVoiceEdit(voice: "", voices: .init(mac: .set("vx")))
        )
    }

    func testWorkspaceDefaultKeepsAnExistingOverrideOnTheOtherDevice() {
        XCTAssertEqual(
            BotVoiceEdit.plan(sharedVoice: "vx", voices: BotVoices(mac: "personal:m"), iphone: "", mac: "personal:m"),
            BotVoiceEdit(voice: "")
        )
    }

    func testEveryPlanResolvesToWhatThePickersShow() {
        let shared: [String?] = [nil, "", "vx"]
        let stored: [BotVoices?] = [nil, BotVoices(mac: "personal:m"), BotVoices(iphone: "vy"), BotVoices(mac: "vy", iphone: "vz")]
        let choices = ["", "vx", "vy", "personal:p"]
        for s in shared {
            for v in stored {
                for iphone in choices {
                    for mac in choices {
                        let edit = BotVoiceEdit.plan(sharedVoice: s, voices: v, iphone: iphone, mac: mac)
                        var nextShared = s
                        var nextVoices = v ?? BotVoices()
                        if let voice = edit.voice { nextShared = voice }
                        for device in SpeechDevice.allCases {
                            switch edit.voices?[device] {
                            case let .set(id)?: nextVoices[device] = id
                            case .clear?: nextVoices[device] = nil
                            case nil: break
                            }
                        }
                        let label = "shared \(String(describing: s)) stored \(String(describing: v)) -> \(iphone)/\(mac)"
                        XCTAssertEqual(BotVoice.resolve(voice: nextShared, voices: nextVoices, device: .iphone) ?? "", iphone, label)
                        XCTAssertEqual(BotVoice.resolve(voice: nextShared, voices: nextVoices, device: .mac) ?? "", mac, label)
                    }
                }
            }
        }
    }

    // MARK: - A computer that predates per-device voices

    func testRecognizesAnOlderSidecarOrHarnessRefusingVoices() {
        XCTAssertTrue(BotVoiceEdit.isDeviceVoicesUnsupported(
            APIError.status(code: 403, message: "voices can only be changed in BotFleet on your computer")
        ))
        XCTAssertTrue(BotVoiceEdit.isDeviceVoicesUnsupported(
            APIError.status(code: 400, message: "unsupported profile field: voices")
        ))
        // Any other refusal is a real failure, not a reason to retry.
        XCTAssertFalse(BotVoiceEdit.isDeviceVoicesUnsupported(
            APIError.status(code: 403, message: "modelSelection can only be changed in BotFleet on your computer")
        ))
        XCTAssertFalse(BotVoiceEdit.isDeviceVoicesUnsupported(
            APIError.status(code: 400, message: "unsupported profile field: bypassPermissions")
        ))
        XCTAssertFalse(BotVoiceEdit.isDeviceVoicesUnsupported(APIError.status(code: 403, message: nil)))
        XCTAssertFalse(BotVoiceEdit.isDeviceVoicesUnsupported(APIError.transport("offline")))
    }

    func testTheRealRefusalBodiesDecodeToTheRecognizedError() throws {
        // The bodies an older sidecar and an older harness actually send,
        // through the client's own non-2xx decoding.
        let url = try XCTUnwrap(URL(string: "https://preview.tailnet.ts.net:8810/api/bots/b1/profile"))
        let refusals: [(Int, String)] = [
            (403, #"{"error":"voices can only be changed in BotFleet on your computer"}"#),
            (400, #"{"error":"unsupported profile field: voices"}"#),
        ]
        for (status, body) in refusals {
            let response = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil))
            XCTAssertThrowsError(try CompanionClient.check(response, Data(body.utf8))) { error in
                XCTAssertTrue(BotVoiceEdit.isDeviceVoicesUnsupported(error), "\(status) \(body)")
            }
        }
    }

    func testTheFallbackSavesTheIphoneChoiceAsTheSharedVoice() {
        // What this app wrote before per-device voices: the iPhone's pick.
        XCTAssertEqual(BotVoiceEdit.sharedVoiceFallback(sharedVoice: "va", voices: nil, iphone: "vb", mac: "va"), "vb")
        XCTAssertEqual(BotVoiceEdit.sharedVoiceFallback(sharedVoice: "va", voices: nil, iphone: "vb", mac: "vc"), "vb")
        // Only the Mac changed: the one shared voice becomes the Mac's pick.
        XCTAssertEqual(BotVoiceEdit.sharedVoiceFallback(sharedVoice: "va", voices: nil, iphone: "va", mac: "vc"), "vc")
        // Workspace default is the empty voice, as before.
        XCTAssertEqual(BotVoiceEdit.sharedVoiceFallback(sharedVoice: "va", voices: nil, iphone: "", mac: "va"), "")
        // Nothing changed: no voice in the fallback either.
        XCTAssertNil(BotVoiceEdit.sharedVoiceFallback(sharedVoice: "va", voices: BotVoices(mac: "vm"), iphone: "va", mac: "vm"))
    }
}
