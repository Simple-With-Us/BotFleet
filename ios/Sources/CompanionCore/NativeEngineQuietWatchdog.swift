import Foundation

public enum NativeProviderLimitKind: String, Sendable, Equatable {
    case rateLimited = "rate_limited"
    case quotaExceeded = "quota_exceeded"

    /// Trusted current-turn stderr only; successful assistant prose is never scanned here.
    public static func classify(_ text: String) -> Self? {
        let hard = #"(?i)\b(?:usage_limit_exceeded|usage[_ -](?:limit|cap)s?|quota[_ -](?:exceeded|exhausted)|insufficient[_ -](?:quota|balance|funds)|GoUsageLimitError|FreeUsageLimitError|credits? (?:exhausted|depleted|used up)|out of credits|billing (?:limit|failure|error)|payment required|enforced_spend_limit(?:_reached)?|monthly (?:usage )?limit|weekly (?:usage )?limit)\b"#
        if text.range(of: hard, options: .regularExpression) != nil { return .quotaExceeded }
        let rate = #"(?i)\b429\b|rate[_ -]?limit|too many requests|concurrency (?:limit|cap)|too many concurrent"#
        return text.range(of: rate, options: .regularExpression) != nil ? .rateLimited : nil
    }
}

public struct NativeProviderLimitEvidence: Sendable, Equatable {
    public let kind: NativeProviderLimitKind
    public let observedAt: TimeInterval
    public init(kind: NativeProviderLimitKind, observedAt: TimeInterval) { self.kind = kind; self.observedAt = observedAt }
}

public struct NativeProcessActivity: Sendable, Equatable {
    public let cpuSeconds: Double?
    public let establishedTCP: Bool?
    public static let unknown = NativeProcessActivity(cpuSeconds: nil, establishedTCP: nil)
    public init(cpuSeconds: Double?, establishedTCP: Bool?) { self.cpuSeconds = cpuSeconds; self.establishedTCP = establishedTCP }
}

public struct NativeEngineQuietActivity: Sendable, Equatable {
    public let process: NativeProcessActivity
    public let lastLogAt: TimeInterval?
    public let providerLimit: NativeProviderLimitEvidence?
    public static let unknown = NativeEngineQuietActivity(process: .unknown)
    public init(process: NativeProcessActivity, lastLogAt: TimeInterval? = nil, providerLimit: NativeProviderLimitEvidence? = nil) {
        self.process = process; self.lastLogAt = lastLogAt; self.providerLimit = providerLimit
    }
}

/// Optional reporting keeps engines without a process probe on the existing hard silence bound.
public protocol EngineQuietActivityReporting: EngineDriver {
    func quietActivity(threadId: String) async -> NativeEngineQuietActivity
}

public protocol NativeEngineActivitySampling: Sendable {
    func sample(rootPID: Int32) async -> NativeProcessActivity
}

public protocol NativeEngineQuietClock: Sendable {
    func now() -> TimeInterval
    func sleep(seconds: TimeInterval) async throws
}

public struct NativeMonotonicQuietClock: NativeEngineQuietClock {
    public init() {}
    public func now() -> TimeInterval { ProcessInfo.processInfo.systemUptime }
    public func sleep(seconds: TimeInterval) async throws {
        try await Task.sleep(nanoseconds: UInt64(max(0.001, min(seconds, 86_400)) * 1_000_000_000))
    }
}

/// Bounded, per-turn evidence contains no log text outside this actor.
public actor NativeEngineQuietEvidence {
    private var tail = ""
    private var lastLogAt: TimeInterval?
    private var limit: NativeProviderLimitEvidence?
    public init() {}

    public func appendStderr(_ chunk: String, at: TimeInterval) {
        guard !chunk.isEmpty, at.isFinite else { return }
        tail = String((tail + String(chunk.suffix(8_192))).suffix(8_192))
        lastLogAt = max(lastLogAt ?? at, at)
        if let kind = NativeProviderLimitKind.classify(tail) {
            // A later ambiguous throttle cannot turn explicit quota evidence into a short rate hold.
            if limit == nil || kind == .quotaExceeded || limit?.kind != .quotaExceeded {
                limit = NativeProviderLimitEvidence(kind: kind, observedAt: at)
            }
        }
    }

    public func activity(process: NativeProcessActivity) -> NativeEngineQuietActivity {
        NativeEngineQuietActivity(process: process, lastLogAt: lastLogAt, providerLimit: limit)
    }
}

public struct NativeEngineQuietPolicy: Sendable, Equatable {
    public let limitQuietSeconds: TimeInterval
    public let noSignsSeconds: TimeInterval
    public let hardQuietSeconds: TimeInterval
    public let pollSeconds: TimeInterval
    public init(limitQuietSeconds: TimeInterval = 120, noSignsSeconds: TimeInterval = 300,
                hardQuietSeconds: TimeInterval = 900, pollSeconds: TimeInterval = 5) {
        self.limitQuietSeconds = max(0.01, limitQuietSeconds)
        self.noSignsSeconds = max(0.01, noSignsSeconds)
        self.hardQuietSeconds = max(0.01, hardQuietSeconds)
        self.pollSeconds = max(0.001, min(pollSeconds, self.hardQuietSeconds / 2))
    }
}

public enum NativeEngineQuietOutcome: Sendable, Equatable {
    case finished
    case stalled
    case providerLimit(code: String)
}

private actor NativeQuietTurnState {
    private var lastEventAt: TimeInterval
    private var lastLogAt: TimeInterval?
    private var lastProgressAt: TimeInterval?
    private var previousCPU: Double?
    private var noSignsSince: TimeInterval?
    private var runningTools: Set<String> = []
    private var toolOverflow = false
    private var awaitingPermission = false
    private var finished = false
    private var stopped: NativeEngineQuietOutcome?

    init(at: TimeInterval) { lastEventAt = at }

    func observe(_ event: TurnEvent, at: TimeInterval) -> Bool {
        guard !finished, stopped == nil else { return false }
        lastEventAt = at; noSignsSince = nil
        switch event {
        case .toolCall(let id, _, _):
            if runningTools.count < 256 { runningTools.insert(id) } else { toolOverflow = true }
            lastProgressAt = at; awaitingPermission = false
        case .toolResult(let id, _, _): runningTools.remove(id); lastProgressAt = at; awaitingPermission = false
        case .permissionRequest: awaitingPermission = true
        case .textDelta, .reasoningDelta: lastProgressAt = at; awaitingPermission = false
        default: break
        }
        if event.isTerminal { finished = true }
        return true
    }

    func evaluate(_ activity: NativeEngineQuietActivity, at now: TimeInterval, policy: NativeEngineQuietPolicy) -> NativeEngineQuietOutcome? {
        guard !finished, stopped == nil else { return nil }
        if let at = activity.lastLogAt, at.isFinite, at <= now { lastLogAt = max(lastLogAt ?? at, at) }
        let quietSince = max(lastEventAt, lastLogAt ?? lastEventAt)
        let quietFor = max(0, now - quietSince)
        let toolRunning = !runningTools.isEmpty || toolOverflow || awaitingPermission
        if !toolRunning, let limit = activity.providerLimit, limit.observedAt <= now,
           limit.observedAt >= (lastProgressAt ?? -.infinity),
           now - max(quietSince, limit.observedAt) >= policy.limitQuietSeconds {
            stopped = .providerLimit(code: limit.kind.rawValue)
        } else {
            let cpu = activity.process.cpuSeconds
            let cpuIdle = cpu != nil && previousCPU != nil && cpu! >= previousCPU! && cpu! - previousCPU! < 0.001
            previousCPU = cpu
            if !toolRunning, cpuIdle, activity.process.establishedTCP == false, quietFor >= policy.pollSeconds {
                noSignsSince = noSignsSince ?? now
                if now - noSignsSince! >= policy.noSignsSeconds { stopped = .stalled }
            } else { noSignsSince = nil }
            if quietFor >= policy.hardQuietSeconds { stopped = .stalled }
        }
        return stopped
    }

    func finish() { finished = true }
    func outcome() -> NativeEngineQuietOutcome { stopped ?? .finished }
}

public enum NativeEngineQuietWatchdog {
    /// Runs against the real stream/cancellation boundary; a provider-limit cancellation is not forwarded as success.
    public static func consume(
        stream: AsyncStream<TurnEvent>, driver: any EngineDriver, threadId: String,
        policy: NativeEngineQuietPolicy, clock: any NativeEngineQuietClock = NativeMonotonicQuietClock(),
        onEvent: @escaping (TurnEvent) async -> Void
    ) async -> NativeEngineQuietOutcome {
        let state = NativeQuietTurnState(at: clock.now())
        let watcher = Task {
            while !Task.isCancelled {
                do { try await clock.sleep(seconds: policy.pollSeconds) } catch { return }
                guard !Task.isCancelled else { return }
                let activity = await (driver as? any EngineQuietActivityReporting)?.quietActivity(threadId: threadId) ?? .unknown
                if await state.evaluate(activity, at: clock.now(), policy: policy) != nil {
                    await driver.cancelTurn(threadId: threadId)
                    return
                }
            }
        }
        for await event in stream {
            guard await state.observe(event, at: clock.now()) else { break }
            await onEvent(event)
            if event.isTerminal { break }
        }
        await state.finish()
        watcher.cancel()
        await watcher.value
        return await state.outcome()
    }
}

public struct NativeQuietCommandResult: Sendable {
    public let output: String
    public let status: Int32
    public let complete: Bool
    public let hadStderr: Bool
    public init(output: String, status: Int32 = 0, complete: Bool = true, hadStderr: Bool = false) {
        self.output = output; self.status = status; self.complete = complete; self.hadStderr = hadStderr
    }
}

public protocol NativeQuietCommandRunning: Sendable {
    func run(executable: String, arguments: [String]) async -> NativeQuietCommandResult?
}

/// Fixed executables and arguments perform local read-only inspection; missing or refused tools mean unknown.
public struct NativeMacEngineActivitySampler: NativeEngineActivitySampling {
    private let commands: any NativeQuietCommandRunning
    public init(commands: any NativeQuietCommandRunning = NativeBoundedQuietCommandRunner()) { self.commands = commands }

    public func sample(rootPID: Int32) async -> NativeProcessActivity {
        guard rootPID > 0, let ps = await commands.run(executable: "/bin/ps", arguments: ["-axo", "pid=,ppid=,time="]),
              ps.status == 0, ps.complete, !ps.hadStderr,
              let tree = Self.processTree(ps.output, rootPID: rootPID) else { return .unknown }
        let pids = tree.map(\.pid).sorted().map(String.init).joined(separator: ",")
        guard let sockets = await commands.run(executable: "/usr/sbin/lsof", arguments: ["-nP", "-a", "-p", pids, "-iTCP", "-sTCP:ESTABLISHED", "-Fp"]),
              sockets.complete, !sockets.hadStderr, sockets.status == 0 || (sockets.status == 1 && sockets.output.isEmpty) else {
            return NativeProcessActivity(cpuSeconds: tree.reduce(0) { $0 + $1.cpu }, establishedTCP: nil)
        }
        return NativeProcessActivity(cpuSeconds: tree.reduce(0) { $0 + $1.cpu }, establishedTCP: !sockets.output.isEmpty)
    }

    private static func processTree(_ output: String, rootPID: Int32) -> [(pid: Int32, cpu: Double)]? {
        let lines = output.split(whereSeparator: \.isNewline)
        guard lines.count <= 4_096 else { return nil }
        var rows: [(pid: Int32, parent: Int32, cpu: Double)] = []
        for line in lines {
            let parts = line.split(whereSeparator: \.isWhitespace)
            guard parts.count == 3, let pid = Int32(parts[0]), let parent = Int32(parts[1]), let cpu = cpuSeconds(String(parts[2])) else { return nil }
            rows.append((pid, parent, cpu))
        }
        guard rows.contains(where: { $0.pid == rootPID }) else { return nil }
        var ids: Set<Int32> = [rootPID]
        var added = true
        while added {
            added = false
            for row in rows where ids.contains(row.parent) && !ids.contains(row.pid) { ids.insert(row.pid); added = true }
            if ids.count > 256 { return nil }
        }
        return rows.filter { ids.contains($0.pid) }.map { ($0.pid, $0.cpu) }
    }

    private static func cpuSeconds(_ value: String) -> Double? {
        let dayParts = value.split(separator: "-", omittingEmptySubsequences: false)
        guard dayParts.count <= 2 else { return nil }
        let days = dayParts.count == 2 ? Double(dayParts[0]) : 0
        let parts = dayParts.last!.split(separator: ":")
        let time = parts.compactMap { Double($0) }
        guard let days, days >= 0, days.isFinite, parts.count == time.count,
              (2...3).contains(time.count), time.allSatisfy({ $0 >= 0 && $0.isFinite }) else { return nil }
        return days * 86_400 + time.reversed().enumerated().reduce(0) { $0 + $1.element * pow(60, Double($1.offset)) }
    }
}

public struct NativeBoundedQuietCommandRunner: NativeQuietCommandRunning {
    public init() {}
    public func run(executable: String, arguments: [String]) async -> NativeQuietCommandResult? {
        #if os(macOS)
        guard ["/bin/ps", "/usr/sbin/lsof"].contains(executable) else { return nil }
        return await withCheckedContinuation { (continuation: CheckedContinuation<NativeQuietCommandResult?, Never>) in
            let process = Process(), output = Pipe(), errorOutput = Pipe()
            let capture = NativeQuietCommandCapture(continuation: continuation)
            process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments
            process.standardInput = FileHandle.nullDevice; process.standardOutput = output; process.standardError = errorOutput
            output.fileHandleForReading.readabilityHandler = { handle in
                if capture.append(handle.availableData) { process.terminate() }
            }
            errorOutput.fileHandleForReading.readabilityHandler = { handle in capture.noteStderr(handle.availableData) }
            let deadline = DispatchWorkItem {
                capture.markIncomplete()
                if process.isRunning { process.terminate() }
                capture.finish(status: nil)
            }
            process.terminationHandler = { stopped in
                deadline.cancel()
                output.fileHandleForReading.readabilityHandler = nil; errorOutput.fileHandleForReading.readabilityHandler = nil
                _ = capture.append(output.fileHandleForReading.readDataToEndOfFile())
                capture.noteStderr(errorOutput.fileHandleForReading.readDataToEndOfFile())
                capture.finish(status: stopped.terminationStatus)
            }
            do { try process.run(); DispatchQueue.global().asyncAfter(deadline: .now() + 2, execute: deadline) }
            catch {
                output.fileHandleForReading.readabilityHandler = nil; errorOutput.fileHandleForReading.readabilityHandler = nil
                capture.finish(status: nil)
            }
        }
        #else
        return nil
        #endif
    }
}

#if os(macOS)
private final class NativeQuietCommandCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    private var complete = true
    private var hadStderr = false
    private var continuation: CheckedContinuation<NativeQuietCommandResult?, Never>?
    init(continuation: CheckedContinuation<NativeQuietCommandResult?, Never>) { self.continuation = continuation }
    func append(_ bytes: Data) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard data.count + bytes.count <= 256 * 1024 else { complete = false; return true }
        data.append(bytes); return false
    }
    func noteStderr(_ bytes: Data) { lock.lock(); defer { lock.unlock() }; hadStderr = hadStderr || !bytes.isEmpty }
    func markIncomplete() { lock.lock(); defer { lock.unlock() }; complete = false }
    func finish(status: Int32?) {
        lock.lock()
        let callback = continuation
        continuation = nil
        let result = status.map { NativeQuietCommandResult(output: String(decoding: data, as: UTF8.self), status: $0, complete: complete, hadStderr: hadStderr) }
        lock.unlock()
        callback?.resume(returning: result)
    }
}
#endif
