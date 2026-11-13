import Foundation
import Testing
@testable import CompanionCore

@Suite("Native routine admission rechecks")
struct NativeRoutineAdmissionRegressionTests {
    @Test("Routine revision changes during an awaited executor prevent success admission")
    func routineRevisionChangeDuringExecution() async throws {
        let database = try DatabaseService(path: ":memory:")
        let scheduler = NativeRoutinesSchedulerActor(database: database)
        let gate = RoutineExecutionGate()
        await scheduler.registerRoutine(ScheduledRoutine(id: "routine-a", botId: "bot-a", title: "A"))

        let running = Task {
            try await scheduler.fireRoutine(id: "routine-a", runId: "run-revision", now: 100) { _, _ in
                await gate.blockUntilReleased()
            }
        }
        await gate.waitUntilStarted()
        await scheduler.registerRoutine(ScheduledRoutine(id: "routine-a", botId: "bot-a", title: "A", enabled: false))
        await gate.release()

        let result = try await running.value
        #expect(result.status == "cancelled")
        #expect(result.error?.contains("admission changed") == true)
        #expect(try await database.loadRoutineRuns(forRoutine: "routine-a").first?.status == "cancelled")
    }

    @Test("Shutdown during an awaited executor closes admission and records a terminal run")
    func shutdownDuringExecution() async throws {
        let database = try DatabaseService(path: ":memory:")
        let scheduler = NativeRoutinesSchedulerActor(database: database)
        let gate = RoutineExecutionGate()
        await scheduler.registerRoutine(ScheduledRoutine(id: "routine-shutdown", botId: "bot-a", title: "A"))

        let running = Task {
            try await scheduler.fireRoutine(id: "routine-shutdown", runId: "run-shutdown", now: 100) { _, _ in
                await gate.blockUntilReleased()
            }
        }
        await gate.waitUntilStarted()
        await scheduler.shutdown()
        await gate.release()

        let result = try await running.value
        #expect(result.status == "cancelled")
        #expect(try await database.loadRoutineRuns(forRoutine: "routine-shutdown").first?.status == "cancelled")
        await #expect(throws: RoutineSchedulerError.self) {
            _ = try await scheduler.fireRoutine(id: "routine-shutdown", runId: "run-after-stop")
        }
    }

    @Test("Scheduler delegates wait registration, ticking and cancellation to its registry")
    func waitRegistrySchedulerWiring() async throws {
        let database = try DatabaseService(path: ":memory:")
        let probe = RoutineWaitProbe()
        let queue = RoutineWaitQueue()
        let registry = NativeEventWaitRegistry(
            probe: probe,
            queue: queue,
            persistence: InMemoryNativeEventWaitPersistence(),
            clock: { 100 }
        )
        let scheduler = NativeRoutinesSchedulerActor(database: database, eventWaitRegistry: registry)
        _ = try await scheduler.registerWait(id: "registered", botId: "bot-a", predicate: .botIdle, now: 100)
        #expect(try await scheduler.tickWaits(now: 100).isEmpty)
        #expect(try await scheduler.cancelWait(id: "registered")?.status == .cancelled)
        #expect(await queue.waitIds.isEmpty)
        await scheduler.shutdown()
        await #expect(throws: RoutineSchedulerError.self) {
            _ = try await scheduler.tickWaits(now: 101)
        }
    }

    @Test("Endpoint revision changes during backoff prevent an old webhook retry")
    func webhookEndpointRevisionChangeDuringBackoff() async throws {
        let database = try DatabaseService(path: ":memory:")
        let sleepGate = WebhookBackoffGate()
        let ingress = NativeWebhookIngressActor(database: database, sleepHandler: { _ in await sleepGate.blockUntilReleased() })
        let endpoint = WebhookEndpointConfig(
            id: "webhook-a",
            botId: "bot-a",
            secret: "first-secret",
            eventTypes: ["push"],
            maxRetries: 2
        )
        await ingress.registerEndpoint(endpoint)
        let payload = Data("{}".utf8)
        let signature = NativeWebhookIngressActor.computeHMACSignature(payload: payload, secret: endpoint.secret)
        let dispatchCounter = WebhookDispatchCounter()

        let handling = Task {
            try await ingress.handleWebhook(
                webhookId: endpoint.id,
                eventType: "push",
                signatureHeader: signature,
                payload: payload,
                deliveryId: "delivery-revision",
                now: 100
            ) { _, _, _ in
                let count = await dispatchCounter.increment()
                if count == 1 { throw NSError(domain: "transient", code: 1) }
                return "unexpected retry"
            }
        }

        await sleepGate.waitUntilStarted()
        await ingress.registerEndpoint(WebhookEndpointConfig(id: endpoint.id, botId: "bot-a", secret: "second-secret", eventTypes: ["push"]))
        await sleepGate.release()
        let outcome = try await handling.value
        #expect(outcome == .failedAfterRetries(deliveryId: "delivery-revision", attempts: 1, lastError: "webhook_endpoint_changed"))
        #expect(await dispatchCounter.value == 1)
    }
}

private actor RoutineExecutionGate {
    private var releaseContinuation: CheckedContinuation<Void, Never>?
    private var startedWaiters: [CheckedContinuation<Void, Never>] = []
    private var started = false

    func blockUntilReleased() async {
        started = true
        let waiters = startedWaiters
        startedWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
        await withCheckedContinuation { releaseContinuation = $0 }
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startedWaiters.append($0) }
    }

    func release() {
        releaseContinuation?.resume()
        releaseContinuation = nil
    }
}

private actor RoutineWaitProbe: NativeEventWaitProbe {
    func isSatisfied(botId: String, predicate: NativeEventWaitPredicate) async throws -> Bool { false }
}

private actor RoutineWaitQueue: NativeEventWaitQueue {
    private(set) var waitIds: [String] = []

    func enqueueFollowUp(_ wait: NativeEventWait) async throws -> NativeEventWaitQueueResult {
        waitIds.append(wait.id)
        return .completed
    }
}

private actor WebhookBackoffGate {
    private var releaseContinuation: CheckedContinuation<Void, Never>?
    private var startedWaiters: [CheckedContinuation<Void, Never>] = []
    private var started = false

    func blockUntilReleased() async {
        started = true
        let waiters = startedWaiters
        startedWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
        await withCheckedContinuation { releaseContinuation = $0 }
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startedWaiters.append($0) }
    }

    func release() {
        releaseContinuation?.resume()
        releaseContinuation = nil
    }
}

private actor WebhookDispatchCounter {
    private(set) var value = 0

    func increment() -> Int {
        value += 1
        return value
    }
}
