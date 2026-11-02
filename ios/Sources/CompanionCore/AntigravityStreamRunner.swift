import Foundation

// MARK: - Antigravity (`agy`) Native Stream-JSON Driver

/// Native Swift `EngineDriver` for Google's Antigravity CLI (`agy --print --output-format stream-json`).
public actor AntigravityStreamRunner: EngineDriver {
    public nonisolated let engineId: String
    public nonisolated let executable: String
    private let launcher: any EngineProcessLauncher
    private var activeSessions: [String: EngineProcessSession] = [:]
    private var activeSessionTokens: [String: UUID] = [:]

    /// Prompts up to 64 KiB pass on `argv` (`--print <prompt>`); larger prompts pass `--print -` and pipe over `stdin`.
    public static let maxArgvPromptUTF8Bytes = 64 * 1024

    public init(
        engineId: String = "antigravity",
        executable: String = "agy",
        launcher: any EngineProcessLauncher = ProcessSupervisorActor()
    ) {
        self.engineId = engineId
        self.executable = executable
        self.launcher = launcher
    }

    // MARK: - Spawn Specification Builder

    /// Builds the `EngineSpawnSpec` for an Antigravity (`agy`) headless print-mode turn.
    public static func buildSpawnSpec(
        executable: String = "agy",
        input: TurnInput
    ) -> EngineSpawnSpec {
        let useStdin = input.prompt.utf8.count > maxArgvPromptUTF8Bytes
        var args: [String] = useStdin ? ["--print", "-"] : ["--print", input.prompt]

        let printTimeoutSeconds = Int(input.configOptions["printTimeoutSeconds"] ?? "") ?? 600
        let timeoutMinutes = EngineMatrixRegistry.antigravityPrintTimeoutMinutes(for: printTimeoutSeconds)
        let workspacePath = input.workingDirectory ?? "/tmp"

        args.append(contentsOf: [
            "--output-format", "stream-json",
            "--print-timeout", "\(timeoutMinutes)m",
            "--add-dir", workspacePath
        ])

        let controlsHostMac = (input.configOptions["controlsHostMac"] == "true")
        let fullAuto = (input.configOptions["fullAuto"] == "true") && !controlsHostMac
        if fullAuto {
            args.append("--dangerously-skip-permissions")
        } else {
            args.append(contentsOf: ["--mode", "accept-edits"])
        }

        let trimmedModel = input.modelId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let selectedModel = trimmedModel.isEmpty
            ? EngineMatrixRegistry.descriptor(for: .antigravity).defaultModel
            : trimmedModel
        args.append(contentsOf: ["--model", selectedModel])

        if let resumeId = input.resumeSessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
           !resumeId.isEmpty {
            args.append(contentsOf: ["--conversation", resumeId])
        }

        return EngineSpawnSpec(
            executable: executable,
            arguments: args,
            workingDirectory: input.workingDirectory,
            environment: input.environment
        )
    }

    // MARK: - EngineDriver Conformance

    public func sendTurn(input: TurnInput) async throws -> AsyncStream<TurnEvent> {
        try input.toolPreparation?.validate(forBot: input.botId)
        guard activeSessions[input.threadId] == nil else {
            throw EngineDriverError.turnAlreadyActive(threadId: input.threadId)
        }

        let spec = Self.buildSpawnSpec(executable: executable, input: input)
        let session = try await launcher.launch(spec: spec, threadId: input.threadId, engineId: engineId)
        let sessionToken = UUID()
        activeSessions[input.threadId] = session
        activeSessionTokens[input.threadId] = sessionToken

        let useStdin = input.prompt.utf8.count > Self.maxArgvPromptUTF8Bytes
        if useStdin {
            do {
                try await session.writeStdinLine(input.prompt)
            } catch {
                activeSessions.removeValue(forKey: input.threadId)
                activeSessionTokens.removeValue(forKey: input.threadId)
                await session.cancel()
                throw error
            }
        }
        await session.closeStdin()

        let (stream, continuation) = AsyncStream<TurnEvent>.makeStream()
        let threadId = input.threadId
        let controlsHostMac = (input.configOptions["controlsHostMac"] == "true")
        let isAutoApproved = (input.configOptions["isAutoApproved"] == "true")
            || ((input.configOptions["fullAuto"] == "true") && !controlsHostMac)

        Task { [weak self] in
            var parserState = AntigravityStreamParserState(
                controlsHostMac: controlsHostMac,
                isAutoApproved: isAutoApproved
            )
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
                if parserState.hostPolicyRefused {
                    await session.cancel()
                    break
                }
            }

            await stderrTask.value
            let exitReason = await session.waitForExit()

            if !parserState.sawTerminalEvent {
                switch exitReason {
                case .signaled(let sig):
                    continuation.yield(.error(code: "process_signal", message: "Antigravity CLI terminated by signal \(sig)"))
                case .exited(let code) where code != 0:
                    let suffix = stderrTail.trimmingCharacters(in: .whitespacesAndNewlines)
                    let msg = suffix.isEmpty
                        ? "Antigravity CLI exited with code \(code)"
                        : "Antigravity CLI exited with code \(code): \(suffix)"
                    continuation.yield(.error(code: "process_exit", message: msg))
                case .cancelled:
                    continuation.yield(.error(code: "cancelled", message: "Antigravity turn was cancelled"))
                case .spawnFailed(let msg):
                    continuation.yield(.error(code: "spawn_error", message: msg))
                case .exited:
                    break
                }
            }

            await self?.clearSession(threadId: threadId, token: sessionToken)
            continuation.finish()
        }

        return stream
    }

    public func cancelTurn(threadId: String) async {
        guard let session = activeSessions.removeValue(forKey: threadId) else { return }
        activeSessionTokens.removeValue(forKey: threadId)
        await session.cancel()
    }

    private func clearSession(threadId: String, token: UUID) {
        guard activeSessionTokens[threadId] == token else { return }
        activeSessions.removeValue(forKey: threadId)
        activeSessionTokens.removeValue(forKey: threadId)
    }

    // MARK: - Stateful Stream-JSON Line Parser

    public struct AntigravityStreamParserState: Sendable {
        public let controlsHostMac: Bool
        public let isAutoApproved: Bool
        public var conversationId: String?
        public var streamedAssistantText: String = ""
        public var hostPolicyRefused: Bool = false
        public var sawTerminalEvent: Bool = false
        public var emittedToolCallIds: Set<String> = []

        public init(
            controlsHostMac: Bool = false,
            isAutoApproved: Bool = false,
            conversationId: String? = nil
        ) {
            self.controlsHostMac = controlsHostMac
            self.isAutoApproved = isAutoApproved
            self.conversationId = conversationId
        }
    }

    /// Parses a single `agy --output-format stream-json` NDJSON line into zero or more normalized `TurnEvent`s.
    public static func parseLine(
        _ line: String,
        state: inout AntigravityStreamParserState
    ) -> [TurnEvent] {
        guard !state.hostPolicyRefused && !state.sawTerminalEvent else {
            return []
        }

        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("{"),
              let data = trimmed.data(using: .utf8),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return []
        }

        let eventKind = (json["event"] as? String) ?? (json["type"] as? String) ?? ""
        let payload = (json[eventKind] as? [String: Any]) ?? json

        switch eventKind {
        case "init":
            var events: [TurnEvent] = []
            let convId = (payload["conversation_id"] as? String)
                ?? (json["conversation_id"] as? String)
                ?? (payload["session_id"] as? String)
                ?? (json["session_id"] as? String)
            if let convId, !convId.isEmpty {
                state.conversationId = convId
                events.append(.sessionStarted(sessionId: convId))
            }

            if state.controlsHostMac && !state.isAutoApproved {
                let permissionMode = (payload["permission_mode"] as? String)
                    ?? (json["permission_mode"] as? String)
                if let refusal = AntigravityDriverPolicy.hostPolicyRefusal(for: permissionMode) {
                    state.hostPolicyRefused = true
                    state.sawTerminalEvent = true
                    events.append(.error(code: "host_control_policy", message: refusal))
                }
            }
            return events

        case "step_update":
            let stepType = (payload["step_type"] as? String) ?? (json["step_type"] as? String) ?? ""
            switch stepType {
            case "tool":
                let convPrefix = state.conversationId
                    ?? (payload["conversation_id"] as? String)
                    ?? (json["conversation_id"] as? String)
                    ?? "conv"
                let stepIndexString: String
                if let idx = (payload["step_index"] as? Int) ?? (json["step_index"] as? Int) {
                    stepIndexString = String(idx)
                } else if let idxStr = (payload["step_index"] as? String) ?? (json["step_index"] as? String),
                          !idxStr.isEmpty {
                    stepIndexString = idxStr
                } else {
                    stepIndexString = "0"
                }
                let itemId = "\(convPrefix):\(stepIndexString)"
                let stepState = ((payload["state"] as? String) ?? (json["state"] as? String) ?? "").uppercased()
                let toolInfo = (payload["tool_info"] as? [String: Any]) ?? (json["tool_info"] as? [String: Any])

                if stepState == "ACTIVE" {
                    let toolName = (payload["tool_name"] as? String)
                        ?? (toolInfo?["name"] as? String)
                        ?? (json["tool_name"] as? String)
                        ?? "tool"
                    let rawInput: Any? = toolInfo?["parameters"]
                        ?? payload["tool_input"]
                        ?? payload["input"]
                        ?? payload["args"]
                        ?? payload["parameters"]
                    let argsJSON = ClaudeStreamRunner.canonicalJSONString(from: rawInput)
                    if state.emittedToolCallIds.insert(itemId).inserted {
                        return [.toolCall(id: itemId, name: toolName, argumentsJSON: argsJSON)]
                    }
                    return []
                } else if stepState == "DONE" || stepState == "ERROR" {
                    let rawDetail: Any? = payload["output"]
                        ?? toolInfo?["output"]
                        ?? payload["result"]
                        ?? toolInfo?["result"]
                        ?? toolInfo?["error"]
                        ?? payload["error"]
                        ?? payload["content"]
                    let outputString: String
                    if let str = rawDetail as? String {
                        outputString = str
                    } else if let rawDetail {
                        outputString = ClaudeStreamRunner.canonicalJSONString(from: rawDetail)
                    } else {
                        outputString = ""
                    }
                    return [.toolResult(id: itemId, output: outputString, isError: stepState == "ERROR")]
                }
                return []

            case "agent_response":
                var events: [TurnEvent] = []
                if let thinkingDelta = (payload["thinking_delta"] as? String) ?? (payload["thinking"] as? String),
                   !thinkingDelta.isEmpty {
                    events.append(.reasoningDelta(thinkingDelta))
                }
                if let textDelta = (payload["text_delta"] as? String) ?? (json["text_delta"] as? String),
                   !textDelta.isEmpty {
                    state.streamedAssistantText += textDelta
                    events.append(.textDelta(textDelta))
                }
                return events

            case "thinking", "reasoning":
                if let thinking = (payload["thinking_delta"] as? String)
                    ?? (payload["text_delta"] as? String)
                    ?? (payload["thinking"] as? String)
                    ?? (payload["text"] as? String),
                   !thinking.isEmpty {
                    return [.reasoningDelta(thinking)]
                }
                return []

            default:
                return []
            }

        case "assistant":
            if let text = (payload["text"] as? String) ?? (json["text"] as? String),
               !text.isEmpty {
                state.streamedAssistantText += text
                return [.textDelta(text)]
            }
            return []

        case "result":
            var events: [TurnEvent] = []
            let rawStatus = (payload["status"] as? String) ?? (json["status"] as? String)
            let normalizedStatus = rawStatus?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            let isErrorFlag = (payload["is_error"] as? Bool) ?? (json["is_error"] as? Bool) ?? false
            let isSuccess = (normalizedStatus == "SUCCESS") || (normalizedStatus == nil && !isErrorFlag)

            let responseText = (payload["response"] as? String)
                ?? (json["response"] as? String)
                ?? (isSuccess ? ((payload["result"] as? String) ?? (json["result"] as? String)) : nil)
            if let responseText, !responseText.isEmpty, state.streamedAssistantText.isEmpty {
                state.streamedAssistantText += responseText
                events.append(.textDelta(responseText))
            }

            let usage = (payload["usage"] as? [String: Any]) ?? (json["usage"] as? [String: Any])
            let inputTokens: Int?
            let outputTokens: Int?
            if let usage {
                let baseInput = (usage["input_tokens"] as? Int) ?? 0
                let cacheRead = (usage["cache_read_tokens"] as? Int)
                    ?? (usage["cache_read_input_tokens"] as? Int)
                    ?? 0
                if usage["input_tokens"] != nil || usage["cache_read_tokens"] != nil || usage["cache_read_input_tokens"] != nil {
                    inputTokens = baseInput + cacheRead
                } else {
                    inputTokens = nil
                }
                outputTokens = usage["output_tokens"] as? Int
            } else {
                inputTokens = nil
                outputTokens = nil
            }

            state.sawTerminalEvent = true
            if isSuccess {
                let stopReason = (payload["stop_reason"] as? String)
                    ?? (json["stop_reason"] as? String)
                    ?? "end_turn"
                events.append(.completed(
                    stopReason: stopReason,
                    inputTokens: inputTokens,
                    outputTokens: outputTokens
                ))
            } else {
                let code = (rawStatus?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
                    .flatMap { $0.isEmpty ? nil : $0 } ?? "error"
                let rawError = ((payload["error"] as? String)
                    ?? (json["error"] as? String)
                    ?? (payload["message"] as? String)
                    ?? (payload["result"] as? String))?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let errorMessage: String
                if !rawError.isEmpty {
                    errorMessage = rawError
                } else {
                    let statusLabel = normalizedStatus ?? "ERROR"
                    errorMessage = "Antigravity: the turn ended with status \(statusLabel) and no reply"
                }
                events.append(.error(code: code, message: errorMessage))
            }
            return events

        default:
            return []
        }
    }
}
