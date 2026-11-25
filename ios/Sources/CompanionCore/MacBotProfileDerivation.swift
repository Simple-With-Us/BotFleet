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
        let threadId = (record.threadId ?? bot.threadId)
            .trimmingCharacters(in: .whitespacesAndNewlines)
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
/// it does from a terminal — so they resolve as available with an empty
/// explicit environment (the Mac supervisor already inherits the app's
/// environment).  Engines that authenticate with an Infisical secret have
/// no interactive credential source here and stay unavailable, so their
/// waits remain admission-held instead of dispatching without credentials.
public final class DatabaseCliLoginCredentials: NativeServiceCredentialSource, @unchecked Sendable {
    private let database: DatabaseService
    private let cache = CliLoginCredentialCache()

    public init(database: DatabaseService) {
        self.database = database
    }

    public func credentials(forBotId botId: String) async throws -> NativeServiceCredentialResult {
        let engine = try await cache.engine(forBotId: botId, load: {
            guard let record = try await database.loadBots().first(where: { $0.id == botId }) else {
                return nil
            }
            return MacBotProfileDerivation.derive(from: record)?.engine
        })
        guard let engine else { return .unavailable }
        if case .cliManagedLogin = EngineMatrixRegistry.descriptor(for: engine).authRequirement {
            return .available(environment: [:])
        }
        return .unavailable
    }
}

/// Registered-engine lookup with the same lazy TTL shape as the workspace
/// source's bot-id cache: the bot table has no change signal, so a fresh
/// hit never touches the database and a miss reloads it once.
private actor CliLoginCredentialCache {
    private var cachedEngine: [String: EngineMatrixID?] = [:]
    private var loadedAt: Date?
    private let ttl: TimeInterval = 30

    func engine(forBotId botId: String, load: @Sendable () async throws -> EngineMatrixID?) async throws -> EngineMatrixID? {
        if let loadedAt, Date().timeIntervalSince(loadedAt) < ttl,
           let cached = cachedEngine[botId] {
            return cached
        }
        let loaded = try await load()
        cachedEngine[botId] = loaded
        loadedAt = Date()
        return loaded
    }
}
