import Foundation

/// Engine family identifier for the scrubbed replay fixture corpus.
public enum EngineReplayFamily: String, Equatable, Sendable, Codable, CaseIterable {
    case claude = "claude"
    case codex = "codex"
    case grok = "grok"
    case mcode = "mcode"
    case muse = "muse"
}

/// A single scripted wire interaction step for deterministic replay testing.
public enum ScriptedWireStep: Equatable, Sendable, Codable {
    /// Unconditionally emits newline-delimited stdout frames as soon as stdin receives the initial turn frame.
    case emitStdoutLines([String])

    /// Waits for a client JSON-RPC request with `method`, optionally emits pre-reply notifications,
    /// sends the correlated JSON-RPC response (substituting the client's `id`), optionally sends a
    /// server-to-client request and waits for the client's response, and emits post-reply notifications.
    case onClientRequest(
        method: String,
        notificationsBeforeReply: [String] = [],
        replyResultJSON: String? = nil,
        replyErrorJSON: String? = nil,
        serverRequestJSON: String? = nil,
        notificationsAfterServerRequestReply: [String] = [],
        notificationsAfterReply: [String] = []
    )
}

/// Scrubbed, self-contained wire fixture capturing spawn specification, scripted stdio exchange,
/// and the exact expected `TurnEvent` sequence for one recorded turn.
public struct EngineReplayFixture: Equatable, Sendable, Codable, Identifiable {
    public let id: String
    public let family: EngineReplayFamily
    public let title: String
    public let input: TurnInput
    public let expectedSpawnSpec: EngineSpawnSpec
    public let steps: [ScriptedWireStep]
    public let expectedEvents: [TurnEvent]

    public init(
        id: String,
        family: EngineReplayFamily,
        title: String,
        input: TurnInput,
        expectedSpawnSpec: EngineSpawnSpec,
        steps: [ScriptedWireStep],
        expectedEvents: [TurnEvent]
    ) {
        self.id = id
        self.family = family
        self.title = title
        self.input = input
        self.expectedSpawnSpec = expectedSpawnSpec
        self.steps = steps
        self.expectedEvents = expectedEvents
    }
}

/// Result of running a single `EngineReplayFixture` through its target `EngineDriver`.
public struct EngineReplayResult: Equatable, Sendable {
    public let fixtureId: String
    public let family: EngineReplayFamily
    public let recordedSpawnSpec: EngineSpawnSpec?
    public let actualEvents: [TurnEvent]
    public let recordedClientStdinLines: [String]
    public let passed: Bool

    public init(
        fixtureId: String,
        family: EngineReplayFamily,
        recordedSpawnSpec: EngineSpawnSpec?,
        actualEvents: [TurnEvent],
        recordedClientStdinLines: [String],
        passed: Bool
    ) {
        self.fixtureId = fixtureId
        self.family = family
        self.recordedSpawnSpec = recordedSpawnSpec
        self.actualEvents = actualEvents
        self.recordedClientStdinLines = recordedClientStdinLines
        self.passed = passed
    }
}

/// Deterministic in-memory `EngineProcessLauncher` that drives an `EngineDriver` using a `EngineReplayFixture`
/// without spawning external binaries or touching the network.
public actor ScriptedProcessLauncher: EngineProcessLauncher {
    private let fixture: EngineReplayFixture
    public private(set) var capturedSpawnSpec: EngineSpawnSpec?
    public private(set) var capturedStdinLines: [String] = []
    private var stepIndex: Int = 0
    private var waitingForServerRequestReply: Bool = false
    private var pendingAfterServerRequestLines: [String] = []
    private var deferredClientReplyLine: String?
    private var deferredPostReplyLines: [String] = []

    public init(fixture: EngineReplayFixture) {
        self.fixture = fixture
    }

    public func getCapturedSpawnSpec() -> EngineSpawnSpec? {
        capturedSpawnSpec
    }

    public func getCapturedStdinLines() -> [String] {
        capturedStdinLines
    }

    public func launch(
        spec: EngineSpawnSpec,
        threadId: String,
        engineId: String
    ) async throws -> EngineProcessSession {
        capturedSpawnSpec = spec
        let (stdoutLines, stdoutContinuation) = AsyncStream<String>.makeStream()
        let (stderrChunks, stderrContinuation) = AsyncStream<String>.makeStream()
        stderrContinuation.finish()

        return EngineProcessSession(
            pid: 42_000,
            stdoutLines: stdoutLines,
            stderrChunks: stderrChunks,
            writeStdinLine: { [weak self] line in
                guard let self else { return }
                await self.handleClientStdinLine(line, stdoutContinuation: stdoutContinuation)
            },
            closeStdin: { [weak self] in
                guard let self else { return }
                await self.handleClientCloseStdin(stdoutContinuation: stdoutContinuation)
            },
            cancel: {
                stdoutContinuation.finish()
            },
            waitForExit: {
                .exited(code: 0)
            }
        )
    }

    private func handleClientStdinLine(
        _ line: String,
        stdoutContinuation: AsyncStream<String>.Continuation
    ) async {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        capturedStdinLines.append(trimmed)

        // If we are waiting for the client's response to a server->client request (e.g. permission/approval),
        // consume this stdin line as that response and flush the remaining notifications/reply.
        // This has to run BEFORE the step-bounds check below: the client answers the server request only
        // after the final scripted step has already been consumed, and that answer still carries the
        // deferred response frame the driver is blocked on.
        if waitingForServerRequestReply {
            waitingForServerRequestReply = false
            for note in pendingAfterServerRequestLines {
                stdoutContinuation.yield(note)
            }
            pendingAfterServerRequestLines.removeAll()

            if let replyLine = deferredClientReplyLine {
                stdoutContinuation.yield(replyLine)
                deferredClientReplyLine = nil
            }
            for note in deferredPostReplyLines {
                stdoutContinuation.yield(note)
            }
            deferredPostReplyLines.removeAll()

            if stepIndex >= fixture.steps.count {
                stdoutContinuation.finish()
            }
            return
        }

        guard stepIndex < fixture.steps.count else { return }

        let currentStep = fixture.steps[stepIndex]
        switch currentStep {
        case .emitStdoutLines(let lines):
            stepIndex += 1
            for outLine in lines {
                stdoutContinuation.yield(outLine)
            }
            if stepIndex >= fixture.steps.count {
                stdoutContinuation.finish()
            }

        case .onClientRequest(
            let expectedMethod,
            let notificationsBeforeReply,
            let replyResultJSON,
            let replyErrorJSON,
            let serverRequestJSON,
            let notificationsAfterServerRequestReply,
            let notificationsAfterReply
        ):
            guard let data = trimmed.data(using: .utf8),
                  let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let method = json["method"] as? String else {
                return
            }

            // Ignore client notifications (such as Codex `initialized` or `session/cancel`) that carry no `id`.
            if json["id"] == nil && method != expectedMethod {
                return
            }

            guard method == expectedMethod else {
                return
            }

            stepIndex += 1
            let clientId = (json["id"] as? Int) ?? 1

            for note in notificationsBeforeReply {
                stdoutContinuation.yield(note)
            }

            let constructedReply: String?
            if let errorJSON = replyErrorJSON {
                constructedReply = #"{"jsonrpc":"2.0","id":\#(clientId),"error":\#(errorJSON)}"#
            } else if let resultJSON = replyResultJSON {
                constructedReply = #"{"jsonrpc":"2.0","id":\#(clientId),"result":\#(resultJSON)}"#
            } else {
                constructedReply = nil
            }

            if let serverReq = serverRequestJSON {
                // For ACP `session/prompt`, the server request (e.g. `session/request_permission`) arrives
                // BEFORE the `session/prompt` response.  For Codex `turn/start`, `turn/start` replies first
                // and then the server sends approval requests before `turn/completed`.
                if method == "session/prompt" {
                    waitingForServerRequestReply = true
                    pendingAfterServerRequestLines = notificationsAfterServerRequestReply
                    deferredClientReplyLine = constructedReply
                    deferredPostReplyLines = notificationsAfterReply
                    stdoutContinuation.yield(serverReq)
                    return
                } else {
                    if let replyLine = constructedReply {
                        stdoutContinuation.yield(replyLine)
                    }
                    waitingForServerRequestReply = true
                    pendingAfterServerRequestLines = notificationsAfterServerRequestReply
                    deferredClientReplyLine = nil
                    deferredPostReplyLines = notificationsAfterReply
                    stdoutContinuation.yield(serverReq)
                    return
                }
            }

            if let replyLine = constructedReply {
                stdoutContinuation.yield(replyLine)
            }
            for note in notificationsAfterReply {
                stdoutContinuation.yield(note)
            }

            if stepIndex >= fixture.steps.count {
                stdoutContinuation.finish()
            }
        }
    }

    private func handleClientCloseStdin(stdoutContinuation: AsyncStream<String>.Continuation) async {
        // For single-shot stdin protocols like Claude stream-json, closing stdin after writing
        // the prompt triggers any remaining `.emitStdoutLines` steps.
        while stepIndex < fixture.steps.count {
            if case .emitStdoutLines(let lines) = fixture.steps[stepIndex] {
                stepIndex += 1
                for line in lines {
                    stdoutContinuation.yield(line)
                }
            } else {
                break
            }
        }
        stdoutContinuation.finish()
    }
}

/// Harness that executes scrubbed replay fixtures against `ClaudeStreamRunner`, `CodexAppServerRunner`,
/// and `AcpProcessRunner` (Grok, MiniMax `mcode`, Muse) and verifies exact `TurnEvent` parity.
public enum EngineReplayHarness {
    /// Executes a single `EngineReplayFixture` against its corresponding native Swift `EngineDriver`.
    public static func runFixture(_ fixture: EngineReplayFixture) async throws -> EngineReplayResult {
        let launcher = ScriptedProcessLauncher(fixture: fixture)
        let driver: any EngineDriver

        switch fixture.family {
        case .claude:
            driver = ClaudeStreamRunner(launcher: launcher)
        case .codex:
            driver = CodexAppServerRunner(launcher: launcher)
        case .grok:
            driver = AcpProcessRunner(harnessKind: .grok, launcher: launcher)
        case .mcode:
            driver = AcpProcessRunner(harnessKind: .mcode, launcher: launcher)
        case .muse:
            driver = AcpProcessRunner(harnessKind: .muse, launcher: launcher)
        }

        let stream = try await driver.sendTurn(input: fixture.input)
        var actualEvents: [TurnEvent] = []
        for await event in stream {
            actualEvents.append(event)
        }

        let recordedSpec = await launcher.getCapturedSpawnSpec()
        let recordedStdin = await launcher.getCapturedStdinLines()
        let specMatches = (recordedSpec == fixture.expectedSpawnSpec)
        let eventsMatch = (actualEvents == fixture.expectedEvents)

        return EngineReplayResult(
            fixtureId: fixture.id,
            family: fixture.family,
            recordedSpawnSpec: recordedSpec,
            actualEvents: actualEvents,
            recordedClientStdinLines: recordedStdin,
            passed: specMatches && eventsMatch
        )
    }

    /// Returns all 100 scrubbed replay fixtures (20 per engine family across all 5 families).
    public static func allFixtures() -> [EngineReplayFixture] {
        claudeFixtures() + codexFixtures() + grokFixtures() + mcodeFixtures() + museFixtures()
    }

    public static func fixtures(for family: EngineReplayFamily) -> [EngineReplayFixture] {
        switch family {
        case .claude: return claudeFixtures()
        case .codex: return codexFixtures()
        case .grok: return grokFixtures()
        case .mcode: return mcodeFixtures()
        case .muse: return museFixtures()
        }
    }

    // MARK: - 1. Claude Code Stream-JSON Corpus (20 Scrubbed Turn Fixtures)

    public static func claudeFixtures() -> [EngineReplayFixture] {
        var list: [EngineReplayFixture] = []

        // Turns 1..8: Streaming text, multi-chunk deltas, custom models, session resume, and reasoning blocks.
        for idx in 1...8 {
            let isResumed = (idx % 2 == 0)
            let includeThinking = (idx >= 4)
            let modelId = (idx % 3 == 0) ? "claude-opus-4-6" : "claude-sonnet-4-6"
            let sessionId = "claude-sess-\(idx)"
            let input = TurnInput(
                threadId: "thread-claude-\(idx)",
                botId: "bot-claude",
                prompt: "Analyze module \(idx) performance.",
                modelId: modelId,
                resumeSessionId: isResumed ? sessionId : nil,
                workingDirectory: "/tmp/workspace"
            )
            let spec = ClaudeStreamRunner.buildSpawnSpec(input: input)

            var lines: [String] = [
                #"{"type":"system","subtype":"init","session_id":"\#(sessionId)","model":"\#(modelId)"}"#
            ]
            var expected: [TurnEvent] = [
                .sessionStarted(sessionId: sessionId)
            ]

            if includeThinking {
                lines.append(#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Inspecting module \#(idx) metrics."}}}"#)
                expected.append(.reasoningDelta("Inspecting module \(idx) metrics."))
            }

            lines.append(#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Module \#(idx) "}}}"#)
            lines.append(#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"is healthy."}}}"#)
            lines.append(#"{"type":"assistant","message":{"id":"msg_\#(idx)","model":"\#(modelId)","content":[{"type":"text","text":"Module \#(idx) is healthy."}],"usage":{"input_tokens":\#(100 + idx),"output_tokens":\#(20 + idx)}}}"#)
            lines.append(#"{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","usage":{"input_tokens":\#(100 + idx),"cache_read_input_tokens":10,"output_tokens":\#(20 + idx)}}"#)

            expected.append(.textDelta("Module \(idx) "))
            expected.append(.textDelta("is healthy."))
            expected.append(.completed(stopReason: "end_turn", inputTokens: 110 + idx, outputTokens: 20 + idx))

            list.append(EngineReplayFixture(
                id: "claude-turn-\(String(format: "%02d", idx))",
                family: .claude,
                title: "Claude streaming turn \(idx) (resume=\(isResumed), thinking=\(includeThinking))",
                input: input,
                expectedSpawnSpec: spec,
                steps: [.emitStdoutLines(lines)],
                expectedEvents: expected
            ))
        }

        // Turns 9..15: Tool calls (`Read`, `Bash`, `Edit`, `Grep`) + tool results (success and error) + final answer.
        let toolNames = ["Read", "Bash", "Edit", "Grep", "Glob", "Write", "Bash"]
        for offset in 0..<7 {
            let idx = 9 + offset
            let toolName = toolNames[offset]
            let isToolError = (offset == 6)
            let sessionId = "claude-sess-\(idx)"
            let toolId = "toolu_\(idx)"
            let input = TurnInput(
                threadId: "thread-claude-\(idx)",
                botId: "bot-claude",
                prompt: "Run tool \(toolName) for task \(idx)",
                modelId: "claude-sonnet-4-6",
                workingDirectory: "/tmp/workspace"
            )
            let spec = ClaudeStreamRunner.buildSpawnSpec(input: input)

            let lines: [String] = [
                #"{"type":"system","subtype":"init","session_id":"\#(sessionId)","model":"claude-sonnet-4-6"}"#,
                #"{"type":"assistant","message":{"id":"msg_a_\#(idx)","model":"claude-sonnet-4-6","content":[{"type":"tool_use","id":"\#(toolId)","name":"\#(toolName)","input":{"target":"item_\#(idx)"}}]}}"#,
                #"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"\#(toolId)","is_error":\#(isToolError),"content":"Result for \#(toolName) \#(idx)"}]}}"#,
                #"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Completed \#(toolName) step \#(idx)."}}}"#,
                #"{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","usage":{"input_tokens":240,"output_tokens":45}}"#
            ]
            let expected: [TurnEvent] = [
                .sessionStarted(sessionId: sessionId),
                .toolCall(id: toolId, name: toolName, argumentsJSON: #"{"target":"item_\#(idx)"}"#),
                .toolResult(id: toolId, output: "Result for \(toolName) \(idx)", isError: isToolError),
                .textDelta("Completed \(toolName) step \(idx)."),
                .completed(stopReason: "end_turn", inputTokens: 240, outputTokens: 45)
            ]

            list.append(EngineReplayFixture(
                id: "claude-turn-\(String(format: "%02d", idx))",
                family: .claude,
                title: "Claude tool execution turn \(idx) (\(toolName))",
                input: input,
                expectedSpawnSpec: spec,
                steps: [.emitStdoutLines(lines)],
                expectedEvents: expected
            ))
        }

        // Turn 16: Streaming `input_json_delta` tool call assembly + subagent narration filtering.
        do {
            let idx = 16
            let sessionId = "claude-sess-16"
            let input = TurnInput(
                threadId: "thread-claude-16",
                botId: "bot-claude",
                prompt: "Stream tool input JSON and ignore subagent narration",
                modelId: "claude-sonnet-4-6",
                workingDirectory: "/tmp/workspace"
            )
            let spec = ClaudeStreamRunner.buildSpawnSpec(input: input)
            let lines: [String] = [
                #"{"type":"system","subtype":"init","session_id":"claude-sess-16","model":"claude-sonnet-4-6"}"#,
                #"{"type":"stream_event","parent_tool_use_id":"toolu_parent","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"SUBAGENT NOISE MUST BE DROPPED"}}}"#,
                #"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_stream_16","name":"Bash"}}}"#,
                #"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\"command\":"}}}"#,
                #"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"\"swift test\"}"}}}"#,
                #"{"type":"stream_event","event":{"type":"content_block_stop"}}"#,
                #"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_stream_16","is_error":false,"content":"All tests passed"}]}}"#,
                #"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Verified build."}}}"#,
                #"{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","usage":{"input_tokens":300,"output_tokens":50}}"#
            ]
            let expected: [TurnEvent] = [
                .sessionStarted(sessionId: sessionId),
                .toolCall(id: "toolu_stream_16", name: "Bash", argumentsJSON: #"{"command":"swift test"}"#),
                .toolResult(id: "toolu_stream_16", output: "All tests passed", isError: false),
                .textDelta("Verified build."),
                .completed(stopReason: "end_turn", inputTokens: 300, outputTokens: 50)
            ]
            list.append(EngineReplayFixture(
                id: "claude-turn-\(idx)",
                family: .claude,
                title: "Claude streaming tool input_json_delta and subagent narration guard",
                input: input,
                expectedSpawnSpec: spec,
                steps: [.emitStdoutLines(lines)],
                expectedEvents: expected
            ))
        }

        // Turn 17: Non-streamed fallback assistant message (no prior `stream_event` before `assistant`).
        do {
            let input = TurnInput(
                threadId: "thread-claude-17",
                botId: "bot-claude",
                prompt: "Return cached reply without stream_event",
                workingDirectory: "/tmp/workspace"
            )
            let spec = ClaudeStreamRunner.buildSpawnSpec(input: input)
            let lines: [String] = [
                #"{"type":"system","subtype":"init","session_id":"claude-sess-17"}"#,
                #"{"type":"assistant","message":{"id":"msg_17","model":"claude-sonnet-4-6","content":[{"type":"text","text":"Fallback whole-message reply."}]}}"#,
                #"{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","usage":{"input_tokens":80,"output_tokens":12}}"#
            ]
            let expected: [TurnEvent] = [
                .sessionStarted(sessionId: "claude-sess-17"),
                .textDelta("Fallback whole-message reply."),
                .completed(stopReason: "end_turn", inputTokens: 80, outputTokens: 12)
            ]
            list.append(EngineReplayFixture(
                id: "claude-turn-17",
                family: .claude,
                title: "Claude whole-message fallback when stream_event is absent",
                input: input,
                expectedSpawnSpec: spec,
                steps: [.emitStdoutLines(lines)],
                expectedEvents: expected
            ))
        }

        // Turn 18: Synthetic assistant model rejection (`<synthetic>` + `model_not_found`) mapped to `.error`.
        do {
            let input = TurnInput(
                threadId: "thread-claude-18",
                botId: "bot-claude",
                prompt: "Test invalid model rejection",
                modelId: "claude-nonexistent-99",
                workingDirectory: "/tmp/workspace"
            )
            let spec = ClaudeStreamRunner.buildSpawnSpec(input: input)
            let lines: [String] = [
                #"{"type":"system","subtype":"init","session_id":"claude-sess-18"}"#,
                #"{"type":"assistant","error":"model_not_found","message":{"id":"msg_syn_18","model":"<synthetic>","content":[{"type":"text","text":"There's an issue with the selected model (claude-nonexistent-99)."}],"usage":{"input_tokens":0,"output_tokens":0}}}"#,
                #"{"type":"result","is_error":true,"terminal_reason":"api_error","api_error_status":404,"result":"There's an issue with the selected model (claude-nonexistent-99)."}"#
            ]
            let expected: [TurnEvent] = [
                .sessionStarted(sessionId: "claude-sess-18"),
                .error(code: "unknown_model", message: "There's an issue with the selected model (claude-nonexistent-99).")
            ]
            list.append(EngineReplayFixture(
                id: "claude-turn-18",
                family: .claude,
                title: "Claude synthetic assistant model_not_found error mapping",
                input: input,
                expectedSpawnSpec: spec,
                steps: [.emitStdoutLines(lines)],
                expectedEvents: expected
            ))
        }

        // Turn 19: Synthetic authentication error (`<synthetic>`) mapped to `.error(code: "auth_required", ...)`.
        do {
            let input = TurnInput(
                threadId: "thread-claude-19",
                botId: "bot-claude",
                prompt: "Run while signed out",
                workingDirectory: "/tmp/workspace"
            )
            let spec = ClaudeStreamRunner.buildSpawnSpec(input: input)
            let lines: [String] = [
                #"{"type":"system","subtype":"init","session_id":"claude-sess-19"}"#,
                #"{"type":"assistant","message":{"id":"msg_syn_19","model":"<synthetic>","content":[{"type":"text","text":"Invalid API key · Please run /login"}],"usage":{"input_tokens":0,"output_tokens":0}}}"#,
                #"{"type":"result","is_error":true,"terminal_reason":"api_error","result":"Invalid API key · Please run /login"}"#
            ]
            let expected: [TurnEvent] = [
                .sessionStarted(sessionId: "claude-sess-19"),
                .error(code: "auth_required", message: "Invalid API key · Please run /login")
            ]
            list.append(EngineReplayFixture(
                id: "claude-turn-19",
                family: .claude,
                title: "Claude synthetic authentication error guard",
                input: input,
                expectedSpawnSpec: spec,
                steps: [.emitStdoutLines(lines)],
                expectedEvents: expected
            ))
        }

        // Turn 20: Rate-limit error on `result` frame (`api_error_status: 429`).
        do {
            let input = TurnInput(
                threadId: "thread-claude-20",
                botId: "bot-claude",
                prompt: "Trigger rate limit",
                workingDirectory: "/tmp/workspace"
            )
            let spec = ClaudeStreamRunner.buildSpawnSpec(input: input)
            let lines: [String] = [
                #"{"type":"system","subtype":"init","session_id":"claude-sess-20"}"#,
                #"{"type":"result","is_error":true,"terminal_reason":"api_error","api_error_status":429,"result":"Anthropic 429 rate limit exceeded"}"#
            ]
            let expected: [TurnEvent] = [
                .sessionStarted(sessionId: "claude-sess-20"),
                .error(code: "rate_limited", message: "Anthropic 429 rate limit exceeded")
            ]
            list.append(EngineReplayFixture(
                id: "claude-turn-20",
                family: .claude,
                title: "Claude result frame HTTP 429 rate_limited classification",
                input: input,
                expectedSpawnSpec: spec,
                steps: [.emitStdoutLines(lines)],
                expectedEvents: expected
            ))
        }

        return list
    }

    // MARK: - 2. Codex App-Server JSON-RPC Corpus (20 Scrubbed Turn Fixtures)

    public static func codexFixtures() -> [EngineReplayFixture] {
        var list: [EngineReplayFixture] = []

        // Turns 1..8: Streaming agentMessage deltas, reasoning deltas, thread/start vs thread/resume, tokenUsage.
        for idx in 1...8 {
            let isResumed = (idx % 2 == 0)
            let includeReasoning = (idx >= 4)
            let threadId = "codex-thr-\(idx)"
            let input = TurnInput(
                threadId: "thread-codex-\(idx)",
                botId: "bot-codex",
                prompt: "Implement feature \(idx)",
                modelId: "gpt-5.4",
                resumeSessionId: isResumed ? threadId : nil,
                workingDirectory: "/tmp/codex",
                environment: ["OPENAI_API_KEY": "sk-testtoken000000000000"]
            )
            let spec = CodexAppServerRunner.buildSpawnSpec(input: input)

            var postTurnStartNotes: [String] = []
            var expected: [TurnEvent] = [.sessionStarted(sessionId: threadId)]

            if includeReasoning {
                postTurnStartNotes.append(#"{"jsonrpc":"2.0","method":"item/reasoning/textDelta","params":{"threadId":"\#(threadId)","delta":"Planning step \#(idx)."}}"#)
                expected.append(.reasoningDelta("Planning step \(idx)."))
            }

            postTurnStartNotes.append(#"{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"threadId":"\#(threadId)","delta":"Feature \#(idx) "}}"#)
            postTurnStartNotes.append(#"{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"threadId":"\#(threadId)","delta":"shipped."}}"#)
            postTurnStartNotes.append(#"{"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"\#(threadId)","item":{"id":"msg_\#(idx)","type":"agentMessage","text":"Feature \#(idx) shipped."}}}"#)
            postTurnStartNotes.append(#"{"jsonrpc":"2.0","method":"thread/tokenUsage/updated","params":{"threadId":"\#(threadId)","tokenUsage":{"last":{"inputTokens":\#(200 + idx),"outputTokens":\#(30 + idx)}}}}"#)
            postTurnStartNotes.append(#"{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"\#(threadId)","turn":{"id":"turn_\#(idx)","status":"completed","stopReason":"completed"}}}"#)

            expected.append(.textDelta("Feature \(idx) "))
            expected.append(.textDelta("shipped."))
            expected.append(.completed(stopReason: "completed", inputTokens: 200 + idx, outputTokens: 30 + idx))

            let steps: [ScriptedWireStep] = [
                .onClientRequest(method: "initialize", replyResultJSON: #"{"serverInfo":{"name":"codex","version":"0.159.0"}}"#),
                .onClientRequest(
                    method: isResumed ? "thread/resume" : "thread/start",
                    replyResultJSON: #"{"thread":{"id":"\#(threadId)"},"model":"gpt-5.4"}"#
                ),
                .onClientRequest(
                    method: "turn/start",
                    replyResultJSON: #"{"turn":{"id":"turn_\#(idx)"}}"#,
                    notificationsAfterReply: postTurnStartNotes
                )
            ]

            list.append(EngineReplayFixture(
                id: "codex-turn-\(String(format: "%02d", idx))",
                family: .codex,
                title: "Codex app-server streaming turn \(idx) (resume=\(isResumed))",
                input: input,
                expectedSpawnSpec: spec,
                steps: steps,
                expectedEvents: expected
            ))
        }

        // Turns 9..15: Tool executions (`commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`, `collabAgentToolCall`).
        let itemConfigs: [(type: String, expectedTitle: String, extraKey: String, extraVal: String, failed: Bool)] = [
            ("commandExecution", "git status", "command", "git status", false),
            ("fileChange", "edit", "filePath", "Sources/App.swift", false),
            ("mcpToolCall", "search_docs", "tool", "search_docs", false),
            ("webSearch", "web_search", "query", "Swift 6 actors", false),
            ("collabAgentToolCall", "spawn_agent", "tool", "spawnAgent", false),
            ("commandExecution", "swift test", "command", "swift test", false),
            ("commandExecution", "false", "command", "false", true)
        ]

        for (offset, cfg) in itemConfigs.enumerated() {
            let idx = 9 + offset
            let threadId = "codex-thr-\(idx)"
            let itemId = "item_\(idx)"
            let input = TurnInput(
                threadId: "thread-codex-\(idx)",
                botId: "bot-codex",
                prompt: "Execute \(cfg.expectedTitle) on turn \(idx)",
                modelId: "gpt-5.4",
                workingDirectory: "/tmp/codex"
            )
            let spec = CodexAppServerRunner.buildSpawnSpec(input: input)
            let statusStr = cfg.failed ? "failed" : "completed"

            let notes: [String] = [
                #"{"jsonrpc":"2.0","method":"item/started","params":{"threadId":"\#(threadId)","item":{"id":"\#(itemId)","type":"\#(cfg.type)","\#(cfg.extraKey)":"\#(cfg.extraVal)","status":"in_progress"}}}"#,
                #"{"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"\#(threadId)","item":{"id":"\#(itemId)","type":"\#(cfg.type)","\#(cfg.extraKey)":"\#(cfg.extraVal)","status":"\#(statusStr)","aggregatedOutput":"Output for \#(itemId)"}}}"#,
                #"{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"threadId":"\#(threadId)","delta":"Finished \#(cfg.expectedTitle)."}}"#,
                #"{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"\#(threadId)","turn":{"id":"turn_\#(idx)","status":"completed","stopReason":"completed","usage":{"inputTokens":310,"outputTokens":42}}}}"#
            ]

            let expectedArgsJSON = ClaudeStreamRunner.canonicalJSONString(from: [
                "type": cfg.type,
                cfg.extraKey: cfg.extraVal
            ])

            let expected: [TurnEvent] = [
                .sessionStarted(sessionId: threadId),
                .toolCall(id: itemId, name: cfg.expectedTitle, argumentsJSON: expectedArgsJSON),
                .toolResult(id: itemId, output: "Output for \(itemId)", isError: cfg.failed),
                .textDelta("Finished \(cfg.expectedTitle)."),
                .completed(stopReason: "completed", inputTokens: 310, outputTokens: 42)
            ]

            let steps: [ScriptedWireStep] = [
                .onClientRequest(method: "initialize", replyResultJSON: #"{"serverInfo":{"name":"codex"}}"#),
                .onClientRequest(method: "thread/start", replyResultJSON: #"{"thread":{"id":"\#(threadId)"}}"#),
                .onClientRequest(
                    method: "turn/start",
                    replyResultJSON: #"{"turn":{"id":"turn_\#(idx)"}}"#,
                    notificationsAfterReply: notes
                )
            ]

            list.append(EngineReplayFixture(
                id: "codex-turn-\(String(format: "%02d", idx))",
                family: .codex,
                title: "Codex tool execution turn \(idx) (\(cfg.type))",
                input: input,
                expectedSpawnSpec: spec,
                steps: steps,
                expectedEvents: expected
            ))
        }

        // Turn 16: Bidirectional server->client approval request (`item/commandExecution/requestApproval`) failing closed.
        do {
            let threadId = "codex-thr-16"
            let input = TurnInput(
                threadId: "thread-codex-16",
                botId: "bot-codex",
                prompt: "Run command requiring approval",
                modelId: "gpt-5.4",
                workingDirectory: "/tmp/codex"
            )
            let spec = CodexAppServerRunner.buildSpawnSpec(input: input)
            let steps: [ScriptedWireStep] = [
                .onClientRequest(method: "initialize", replyResultJSON: #"{"serverInfo":{"name":"codex"}}"#),
                .onClientRequest(method: "thread/start", replyResultJSON: #"{"thread":{"id":"codex-thr-16"}}"#),
                .onClientRequest(
                    method: "turn/start",
                    replyResultJSON: #"{"turn":{"id":"turn_16"}}"#,
                    serverRequestJSON: #"{"jsonrpc":"2.0","id":701,"method":"item/commandExecution/requestApproval","params":{"threadId":"codex-thr-16","itemId":"ask_16","command":"rm -rf /tmp/build"}}"#,
                    notificationsAfterServerRequestReply: [
                        #"{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"threadId":"codex-thr-16","delta":"Skipped declined command."}}"#,
                        #"{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"codex-thr-16","turn":{"id":"turn_16","status":"completed","stopReason":"completed","usage":{"inputTokens":150,"outputTokens":20}}}}"#
                    ]
                )
            ]
            let expected: [TurnEvent] = [
                .sessionStarted(sessionId: threadId),
                .permissionRequest(id: "ask_16", tool: "shell", description: "rm -rf /tmp/build"),
                .textDelta("Skipped declined command."),
                .completed(stopReason: "completed", inputTokens: 150, outputTokens: 20)
            ]
            list.append(EngineReplayFixture(
                id: "codex-turn-16",
                family: .codex,
                title: "Codex server->client command approval request failing closed",
                input: input,
                expectedSpawnSpec: spec,
                steps: steps,
                expectedEvents: expected
            ))
        }

        // Turn 17: Foreign helper thread notification filtering (`params.threadId != codexThreadId`).
        do {
            let threadId = "codex-thr-17"
            let input = TurnInput(
                threadId: "thread-codex-17",
                botId: "bot-codex",
                prompt: "Filter foreign helper thread notifications",
                workingDirectory: "/tmp/codex"
            )
            let spec = CodexAppServerRunner.buildSpawnSpec(input: input)
            let steps: [ScriptedWireStep] = [
                .onClientRequest(method: "initialize", replyResultJSON: #"{"serverInfo":{"name":"codex"}}"#),
                .onClientRequest(method: "thread/start", replyResultJSON: #"{"thread":{"id":"codex-thr-17"}}"#),
                .onClientRequest(
                    method: "turn/start",
                    replyResultJSON: #"{"turn":{"id":"turn_17"}}"#,
                    notificationsAfterReply: [
                        #"{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"threadId":"foreign-helper-99","delta":"FOREIGN HELPER TEXT MUST NOT LEAK"}}"#,
                        #"{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"threadId":"codex-thr-17","delta":"Main thread answer."}}"#,
                        #"{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"codex-thr-17","turn":{"id":"turn_17","status":"completed","stopReason":"completed","usage":{"inputTokens":95,"outputTokens":14}}}}"#
                    ]
                )
            ]
            let expected: [TurnEvent] = [
                .sessionStarted(sessionId: threadId),
                .textDelta("Main thread answer."),
                .completed(stopReason: "completed", inputTokens: 95, outputTokens: 14)
            ]
            list.append(EngineReplayFixture(
                id: "codex-turn-17",
                family: .codex,
                title: "Codex foreign helper thread notification isolation",
                input: input,
                expectedSpawnSpec: spec,
                steps: steps,
                expectedEvents: expected
            ))
        }

        // Turn 18: Missing rollout on `thread/resume` (`-32600 no rollout found for thread id`).
        do {
            let input = TurnInput(
                threadId: "thread-codex-18",
                botId: "bot-codex",
                prompt: "Resume missing thread",
                resumeSessionId: "missing-cursor-18",
                workingDirectory: "/tmp/codex"
            )
            let spec = CodexAppServerRunner.buildSpawnSpec(input: input)
            let steps: [ScriptedWireStep] = [
                .onClientRequest(method: "initialize", replyResultJSON: #"{"serverInfo":{"name":"codex"}}"#),
                .onClientRequest(
                    method: "thread/resume",
                    replyErrorJSON: #"{"code":-32600,"message":"no rollout found for thread id missing-cursor-18"}"#
                )
            ]
            let expected: [TurnEvent] = [
                .error(code: "resume_failed", message: "no rollout found for thread id missing-cursor-18")
            ]
            list.append(EngineReplayFixture(
                id: "codex-turn-18",
                family: .codex,
                title: "Codex thread/resume missing rollout error classification",
                input: input,
                expectedSpawnSpec: spec,
                steps: steps,
                expectedEvents: expected
            ))
        }

        // Turn 19: Unknown model rejection in `turn/completed`.
        do {
            let input = TurnInput(
                threadId: "thread-codex-19",
                botId: "bot-codex",
                prompt: "Test retired model",
                modelId: "gpt-retired-model",
                workingDirectory: "/tmp/codex"
            )
            let spec = CodexAppServerRunner.buildSpawnSpec(input: input)
            let steps: [ScriptedWireStep] = [
                .onClientRequest(method: "initialize", replyResultJSON: #"{"serverInfo":{"name":"codex"}}"#),
                .onClientRequest(method: "thread/start", replyResultJSON: #"{"thread":{"id":"codex-thr-19"}}"#),
                .onClientRequest(
                    method: "turn/start",
                    replyResultJSON: #"{"turn":{"id":"turn_19"}}"#,
                    notificationsAfterReply: [
                        #"{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"codex-thr-19","turn":{"id":"turn_19","status":"failed","error":{"message":"The model is not supported: model_not_found"}}}}"#
                    ]
                )
            ]
            let expected: [TurnEvent] = [
                .sessionStarted(sessionId: "codex-thr-19"),
                .error(code: "unknown_model", message: "The model is not supported: model_not_found")
            ]
            list.append(EngineReplayFixture(
                id: "codex-turn-19",
                family: .codex,
                title: "Codex turn/completed unknown_model failure",
                input: input,
                expectedSpawnSpec: spec,
                steps: steps,
                expectedEvents: expected
            ))
        }

        // Turn 20: Rate-limit error notification during turn.
        do {
            let input = TurnInput(
                threadId: "thread-codex-20",
                botId: "bot-codex",
                prompt: "Hit rate limit",
                workingDirectory: "/tmp/codex"
            )
            let spec = CodexAppServerRunner.buildSpawnSpec(input: input)
            let steps: [ScriptedWireStep] = [
                .onClientRequest(method: "initialize", replyResultJSON: #"{"serverInfo":{"name":"codex"}}"#),
                .onClientRequest(method: "thread/start", replyResultJSON: #"{"thread":{"id":"codex-thr-20"}}"#),
                .onClientRequest(
                    method: "turn/start",
                    replyResultJSON: #"{"turn":{"id":"turn_20"}}"#,
                    notificationsAfterReply: [
                        #"{"jsonrpc":"2.0","method":"error","params":{"threadId":"codex-thr-20","message":"HTTP 429 rate limit exceeded"}}"#
                    ]
                )
            ]
            let expected: [TurnEvent] = [
                .sessionStarted(sessionId: "codex-thr-20"),
                .error(code: "rate_limited", message: "HTTP 429 rate limit exceeded")
            ]
            list.append(EngineReplayFixture(
                id: "codex-turn-20",
                family: .codex,
                title: "Codex error notification rate_limited handling",
                input: input,
                expectedSpawnSpec: spec,
                steps: steps,
                expectedEvents: expected
            ))
        }

        return list
    }

    // MARK: - 3. Grok Build ACP Corpus (20 Scrubbed Turn Fixtures)

    public static func grokFixtures() -> [EngineReplayFixture] {
         buildAcpFixtures(for: .grok)
    }

    // MARK: - 4. MiniMax Code (`mcode`) ACP Corpus (20 Scrubbed Turn Fixtures)

    public static func mcodeFixtures() -> [EngineReplayFixture] {
        buildAcpFixtures(for: .mcode)
    }

    // MARK: - 5. Muse ACP Corpus (20 Scrubbed Turn Fixtures)

    public static func museFixtures() -> [EngineReplayFixture] {
        buildAcpFixtures(for: .muse)
    }

    private static func buildAcpFixtures(for harness: AcpHarnessKind) -> [EngineReplayFixture] {
        let family: EngineReplayFamily
        switch harness {
        case .grok: family = .grok
        case .mcode: family = .mcode
        case .muse: family = .muse
        }

        let prefix = harness.rawValue
        var list: [EngineReplayFixture] = []

        // Turns 1..6: Streaming text & thought chunks with `session/new`.
        for idx in 1...6 {
            let sessionId = "\(prefix)-sess-\(idx)"
            let includeThought = (idx >= 3)
            let modelId: String? = (harness == .grok) ? "grok-4.7" : nil
            let input = TurnInput(
                threadId: "thread-\(prefix)-\(idx)",
                botId: "bot-\(prefix)",
                prompt: "Synthesize \(prefix) response \(idx)",
                modelId: modelId,
                workingDirectory: "/tmp/\(prefix)",
                environment: harness == .grok ? ["XAI_API_KEY": "xai-strip-me"] : [:]
            )
            let spec = AcpProcessRunner.buildSpawnSpec(harnessKind: harness, input: input)

            var promptNotes: [String] = []
            var expected: [TurnEvent] = [.sessionStarted(sessionId: sessionId)]

            if includeThought {
                promptNotes.append(#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"\#(sessionId)","update":{"sessionUpdate":"agent_thought_chunk","content":{"text":"Thinking on \#(prefix) turn \#(idx)."}}}}"#)
                expected.append(.reasoningDelta("Thinking on \(prefix) turn \(idx)."))
            }
            promptNotes.append(#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"\#(sessionId)","update":{"sessionUpdate":"agent_message_chunk","content":{"text":"\#(prefix) reply \#(idx) part A. "}}}}"#)
            promptNotes.append(#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"\#(sessionId)","update":{"sessionUpdate":"agent_message_chunk","content":{"text":"Part B."}}}}"#)

            expected.append(.textDelta("\(prefix) reply \(idx) part A. "))
            expected.append(.textDelta("Part B."))
            expected.append(.completed(stopReason: "end_turn", inputTokens: 120 + idx, outputTokens: 25 + idx))

            let steps: [ScriptedWireStep] = [
                .onClientRequest(method: "initialize", replyResultJSON: #"{"protocolVersion":1,"agentCapabilities":{}}"#),
                .onClientRequest(method: "session/new", replyResultJSON: #"{"sessionId":"\#(sessionId)"}"#),
                .onClientRequest(
                    method: "session/prompt",
                    notificationsBeforeReply: promptNotes,
                    replyResultJSON: #"{"stopReason":"end_turn","usage":{"inputTokens":\#(120 + idx),"outputTokens":\#(25 + idx)}}"#
                )
            ]

            list.append(EngineReplayFixture(
                id: "\(prefix)-turn-\(String(format: "%02d", idx))",
                family: family,
                title: "\(prefix.uppercased()) ACP streaming turn \(idx)",
                input: input,
                expectedSpawnSpec: spec,
                steps: steps,
                expectedEvents: expected
            ))
        }

        // Turns 7..11: Tool calls (`tool_call` + `tool_call_update` completed & failed).
        for offset in 0..<5 {
            let idx = 7 + offset
            let sessionId = "\(prefix)-sess-\(idx)"
            let callId = "call_\(prefix)_\(idx)"
            let isFailed = (offset == 4)
            let statusStr = isFailed ? "failed" : "completed"
            let input = TurnInput(
                threadId: "thread-\(prefix)-\(idx)",
                botId: "bot-\(prefix)",
                prompt: "Run ACP tool \(idx)",
                workingDirectory: "/tmp/\(prefix)"
            )
            let spec = AcpProcessRunner.buildSpawnSpec(harnessKind: harness, input: input)

            let promptNotes: [String] = [
                #"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"\#(sessionId)","update":{"sessionUpdate":"tool_call","toolCallId":"\#(callId)","title":"read_file","kind":"read","rawInput":{"path":"src/file_\#(idx).swift"}}}}"#,
                #"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"\#(sessionId)","update":{"sessionUpdate":"tool_call_update","toolCallId":"\#(callId)","status":"\#(statusStr)","content":[{"type":"text","text":"Contents of file_\#(idx).swift"}]}}}"#,
                #"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"\#(sessionId)","update":{"sessionUpdate":"agent_message_chunk","content":{"text":"Processed file_\#(idx).swift."}}}}"#
            ]

            let expected: [TurnEvent] = [
                .sessionStarted(sessionId: sessionId),
                .toolCall(id: callId, name: "read_file", argumentsJSON: #"{"path":"src/file_\#(idx).swift"}"#),
                .toolResult(id: callId, output: "Contents of file_\(idx).swift", isError: isFailed),
                .textDelta("Processed file_\(idx).swift."),
                .completed(stopReason: "end_turn", inputTokens: 210, outputTokens: 35)
            ]

            let steps: [ScriptedWireStep] = [
                .onClientRequest(method: "initialize", replyResultJSON: #"{"protocolVersion":1}"#),
                .onClientRequest(method: "session/new", replyResultJSON: #"{"sessionId":"\#(sessionId)"}"#),
                .onClientRequest(
                    method: "session/prompt",
                    notificationsBeforeReply: promptNotes,
                    replyResultJSON: #"{"stopReason":"end_turn","usage":{"inputTokens":210,"outputTokens":35}}"#
                )
            ]

            list.append(EngineReplayFixture(
                id: "\(prefix)-turn-\(String(format: "%02d", idx))",
                family: family,
                title: "\(prefix.uppercased()) ACP tool call turn \(idx) (failed=\(isFailed))",
                input: input,
                expectedSpawnSpec: spec,
                steps: steps,
                expectedEvents: expected
            ))
        }

        // Turns 12..14: `session/load` with Double Replay Gate suppression
        // (both pre-prompt `session/update` notifications and `_meta.isReplay == true` updates dropped).
        for offset in 0..<3 {
            let idx = 12 + offset
            let sessionId = "\(prefix)-resumed-\(idx)"
            let input = TurnInput(
                threadId: "thread-\(prefix)-\(idx)",
                botId: "bot-\(prefix)",
                prompt: "Continue resumed session \(idx)",
                resumeSessionId: sessionId,
                workingDirectory: "/tmp/\(prefix)"
            )
            let spec = AcpProcessRunner.buildSpawnSpec(harnessKind: harness, input: input)

            let prePromptReplays: [String] = [
                #"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"\#(sessionId)","update":{"sessionUpdate":"agent_message_chunk","content":{"text":"OLD HISTORY BEFORE LOAD RESOLVES MUST BE DROPPED"}}}}"#,
                #"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"\#(sessionId)","update":{"sessionUpdate":"tool_call","toolCallId":"old_tool","title":"old_cmd","rawInput":{"command":"ls"}}}}"#
            ]
            let promptNotes: [String] = [
                #"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"\#(sessionId)","_meta":{"isReplay":true},"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"TAGGED REPLAY CHUNK AFTER PROMPT SENT MUST ALSO BE DROPPED"}}}}"#,
                #"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"\#(sessionId)","update":{"sessionUpdate":"agent_message_chunk","content":{"text":"Fresh live answer on resumed session \#(idx)."}}}}"#
            ]

            let expected: [TurnEvent] = [
                .sessionStarted(sessionId: sessionId),
                .textDelta("Fresh live answer on resumed session \(idx)."),
                .completed(stopReason: "end_turn", inputTokens: 340, outputTokens: 28)
            ]

            let steps: [ScriptedWireStep] = [
                .onClientRequest(method: "initialize", replyResultJSON: #"{"protocolVersion":1}"#),
                .onClientRequest(
                    method: "session/load",
                    notificationsBeforeReply: prePromptReplays,
                    replyResultJSON: #"{"sessionId":"\#(sessionId)"}"#
                ),
                .onClientRequest(
                    method: "session/prompt",
                    notificationsBeforeReply: promptNotes,
                    replyResultJSON: #"{"stopReason":"end_turn","usage":{"inputTokens":340,"outputTokens":28}}"#
                )
            ]

            list.append(EngineReplayFixture(
                id: "\(prefix)-turn-\(String(format: "%02d", idx))",
                family: family,
                title: "\(prefix.uppercased()) ACP session/load Double Replay Gate turn \(idx)",
                input: input,
                expectedSpawnSpec: spec,
                steps: steps,
                expectedEvents: expected
            ))
        }

        // Turns 15..17: `session/set_config_option` round-trip verification (model + thinkingEffort / mode).
        let effortValues = ["low", "high", "max"]
        for offset in 0..<3 {
            let idx = 15 + offset
            let sessionId = "\(prefix)-cfg-\(idx)"
            let effortVal = effortValues[offset]
            let configKey = (harness == .muse) ? "mode" : "thinkingEffort"
            let configVal = (harness == .muse) ? "auto" : effortVal
            let mcodeModelId = (harness == .mcode) ? "MiniMax-M3.1-Flash-thinking" : nil
            let mcodeWireVal = "m:minimax:MiniMax-M3.1-Flash:v:thinking"

            let input = TurnInput(
                threadId: "thread-\(prefix)-\(idx)",
                botId: "bot-\(prefix)",
                prompt: "Verify session/set_config_option round-trip \(idx)",
                modelId: mcodeModelId,
                workingDirectory: "/tmp/\(prefix)",
                configOptions: [configKey: configVal]
            )
            let spec = AcpProcessRunner.buildSpawnSpec(harnessKind: harness, input: input)

            var steps: [ScriptedWireStep] = [
                .onClientRequest(method: "initialize", replyResultJSON: #"{"protocolVersion":1}"#),
                .onClientRequest(
                    method: "session/new",
                    replyResultJSON: #"{"sessionId":"\#(sessionId)","configOptions":[{"id":"model","currentValue":"m:minimax:MiniMax-M2.7:v:","options":[{"value":"\#(mcodeWireVal)","name":"MiniMax M3.1 Flash"}]},{"id":"\#(configKey)","currentValue":"default"}]}"#
                )
            ]

            var expected: [TurnEvent] = [.sessionStarted(sessionId: sessionId)]

            if harness == .mcode {
                steps.append(.onClientRequest(
                    method: "session/set_config_option",
                    replyResultJSON: #"{"configOptions":[{"id":"model","currentValue":"\#(mcodeWireVal)"}]}"#
                ))
                expected.append(.configUpdated(key: "model", value: mcodeWireVal))
            }

            steps.append(.onClientRequest(
                method: "session/set_config_option",
                replyResultJSON: #"{"configOptions":[{"id":"\#(configKey)","currentValue":"\#(configVal)"}]}"#
            ))
            expected.append(.configUpdated(key: configKey, value: configVal))

            steps.append(.onClientRequest(
                method: "session/prompt",
                notificationsBeforeReply: [
                    #"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"\#(sessionId)","update":{"sessionUpdate":"agent_message_chunk","content":{"text":"Configured \#(configKey)=\#(configVal)."}}}}"#
                ],
                replyResultJSON: #"{"stopReason":"end_turn","usage":{"inputTokens":180,"outputTokens":22}}"#
            ))
            expected.append(.textDelta("Configured \(configKey)=\(configVal)."))
            expected.append(.completed(stopReason: "end_turn", inputTokens: 180, outputTokens: 22))

            list.append(EngineReplayFixture(
                id: "\(prefix)-turn-\(String(format: "%02d", idx))",
                family: family,
                title: "\(prefix.uppercased()) ACP session/set_config_option round-trip \(idx)",
                input: input,
                expectedSpawnSpec: spec,
                steps: steps,
                expectedEvents: expected
            ))
        }

        // Turn 18: Fail-closed `session/request_permission` handling.
        do {
            let sessionId = "\(prefix)-perm-18"
            let input = TurnInput(
                threadId: "thread-\(prefix)-18",
                botId: "bot-\(prefix)",
                prompt: "Trigger ACP permission gate",
                workingDirectory: "/tmp/\(prefix)"
            )
            let spec = AcpProcessRunner.buildSpawnSpec(harnessKind: harness, input: input)

            let steps: [ScriptedWireStep] = [
                .onClientRequest(method: "initialize", replyResultJSON: #"{"protocolVersion":1}"#),
                .onClientRequest(method: "session/new", replyResultJSON: #"{"sessionId":"\#(sessionId)"}"#),
                .onClientRequest(
                    method: "session/prompt",
                    replyResultJSON: #"{"stopReason":"end_turn","usage":{"inputTokens":140,"outputTokens":18}}"#,
                    serverRequestJSON: #"{"jsonrpc":"2.0","id":801,"method":"session/request_permission","params":{"sessionId":"\#(sessionId)","toolCall":{"toolCallId":"perm_call_18","kind":"execute","rawInput":{"command":"curl https://example.com"}},"options":[{"optionId":"opt_allow","kind":"allow_once"},{"optionId":"opt_reject","kind":"reject_once"}]}}"#,
                    notificationsAfterServerRequestReply: [
                        #"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"\#(sessionId)","update":{"sessionUpdate":"agent_message_chunk","content":{"text":"Permission request failed closed as expected."}}}}"#
                    ]
                )
            ]

            let expected: [TurnEvent] = [
                .sessionStarted(sessionId: sessionId),
                .permissionRequest(id: "perm_call_18", tool: "shell", description: "curl https://example.com"),
                .textDelta("Permission request failed closed as expected."),
                .completed(stopReason: "end_turn", inputTokens: 140, outputTokens: 18)
            ]

            list.append(EngineReplayFixture(
                id: "\(prefix)-turn-18",
                family: family,
                title: "\(prefix.uppercased()) ACP fail-closed permission request",
                input: input,
                expectedSpawnSpec: spec,
                steps: steps,
                expectedEvents: expected
            ))
        }

        // Turn 19: Config mismatch detection on `session/set_config_option`.
        do {
            let sessionId = "\(prefix)-mismatch-19"
            let input = TurnInput(
                threadId: "thread-\(prefix)-19",
                botId: "bot-\(prefix)",
                prompt: "Detect ignored config option switch",
                workingDirectory: "/tmp/\(prefix)",
                configOptions: ["thinkingEffort": "high"]
            )
            let spec = AcpProcessRunner.buildSpawnSpec(harnessKind: harness, input: input)

            let steps: [ScriptedWireStep] = [
                .onClientRequest(method: "initialize", replyResultJSON: #"{"protocolVersion":1}"#),
                .onClientRequest(method: "session/new", replyResultJSON: #"{"sessionId":"\#(sessionId)"}"#),
                .onClientRequest(
                    method: "session/set_config_option",
                    replyResultJSON: #"{"configOptions":[{"id":"thinkingEffort","currentValue":"low"}]}"#
                )
            ]

            let expected: [TurnEvent] = [
                .sessionStarted(sessionId: sessionId),
                .error(
                    code: "config_mismatch",
                    message: "\(prefix) did not apply config 'thinkingEffort' = 'high' (still 'low')"
                )
            ]

            list.append(EngineReplayFixture(
                id: "\(prefix)-turn-19",
                family: family,
                title: "\(prefix.uppercased()) ACP config_mismatch refusal when agent ignores config switch",
                input: input,
                expectedSpawnSpec: spec,
                steps: steps,
                expectedEvents: expected
            ))
        }

        // Turn 20: JSON-RPC error on `session/prompt` (rate limit / unknown model).
        do {
            let sessionId = "\(prefix)-err-20"
            let input = TurnInput(
                threadId: "thread-\(prefix)-20",
                botId: "bot-\(prefix)",
                prompt: "Trigger ACP RPC error",
                workingDirectory: "/tmp/\(prefix)"
            )
            let spec = AcpProcessRunner.buildSpawnSpec(harnessKind: harness, input: input)

            let steps: [ScriptedWireStep] = [
                .onClientRequest(method: "initialize", replyResultJSON: #"{"protocolVersion":1}"#),
                .onClientRequest(method: "session/new", replyResultJSON: #"{"sessionId":"\#(sessionId)"}"#),
                .onClientRequest(
                    method: "session/prompt",
                    replyErrorJSON: #"{"code":-32602,"message":"Invalid params","data":"unknown model id"}"#
                )
            ]

            let expected: [TurnEvent] = [
                .sessionStarted(sessionId: sessionId),
                .error(code: "unknown_model", message: "Invalid params: unknown model id")
            ]

            list.append(EngineReplayFixture(
                id: "\(prefix)-turn-20",
                family: family,
                title: "\(prefix.uppercased()) ACP JSON-RPC unknown_model error mapping",
                input: input,
                expectedSpawnSpec: spec,
                steps: steps,
                expectedEvents: expected
            ))
        }

        return list
    }
}
