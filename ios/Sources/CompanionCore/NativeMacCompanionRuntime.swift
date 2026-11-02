import Foundation

/// Registered-bot ids for the workspace source, loaded lazily from the
/// database and then served from memory until the entry expires.
/// `DatabaseService` exposes no bot-change signal to invalidate on, so a
/// fresh cache hit never touches the database; a miss — or an entry older
/// than `ttl` — reloads the bot table once, which picks up bots registered
/// after the first probe and drops deregistered ones within one TTL
/// window, without rescanning on every poll tick.
private actor RegisteredBotIdCache {
    private var cachedIds: Set<String>?
    private var loadedAt: Date?
    private let ttl: TimeInterval

    init(ttl: TimeInterval = 30) {
        self.ttl = ttl
    }

    func contains(_ botId: String, load: @Sendable () async throws -> [String]) async throws -> Bool {
        if let cachedIds, let loadedAt, cachedIds.contains(botId),
           Date().timeIntervalSince(loadedAt) < ttl { return true }
        let loaded = Set(try await load())
        cachedIds = loaded
        loadedAt = Date()
        return loaded.contains(botId)
    }
}

/// Production workspace source for the Mac companion listener: one directory
/// per bot registered in the listener's own database, confined under the
/// listener's `workspaces` root.  Unlike the headless host's execution
/// context, which only knows bots a service explicitly registered with it,
/// this source reads registration from the database the listener already
/// owns, so a `fileExists` wait resolves under
/// `<workspacesRoot>/<botId>/` and nowhere else.
public final class DatabaseBotWorkspaceSource: NativeEventWaitWorkspaceSource {
    private let database: DatabaseService
    private let workspacesRoot: URL
    private let registeredBotIds: RegisteredBotIdCache

    public init(database: DatabaseService, workspacesRoot: URL) {
        self.database = database
        self.workspacesRoot = workspacesRoot
        self.registeredBotIds = RegisteredBotIdCache()
    }

    /// Test seam for cache-expiry behavior; production uses the default TTL.
    init(database: DatabaseService, workspacesRoot: URL, botIdCacheTTL: TimeInterval) {
        self.database = database
        self.workspacesRoot = workspacesRoot
        self.registeredBotIds = RegisteredBotIdCache(ttl: botIdCacheTTL)
    }

    public func workspaceRoot(forRegisteredBotId botId: String) async throws -> URL? {
        guard Self.safeComponent(botId), workspacesRoot.isFileURL,
              workspacesRoot.path.hasPrefix("/"), workspacesRoot.path != "/" else { return nil }
        guard try await registeredBotIds.contains(botId, load: { try await database.loadBots().map(\.id) }) else { return nil }
        try FileManager.default.createDirectory(at: workspacesRoot, withIntermediateDirectories: true)
        let candidate = workspacesRoot.appendingPathComponent(botId, isDirectory: true)
        try FileManager.default.createDirectory(at: candidate, withIntermediateDirectories: true)
        // Confinement is checked after symlink resolution, so a planted
        // symlink in place of the bot directory cannot redirect probes
        // outside the workspaces root.
        let root = workspacesRoot.standardizedFileURL.resolvingSymlinksInPath()
        let resolved = candidate.standardizedFileURL.resolvingSymlinksInPath()
        guard resolved.path.hasPrefix(root.path + "/") else { return nil }
        return resolved
    }

    private static func safeComponent(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 128 && value.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil
    }
}

/// Admission for the production Mac graph, which has no engine drivers
/// yet: every satisfied wait is held here, before any dispatch claim, as
/// typed unclaimed work that `resumeCapabilityHeldWaits` can later
/// resume.  The headless host can register production drivers because its
/// bootstrap decodes a per-bot `NativeHostBotConfiguration` (including
/// the engine executable) from each bot's stored JSON, resolves service
/// credentials, and switches the bot to native ownership
/// (`NativeHeadlessHost.registerBot`).  Mac listener bots carry Node
/// `bots.json` records with none of that configuration, and the
/// interactive app has no service credential source, so claiming a wait
/// here could only fail inside driver dispatch.  Holding at admission is
/// the honest state until the Mac composition supplies an execution
/// context (and with it, registered drivers).
private struct UnavailableMacExecutionContext: NativeExecutionContextSource {
    func resolve(wait: NativeEventWait) async throws -> NativeExecutionAdmission {
        .held(.credentialsUnavailable)
    }
}

#if !os(macOS)
/// No Mac engine processes can be launched off macOS, so no owned process
/// can ever have finished; this fails closed rather than probing PIDs.
private struct NoOwnedProcessSource: NativeEventWaitProcessOwnershipSource {
    func hasFinishedProcess(pid: Int32, startTime: Double, ownedByBotId botId: String) async -> Bool { false }
}
#endif

/// The Mac app companion listener's native runtime graph, mirroring the
/// headless host's composition (`NativeHeadlessHost.start`) for the
/// interactive app: the listener's own database, a durable turn dispatcher,
/// the reused owned-process ledger over a real process supervisor, and a
/// workspace source confined under the listener's data directory.
/// Construction starts nothing: the server activates the runtime (and its
/// polling) only from `startListening`, and `stopListening` stays
/// socket-only, exactly as before this injection.  Unless the caller
/// supplies an execution context, satisfied waits are admission-held
/// unclaimed (see `UnavailableMacExecutionContext`): this graph serves
/// and probes waits, but dispatches no turns.
public struct NativeMacCompanionRuntime {
    public let runtime: NativeRuntimeServices
    /// The launcher engine drivers must use for their processes to be
    /// visible to `processFinished` waits.  Nil off macOS.
    public let ownedProcessLauncher: (any EngineProcessLauncher)?
    private let database: DatabaseService

    public init(
        database: DatabaseService,
        workspacesRoot: URL,
        engineCoordinator: EngineCoordinatorActor? = nil,
        engineSwitch: BotNativeEngineSwitchActor? = nil,
        executionContext: (any NativeExecutionContextSource)? = nil
    ) {
        self.database = database
        let coordinator = engineCoordinator ?? EngineCoordinatorActor(
            dispatcher: TurnDispatcherActor(database: database, maxRetriesPerEngine: 0, requiresDurablePersistence: true)
        )
        let engineSwitch = engineSwitch ?? BotNativeEngineSwitchActor(database: database)
        #if os(macOS)
        // The interactive app's supervisor inherits the app process
        // environment (the default), unlike the headless service, whose
        // execution context supplies an explicit one.
        let ledger = NativeHostProcessLedger(supervisor: ProcessSupervisorActor(), database: database)
        self.ownedProcessLauncher = ledger
        let processSource: any NativeEventWaitProcessOwnershipSource = ledger
        #else
        self.ownedProcessLauncher = nil
        let processSource: any NativeEventWaitProcessOwnershipSource = NoOwnedProcessSource()
        #endif
        let resolvedExecutionContext: any NativeExecutionContextSource =
            executionContext ?? UnavailableMacExecutionContext()
        self.runtime = NativeRuntimeServices(
            database: database,
            engineCoordinator: coordinator,
            engineSwitch: engineSwitch,
            workspaceSource: DatabaseBotWorkspaceSource(database: database, workspacesRoot: workspacesRoot),
            processOwnershipSource: processSource,
            executionContext: resolvedExecutionContext
        )
    }

    /// The companion server carrying this runtime, so its wait routes are
    /// served instead of answering `no_route`.
    public func makeServer() -> NativeCompanionServer {
        NativeCompanionServer(database: database, nativeRuntime: runtime)
    }
}
