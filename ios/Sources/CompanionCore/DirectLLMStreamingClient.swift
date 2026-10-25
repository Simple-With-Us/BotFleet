import Foundation

/// Provider wire dialect for direct HTTPS LLM streaming.
public enum DirectLLMProviderKind: String, Codable, Equatable, Sendable {
    case openAICompatible
    case xAI
    case miniMax
    case gemini

    /// Default Infisical secret key name for this provider.
    public var defaultInfisicalSecretKey: String {
        switch self {
        case .openAICompatible:
            return "OPENAI_API_KEY"
        case .xAI:
            return "XAI_API_KEY"
        case .miniMax:
            return "MINIMAX_API_KEY"
        case .gemini:
            return "GEMINI_API_KEY"
        }
    }

    /// Default API base URL for this provider.
    public var defaultBaseURL: String {
        switch self {
        case .openAICompatible:
            return "https://api.openai.com"
        case .xAI:
            return "https://api.x.ai"
        case .miniMax:
            return "https://api.minimax.io"
        case .gemini:
            return "https://generativelanguage.googleapis.com"
        }
    }

    /// Hosts this provider's credential is allowed to be sent to.
    ///
    /// A provider key resolved from the vault must never travel to a host named
    /// by a bot- or user-settable endpoint, so the endpoint host is checked
    /// against this set (plus the operator allowlist the client is built with)
    /// before the credential is attached to the request.
    public var credentialHosts: Set<String> {
        switch self {
        case .openAICompatible:
            return ["api.openai.com"]
        case .xAI:
            return ["api.x.ai"]
        case .miniMax:
            return ["api.minimax.io", "api.minimaxi.com"]
        case .gemini:
            return ["generativelanguage.googleapis.com"]
        }
    }
}

/// Chat message input for a direct LLM streaming turn.
public struct DirectLLMChatMessage: Codable, Equatable, Sendable {
    public let role: String
    public let content: String

    public init(role: String, content: String) {
        self.role = role
        self.content = content
    }
}

/// Configuration for a single direct LLM streaming turn.
public struct DirectLLMStreamRequest: Equatable, Sendable {
    public let provider: DirectLLMProviderKind
    public let model: String
    public let messages: [DirectLLMChatMessage]
    public let baseURL: String?
    public let infisicalSecretKey: String?
    public let reasoningEffort: String?
    public let useMiniMaxV2Endpoint: Bool

    public init(
        provider: DirectLLMProviderKind,
        model: String,
        messages: [DirectLLMChatMessage],
        baseURL: String? = nil,
        infisicalSecretKey: String? = nil,
        reasoningEffort: String? = nil,
        useMiniMaxV2Endpoint: Bool = true
    ) {
        self.provider = provider
        self.model = model
        self.messages = messages
        self.baseURL = baseURL
        self.infisicalSecretKey = infisicalSecretKey
        self.reasoningEffort = reasoningEffort
        self.useMiniMaxV2Endpoint = useMiniMaxV2Endpoint
    }
}

/// Normalized streaming delta emitted by `DirectLLMStreamingClient`.
public enum DirectLLMStreamDelta: Equatable, Sendable {
    case text(String)
    case reasoning(String)
    case toolCall(id: String?, name: String?, argumentsDelta: String)
    case completed(finishReason: String?)
}

/// Errors thrown by `DirectLLMStreamingClient`.
public enum DirectLLMStreamError: LocalizedError, Equatable, Sendable {
    case missingAPIKey(secretKey: String)
    case invalidEndpoint(String)
    case httpStatus(code: Int)
    case cancelled

    public var errorDescription: String? {
        switch self {
        case .missingAPIKey(let key):
            return "Direct LLM stream refused: API key '\(key)' is missing or empty in Infisical."
        case .invalidEndpoint(let url):
            return "Invalid LLM endpoint URL: \(url)"
        case .httpStatus(let code):
            return "Direct LLM streaming request failed with HTTP \(code)."
        case .cancelled:
            return "Direct LLM streaming request was cancelled."
        }
    }
}

/// Cancellable handle representing an in-flight streaming HTTP connection.
public protocol DirectLLMStreamTaskHandle: Sendable {
    func cancel()
}

/// Transport abstraction yielding raw SSE lines from an authenticated `URLRequest`
/// while supporting immediate task cancellation.
public protocol DirectLLMStreamTransportProtocol: Sendable {
    func openLineStream(
        for request: URLRequest,
        onTaskCreated: @Sendable @escaping (DirectLLMStreamTaskHandle) -> Void
    ) -> AsyncThrowingStream<String, Error>
}

private final class URLSessionTaskCancellationBox: DirectLLMStreamTaskHandle, @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<Void, Never>?
    private var isCancelled = false

    func bind(_ task: Task<Void, Never>) {
        lock.lock()
        let shouldCancel = isCancelled
        self.task = task
        lock.unlock()
        if shouldCancel {
            task.cancel()
        }
    }

    func cancel() {
        lock.lock()
        isCancelled = true
        let currentTask = task
        lock.unlock()
        currentTask?.cancel()
    }
}

/// Default `URLSession` SSE line transport using `session.bytes(for:)` and manual
/// newline framing so empty lines (`\n\n` event boundaries) are preserved.
public struct URLSessionDirectLLMStreamTransport: DirectLLMStreamTransportProtocol {
    private let session: URLSession

    public init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.urlCache = nil
            config.httpCookieAcceptPolicy = .never
            config.httpShouldSetCookies = false
            config.timeoutIntervalForRequest = 120
            self.session = URLSession(configuration: config)
        }
    }

    public func openLineStream(
        for request: URLRequest,
        onTaskCreated: @Sendable @escaping (DirectLLMStreamTaskHandle) -> Void
    ) -> AsyncThrowingStream<String, Error> {
        let box = URLSessionTaskCancellationBox()
        onTaskCreated(box)

        return AsyncThrowingStream { continuation in
            let readerTask = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        throw DirectLLMStreamError.httpStatus(code: http.statusCode)
                    }

                    var lineBuffer: [UInt8] = []
                    for try await byte in bytes {
                        if Task.isCancelled {
                            throw DirectLLMStreamError.cancelled
                        }
                        if byte == 0x0A {
                            if lineBuffer.last == 0x0D {
                                lineBuffer.removeLast()
                            }
                            let line = String(decoding: lineBuffer, as: UTF8.self)
                            lineBuffer.removeAll(keepingCapacity: true)
                            continuation.yield(line)
                        } else {
                            lineBuffer.append(byte)
                        }
                    }
                    if !lineBuffer.isEmpty {
                        if lineBuffer.last == 0x0D {
                            lineBuffer.removeLast()
                        }
                        continuation.yield(String(decoding: lineBuffer, as: UTF8.self))
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish(throwing: DirectLLMStreamError.cancelled)
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            box.bind(readerTask)
            continuation.onTermination = { _ in
                box.cancel()
            }
        }
    }
}

/// Direct HTTPS SSE streaming client for OpenAI/xAI, MiniMax Direct API, and Google Gemini Direct API.
///
/// Resolves credentials at turn start from `NativeInfisicalResolver`, fails closed if the key
/// is missing or empty, parses SSE `data:` frames into `DirectLLMStreamDelta` events, and
/// cancels the underlying HTTP task immediately when the stream consumer cancels.
public final class DirectLLMStreamingClient: Sendable {
    private let resolver: NativeInfisicalResolver
    private let transport: DirectLLMStreamTransportProtocol
    private let operatorAllowedHosts: Set<String>

    /// - Parameters:
    ///   - resolver: the vault the provider credential is resolved from.
    ///   - transport: the line transport the SSE stream is read from.
    ///   - operatorAllowedHosts: extra hosts an operator has explicitly
    ///     approved to receive a provider credential, for self-hosted
    ///     OpenAI-compatible gateways.  This is set by the composition root and
    ///     never by per-bot configuration.
    public init(
        resolver: NativeInfisicalResolver,
        transport: DirectLLMStreamTransportProtocol = URLSessionDirectLLMStreamTransport(),
        operatorAllowedHosts: Set<String> = []
    ) {
        self.resolver = resolver
        self.transport = transport
        self.operatorAllowedHosts = Set(operatorAllowedHosts.map { $0.lowercased() })
    }

    /// Builds an authenticated `URLRequest` after verifying that `NativeInfisicalResolver`
    /// holds a non-empty API key for the target provider.
    ///
    /// The credential is only attached to an `https` endpoint whose host is the
    /// provider's own host or an operator-approved one, so a bot- or
    /// user-settable `baseURL` cannot exfiltrate the resolved key.
    public func buildAuthenticatedRequest(for spec: DirectLLMStreamRequest) async throws -> URLRequest {
        let secretKey = spec.infisicalSecretKey ?? spec.provider.defaultInfisicalSecretKey
        let resolvedSecret: RedactedSecret
        do {
            resolvedSecret = try await resolver.resolveSecret(forKey: secretKey)
        } catch let error as InfisicalResolverError {
            switch error {
            case .missingMachineIdentity, .secretNotFound:
                throw DirectLLMStreamError.missingAPIKey(secretKey: secretKey)
            default:
                throw error
            }
        }

        let apiKey = resolvedSecret.exposeSecret().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !apiKey.isEmpty else {
            throw DirectLLMStreamError.missingAPIKey(secretKey: secretKey)
        }

        let base = (spec.baseURL ?? spec.provider.defaultBaseURL).trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        switch spec.provider {
        case .openAICompatible, .xAI:
            let path = base.hasSuffix("/v1") ? "\(base)/chat/completions" : "\(base)/v1/chat/completions"
            let url = try approvedCredentialEndpoint(path, provider: spec.provider)
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
            request.httpBody = try encodeOpenAICompatibleBody(for: spec)
            return request

        case .miniMax:
            let endpointPath: String
            if spec.useMiniMaxV2Endpoint {
                endpointPath = base.hasSuffix("/v1")
                    ? "\(base)/text/chatcompletion_v2"
                    : "\(base)/v1/text/chatcompletion_v2"
            } else {
                endpointPath = base.hasSuffix("/v1")
                    ? "\(base)/chat/completions"
                    : "\(base)/v1/chat/completions"
            }
            let url = try approvedCredentialEndpoint(endpointPath, provider: spec.provider)
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
            request.httpBody = try encodeOpenAICompatibleBody(for: spec)
            return request

        case .gemini:
            let encodedModel = spec.model.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? spec.model
            let endpointPath = "\(base)/v1beta/models/\(encodedModel):streamGenerateContent?alt=sse"
            let url = try approvedCredentialEndpoint(endpointPath, provider: spec.provider)
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            request.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
            request.httpBody = try encodeGeminiBody(for: spec)
            return request
        }
    }

    /// Streams parsed LLM deltas for `spec`, cancelling the underlying network task
    /// immediately if the caller cancels the returned `AsyncThrowingStream`.
    public func streamTurn(_ spec: DirectLLMStreamRequest) -> AsyncThrowingStream<DirectLLMStreamDelta, Error> {
        let handleBox = URLSessionTaskCancellationBox()

        return AsyncThrowingStream { continuation in
            let driverTask = Task {
                do {
                    let request = try await buildAuthenticatedRequest(for: spec)
                    if Task.isCancelled {
                        throw DirectLLMStreamError.cancelled
                    }

                    let lineStream = transport.openLineStream(for: request) { taskHandle in
                        if Task.isCancelled {
                            taskHandle.cancel()
                        }
                    }

                    var sseParser = SSEParser()
                    for try await rawLine in lineStream {
                        if Task.isCancelled {
                            throw DirectLLMStreamError.cancelled
                        }
                        if let event = sseParser.line(rawLine) {
                            let deltas = Self.parseSSEPayload(event.data, provider: spec.provider)
                            for delta in deltas {
                                continuation.yield(delta)
                            }
                        }
                    }
                    // End of stream is an event boundary.  `SSEParser` only closes
                    // an event on a blank line, so a provider that closes the body
                    // without a trailing blank line would otherwise lose its last
                    // delta and its completion frame.  Feeding the parser a final
                    // blank line returns whatever it still has buffered, and
                    // returns nil when nothing is pending.
                    if let event = sseParser.line("") {
                        let deltas = Self.parseSSEPayload(event.data, provider: spec.provider)
                        for delta in deltas {
                            continuation.yield(delta)
                        }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish(throwing: DirectLLMStreamError.cancelled)
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            handleBox.bind(driverTask)
            continuation.onTermination = { _ in
                handleBox.cancel()
            }
        }
    }

    // MARK: - Request Encoders

    /// Returns the endpoint URL when it is safe to attach the provider credential
    /// to it: `https`, no embedded userinfo, and a host that the provider owns
    /// or the operator explicitly approved.  Anything else throws, so a
    /// bot- or user-settable `baseURL` cannot redirect the resolved vault key to
    /// another host.
    private func approvedCredentialEndpoint(
        _ raw: String,
        provider: DirectLLMProviderKind
    ) throws -> URL {
        guard let url = URL(string: raw),
              url.scheme?.lowercased() == "https",
              url.user == nil,
              url.password == nil,
              let host = url.host?.lowercased(),
              provider.credentialHosts.contains(host) || operatorAllowedHosts.contains(host)
        else {
            throw DirectLLMStreamError.invalidEndpoint(raw)
        }
        return url
    }

    private func encodeOpenAICompatibleBody(for spec: DirectLLMStreamRequest) throws -> Data {
        var body: [String: Any] = [
            "model": spec.model,
            "stream": true,
            "messages": spec.messages.map { ["role": $0.role, "content": $0.content] },
        ]
        if let effort = spec.reasoningEffort, !effort.isEmpty {
            body["reasoning_effort"] = effort
        }
        return try JSONSerialization.data(withJSONObject: body, options: [])
    }

    private func encodeGeminiBody(for spec: DirectLLMStreamRequest) throws -> Data {
        var systemParts: [[String: Any]] = []
        var contents: [[String: Any]] = []

        for message in spec.messages {
            if message.role == "system" {
                systemParts.append(["text": message.content])
            } else {
                let geminiRole = message.role == "assistant" ? "model" : "user"
                contents.append([
                    "role": geminiRole,
                    "parts": [["text": message.content]],
                ])
            }
        }

        var body: [String: Any] = ["contents": contents]
        if !systemParts.isEmpty {
            body["systemInstruction"] = ["parts": systemParts]
        }
        return try JSONSerialization.data(withJSONObject: body, options: [])
    }

    // MARK: - SSE Payload Parsing

    /// Pure parser turning one SSE `data:` payload into zero or more `DirectLLMStreamDelta` items.
    public static func parseSSEPayload(_ dataString: String, provider: DirectLLMProviderKind) -> [DirectLLMStreamDelta] {
        let trimmed = dataString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        if trimmed == "[DONE]" {
            return [.completed(finishReason: "stop")]
        }
        guard
            let data = trimmed.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return []
        }

        switch provider {
        case .openAICompatible, .xAI, .miniMax:
            return parseOpenAICompatibleJSON(json)
        case .gemini:
            return parseGeminiJSON(json)
        }
    }

    private static func parseOpenAICompatibleJSON(_ json: [String: Any]) -> [DirectLLMStreamDelta] {
        guard let choices = json["choices"] as? [[String: Any]], !choices.isEmpty else {
            return []
        }
        var results: [DirectLLMStreamDelta] = []
        for choice in choices {
            if let delta = choice["delta"] as? [String: Any] {
                if let reasoning = delta["reasoning_content"] as? String, !reasoning.isEmpty {
                    results.append(.reasoning(reasoning))
                }
                if let content = delta["content"] as? String, !content.isEmpty {
                    results.append(.text(content))
                }
                if let toolCalls = delta["tool_calls"] as? [[String: Any]] {
                    for call in toolCalls {
                        let id = call["id"] as? String
                        let function = call["function"] as? [String: Any]
                        let name = function?["name"] as? String
                        let arguments = (function?["arguments"] as? String) ?? ""
                        results.append(.toolCall(id: id, name: name, argumentsDelta: arguments))
                    }
                }
            }
            if let finishReason = choice["finish_reason"] as? String, !finishReason.isEmpty {
                results.append(.completed(finishReason: finishReason))
            }
        }
        return results
    }

    private static func parseGeminiJSON(_ json: [String: Any]) -> [DirectLLMStreamDelta] {
        guard let candidates = json["candidates"] as? [[String: Any]], !candidates.isEmpty else {
            return []
        }
        var results: [DirectLLMStreamDelta] = []
        for candidate in candidates {
            if let content = candidate["content"] as? [String: Any],
               let parts = content["parts"] as? [[String: Any]] {
                for part in parts {
                    let isThought = (part["thought"] as? Bool) == true
                    if let text = part["text"] as? String, !text.isEmpty {
                        if isThought {
                            results.append(.reasoning(text))
                        } else {
                            results.append(.text(text))
                        }
                    }
                    if let functionCall = part["functionCall"] as? [String: Any],
                       let name = functionCall["name"] as? String {
                        let argsDict = functionCall["args"] as? [String: Any] ?? [:]
                        let argsData = (try? JSONSerialization.data(withJSONObject: argsDict, options: [.sortedKeys])) ?? Data()
                        let argsString = String(data: argsData, encoding: .utf8) ?? "{}"
                        results.append(.toolCall(id: nil, name: name, argumentsDelta: argsString))
                    }
                }
            }
            if let finishReason = candidate["finishReason"] as? String, !finishReason.isEmpty {
                results.append(.completed(finishReason: finishReason))
            }
        }
        return results
    }
}
