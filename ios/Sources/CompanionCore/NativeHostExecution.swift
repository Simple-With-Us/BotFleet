import Foundation

/// A capability hold is unclaimed work, rather than an uncertain provider outcome.
public enum NativeWorkHoldReason: String, Codable, Equatable, Sendable {
    case waitingForLogin
    case credentialsUnavailable
}

public enum NativeExecutionAdmission: Sendable {
    case ready(TurnInput)
    case held(NativeWorkHoldReason)
}

/// Resolvers must return only service-owned execution context and recheck their own lifecycle after awaits.
public protocol NativeExecutionContextSource: Sendable {
    func resolve(wait: NativeEventWait) async throws -> NativeExecutionAdmission
}

public enum NativeServiceCredentialResult: Sendable {
    case unavailable
    case available(environment: [String: String])
}

public protocol NativeServiceCredentialSource: Sendable {
    func credentials(forBotId botId: String) async throws -> NativeServiceCredentialResult
}

/// Service credential provisioning is separate from the interactive app's login Keychain.
public struct UnavailableNativeServiceCredentials: NativeServiceCredentialSource {
    public init() {}
    public func credentials(forBotId botId: String) async throws -> NativeServiceCredentialResult { .unavailable }
}

public struct NativeHostBotConfiguration: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let threadId: String
    public let claudeExecutable: String
    public let modelId: String?
    public let requiresDesktop: Bool

    public init(id: String, name: String, threadId: String, claudeExecutable: String,
                modelId: String? = nil, requiresDesktop: Bool = false) {
        self.id = id; self.name = name; self.threadId = threadId
        self.claudeExecutable = claudeExecutable; self.modelId = modelId; self.requiresDesktop = requiresDesktop
    }
}

#if os(macOS)
import Darwin

enum NativeServiceTaskContext {
    @TaskLocal static var credentialOwner: UUID?
}

/// App-owned workspaces and capabilities need no NSWorkspace or desktop permission.
actor NativeHostExecutionContext: NativeExecutionContextSource, NativeEventWaitWorkspaceSource {
    nonisolated let ownerID = UUID()
    private let paths: NativeServicePaths
    private let credentials: any NativeServiceCredentialSource
    private var bots: [String: NativeHostBotConfiguration] = [:]
    private var generation: UInt64 = 0
    private var stopped = false

    init(paths: NativeServicePaths, credentials: any NativeServiceCredentialSource) {
        self.paths = paths; self.credentials = credentials
    }

    func register(_ bot: NativeHostBotConfiguration) throws {
        guard !stopped else { throw NativeRuntimeServicesError.stopped }
        guard Self.safeComponent(bot.id), !bot.threadId.isEmpty,
              bot.claudeExecutable.hasPrefix("/"), !bot.claudeExecutable.contains("\0") else {
            throw NativeHeadlessHostError.invalidBotConfiguration
        }
        _ = try paths.prepareWorkspace(botId: bot.id)
        bots[bot.id] = bot
        generation &+= 1
    }

    func workspaceRoot(forRegisteredBotId botId: String) async throws -> URL? {
        guard !stopped, bots[botId] != nil else { return nil }
        return try paths.prepareWorkspace(botId: botId)
    }

    func resolve(wait: NativeEventWait) async throws -> NativeExecutionAdmission {
        guard !stopped else { throw NativeRuntimeServicesError.stopped }
        guard let bot = bots[wait.botId], bot.threadId == wait.threadId, let prompt = wait.prompt else {
            throw NativeHeadlessHostError.invalidBotConfiguration
        }
        // This slice has no attachment grant API, so desktop work always waits.
        guard !bot.requiresDesktop else { return .held(.waitingForLogin) }
        let revision = generation
        let result: NativeServiceCredentialResult
        do {
            result = try await NativeServiceTaskContext.$credentialOwner.withValue(ownerID) {
                try await credentials.credentials(forBotId: bot.id)
            }
        } catch {
            guard !stopped, revision == generation else { throw NativeRuntimeServicesError.stopped }
            return .held(.credentialsUnavailable)
        }
        guard !stopped, revision == generation else { throw NativeRuntimeServicesError.stopped }
        guard case .available(let environment) = result else { return .held(.credentialsUnavailable) }
        guard environment.allSatisfy({ key, value in
            key.range(of: #"^[A-Za-z_][A-Za-z0-9_]*$"#, options: .regularExpression) != nil && !value.contains("\0")
        }) else { return .held(.credentialsUnavailable) }
        let workspace = try paths.prepareWorkspace(botId: bot.id)
        // The supervisor has an empty inherited environment; only this explicit service context reaches the child.
        var childEnvironment = environment
        childEnvironment["HOME"] = paths.home.path
        childEnvironment["PATH"] = "/usr/bin:/bin"
        childEnvironment["TMPDIR"] = paths.temporary.path
        return .ready(TurnInput(threadId: bot.threadId, botId: bot.id, prompt: prompt,
                                modelId: bot.modelId, workingDirectory: workspace.path,
                                environment: childEnvironment))
    }

    func stop() { stopped = true; generation &+= 1 }

    private static func safeComponent(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 128 && value.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil
    }
}

/// The launch ledger contains only sessions this host launched, and never infers ownership from a PID probe.
actor NativeHostProcessLedger: EngineProcessLauncher, NativeEventWaitProcessOwnershipSource {
    private let supervisor: ProcessSupervisorActor
    private let database: DatabaseService
    private struct Record { let botId: String; let startTime: Double; var finished: Bool }
    private var records: [Int32: Record] = [:]
    private var stopped = false

    init(supervisor: ProcessSupervisorActor, database: DatabaseService) {
        self.supervisor = supervisor; self.database = database
    }

    func launch(spec: EngineSpawnSpec, threadId: String, engineId: String) async throws -> EngineProcessSession {
        guard !stopped, let thread = try await database.loadThread(id: threadId), let botId = thread.botId else {
            throw NativeRuntimeServicesError.stopped
        }
        guard !stopped else { throw NativeRuntimeServicesError.stopped }
        let session = try await supervisor.launch(spec: spec, threadId: threadId, engineId: engineId)
        guard !stopped else { await session.cancel(); throw NativeRuntimeServicesError.stopped }
        if let identity = Self.startTime(pid: session.pid) {
            if records.count >= 4096, let old = records.first(where: { $0.value.finished })?.key { records.removeValue(forKey: old) }
            records[session.pid] = Record(botId: botId, startTime: identity, finished: false)
            Task {
                _ = await session.waitForExit()
                self.markFinished(pid: session.pid, identity: identity)
            }
        }
        return session
    }

    func hasFinishedProcess(pid: Int32, startTime: Double, ownedByBotId botId: String) async -> Bool {
        guard let record = records[pid] else { return false }
        return record.botId == botId && record.startTime == startTime && record.finished
    }

    func stop() { stopped = true }
    private func markFinished(pid: Int32, identity: Double) {
        guard records[pid]?.startTime == identity else { return }
        records[pid]?.finished = true
    }

    private static func startTime(pid: Int32) -> Double? {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
        let stamp = info.kp_proc.p_starttime
        let time = Double(stamp.tv_sec) + Double(stamp.tv_usec) / 1_000_000
        return time > 0 ? time : nil
    }
}
#endif
