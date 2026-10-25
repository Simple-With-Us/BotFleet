import Foundation

// MARK: - Turn Input & Event Contracts

/// Canonical input for a single conversational or routine turn dispatched to a native engine driver.
/// Carries thread and bot identity, user prompt, model selection, resume cursor, working directory,
/// child environment overrides, and engine-specific session config options.
public struct TurnInput: Equatable, Sendable, Codable {
    public let threadId: String
    public let botId: String
    public let prompt: String
    public let modelId: String?
    public let resumeSessionId: String?
    public let workingDirectory: String?
    public let environment: [String: String]
    public let configOptions: [String: String]

    public init(
        threadId: String,
        botId: String,
        prompt: String,
        modelId: String? = nil,
        resumeSessionId: String? = nil,
        workingDirectory: String? = nil,
        environment: [String: String] = [:],
        configOptions: [String: String] = [:]
    ) {
        self.threadId = threadId
        self.botId = botId
        self.prompt = prompt
        self.modelId = modelId
        self.resumeSessionId = resumeSessionId
        self.workingDirectory = workingDirectory
        self.environment = environment
        self.configOptions = configOptions
    }
}

/// Canonical normalized event emitted by all native engine drivers during a turn.
/// Maps engine-specific wire frames (Claude stream-json, ACP JSON-RPC 2.0, Codex app-server)
/// into a single strongly-typed stream for persistence and UI rendering.
public enum TurnEvent: Equatable, Sendable, Codable {
    case sessionStarted(sessionId: String)
    case textDelta(String)
    case reasoningDelta(String)
    case toolCall(id: String, name: String, argumentsJSON: String)
    case toolResult(id: String, output: String, isError: Bool)
    case permissionRequest(id: String, tool: String, description: String)
    case configUpdated(key: String, value: String)
    case completed(stopReason: String, inputTokens: Int?, outputTokens: Int?)
    case error(code: String, message: String)

    /// True when the event represents user-visible output or side-effects that must not be duplicated by a blind retry or failover.
    public var producesVisibleOutput: Bool {
        switch self {
        case .textDelta(let text):
            return !text.isEmpty
        case .reasoningDelta(let text):
            return !text.isEmpty
        case .toolCall, .toolResult, .permissionRequest:
            return true
        case .sessionStarted, .configUpdated, .completed, .error:
            return false
        }
    }

    /// True when the event terminates a turn stream.
    public var isTerminal: Bool {
        switch self {
        case .completed:
            return true
        default:
            return false
        }
    }
}

/// Protocol implemented by all native CLI engine runners (Claude Code, Grok ACP, MiniMax mcode, Muse ACP, Codex app-server).
public protocol EngineDriver: Sendable {
    var engineId: String { get }
    func sendTurn(input: TurnInput) async throws -> AsyncStream<TurnEvent>
    func cancelTurn(threadId: String) async
}

// MARK: - Process Transport Abstractions

/// Exit disposition of a supervised child CLI process.
public enum ProcessExitReason: Equatable, Sendable, Codable {
    case exited(code: Int32)
    case signaled(signal: Int32)
    case cancelled
    case spawnFailed(message: String)
}

/// Specification for launching a native CLI engine subprocess.
public struct EngineSpawnSpec: Equatable, Sendable, Codable {
    public let executable: String
    public let arguments: [String]
    public let workingDirectory: String?
    public let environment: [String: String]

    public init(
        executable: String,
        arguments: [String],
        workingDirectory: String? = nil,
        environment: [String: String] = [:]
    ) {
        self.executable = executable
        self.arguments = arguments
        self.workingDirectory = workingDirectory
        self.environment = environment
    }
}

/// Direction of a native wire frame for diagnostic teeing.
public enum NativeProtocolDirection: String, Equatable, Sendable, Codable {
    case inbound = "in"
    case outbound = "out"
}

/// Redacted diagnostic record of a line sent to or received from a native CLI process.
public struct NativeProtocolRecord: Equatable, Sendable, Codable {
    public let engineId: String
    public let threadId: String
    public let direction: NativeProtocolDirection
    public let redactedLine: String
    public let timestamp: Double

    public init(
        engineId: String,
        threadId: String,
        direction: NativeProtocolDirection,
        line: String,
        timestamp: Double = Date().timeIntervalSince1970
    ) {
        self.engineId = engineId
        self.threadId = threadId
        self.direction = direction
        self.redactedLine = Self.redactSecrets(in: line)
        self.timestamp = timestamp
    }

    /// Redacts bearer tokens, API keys, and credential-shaped JSON fields before diagnostic logging.
    public static func redactSecrets(in raw: String) -> String {
        var result = raw
        let patterns = [
            #"("?(?:api_key|apiKey|token|secret|password|authorization)"?\s*:\s*")([^"]+)(")"#,
            #"(sk-[A-Za-z0-9_-]{12,})"#
        ]
        for (index, pattern) in patterns.enumerated() {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
                continue
            }
            let range = NSRange(result.startIndex..<result.endIndex, in: result)
            if index == 0 {
                result = regex.stringByReplacingMatches(in: result, options: [], range: range, withTemplate: "$1[REDACTED]$3")
            } else {
                result = regex.stringByReplacingMatches(in: result, options: [], range: range, withTemplate: "[REDACTED]")
            }
        }
        return result
    }
}

/// Live handle to a spawned or scripted CLI session with line-delimited stdout, chunked stderr, and stdin writer.
public struct EngineProcessSession: Sendable {
    public let pid: Int32
    public let stdoutLines: AsyncStream<String>
    public let stderrChunks: AsyncStream<String>
    public let writeStdinLine: @Sendable (String) async throws -> Void
    public let closeStdin: @Sendable () async -> Void
    public let cancel: @Sendable () async -> Void
    public let waitForExit: @Sendable () async -> ProcessExitReason

    public init(
        pid: Int32,
        stdoutLines: AsyncStream<String>,
        stderrChunks: AsyncStream<String>,
        writeStdinLine: @escaping @Sendable (String) async throws -> Void,
        closeStdin: @escaping @Sendable () async -> Void,
        cancel: @escaping @Sendable () async -> Void,
        waitForExit: @escaping @Sendable () async -> ProcessExitReason
    ) {
        self.pid = pid
        self.stdoutLines = stdoutLines
        self.stderrChunks = stderrChunks
        self.writeStdinLine = writeStdinLine
        self.closeStdin = closeStdin
        self.cancel = cancel
        self.waitForExit = waitForExit
    }
}

/// Protocol abstracting child process spawning so engine runners work identically over
/// `ProcessSupervisorActor` (real POSIX processes) and `EngineReplayHarness` (deterministic fixtures).
public protocol EngineProcessLauncher: Sendable {
    func launch(
        spec: EngineSpawnSpec,
        threadId: String,
        engineId: String
    ) async throws -> EngineProcessSession
}

// MARK: - Errors & Retry / Failover Classification

/// Errors thrown by engine drivers and the turn dispatcher.
public enum EngineDriverError: LocalizedError, Equatable, Sendable {
    case turnAlreadyActive(threadId: String)
    case noEnginesConfigured(botId: String)
    case spawnFailed(String)
    case stdinWriteFailed(String)
    case protocolError(code: String, message: String)
    case stallTimedOut(threadId: String, timeoutSeconds: Double)
    case cancelled(threadId: String)

    public var errorDescription: String? {
        switch self {
        case .turnAlreadyActive(let threadId):
            return "A turn is already active on thread \(threadId)."
        case .noEnginesConfigured(let botId):
            return "No engines are configured for bot \(botId)."
        case .spawnFailed(let msg):
            return "Failed to spawn CLI process: \(msg)"
        case .stdinWriteFailed(let msg):
            return "Failed to write to child stdin: \(msg)"
        case .protocolError(let code, let message):
            return "Engine protocol error (\(code)): \(message)"
        case .stallTimedOut(let threadId, let timeoutSeconds):
            return "Turn on thread \(threadId) stalled for more than \(timeoutSeconds)s."
        case .cancelled(let threadId):
            return "Turn on thread \(threadId) was cancelled."
        }
    }
}

/// Verdict returned by `TurnRetryClassifier` for an engine error.
public struct TurnErrorVerdict: Equatable, Sendable {
    public let reason: String
    public let isTransient: Bool
    public let isFailoverEligible: Bool

    public init(reason: String, isTransient: Bool, isFailoverEligible: Bool) {
        self.reason = reason
        self.isTransient = isTransient
        self.isFailoverEligible = isFailoverEligible
    }
}

/// Classifies engine error events to decide retry and fallback-chain advancement.
/// Matches `server/drivers/retry.ts` semantics: transient transport/rate-limit errors may retry
/// before output is produced, while model/quota/provider errors advance the fallback chain.
public enum TurnRetryClassifier {
    public static func classify(code: String, message: String, sawVisibleOutput: Bool) -> TurnErrorVerdict {
        // Once visible output or a tool call has been emitted, automatic retry or failover
        // is forbidden because re-running the prompt would duplicate text or side-effects.
        guard !sawVisibleOutput else {
            return TurnErrorVerdict(reason: code, isTransient: false, isFailoverEligible: false)
        }

        let lowerCode = code.lowercased()
        let lowerMsg = message.lowercased()

        if lowerCode == "cancelled" || lowerCode == "interrupted" {
            return TurnErrorVerdict(reason: "cancelled", isTransient: false, isFailoverEligible: false)
        }

        if lowerCode == "rate_limited" || lowerCode == "overloaded" || lowerCode == "server_error" ||
            lowerCode == "connection_reset" || lowerCode == "stall_timeout" ||
            lowerMsg.contains("429") || lowerMsg.contains("rate limit") ||
            lowerMsg.contains("overloaded") || lowerMsg.contains("econnreset") ||
            lowerMsg.contains("503") || lowerMsg.contains("502") {
            return TurnErrorVerdict(reason: lowerCode, isTransient: true, isFailoverEligible: true)
        }

        if lowerCode == "unknown_model" || lowerCode == "model_not_found" ||
            lowerCode == "auth_required" || lowerCode == "invalid_credentials" ||
            lowerCode == "quota_exceeded" || lowerCode == "spawn_error" ||
            lowerCode == "process_signal" || lowerCode == "process_exit" ||
            lowerMsg.contains("model_not_found") || lowerMsg.contains("unknown model") {
            return TurnErrorVerdict(reason: lowerCode, isTransient: false, isFailoverEligible: true)
        }

        return TurnErrorVerdict(reason: lowerCode, isTransient: false, isFailoverEligible: true)
    }
}

// MARK: - Bounded Backpressure Event Buffer

/// Bounded ring buffer for `TurnEvent` values that coalesces adjacent `.textDelta` or
/// `.reasoningDelta` events under backpressure so high-frequency streaming never drops
/// structural tool/completion events or grows unbounded in memory.
public struct BoundedTurnEventBuffer: Sendable {
    public let capacity: Int
    private var storage: [TurnEvent] = []
    public private(set) var coalescedDeltaCount: Int = 0

    public init(capacity: Int = 256) {
        self.capacity = max(4, capacity)
    }

    public var count: Int { storage.count }
    public var isEmpty: Bool { storage.isEmpty }

    public mutating func enqueue(_ event: TurnEvent) {
        // Coalesce adjacent text or reasoning deltas when the buffer is at capacity
        // or when the tail is already the same delta kind.
        if let last = storage.last {
            switch (last, event) {
            case (.textDelta(let prev), .textDelta(let next)) where storage.count >= capacity:
                storage[storage.count - 1] = .textDelta(prev + next)
                coalescedDeltaCount += 1
                return
            case (.reasoningDelta(let prev), .reasoningDelta(let next)) where storage.count >= capacity:
                storage[storage.count - 1] = .reasoningDelta(prev + next)
                coalescedDeltaCount += 1
                return
            default:
                break
            }
        }

        if storage.count >= capacity {
            // Compact any adjacent deltas across the buffer to free slots without losing text.
            if compactAdjacentDeltas() && storage.count < capacity {
                storage.append(event)
                return
            }
            // If still full, drop the oldest non-structural delta if possible.
            if let dropIdx = storage.firstIndex(where: {
                if case .textDelta = $0 { return true }
                if case .reasoningDelta = $0 { return true }
                return false
            }) {
                storage.remove(at: dropIdx)
            } else {
                storage.removeFirst()
            }
        }
        storage.append(event)
    }

    public mutating func dequeue() -> TurnEvent? {
        guard !storage.isEmpty else { return nil }
        return storage.removeFirst()
    }

    public mutating func drainAll() -> [TurnEvent] {
        defer { storage.removeAll(keepingCapacity: true) }
        return storage
    }

    private mutating func compactAdjacentDeltas() -> Bool {
        guard storage.count > 1 else { return false }
        var compacted: [TurnEvent] = []
        compacted.reserveCapacity(storage.count)
        var didCompact = false

        for event in storage {
            if let last = compacted.last {
                switch (last, event) {
                case (.textDelta(let a), .textDelta(let b)):
                    compacted[compacted.count - 1] = .textDelta(a + b)
                    coalescedDeltaCount += 1
                    didCompact = true
                    continue
                case (.reasoningDelta(let a), .reasoningDelta(let b)):
                    compacted[compacted.count - 1] = .reasoningDelta(a + b)
                    coalescedDeltaCount += 1
                    didCompact = true
                    continue
                default:
                    break
                }
            }
            compacted.append(event)
        }
        storage = compacted
        return didCompact
    }
}

// MARK: - TurnDispatcherActor & EngineCoordinatorActor

/// Per-thread turn dispatcher managing active turn state, stall detection, retry/failover across
/// a fallback chain of `EngineDriver`s, and SQLite transcript persistence via `DatabaseService`.
public actor TurnDispatcherActor {
    private struct ActiveTurnContext {
        let threadId: String
        let botId: String
        var currentEngine: any EngineDriver
        let task: Task<Void, Never>
    }

    private var activeTurns: [String: ActiveTurnContext] = [:]
    private let database: DatabaseService?
    private let stallTimeoutSeconds: Double
    private let maxRetriesPerEngine: Int
    private let retryDelaySeconds: Double
    private let bufferCapacity: Int

    public init(
        database: DatabaseService? = nil,
        stallTimeoutSeconds: Double = 120.0,
        maxRetriesPerEngine: Int = 1,
        retryDelaySeconds: Double = 0.05,
        bufferCapacity: Int = 256
    ) {
        self.database = database
        self.stallTimeoutSeconds = stallTimeoutSeconds
        self.maxRetriesPerEngine = maxRetriesPerEngine
        self.retryDelaySeconds = retryDelaySeconds
        self.bufferCapacity = bufferCapacity
    }

    public func isTurnActive(threadId: String) -> Bool {
        activeTurns[threadId] != nil
    }

    public func cancelTurn(threadId: String) async {
        guard let active = activeTurns.removeValue(forKey: threadId) else { return }
        active.task.cancel()
        await active.currentEngine.cancelTurn(threadId: threadId)
    }

    /// Dispatches a turn across the provided ordered fallback chain of drivers.
    /// Persists user and assistant messages into `DatabaseService` when configured.
    public func dispatchTurn(
        input: TurnInput,
        fallbackChain: [any EngineDriver]
    ) throws -> AsyncStream<TurnEvent> {
        guard !fallbackChain.isEmpty else {
            throw EngineDriverError.noEnginesConfigured(botId: input.botId)
        }
        guard activeTurns[input.threadId] == nil else {
            throw EngineDriverError.turnAlreadyActive(threadId: input.threadId)
        }

        let (stream, continuation) = AsyncStream<TurnEvent>.makeStream(
            bufferingPolicy: .bufferingNewest(bufferCapacity)
        )

        let task = Task { [weak self] in
            guard let self else {
                continuation.finish()
                return
            }
            await self.runTurnPipeline(
                input: input,
                fallbackChain: fallbackChain,
                continuation: continuation
            )
        }

        activeTurns[input.threadId] = ActiveTurnContext(
            threadId: input.threadId,
            botId: input.botId,
            currentEngine: fallbackChain[0],
            task: task
        )

        continuation.onTermination = { [weak self] termination in
            if case .cancelled = termination {
                Task { await self?.cancelTurn(threadId: input.threadId) }
            }
        }

        return stream
    }

    private func updateCurrentEngine(threadId: String, engine: any EngineDriver) {
        if var ctx = activeTurns[threadId] {
            ctx.currentEngine = engine
            activeTurns[threadId] = ctx
        }
    }

    private func finishTurn(threadId: String) {
        activeTurns.removeValue(forKey: threadId)
    }

    private func runTurnPipeline(
        input: TurnInput,
        fallbackChain: [any EngineDriver],
        continuation: AsyncStream<TurnEvent>.Continuation
    ) async {
        defer {
            finishTurn(threadId: input.threadId)
            continuation.finish()
        }

        if let database {
            let now = Date().timeIntervalSince1970
            try? await database.upsertThread(
                ThreadRecord(id: input.threadId, title: input.threadId, botId: input.botId, createdAt: now, updatedAt: now)
            )
            try? await database.insertMessage(
                MessageRecord(
                    id: "user-\(UUID().uuidString)",
                    threadId: input.threadId,
                    role: "user",
                    kind: "text",
                    content: input.prompt,
                    createdAt: now,
                    model: input.modelId
                )
            )
        }

        var accumulatedText = ""
        var buffer = BoundedTurnEventBuffer(capacity: bufferCapacity)
        var lastErrorEvent: TurnEvent?

        engineLoop: for (engineIndex, driver) in fallbackChain.enumerated() {
            if Task.isCancelled { return }
            updateCurrentEngine(threadId: input.threadId, engine: driver)

            var attempt = 0
            while attempt <= maxRetriesPerEngine {
                if Task.isCancelled { return }
                var sawVisibleOutput = false
                var terminalError: (code: String, message: String)?
                var didComplete = false

                do {
                    let driverStream = try await driver.sendTurn(input: input)
                    let outcome = await consumeWithStallWatchdog(
                        driverStream: driverStream,
                        driver: driver,
                        threadId: input.threadId
                    ) { event in
                        if event.producesVisibleOutput {
                            sawVisibleOutput = true
                        }
                        if case .textDelta(let delta) = event {
                            accumulatedText += delta
                        }
                        if case .error(let code, let message) = event {
                            terminalError = (code, message)
                            return
                        }
                        if case .completed = event {
                            didComplete = true
                        }
                        buffer.enqueue(event)
                        while let next = buffer.dequeue() {
                            continuation.yield(next)
                        }
                    }

                    if case .stalled = outcome {
                        terminalError = ("stall_timeout", "Turn stalled with no events for \(stallTimeoutSeconds)s")
                    }
                } catch {
                    terminalError = ("spawn_error", error.localizedDescription)
                }

                if let err = terminalError, !didComplete {
                    let errorEvent = TurnEvent.error(code: err.code, message: err.message)
                    lastErrorEvent = errorEvent
                    let verdict = TurnRetryClassifier.classify(
                        code: err.code,
                        message: err.message,
                        sawVisibleOutput: sawVisibleOutput
                    )

                    if verdict.isTransient && attempt < maxRetriesPerEngine {
                        attempt += 1
                        if retryDelaySeconds > 0 {
                            try? await Task.sleep(nanoseconds: UInt64(retryDelaySeconds * 1_000_000_000))
                        }
                        continue
                    }

                    if verdict.isFailoverEligible && (engineIndex + 1) < fallbackChain.count {
                        // Advance to the next fallback engine in the chain.
                        continue engineLoop
                    }

                    // Terminal failure on the final eligible engine: emit the error event.
                    continuation.yield(errorEvent)
                    return
                }

                if didComplete {
                    if let database, !accumulatedText.isEmpty {
                        try? await database.insertMessage(
                            MessageRecord(
                                id: "assistant-\(UUID().uuidString)",
                                threadId: input.threadId,
                                role: "assistant",
                                kind: "text",
                                content: accumulatedText,
                                createdAt: Date().timeIntervalSince1970,
                                model: input.modelId
                            )
                        )
                    }
                    return
                }

                break
            }
        }

        if let lastErrorEvent {
            continuation.yield(lastErrorEvent)
        }
    }

    private enum StreamConsumptionOutcome {
        case finished
        case stalled
    }

    private func consumeWithStallWatchdog(
        driverStream: AsyncStream<TurnEvent>,
        driver: any EngineDriver,
        threadId: String,
        onEvent: @escaping (TurnEvent) -> Void
    ) async -> StreamConsumptionOutcome {
        let timeoutNanos = UInt64(max(0.05, stallTimeoutSeconds) * 1_000_000_000)

        actor ActivityTracker {
            var lastActivityTime: DispatchTime = .now()
            var finished = false

            func touch() {
                lastActivityTime = .now()
            }

            func markFinished() {
                finished = true
            }

            func checkStalled(timeoutNanos: UInt64) -> Bool {
                guard !finished else { return false }
                let elapsed = DispatchTime.now().uptimeNanoseconds - lastActivityTime.uptimeNanoseconds
                return elapsed >= timeoutNanos
            }
        }

        let tracker = ActivityTracker()
        let checkIntervalNanos = min(timeoutNanos / 2, 50_000_000)

        let watchdogTask = Task { () -> Bool in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: max(10_000_000, checkIntervalNanos))
                if Task.isCancelled { return false }
                if await tracker.checkStalled(timeoutNanos: timeoutNanos) {
                    await driver.cancelTurn(threadId: threadId)
                    return true
                }
            }
            return false
        }

        for await event in driverStream {
            await tracker.touch()
            onEvent(event)
            if event.isTerminal {
                break
            }
        }

        await tracker.markFinished()
        watchdogTask.cancel()
        let didStall = await watchdogTask.value
        return didStall ? .stalled : .finished
    }
}

/// Top-level coordinator registering engine drivers and bot fallback chains,
/// routing turns through `TurnDispatcherActor` and broadcasting live `TurnEvent`s.
public actor EngineCoordinatorActor {
    private var driversById: [String: any EngineDriver] = [:]
    private var botFallbackChains: [String: [String]] = [:]
    private let dispatcher: TurnDispatcherActor

    public init(
        drivers: [any EngineDriver] = [],
        botFallbackChains: [String: [String]] = [:],
        dispatcher: TurnDispatcherActor = TurnDispatcherActor()
    ) {
        for driver in drivers {
            self.driversById[driver.engineId] = driver
        }
        self.botFallbackChains = botFallbackChains
        self.dispatcher = dispatcher
    }

    public func registerDriver(_ driver: any EngineDriver) {
        driversById[driver.engineId] = driver
    }

    public func setFallbackChain(forBot botId: String, engineIds: [String]) {
        botFallbackChains[botId] = engineIds
    }

    public func sendTurn(input: TurnInput) async throws -> AsyncStream<TurnEvent> {
        let chainIds = botFallbackChains[input.botId] ?? Array(driversById.keys.sorted())
        let chain = chainIds.compactMap { driversById[$0] }
        guard !chain.isEmpty else {
            throw EngineDriverError.noEnginesConfigured(botId: input.botId)
        }
        return try await dispatcher.dispatchTurn(input: input, fallbackChain: chain)
    }

    public func cancelTurn(threadId: String) async {
        await dispatcher.cancelTurn(threadId: threadId)
    }
}
