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
/// the reused owned-process ledger over a real process supervisor, a
/// workspace source confined under the listener's data directory, and
/// `MacExecutionContext` plus `CostLedgerService`, `NativeFaultBannerStore`,
/// `PluginSandboxHost`, `NativeRecallClient`, and optional `ZulipEventActor`
/// (`BF-2689`).
/// Construction starts nothing: the server activates the runtime (and its
/// polling) only from `startListening`, and `stopListening` stays
/// socket-only, exactly as before this injection.  Until a bot profile,
/// credential source, and engine driver are registered, `MacExecutionContext`
/// fails closed and holds waits unclaimed as `.credentialsUnavailable`.
public struct NativeMacCompanionRuntime: Sendable {
    public let runtime: NativeRuntimeServices
    /// Interactive Mac execution context resolving ready turns when profiles,
    /// workspaces, and credentials are registered (`BF-2689`).
    public let macExecutionContext: MacExecutionContext
    private let usesExternalExecutionContext: Bool
    /// Spend and quota ledger (`BF-2619`).
    public let costLedger: CostLedgerService
    /// Redacted runtime fault banner store (`BF-2618`).
    public let faultBanners: NativeFaultBannerStore
    /// Plugin sandbox confinement and environment scrubbing host (`BF-2620`).
    public let pluginSandbox: PluginSandboxHost
    /// Preflight secret-scanning Fleet Recall client (`BF-2620`).
    public let recallClient: NativeRecallClient
    /// Optional Zulip event queue actor (`BF-2512`).
    public let zulipActor: ZulipEventActor?
    /// The launcher engine drivers must use for their processes to be
    /// visible to `processFinished` waits.  Nil off macOS.
    public let ownedProcessLauncher: (any EngineProcessLauncher)?
    private let database: DatabaseService
    /// The supervisor behind the ledger, retained so the Mac app's session
    /// state and graceful-stop drain can read its supervised-process count.
    /// Nil off macOS, where no owned process can run.
    private let processSupervisor: ProcessSupervisorActor?

    public init(
        database: DatabaseService,
        workspacesRoot: URL,
        engineCoordinator: EngineCoordinatorActor? = nil,
        engineSwitch: BotNativeEngineSwitchActor? = nil,
        executionContext: (any NativeExecutionContextSource)? = nil,
        processSupervisor: ProcessSupervisorActor? = nil,
        credentials: (any NativeServiceCredentialSource)? = nil,
        costLedger: CostLedgerService? = nil,
        faultBanners: NativeFaultBannerStore? = nil,
        pluginSandbox: PluginSandboxHost? = nil,
        recallClient: NativeRecallClient? = nil,
        zulipActor: ZulipEventActor? = nil
    ) {
        self.database = database
        let coordinator = engineCoordinator ?? EngineCoordinatorActor(
            dispatcher: TurnDispatcherActor(database: database, maxRetriesPerEngine: 0, requiresDurablePersistence: true)
        )
        let engineSwitch = engineSwitch ?? BotNativeEngineSwitchActor(database: database)
        let workspaceSource = DatabaseBotWorkspaceSource(database: database, workspacesRoot: workspacesRoot)
        if let injectedMacContext = executionContext as? MacExecutionContext {
            self.macExecutionContext = injectedMacContext
            self.usesExternalExecutionContext = false
        } else {
            self.macExecutionContext = MacExecutionContext(
                workspaceSource: workspaceSource,
                credentials: credentials ?? UnavailableNativeServiceCredentials()
            )
            self.usesExternalExecutionContext = (executionContext != nil)
        }
        self.costLedger = costLedger ?? CostLedgerService()
        self.faultBanners = faultBanners ?? NativeFaultBannerStore()
        let defaultPluginRoot = workspacesRoot.deletingLastPathComponent().appendingPathComponent("plugins", isDirectory: true)
        self.pluginSandbox = pluginSandbox ?? PluginSandboxHost(policy: PluginSandboxPolicy(sandboxRoot: defaultPluginRoot))
        self.recallClient = recallClient ?? NativeRecallClient()
        self.zulipActor = zulipActor
        #if os(macOS)
        // The interactive app's supervisor inherits the app process
        // environment (the default), unlike the headless service, whose
        // execution context supplies an explicit one.  An injected
        // supervisor is used as-is so the Mac app composition owns the one
        // instance its drain counters read.
        let supervisor = processSupervisor ?? ProcessSupervisorActor()
        self.processSupervisor = supervisor
        let ledger = NativeHostProcessLedger(supervisor: supervisor, database: database)
        self.ownedProcessLauncher = ledger
        let processSource: any NativeEventWaitProcessOwnershipSource = ledger
        #else
        self.processSupervisor = nil
        self.ownedProcessLauncher = nil
        let processSource: any NativeEventWaitProcessOwnershipSource = NoOwnedProcessSource()
        #endif
        let resolvedExecutionContext: any NativeExecutionContextSource =
            executionContext ?? self.macExecutionContext
        self.runtime = NativeRuntimeServices(
            database: database,
            engineCoordinator: coordinator,
            engineSwitch: engineSwitch,
            workspaceSource: workspaceSource,
            processOwnershipSource: processSource,
            executionContext: resolvedExecutionContext
        )
    }

    /// Registers an interactive Mac bot profile and optional engine driver on
    /// the runtime's execution context and engine coordinator (`BF-2689`).
    /// Fails closed with `MacExecutionContextError.externalExecutionContextActive`
    /// if the runtime was constructed with a non-`MacExecutionContext` override.
    public func registerBot(
        _ profile: MacBotExecutionProfile,
        driver: (any EngineDriver)? = nil
    ) async throws {
        guard !usesExternalExecutionContext else {
            throw MacExecutionContextError.externalExecutionContextActive
        }
        try await macExecutionContext.register(profile)
        if let driver {
            await runtime.engineCoordinator.registerDriver(driver)
            await runtime.engineCoordinator.setFallbackChain(forBot: profile.id, engineIds: [profile.engineId])
        }
    }

    /// The companion server carrying this runtime, so its wait routes are
    /// served instead of answering `no_route`.
    public func makeServer() -> NativeCompanionServer {
        NativeCompanionServer(database: database, nativeRuntime: runtime)
    }

    /// Active engine turns on this graph.  Feeds the Mac app session state's
    /// busy reading and the graceful-stop drain's work-in-flight counter.
    public func activeEngineTurnCount() async -> Int {
        await runtime.engineCoordinator.activeTurnCount()
    }

    /// Supervised engine processes on this graph.  Off macOS this is always
    /// zero: no owned process can ever have started there.
    public func activeProcessCount() async -> Int {
        #if os(macOS)
        await processSupervisor?.activeProcessCount() ?? 0
        #else
        return 0
        #endif
    }
}
