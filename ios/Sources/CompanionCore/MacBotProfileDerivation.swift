import Foundation

/// A stored bot's derived native execution profile and the matrix engine
/// that runs it (`BF-2689`).
public struct DerivedMacBot: Equatable, Sendable {
    public let profile: MacBotExecutionProfile
    public let engine: EngineMatrixID

    public init(profile: MacBotExecutionProfile, engine: EngineMatrixID) {
        self.profile = profile
        self.engine = engine
    }
}

/// One stored bot that registration skipped, with the reason.
public struct MacBotRegistrationSkip: Equatable, Sendable {
    public let botId: String
    public let reason: String

    public init(botId: String, reason: String) {
        self.botId = botId
        self.reason = reason
    }
}

/// Outcome of registering every stored bot on the Mac runtime (`BF-2689`).
public struct MacBotRegistrationReport: Equatable, Sendable {
    public var registered: [String] = []
    public var skipped: [MacBotRegistrationSkip] = []
    /// Why the bot table itself could not be loaded, when it could not:
    /// distinct from per-bot skips so a startup storage failure is never
    /// reported as a clean run that simply registered nothing.
    public var loadFailure: String?

    public init() {}
}

/// Derives native execution profiles for interactive Mac bots from the
/// listener's own bot table (`BF-2689`).
///
/// Mac bots arrive as Node-era records: `StoredBotRecord.rawJSON` is the
/// full bot record, whose `modelSelection` names the engine instance and
/// the model.  Only instances with a native Swift driver derive a profile;
/// every other bot stays admission-held, which is the honest state for an
/// engine this app cannot run yet.
public enum MacBotProfileDerivation {
    /// Harness instance id → native matrix engine.  Instances absent here
    /// have no native driver and derive nothing.
    public static func matrixEngine(forInstanceId instanceId: String) -> EngineMatrixID? {
        switch instanceId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "antigravity": return .antigravity
        case "claude": return .claude
        case "codex": return .codex
        case "grok": return .grokAcp
        case "mcode": return .mcode
        case "muse": return .muse
        default: return nil
        }
    }

    /// The execution profile for one stored bot, or nil when the record
    /// cannot be decoded, names no thread, or runs on an engine with no
    /// native driver.  An empty saved model derives nil so the driver
    /// factory's registration path substitutes the matrix default.
    public static func derive(from record: StoredBotRecord) -> DerivedMacBot? {
        guard let data = record.rawJSON.data(using: .utf8),
              let bot = try? JSONDecoder().decode(Bot.self, from: data) else {
            return nil
        }
        guard let engine = matrixEngine(forInstanceId: bot.modelSelection.instanceId) else {
            return nil
        }
        // A blank record thread counts as absent, like a missing one: the
        // bot JSON thread is the fallback, not an empty string.
        let recordThread = record.threadId?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let botThread = bot.threadId.trimmingCharacters(in: .whitespacesAndNewlines)
        let threadId = recordThread.isEmpty ? botThread : recordThread
        guard !threadId.isEmpty else { return nil }
        let model = bot.modelSelection.model.trimmingCharacters(in: .whitespacesAndNewlines)
        return DerivedMacBot(
            profile: MacBotExecutionProfile(
                id: record.id,
                threadId: threadId,
                engineId: engine.rawValue,
                modelId: model.isEmpty ? nil : model
            ),
            engine: engine
        )
    }
}

/// The interactive app's credential boundary (`BF-2689`): engines whose
/// matrix row authenticates through their own CLI login need no secret
/// from this app — the launched CLI reads its own login state, exactly as
/// it does from a terminal — so they resolve as available with the minimal
/// explicit environment (HOME, PATH, TMPDIR) the CLI needs to find that
/// login.  A CLI that is logged out fails its own turn honestly at spawn;
/// this boundary does not invent a login probe the thirteen CLIs share no
/// shape for.  Engines that authenticate with an Infisical secret have
/// no interactive credential source here and stay unavailable, so their
/// waits remain admission-held instead of dispatching without credentials.
public final class DatabaseCliLoginCredentials: NativeServiceCredentialSource, @unchecked Sendable {
    private let database: DatabaseService
    private let cache = CliLoginCredentialCache()

    public init(database: DatabaseService) {
        self.database = database
    }

    public func credentials(forBotId botId: String) async throws -> NativeServiceCredentialResult {
        let engines = try await cache.engines(load: {
            var map: [String: EngineMatrixID] = [:]
            for record in try await database.loadBots() {
                if let derived = MacBotProfileDerivation.derive(from: record) {
                    map[record.id] = derived.engine
                }
            }
            return map
        })
        guard let engine = engines[botId] else { return .unavailable }
        if case .cliManagedLogin = EngineMatrixRegistry.descriptor(for: engine).authRequirement {
            return .available(environment: Self.minimalEnvironment())
        }
        return .unavailable
    }

    /// The only variables a CLI-login child is explicitly given: its login
    /// state lives under HOME, its binary resolves through PATH, and its
    /// scratch space is TMPDIR.  Anything else in the app process
    /// environment reaches the child only through the supervisor overlay
    /// the runners already strip credential keys from; naming the set here
    /// keeps this boundary from silently widening.
    static func minimalEnvironment(
        from processEnvironment: [String: String] = ProcessInfo.processInfo.environment
    ) -> [String: String] {
        var environment: [String: String] = [:]
        for key in ["HOME", "PATH", "TMPDIR"] {
            if let value = processEnvironment[key], !value.isEmpty {
                environment[key] = value
            }
        }
        return environment
    }
}

/// Registered-engine map with the same lazy TTL shape as the workspace
/// source's bot-id cache: the bot table has no change signal, so one load
/// serves every bot until the entry expires, and a miss after expiry
/// reloads the table once rather than scanning per bot.
private actor CliLoginCredentialCache {
    private var cachedEngines: [String: EngineMatrixID]?
    private var loadedAt: Date?
    private let ttl: TimeInterval = 30

    func engines(load: @Sendable () async throws -> [String: EngineMatrixID]) async throws -> [String: EngineMatrixID] {
        if let cachedEngines, let loadedAt, Date().timeIntervalSince(loadedAt) < ttl {
            return cachedEngines
        }
        let loaded = try await load()
        cachedEngines = loaded
        loadedAt = Date()
        return loaded
    }
}
