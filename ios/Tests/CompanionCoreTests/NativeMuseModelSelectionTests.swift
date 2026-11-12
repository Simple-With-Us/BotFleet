import Foundation
import Testing
@testable import CompanionCore

@Suite("Native Muse ACP model selection")
struct NativeMuseModelSelectionTests {
    private let metaSpark = "muse-model:%5B%22meta%22%2Cnull%2C%22muse-spark-1.2%22%5D"
    private let otherProviderSpark = "muse-model:%5B%22other%22%2Cnull%2C%22muse-spark-1.2%22%5D"
    private let namedProfileSpark = "muse-model:%5B%22meta%22%2C%22contributor%22%2C%22muse-spark-1.2%22%5D"

    @Test("Muse launches the installed ACP adapter without native CLI arguments")
    func museSpawnUsesAdapter() throws {
        let input = TurnInput(threadId: "muse-test", botId: "bot", prompt: "hello")
        let runnerSpec = AcpProcessRunner.buildSpawnSpec(harnessKind: .muse, input: input)
        #expect(runnerSpec.executable == "muse-code-acp")
        #expect(runnerSpec.arguments.isEmpty)

        let overriddenSpec = AcpProcessRunner.buildSpawnSpec(
            harnessKind: .muse,
            executable: "/opt/test/muse-code-acp",
            input: input
        )
        #expect(overriddenSpec.executable == "/opt/test/muse-code-acp")
        #expect(overriddenSpec.arguments.isEmpty)

        let matrixSpec = try #require(EngineMatrixRegistry.buildSpawnSpec(
            for: .muse,
            input: EngineTurnSpawnInput(prompt: "hello", workspacePath: "/tmp/muse")
        ))
        #expect(matrixSpec.executable == "muse-code-acp")
        #expect(matrixSpec.argv.isEmpty)
    }

    @Test("Nil and Muse default sentinel preserve the session startup model")
    func defaultSelectionKeepsStartupModel() throws {
        let reply = sessionReply(options: [metaSpark], current: metaSpark)
        #expect(try AcpProcessRunner.resolveMuseModelSelection(requestedModel: nil, sessionReply: reply) == .keepDefault)
        #expect(try AcpProcessRunner.resolveMuseModelSelection(requestedModel: "", sessionReply: reply) == .keepDefault)
        #expect(try AcpProcessRunner.resolveMuseModelSelection(requestedModel: "muse-default", sessionReply: reply) == .keepDefault)
        #expect(try AcpProcessRunner.resolveMuseModelSelection(
            requestedModel: nil,
            requestedConfigModel: metaSpark,
            sessionReply: reply
        ) == .wireValue(metaSpark))
        #expect(try AcpProcessRunner.resolveMuseModelSelection(
            requestedModel: nil,
            requestedConfigModel: "muse-spark-1.2",
            sessionReply: reply
        ) == .wireValue(metaSpark))
    }

    @Test("Muse sends only an advertised provider-qualified adapter value")
    func qualifiedSelectionMatchesProviderAndProfile() throws {
        let reply = sessionReply(options: [metaSpark, otherProviderSpark], current: metaSpark)
        #expect(try AcpProcessRunner.resolveMuseModelSelection(
            requestedModel: metaSpark,
            sessionReply: reply
        ) == .wireValue(metaSpark))
        #expect(throws: (any Error).self) {
            try AcpProcessRunner.resolveMuseModelSelection(requestedModel: "muse-spark-1.2", sessionReply: reply)
        }
    }

    @Test("Muse rejects ambiguous, unavailable, profile-routed, and conflicting selections")
    func invalidSelectionsFailClosed() throws {
        let ambiguous = sessionReply(options: [metaSpark, otherProviderSpark], current: metaSpark)
        #expect(throws: (any Error).self) {
            try AcpProcessRunner.resolveMuseModelSelection(requestedModel: "muse-spark-1.2", sessionReply: ambiguous)
        }

        let unavailable = sessionReply(options: [metaSpark], current: metaSpark)
        #expect(throws: (any Error).self) {
            try AcpProcessRunner.resolveMuseModelSelection(requestedModel: "unadvertised-model", sessionReply: unavailable)
        }
        #expect(throws: (any Error).self) {
            try AcpProcessRunner.resolveMuseModelSelection(requestedModel: namedProfileSpark, sessionReply: sessionReply(options: [namedProfileSpark], current: namedProfileSpark))
        }
        #expect(throws: (any Error).self) {
            try AcpProcessRunner.resolveMuseModelSelection(
                requestedModel: metaSpark,
                requestedConfigModel: otherProviderSpark,
                sessionReply: ambiguous
            )
        }
        #expect(try AcpProcessRunner.resolveMuseModelSelection(
            requestedModel: nil,
            requestedConfigModel: otherProviderSpark,
            sessionReply: ambiguous
        ) == .wireValue(otherProviderSpark))
    }

    @Test("Muse runner applies the advertised adapter value before prompting")
    func runnerAppliesSelectedModel() async throws {
        let sessionId = "muse-selected-model"
        let sessionReply = #"{"sessionId":"muse-selected-model","configOptions":[{"id":"model","currentValue":"muse-model:%5B%22meta%22%2Cnull%2C%22startup-model%22%5D","options":[{"value":"muse-model:%5B%22meta%22%2Cnull%2C%22muse-spark-1.2%22%5D","name":"Muse Spark 1.2"}]}]}"#
        let appliedReply = #"{"configOptions":[{"id":"model","currentValue":"muse-model:%5B%22meta%22%2Cnull%2C%22muse-spark-1.2%22%5D"}]}"#
        let input = TurnInput(
            threadId: "muse-selected-model-thread",
            botId: "bot-muse",
            prompt: "hello",
            modelId: "muse-spark-1.2",
            configOptions: ["model": "muse-spark-1.2"]
        )
        let fixture = EngineReplayFixture(
            id: "muse-selected-model",
            family: .muse,
            title: "Muse model selection",
            input: input,
            expectedSpawnSpec: AcpProcessRunner.buildSpawnSpec(harnessKind: .muse, input: input),
            steps: [
                .onClientRequest(method: "initialize", replyResultJSON: #"{"protocolVersion":1}"#),
                .onClientRequest(method: "session/new", replyResultJSON: sessionReply),
                .onClientRequest(method: "session/set_config_option", replyResultJSON: appliedReply),
                .onClientRequest(method: "session/prompt", replyResultJSON: #"{"stopReason":"end_turn"}"#)
            ],
            expectedEvents: [
                .sessionStarted(sessionId: sessionId),
                .configUpdated(key: "model", value: metaSpark),
                .completed(stopReason: "end_turn", inputTokens: nil, outputTokens: nil)
            ]
        )

        let result = try await EngineReplayHarness.runFixture(fixture)
        #expect(result.passed)
        let modelRequestLine = try #require(result.recordedClientStdinLines.first { line in
            guard let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
            return object["method"] as? String == "session/set_config_option"
        })
        let requestData = try #require(modelRequestLine.data(using: .utf8))
        let request = try #require(JSONSerialization.jsonObject(with: requestData) as? [String: Any])
        let params = try #require(request["params"] as? [String: Any])
        #expect(params["configId"] as? String == "model")
        #expect(params["value"] as? String == metaSpark)
        let methods = result.recordedClientStdinLines.compactMap { line -> String? in
            guard let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            return object["method"] as? String
        }
        #expect(methods.filter { $0 == "session/set_config_option" }.count == 1)
        let modelRequestIndex = try #require(methods.firstIndex(of: "session/set_config_option"))
        let promptRequestIndex = try #require(methods.firstIndex(of: "session/prompt"))
        #expect(modelRequestIndex < promptRequestIndex)
    }

    @Test("Muse applies config-only model selection once and rejects unavailable values before prompt")
    func configOnlyModelSelection() async throws {
        let sessionId = "muse-config-only-model"
        let sessionReply = #"{"sessionId":"muse-config-only-model","configOptions":[{"id":"model","currentValue":"muse-model:%5B%22meta%22%2Cnull%2C%22startup-model%22%5D","options":[{"value":"muse-model:%5B%22meta%22%2Cnull%2C%22muse-spark-1.2%22%5D","name":"Muse Spark 1.2"}]}]}"#
        let appliedReply = #"{"configOptions":[{"id":"model","currentValue":"muse-model:%5B%22meta%22%2Cnull%2C%22muse-spark-1.2%22%5D"}]}"#
        let input = TurnInput(
            threadId: "muse-config-only-thread",
            botId: "bot-muse",
            prompt: "hello",
            configOptions: ["model": "muse-spark-1.2"]
        )
        let fixture = EngineReplayFixture(
            id: "muse-config-only-model",
            family: .muse,
            title: "Muse config-only model selection",
            input: input,
            expectedSpawnSpec: AcpProcessRunner.buildSpawnSpec(harnessKind: .muse, input: input),
            steps: [
                .onClientRequest(method: "initialize", replyResultJSON: #"{"protocolVersion":1}"#),
                .onClientRequest(method: "session/new", replyResultJSON: sessionReply),
                .onClientRequest(method: "session/set_config_option", replyResultJSON: appliedReply),
                .onClientRequest(method: "session/prompt", replyResultJSON: #"{"stopReason":"end_turn"}"#)
            ],
            expectedEvents: [
                .sessionStarted(sessionId: sessionId),
                .configUpdated(key: "model", value: metaSpark),
                .completed(stopReason: "end_turn", inputTokens: nil, outputTokens: nil)
            ]
        )
        let result = try await EngineReplayHarness.runFixture(fixture)
        #expect(result.passed)
        let methods = result.recordedClientStdinLines.compactMap { line -> String? in
            guard let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            return object["method"] as? String
        }
        #expect(methods.filter { $0 == "session/set_config_option" }.count == 1)
        let modelRequestIndex = try #require(methods.firstIndex(of: "session/set_config_option"))
        let promptRequestIndex = try #require(methods.firstIndex(of: "session/prompt"))
        #expect(modelRequestIndex < promptRequestIndex)

        let rejectedInput = TurnInput(
            threadId: "muse-config-only-rejected-thread",
            botId: "bot-muse",
            prompt: "hello",
            configOptions: ["model": "unadvertised-model"]
        )
        let rejectedFixture = EngineReplayFixture(
            id: "muse-config-only-rejected",
            family: .muse,
            title: "Reject an unadvertised Muse model",
            input: rejectedInput,
            expectedSpawnSpec: AcpProcessRunner.buildSpawnSpec(harnessKind: .muse, input: rejectedInput),
            steps: [
                .onClientRequest(method: "initialize", replyResultJSON: #"{"protocolVersion":1}"#),
                .onClientRequest(method: "session/new", replyResultJSON: sessionReply)
            ],
            expectedEvents: [
                .sessionStarted(sessionId: sessionId),
                .error(code: "unknown_model", message: "Muse does not advertise one unambiguous selectable option for this model")
            ]
        )
        let rejected = try await EngineReplayHarness.runFixture(rejectedFixture)
        #expect(rejected.actualEvents.last == .error(
            code: "unknown_model",
            message: "Muse does not advertise one unambiguous selectable option for this model"
        ))
        let rejectedMethods = rejected.recordedClientStdinLines.compactMap { line -> String? in
            guard let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            return object["method"] as? String
        }
        #expect(!rejectedMethods.contains("session/set_config_option"))
        #expect(!rejectedMethods.contains("session/prompt"))
    }

    private func sessionReply(options: [String], current: String) -> [String: Any] {
        [
            "configOptions": [[
                "id": "model",
                "currentValue": current,
                "options": options.map { ["value": $0, "name": "Spark"] }
            ]]
        ]
    }
}
