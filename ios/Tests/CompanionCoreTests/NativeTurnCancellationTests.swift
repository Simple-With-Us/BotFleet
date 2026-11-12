import Foundation
import Testing
@testable import CompanionCore

@Suite("Native Turn Cancellation Drain")
struct NativeTurnCancellationTests {
    @Test("Consumer termination retains ownership while duplicate cancellation and shutdown join teardown")
    func consumerCancellationDrainsBeforeShutdown() async throws {
        let gate = CancellationReleaseGate()
        let driver = GatedCancellationDriver(gate: gate)
        let dispatcher = TurnDispatcherActor(maxRetriesPerEngine: 0)
        let input = TurnInput(threadId: "thread", botId: "bot", prompt: "fixture")
        let stream = try await dispatcher.dispatchTurn(input: input, fallbackChain: [driver])
        let consumer = Task { for await _ in stream {} }
        await driver.waitForSendCount(1)
        consumer.cancel()
        await gate.waitUntilEntered()
        await driver.waitForConsumerTermination()

        #expect(await dispatcher.isTurnActive(threadId: input.threadId))
        #expect(await dispatcher.isBotActive(botId: input.botId))
        #expect(await dispatcher.activeTurnCount() == 1)
        let outcomes = CancellationCallOutcomes()
        let first = Task {
            await outcomes.begin()
            try await dispatcher.shutdownAndDrain()
            await outcomes.finish("first shutdown")
        }
        let second = Task {
            await outcomes.begin()
            try await dispatcher.shutdownAndDrain()
            await outcomes.finish("second shutdown")
        }
        let duplicate = Task {
            await outcomes.begin()
            await dispatcher.cancelTurn(threadId: input.threadId)
            await outcomes.finish("duplicate cancel")
        }
        await outcomes.waitForBeginnings(3)
        // Scheduling opportunity only; this does not prove that the pipeline settled.
        for _ in 0..<100 { await Task.yield() }
        #expect(await outcomes.completed.isEmpty)
        #expect(await driver.cancellationCount == 1)
        #expect(await dispatcher.activeTurnCount() == 1)

        await gate.release()
        try await first.value
        try await second.value
        await duplicate.value
        await consumer.value
        #expect(await outcomes.completed.count == 3)
        #expect(await driver.cancellationCount == 1)
        #expect(await driver.completedCancellationCount == 1)
        #expect(await dispatcher.activeTurnCount() == 0)
        #expect(await dispatcher.isTurnActive(threadId: input.threadId) == false)
        #expect(await dispatcher.isBotActive(botId: input.botId) == false)
    }

    @Test("A draining fallback engine fences thread reuse until its own cancellation completes")
    func currentEngineCancellationFencesThreadReuse() async throws {
        let gate = CancellationReleaseGate()
        let driver = GatedCancellationDriver(gate: gate)
        let primary = RefusingCancellationDriver()
        let dispatcher = TurnDispatcherActor(maxRetriesPerEngine: 0)
        let input = TurnInput(threadId: "thread", botId: "bot", prompt: "fixture")
        let original = try await dispatcher.dispatchTurn(input: input, fallbackChain: [primary, driver])
        let consumer = Task { for await _ in original {} }
        await driver.waitForSendCount(1)
        let cancellation = Task { await dispatcher.cancelTurn(threadId: input.threadId) }
        await gate.waitUntilEntered()
        await driver.waitForConsumerTermination()
        await #expect(throws: EngineDriverError.turnAlreadyActive(threadId: input.threadId)) {
            try await dispatcher.dispatchTurn(input: input, fallbackChain: [driver])
        }
        #expect(await primary.cancellationCount == 0)
        #expect(await driver.cancellationCount == 1)
        #expect(await dispatcher.activeTurnCount() == 1)

        await gate.release()
        await cancellation.value
        await consumer.value
        let replacement = try await dispatcher.dispatchTurn(input: input, fallbackChain: [driver])
        let replacementConsumer = Task { for await _ in replacement {} }
        await driver.waitForSendCount(2)
        #expect(await dispatcher.isTurnActive(threadId: input.threadId))
        #expect(await driver.cancellationCount == 1)
        await dispatcher.cancelTurn(threadId: input.threadId)
        await replacementConsumer.value
        try await dispatcher.shutdownAndDrain()
        #expect(await driver.cancellationCount == 2)
        #expect(await dispatcher.activeTurnCount() == 0)
    }
}

private actor CancellationReleaseGate {
    private var entered = false
    private var released = false
    private var entryWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func hold() async {
        entered = true
        let waiters = entryWaiters
        entryWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
        if !released { await withCheckedContinuation { releaseWaiters.append($0) } }
    }

    func waitUntilEntered() async {
        if !entered { await withCheckedContinuation { entryWaiters.append($0) } }
    }

    func release() {
        released = true
        let waiters = releaseWaiters
        releaseWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }
}

private actor GatedCancellationDriver: EngineDriver {
    nonisolated let engineId = "gated"
    private let gate: CancellationReleaseGate
    private var continuation: AsyncStream<TurnEvent>.Continuation?
    private var sends = 0
    private var sendWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var terminated = false
    private var terminationWaiters: [CheckedContinuation<Void, Never>] = []
    private(set) var cancellationCount = 0
    private(set) var completedCancellationCount = 0

    init(gate: CancellationReleaseGate) { self.gate = gate }

    func sendTurn(input: TurnInput) async throws -> AsyncStream<TurnEvent> {
        let (stream, output) = AsyncStream<TurnEvent>.makeStream()
        continuation = output
        output.onTermination = { [weak self] _ in Task { await self?.consumerTerminated() } }
        sends += 1
        let ready = sendWaiters.filter { $0.0 <= sends }
        sendWaiters.removeAll { $0.0 <= sends }
        for (_, waiter) in ready { waiter.resume() }
        return stream
    }

    func cancelTurn(threadId: String) async {
        cancellationCount += 1
        continuation?.finish()
        await gate.hold()
        completedCancellationCount += 1
    }

    func waitForSendCount(_ count: Int) async {
        if sends < count { await withCheckedContinuation { sendWaiters.append((count, $0)) } }
    }

    func waitForConsumerTermination() async {
        if !terminated { await withCheckedContinuation { terminationWaiters.append($0) } }
    }

    private func consumerTerminated() {
        terminated = true
        let waiters = terminationWaiters
        terminationWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }
}

private actor RefusingCancellationDriver: EngineDriver {
    nonisolated let engineId = "refusing"
    private(set) var cancellationCount = 0
    func sendTurn(input: TurnInput) async throws -> AsyncStream<TurnEvent> {
        AsyncStream { output in
            output.yield(.error(code: "unknown_model", message: "fixture refusal"))
            output.finish()
        }
    }
    func cancelTurn(threadId: String) async { cancellationCount += 1 }
}

private actor CancellationCallOutcomes {
    private var beginnings = 0
    private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private(set) var completed: Set<String> = []
    func begin() {
        beginnings += 1
        let ready = waiters.filter { $0.0 <= beginnings }
        waiters.removeAll { $0.0 <= beginnings }
        for (_, waiter) in ready { waiter.resume() }
    }
    func finish(_ name: String) { completed.insert(name) }
    func waitForBeginnings(_ count: Int) async {
        if beginnings < count { await withCheckedContinuation { waiters.append((count, $0)) } }
    }
}
