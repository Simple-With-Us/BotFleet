import Foundation

/// Supported ACP (Agent Client Protocol) CLI harness profiles.
public enum AcpHarnessKind: String, Equatable, Sendable, Codable, CaseIterable {
    case grok = "grok"
    case mcode = "mcode"
    case muse = "muse"

    public var defaultExecutable: String {
        switch self {
        case .grok: return "grok"
        case .mcode: return "mcode"
        case .muse: return "muse"
        }
    }

    /// Builds the verified CLI arguments to enter ACP stdio mode for each engine family.
    public func buildSpawnArguments(input: TurnInput) -> [String] {
        switch self {
        case .grok:
            let permissionMode = input.configOptions["permissionMode"] ?? "default"
            var args = ["--permission-mode", permissionMode, "agent"]
            if let modelId = input.modelId, !modelId.isEmpty {
                args.append(contentsOf: ["-m", modelId])
            }
            if let effort = input.configOptions["effort"], !effort.isEmpty {
                args.append(contentsOf: ["--reasoning-effort", effort])
            }
            args.append("stdio")
            return args
        case .mcode:
            return ["acp"]
        case .muse:
            return ["acp"]
        }
    }
}

/// Decision returned by an optional permission approval callback for ACP `session/request_permission`.
public enum AcpPermissionDecision: Equatable, Sendable {
    case allow
    case reject
    case cancel
}

/// Outcome of matching a requested MiniMax Code picker model against the options a session advertised.
public enum McodeModelSelection: Equatable, Sendable {
    /// The session advertises no `model` config option: the switch is skipped and the session keeps its own default.
    case unsupported
    /// The advertised wire value for the requested model, sent back verbatim.
    case wireValue(String)
}

/// One decoded MiniMax Code model selection, from an ACP wire value of the shape
/// `m:<providerId>:<modelId>:u` (no variant) or `m:<providerId>:<modelId>:v[:<variant>]`.
public struct McodeModelWireValue: Equatable, Sendable {
    public let providerId: String
    public let modelId: String
    public let variant: String?

    public init(providerId: String, modelId: String, variant: String? = nil) {
        self.providerId = providerId
        self.modelId = modelId
        self.variant = variant
    }

    /// The picker id this selection corresponds to: the model id with the variant folded in
    /// (`MiniMax-M2.7-highspeed`).
    public var pickerId: String {
        guard let variant, !variant.isEmpty else { return modelId }
        return "\(modelId)-\(variant)"
    }

    /// Decodes an mcode model wire value.  The CLI advertises the no-variant selection as a bare
    /// `v:` with an EMPTY variant (`m:minimax:MiniMax-M3:v:`), so both spellings mean "no variant".
    public static func parse(_ raw: String) -> McodeModelWireValue? {
        let parts = raw.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 4 || parts.count == 5, parts[0] == "m" else { return nil }
        let providerId = percentDecoded(parts[1])
        let modelId = percentDecoded(parts[2])
        guard !providerId.isEmpty, !modelId.isEmpty else { return nil }

        switch parts[3] {
        case "u":
            guard parts.count == 4 else { return nil }
            return McodeModelWireValue(providerId: providerId, modelId: modelId, variant: nil)
        case "v":
            let variant = parts.count == 5 ? percentDecoded(parts[4]) : ""
            return McodeModelWireValue(
                providerId: providerId,
                modelId: modelId,
                variant: variant.isEmpty ? nil : variant
            )
        default:
            return nil
        }
    }

    /// Percent-decodes a wire component the way `decodeURIComponent` does: a `%XX` run is one UTF-8
    /// byte, every other character passes through unchanged.
    private static func percentDecoded(_ value: String) -> String {
        guard value.contains("%") else { return value }
        var bytes: [UInt8] = []
        var index = value.startIndex
        while index < value.endIndex {
            let char = value[index]
            if char == "%" {
                let hexStart = value.index(after: index)
                if hexStart < value.endIndex,
                   let hexEnd = value.index(hexStart, offsetBy: 2, limitedBy: value.endIndex),
                   let byte = UInt8(value[hexStart..<hexEnd], radix: 16) {
                    bytes.append(byte)
                    index = hexEnd
                    continue
                }
            }
            bytes.append(contentsOf: Array(String(char).utf8))
            index = value.index(after: index)
        }
        return String(decoding: bytes, as: UTF8.self)
    }
}

/// Pure-Swift JSON-RPC 2.0 ACP runner supporting Grok Build (`grok agent stdio`),
/// MiniMax Code (`mcode acp`), and Muse (`muse acp`).
/// Enforces the double replay gate on `session/load`, round-trip config verification on
/// `session/set_config_option`, and fail-closed permission handling on `session/request_permission`.
public actor AcpProcessRunner: EngineDriver {
    public typealias PermissionHandler = @Sendable (
        _ requestId: String,
        _ tool: String,
        _ description: String
    ) async -> AcpPermissionDecision

    public nonisolated let harnessKind: AcpHarnessKind
    public nonisolated let engineId: String
    public nonisolated let executable: String
    private let launcher: any EngineProcessLauncher
    private let permissionHandler: PermissionHandler?
    private var activeSessions: [String: EngineProcessSession] = [:]
    private var activeSessionIds: [String: String] = [:]

    public init(
        harnessKind: AcpHarnessKind,
        engineId: String? = nil,
        executable: String? = nil,
        launcher: any EngineProcessLauncher = ProcessSupervisorActor(),
        permissionHandler: PermissionHandler? = nil
    ) {
        self.harnessKind = harnessKind
        self.engineId = engineId ?? harnessKind.rawValue
        self.executable = executable ?? harnessKind.defaultExecutable
        self.launcher = launcher
        self.permissionHandler = permissionHandler
    }

    public static func buildSpawnSpec(
        harnessKind: AcpHarnessKind,
        executable: String? = nil,
        input: TurnInput
    ) -> EngineSpawnSpec {
        var env = input.environment
        if harnessKind == .grok {
            // Grok CLI uses subscription auth; remove ambient XAI_API_KEY so billing never flips to pay-as-you-go.
            env.removeValue(forKey: "XAI_API_KEY")
        }
        return EngineSpawnSpec(
            executable: executable ?? harnessKind.defaultExecutable,
            arguments: harnessKind.buildSpawnArguments(input: input),
            workingDirectory: input.workingDirectory,
            environment: env
        )
    }

    public func sendTurn(input: TurnInput) async throws -> AsyncStream<TurnEvent> {
        guard activeSessions[input.threadId] == nil else {
            throw EngineDriverError.turnAlreadyActive(threadId: input.threadId)
        }

        let spec = Self.buildSpawnSpec(harnessKind: harnessKind, executable: executable, input: input)
        let session = try await launcher.launch(spec: spec, threadId: input.threadId, engineId: engineId)
        activeSessions[input.threadId] = session

        let (stream, continuation) = AsyncStream<TurnEvent>.makeStream()
        let threadId = input.threadId
        let kind = harnessKind
        let permHandler = permissionHandler

        Task { [weak self] in
            let coordinator = AcpRpcSessionCoordinator(
                session: session,
                harnessKind: kind,
                continuation: continuation,
                permissionHandler: permHandler
            )

            let readerTask = Task {
                for await line in session.stdoutLines {
                    await coordinator.handleInboundLine(line)
                }
                await coordinator.handleStdoutEOF()
            }

            do {
                // 1. Handshake: initialize
                _ = try await coordinator.sendRequest(
                    method: "initialize",
                    params: [
                        "protocolVersion": 1,
                        "clientCapabilities": [
                            "fs": [
                                "readTextFile": false,
                                "writeTextFile": false
                            ]
                        ]
                    ]
                )

                let cwd = input.workingDirectory ?? "/tmp"
                let sessionId: String
                var sessionReply: [String: Any] = [:]

                // 2. Establish or resume session (`session/load` vs `session/new`).
                // While `session/load` is in flight, `coordinator.promptSent` is false, so all
                // replayed `session/update` notifications are dropped by the Double Replay Gate.
                if let resumeId = input.resumeSessionId, !resumeId.isEmpty {
                    sessionReply = try await coordinator.sendRequest(
                        method: "session/load",
                        params: [
                            "sessionId": resumeId,
                            "cwd": cwd,
                            "mcpServers": [] as [[String: Any]]
                        ]
                    )
                    sessionId = (sessionReply["sessionId"] as? String) ?? resumeId
                } else {
                    sessionReply = try await coordinator.sendRequest(
                        method: "session/new",
                        params: [
                            "cwd": cwd,
                            "mcpServers": [] as [[String: Any]]
                        ]
                    )
                    guard let createdId = sessionReply["sessionId"] as? String, !createdId.isEmpty else {
                        throw EngineDriverError.protocolError(code: "missing_session_id", message: "session/new returned no sessionId")
                    }
                    sessionId = createdId
                }

                await self?.recordSessionId(threadId: threadId, sessionId: sessionId)
                continuation.yield(.sessionStarted(sessionId: sessionId))

                // 3. Apply model & session config options (`session/set_config_option`).
                // MiniMax mcode uses `session/set_config_option` for both `model` and `thinkingEffort`
                // and confirms the applied value in the response's `configOptions` array.
                if kind == .mcode, let modelId = input.modelId, !modelId.isEmpty {
                    switch try Self.resolveMcodeModelSelection(requestedModel: modelId, sessionReply: sessionReply) {
                    case .unsupported:
                        // The session advertises no `model` option, so it keeps its own default.
                        break
                    case .wireValue(let wireValue):
                        try await coordinator.applyConfigOption(
                            sessionId: sessionId,
                            configId: "model",
                            requestedValue: wireValue
                        )
                    }
                }

                // Apply any explicit `configOptions` passed on `TurnInput` (sorted by key for determinism).
                for key in input.configOptions.keys.sorted() {
                    if key == "permissionMode" || (kind == .grok && key == "effort") {
                        continue
                    }
                    if let val = input.configOptions[key] {
                        try await coordinator.applyConfigOption(
                            sessionId: sessionId,
                            configId: key,
                            requestedValue: val
                        )
                    }
                }

                // 4. Open Gate 1 (`promptSent = true`) immediately before sending `session/prompt`.
                await coordinator.markPromptSent()

                let promptResult = try await coordinator.sendRequest(
                    method: "session/prompt",
                    params: [
                        "sessionId": sessionId,
                        "prompt": [
                            [
                                "type": "text",
                                "text": input.prompt
                            ]
                        ]
                    ]
                )

                await coordinator.completeWithPromptResult(promptResult)
            } catch let error as EngineDriverError {
                switch error {
                case .protocolError(let code, let message):
                    await coordinator.emitTerminalError(code: code, message: message)
                case .cancelled:
                    await coordinator.emitTerminalError(code: "cancelled", message: "ACP turn was cancelled")
                default:
                    await coordinator.emitTerminalError(code: "acp_error", message: error.localizedDescription)
                }
            } catch {
                await coordinator.emitTerminalError(code: "acp_error", message: error.localizedDescription)
            }

            continuation.finish()
            await session.closeStdin()
            readerTask.cancel()
            _ = await session.waitForExit()
            await self?.clearSession(threadId: threadId)
        }

        return stream
    }

    public func cancelTurn(threadId: String) async {
        guard let session = activeSessions.removeValue(forKey: threadId) else { return }
        if let sessionId = activeSessionIds.removeValue(forKey: threadId) {
            let cancelFrame: [String: Any] = [
                "jsonrpc": "2.0",
                "method": "session/cancel",
                "params": ["sessionId": sessionId]
            ]
            if let data = try? JSONSerialization.data(withJSONObject: cancelFrame, options: [.sortedKeys]),
               let json = String(data: data, encoding: .utf8) {
                try? await session.writeStdinLine(json)
            }
        }
        await session.cancel()
    }

    private func recordSessionId(threadId: String, sessionId: String) {
        activeSessionIds[threadId] = sessionId
    }

    private func clearSession(threadId: String) {
        activeSessions.removeValue(forKey: threadId)
        activeSessionIds.removeValue(forKey: threadId)
    }

    /// Resolves a requested MiniMax Code picker model id against the `configOptions` the session
    /// advertised in `session/new` or `session/load`.
    ///
    /// mcode's wire value embeds the owner's own login/BYOK provider (`m:<providerId>:<modelId>:v[:<variant>]`),
    /// so a value is never constructed here: the picker id is matched against the options the session
    /// advertises and the advertised value goes back verbatim.  A session that advertises no `model`
    /// option keeps its own default and the switch is skipped; a session that advertises one but not the
    /// requested model fails the turn.
    public static func resolveMcodeModelSelection(
        requestedModel: String,
        sessionReply: [String: Any]
    ) throws -> McodeModelSelection {
        guard let configOptions = sessionReply["configOptions"] as? [[String: Any]],
              let modelOption = configOptions.first(where: { ($0["id"] as? String) == "model" }),
              let options = modelOption["options"] as? [[String: Any]] else {
            return .unsupported
        }

        let wanted = requestedModel.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        for option in options {
            guard let raw = option["value"] as? String,
                  let decoded = McodeModelWireValue.parse(raw),
                  decoded.pickerId.lowercased() == wanted else {
                continue
            }
            return .wireValue(raw)
        }

        let names = options
            .map { ($0["name"] as? String) ?? ($0["value"] as? String) ?? "?" }
            .joined(separator: ", ")
        throw EngineDriverError.protocolError(
            code: "unknown_model",
            message: "MiniMax Code does not offer \(requestedModel) for this login - available: \(names.isEmpty ? "none" : names)"
        )
    }
}

// MARK: - Internal ACP JSON-RPC 2.0 Session Coordinator

private actor AcpRpcSessionCoordinator {
    private let session: EngineProcessSession
    private let harnessKind: AcpHarnessKind
    private let continuation: AsyncStream<TurnEvent>.Continuation
    private let permissionHandler: AcpProcessRunner.PermissionHandler?

    private var nextId: Int = 1
    private var pendingRequests: [Int: CheckedContinuation<[String: Any], Error>] = [:]
    private var promptSent: Bool = false
    private var settled: Bool = false
    private var lastUsageUpdateInputTokens: Int?
    private var lastUsageUpdateOutputTokens: Int?

    init(
        session: EngineProcessSession,
        harnessKind: AcpHarnessKind,
        continuation: AsyncStream<TurnEvent>.Continuation,
        permissionHandler: AcpProcessRunner.PermissionHandler?
    ) {
        self.session = session
        self.harnessKind = harnessKind
        self.continuation = continuation
        self.permissionHandler = permissionHandler
    }

    func markPromptSent() {
        promptSent = true
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
            throw EngineDriverError.protocolError(code: "encode_error", message: "Failed to encode JSON-RPC request for \(method)")
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

    func applyConfigOption(sessionId: String, configId: String, requestedValue: String) async throws {
        let reply = try await sendRequest(
            method: "session/set_config_option",
            params: [
                "sessionId": sessionId,
                "configId": configId,
                "value": requestedValue
            ]
        )

        // Verify round-trip config option ACK when the agent returns `configOptions`.
        if let options = reply["configOptions"] as? [[String: Any]],
           let matching = options.first(where: { ($0["id"] as? String) == configId }),
           let reported = matching["currentValue"] as? String {
            if reported != requestedValue {
                throw EngineDriverError.protocolError(
                    code: "config_mismatch",
                    message: "\(harnessKind.rawValue) did not apply config '\(configId)' = '\(requestedValue)' (still '\(reported)')"
                )
            }
            continuation.yield(.configUpdated(key: configId, value: reported))
        } else {
            continuation.yield(.configUpdated(key: configId, value: requestedValue))
        }
    }

    func completeWithPromptResult(_ result: [String: Any]) {
        guard !settled else { return }
        settled = true
        let stopReason = (result["stopReason"] as? String) ?? "end_turn"
        let usage = result["usage"] as? [String: Any]
        let inputTokens = (usage?["inputTokens"] as? Int)
            ?? (usage?["input_tokens"] as? Int)
            ?? (usage?["input"] as? Int)
            ?? lastUsageUpdateInputTokens
        let outputTokens = (usage?["outputTokens"] as? Int)
            ?? (usage?["output_tokens"] as? Int)
            ?? (usage?["output"] as? Int)
            ?? lastUsageUpdateOutputTokens
        continuation.yield(.completed(stopReason: stopReason, inputTokens: inputTokens, outputTokens: outputTokens))
    }

    func emitTerminalError(code: String, message: String) {
        guard !settled else { return }
        settled = true
        continuation.yield(.error(code: code, message: message))
    }

    func handleStdoutEOF() {
        let remaining = pendingRequests
        pendingRequests.removeAll()
        for (_, cont) in remaining {
            cont.resume(throwing: EngineDriverError.protocolError(code: "eof_before_result", message: "ACP process closed stdout before completing RPC"))
        }
    }

    private func failPendingRequest(id: Int, error: Error) {
        if let cont = pendingRequests.removeValue(forKey: id) {
            cont.resume(throwing: error)
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
            // JSON-RPC 2.0 Response
            guard let cont = pendingRequests.removeValue(forKey: id) else { return }
            if let errObj = msg["error"] as? [String: Any] {
                let codeNum = errObj["code"] as? Int
                let rawMessage = (errObj["message"] as? String) ?? "JSON-RPC error"
                let dataDetail = errObj["data"] as? String
                let combinedMessage: String
                if let dataDetail, !dataDetail.isEmpty, !rawMessage.contains(dataDetail) {
                    combinedMessage = "\(rawMessage): \(dataDetail)"
                } else {
                    combinedMessage = rawMessage
                }
                let codeStr = Self.mapRpcErrorCode(code: codeNum, message: combinedMessage)
                cont.resume(throwing: EngineDriverError.protocolError(code: codeStr, message: combinedMessage))
            } else {
                let resultDict = (msg["result"] as? [String: Any]) ?? [:]
                cont.resume(returning: resultDict)
            }
        } else if msg["id"] != nil, let method {
            // Server -> Client JSON-RPC 2.0 Request
            await handleServerRequest(msg: msg, method: method)
        } else if let method {
            // Server -> Client Notification
            handleNotification(msg: msg, method: method)
        }
    }

    private func handleServerRequest(msg: [String: Any], method: String) async {
        let rawId = msg["id"] ?? 0
        guard method == "session/request_permission" else {
            await sendRawResponse(id: rawId, error: ["code": -32601, "message": "method not found"])
            return
        }

        let params = (msg["params"] as? [String: Any]) ?? [:]
        let toolCall = (params["toolCall"] as? [String: Any]) ?? [:]
        let rawInput = toolCall["rawInput"] as? [String: Any]
        let kind = (toolCall["kind"] as? String) ?? ""
        let toolName: String
        if kind == "execute" {
            toolName = "shell"
        } else if kind == "edit" {
            toolName = "edit"
        } else if !kind.isEmpty {
            toolName = kind
        } else {
            toolName = (toolCall["title"] as? String) ?? "tool"
        }

        let description = (rawInput?["command"] as? String)
            ?? (toolCall["title"] as? String)
            ?? (params["message"] as? String)
            ?? toolName
        let reqId = (toolCall["toolCallId"] as? String) ?? "perm-\( rawId )"

        continuation.yield(.permissionRequest(id: reqId, tool: toolName, description: description))

        // Fail-closed permission gate: default to `cancelled` unless an explicit permissionHandler
        // approves AND the agent provided an `allow*` option in `params.options`.
        let decision: AcpPermissionDecision
        if let permissionHandler {
            decision = await permissionHandler(reqId, toolName, description)
        } else {
            decision = .cancel
        }

        let options = (params["options"] as? [[String: Any]]) ?? []
        let resultPayload: [String: Any]
        switch decision {
        case .allow:
            if let allowOption = options.first(where: { (($0["kind"] as? String) ?? "").hasPrefix("allow") }),
               let optionId = allowOption["optionId"] as? String, !optionId.isEmpty {
                resultPayload = ["outcome": ["outcome": "selected", "optionId": optionId]]
            } else {
                resultPayload = ["outcome": ["outcome": "cancelled"]]
            }
        case .reject:
            if let rejectOption = options.first(where: { (($0["kind"] as? String) ?? "").hasPrefix("reject") }),
               let optionId = rejectOption["optionId"] as? String, !optionId.isEmpty {
                resultPayload = ["outcome": ["outcome": "selected", "optionId": optionId]]
            } else {
                resultPayload = ["outcome": ["outcome": "cancelled"]]
            }
        case .cancel:
            resultPayload = ["outcome": ["outcome": "cancelled"]]
        }

        await sendRawResponse(id: rawId, result: resultPayload)
    }

    private func handleNotification(msg: [String: Any], method: String) {
        guard !settled, method == "session/update" else { return }
        guard let params = msg["params"] as? [String: Any],
              let update = params["update"] as? [String: Any],
              let sessionUpdate = update["sessionUpdate"] as? String else {
            return
        }

        if sessionUpdate == "available_commands_update" {
            return
        }

        // Double Replay Gate (matching `server/drivers/acp/core.ts`):
        // 1. Drop any `session/update` arriving before `session/prompt` is sent (e.g. during `session/load`).
        // 2. Drop any `session/update` carrying `_meta.isReplay == true`.
        let meta = params["_meta"] as? [String: Any]
        let isReplay = (meta?["isReplay"] as? Bool) == true
        guard promptSent && !isReplay else {
            return
        }

        switch sessionUpdate {
        case "agent_message_chunk":
            if let content = update["content"] as? [String: Any],
               let text = content["text"] as? String,
               !text.isEmpty {
                continuation.yield(.textDelta(text))
            }

        case "agent_thought_chunk":
            if let content = update["content"] as? [String: Any],
               let text = content["text"] as? String,
               !text.isEmpty {
                continuation.yield(.reasoningDelta(text))
            }

        case "tool_call":
            let toolCallId = (update["toolCallId"] as? String) ?? "call-\(nextId)"
            let rawInput = update["rawInput"]
            let rawInputDict = rawInput as? [String: Any]
            let title = (update["title"] as? String)
                ?? (rawInputDict?["command"] as? String)
                ?? (update["kind"] as? String)
                ?? "tool"
            let argsJSON = ClaudeStreamRunner.canonicalJSONString(from: rawInput)
            continuation.yield(.toolCall(id: toolCallId, name: title, argumentsJSON: argsJSON))

        case "tool_call_update":
            let status = (update["status"] as? String) ?? ""
            guard status == "completed" || status == "failed" else { break }
            let toolCallId = (update["toolCallId"] as? String) ?? "call"
            let outputObj = update["content"] ?? update["rawOutput"]
            let outputText = Self.extractToolUpdateOutput(outputObj)
            continuation.yield(.toolResult(id: toolCallId, output: outputText, isError: status == "failed"))

        case "usage_update":
            if let used = update["used"] as? Int {
                lastUsageUpdateInputTokens = used
            }
            if let output = update["output"] as? Int {
                lastUsageUpdateOutputTokens = output
            }

        default:
            break
        }
    }

    private func sendRawResponse(id: Any, result: [String: Any]? = nil, error: [String: Any]? = nil) async {
        var payload: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id
        ]
        if let result {
            payload["result"] = result
        } else if let error {
            payload["error"] = error
        }
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
           let json = String(data: data, encoding: .utf8) {
            try? await session.writeStdinLine(json)
        }
    }

    private static func extractIntId(_ raw: Any?) -> Int? {
        if let intVal = raw as? Int { return intVal }
        if let num = raw as? NSNumber { return num.intValue }
        if let str = raw as? String, let intVal = Int(str) { return intVal }
        return nil
    }

    private static func extractToolUpdateOutput(_ raw: Any?) -> String {
        if let str = raw as? String {
            return str
        }
        if let dict = raw as? [String: Any], let text = dict["text"] as? String {
            return text
        }
        if let arr = raw as? [[String: Any]] {
            let texts = arr.compactMap { item -> String? in
                if let text = item["text"] as? String { return text }
                if let content = item["content"] as? [String: Any], let text = content["text"] as? String {
                    return text
                }
                return nil
            }
            if !texts.isEmpty {
                return texts.joined(separator: "\n")
            }
        }
        return ClaudeStreamRunner.canonicalJSONString(from: raw)
    }

    private static func mapRpcErrorCode(code: Int?, message: String) -> String {
        let lower = message.lowercased()
        if lower.contains("unknown model") || lower.contains("model_not_found") || lower.contains("does not offer") {
            return "unknown_model"
        }
        if lower.contains("not signed in") || lower.contains("authentication") || lower.contains("unauthorized") || lower.contains("api key") {
            return "auth_required"
        }
        if lower.contains("rate limit") || lower.contains("429") {
            return "rate_limited"
        }
        if code == -32602 {
            return "invalid_params"
        }
        return code.map { "rpc_\($0)" } ?? "rpc_error"
    }
}
