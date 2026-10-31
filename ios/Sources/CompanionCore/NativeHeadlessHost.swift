import Foundation

public enum NativeHeadlessHostError: Error, Equatable, Sendable {
    case invalidServiceRoot
    case unsafeServicePath
    case ownerAlreadyRunning
    case ownerLockFailed
    case invalidBotConfiguration
    case botConfigurationIsImmutable
    case stopped
    case reentrantShutdown
    case stopMarkerFailed
}

#if os(macOS)
import Darwin

/// Every runtime path is below an explicitly selected, private, service-owned directory.
public struct NativeServicePaths: Sendable {
    public let root: URL
    public var database: URL { root.appendingPathComponent("host.sqlite") }
    public var home: URL { root.appendingPathComponent("home", isDirectory: true) }
    public var temporary: URL { root.appendingPathComponent("tmp", isDirectory: true) }
    public var workspaces: URL { root.appendingPathComponent("workspaces", isDirectory: true) }
    public var stoppedMarker: URL { root.appendingPathComponent("stopped.marker") }

    public init(serviceData: URL) throws {
        guard serviceData.isFileURL, serviceData.path.hasPrefix("/"), serviceData.path != "/",
              !serviceData.path.contains("\0") else { throw NativeHeadlessHostError.invalidServiceRoot }
        let root = serviceData.standardizedFileURL
        try Self.privateDirectory(root)
        self.root = root.resolvingSymlinksInPath()
        // An interactive/Node root must never be silently adopted by the separate service identity.
        for name in ["harness-owner.json", "config.json"] where FileManager.default.fileExists(atPath: root.appendingPathComponent(name).path) {
            throw NativeHeadlessHostError.invalidServiceRoot
        }
    }

    func prepareContents() throws {
        for directory in [home, temporary, workspaces] { try Self.privateDirectory(directory) }
        for file in [database, URL(fileURLWithPath: database.path + "-wal"), URL(fileURLWithPath: database.path + "-shm")] {
            var info = stat()
            if lstat(file.path, &info) == 0 {
                guard info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_nlink == 1 else {
                    throw NativeHeadlessHostError.unsafeServicePath
                }
            } else if errno != ENOENT { throw NativeHeadlessHostError.unsafeServicePath }
        }
    }

    func prepareWorkspace(botId: String) throws -> URL {
        guard !botId.isEmpty, botId.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil else {
            throw NativeHeadlessHostError.invalidBotConfiguration
        }
        let workspace = workspaces.appendingPathComponent(botId, isDirectory: true)
        try Self.privateDirectory(workspace)
        return workspace
    }

    func clearStoppedMarker() throws {
        if try hasStoppedMarker() { try FileManager.default.removeItem(at: stoppedMarker) }
    }

    func hasStoppedMarker() throws -> Bool {
        var info = stat()
        if lstat(stoppedMarker.path, &info) == 0 {
            guard info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_nlink == 1,
                  info.st_mode & 0o077 == 0 else {
                throw NativeHeadlessHostError.unsafeServicePath
            }
            let fd = open(stoppedMarker.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            guard fd >= 0 else { throw NativeHeadlessHostError.unsafeServicePath }
            defer { Darwin.close(fd) }
            var opened = stat()
            guard fstat(fd, &opened) == 0, opened.st_dev == info.st_dev, opened.st_ino == info.st_ino,
                  opened.st_mode & S_IFMT == S_IFREG, opened.st_uid == getuid(), opened.st_nlink == 1,
                  opened.st_mode & 0o077 == 0, opened.st_size == 17 else { throw NativeHeadlessHostError.unsafeServicePath }
            var bytes = [UInt8](repeating: 0, count: 18)
            var count: Int
            repeat { count = Darwin.read(fd, &bytes, bytes.count) } while count < 0 && errno == EINTR
            guard count == 17, Data(bytes.prefix(count)) == Data("{\"stopped\":true}\n".utf8) else {
                throw NativeHeadlessHostError.unsafeServicePath
            }
            return true
        } else if errno != ENOENT { throw NativeHeadlessHostError.unsafeServicePath }
        return false
    }

    private static func privateDirectory(_ url: URL) throws {
        var info = stat()
        if lstat(url.path, &info) != 0 {
            guard errno == ENOENT else { throw NativeHeadlessHostError.unsafeServicePath }
            // Parent provisioning belongs to the installer; the runtime creates only its own final component.
            guard mkdir(url.path, 0o700) == 0 || errno == EEXIST else { throw NativeHeadlessHostError.unsafeServicePath }
            guard lstat(url.path, &info) == 0 else { throw NativeHeadlessHostError.unsafeServicePath }
        }
        guard info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(), info.st_mode & 0o077 == 0 else {
            throw NativeHeadlessHostError.unsafeServicePath
        }
    }
}

/// The lock inode is stable across owners; never unlink a lock file to recover a live or stalled owner.
final class NativeHostOwnerLease: @unchecked Sendable {
    private let mutex = NSLock()
    private var descriptor: Int32

    init(paths: NativeServicePaths, beforeAcquire: (() throws -> Void)? = nil) throws {
        let path = paths.root.appendingPathComponent("owner.lock").path
        let fd = open(path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0o600)
        guard fd >= 0 else { throw NativeHeadlessHostError.ownerLockFailed }
        var acquired = false
        do {
            guard Self.matchesListedIdentity(fd: fd, path: path) else { throw NativeHeadlessHostError.ownerLockFailed }
            try beforeAcquire?()
            guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
                throw errno == EWOULDBLOCK ? NativeHeadlessHostError.ownerAlreadyRunning : NativeHeadlessHostError.ownerLockFailed
            }
            acquired = true
            guard Self.matchesListedIdentity(fd: fd, path: path) else { throw NativeHeadlessHostError.ownerLockFailed }
            descriptor = fd
        } catch {
            if acquired { _ = flock(fd, LOCK_UN) }
            Darwin.close(fd)
            throw error
        }
    }

    private static func matchesListedIdentity(fd: Int32, path: String) -> Bool {
        var opened = stat()
        var listed = stat()
        return fstat(fd, &opened) == 0 && lstat(path, &listed) == 0 &&
            opened.st_mode & S_IFMT == S_IFREG && listed.st_mode & S_IFMT == S_IFREG &&
            opened.st_uid == getuid() && listed.st_uid == getuid() &&
            opened.st_nlink == 1 && listed.st_nlink == 1 &&
            opened.st_mode & 0o077 == 0 && listed.st_mode & 0o077 == 0 &&
            opened.st_dev == listed.st_dev && opened.st_ino == listed.st_ino
    }

    func release() {
        mutex.lock()
        let fd = descriptor
        descriptor = -1
        mutex.unlock()
        if fd >= 0 { _ = flock(fd, LOCK_UN); Darwin.close(fd) }
    }

    deinit { release() }
}

public enum NativeHeadlessHostState: String, Sendable {
    case running
    case stopping
    case stopped
    case shutdownFailed
}

public enum NativeHostStartIntent: Equatable, Sendable { case automatic, explicit }

public enum NativeHostLaunchResult: Sendable {
    case running(NativeHeadlessHost)
    case stoppedByOwner
}

/// A foreground service graph, independent of MacSession, NSWorkspace, login Keychain and desktop permissions.
public actor NativeHeadlessHost {
    public let paths: NativeServicePaths
    private let lease: NativeHostOwnerLease
    private let database: DatabaseService
    private let context: NativeHostExecutionContext
    private let processes: NativeHostProcessLedger
    private let coordinator: EngineCoordinatorActor
    private let engineSwitch: BotNativeEngineSwitchActor
    private let runtime: NativeRuntimeServices
    private var bots: [String: NativeHostBotConfiguration] = [:]
    private var registeringBots: Set<String> = []
    private var lifecycle: UInt64 = 0
    private var operations = 0
    private var operationWaiters: [CheckedContinuation<Void, Never>] = []
    private var shutdownTask: Task<Void, Error>?
    private(set) var deliberateStopRequested = false
    private var lateStopLease: NativeHostOwnerLease?
    public private(set) var state: NativeHeadlessHostState = .running

    private init(paths: NativeServicePaths, lease: NativeHostOwnerLease, database: DatabaseService,
                 context: NativeHostExecutionContext, processes: NativeHostProcessLedger,
                 coordinator: EngineCoordinatorActor, engineSwitch: BotNativeEngineSwitchActor,
                 runtime: NativeRuntimeServices) {
        self.paths = paths; self.lease = lease; self.database = database
        self.context = context; self.processes = processes; self.coordinator = coordinator
        self.engineSwitch = engineSwitch; self.runtime = runtime
    }

    public static func start(
        serviceData: URL,
        credentials: any NativeServiceCredentialSource = UnavailableNativeServiceCredentials(),
        pollIntervalSeconds: TimeInterval? = 1
    ) async throws -> NativeHeadlessHost {
        let result = try await launch(serviceData: serviceData, intent: .explicit,
            credentials: credentials, pollIntervalSeconds: pollIntervalSeconds)
        guard case .running(let host) = result else { throw NativeHeadlessHostError.stopped }
        return host
    }

    public static func launch(
        serviceData: URL,
        intent: NativeHostStartIntent,
        credentials: any NativeServiceCredentialSource = UnavailableNativeServiceCredentials(),
        pollIntervalSeconds: TimeInterval? = 1
    ) async throws -> NativeHostLaunchResult {
        let paths = try NativeServicePaths(serviceData: serviceData)
        let lease = try NativeHostOwnerLease(paths: paths)
        var openedDatabase: DatabaseService?
        do {
            if intent == .automatic, try paths.hasStoppedMarker() {
                lease.release()
                return .stoppedByOwner
            }
            // Refuse unsafe markers before explicit startup can open or recover the database.
            _ = try paths.hasStoppedMarker()
            try paths.prepareContents()
            let database = try DatabaseService(path: paths.database.path)
            openedDatabase = database
            let supervisor = ProcessSupervisorActor(baseEnvironment: [:])
            let processes = NativeHostProcessLedger(supervisor: supervisor, database: database)
            let context = NativeHostExecutionContext(paths: paths, credentials: credentials)
            let coordinator = EngineCoordinatorActor(dispatcher: TurnDispatcherActor(database: database,
                maxRetriesPerEngine: 0, requiresDurablePersistence: true))
            let engineSwitch = BotNativeEngineSwitchActor(database: database)
            let runtime = NativeRuntimeServices(database: database, engineCoordinator: coordinator,
                engineSwitch: engineSwitch, workspaceSource: context, processOwnershipSource: processes,
                executionContext: context)
            let host = NativeHeadlessHost(paths: paths, lease: lease, database: database, context: context,
                processes: processes, coordinator: coordinator, engineSwitch: engineSwitch, runtime: runtime)
            for record in try await database.loadBots() {
                guard let data = record.rawJSON.data(using: .utf8),
                      let bot = try? JSONDecoder().decode(NativeHostBotConfiguration.self, from: data),
                      bot.id == record.id, bot.threadId == record.threadId else {
                    throw NativeHeadlessHostError.invalidBotConfiguration
                }
                try await host.registerBot(bot)
            }
            try await runtime.activate()
            try await runtime.resumeCapabilityHeldWaits()
            try paths.clearStoppedMarker()
            try await runtime.activate(pollIntervalSeconds: pollIntervalSeconds)
            return .running(host)
        } catch {
            // No work starts until recovery succeeds; a failed construction never publishes an owner.
            try? await openedDatabase?.checkpointAndClose()
            lease.release()
            throw error
        }
    }

    /// Trusted local composition API; no unauthenticated network endpoint changes execution capabilities.
    public func registerBot(_ bot: NativeHostBotConfiguration) async throws {
        try beginOperation()
        defer { endOperation() }
        if let existing = bots[bot.id] {
            guard existing == bot else { throw NativeHeadlessHostError.botConfigurationIsImmutable }
            return
        }
        guard registeringBots.insert(bot.id).inserted else { throw NativeHeadlessHostError.botConfigurationIsImmutable }
        defer { registeringBots.remove(bot.id) }
        let revision = lifecycle
        try await context.register(bot)
        try requireCurrent(revision)
        let existingThread = try await database.loadThread(id: bot.threadId)
        try requireCurrent(revision)
        guard existingThread == nil || existingThread?.botId == bot.id else { throw NativeHeadlessHostError.invalidBotConfiguration }
        let now = Date().timeIntervalSince1970
        let thread = existingThread ?? ThreadRecord(id: bot.threadId, title: bot.name, botId: bot.id, createdAt: now, updatedAt: now)
        let rawJSON = String(decoding: try JSONEncoder().encode(bot), as: UTF8.self)
        try await database.upsertBot(StoredBotRecord(id: bot.id, name: bot.name, threadId: bot.threadId, createdAt: now, rawJSON: rawJSON))
        try requireCurrent(revision)
        // This is a separate service store, not a migration of an interactive/Node history.
        _ = try await engineSwitch.switchToNativeSwift(botId: bot.id,
            historySnapshot: BotHistoryImportSnapshot(botId: bot.id, threads: [thread], messagesByThread: [:]))
        try requireCurrent(revision)
        let engineId = "service-\(bot.id)"
        await coordinator.registerDriver(ClaudeStreamRunner(engineId: engineId, executable: bot.claudeExecutable, launcher: processes))
        await coordinator.setFallbackChain(forBot: bot.id, engineIds: [engineId])
        try requireCurrent(revision)
        bots[bot.id] = bot
    }

    public func registerWait(botId: String, prompt: String, predicate: NativeEventWaitPredicate,
                             timeout: TimeInterval? = nil) async throws -> NativeEventWait {
        try beginOperation()
        defer { endOperation() }
        guard let bot = bots[botId] else { throw NativeHeadlessHostError.invalidBotConfiguration }
        let revision = lifecycle
        let wait = try await runtime.registerWait(botId: botId, threadId: bot.threadId, prompt: prompt,
                                                  predicate: predicate, timeout: timeout)
        try requireCurrent(revision)
        return wait
    }

    public func tick() async throws {
        try beginOperation()
        defer { endOperation() }
        let revision = lifecycle
        _ = try await runtime.tick()
        try requireCurrent(revision)
    }

    public func refreshCapabilities() async throws {
        try beginOperation()
        defer { endOperation() }
        let revision = lifecycle
        try await runtime.resumeCapabilityHeldWaits()
        try requireCurrent(revision)
    }

    public func waitForDispatches() async { await runtime.waitRegistry.waitForDispatches() }
    public func wait(id: String) async -> NativeEventWait? { await runtime.waitRegistry.wait(id: id) }
    public func messages(botId: String) async throws -> [MessageRecord] {
        try beginOperation()
        defer { endOperation() }
        guard let bot = bots[botId] else { throw NativeHeadlessHostError.invalidBotConfiguration }
        return try await database.loadMessages(forThread: bot.threadId, limit: 1000)
    }

    /// Concurrent stop requests share one checked completion, including any failure.
    public func shutdown(deliberateStop: Bool = false) async throws {
        guard NativeServiceTaskContext.credentialOwner != context.ownerID else {
            throw NativeHeadlessHostError.reentrantShutdown
        }
        deliberateStopRequested = deliberateStopRequested || deliberateStop
        if state == .stopped, deliberateStop {
            // Reacquire ownership before a late explicit stop can publish a marker beside a newer graph.
            let markerLease = try NativeHostOwnerLease(paths: paths)
            lateStopLease = markerLease
            do {
                try publishStoppedMarker()
                markerLease.release()
                lateStopLease = nil
            } catch {
                state = .shutdownFailed
                shutdownTask = Task { throw error }
                throw error
            }
        }
        if let shutdownTask { return try await shutdownTask.value }
        state = .stopping
        lifecycle &+= 1
        let task = Task { try await self.finishShutdown() }
        shutdownTask = task
        try await task.value
    }

    private func finishShutdown() async throws {
        do {
            await context.stop()
            await processes.stop()
            await runtime.shutdown()
            await drainOperations()
            try await runtime.shutdownAndDrain()
            for bot in bots.values { _ = try await engineSwitch.flushPendingNativeWrites(for: bot.id) }
            try await database.checkpointAndClose()
            if deliberateStopRequested { try publishStoppedMarker() }
            lease.release()
            state = .stopped
        } catch {
            // Keep the owner lease on an incomplete shutdown; another graph must not race unfinished work.
            state = .shutdownFailed
            throw error
        }
    }

    private func publishStoppedMarker() throws {
        let temporary = paths.root.appendingPathComponent(".stop-\(UUID().uuidString)")
        let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0o600)
        guard fd >= 0 else { throw NativeHeadlessHostError.stopMarkerFailed }
        defer { Darwin.close(fd); _ = unlink(temporary.path) }
        let payload = Data("{\"stopped\":true}\n".utf8)
        try payload.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let written = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if written > 0 { offset += written }
                else if written < 0, errno == EINTR { continue }
                else { throw NativeHeadlessHostError.stopMarkerFailed }
            }
        }
        // Check permissions and file flush before the final marker becomes visible.
        guard fchmod(fd, 0o600) == 0, fsync(fd) == 0,
              rename(temporary.path, paths.stoppedMarker.path) == 0 else {
            throw NativeHeadlessHostError.stopMarkerFailed
        }
    }

    private func requireRunning() throws {
        guard state == .running else { throw NativeHeadlessHostError.stopped }
    }
    private func beginOperation() throws {
        try requireRunning()
        operations += 1
    }
    private func endOperation() {
        operations -= 1
        if operations == 0 {
            let waiters = operationWaiters
            operationWaiters.removeAll()
            for waiter in waiters { waiter.resume() }
        }
    }
    private func drainOperations() async {
        if operations == 0 { return }
        await withCheckedContinuation { operationWaiters.append($0) }
    }
    private func requireCurrent(_ revision: UInt64) throws {
        try requireRunning()
        guard revision == lifecycle else { throw NativeHeadlessHostError.stopped }
    }
}
#endif
