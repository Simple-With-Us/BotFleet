import Foundation

/// Approval decision for Codex app-server server-to-client approval requests.
public enum CodexApprovalDecision: Equatable, Sendable {
    case accept
    case decline
}

/// Native Swift runner for the OpenAI Codex CLI headless `app-server` protocol (`codex app-server`).
/// Speaks newline-delimited JSON-RPC 2.0 over stdio, handling `initialize`, `thread/start` / `thread/resume`,
/// `turn/start`, streaming item deltas, tool executions, bidirectional approval requests, and `turn/completed`.
public actor CodexAppServerRunner: EngineDriver {
    public typealias ApprovalHandler = @Sendable (
        _ requestId: String,
        _ tool: String,
        _ description: String
    ) async -> CodexApprovalDecision

    public nonisolated let engineId: String
    public nonisolated let executable: String
    private let launcher: any EngineProcessLauncher
    private let approvalHandler: ApprovalHandler?
    private var activeSessions: [String: EngineProcessSession] = [:]
    /// Identifies the turn that owns each registered session, so a turn that is winding down cannot
    /// clear a newer turn's session for the same thread.
    private var activeSessionTokens: [String: UUID] = [:]

    /// Outcome fields excluded when serializing a Codex tool item's input arguments,
    /// matching `CODEX_ITEM_OUTCOME_FIELDS` in `server/drivers/codex.ts`.
    public static let itemOutcomeFields: Set<String> = [
        "id",
        "status",
        "aggregatedOutput",
        "output",
        "result",
        "error",
        "exitCode",
        "durationMs"
    ]

    public init(
        engineId: String = "codex",
        executable: String = "codex",
        launcher: any EngineProcessLauncher = ProcessSupervisorActor(),
        approvalHandler: ApprovalHandler? = nil
    ) {
        self.engineId = engineId
        self.executable = executable
        self.launcher = launcher
        self.approvalHandler = approvalHandler
    }

    /// Builds the verified spawn specification for Codex `app-server` over stdio.
    public static func buildSpawnSpec(executable: String = "codex", input: TurnInput) -> EngineSpawnSpec {
        var args = ["app-server"]
        if let effort = input.configOptions["effort"], !effort.isEmpty {
            args.append(contentsOf: ["-c", "model_reasoning_effort=\"\(effort)\""])
        }
        var env = input.environment
        // Strip ambient OPENAI_API_KEY so the CLI uses its ChatGPT subscription login unless explicitly overridden.
        let keepOpenAIKey = input.configOptions["keepOpenAIKey"] == "true"
        if !keepOpenAIKey {
            env.removeValue(forKey: "OPENAI_API_KEY")
        }
        env["NPM_CONFIG_LOGLEVEL"] = "error"
        return EngineSpawnSpec(
            executable: executable,
            arguments: args,
            workingDirectory: input.workingDirectory,
            environment: env,
            unsetEnvironmentKeys: keepOpenAIKey ? [] : ["OPENAI_API_KEY"]
        )
    }

    public func sendTurn(input: TurnInput) async throws -> AsyncStream<TurnEvent> {
        guard activeSessions[input.threadId] == nil else {
            throw EngineDriverError.turnAlreadyActive(threadId: input.threadId)
        }

        let spec = Self.buildSpawnSpec(executable: executable, input: input)
        let session = try await launcher.launch(spec: spec, threadId: input.threadId, engineId: engineId)
        let sessionToken = UUID()
        activeSessions[input.threadId] = session
        activeSessionTokens[input.threadId] = sessionToken

        let (stream, continuation) = AsyncStream<TurnEvent>.makeStream()
        let threadId = input.threadId
        let handler = approvalHandler
        let fullAuto = input.configOptions["fullAuto"] == "true"

        Task { [weak self] in
            let coordinator = CodexRpcCoordinator(
                session: session,
                continuation: continuation,
                approvalHandler: handler,
                fullAuto: fullAuto
            )

            let readerTask = Task {
                for await line in session.stdoutLines {
                    await coordinator.handleInboundLine(line)
                }
                await coordinator.handleStdoutEOF()
            }

            do {
                // 1. Handshake: initialize + initialized notification.
                _ = try await coordinator.sendRequest(
                    method: "initialize",
                    params: [
                        "clientInfo": [
                            "name": "botfleet",
                            "version": "2"
                        ]
                    ]
                )
                try await coordinator.sendNotification(method: "initialized", params: [:])

                // 2. Resume or start thread.
                let cwd = input.workingDirectory ?? "/tmp"
                let codexThreadId: String
                if let resumeId = input.resumeSessionId, !resumeId.isEmpty {
                    let resumed = try await coordinator.sendRequest(
                        method: "thread/resume",
                        params: ["threadId": resumeId]
                    )
                    let threadObj = resumed["thread"] as? [String: Any]
                    codexThreadId = (threadObj?["id"] as? String) ?? resumeId
                } else {
                    var startParams: [String: Any] = [
                        "cwd": cwd,
                        "sandbox": fullAuto ? "danger-full-access" : "workspace-write",
                        "approvalPolicy": fullAuto ? "never" : "on-request",
                        "ephemeral": false
                    ]
                    if let modelId = input.modelId, !modelId.isEmpty {
                        startParams["model"] = modelId
                    }
                    let started = try await coordinator.sendRequest(
                        method: "thread/start",
                        params: startParams
                    )
                    let threadObj = started["thread"] as? [String: Any]
                    guard let id = (threadObj?["id"] as? String) ?? (started["threadId"] as? String), !id.isEmpty else {
                        throw EngineDriverError.protocolError(code: "missing_thread_id", message: "thread/start returned no thread id")
                    }
                    codexThreadId = id
                }

                await coordinator.setCodexThreadId(codexThreadId)
                continuation.yield(.sessionStarted(sessionId: codexThreadId))

                // 3. Kick off the turn and await `turn/completed` notification.
                _ = try await coordinator.sendRequest(
                    method: "turn/start",
                    params: [
                        "threadId": codexThreadId,
                        "input": [
                            [
                                "type": "text",
                                "text": input.prompt
                            ]
                        ]
                    ]
                )

                await coordinator.waitForTurnCompletion()
            } catch let error as EngineDriverError {
                switch error {
                case .protocolError(let code, let message):
                    await coordinator.settleWithError(code: code, message: message)
                case .cancelled:
                    await coordinator.settleWithError(code: "cancelled", message: "Codex turn was cancelled")
                default:
                    await coordinator.settleWithError(code: "codex_error", message: error.localizedDescription)
                }
            } catch {
                await coordinator.settleWithError(code: "codex_error", message: error.localizedDescription)
            }

            await session.closeStdin()
            readerTask.cancel()
            _ = await session.waitForExit()
            // Release the thread before the stream ends so a consumer that retries the moment the stream
            // closes is not told a turn is still active.
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
        // Only the turn that registered the session may clear it: a cancelled turn winds down after the
        // cancel, and by then a newer turn may already own the thread.
        guard activeSessionTokens[threadId] == token else { return }
        activeSessions.removeValue(forKey: threadId)
        activeSessionTokens.removeValue(forKey: threadId)
    }
}

// MARK: - Internal Codex App-Server JSON-RPC Coordinator

private actor CodexRpcCoordinator {
    private let session: EngineProcessSession
    private let continuation: AsyncStream<TurnEvent>.Continuation
    private let approvalHandler: CodexAppServerRunner.ApprovalHandler?
    private let fullAuto: Bool

    private var nextId: Int = 1
    private var pendingRequests: [Int: CheckedContinuation<[String: Any], Error>] = [:]
    private var turnCompletionWaiters: [CheckedContinuation<Void, Never>] = []
    private var codexThreadId: String?
    private var sawStreamDelta: Bool = false
    private var settled: Bool = false
    private var trackedInputTokens: Int?
    private var trackedOutputTokens: Int?

    init(
        session: EngineProcessSession,
        continuation: AsyncStream<TurnEvent>.Continuation,
        approvalHandler: CodexAppServerRunner.ApprovalHandler?,
        fullAuto: Bool
    ) {
        self.session = session
        self.continuation = continuation
        self.approvalHandler = approvalHandler
        self.fullAuto = fullAuto
    }

    func setCodexThreadId(_ id: String) {
        codexThreadId = id
    }

    func sendRequest(method: String, params: [String: Any]) async throws -> [String: Any] {
        let requestId = nextId
        nextId += 1
        let payload: [String: Any] = [
            "jsonrpc": "2.0",
            "id": requestId,
            "method": method,
            "params": params
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
              let line = String(data: data, encoding: .utf8) else {
            throw EngineDriverError.protocolError(code: "encode_error", message: "Failed to encode Codex request \(method)")
        }

        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<[String: Any], Error>) in
            pendingRequests[requestId] = cont
            Task {
                do {
                    try await session.writeStdinLine(line)
                } catch {
                    self.failPendingRequest(id: requestId, error: error)
                }
            }
        }
    }

    func sendNotification(method: String, params: [String: Any]) async throws {
        let payload: [String: Any] = [
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
              let line = String(data: data, encoding: .utf8) else {
            return
        }
        try await session.writeStdinLine(line)
    }

    func waitForTurnCompletion() async {
        if settled { return }
        await withCheckedContinuation { cont in
            if settled {
                cont.resume()
            } else {
                turnCompletionWaiters.append(cont)
            }
        }
    }

    func settleWithError(code: String, message: String) {
        guard !settled else { return }
        settled = true
        continuation.yield(.error(code: code, message: message))
        resumeCompletionWaiters()
    }

    func handleStdoutEOF() {
        let remaining = pendingRequests
        pendingRequests.removeAll()
        for (_, cont) in remaining {
            cont.resume(throwing: EngineDriverError.protocolError(code: "eof_before_result", message: "Codex app-server closed stdout before completing RPC"))
        }
        if !settled {
            settled = true
            continuation.yield(.error(code: "eof_before_result", message: "Codex app-server exited before turn/completed"))
            resumeCompletionWaiters()
        }
    }

    private func failPendingRequest(id: Int, error: Error) {
        if let cont = pendingRequests.removeValue(forKey: id) {
            cont.resume(throwing: error)
        }
    }

    private func resumeCompletionWaiters() {
        let waiters = turnCompletionWaiters
        turnCompletionWaiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }
    }

    func handleInboundLine(_ line: String) async {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let data = trimmed.data(using: .utf8),
              let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return
        }

        let idValue = Self.extractIntId(msg["id"])
        let hasResult = msg["result"] != nil
        let hasError = msg["error"] != nil
        let method = msg["method"] as? String

        if let id = idValue, (hasResult || hasError) {
            guard let cont = pendingRequests.removeValue(forKey: id) else { return }
            if let errObj = msg["error"] as? [String: Any] {
                let codeNum = errObj["code"] as? Int
                let message = (errObj["message"] as? String) ?? "Codex JSON-RPC error"
                let codeStr = Self.mapCodexErrorCode(code: codeNum, message: message)
                // Settle the turn here rather than leaving it to the awaiting caller.  The
                // app-server can close stdout right behind the error frame, and the EOF path
                // would otherwise report a generic `eof_before_result` ahead of the real cause.
                settleWithError(code: codeStr, message: message)
                cont.resume(throwing: EngineDriverError.protocolError(code: codeStr, message: message))
            } else {
                let resultDict = (msg["result"] as? [String: Any]) ?? [:]
                cont.resume(returning: resultDict)
            }
        } else if msg["id"] != nil, let method {
            await handleServerRequest(msg: msg, method: method)
        } else if let method {
            handleNotification(msg: msg, method: method)
        }
    }

    private func handleServerRequest(msg: [String: Any], method: String) async {
        let rawId = msg["id"] ?? 0
        let params = (msg["params"] as? [String: Any]) ?? [:]
        let isLegacy = (method == "execCommandApproval" || method == "applyPatchApproval")
        let meta = params["_meta"] as? [String: Any]
        let isMcpElicitation = (method == "mcpServer/elicitation/request") && ((meta?["codex_approval_kind"] as? String) == "mcp_tool_call")

        let toolName: String
        if isMcpElicitation {
            toolName = (params["tool"] as? String) ?? "mcp"
        } else if method == "item/fileChange/requestApproval" || method == "applyPatchApproval" {
            toolName = "edit"
        } else if method == "item/tool/requestUserInput" {
            toolName = "ask_user"
        } else {
            toolName = "shell"
        }

        let description = (params["command"] as? String)
            ?? (params["reason"] as? String)
            ?? (params["message"] as? String)
            ?? toolName
        let reqId = (params["itemId"] as? String)
            ?? (params["callId"] as? String)
            ?? "approval-\(rawId)"

        continuation.yield(.permissionRequest(id: reqId, tool: toolName, description: description))

        let decision: CodexApprovalDecision
        if fullAuto && method != "item/tool/requestUserInput" {
            decision = .accept
        } else if let approvalHandler {
            decision = await approvalHandler(reqId, toolName, description)
        } else {
            decision = .decline
        }

        let resultPayload: [String: Any]
        if isMcpElicitation {
            resultPayload = decision == .accept
                ? ["action": "accept", "content": [:] as [String: Any]]
                : ["action": "decline"]
        } else {
            let word: String
            switch (decision, isLegacy) {
            case (.accept, true): word = "approved"
            case (.accept, false): word = "accept"
            case (.decline, true): word = "denied"
            case (.decline, false): word = "decline"
            }
            resultPayload = ["decision": word]
        }

        let response: [String: Any] = [
            "jsonrpc": "2.0",
            "id": rawId,
            "result": resultPayload
        ]
        if let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]),
           let json = String(data: data, encoding: .utf8) {
            try? await session.writeStdinLine(json)
        }
    }

    private func handleNotification(msg: [String: Any], method: String) {
        guard !settled else { return }
        let params = (msg["params"] as? [String: Any]) ?? [:]

        // Filter out helper-thread notifications unless they are tool items, matching `server/drivers/codex.ts`.
        if let notifiedThread = params["threadId"] as? String,
           !notifiedThread.isEmpty,
           let currentThread = codexThreadId,
           notifiedThread != currentThread {
            return
        }

        switch method {
        case "item/agentMessage/delta":
            if let delta = params["delta"] as? String, !delta.isEmpty {
                sawStreamDelta = true
                continuation.yield(.textDelta(delta))
            }

        case "item/reasoning/textDelta", "item/reasoning/summaryTextDelta":
            if let delta = params["delta"] as? String, !delta.isEmpty {
                continuation.yield(.reasoningDelta(delta))
            }

        case "item/started":
            guard let item = params["item"] as? [String: Any],
                  let title = Self.toolTitle(for: item) else {
                break
            }
            let itemId = (item["id"] as? String) ?? "item-\(nextId)"
            let inputDict = Self.extractItemInput(from: item)
            let argsJSON = ClaudeStreamRunner.canonicalJSONString(from: inputDict)
            continuation.yield(.toolCall(id: itemId, name: title, argumentsJSON: argsJSON))

        case "item/completed":
            guard let item = params["item"] as? [String: Any],
                  let itemType = item["type"] as? String else {
                break
            }
            if itemType == "agentMessage" {
                if let text = item["text"] as? String,
                   !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    if !sawStreamDelta {
                        continuation.yield(.textDelta(text))
                    }
                    sawStreamDelta = false
                }
            } else if Self.toolTitle(for: item) != nil {
                let itemId = (item["id"] as? String) ?? "item"
                let status = (item["status"] as? String) ?? "completed"
                let isError = (status == "failed" || status == "declined")
                let rawOut = item["aggregatedOutput"] ?? item["output"] ?? item["result"] ?? item["error"]
                let outputText: String
                if let str = rawOut as? String {
                    outputText = str
                } else if let dict = rawOut as? [String: Any], let msg = dict["message"] as? String {
                    outputText = msg
                } else if rawOut != nil {
                    outputText = ClaudeStreamRunner.canonicalJSONString(from: rawOut)
                } else {
                    outputText = ""
                }
                continuation.yield(.toolResult(id: itemId, output: outputText, isError: isError))
            }

        case "thread/tokenUsage/updated":
            let tokenUsage = params["tokenUsage"] as? [String: Any]
            let usageSource = (tokenUsage?["last"] as? [String: Any]) ?? (tokenUsage?["total"] as? [String: Any])
            if let usageSource {
                if let input = usageSource["inputTokens"] as? Int {
                    trackedInputTokens = input
                }
                if let output = usageSource["outputTokens"] as? Int {
                    trackedOutputTokens = output
                }
            }

        case "turn/completed":
            let turnObj = (params["turn"] as? [String: Any]) ?? [:]
            let status = (turnObj["status"] as? String) ?? "completed"
            if let usage = turnObj["usage"] as? [String: Any] {
                if let input = (usage["inputTokens"] as? Int) ?? (usage["input_tokens"] as? Int) {
                    trackedInputTokens = input
                }
                if let output = (usage["outputTokens"] as? Int) ?? (usage["output_tokens"] as? Int) {
                    trackedOutputTokens = output
                }
            }
            if status == "completed" {
                settled = true
                let stopReason = (turnObj["stopReason"] as? String) ?? "completed"
                continuation.yield(.completed(
                    stopReason: stopReason,
                    inputTokens: trackedInputTokens,
                    outputTokens: trackedOutputTokens
                ))
                resumeCompletionWaiters()
            } else {
                let errObj = turnObj["error"] as? [String: Any]
                let reason = (errObj?["message"] as? String) ?? status
                let code = Self.mapCodexErrorCode(code: errObj?["code"] as? Int, message: reason)
                settleWithError(code: code, message: reason)
            }

        case "error":
            let errObj = params["error"] as? [String: Any]
            let message = (params["message"] as? String) ?? (errObj?["message"] as? String) ?? "Codex error"
            let code = Self.mapCodexErrorCode(code: errObj?["code"] as? Int, message: message)
            settleWithError(code: code, message: message)

        default:
            break
        }
    }

    private static func toolTitle(for item: [String: Any]) -> String? {
        guard let type = item["type"] as? String else { return nil }
        switch type {
        case "commandExecution":
            return (item["command"] as? String) ?? "shell"
        case "fileChange":
            return "edit"
        case "mcpToolCall":
            return (item["tool"] as? String) ?? (item["name"] as? String) ?? "mcp"
        case "webSearch":
            return "web_search"
        case "collabAgentToolCall":
            if (item["tool"] as? String) == "spawnAgent" {
                return "spawn_agent"
            }
            return nil
        default:
            return nil
        }
    }

    private static func extractItemInput(from item: [String: Any]) -> [String: Any] {
        var filtered: [String: Any] = [:]
        for (key, value) in item where !CodexAppServerRunner.itemOutcomeFields.contains(key) {
            filtered[key] = value
        }
        return filtered
    }

    private static func extractIntId(_ raw: Any?) -> Int? {
        if let intVal = raw as? Int { return intVal }
        if let num = raw as? NSNumber { return num.intValue }
        if let str = raw as? String, let intVal = Int(str) { return intVal }
        return nil
    }

    private static func mapCodexErrorCode(code: Int?, message: String) -> String {
        let lower = message.lowercased()
        if lower.contains("unknown model") || lower.contains("model_not_found") || lower.contains("model is not supported") {
            return "unknown_model"
        }
        if lower.contains("no rollout found for thread id") {
            return "resume_failed"
        }
        if lower.contains("not logged in") || lower.contains("unauthorized") || lower.contains("invalid_api_key") {
            return "auth_required"
        }
        if lower.contains("rate limit") || lower.contains("429") {
            return "rate_limited"
        }
        return code.map { "rpc_\($0)" } ?? "codex_error"
    }
}
