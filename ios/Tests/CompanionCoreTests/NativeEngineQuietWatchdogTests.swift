import Foundation
import Testing
@testable import CompanionCore

private final class QuietClockFixture: NativeEngineQuietClock, @unchecked Sendable {
    private let lock = NSLock()
    private var instant: TimeInterval = 1_000
    func now() -> TimeInterval { lock.lock(); defer { lock.unlock() }; return instant }
    func advance(_ seconds: TimeInterval) { lock.lock(); defer { lock.unlock() }; instant += seconds }
    func sleep(seconds: TimeInterval) async throws { try await Task.sleep(nanoseconds: 1_000_000) }
}

private actor QuietDriverFixture: EngineQuietActivityReporting {
    nonisolated let engineId: String
    private let initialEvents: [TurnEvent]
    private let evidence: NativeEngineQuietEvidence?
    private let tcp: Bool?
    private let cpu: Double?
    private let cpuIncrement: Double
    private var continuation: AsyncStream<TurnEvent>.Continuation?
    private(set) var samples = 0
    private(set) var cancelled = 0
    private(set) var sends = 0

    init(id: String = "quiet", events: [TurnEvent] = [], evidence: NativeEngineQuietEvidence? = nil,
         cpu: Double? = nil, tcp: Bool? = nil, cpuIncrement: Double = 0) {
        engineId = id; initialEvents = events; self.evidence = evidence; self.cpu = cpu
        self.tcp = tcp; self.cpuIncrement = cpuIncrement
    }
    func sendTurn(input: TurnInput) async throws -> AsyncStream<TurnEvent> {
        sends += 1
        let (stream, continuation) = AsyncStream<TurnEvent>.makeStream()
        self.continuation = continuation
        for event in initialEvents { continuation.yield(event) }
        if initialEvents.last?.isTerminal == true { continuation.finish() }
        return stream
    }
    func cancelTurn(threadId: String) async { cancelled += 1; continuation?.finish() }
    func quietActivity(threadId: String) async -> NativeEngineQuietActivity {
        samples += 1
        let process = NativeProcessActivity(cpuSeconds: cpu.map { $0 + Double(samples) * cpuIncrement }, establishedTCP: tcp)
        return await evidence?.activity(process: process) ?? NativeEngineQuietActivity(process: process)
    }
}

private actor QuietEventCollector {
    private(set) var events: [TurnEvent] = []
    func append(_ event: TurnEvent) { events.append(event) }
}

private actor QuietCommandFixture: NativeQuietCommandRunning {
    private let ps: NativeQuietCommandResult?
    private let sockets: NativeQuietCommandResult?
    private(set) var arguments: [[String]] = []
    init(ps: NativeQuietCommandResult?, sockets: NativeQuietCommandResult?) { self.ps = ps; self.sockets = sockets }
    func run(executable: String, arguments: [String]) async -> NativeQuietCommandResult? {
        self.arguments.append(arguments)
        return executable == "/bin/ps" ? ps : sockets
    }
}

private func waitForQuietSamples(_ driver: QuietDriverFixture, _ count: Int) async throws {
    for _ in 0..<300 {
        if await driver.samples >= count { return }
        try await Task.sleep(nanoseconds: 1_000_000)
    }
    Issue.record("The fixture watchdog did not sample the driver")
}

@Suite("Native Quiet Engine Watchdog")
struct NativeEngineQuietWatchdogTests {
    @Test("Current stderr limits stop the runtime after two quiet minutes with rate and quota kept separate")
    func currentProviderLimitClassification() async throws {
        for (chunks, expected) in [
            (["HTTP 4", "29: Too Many Requests; retry-after 18000"], "rate_limited"),
            (["stream error: AI_APICallError: Usage limit reached"], "quota_exceeded"),
        ] {
            let clock = QuietClockFixture(), evidence = NativeEngineQuietEvidence()
            for chunk in chunks { await evidence.appendStderr(chunk, at: clock.now()) }
            let driver = QuietDriverFixture(evidence: evidence), collector = QuietEventCollector()
            let stream = try await driver.sendTurn(input: TurnInput(threadId: "t", botId: "b", prompt: "fixture"))
            let consumed = Task {
                await NativeEngineQuietWatchdog.consume(stream: stream, driver: driver, threadId: "t",
                    policy: NativeEngineQuietPolicy(), clock: clock, onEvent: { await collector.append($0) })
            }
            try await waitForQuietSamples(driver, 1)
            clock.advance(119)
            let before = await driver.samples
            try await waitForQuietSamples(driver, before + 1)
            #expect(await driver.cancelled == 0)
            clock.advance(2)
            #expect(await consumed.value == .providerLimit(code: expected))
            #expect(await driver.cancelled == 1)
            #expect(await collector.events.isEmpty)
        }
    }

    @Test("Only known idle CPU plus known absent sockets and logs can use the five-minute no-signs bound")
    func noSignsAndUnknown() async throws {
        let clock = QuietClockFixture(), idle = QuietDriverFixture(cpu: 0, tcp: false)
        let stream = try await idle.sendTurn(input: TurnInput(threadId: "idle", botId: "b", prompt: "fixture"))
        let consumed = Task {
            await NativeEngineQuietWatchdog.consume(stream: stream, driver: idle, threadId: "idle", policy: NativeEngineQuietPolicy(), clock: clock, onEvent: { _ in })
        }
        try await waitForQuietSamples(idle, 2)
        clock.advance(5)
        let start = await idle.samples
        try await waitForQuietSamples(idle, start + 1)
        clock.advance(299)
        let before = await idle.samples
        try await waitForQuietSamples(idle, before + 1)
        #expect(await idle.cancelled == 0)
        clock.advance(2)
        #expect(await consumed.value == .stalled)

        for unknownOrBusy in [QuietDriverFixture(cpu: 0, tcp: nil), QuietDriverFixture(cpu: 0, tcp: true), QuietDriverFixture(cpu: 0, tcp: false, cpuIncrement: 0.1)] {
            let otherClock = QuietClockFixture()
            let otherStream = try await unknownOrBusy.sendTurn(input: TurnInput(threadId: "other", botId: "b", prompt: "fixture"))
            let other = Task {
                await NativeEngineQuietWatchdog.consume(stream: otherStream, driver: unknownOrBusy, threadId: "other",
                    policy: NativeEngineQuietPolicy(), clock: otherClock, onEvent: { _ in })
            }
            try await waitForQuietSamples(unknownOrBusy, 2)
            otherClock.advance(301)
            let count = await unknownOrBusy.samples
            try await waitForQuietSamples(unknownOrBusy, count + 2)
            #expect(await unknownOrBusy.cancelled == 0)
            otherClock.advance(600)
            #expect(await other.value == .stalled)
        }
    }

    @Test("A running tool prevents early no-signs cancellation and cannot replay through a backup")
    func toolActivityAndNoReplay() async throws {
        let clock = QuietClockFixture()
        let running = QuietDriverFixture(events: [.toolCall(id: "tool", name: "shell", argumentsJSON: "{}")], cpu: 0, tcp: false)
        let stream = try await running.sendTurn(input: TurnInput(threadId: "tool", botId: "b", prompt: "fixture"))
        let consumed = Task {
            await NativeEngineQuietWatchdog.consume(stream: stream, driver: running, threadId: "tool", policy: NativeEngineQuietPolicy(), clock: clock, onEvent: { _ in })
        }
        try await waitForQuietSamples(running, 2)
        clock.advance(301)
        let count = await running.samples
        try await waitForQuietSamples(running, count + 2)
        #expect(await running.cancelled == 0)
        clock.advance(600)
        #expect(await consumed.value == .stalled)

        let primary = QuietDriverFixture(id: "primary", events: [.toolCall(id: "tool", name: "write_file", argumentsJSON: "{}")])
        let backup = QuietDriverFixture(id: "backup", events: [.completed(stopReason: "end_turn", inputTokens: nil, outputTokens: nil)])
        let dispatcher = TurnDispatcherActor(stallTimeoutSeconds: 0.03, maxRetriesPerEngine: 1, retryDelaySeconds: 0)
        let dispatched = try await dispatcher.dispatchTurn(input: TurnInput(threadId: "no-replay", botId: "b", prompt: "fixture"), fallbackChain: [primary, backup])
        var events: [TurnEvent] = []
        for await event in dispatched { events.append(event) }
        #expect(await primary.sends == 1)
        #expect(await backup.sends == 0)
        #expect(events.contains { if case .toolCall = $0 { return true }; return false })
        #expect(events.contains { if case .error(code: "stall_timeout", message: _) = $0 { return true }; return false })
    }

    @Test("Process inspection includes child CPU and established sockets and preserves unknown results")
    func boundedProcessTreeSampler() async {
        let ps = NativeQuietCommandResult(output: "100 1 0:00.50\n101 100 0:01.25\n999 1 1:00.00\n")
        let commands = QuietCommandFixture(ps: ps, sockets: NativeQuietCommandResult(output: "p101\n"))
        let sampler = NativeMacEngineActivitySampler(commands: commands)
        #expect(await sampler.sample(rootPID: 100) == NativeProcessActivity(cpuSeconds: 1.75, establishedTCP: true))
        let arguments = await commands.arguments
        #expect(arguments.count == 2)
        #expect(arguments[1].contains("100,101"))
        #expect(!arguments[1].contains("999"))
        let unavailable = NativeMacEngineActivitySampler(commands: QuietCommandFixture(ps: ps, sockets: nil))
        #expect(await unavailable.sample(rootPID: 100) == NativeProcessActivity(cpuSeconds: 1.75, establishedTCP: nil))
        let failed = NativeMacEngineActivitySampler(commands: QuietCommandFixture(ps: NativeQuietCommandResult(output: "", status: 1), sockets: nil))
        #expect(await failed.sample(rootPID: 100) == .unknown)
        let malformed = NativeMacEngineActivitySampler(commands: QuietCommandFixture(ps: NativeQuietCommandResult(output: "100 1 invalid"), sockets: nil))
        #expect(await malformed.sample(rootPID: 100) == .unknown)
    }

    @Test("Evidence stays private, distinguishes explicit quota from throttling, and normal logs defer cancellation")
    func boundedCurrentEvidence() async throws {
        let evidence = NativeEngineQuietEvidence(), clock = QuietClockFixture()
        await evidence.appendStderr("api_key=fixture-private-key\n429 rate limited", at: clock.now())
        #expect(await evidence.activity(process: .unknown).providerLimit?.kind == .rateLimited)
        await evidence.appendStderr("\ninsufficient_quota", at: clock.now())
        #expect(await evidence.activity(process: .unknown).providerLimit?.kind == .quotaExceeded)
        await evidence.appendStderr(String(repeating: "x", count: 20_000), at: clock.now() + 1)
        let state = await evidence.activity(process: .unknown)
        #expect(state.lastLogAt == clock.now() + 1)
        #expect(state.providerLimit?.kind == .quotaExceeded)
        let nextTurn = NativeEngineQuietEvidence()
        #expect(await nextTurn.activity(process: .unknown).providerLimit == nil)
    }
}
