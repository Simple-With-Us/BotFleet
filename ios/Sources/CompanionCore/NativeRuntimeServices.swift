import Foundation

public enum NativeRuntimeServicesError: LocalizedError, Equatable, Sendable {
    case inactive
    case stopped
    case unknownBot(String)
    case threadNotOwned(String)
    case unknownWait(String)
    case waitAlreadyDispatched(String)

    public var errorDescription: String? {
        switch self {
        case .inactive:
            return "The native runtime is not active."
        case .stopped:
            return "The native runtime is stopped."
        case .unknownBot(let id):
            return "Bot '\(id)' is not registered."
        case .threadNotOwned(let id):
            return "Thread '\(id)' does not belong to the requested bot."
        case .unknownWait(let id):
            return "Wait '\(id)' is not registered."
        case .waitAlreadyDispatched(let id):
            return "Wait '\(id)' has already been accepted for dispatch."
        }
    }
}

/// Reads bot activity from the native database and turn dispatcher without inspecting provider processes.
public struct DatabaseEngineBotActivitySource: NativeEventWaitBotActivitySource {
    private let database: DatabaseService
    private let coordinator: EngineCoordinatorActor

    public init(database: DatabaseService, coordinator: EngineCoordinatorActor) {
        self.database = database
        self.coordinator = coordinator
    }

    public func isIdle(registeredBotId botId: String) async -> Bool {
        guard let bots = try? await database.loadBots(), bots.contains(where: { $0.id == botId }) else { return false }
        return !(await coordinator.isBotActive(botId: botId))
    }
}

/// Opt-in composition for one native owner; construction alone starts no listener or polling loop.
public actor NativeRuntimeServices {
    public let engineCoordinator: EngineCoordinatorActor
    public let engineSwitch: BotNativeEngineSwitchActor
    public let waitRegistry: NativeEventWaitRegistry
    public let scheduler: NativeRoutinesSchedulerActor

    private let database: DatabaseService
    private var isActivated = false
    private var isStopped = false
    private var pollingTask: Task<Void, Never>?
    private let dispatchQueue: NativeCoordinatorEventWaitQueue

    public init(
        database: DatabaseService,
        engineCoordinator: EngineCoordinatorActor,
        engineSwitch: BotNativeEngineSwitchActor,
        workspaceSource: any NativeEventWaitWorkspaceSource,
        processOwnershipSource: any NativeEventWaitProcessOwnershipSource,
        waitLimits: NativeEventWaitLimits = NativeEventWaitLimits(),
        executionContext: (any NativeExecutionContextSource)? = nil
    ) {
        self.database = database
        self.engineCoordinator = engineCoordinator
        self.engineSwitch = engineSwitch
        let botActivitySource = DatabaseEngineBotActivitySource(database: database, coordinator: engineCoordinator)
        let probe = LocalNativeEventWaitProbe(
            workspaces: workspaceSource,
            processes: processOwnershipSource,
            botActivity: botActivitySource
        )
        let queue = NativeCoordinatorEventWaitQueue(
            database: database,
            engineCoordinator: engineCoordinator,
            engineSwitch: engineSwitch,
            executionContext: executionContext
        )
        self.dispatchQueue = queue
        let registry = NativeEventWaitRegistry(
            probe: probe,
            queue: queue,
            persistence: DatabaseNativeEventWaitPersistence(database: database),
            limits: waitLimits
        )
        self.waitRegistry = registry
        self.scheduler = NativeRoutinesSchedulerActor(database: database, eventWaitRegistry: registry)
    }

    /// Recovers waits and optionally starts the local polling task; callers must invoke this explicitly.
    public func activate(pollIntervalSeconds: TimeInterval? = nil) async throws {
        guard !isStopped else { throw NativeRuntimeServicesError.stopped }
        if !isActivated {
            try await scheduler.recoverWaits()
            guard !isStopped else { throw NativeRuntimeServicesError.stopped }
            isActivated = true
        }
        guard let interval = pollIntervalSeconds, pollingTask == nil else { return }
        let sleepNanos = UInt64(max(0.1, interval) * 1_000_000_000)
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: sleepNanos)
                } catch {
                    break
                }
                guard !Task.isCancelled else { break }
                await self?.runPollingTick()
            }
        }
    }

    /// Cancels the polling task without the terminal `shutdown()`: the
    /// runtime stays activated, so a later `activate` restarts polling.
    /// Listener stop uses this — socket stop must not leave waits polling,
    /// and must not make a later listener start fail as stopped.
    public func deactivatePolling() async {
        let polling = pollingTask
        polling?.cancel()
        pollingTask = nil
        await polling?.value
    }

    public func tick() async throws -> [String] {
        guard !isStopped else { throw NativeRuntimeServicesError.stopped }
        guard isActivated else { throw NativeRuntimeServicesError.inactive }
        let result = try await scheduler.tickWaits()
        try requireActive()
        return result
    }

    @discardableResult
    public func registerWait(
        botId: String,
        threadId: String,
        prompt: String,
        predicate: NativeEventWaitPredicate,
        timeout: TimeInterval? = nil,
        now: Double = Date().timeIntervalSince1970
    ) async throws -> NativeEventWait {
        try requireActive()
        try await requireOwnedThread(botId: botId, threadId: threadId)
        try requireActive()
        let wait = try await scheduler.registerWait(
            botId: botId,
            threadId: threadId,
            prompt: prompt,
            predicate: predicate,
            now: now,
            timeout: timeout
        )
        try requireActive()
        return wait
    }

    public func listWaits(botId: String) async throws -> [NativeEventWait] {
        try requireActive()
        try await requireRegisteredBot(botId)
        try requireActive()
        let waits = await waitRegistry.visibleWaits(botId: botId)
        try requireActive()
        return waits
    }

    @discardableResult
    public func cancelWait(id: String) async throws -> NativeEventWait {
        try requireActive()
        guard let wait = await waitRegistry.wait(id: id) else { throw NativeRuntimeServicesError.unknownWait(id) }
        try await requireOwnedThread(botId: wait.botId, threadId: wait.threadId ?? "")
        try requireActive()
        guard wait.status == .pending || wait.status == .ready || wait.status == .held else {
            throw NativeRuntimeServicesError.waitAlreadyDispatched(id)
        }
        guard let cancelled = try await scheduler.cancelWait(id: id) else {
            throw NativeRuntimeServicesError.unknownWait(id)
        }
        try requireActive()
        guard cancelled.status == .cancelled else {
            throw NativeRuntimeServicesError.waitAlreadyDispatched(id)
        }
        return cancelled
    }

    public func shutdown() async {
        guard !isStopped else { return }
        isStopped = true
        await dispatchQueue.shutdown()
        let polling = pollingTask
        polling?.cancel()
        pollingTask = nil
        await scheduler.shutdown()
        await polling?.value
    }

    /// Only typed, unclaimed capability holds can return to pending work.
    public func resumeCapabilityHeldWaits() async throws {
        try requireActive()
        for wait in await waitRegistry.visibleWaits() where wait.admissionHold != nil {
            guard try await !database.hasNativeEventWaitDispatchClaim(id: wait.id) else { continue }
            try requireActive()
            try await waitRegistry.resumeAdmissionHold(id: wait.id)
        }
    }

    /// The host calls this before closing its database or releasing the lifetime owner lease.
    public func shutdownAndDrain() async throws {
        await shutdown()
        try await engineCoordinator.shutdownAndDrain()
        await waitRegistry.waitForDispatches()
        try await waitRegistry.flushPersistence()
    }

    private func runPollingTick() async {
        guard !isStopped, isActivated else { return }
        _ = try? await scheduler.tickWaits()
    }

    private func requireActive() throws {
        guard !isStopped else { throw NativeRuntimeServicesError.stopped }
        guard isActivated else { throw NativeRuntimeServicesError.inactive }
    }

    private func requireRegisteredBot(_ botId: String) async throws {
        let bots = try await database.loadBots()
        guard bots.contains(where: { $0.id == botId }) else { throw NativeRuntimeServicesError.unknownBot(botId) }
    }

    private func requireOwnedThread(botId: String, threadId: String) async throws {
        try await requireRegisteredBot(botId)
        guard !threadId.isEmpty,
              let thread = try await database.loadThread(id: threadId),
              thread.botId == botId else {
            throw NativeRuntimeServicesError.threadNotOwned(threadId)
        }
    }
}

private actor NativeCoordinatorEventWaitQueue: NativeEventWaitQueue {
    private let database: DatabaseService
    private let engineCoordinator: EngineCoordinatorActor
    private let engineSwitch: BotNativeEngineSwitchActor
    private let executionContext: (any NativeExecutionContextSource)?
    private var isShutdown = false

    init(database: DatabaseService, engineCoordinator: EngineCoordinatorActor, engineSwitch: BotNativeEngineSwitchActor,
         executionContext: (any NativeExecutionContextSource)?) {
        self.database = database
        self.engineCoordinator = engineCoordinator
        self.engineSwitch = engineSwitch
        self.executionContext = executionContext
    }

    func enqueueFollowUp(_ wait: NativeEventWait) async throws -> NativeEventWaitQueueResult {
        guard !isShutdown, !Task.isCancelled else { return .preClaimInterrupted }
        guard let threadId = wait.threadId, let prompt = wait.prompt else {
            return .held(reason: "Wait has no durable follow-up thread or prompt")
        }
        guard let bots = try? await database.loadBots(), bots.contains(where: { $0.id == wait.botId }),
              let thread = try? await database.loadThread(id: threadId), thread.botId == wait.botId else {
            return .held(reason: "Bot or thread ownership changed before dispatch")
        }
        guard !isShutdown, !Task.isCancelled else { return .preClaimInterrupted }

        let input: TurnInput
        do {
            if let executionContext {
                let admission = try await executionContext.resolve(wait: wait)
                guard !isShutdown, !Task.isCancelled else { return .preClaimInterrupted }
                switch admission {
                case .held(let reason): return .admissionHeld(reason)
                case .ready(let prepared):
                    guard prepared.botId == wait.botId, prepared.threadId == threadId, prepared.prompt == prompt else {
                        return .held(reason: "Execution context does not match the durable wait")
                    }
                    input = prepared
                }
            } else {
                input = TurnInput(threadId: threadId, botId: wait.botId, prompt: prompt)
            }
            guard !isShutdown, !Task.isCancelled else { return .preClaimInterrupted }
        } catch NativeRuntimeServicesError.stopped {
            return .preClaimInterrupted
        } catch is CancellationError {
            return .preClaimInterrupted
        } catch {
            return .held(reason: Self.bounded(error.localizedDescription))
        }

        do {
            guard try await database.claimNativeEventWaitDispatch(wait) else {
                return .held(reason: "Wait dispatch was already claimed")
            }
            guard !isShutdown else { return .held(reason: "Native wait dispatcher shut down after acceptance") }
            do {
                try await engineSwitch.beginTurn(botId: wait.botId, callerRuntime: .nativeSwift, turnId: wait.id)
            } catch {
                return .held(reason: "Native runtime does not own this bot")
            }
            guard !isShutdown else {
                await engineSwitch.endTurn(botId: wait.botId, turnId: wait.id)
                return .held(reason: "Native wait dispatcher shut down before turn start")
            }
            let stream = try await engineCoordinator.sendTurn(
                input: input
            )
            var completed = false
            var failure: String?
            for await event in stream {
                switch event {
                case .completed:
                    completed = true
                case .error(_, let message):
                    failure = message
                default:
                    break
                }
            }
            await engineSwitch.endTurn(botId: wait.botId, turnId: wait.id)
            if let failure { return .held(reason: Self.bounded(failure)) }
            guard completed else { return .held(reason: "Native turn ended without completion") }
            return .completed
        } catch {
            await engineSwitch.endTurn(botId: wait.botId, turnId: wait.id)
            return .held(reason: Self.bounded(error.localizedDescription))
        }
    }

    private static func bounded(_ reason: String) -> String {
        String(reason.prefix(512))
    }

    func shutdown() {
        isShutdown = true
    }
}
