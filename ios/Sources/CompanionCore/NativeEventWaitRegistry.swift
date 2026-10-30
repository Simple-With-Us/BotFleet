import Foundation

public enum NativeEventWaitPredicate: Codable, Equatable, Sendable {
    case fileExists(relativePath: String)
    case processFinished(pid: Int32, startTime: Double)
    case botIdle
}

public enum NativeEventWaitStatus: String, Codable, Equatable, Sendable {
    case pending
    case ready
    case dispatching
    case accepted
    case held
    case completed
    case cancelled
    case expired
}

public struct NativeEventWait: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let botId: String
    public let threadId: String?
    public let prompt: String?
    public let predicate: NativeEventWaitPredicate
    public let createdAt: Double
    public let deadlineAt: Double
    public var status: NativeEventWaitStatus
    public var revision: UInt64
    public var holdReason: String?

    public init(
        id: String = "wait_\(UUID().uuidString.lowercased())",
        botId: String,
        threadId: String? = nil,
        prompt: String? = nil,
        predicate: NativeEventWaitPredicate,
        createdAt: Double,
        deadlineAt: Double,
        status: NativeEventWaitStatus = .pending,
        revision: UInt64 = 0,
        holdReason: String? = nil
    ) {
        self.id = id
        self.botId = botId
        self.threadId = threadId
        self.prompt = prompt
        self.predicate = predicate
        self.createdAt = createdAt
        self.deadlineAt = deadlineAt
        self.status = status
        self.revision = revision
        self.holdReason = holdReason
    }
}

public enum NativeEventWaitError: LocalizedError, Equatable, Sendable {
    case invalidBotId
    case invalidPredicate
    case invalidDeadline
    case invalidThread
    case invalidPrompt
    case duplicateWait(String)
    case perBotLimitReached(String)
    case totalLimitReached
    case registryStopped

    public var errorDescription: String? {
        switch self {
        case .invalidBotId:
            return "A bot id is required."
        case .invalidPredicate:
            return "The wait predicate is invalid."
        case .invalidDeadline:
            return "The wait deadline is invalid."
        case .invalidThread:
            return "A thread id is required."
        case .invalidPrompt:
            return "A valid follow-up prompt is required."
        case .duplicateWait(let id):
            return "Wait '\(id)' already exists."
        case .perBotLimitReached(let botId):
            return "Bot '\(botId)' has reached its active wait limit."
        case .totalLimitReached:
            return "The active wait limit has been reached."
        case .registryStopped:
            return "The wait registry is stopped."
        }
    }
}

/// Implementations must probe without invoking a model, scope file reads to the bot workspace,
/// canonicalize symlinks before access, and prove that a process belongs to the requested bot.
public protocol NativeEventWaitProbe: Sendable {
    func isSatisfied(botId: String, predicate: NativeEventWaitPredicate) async throws -> Bool
}

/// The queue callback must be idempotent by wait id so a crash between enqueue and persistence
/// cannot create a duplicate follow-up turn.
public protocol NativeEventWaitQueue: Sendable {
    func enqueueFollowUp(_ wait: NativeEventWait) async throws -> NativeEventWaitQueueResult
}

public enum NativeEventWaitQueueResult: Equatable, Sendable {
    case completed
    case held(reason: String)
}

/// Persistence stores a complete bounded snapshot so implementations can use one atomic write.
public protocol NativeEventWaitPersistence: Sendable {
    func loadSnapshot() async throws -> [NativeEventWait]
    func saveSnapshot(_ waits: [NativeEventWait]) async throws
}

public protocol NativeEventWaitWorkspaceSource: Sendable {
    func workspaceRoot(forRegisteredBotId botId: String) async throws -> URL?
}

public protocol NativeEventWaitProcessOwnershipSource: Sendable {
    /// Returns true only for a process previously registered to this bot and matched by its start time.
    func hasFinishedProcess(pid: Int32, startTime: Double, ownedByBotId botId: String) async -> Bool
}

public protocol NativeEventWaitBotActivitySource: Sendable {
    /// Returns true only when the bot id is registered and has no active turn.
    func isIdle(registeredBotId botId: String) async -> Bool
}

/// Local probes are supplied with narrow bot-owned sources and never call an engine or network service.
public struct LocalNativeEventWaitProbe: NativeEventWaitProbe {
    private let workspaces: any NativeEventWaitWorkspaceSource
    private let processes: any NativeEventWaitProcessOwnershipSource
    private let botActivity: any NativeEventWaitBotActivitySource

    public init(
        workspaces: any NativeEventWaitWorkspaceSource,
        processes: any NativeEventWaitProcessOwnershipSource,
        botActivity: any NativeEventWaitBotActivitySource
    ) {
        self.workspaces = workspaces
        self.processes = processes
        self.botActivity = botActivity
    }

    public func isSatisfied(botId: String, predicate: NativeEventWaitPredicate) async throws -> Bool {
        switch predicate {
        case .fileExists(let relativePath):
            guard Self.isSafeRelativePath(relativePath),
                  let workspace = try await workspaces.workspaceRoot(forRegisteredBotId: botId),
                  workspace.isFileURL else { return false }
            let root = workspace.standardizedFileURL.resolvingSymlinksInPath()
            var isDirectory: ObjCBool = false
            guard root.path != "/", FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory), isDirectory.boolValue else {
                return false
            }
            let candidate = root.appendingPathComponent(relativePath).standardizedFileURL.resolvingSymlinksInPath()
            guard Self.isDescendant(candidate, of: root) else { return false }
            return FileManager.default.fileExists(atPath: candidate.path)
        case .processFinished(let pid, let startTime):
            guard pid > 0, startTime.isFinite, startTime > 0 else { return false }
            return await processes.hasFinishedProcess(pid: pid, startTime: startTime, ownedByBotId: botId)
        case .botIdle:
            return await botActivity.isIdle(registeredBotId: botId)
        }
    }

    private static func isSafeRelativePath(_ path: String) -> Bool {
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\\"), !path.contains(":"), !path.contains("\0") else {
            return false
        }
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        return components.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }

    private static func isDescendant(_ candidate: URL, of root: URL) -> Bool {
        let rootPath = root.standardizedFileURL.path.hasSuffix("/")
            ? root.standardizedFileURL.path
            : root.standardizedFileURL.path + "/"
        let candidatePath = candidate.standardizedFileURL.path
        return candidatePath.hasPrefix(rootPath)
    }
}

public struct NativeEventWaitLimits: Equatable, Sendable {
    public let perBot: Int
    public let total: Int
    public let defaultTimeout: TimeInterval
    public let maximumTimeout: TimeInterval
    public let terminalRetention: TimeInterval
    public let terminalHistoryLimit: Int
    public let maximumPromptBytes: Int

    public init(
        perBot: Int = 10,
        total: Int = 50,
        defaultTimeout: TimeInterval = 24 * 60 * 60,
        maximumTimeout: TimeInterval = 7 * 24 * 60 * 60,
        terminalRetention: TimeInterval = 24 * 60 * 60,
        terminalHistoryLimit: Int = 100,
        maximumPromptBytes: Int = 4_000
    ) {
        let boundedTotal = min(50, max(1, total))
        self.perBot = min(boundedTotal, max(1, perBot))
        self.total = boundedTotal
        self.defaultTimeout = max(1, defaultTimeout)
        self.maximumTimeout = max(1, maximumTimeout)
        self.terminalRetention = max(0, terminalRetention)
        self.terminalHistoryLimit = min(100, max(0, terminalHistoryLimit))
        self.maximumPromptBytes = max(1, maximumPromptBytes)
    }
}

/// Stores typed event waits through an injected local probe; pending waits never call the model, and matching predicates enqueue an idempotent follow-up.
public actor NativeEventWaitRegistry {
    private let probe: any NativeEventWaitProbe
    private let queue: any NativeEventWaitQueue
    private let persistence: any NativeEventWaitPersistence
    private let limits: NativeEventWaitLimits
    private let clock: @Sendable () -> Double
    private var waitsById: [String: NativeEventWait] = [:]
    private var registeringWaitIds: Set<String> = []
    private var stopped = false
    private var didRecover = false
    private var snapshotRevision: UInt64 = 0
    private var saveTask: Task<Void, Error>?

    public init(
        probe: any NativeEventWaitProbe,
        queue: any NativeEventWaitQueue,
        persistence: any NativeEventWaitPersistence,
        limits: NativeEventWaitLimits = NativeEventWaitLimits(),
        clock: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 }
    ) {
        self.probe = probe
        self.queue = queue
        self.persistence = persistence
        self.limits = limits
        self.clock = clock
    }

    @discardableResult
    public func register(
        id: String = "wait_\(UUID().uuidString.lowercased())",
        botId: String,
        threadId: String? = nil,
        prompt: String? = nil,
        predicate: NativeEventWaitPredicate,
        now: Double = Date().timeIntervalSince1970,
        timeout: TimeInterval? = nil
    ) async throws -> NativeEventWait {
        guard !stopped else { throw NativeEventWaitError.registryStopped }
        if !didRecover { _ = try await recover(now: now) }
        guard !stopped else { throw NativeEventWaitError.registryStopped }
        guard !botId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw NativeEventWaitError.invalidBotId
        }
        if let threadId, threadId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw NativeEventWaitError.invalidThread
        }
        if let prompt, prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || prompt.utf8.count > limits.maximumPromptBytes {
            throw NativeEventWaitError.invalidPrompt
        }
        guard Self.isSafe(predicate) else { throw NativeEventWaitError.invalidPredicate }
        let resolvedTimeout = min(max(1, timeout ?? limits.defaultTimeout), limits.maximumTimeout)
        let deadline = now + resolvedTimeout
        guard now.isFinite, deadline.isFinite, deadline > now else {
            throw NativeEventWaitError.invalidDeadline
        }
        guard waitsById[id] == nil else { throw NativeEventWaitError.duplicateWait(id) }

        let active = waitsById.values.filter(Self.isActive)
        guard active.filter({ $0.botId == botId }).count < limits.perBot else {
            throw NativeEventWaitError.perBotLimitReached(botId)
        }
        guard active.count < limits.total else { throw NativeEventWaitError.totalLimitReached }

        let wait = NativeEventWait(id: id, botId: botId, threadId: threadId, prompt: prompt, predicate: predicate, createdAt: now, deadlineAt: deadline)
        waitsById[id] = wait
        registeringWaitIds.insert(id)
        do {
            try await persistSnapshot()
            guard !stopped else { throw NativeEventWaitError.registryStopped }
            registeringWaitIds.remove(id)
            return waitsById[id] ?? wait
        } catch {
            if waitsById[id]?.revision == wait.revision, !stopped {
                waitsById.removeValue(forKey: id)
            }
            registeringWaitIds.remove(id)
            throw error
        }
    }

    public func wait(id: String) -> NativeEventWait? {
        waitsById[id]
    }

    public func activeWaits(botId: String? = nil) -> [NativeEventWait] {
        waitsById.values
            .filter { Self.isActive($0) && !registeringWaitIds.contains($0.id) && (botId == nil || $0.botId == botId) }
            .sorted { $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt }
    }

    public func visibleWaits(botId: String? = nil) -> [NativeEventWait] {
        waitsById.values
            .filter { (Self.isActive($0) || $0.status == .held) && (botId == nil || $0.botId == botId) }
            .sorted { $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt }
    }

    /// Restores persisted waits once, dropping terminal records and expiring stale entries.
    @discardableResult
    public func recover(now: Double = Date().timeIntervalSince1970) async throws -> [NativeEventWait] {
        guard !stopped else { throw NativeEventWaitError.registryStopped }
        guard !didRecover else { return activeWaits() }
        let persisted = try await persistence.loadSnapshot()
        guard !stopped else { throw NativeEventWaitError.registryStopped }
        guard !didRecover else { return activeWaits() }
        let currentValues = Array(waitsById.values)
        var restored: [String: NativeEventWait] = [:]
        for var wait in persisted where Self.isSafe(wait.predicate) && !wait.botId.isEmpty {
            guard Self.isActive(wait) || wait.status == .accepted || wait.status == .dispatching || wait.status == .held else { continue }
            if wait.status == .dispatching { wait.status = .ready }
            if wait.status == .accepted {
                wait.status = .held
                wait.holdReason = "Dispatch outcome unknown after restart"
                wait.revision &+= 1
            }
            if wait.deadlineAt <= now, wait.status != .held {
                wait.status = .expired
                wait.revision &+= 1
                restored[wait.id] = wait
                continue
            }
            let existingForBot = restored.values.filter { Self.isActive($0) && $0.botId == wait.botId }.count
            let existingTotal = restored.values.filter(Self.isActive).count
            if wait.status == .held {
                let heldCount = restored.values.filter { $0.status == .held }.count
                guard heldCount < limits.terminalHistoryLimit, restored.count < limits.total + limits.terminalHistoryLimit else { continue }
            } else {
                guard existingForBot < limits.perBot, existingTotal < limits.total else { continue }
            }
            restored[wait.id] = wait
        }
        for wait in currentValues where (Self.isActive(wait) || wait.status == .held) && restored[wait.id] == nil {
            let existingForBot = restored.values.filter { Self.isActive($0) && $0.botId == wait.botId }.count
            let existingTotal = restored.values.filter(Self.isActive).count
            if wait.status == .held {
                let heldCount = restored.values.filter { $0.status == .held }.count
                guard heldCount < limits.terminalHistoryLimit, restored.count < limits.total + limits.terminalHistoryLimit else { continue }
            } else {
                guard existingForBot < limits.perBot, existingTotal < limits.total else { continue }
            }
            restored[wait.id] = wait
        }
        waitsById = restored
        didRecover = true
        try await persistSnapshot()
        return activeWaits()
    }

    /// Checks registered waits without starting model work while predicates remain false.
    @discardableResult
    public func tick(now: Double = Date().timeIntervalSince1970) async throws -> [String] {
        guard !stopped else { throw NativeEventWaitError.registryStopped }
        if !didRecover { _ = try await recover(now: now) }
        guard !stopped else { throw NativeEventWaitError.registryStopped }

        var enqueued: [String] = []
        let candidateIds = activeWaits().map(\.id)
        for id in candidateIds {
            guard !stopped, let snapshot = waitsById[id], snapshot.deadlineAt > max(now, clock()) else {
                if let current = waitsById[id], current.deadlineAt <= max(now, clock()), Self.isActive(current) {
                    var expired = current
                    expired.status = .expired
                    expired.revision &+= 1
                    waitsById[id] = expired
                    try await persistSnapshot()
                }
                continue
            }

            if snapshot.status == .pending {
                let satisfied = (try? await probe.isSatisfied(botId: snapshot.botId, predicate: snapshot.predicate)) ?? false
                guard !stopped else { throw NativeEventWaitError.registryStopped }
                guard var current = waitsById[id],
                      current.revision == snapshot.revision,
                      current.status == .pending else { continue }
                if current.deadlineAt <= max(now, clock()) {
                    current.status = .expired
                    current.revision &+= 1
                    waitsById[id] = current
                    try await persistSnapshot()
                    continue
                }
                guard satisfied else { continue }
                current.status = .ready
                current.revision &+= 1
                waitsById[id] = current
                try await persistSnapshot()
            }

            guard !stopped,
                  let ready = waitsById[id],
                  ready.status == .ready,
                  ready.deadlineAt > max(now, clock()) else { continue }
            var dispatching = ready
            dispatching.status = .dispatching
            dispatching.revision &+= 1
            waitsById[id] = dispatching
            try await persistSnapshot()
            guard !stopped else { throw NativeEventWaitError.registryStopped }
            guard var beforeEnqueue = waitsById[id],
                  beforeEnqueue.status == .dispatching,
                  beforeEnqueue.revision == dispatching.revision else { continue }
            if beforeEnqueue.deadlineAt <= max(now, clock()) {
                beforeEnqueue.status = .expired
                beforeEnqueue.revision &+= 1
                waitsById[id] = beforeEnqueue
                try await persistSnapshot()
                continue
            }
            do {
                switch try await queue.enqueueFollowUp(dispatching) {
                case .completed:
                    break
                case .held(let reason):
                    guard var current = waitsById[id], current.status == .dispatching, current.revision == dispatching.revision else { continue }
                    current.status = .held
                    current.holdReason = reason
                    current.revision &+= 1
                    waitsById[id] = current
                    try await persistSnapshot()
                    continue
                }
            } catch {
                if var current = waitsById[id], current.revision == dispatching.revision, current.status == .dispatching {
                    current.status = .ready
                    current.revision &+= 1
                    waitsById[id] = current
                    try await persistSnapshot()
                }
                continue
            }
            guard var current = waitsById[id],
                  current.status == .dispatching,
                  current.revision == dispatching.revision else { continue }
            current.status = .completed
            current.revision &+= 1
            waitsById[id] = current
            enqueued.append(id)
            try await persistSnapshot()
        }
        pruneTerminal(now: now)
        guard !stopped else { throw NativeEventWaitError.registryStopped }
        return enqueued
    }

    @discardableResult
    public func cancel(id: String) async throws -> NativeEventWait? {
        guard var wait = waitsById[id], wait.status == .pending || wait.status == .ready || wait.status == .held else { return waitsById[id] }
        wait.status = .cancelled
        wait.revision &+= 1
        waitsById[id] = wait
        try await persistSnapshot()
        return wait
    }

    /// Stops probes while keeping pending records available for recovery after restart.
    public func shutdown() {
        stopped = true
    }

    private func pruneTerminal(now: Double) {
        let active = Dictionary(uniqueKeysWithValues: waitsById.filter { Self.isActive($0.value) }.map { ($0.key, $0.value) })
        let terminal = waitsById.values
            .filter { $0.status == .held || (!Self.isActive($0) && now - $0.deadlineAt <= limits.terminalRetention) }
            .sorted { $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt }
            .suffix(limits.terminalHistoryLimit)
        waitsById = active.merging(Dictionary(uniqueKeysWithValues: terminal.map { ($0.id, $0) })) { _, latest in latest }
    }

    private func persistSnapshot() async throws {
        snapshotRevision &+= 1
        let revision = snapshotRevision
        let snapshot = waitsById.values.filter { Self.isActive($0) || $0.status == .held || $0.status == .accepted }.sorted { $0.id < $1.id }
        let previous = saveTask
        let persistence = self.persistence
        let task = Task<Void, Error> {
            _ = try? await previous?.value
            try await persistence.saveSnapshot(snapshot)
        }
        saveTask = task
        do {
            try await task.value
        } catch {
            if snapshotRevision == revision { saveTask = nil }
            throw error
        }
    }

    private static func isSafe(_ predicate: NativeEventWaitPredicate) -> Bool {
        switch predicate {
        case .fileExists(let path):
            guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\\"), !path.contains(":") else { return false }
            let components = path.split(separator: "/", omittingEmptySubsequences: false)
            return components.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\0") }
        case .processFinished(let pid, let startTime):
            return pid > 0 && startTime.isFinite && startTime > 0
        case .botIdle:
            return true
        }
    }

    private static func isActive(_ wait: NativeEventWait) -> Bool {
        wait.status == .pending || wait.status == .ready || wait.status == .dispatching
    }
}

/// Small in-memory persistence useful for deterministic tests and ephemeral hosts.
public actor InMemoryNativeEventWaitPersistence: NativeEventWaitPersistence {
    private var snapshot: [NativeEventWait]

    public init(snapshot: [NativeEventWait] = []) {
        self.snapshot = snapshot
    }

    public func loadSnapshot() async throws -> [NativeEventWait] { snapshot }
    public func saveSnapshot(_ waits: [NativeEventWait]) async throws { snapshot = waits }
}

public struct DatabaseNativeEventWaitPersistence: NativeEventWaitPersistence {
    private let database: DatabaseService

    public init(database: DatabaseService) {
        self.database = database
    }

    public func loadSnapshot() async throws -> [NativeEventWait] {
        try await database.loadNativeEventWaits()
    }

    public func saveSnapshot(_ waits: [NativeEventWait]) async throws {
        try await database.replaceNativeEventWaitSnapshot(waits)
    }
}
