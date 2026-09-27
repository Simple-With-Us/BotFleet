import XCTest
@testable import CompanionCore

final class ProfileRoutinePolicyTests: XCTestCase {
    func testOnlyFutureOneTimeRoutinesCanToggle() {
        let now = Date(timeIntervalSince1970: 2_000)

        XCTAssertTrue(routine(schedule: .daily(time: "09:00", weekdays: [1])).canToggle(at: now))
        XCTAssertTrue(routine(schedule: .once(at: now.addingTimeInterval(1))).canToggle(at: now))
        XCTAssertFalse(routine(schedule: .once(at: now)).canToggle(at: now))
        XCTAssertFalse(routine(schedule: .once(at: now.addingTimeInterval(-1))).canToggle(at: now))
        XCTAssertFalse(
            routine(schedule: .init(type: .unknown, at: now.addingTimeInterval(1).timeIntervalSince1970 * 1_000))
                .canToggle(at: now),
            "an unsupported kind stays non-toggleable even when it happens to carry a future at field"
        )
    }

    func testCloudRunAvailabilityMatchesDesktopRequirements() throws {
        let configured = try decodeConfig(#"{"box":{"configured":true}}"#)
        let unconfigured = try decodeConfig(#"{"box":{"configured":false}}"#)
        let available = try decodeInstances(state: "available")
        let unavailable = try decodeInstances(state: "unavailable")

        XCTAssertFalse(RoutineRunAvailability(config: unconfigured, instances: available).cloudReady)
        XCTAssertFalse(RoutineRunAvailability(config: configured, instances: unavailable).cloudReady)

        let ready = RoutineRunAvailability(config: configured, instances: available)
        XCTAssertTrue(ready.cloudReady)
        XCTAssertTrue(ready.canSelect(.cloud, preserving: .bot))

        let offline = RoutineRunAvailability(config: configured, instances: unavailable)
        XCTAssertFalse(offline.canSelect(.cloud, preserving: .bot))
        XCTAssertTrue(offline.canSelect(.cloud, preserving: .cloud), "an existing cloud routine must not silently move")
        XCTAssertTrue(offline.canSelect(.bot, preserving: .cloud))
    }

    func testEngineStatusLabelKeepsAmbiguousProbeFailuresUnavailable() {
        func label(_ state: String, _ reason: String? = nil, authenticated: Bool? = nil) -> String {
            ProviderSnapshot(state: state, reason: reason, authenticated: authenticated, version: nil).engineStatusLabel
        }
        XCTAssertEqual(label("available"), "Ready")
        XCTAssertEqual(label("available", authenticated: false), "Sign in")
        // Claude/Codex reuse "CLI not found" for timeout / nonzero exit too —
        // that text alone cannot mean "Not installed".
        XCTAssertEqual(label("unavailable", "`claude` CLI not found"), "Unavailable")
        XCTAssertEqual(label("unavailable", "no API key — set MINIMAX_API_KEY or add it to the instance config"), "Unavailable")
        XCTAssertEqual(label("unavailable", "Update Claude Code to 2.0 or newer"), "Unavailable")
        XCTAssertEqual(label("unavailable", "provider probe exploded"), "Unavailable")
        XCTAssertEqual(label("unavailable", "Disabled in settings"), "Unavailable")
        XCTAssertEqual(label("unavailable"), "Unavailable", "no reason is not proof the binary is missing")
        XCTAssertFalse(
            ProviderSnapshot(state: "unavailable", reason: "`claude` CLI not found", authenticated: nil, version: nil).isMissingBinary,
            "no structured missing-binary signal yet"
        )
    }

    func testAgentVoiceWorksWithoutANonexistentWorkspaceDefault() throws {
        let keyOnly = try decodeConfig(#"{"tts":{"configured":true,"ready":false,"voice":""}}"#)
        XCTAssertTrue(keyOnly.isTTSConfigured)
        XCTAssertFalse(keyOnly.hasWorkspaceDefaultVoice)
        XCTAssertFalse(keyOnly.canSpeak(agentVoice: nil))
        XCTAssertTrue(keyOnly.canSpeak(agentVoice: "agent-voice"))

        let withDefault = try decodeConfig(#"{"tts":{"configured":true,"ready":true,"voice":"workspace-voice"}}"#)
        XCTAssertTrue(withDefault.hasWorkspaceDefaultVoice)
        XCTAssertTrue(withDefault.canSpeak(agentVoice: nil))
    }

    func testVoiceProviderClassificationMatchesServerDefault() throws {
        XCTAssertEqual(try decodeConfig(#"{"tts":{"configured":false,"provider":"system"}}"#).voiceProvider, .system)
        XCTAssertEqual(try decodeConfig(#"{"tts":{"configured":true,"provider":"elevenlabs"}}"#).voiceProvider, .elevenlabs)
        XCTAssertEqual(try decodeConfig(#"{"tts":{"configured":false,"provider":"minimax"}}"#).voiceProvider, .minimax)
        XCTAssertEqual(
            try decodeConfig(#"{"tts":{"configured":true,"ready":true,"voice":"v"}}"#).voiceProvider, .minimax,
            "a missing provider uses the server's MiniMax default"
        )
        XCTAssertEqual(
            try decodeConfig("{}").voiceProvider, .minimax,
            "a missing voice block also uses the server's MiniMax default"
        )
        XCTAssertEqual(
            try decodeConfig(#"{"tts":{"configured":false,"provider":"cartesia"}}"#).voiceProvider, .unknown,
            "a future provider must not borrow MiniMax or ElevenLabs setup copy"
        )
        XCTAssertEqual(
            try decodeConfig(#"{"tts":{"configured":false,"provider":"System"}}"#).voiceProvider, .unknown,
            "provider matching follows the server's exact wire values"
        )

        XCTAssertTrue(try decodeConfig(#"{"tts":{"configured":true,"provider":"system","voice":"Albert"}}"#).canSpeak(agentVoice: nil))
        XCTAssertFalse(try decodeConfig(#"{"tts":{"configured":false,"provider":"system","voice":"Albert"}}"#).canSpeak(agentVoice: nil))
    }

    private func routine(schedule: RoutineSchedule) -> Routine {
        Routine(
            id: "routine-1",
            name: "Brief",
            prompt: "Summarize",
            botId: "bot-1",
            runOn: "bot",
            enabled: false,
            schedule: schedule,
            durationMinutes: 30,
            nextRunAt: nil,
            createdAt: 1,
            updatedAt: 1
        )
    }

    private func decodeConfig(_ json: String) throws -> ConfigStatus {
        try JSONDecoder().decode(ConfigStatus.self, from: Data(json.utf8))
    }

    private func decodeInstances(state: String) throws -> [Instance] {
        let json = """
        {"instances":[{
          "instanceId":"box-1","driverKind":"boxAgent",
          "snapshot":{"state":"\(state)"},
          "models":{"default":"model-1","options":[]}
        }]}
        """
        return try JSONDecoder().decode(InstanceList.self, from: Data(json.utf8)).instances
    }
}
