import Foundation
import Testing
@testable import CompanionCore

@Suite("Native event wait registry")
struct NativeEventWaitRegistryTests {
    @Test("Pending waits use only the injected probe and enqueue once after a match")
    func pendingWaitDoesNotStartModelWorkAndQueuesOnce() async throws {
        let probe = MutableNativeEventWaitProbe(satisfied: false)
        let queue = RecordingNativeEventWaitQueue()
        let persistence = InMemoryNativeEventWaitPersistence()
        let registry = NativeEventWaitRegistry(
            probe: probe,
            queue: queue,
            persistence: persistence,
            clock: { 100 }
        )

        _ = try await registry.register(id: "wait-file", botId: "bot-a", predicate: .fileExists(relativePath: "reports/done.json"), now: 100)
        #expect(try await registry.tick(now: 100).isEmpty)
        #expect(await probe.callCount == 1)
        #expect(await queue.waitIds.isEmpty)
        #expect(await registry.wait(id: "wait-file")?.status == .pending)

        await probe.setSatisfied(true)
        #expect(try await registry.tick(now: 101) == ["wait-file"])
        await registry.waitForDispatches()
        #expect(try await registry.tick(now: 102).isEmpty)
        #expect(await queue.waitIds == ["wait-file"])
        #expect(await registry.wait(id: "wait-file")?.status == .completed)
    }

    @Test("Wait registration rejects path escapes and enforces bot and total limits")
    func pathAndAdmissionLimits() async throws {
        let probe = MutableNativeEventWaitProbe(satisfied: false)
        let registry = NativeEventWaitRegistry(
            probe: probe,
            queue: RecordingNativeEventWaitQueue(),
            persistence: InMemoryNativeEventWaitPersistence(),
            limits: NativeEventWaitLimits(perBot: 1, total: 2),
            clock: { 100 }
        )

        await #expect(throws: NativeEventWaitError.self) {
            _ = try await registry.register(botId: "bot-a", predicate: .fileExists(relativePath: "../other/secret"), now: 100)
        }
        await #expect(throws: NativeEventWaitError.self) {
            _ = try await registry.register(botId: "bot-a", predicate: .fileExists(relativePath: "/etc/passwd"), now: 100)
        }
        _ = try await registry.register(id: "a1", botId: "bot-a", predicate: .botIdle, now: 100)
        await #expect(throws: NativeEventWaitError.self) {
            _ = try await registry.register(id: "a2", botId: "bot-a", predicate: .botIdle, now: 100)
        }
        _ = try await registry.register(id: "b1", botId: "bot-b", predicate: .processFinished(pid: 42, startTime: 1), now: 100)
        await #expect(throws: NativeEventWaitError.self) {
            _ = try await registry.register(id: "c1", botId: "bot-c", predicate: .botIdle, now: 100)
        }
    }

    @Test("Recovery restores pending waits, preserves cancellation and expires elapsed deadlines")
    func recoveryAndExpiry() async throws {
        let pending = NativeEventWait(id: "pending", botId: "bot-a", predicate: .botIdle, createdAt: 1, deadlineAt: 500)
        let cancelled = NativeEventWait(id: "cancelled", botId: "bot-a", predicate: .botIdle, createdAt: 1, deadlineAt: 500, status: .cancelled)
        let elapsed = NativeEventWait(id: "elapsed", botId: "bot-b", predicate: .botIdle, createdAt: 1, deadlineAt: 50)
        let persistence = InMemoryNativeEventWaitPersistence(snapshot: [pending, cancelled, elapsed])
        let registry = NativeEventWaitRegistry(
            probe: MutableNativeEventWaitProbe(satisfied: false),
            queue: RecordingNativeEventWaitQueue(),
            persistence: persistence,
            clock: { 100 }
        )

        let restored = try await registry.recover(now: 100)
        #expect(restored.map(\.id) == ["pending"])
        #expect(await registry.wait(id: "elapsed")?.status == .expired)
        #expect(await registry.wait(id: "cancelled") == nil)
    }

    @Test("Concurrent first recovery cannot replace a wait registered after recovery completes")
    func concurrentRecoveryDoesNotDropNewWait() async throws {
        let persistence = PausedSnapshotPersistence()
        let registry = NativeEventWaitRegistry(
            probe: MutableNativeEventWaitProbe(satisfied: false),
            queue: RecordingNativeEventWaitQueue(),
            persistence: persistence,
            clock: { 100 }
        )
        let firstRecovery = Task { try await registry.recover(now: 100) }
        await persistence.waitForLoadCount(1)
        let secondRecovery = Task { try await registry.recover(now: 100) }
        await persistence.waitForLoadCount(2)

        await persistence.releaseNextLoad()
        #expect(try await firstRecovery.value.isEmpty)
        _ = try await registry.register(id: "after-recovery", botId: "bot-a", predicate: .botIdle, now: 100)
        await persistence.releaseNextLoad()
        _ = try await secondRecovery.value

        #expect(await registry.activeWaits().map(\.id) == ["after-recovery"])
    }

    @Test("A persisted dispatching wait recovers as ready and uses the wait id for idempotent enqueue")
    func dispatchingRecoveryIsIdempotent() async throws {
        let dispatching = NativeEventWait(
            id: "dispatching",
            botId: "bot-a",
            predicate: .botIdle,
            createdAt: 1,
            deadlineAt: 500,
            status: .dispatching,
            revision: 4
        )
        let persistence = InMemoryNativeEventWaitPersistence(snapshot: [dispatching])
        let probe = MutableNativeEventWaitProbe(satisfied: true)
        let queue = RecordingNativeEventWaitQueue()
        let registry = NativeEventWaitRegistry(probe: probe, queue: queue, persistence: persistence, clock: { 100 })

        #expect(try await registry.recover(now: 100).first?.status == .ready)
        #expect(try await registry.tick(now: 100) == ["dispatching"])
        await registry.waitForDispatches()
        #expect(try await registry.tick(now: 101).isEmpty)
        #expect(await queue.waitIds == ["dispatching"])
    }

    @Test("SQLite recovery across registry instances retries dispatching state with one queue effect")
    func sqliteRestartRecoveryQueuesExactlyOnce() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("native-waits-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try DatabaseService(path: root.appendingPathComponent("store.sqlite").path)
        let persistence = DatabaseNativeEventWaitPersistence(database: database)
        let probe = MutableNativeEventWaitProbe(satisfied: true)
        let queue = CrashWindowNativeEventWaitQueue()
        let directRecord = NativeEventWait(id: "crud", botId: "bot-a", predicate: .botIdle, createdAt: 1, deadlineAt: 500)
        try await database.saveNativeEventWait(directRecord)
        #expect(try await database.loadNativeEventWaits().map(\.id) == ["crud"])
        try await database.deleteNativeEventWait(id: "crud")
        #expect(try await database.loadNativeEventWaits().isEmpty)
        let firstRegistry = NativeEventWaitRegistry(probe: probe, queue: queue, persistence: persistence, clock: { 100 })
        _ = try await firstRegistry.register(id: "durable", botId: "bot-a", predicate: .botIdle, now: 100)

        let firstTick = Task { try await firstRegistry.tick(now: 101) }
        await queue.waitUntilFirstCall()
        #expect(try await database.loadNativeEventWaits().first?.status == .dispatching)

        let restartedRegistry = NativeEventWaitRegistry(probe: probe, queue: queue, persistence: persistence, clock: { 101 })
        #expect(try await restartedRegistry.recover(now: 101).first?.status == .ready)
        #expect(try await restartedRegistry.tick(now: 101) == ["durable"])
        await restartedRegistry.waitForDispatches()
        await queue.releaseFirstCall()
        #expect(try await firstTick.value == ["durable"])
        await firstRegistry.waitForDispatches()
        #expect(await queue.acceptedWaitIds == ["durable"])
        #expect(await queue.callCount == 2)
        #expect(try await database.loadNativeEventWaits().first?.status == .completed)
        #expect(try await database.countRows(inTable: "native_event_waits") == 1)
    }

    @Test("Stale ready, equal dispatching, and incomplete snapshots cannot reopen or delete an accepted wait")
    func acceptedSnapshotFence() async throws {
        let database = try DatabaseService(path: ":memory:")
        let dispatching = NativeEventWait(id: "claimed", botId: "a", predicate: .botIdle, createdAt: 1, deadlineAt: 500, status: .dispatching, revision: 2)
        try await database.saveNativeEventWait(dispatching)
        #expect(try await database.claimNativeEventWaitDispatch(dispatching))
        let accepted = try #require(try await database.loadNativeEventWaits().first)
        #expect(accepted.status == .accepted)
        for (status, revision) in [(NativeEventWaitStatus.ready, UInt64(1)), (.dispatching, UInt64(3)), (.pending, UInt64(0))] {
            var stale = dispatching; stale.status = status; stale.revision = revision
            try await database.replaceNativeEventWaitSnapshot([stale])
            #expect(try await database.loadNativeEventWaits() == [accepted])
            #expect(try await database.claimNativeEventWaitDispatch(stale) == false)
        }
        try await database.replaceNativeEventWaitSnapshot([])
        #expect(try await database.loadNativeEventWaits() == [accepted])
        var completed = accepted; completed.status = .completed
        try await database.replaceNativeEventWaitSnapshot([completed])
        #expect(try await database.loadNativeEventWaits() == [completed])
        try await database.replaceNativeEventWaitSnapshot([dispatching])
        #expect(try await database.loadNativeEventWaits() == [completed])
    }

    @Test("The id-only dispatch ledger survives settled-history pruning and permits a different wait id")
    func permanentDispatchClaim() async throws {
        let database = try DatabaseService(path: ":memory:")
        var dispatching = NativeEventWait(id: "once", botId: "a", predicate: .botIdle, createdAt: 1, deadlineAt: 500, status: .dispatching, revision: 2)
        try await database.replaceNativeEventWaitSnapshot([dispatching])
        #expect(try await database.claimNativeEventWaitDispatch(dispatching))
        var completed = dispatching; completed.status = .completed; completed.revision = 3
        try await database.replaceNativeEventWaitSnapshot([completed])
        try await database.replaceNativeEventWaitSnapshot([])
        #expect(try await database.loadNativeEventWaits().isEmpty)
        dispatching.revision = 100
        try await database.replaceNativeEventWaitSnapshot([dispatching])
        #expect(try await database.claimNativeEventWaitDispatch(dispatching) == false)
        #expect(try await database.countRows(inTable: "native_event_wait_dispatches") == 1)
        let fresh = NativeEventWait(id: "different", botId: "a", predicate: .botIdle, createdAt: 2, deadlineAt: 500, status: .dispatching, revision: 2)
        try await database.replaceNativeEventWaitSnapshot([fresh])
        #expect(try await database.claimNativeEventWaitDispatch(fresh))
        #expect(try await database.countRows(inTable: "native_event_wait_dispatches") == 2)
    }

    @Test("Merging retained accepted claims fails closed instead of evicting storage-limit entries")
    func acceptedMergeStorageBound() async throws {
        let database = try DatabaseService(path: ":memory:")
        let accepted = (0..<150).map { NativeEventWait(id: "accepted-\($0)", botId: "a", predicate: .botIdle, createdAt: 1, deadlineAt: 500, status: .accepted, revision: 3) }
        try await database.replaceNativeEventWaitSnapshot(accepted)
        let new = NativeEventWait(id: "new", botId: "b", predicate: .botIdle, createdAt: 2, deadlineAt: 500)
        await #expect(throws: DatabaseError.self) { try await database.replaceNativeEventWaitSnapshot([new]) }
        #expect(try await database.loadNativeEventWaits().count == 150)
        #expect(try await database.loadNativeEventWaits().allSatisfy { $0.status == .accepted })
        try await database.replaceNativeEventWaitSnapshot([])
        #expect(try await database.loadNativeEventWaits().count == 150)
    }

    @Test("A delayed second registry probe cannot dispatch a wait already accepted by the first registry")
    func delayedProbeAcrossRegistries() async throws {
        let database = try DatabaseService(path: ":memory:")
        let persistence = DatabaseNativeEventWaitPersistence(database: database)
        let firstQueue = ClaimingNativeEventWaitQueue(database: database, hold: true)
        let secondQueue = ClaimingNativeEventWaitQueue(database: database, hold: false)
        let first = NativeEventWaitRegistry(probe: MutableNativeEventWaitProbe(satisfied: true), queue: firstQueue, persistence: persistence, clock: { 100 })
        _ = try await first.register(id: "shared", botId: "a", predicate: .botIdle, now: 100)
        let delayed = BlockingNativeEventWaitProbe()
        let second = NativeEventWaitRegistry(probe: delayed, queue: secondQueue, persistence: persistence, clock: { 100 })
        _ = try await second.recover(now: 100)
        let secondTick = Task { try await second.tick(now: 100) }
        await delayed.waitUntilCalled()
        #expect(try await first.tick(now: 100) == ["shared"])
        await firstQueue.waitUntilClaimed()
        #expect(try await database.loadNativeEventWaits().first?.status == .accepted)
        await delayed.resolve(true)
        #expect(try await secondTick.value == ["shared"])
        await second.waitForDispatches()
        #expect(await secondQueue.effects.isEmpty)
        await firstQueue.release()
        await first.waitForDispatches()
        #expect(await firstQueue.effects == ["shared"])
        #expect(try await database.loadNativeEventWaits().first?.status == .completed)
        #expect(try await database.countRows(inTable: "native_event_wait_dispatches") == 1)
    }

    @Test("A blocked model follow-up does not block other predicates, expiry, or registry shutdown")
    func independentWaitDispatchTasks() async throws {
        let queue = CrashWindowNativeEventWaitQueue()
        let registry = NativeEventWaitRegistry(probe: MutableNativeEventWaitProbe(satisfied: true), queue: queue,
            persistence: InMemoryNativeEventWaitPersistence(), clock: { 100 })
        _ = try await registry.register(id: "first", botId: "a", predicate: .botIdle, now: 100)
        _ = try await registry.register(id: "second", botId: "b", predicate: .botIdle, now: 100)
        #expect(try await registry.tick(now: 100) == ["first", "second"])
        await queue.waitUntilFirstCall()
        await registry.waitForDispatches(ids: ["second"])
        #expect(await registry.wait(id: "second")?.status == .completed)
        #expect(await registry.wait(id: "first")?.status == .dispatching)
        _ = try await registry.register(id: "expiring", botId: "c", predicate: .botIdle, now: 100, timeout: 1)
        #expect(try await registry.tick(now: 102).isEmpty)
        #expect(await registry.wait(id: "expiring")?.status == .expired)
        await registry.shutdown()
        await #expect(throws: NativeEventWaitError.registryStopped) { _ = try await registry.tick(now: 103) }
        await queue.releaseFirstCall()
        await registry.waitForDispatches()
        #expect(await queue.callCount == 2)
        #expect(await registry.wait(id: "first")?.status == .held)
        #expect(await registry.dispatchPersistenceFailed == false)
    }

    @Test("Local probes scope files to a bot workspace and require process and bot ownership evidence")
    func localProbeEnforcesOwnershipAndWorkspaceScope() async throws {
        let temporaryRoot = FileManager.default.temporaryDirectory.appendingPathComponent("native-probe-\(UUID().uuidString)", isDirectory: true)
        let workspace = temporaryRoot.appendingPathComponent("bot-workspace", isDirectory: true)
        let outside = temporaryRoot.appendingPathComponent("outside.txt")
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        try Data("inside".utf8).write(to: workspace.appendingPathComponent("inside.txt"))
        try Data("outside".utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(at: workspace.appendingPathComponent("escape.txt"), withDestinationURL: outside)
        defer { try? FileManager.default.removeItem(at: temporaryRoot) }

        let workspaces = WaitWorkspaceSource(botRoots: ["bot-a": workspace])
        let processes = WaitProcessOwnershipSource(ownedFinished: ["bot-a:42:10.5"])
        let botActivity = WaitBotActivitySource(idleBots: ["bot-a"])
        let probe = LocalNativeEventWaitProbe(workspaces: workspaces, processes: processes, botActivity: botActivity)

        #expect(try await probe.isSatisfied(botId: "bot-a", predicate: .fileExists(relativePath: "inside.txt")))
        #expect(!(try await probe.isSatisfied(botId: "bot-a", predicate: .fileExists(relativePath: "escape.txt"))))
        #expect(!(try await probe.isSatisfied(botId: "bot-b", predicate: .fileExists(relativePath: "inside.txt"))))
        #expect(try await probe.isSatisfied(botId: "bot-a", predicate: .processFinished(pid: 42, startTime: 10.5)))
        #expect(!(try await probe.isSatisfied(botId: "bot-b", predicate: .processFinished(pid: 42, startTime: 10.5))))
        #expect(try await probe.isSatisfied(botId: "bot-a", predicate: .botIdle))
        #expect(!(try await probe.isSatisfied(botId: "unknown-bot", predicate: .botIdle)))
    }

    @Test("Cancellation during an awaited probe invalidates its result")
    func cancellationWinsProbeRace() async throws {
        let probe = BlockingNativeEventWaitProbe()
        let queue = RecordingNativeEventWaitQueue()
        let registry = NativeEventWaitRegistry(probe: probe, queue: queue, persistence: InMemoryNativeEventWaitPersistence(), clock: { 100 })
        _ = try await registry.register(id: "race", botId: "bot-a", predicate: .botIdle, now: 100)

        let ticking = Task { try await registry.tick(now: 100) }
        await probe.waitUntilCalled()
        #expect(try await registry.cancel(id: "race")?.status == .cancelled)
        await probe.resolve(true)
        let tickResult = try await ticking.value
        #expect(tickResult.isEmpty)
        #expect(await queue.waitIds.isEmpty)
        #expect(await registry.wait(id: "race")?.status == .cancelled)
    }

    @Test("Shutdown during a probe leaves the wait recoverable and does not queue it")
    func shutdownDuringProbe() async throws {
        let probe = BlockingNativeEventWaitProbe()
        let persistence = InMemoryNativeEventWaitPersistence()
        let queue = RecordingNativeEventWaitQueue()
        let registry = NativeEventWaitRegistry(probe: probe, queue: queue, persistence: persistence, clock: { 100 })
        _ = try await registry.register(id: "shutdown", botId: "bot-a", predicate: .botIdle, now: 100)

        let ticking = Task { try await registry.tick(now: 100) }
        await probe.waitUntilCalled()
        await registry.shutdown()
        await probe.resolve(true)
        await #expect(throws: NativeEventWaitError.self) { _ = try await ticking.value }
        #expect(await queue.waitIds.isEmpty)
        #expect(await registry.wait(id: "shutdown")?.status == .pending)
    }
}

private actor ClaimingNativeEventWaitQueue: NativeEventWaitQueue {
    private let database: DatabaseService
    private let hold: Bool
    private var didClaim = false
    private var claimWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?
    private(set) var effects: [String] = []
    init(database: DatabaseService, hold: Bool) { self.database = database; self.hold = hold }
    func enqueueFollowUp(_ wait: NativeEventWait) async throws -> NativeEventWaitQueueResult {
        guard try await database.claimNativeEventWaitDispatch(wait) else { return .held(reason: "Already claimed") }
        effects.append(wait.id); didClaim = true
        for waiter in claimWaiters { waiter.resume() }
        claimWaiters.removeAll()
        if hold { await withCheckedContinuation { releaseContinuation = $0 } }
        return .completed
    }
    func waitUntilClaimed() async {
        if didClaim { return }
        await withCheckedContinuation { claimWaiters.append($0) }
    }
    func release() { releaseContinuation?.resume(); releaseContinuation = nil }
}

private actor MutableNativeEventWaitProbe: NativeEventWaitProbe {
    private var satisfied: Bool
    private(set) var callCount = 0

    init(satisfied: Bool) { self.satisfied = satisfied }

    func isSatisfied(botId: String, predicate: NativeEventWaitPredicate) async throws -> Bool {
        callCount += 1
        return satisfied
    }

    func setSatisfied(_ value: Bool) { satisfied = value }
}

private actor BlockingNativeEventWaitProbe: NativeEventWaitProbe {
    private var result: CheckedContinuation<Bool, Never>?
    private var calledWaiters: [CheckedContinuation<Void, Never>] = []
    private var wasCalled = false

    func isSatisfied(botId: String, predicate: NativeEventWaitPredicate) async throws -> Bool {
        wasCalled = true
        let waiters = calledWaiters
        calledWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
        return await withCheckedContinuation { result = $0 }
    }

    func waitUntilCalled() async {
        if wasCalled { return }
        await withCheckedContinuation { calledWaiters.append($0) }
    }

    func resolve(_ value: Bool) {
        result?.resume(returning: value)
        result = nil
    }
}

private actor PausedSnapshotPersistence: NativeEventWaitPersistence {
    private var snapshot: [NativeEventWait] = []
    private var loadCount = 0
    private var loadContinuations: [CheckedContinuation<[NativeEventWait], Never>] = []
    private var countWaiters: [(Int, CheckedContinuation<Void, Never>)] = []

    func loadSnapshot() async throws -> [NativeEventWait] {
        loadCount += 1
        let ready = countWaiters.filter { $0.0 <= loadCount }
        countWaiters.removeAll { $0.0 <= loadCount }
        for (_, waiter) in ready { waiter.resume() }
        return await withCheckedContinuation { loadContinuations.append($0) }
    }

    func saveSnapshot(_ waits: [NativeEventWait]) async throws {
        snapshot = waits
    }

    func waitForLoadCount(_ count: Int) async {
        if loadCount >= count { return }
        await withCheckedContinuation { countWaiters.append((count, $0)) }
    }

    func releaseNextLoad() {
        guard !loadContinuations.isEmpty else { return }
        loadContinuations.removeFirst().resume(returning: snapshot)
    }
}

private actor RecordingNativeEventWaitQueue: NativeEventWaitQueue {
    private(set) var waitIds: [String] = []
    private var accepted = Set<String>()

    func enqueueFollowUp(_ wait: NativeEventWait) async throws -> NativeEventWaitQueueResult {
        if accepted.insert(wait.id).inserted { waitIds.append(wait.id) }
        return .completed
    }
}

private actor CrashWindowNativeEventWaitQueue: NativeEventWaitQueue {
    private var firstCallContinuation: CheckedContinuation<Void, Never>?
    private var firstCallWaiters: [CheckedContinuation<Void, Never>] = []
    private var firstCallStarted = false
    private(set) var callCount = 0
    private(set) var acceptedWaitIds: [String] = []
    private var accepted = Set<String>()

    func enqueueFollowUp(_ wait: NativeEventWait) async throws -> NativeEventWaitQueueResult {
        callCount += 1
        if accepted.insert(wait.id).inserted { acceptedWaitIds.append(wait.id) }
        if callCount == 1 {
            firstCallStarted = true
            let waiters = firstCallWaiters
            firstCallWaiters.removeAll()
            for waiter in waiters { waiter.resume() }
            await withCheckedContinuation { firstCallContinuation = $0 }
        }
        return .completed
    }

    func waitUntilFirstCall() async {
        if firstCallStarted { return }
        await withCheckedContinuation { firstCallWaiters.append($0) }
    }

    func releaseFirstCall() {
        firstCallContinuation?.resume()
        firstCallContinuation = nil
    }
}

private actor WaitWorkspaceSource: NativeEventWaitWorkspaceSource {
    private let botRoots: [String: URL]

    init(botRoots: [String: URL]) { self.botRoots = botRoots }

    func workspaceRoot(forRegisteredBotId botId: String) async throws -> URL? {
        botRoots[botId]
    }
}

private actor WaitProcessOwnershipSource: NativeEventWaitProcessOwnershipSource {
    private let ownedFinished: Set<String>

    init(ownedFinished: Set<String>) { self.ownedFinished = ownedFinished }

    func hasFinishedProcess(pid: Int32, startTime: Double, ownedByBotId botId: String) async -> Bool {
        ownedFinished.contains("\(botId):\(pid):\(startTime)")
    }
}

private actor WaitBotActivitySource: NativeEventWaitBotActivitySource {
    private let idleBots: Set<String>

    init(idleBots: Set<String>) { self.idleBots = idleBots }

    func isIdle(registeredBotId botId: String) async -> Bool {
        idleBots.contains(botId)
    }
}
