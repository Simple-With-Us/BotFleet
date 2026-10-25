import Foundation

/// Native Swift runner for the Claude Code CLI (`claude --print --output-format stream-json --input-format stream-json --verbose`).
/// Translates newline-delimited stream-json frames (`system`, `stream_event`, `assistant`, `user`, `result`)
/// into canonical `TurnEvent`s, including synthetic error message detection and session resume support.
public actor ClaudeStreamRunner: EngineDriver {
    public nonisolated let engineId: String
    public nonisolated let executable: String
    private let launcher: any EngineProcessLauncher
    private var activeSessions: [String: EngineProcessSession] = [:]

    /// Containment environment variables matching `CLAUDE_CONTAINMENT_ENV` in `server/drivers/claude.ts`.
    public static let containmentEnvironment: [String: String] = [
        "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS": "1",
        "CLAUDE_CODE_DISABLE_CRON": "1",
        "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": "3",
        "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "1"
    ]

    public init(
        engineId: String = "claude",
        executable: String = "claude",
        launcher: any EngineProcessLauncher = ProcessSupervisorActor()
    ) {
        self.engineId = engineId
        self.executable = executable
        self.launcher = launcher
    }

    /// Constructs the verified spawn specification for Claude Code headless `stream-json` execution.
    public static func buildSpawnSpec(executable: String = "claude", input: TurnInput) -> EngineSpawnSpec {
        var args: [String] = [
            "--print",
            "--output-format", "stream-json",
            "--input-format", "stream-json",
            "--verbose",
            "--include-partial-messages"
        ]

        if let permissionMode = input.configOptions["permissionMode"], !permissionMode.isEmpty {
            args.append(contentsOf: ["--permission-mode", permissionMode])
        } else {
            args.append(contentsOf: ["--permission-mode", "acceptEdits"])
        }

        if let modelId = input.modelId, !modelId.isEmpty {
            args.append(contentsOf: ["--model", modelId])
        }

        if let effort = input.configOptions["effort"], !effort.isEmpty {
            args.append(contentsOf: ["--effort", effort])
        }

        if let resumeId = input.resumeSessionId, !resumeId.isEmpty {
            args.append(contentsOf: ["--resume", resumeId])
        }

        var env = input.environment
        for (key, value) in Self.containmentEnvironment {
            env[key] = value
        }

        return EngineSpawnSpec(
            executable: executable,
            arguments: args,
            workingDirectory: input.workingDirectory,
            environment: env
        )
    }

    /// Builds the newline-delimited stream-json user message written to Claude Code's stdin.
    public static func buildUserStdinFrame(prompt: String, uuid: String = UUID().uuidString) -> String {
        let safeContent = neutralizeLeadingSlash(prompt)
        let payload: [String: Any] = [
            "type": "user",
            "uuid": uuid,
            "message": [
                "role": "user",
                "content": safeContent
            ]
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else {
            return #"{"type":"user","message":{"role":"user","content":""}}"#
        }
        return json
    }

    /// Neutralizes a leading slash on ordinary prompts so a user message starting with `/model` or `/advisor`
    /// is not interpreted as a local CLI slash command.
    public static func neutralizeLeadingSlash(_ text: String) -> String {
        if text.hasPrefix("/") {
            return "\u{200B}" + text
        }
        return text
    }

    public func sendTurn(input: TurnInput) async throws -> AsyncStream<TurnEvent> {
        guard activeSessions[input.threadId] == nil else {
            throw EngineDriverError.turnAlreadyActive(threadId: input.threadId)
        }

        let spec = Self.buildSpawnSpec(executable: executable, input: input)
        let session = try await launcher.launch(spec: spec, threadId: input.threadId, engineId: engineId)
        activeSessions[input.threadId] = session

        let userFrame = Self.buildUserStdinFrame(prompt: input.prompt)
        try await session.writeStdinLine(userFrame)
        await session.closeStdin()

        let (stream, continuation) = AsyncStream<TurnEvent>.makeStream()
        let threadId = input.threadId
        let requestedModel = input.modelId

        Task { [weak self] in
            var parserState = ClaudeStreamParserState(requestedModel: requestedModel)
            var stderrTail = ""

            let stderrTask = Task {
                for await chunk in session.stderrChunks {
                    stderrTail += chunk
                    if stderrTail.count > 4096 {
                        stderrTail = String(stderrTail.suffix(4096))
                    }
                }
            }

            for await line in session.stdoutLines {
                let events = Self.parseLine(line, state: &parserState)
                for event in events {
                    continuation.yield(event)
                }
            }

            await stderrTask.value
            let exitReason = await session.waitForExit()

            if !parserState.sawTerminalEvent {
                switch exitReason {
                case .signaled(let sig):
                    continuation.yield(.error(code: "process_signal", message: "Claude CLI terminated by signal \(sig)"))
                case .exited(let code) where code != 0:
                    let suffix = stderrTail.trimmingCharacters(in: .whitespacesAndNewlines)
                    let msg = suffix.isEmpty ? "Claude CLI exited with code \(code)" : "Claude CLI exited with code \(code): \(suffix)"
                    continuation.yield(.error(code: "process_exit", message: msg))
                case .cancelled:
                    continuation.yield(.error(code: "cancelled", message: "Claude turn was cancelled"))
                case .spawnFailed(let msg):
                    continuation.yield(.error(code: "spawn_error", message: msg))
                case .exited:
                    break
                }
            }

            await self?.clearSession(threadId: threadId)
            continuation.finish()
        }

        return stream
    }

    public func cancelTurn(threadId: String) async {
        guard let session = activeSessions.removeValue(forKey: threadId) else { return }
        await session.cancel()
    }

    private func clearSession(threadId: String) {
        activeSessions.removeValue(forKey: threadId)
    }

    // MARK: - Stateful Stream-JSON Line Parser

    public struct ClaudeStreamParserState: Sendable {
        public var requestedModel: String?
        public var sawStreamDelta: Bool = false
        public var sawSyntheticError: Bool = false
        public var sawTerminalEvent: Bool = false
        public var streamingToolId: String?
        public var streamingToolName: String?
        public var streamingToolArgsBuffer: String = ""
        public var emittedToolCallIds: Set<String> = []

        public init(requestedModel: String? = nil) {
            self.requestedModel = requestedModel
        }
    }

    /// Parses a single newline-delimited Claude Code `stream-json` line into zero or more `TurnEvent`s.
    public static func parseLine(_ line: String, state: inout ClaudeStreamParserState) -> [TurnEvent] {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let data = trimmed.data(using: .utf8),
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = root["type"] as? String else {
            return []
        }

        // Ignore subagent narration deltas when `parent_tool_use_id` is non-null on `stream_event` frames.
        let parentToolUseId = root["parent_tool_use_id"] as? String
        var events: [TurnEvent] = []

        switch type {
        case "system":
            let subtype = root["subtype"] as? String
            if subtype == "init", let sessionId = root["session_id"] as? String, !sessionId.isEmpty {
                events.append(.sessionStarted(sessionId: sessionId))
            }

        case "stream_event":
            if parentToolUseId != nil {
                break
            }
            guard let ev = root["event"] as? [String: Any],
                  let evType = ev["type"] as? String else {
                break
            }
            switch evType {
            case "content_block_start":
                if let block = ev["content_block"] as? [String: Any],
                   (block["type"] as? String) == "tool_use",
                   let id = block["id"] as? String,
                   let name = block["name"] as? String {
                    state.streamingToolId = id
                    state.streamingToolName = name
                    state.streamingToolArgsBuffer = ""
                }
            case "content_block_delta":
                guard let delta = ev["delta"] as? [String: Any],
                      let deltaType = delta["type"] as? String else {
                    break
                }
                if deltaType == "text_delta", let text = delta["text"] as? String, !text.isEmpty {
                    state.sawStreamDelta = true
                    events.append(.textDelta(text))
                } else if deltaType == "thinking_delta", let thinking = delta["thinking"] as? String, !thinking.isEmpty {
                    events.append(.reasoningDelta(thinking))
                } else if deltaType == "input_json_delta", let partial = delta["partial_json"] as? String {
                    state.streamingToolArgsBuffer += partial
                }
            case "content_block_stop":
                if let toolId = state.streamingToolId,
                   let toolName = state.streamingToolName,
                   !state.emittedToolCallIds.contains(toolId) {
                    let argsJSON = state.streamingToolArgsBuffer.isEmpty ? "{}" : state.streamingToolArgsBuffer
                    state.emittedToolCallIds.insert(toolId)
                    events.append(.toolCall(id: toolId, name: toolName, argumentsJSON: argsJSON))
                }
                state.streamingToolId = nil
                state.streamingToolName = nil
                state.streamingToolArgsBuffer = ""
            default:
                break
            }

        case "assistant":
            let message = (root["message"] as? [String: Any]) ?? [:]
            let contentArray = (message["content"] as? [[String: Any]]) ?? []
            let combinedText = extractText(from: contentArray)

            // Synthetic-assistant-message guard: detect `<synthetic>` model or explicit error markers
            // so CLI-generated error apologies map to `.error(...)` rather than assistant chat text.
            if let syntheticError = detectSyntheticError(root: root, message: message, text: combinedText, requestedModel: state.requestedModel) {
                state.sawSyntheticError = true
                state.sawTerminalEvent = true
                events.append(.error(code: syntheticError.code, message: syntheticError.message))
                break
            }

            if parentToolUseId == nil && !combinedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                if !state.sawStreamDelta {
                    events.append(.textDelta(combinedText))
                }
                state.sawStreamDelta = false
            }

            // Extract thinking blocks when not already streamed, plus tool_use blocks.
            for block in contentArray {
                let blockType = block["type"] as? String
                if blockType == "thinking",
                   let thinking = block["thinking"] as? String,
                   !thinking.isEmpty,
                   !state.sawStreamDelta {
                    // Only emit if no streaming deltas preceded the whole message.
                } else if blockType == "tool_use",
                          let id = block["id"] as? String,
                          let name = block["name"] as? String,
                          !state.emittedToolCallIds.contains(id) {
                    let argsJSON = canonicalJSONString(from: block["input"])
                    state.emittedToolCallIds.insert(id)
                    events.append(.toolCall(id: id, name: name, argumentsJSON: argsJSON))
                }
            }

        case "user":
            let message = (root["message"] as? [String: Any]) ?? [:]
            let contentArray = (message["content"] as? [[String: Any]]) ?? []
            for block in contentArray {
                if (block["type"] as? String) == "tool_result",
                   let toolUseId = block["tool_use_id"] as? String {
                    let isError = (block["is_error"] as? Bool) ?? false
                    let output = extractToolResultOutput(block["content"])
                    events.append(.toolResult(id: toolUseId, output: output, isError: isError))
                }
            }

        case "result":
            let isError = (root["is_error"] as? Bool) ?? false
            let usage = root["usage"] as? [String: Any]
            let inputTokens = extractInputTokens(from: usage)
            let outputTokens = usage?["output_tokens"] as? Int

            if isError {
                state.sawTerminalEvent = true
                if !state.sawSyntheticError {
                    let apiStatus = root["api_error_status"] as? Int
                    let code: String
                    if apiStatus == 404 {
                        code = "unknown_model"
                    } else if apiStatus == 429 {
                        code = "rate_limited"
                    } else {
                        code = (root["terminal_reason"] as? String)
                            ?? (root["stop_reason"] as? String)
                            ?? (root["subtype"] as? String)
                            ?? "claude_error"
                    }
                    let msg = (root["result"] as? String)
                        ?? (root["error"] as? String)
                        ?? "Claude turn failed"
                    events.append(.error(code: code, message: msg))
                }
            } else {
                state.sawTerminalEvent = true
                let stopReason = (root["stop_reason"] as? String)
                    ?? (root["terminal_reason"] as? String)
                    ?? (root["subtype"] as? String)
                    ?? "end_turn"
                events.append(.completed(stopReason: stopReason, inputTokens: inputTokens, outputTokens: outputTokens))
            }

        case "error":
            state.sawTerminalEvent = true
            let errObj = root["error"] as? [String: Any]
            let code = (errObj?["type"] as? String) ?? (root["code"] as? String) ?? "claude_error"
            let message = (errObj?["message"] as? String) ?? (root["message"] as? String) ?? "Claude stream error"
            events.append(.error(code: code, message: message))

        default:
            break
        }

        return events
    }

    private static func extractText(from blocks: [[String: Any]]) -> String {
        blocks.compactMap { block -> String? in
            guard (block["type"] as? String) == "text" else { return nil }
            return block["text"] as? String
        }.joined()
    }

    private static func detectSyntheticError(
        root: [String: Any],
        message: [String: Any],
        text: String,
        requestedModel: String?
    ) -> (code: String, message: String)? {
        let topError = (root["error"] as? String) ?? (message["error"] as? String)
        let modelField = message["model"] as? String
        let usage = message["usage"] as? [String: Any]
        let outputTokens = (usage?["output_tokens"] as? Int) ?? 0
        let isSynthetic = (modelField == "<synthetic>") || (outputTokens == 0 && topError != nil)
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

        if topError == "model_not_found" ||
            (isSynthetic && trimmed.hasPrefix("There's an issue with the selected model")) {
            let detail = trimmed.isEmpty
                ? "Claude can't use \(requestedModel ?? "the selected model")."
                : trimmed
            return ("unknown_model", detail)
        }

        if let topError, !topError.isEmpty {
            let detail = trimmed.isEmpty ? "Claude error: \(topError)" : trimmed
            return (topError, detail)
        }

        if modelField == "<synthetic>" && !trimmed.isEmpty {
            let lower = trimmed.lowercased()
            if lower.contains("invalid api key") || lower.contains("not logged in") || lower.contains("authentication") {
                return ("auth_required", trimmed)
            }
            if lower.contains("rate limit") || lower.contains("429") {
                return ("rate_limited", trimmed)
            }
            return ("synthetic_error", trimmed)
        }

        return nil
    }

    private static func extractToolResultOutput(_ content: Any?) -> String {
        if let str = content as? String {
            return str
        }
        if let arr = content as? [[String: Any]] {
            let texts = arr.compactMap { item -> String? in
                if (item["type"] as? String) == "text", let t = item["text"] as? String {
                    return t
                }
                return nil
            }
            if !texts.isEmpty {
                return texts.joined(separator: "\n")
            }
        }
        return canonicalJSONString(from: content)
    }

    private static func extractInputTokens(from usage: [String: Any]?) -> Int? {
        guard let usage else { return nil }
        let input = (usage["input_tokens"] as? Int) ?? 0
        let cacheRead = (usage["cache_read_input_tokens"] as? Int) ?? 0
        let cacheWrite = (usage["cache_creation_input_tokens"] as? Int) ?? 0
        let total = input + cacheRead + cacheWrite
        if total == 0 && usage["input_tokens"] == nil {
            return nil
        }
        return total
    }

    public static func canonicalJSONString(from value: Any?) -> String {
        guard let value else { return "{}" }
        if let str = value as? String {
            return str
        }
        if JSONSerialization.isValidJSONObject(value),
           let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]),
           let json = String(data: data, encoding: .utf8) {
            return json
        }
        return "{}"
    }
}
