import Foundation
import Testing
@testable import CompanionCore

@Suite("Upstream Native Engine Protocol Regressions")
struct UpstreamNativeEngineProtocolTests {
    @Test("Codex does not replay after a tool action precedes a transient turn/start error")
    func codexEarlyToolDoesNotRetryOrFallback() async throws {
        let fixture = EngineReplayHarness.codexEarlyToolBeforeTurnStartErrorFixture()
        let replay = try await EngineReplayHarness.runFixture(fixture)
        #expect(replay.passed)
        #expect(replay.actualEvents.filter { event in
            if case .toolCall = event { return true }
            return false
        }.count == 1)

        let launcher = ScriptedProcessLauncher(fixture: fixture)
        let codex = CodexAppServerRunner(launcher: launcher)
        let fallback = CountingCompletedDriver()
        let dispatcher = TurnDispatcherActor(stallTimeoutSeconds: 5, maxRetriesPerEngine: 1, retryDelaySeconds: 0)
        let stream = try await dispatcher.dispatchTurn(input: fixture.input, fallbackChain: [codex, fallback])
        var events: [TurnEvent] = []
        for await event in stream { events.append(event) }

        let fallbackCalls = await fallback.callCount
        let requests = try rpcRequests(await launcher.getCapturedStdinLines())
        #expect(fallbackCalls == 0)
        #expect(requests.filter { $0.method == "turn/start" }.count == 1)
        #expect(events.filter { event in
            if case .toolCall = event { return true }
            return false
        }.count == 1)
        #expect(events.last == .error(code: "rate_limited", message: "HTTP 429 rate limit exceeded"))
    }

    @Test("Grok chooses cached_token before grok.com and uses grok.com only as fallback")
    func grokAuthMethodPriority() async throws {
        let preferred = try await EngineReplayHarness.runFixture(EngineReplayHarness.grokAuthPriorityFixture())
        #expect(preferred.passed)
        let preferredRequests = try rpcRequests(preferred.recordedClientStdinLines)
        #expect(preferredRequests.map(\.method) == ["initialize", "authenticate", "session/new", "session/prompt"])
        let preferredAuth = preferredRequests.first(where: { $0.method == "authenticate" })?.params
        #expect(preferredAuth?.count == 1)
        #expect(preferredAuth?["methodId"] as? String == "cached_token")

        let fallback = try await EngineReplayHarness.runFixture(EngineReplayHarness.grokAuthMethodFallbackFixture())
        #expect(fallback.passed)
        let fallbackRequests = try rpcRequests(fallback.recordedClientStdinLines)
        let fallbackAuth = fallbackRequests.first(where: { $0.method == "authenticate" })?.params
        #expect(fallbackAuth?.count == 1)
        #expect(fallbackAuth?["methodId"] as? String == "grok.com")

        let unsupported = try await EngineReplayHarness.runFixture(EngineReplayHarness.grokUnsupportedAuthMethodFixture())
        #expect(unsupported.passed)
        let unsupportedRequests = try rpcRequests(unsupported.recordedClientStdinLines)
        #expect(unsupportedRequests.map(\.method) == ["initialize"])

        let otherEngine = try await EngineReplayHarness.runFixture(EngineReplayHarness.mcodeIgnoresGrokAuthMethodsFixture())
        #expect(otherEngine.passed)
        let otherRequests = try rpcRequests(otherEngine.recordedClientStdinLines)
        #expect(!otherRequests.contains { $0.method == "authenticate" })
    }

    @Test("Grok skips an already selected model and sets only an advertised different model")
    func grokModelSelection() async throws {
        let alreadySelected = try await EngineReplayHarness.runFixture(EngineReplayHarness.grokAlreadySelectedModelFixture())
        #expect(alreadySelected.passed)
        let unchangedRequests = try rpcRequests(alreadySelected.recordedClientStdinLines)
        #expect(!unchangedRequests.contains { $0.method == "session/set_model" })

        let needsSwitch = try await EngineReplayHarness.runFixture(EngineReplayHarness.grokSelectsAdvertisedModelFixture())
        #expect(needsSwitch.passed)
        let changedRequests = try rpcRequests(needsSwitch.recordedClientStdinLines)
        #expect(changedRequests.map(\.method) == ["initialize", "session/new", "session/set_model", "session/prompt"])
        #expect(changedRequests.first(where: { $0.method == "session/set_model" })?.params["modelId"] as? String == "grok-4.7")

        let unsupported = try await EngineReplayHarness.runFixture(EngineReplayHarness.grokRejectsUnadvertisedModelFixture())
        #expect(unsupported.passed)
        let unsupportedRequests = try rpcRequests(unsupported.recordedClientStdinLines)
        #expect(unsupportedRequests.map(\.method) == ["initialize", "session/new"])
    }

    @Test("ACP rejects tool preparation owned by another bot before launcher invocation")
    func mismatchedToolPreparationFailsClosed() async throws {
        let fixture = EngineReplayHarness.grokMismatchedToolOwnerFixture()
        let launcher = ScriptedProcessLauncher(fixture: fixture)
        let runner = AcpProcessRunner(harnessKind: .grok, launcher: launcher)
        await #expect(throws: NativeTurnToolError.wrongIdentity) {
            _ = try await runner.sendTurn(input: fixture.input)
        }
        #expect(await launcher.getCapturedSpawnSpec() == nil)
        #expect(await launcher.getCapturedStdinLines().isEmpty)
    }

    @Test("ACP sends only validated bot-scoped mounts on new and resumed sessions")
    func preparedAcpMountsAreSerializedWithoutCredentials() async throws {
        let identity = NativeToolIdentity(
            hostId: "mac:test",
            installationId: "fixture-installation",
            userId: "fixture-user",
            generation: 1
        )
        let mount = NativeMCPServerMount(
            name: "docs",
            botId: "bot-grok",
            identity: identity,
            endpoint: .loopbackHTTP(url: "http://127.0.0.1:18181/mcp")
        )
        let preparation = NativeTurnToolPreparation(botId: "bot-grok", identity: identity, mounts: [mount])

        for resumed in [false, true] {
            let sessionId = resumed ? "grok-resumed-with-mount" : "grok-new-with-mount"
            let input = TurnInput(
                threadId: "thread-\(sessionId)",
                botId: "bot-grok",
                prompt: "Use the prepared local docs mount",
                resumeSessionId: resumed ? sessionId : nil,
                workingDirectory: "/tmp/grok",
                toolPreparation: preparation
            )
            let fixture = EngineReplayFixture(
                id: sessionId,
                family: .grok,
                title: "Grok prepared MCP mount on \(resumed ? "session/load" : "session/new")",
                input: input,
                expectedSpawnSpec: AcpProcessRunner.buildSpawnSpec(harnessKind: .grok, input: input),
                steps: [
                    .onClientRequest(method: "initialize", replyResultJSON: #"{"agentCapabilities":{}}"#),
                    .onClientRequest(
                        method: resumed ? "session/load" : "session/new",
                        replyResultJSON: #"{"sessionId":"\#(sessionId)"}"#
                    ),
                    .onClientRequest(method: "session/prompt", replyResultJSON: #"{"stopReason":"end_turn"}"#)
                ],
                expectedEvents: [
                    .sessionStarted(sessionId: sessionId),
                    .completed(stopReason: "end_turn", inputTokens: nil, outputTokens: nil)
                ]
            )
            let replay = try await EngineReplayHarness.runFixture(fixture)
            #expect(replay.passed)
            let requests = try rpcRequests(replay.recordedClientStdinLines)
            let sessionRequest = requests.first(where: { $0.method == (resumed ? "session/load" : "session/new") })
            let serializedMounts = sessionRequest?.params["mcpServers"] as? [[String: Any]]
            #expect(serializedMounts?.count == 1)
            let serialized = serializedMounts?.first
            #expect(serialized?["type"] as? String == "http")
            #expect(serialized?["name"] as? String == "docs")
            #expect(serialized?["url"] as? String == "http://127.0.0.1:18181/mcp")
            #expect((serialized?["headers"] as? [Any])?.isEmpty == true)
            #expect(serialized?["authorization"] == nil)
        }
    }
}

private struct RpcRequestRecord {
    let method: String
    let params: [String: Any]
}

private func rpcRequests(_ lines: [String]) throws -> [RpcRequestRecord] {
    try lines.compactMap { line in
        guard let data = line.data(using: .utf8),
              let message = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let method = message["method"] as? String else { return nil }
        return RpcRequestRecord(method: method, params: message["params"] as? [String: Any] ?? [:])
    }
}

private actor CountingCompletedDriver: EngineDriver {
    nonisolated let engineId = "fallback-fixture"
    private(set) var callCount = 0

    func sendTurn(input: TurnInput) async throws -> AsyncStream<TurnEvent> {
        callCount += 1
        return AsyncStream { continuation in
            continuation.yield(.completed(stopReason: "end_turn", inputTokens: nil, outputTokens: nil))
            continuation.finish()
        }
    }

    func cancelTurn(threadId: String) async {}
}
