import Foundation

/// Production workspace source for the Mac companion listener: one directory
/// per bot registered in the listener's own database, confined under the
/// listener's `workspaces` root.  Unlike the headless host's execution
/// context, which only knows bots a service explicitly registered with it,
/// this source reads registration from the database the listener already
/// owns, so a `fileExists` wait resolves under
/// `<workspacesRoot>/<botId>/` and nowhere else.
public struct DatabaseBotWorkspaceSource: NativeEventWaitWorkspaceSource {
    private let database: DatabaseService
    private let workspacesRoot: URL

    public init(database: DatabaseService, workspacesRoot: URL) {
        self.database = database
        self.workspacesRoot = workspacesRoot
    }

    public func workspaceRoot(forRegisteredBotId botId: String) async throws -> URL? {
        guard Self.safeComponent(botId), workspacesRoot.isFileURL,
              workspacesRoot.path.hasPrefix("/"), workspacesRoot.path != "/" else { return nil }
        let bots = try await database.loadBots()
        guard bots.contains(where: { $0.id == botId }) else { return nil }
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
/// the reused owned-process ledger over a real process supervisor, and a
/// workspace source confined under the listener's data directory.
/// Construction starts nothing: the server activates the runtime (and its
/// polling) only from `startListening`, and `stopListening` stays
/// socket-only, exactly as before this injection.
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
        engineSwitch: BotNativeEngineSwitchActor? = nil
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
        self.runtime = NativeRuntimeServices(
            database: database,
            engineCoordinator: coordinator,
            engineSwitch: engineSwitch,
            workspaceSource: DatabaseBotWorkspaceSource(database: database, workspacesRoot: workspacesRoot),
            processOwnershipSource: processSource
        )
    }

    /// The companion server carrying this runtime, so its wait routes are
    /// served instead of answering `no_route`.
    public func makeServer() -> NativeCompanionServer {
        NativeCompanionServer(database: database, nativeRuntime: runtime)
    }
}
