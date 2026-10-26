#if os(macOS)
import CoreGraphics
import Darwin
import Foundation
import Security
import Testing
@testable import CompanionCore

// MARK: - Test Doubles for Keychain, Infisical HTTP, SSE Stream, and AX Tree

private final class MockKeychainStore: InfisicalKeychainStoreProtocol, @unchecked Sendable {
    let serviceName = "app.botfleet.macos.infisical.test"
    let accountName = "machine-identity"

    private let lock = NSLock()
    private var scriptedResponses: [KeychainRawQueryResult]
    private var storedData: Data?
    private(set) var queryCount = 0

    init(scriptedResponses: [KeychainRawQueryResult] = [], initialData: Data? = nil) {
        self.scriptedResponses = scriptedResponses
        self.storedData = initialData
    }

    func queryRaw() -> KeychainRawQueryResult {
        lock.lock()
        defer { lock.unlock() }
        queryCount += 1
        if !scriptedResponses.isEmpty {
            return scriptedResponses.removeFirst()
        }
        if let storedData {
            return .itemData(storedData)
        }
        return .itemNotFound
    }

    func saveRaw(_ data: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        storedData = data
    }

    func deleteRaw() throws {
        lock.lock()
        defer { lock.unlock() }
        storedData = nil
    }
}

private final class MockInfisicalTransport: InfisicalHTTPTransportProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var recordedRequests: [URLRequest] = []
    var loginToken: String = "infisical-access-token-secret-998877"
    var secretsPayload: [[String: String]] = []

    init(secrets: [String: String] = [:]) {
        self.secretsPayload = secrets.map { ["secretKey": $0.key, "secretValue": $0.value] }
    }

    private func recordRequestAndSnapshot(_ request: URLRequest) -> (String, [[String: String]]) {
        lock.lock()
        defer { lock.unlock() }
        recordedRequests.append(request)
        return (loginToken, secretsPayload)
    }

    func execute(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (token, secrets) = recordRequestAndSnapshot(request)

        let url = request.url!
        if url.path.hasSuffix("/api/v1/auth/universal-auth/login") {
            let body = try JSONSerialization.data(withJSONObject: ["accessToken": token], options: [])
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
            return (body, response)
        }
        if url.path.hasSuffix("/api/v3/secrets/raw") {
            let body = try JSONSerialization.data(withJSONObject: ["secrets": secrets], options: [])
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
            return (body, response)
        }
        let response = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (Data(), response)
    }
}

private final class MockSSEStreamTransport: DirectLLMStreamTransportProtocol, @unchecked Sendable {
    private final class Handle: DirectLLMStreamTaskHandle, @unchecked Sendable {
        private let onCancel: @Sendable () -> Void
        init(onCancel: @escaping @Sendable () -> Void) {
            self.onCancel = onCancel
        }
        func cancel() {
            onCancel()
        }
    }

    private let lock = NSLock()
    private let lines: [String]
    private let hangAfterLines: Bool
    private(set) var recordedRequests: [URLRequest] = []
    private(set) var cancelCallCount = 0

    init(lines: [String], hangAfterLines: Bool = false) {
        self.lines = lines
        self.hangAfterLines = hangAfterLines
    }

    func recordCancel() {
        lock.lock()
        cancelCallCount += 1
        lock.unlock()
    }

    func openLineStream(
        for request: URLRequest,
        onTaskCreated: @Sendable @escaping (DirectLLMStreamTaskHandle) -> Void
    ) -> AsyncThrowingStream<String, Error> {
        lock.lock()
        recordedRequests.append(request)
        let scriptedLines = lines
        let shouldHang = hangAfterLines
        lock.unlock()

        let handle = Handle { [weak self] in
            self?.recordCancel()
        }
        onTaskCreated(handle)

        return AsyncThrowingStream { continuation in
            let task = Task {
                for line in scriptedLines {
                    if Task.isCancelled { break }
                    continuation.yield(line)
                }
                if shouldHang {
                    while !Task.isCancelled {
                        try? await Task.sleep(nanoseconds: 10_000_000)
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in
                handle.cancel()
                task.cancel()
            }
        }
    }
}

private final class SyntheticAXElement {
    let role: String
    let title: String?
    let frame: CGRect?
    let children: [SyntheticAXElement]

    init(role: String, title: String? = nil, frame: CGRect? = nil, children: [SyntheticAXElement] = []) {
        self.role = role
        self.title = title
        self.frame = frame
        self.children = children
    }
}

private struct SyntheticAXProvider: AXHierarchyProviderProtocol {
    let roots: [@Sendable () -> SyntheticAXElement]

    func rootWindows(forPid pid: pid_t) -> [AnyObject] {
        roots.map { $0() as AnyObject }
    }

    func role(of element: AnyObject) -> String? {
        (element as? SyntheticAXElement)?.role
    }

    func title(of element: AnyObject) -> String? {
        (element as? SyntheticAXElement)?.title
    }

    func frame(of element: AnyObject) -> CGRect? {
        (element as? SyntheticAXElement)?.frame
    }

    func children(of element: AnyObject) -> [AnyObject] {
        ((element as? SyntheticAXElement)?.children ?? []).map { $0 as AnyObject }
    }
}

// MARK: - Local POSIX `AF_UNIX` Test HTTP Server

private final class LocalUnixSocketHTTPTestServer: @unchecked Sendable {
    let socketPath: String
    private var listenFd: Int32 = -1
    private var acceptThread: Thread?
    private let lock = NSLock()
    private(set) var receivedRequests: [String] = []
    private(set) var containerRunning: Bool = false

    init() throws {
        // Keep path well under the 104-byte sockaddr_un.sun_path limit on macOS
        let shortId = String(UUID().uuidString.prefix(8)).lowercased()
        self.socketPath = "/tmp/bf-cua-\(shortId).sock"
        unlink(socketPath)

        listenFd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard listenFd >= 0 else {
            throw ContainerSocketError.connectionFailed(socketPath: socketPath, errnoCode: errno)
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8CString)
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            let raw = UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: CChar.self)
            for (idx, b) in pathBytes.enumerated() {
                raw[idx] = b
            }
        }
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)

        let bindRes = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(listenFd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindRes == 0, Darwin.listen(listenFd, 16) == 0 else {
            let code = errno
            Darwin.close(listenFd)
            throw ContainerSocketError.connectionFailed(socketPath: socketPath, errnoCode: code)
        }

        let fdCopy = listenFd
        let thread = Thread { [weak self] in
            while true {
                let clientFd = Darwin.accept(fdCopy, nil, nil)
                if clientFd < 0 { break }
                self?.handleClient(clientFd)
            }
        }
        thread.start()
        self.acceptThread = thread
    }

    func shutdown() {
        if listenFd >= 0 {
            Darwin.close(listenFd)
            listenFd = -1
        }
        unlink(socketPath)
    }

    private func handleClient(_ fd: Int32) {
        defer { Darwin.close(fd) }
        var buffer = [UInt8](repeating: 0, count: 4096)
        let n = Darwin.read(fd, &buffer, buffer.count)
        guard n > 0 else { return }
        let rawRequest = String(decoding: buffer.prefix(n), as: UTF8.self)
        let firstLine = rawRequest.components(separatedBy: "\r\n").first ?? ""

        lock.lock()
        receivedRequests.append(firstLine)
        var isRunning = containerRunning
        if firstLine.hasPrefix("POST /containers/botfleet-computer-jay/start") {
            isRunning = true
            containerRunning = true
        } else if firstLine.hasPrefix("POST /containers/botfleet-computer-jay/stop") {
            isRunning = false
            containerRunning = false
        }
        lock.unlock()

        let responseString: String
        if firstLine.hasPrefix("GET /containers/json") {
            let body = """
            [
              {"Id":"c-bf-1","Names":["/botfleet-computer-jay"],"State":"\(isRunning ? "running" : "exited")","Status":"Up 2m","Labels":{"com.botfleet.local-vm":"1"}},
              {"Id":"c-other","Names":["/postgres-local"],"State":"running","Status":"Up 5d","Labels":{}}
            ]
            """
            responseString = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)"
        } else if firstLine.hasPrefix("GET /containers/botfleet-computer-jay/json") {
            let body = """
            {"Id":"c-bf-1","Name":"/botfleet-computer-jay","State":{"Running":\(isRunning),"Status":"\(isRunning ? "running" : "exited")"},"Config":{"Labels":{"com.botfleet.local-vm":"1"}},"HostConfig":{"Memory":2147483648}}
            """
            responseString = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)"
        } else if firstLine.hasPrefix("POST /containers/botfleet-computer-jay/start")
                    || firstLine.hasPrefix("POST /containers/botfleet-computer-jay/stop") {
            responseString = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n"
        } else {
            let body = #"{"message":"not found"}"#
            responseString = "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)"
        }

        let outBytes = Array(responseString.utf8)
        _ = outBytes.withUnsafeBytes { ptr in
            Darwin.write(fd, ptr.baseAddress!, ptr.count)
        }
    }
}

// MARK: - Test Suite

@Suite("Phase 4 Direct LLM Streaming, Infisical Resolver, Engine Matrix, Per-Bot Switch, and CUA Socket")
struct Phase4DirectLlmAndCuaSocketTests {

    // MARK: 1. BF-2506: NativeInfisicalResolver

    @Test("NativeInfisicalResolver retries busy Keychain with 100/200/400/800 ms backoff and distinguishes empty vs unavailable")
    func testKeychainBusyRetryAndStatusInvariant() async throws {
        let validIdentity = InfisicalMachineIdentity(
            clientId: "cid-123",
            clientSecret: ["csecret", "test", "fixture"].joined(separator: "-"),
            projectId: "fedc540e-4641-45a8-8aa2-0e5a5c3dd6c3",
            environment: "prod"
        )
        let encodedIdentity = try JSONEncoder().encode(validIdentity)

        // 1. Busy twice (errSecNotAvailable), then succeeds on the 3rd attempt
        let recordedDelays = LockBox<[UInt64]>([])
        let recoveringKeychain = MockKeychainStore(scriptedResponses: [
            .statusError(errSecNotAvailable),
            .statusError(errSecNotAvailable),
            .itemData(encodedIdentity),
        ])
        let resolver1 = NativeInfisicalResolver(
            keychain: recoveringKeychain,
            transport: MockInfisicalTransport(),
            sleepMs: { ms in recordedDelays.withLock { $0.append(ms) } }
        )

        let status1 = await resolver1.readMachineIdentity()
        #expect(status1 == .ok(validIdentity))
        #expect(recordedDelays.withLock { $0 } == [100, 200])

        // 2. Persistently locked Keychain retries all 4 delays [100, 200, 400, 800] and returns .unavailable, NEVER .empty
        let fullDelays = LockBox<[UInt64]>([])
        let lockedKeychain = MockKeychainStore(scriptedResponses: Array(repeating: .statusError(errSecInteractionNotAllowed), count: 10))
        let resolver2 = NativeInfisicalResolver(
            keychain: lockedKeychain,
            transport: MockInfisicalTransport(),
            sleepMs: { ms in fullDelays.withLock { $0.append(ms) } }
        )
        let status2 = await resolver2.readMachineIdentity()
        #expect(fullDelays.withLock { $0 } == [100, 200, 400, 800])
        if case .unavailable(let osStatus, _) = status2 {
            #expect(osStatus == errSecInteractionNotAllowed)
        } else {
            Issue.record("Expected .unavailable when Keychain is locked, got \(status2)")
        }
    }

    @Test("NativeInfisicalResolver fails closed on missing Keychain identity, caches in memory only, and redacts all string descriptions")
    func testInfisicalFailClosedCachingAndRedaction() async throws {
        // 1. Fail-closed when Keychain is empty: zero HTTP calls allowed
        let emptyKeychain = MockKeychainStore()
        let mockOpenAIKey = ["mock", "openai", "token"].joined(separator: "-")
        let transport = MockInfisicalTransport(secrets: ["OPENAI_API_KEY": mockOpenAIKey])
        let emptyResolver = NativeInfisicalResolver(keychain: emptyKeychain, transport: transport)

        await #expect(throws: InfisicalResolverError.missingMachineIdentity) {
            _ = try await emptyResolver.resolveSecret(forKey: "OPENAI_API_KEY")
        }
        #expect(transport.recordedRequests.isEmpty)

        // 2. Save machine identity and resolve secret with in-memory TTL caching
        let identity = InfisicalMachineIdentity(
            clientId: "cid-prod",
            clientSecret: ["csecret", "private", "fixture"].joined(separator: "-"),
            projectId: "0be350b7-598a-4ac8-8497-81dc3c53ec44",
            environment: "prod"
        )
        try await emptyResolver.saveMachineIdentity(identity)

        let secret1 = try await emptyResolver.resolveSecret(forKey: "OPENAI_API_KEY")
        let secret2 = try await emptyResolver.resolveSecret(forKey: "OPENAI_API_KEY")
        #expect(secret1.exposeSecret() == mockOpenAIKey)
        #expect(secret2.exposeSecret() == mockOpenAIKey)
        // Only 1 login + 1 secrets list call despite 2 resolveSecret calls
        #expect(transport.recordedRequests.count == 2)

        // 3. Verify redaction across CustomStringConvertible, CustomDebugStringConvertible, and redactSecrets(in:)
        #expect(String(describing: secret1) == "[REDACTED]")
        #expect(String(reflecting: secret1) == "[REDACTED]")
        #expect(String(describing: identity) == "[REDACTED]")
        #expect(String(reflecting: identity) == "[REDACTED]")
        #expect(!String(describing: emptyResolver).contains(mockOpenAIKey))

        let scrubbed = await emptyResolver.redactSecrets(
            in: "Failed header Authorization: Bearer \(mockOpenAIKey) and token infisical-access-token-secret-998877"
        )
        #expect(!scrubbed.contains(mockOpenAIKey))
        #expect(!scrubbed.contains("infisical-access-token-secret-998877"))
        #expect(scrubbed.contains("[REDACTED]"))
    }

    // MARK: 2. BF-2506: DirectLLMStreamingClient

    @Test("DirectLLMStreamingClient streams OpenAI, MiniMax reasoning+content, and Gemini SSE deltas, cancels immediately, and fails closed on missing key")
    func testDirectLLMStreamingProvidersAndCancellation() async throws {
        let identity = InfisicalMachineIdentity(
            clientId: "cid",
            clientSecret: "csec",
            projectId: "proj",
            environment: "prod"
        )
        let keychain = MockKeychainStore(initialData: try JSONEncoder().encode(identity))
        let mockOpenAIKey = ["mock", "openai", "key"].joined(separator: "-")
        let mockMiniMaxKey = ["mock", "minimax", "key"].joined(separator: "-")
        let mockGeminiKey = ["mock", "gemini", "key"].joined(separator: "-")
        let infisicalHTTP = MockInfisicalTransport(secrets: [
            "OPENAI_API_KEY": mockOpenAIKey,
            "MINIMAX_API_KEY": mockMiniMaxKey,
            "GEMINI_API_KEY": mockGeminiKey,
        ])
        let resolver = NativeInfisicalResolver(keychain: keychain, transport: infisicalHTTP)

        // 1. Fail-closed on missing XAI_API_KEY before opening stream transport
        let failTransport = MockSSEStreamTransport(lines: [])
        let failClient = DirectLLMStreamingClient(resolver: resolver, transport: failTransport)
        await #expect(throws: DirectLLMStreamError.missingAPIKey(secretKey: "XAI_API_KEY")) {
            let stream = failClient.streamTurn(DirectLLMStreamRequest(
                provider: .xAI,
                model: "grok-4",
                messages: [DirectLLMChatMessage(role: "user", content: "Hello")]
            ))
            for try await _ in stream {}
        }
        #expect(failTransport.recordedRequests.isEmpty)

        // 2. MiniMax Direct API (/v1/text/chatcompletion_v2) with reasoning_content + content + tool_calls
        let minimaxSSE = [
            #"data: {"choices":[{"delta":{"reasoning_content":"Thinking step 1.  "}}]}"#,
            "",
            #"data: {"choices":[{"delta":{"content":"Final MiniMax answer."}}]}"#,
            "",
            #"data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"lookup","arguments":"{\"q\":\"swift\"}"}}]},"finish_reason":"tool_calls"}]}"#,
            "",
            "data: [DONE]",
            "",
        ]
        let minimaxTransport = MockSSEStreamTransport(lines: minimaxSSE)
        let minimaxClient = DirectLLMStreamingClient(resolver: resolver, transport: minimaxTransport)
        var minimaxDeltas: [DirectLLMStreamDelta] = []
        for try await delta in minimaxClient.streamTurn(DirectLLMStreamRequest(
            provider: .miniMax,
            model: "MiniMax-M3.1-Flash",
            messages: [DirectLLMChatMessage(role: "user", content: "Run test")],
            reasoningEffort: "high"
        )) {
            minimaxDeltas.append(delta)
        }
        #expect(minimaxTransport.recordedRequests.first?.url?.absoluteString == "https://api.minimax.io/v1/text/chatcompletion_v2")
        #expect(minimaxTransport.recordedRequests.first?.value(forHTTPHeaderField: "Authorization") == "Bearer \(mockMiniMaxKey)")
        #expect(minimaxDeltas.contains(.reasoning("Thinking step 1.  ")))
        #expect(minimaxDeltas.contains(.text("Final MiniMax answer.")))
        #expect(minimaxDeltas.contains(.toolCall(id: "call_1", name: "lookup", argumentsDelta: #"{"q":"swift"}"#)))

        // 3. Google Gemini Direct API (streamGenerateContent?alt=sse with x-goog-api-key)
        let geminiSSE = [
            #"data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Gemini thought"},{"text":"Gemini response"}]},"finishReason":"STOP"}]}"#,
            "",
        ]
        let geminiTransport = MockSSEStreamTransport(lines: geminiSSE)
        let geminiClient = DirectLLMStreamingClient(resolver: resolver, transport: geminiTransport)
        var geminiDeltas: [DirectLLMStreamDelta] = []
        for try await delta in geminiClient.streamTurn(DirectLLMStreamRequest(
            provider: .gemini,
            model: "gemini-2.5-pro",
            messages: [
                DirectLLMChatMessage(role: "system", content: "Be concise."),
                DirectLLMChatMessage(role: "user", content: "Hi"),
            ]
        )) {
            geminiDeltas.append(delta)
        }
        let geminiReq = try #require(geminiTransport.recordedRequests.first)
        #expect(geminiReq.url?.absoluteString == "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse")
        #expect(geminiReq.value(forHTTPHeaderField: "x-goog-api-key") == mockGeminiKey)
        #expect(geminiDeltas == [
            .reasoning("Gemini thought"),
            .text("Gemini response"),
            .completed(finishReason: "STOP"),
        ])

        // 4. Immediate task cancellation stops the underlying request
        let hangingSSE = [
            #"data: {"choices":[{"delta":{"content":"First token"}}]}"#,
            "",
        ]
        let cancelTransport = MockSSEStreamTransport(lines: hangingSSE, hangAfterLines: true)
        let cancelClient = DirectLLMStreamingClient(resolver: resolver, transport: cancelTransport)
        let consumerTask = Task {
            for try await delta in cancelClient.streamTurn(DirectLLMStreamRequest(
                provider: .openAICompatible,
                model: "gpt-5.4",
                messages: [DirectLLMChatMessage(role: "user", content: "Stream")]
            )) {
                if delta == .text("First token") {
                    break
                }
            }
        }
        try await consumerTask.value
        #expect(cancelTransport.cancelCallCount >= 1)

        // 5. The provider credential is never attached to a host outside the provider's allowlist
        let offHostTransport = MockSSEStreamTransport(lines: [])
        let offHostClient = DirectLLMStreamingClient(resolver: resolver, transport: offHostTransport)
        await #expect(throws: DirectLLMStreamError.invalidEndpoint("https://attacker.example/v1/chat/completions")) {
            _ = try await offHostClient.buildAuthenticatedRequest(for: DirectLLMStreamRequest(
                provider: .openAICompatible,
                model: "gpt-5.4",
                messages: [DirectLLMChatMessage(role: "user", content: "Hello")],
                baseURL: "https://attacker.example"
            ))
        }
        // A plaintext endpoint is refused too, even for a known host.
        await #expect(throws: DirectLLMStreamError.invalidEndpoint("http://api.openai.com/v1/chat/completions")) {
            _ = try await offHostClient.buildAuthenticatedRequest(for: DirectLLMStreamRequest(
                provider: .openAICompatible,
                model: "gpt-5.4",
                messages: [DirectLLMChatMessage(role: "user", content: "Hello")],
                baseURL: "http://api.openai.com"
            ))
        }
        #expect(offHostTransport.recordedRequests.isEmpty)
    }

    // MARK: 3. BF-2507: EngineMatrixRegistry & OpenCode Probe Failure Sentences

    @Test("EngineMatrixRegistry covers all 13 engines, Antigravity agy host-control policy, and BF-2488 OpenCode probe sentences")
    func testEngineMatrixAndOpenCodeProbeClassification() {
        // 1. All 13 engines present and verified by replay
        #expect(EngineMatrixID.allCases.count == 13)
        #expect(EngineMatrixRegistry.allDescriptors.count == 13)

        for engineId in EngineMatrixID.allCases {
            let replay = EngineReplayVerifier.verifyMatrixEngineReplay(for: engineId)
            #expect(replay.engineId == engineId)
            #expect(replay.completedNormally)
            #expect(replay.assistantText.contains("Verified"))
            #expect(replay.permissionPolicyRefusal == nil)
        }

        // 2. Antigravity `agy` spawn spec strips `--dangerously-skip-permissions` when controlling host Mac
        let agySandboxSpec = try! #require(EngineMatrixRegistry.buildSpawnSpec(
            for: .antigravity,
            input: EngineTurnSpawnInput(
                prompt: "Build module",
                workspacePath: "/tmp/ws-1",
                model: "gemini-3.1-pro-high",
                resumeCursor: "conv-abc",
                fullAuto: true,
                controlsHostMac: false
            )
        ))
        #expect(agySandboxSpec.executable == "agy")
        #expect(agySandboxSpec.argv.contains("--dangerously-skip-permissions"))
        #expect(agySandboxSpec.argv.contains("--conversation"))
        #expect(agySandboxSpec.argv.contains("conv-abc"))

        let agyHostSpec = try! #require(EngineMatrixRegistry.buildSpawnSpec(
            for: .antigravity,
            input: EngineTurnSpawnInput(
                prompt: "Control desktop",
                workspacePath: "/tmp/ws-host",
                fullAuto: true,
                controlsHostMac: true
            )
        ))
        #expect(!agyHostSpec.argv.contains("--dangerously-skip-permissions"))
        #expect(agyHostSpec.argv.contains("--mode"))
        #expect(agyHostSpec.argv.contains("accept-edits"))

        // 3. Antigravity host-control replay stops turn if agy reports `always-proceed`
        let unsafeAgyReplay = EngineReplayVerifier.replayAntigravityStreamJSON(
            lines: [
                #"{"type":"init","conversation_id":"conv-unsafe","permission_mode":"always-proceed"}"#,
                #"{"type":"assistant","text":"Should not emit"}"#,
            ],
            controlsHostMac: true
        )
        #expect(!unsafeAgyReplay.completedNormally)
        #expect(unsafeAgyReplay.assistantText.isEmpty)
        #expect(unsafeAgyReplay.permissionPolicyRefusal?.contains("always-proceed") == true)

        // 4. OpenCode probe failure classification (BF-2488)
        let saturatedLoad = EngineHostLoad(load1: 25.0, cores: 10)
        let probeDeadline = EngineInitDeadline.resolve(
            engineBaseMs: EngineInitDeadline.openCodeModelProbeBaseTimeoutMs,
            load: saturatedLoad
        )
        #expect(probeDeadline.timeoutMs == 50_000)
        #expect(
            OpenCodeProbeFailureKind.timedOut(deadline: probeDeadline).statusSentence
                == "OpenCode's model probe timed out after 50 s (host load 2.5 per core)"
        )
        #expect(
            OpenCodeProbeFailureKind.stoppedBySignal(signal: "SIGTERM").statusSentence
                == "OpenCode's model probe was stopped by SIGTERM before it answered"
        )
        #expect(
            OpenCodeProbeFailureKind.emptyOutput(verboseError: nil).statusSentence
                == "opencode models answered nothing"
        )
        #expect(
            OpenCodeProbeFailureKind.emptyOutput(verboseError: "Unrecognized flag: --verbose").statusSentence
                == "opencode models listed nothing (Unrecognized flag: --verbose)"
        )
    }

    // MARK: 4. BF-2508: BotNativeEngineSwitchActor

    @Test("BotNativeEngineSwitchActor enforces single-runtime fence, idempotent import, sub-10ms FTS5 search, and lossless switch-back")
    func testBotNativeEngineSwitchLifecycle() async throws {
        let db = try DatabaseService(path: ":memory:")
        let switchActor = BotNativeEngineSwitchActor(database: db)
        let botId = "bot-architect"

        // Initially owned by .nodeHarness
        #expect(await switchActor.owner(for: botId) == .nodeHarness)
        try await switchActor.beginTurn(botId: botId, callerRuntime: .nodeHarness, turnId: "node-turn-1")
        await #expect(throws: BotEngineSwitchError.runtimeFenced(
            botId: botId,
            activeOwner: .nodeHarness,
            attemptedBy: .nativeSwift
        )) {
            try await switchActor.beginTurn(botId: botId, callerRuntime: .nativeSwift, turnId: "native-turn-early")
        }
        await switchActor.endTurn(botId: botId, turnId: "node-turn-1")

        // Prepare history snapshot with 2 threads and 4 messages
        let thread1 = ThreadRecord(id: "t-arch-1", title: "Phase 4 Architecture", botId: botId, createdAt: 1_000, updatedAt: 1_010)
        let thread2 = ThreadRecord(id: "t-arch-2", title: "CUA Socket Design", botId: botId, createdAt: 2_000, updatedAt: 2_010)
        let snapshot = BotHistoryImportSnapshot(
            botId: botId,
            threads: [thread1, thread2],
            messagesByThread: [
                "t-arch-1": [
                    MessageRecord(id: "m-1", threadId: "t-arch-1", role: "user", content: "Migrate Infisical resolver to Keychain.", createdAt: 1_001),
                    MessageRecord(id: "m-2", threadId: "t-arch-1", role: "assistant", content: "Keychain machine identity verified with zero disk writes.", createdAt: 1_005),
                ],
                "t-arch-2": [
                    MessageRecord(id: "m-3", threadId: "t-arch-2", role: "user", content: "Connect to Docker socket directly.", createdAt: 2_001),
                    MessageRecord(id: "m-4", threadId: "t-arch-2", role: "assistant", content: "Pure-Swift AF_UNIX client ready for Local VM.", createdAt: 2_005),
                ],
            ]
        )

        // Switch to .nativeSwift twice to prove idempotency
        let report1 = try await switchActor.switchToNativeSwift(botId: botId, historySnapshot: snapshot)
        let report2 = try await switchActor.switchToNativeSwift(botId: botId, historySnapshot: snapshot)
        #expect(report1.verifiedThreadCount == 2)
        #expect(report1.verifiedMessageCount == 4)
        #expect(report2.verifiedThreadCount == 2)
        #expect(report2.verifiedMessageCount == 4)
        #expect(await switchActor.owner(for: botId) == .nativeSwift)

        // Node turns are now fenced for this bot
        await #expect(throws: BotEngineSwitchError.runtimeFenced(
            botId: botId,
            activeOwner: .nativeSwift,
            attemptedBy: .nodeHarness
        )) {
            try await switchActor.beginTurn(botId: botId, callerRuntime: .nodeHarness, turnId: "node-turn-fenced")
        }

        // FTS5 search routes through DatabaseService in < 10 ms
        let (searchHits, elapsedMs) = try await switchActor.searchMessages(forBot: botId, query: "Keychain")
        #expect(searchHits.count == 2)
        #expect(elapsedMs < 10.0)

        // Stage a new native turn message while running on .nativeSwift, then switch back to .nodeHarness
        try await switchActor.stagePendingNativeTurnWrite(
            botId: botId,
            thread: thread1,
            message: MessageRecord(
                id: "m-5-native",
                threadId: "t-arch-1",
                role: "assistant",
                content: "Native Swift turn persisted before handback.",
                createdAt: 3_000
            )
        )

        let (backReport, exported) = try await switchActor.switchBackToNodeHarness(botId: botId)
        #expect(backReport.newOwner == .nodeHarness)
        #expect(backReport.flushedPendingTurnCount == 1)
        #expect(backReport.verifiedMessageCount == 5)
        #expect(exported.totalThreadCount == 2)
        #expect(exported.totalMessageCount == 5)
        #expect(await switchActor.owner(for: botId) == .nodeHarness)
    }

    // MARK: 5. BF-2509: ContainerSocketClient (AF_UNIX) & MacAXInspector

    @Test("ContainerSocketClient speaks HTTP/1.1 over a real AF_UNIX socket, refuses non-BotFleet containers, and reports unsupported runtimes")
    func testContainerSocketClientAndAXInspector() async throws {
        let server = try LocalUnixSocketHTTPTestServer()
        defer { server.shutdown() }

        let client = try ContainerSocketClient(socketPath: server.socketPath, runtimeId: "docker")

        // 1. List filters to verified botfleet-computer* containers only (drops postgres-local)
        let listed = try await client.listBotFleetContainers()
        #expect(listed.count == 1)
        #expect(listed.first?.name == "botfleet-computer-jay")
        #expect(listed.first?.isRunning == false)

        // 2. Start container -> inspect shows running == true -> stop container -> inspect shows running == false
        try await client.startContainer(idOrName: "botfleet-computer-jay")
        let afterStart = try await client.inspectContainer(idOrName: "botfleet-computer-jay")
        #expect(afterStart.running == true)
        #expect(afterStart.memoryLimitBytes == 2_147_483_648)

        // The Local VM driver reports that the guest bridge is not wired up
        // instead of pretending a click or a frame happened.
        let vmDriver = try LocalVmCuaDriver(containerName: "botfleet-computer-jay", viewerPort: 6080, socketClient: client)
        #expect(vmDriver.targetKind == .localVM(containerName: "botfleet-computer-jay", viewerPort: 6080))
        await #expect(throws: ContainerSocketError.unsupportedOperation(
            operation: "captureFrame",
            reason: "reading the guest screen needs the container's cua-driver bridge, which is not wired up in the native client yet"
        )) {
            _ = try await vmDriver.captureFrame()
        }
        await #expect(throws: ContainerSocketError.unsupportedOperation(
            operation: "click",
            reason: "driving the guest's pointer needs the container's cua-driver bridge, which is not wired up in the native client yet"
        )) {
            try await vmDriver.click(point: CGPoint(x: 10, y: 10))
        }

        try await client.stopContainer(idOrName: "botfleet-computer-jay", timeoutSeconds: 5)
        let afterStop = try await client.inspectContainer(idOrName: "botfleet-computer-jay")
        #expect(afterStop.running == false)

        // 3. Non-BotFleet container names are refused before touching the socket
        await #expect(throws: ContainerSocketError.unownedContainerRefused(name: "postgres-local")) {
            try await client.stopContainer(idOrName: "postgres-local")
        }
        await #expect(throws: ContainerSocketError.unownedContainerRefused(name: "../botfleet-computer-escape")) {
            _ = try await client.inspectContainer(idOrName: "../botfleet-computer-escape")
        }

        // 4. A request line carrying CR/LF is refused instead of being split
        await #expect(throws: ContainerSocketError.malformedHTTPRequest) {
            _ = try await client.performHTTPRequest(
                method: "GET",
                path: "/containers/json\r\nX-Injected: 1\r\n\r\nGET /containers/json"
            )
        }
        await #expect(throws: ContainerSocketError.malformedHTTPRequest) {
            _ = try await client.performHTTPRequest(method: "GET /containers/json", path: "/containers/json")
        }
        await #expect(throws: ContainerSocketError.malformedHTTPRequest) {
            _ = try await client.performHTTPRequest(method: "GET", path: "containers/json")
        }

        // 5. Unsupported container runtime is reported by product name
        #expect(throws: ContainerSocketError.self) {
            _ = try ContainerSocketClient(socketPath: server.socketPath, runtimeId: "container")
        }
        #expect(
            ContainerRuntimeNaming.daemonSlowProblem(runtime: "podman")
                == "Podman is slow to respond right now; try again in a moment"
        )

        // 5. MacAXInspector enforces maxDepth and maxNodes bounds
        let deepTree = SyntheticAXElement(
            role: "AXWindow",
            title: "Main Window",
            frame: CGRect(x: 0, y: 0, width: 1000, height: 800),
            children: [
                SyntheticAXElement(
                    role: "AXSplitGroup",
                    title: "Split",
                    children: [
                        SyntheticAXElement(
                            role: "AXButton",
                            title: "Send",
                            children: [
                                SyntheticAXElement(role: "AXStaticText", title: "Too Deep")
                            ]
                        ),
                        SyntheticAXElement(role: "AXButton", title: "Cancel"),
                    ]
                ),
            ]
        )
        let inspector = MacAXInspector(
            maxDepth: 3,
            maxNodes: 3,
            provider: SyntheticAXProvider(roots: [{ deepTree }])
        )
        let nodes = inspector.inspect(pid: 1234)
        #expect(nodes.count == 1)
        #expect(nodes.first?.role == "AXWindow")
        #expect(nodes.first?.children.count == 1)
        // Node 1 = AXWindow, Node 2 = AXSplitGroup, Node 3 = AXButton("Send"); "Cancel" and "Too Deep" are capped out
        #expect(nodes.first?.children.first?.children.count == 1)
        #expect(nodes.first?.children.first?.children.first?.title == "Send")
        #expect(nodes.first?.children.first?.children.first?.children.isEmpty == true)
    }
}

private final class LockBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) {
        self.value = value
    }

    func withLock<T>(_ body: (inout Value) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
}
#endif
