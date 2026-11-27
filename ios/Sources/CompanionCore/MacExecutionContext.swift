import Foundation

/// Errors emitted when registering interactive Mac bot execution profiles.
public enum MacExecutionContextError: LocalizedError, Equatable, Sendable {
    case invalidProfile(String)
    case externalExecutionContextActive

    public var errorDescription: String? {
        switch self {
        case .invalidProfile(let detail):
            return "Invalid Mac execution profile: \(detail)"
        case .externalExecutionContextActive:
            return "Cannot register interactive Mac bot profile while a custom NativeExecutionContextSource overrides MacExecutionContext."
        }
    }
}

/// Interactive Mac bot configuration resolved by `MacExecutionContext` (`BF-2689`).
public struct MacBotExecutionProfile: Codable, Equatable, Sendable {
    public let id: String
    public let threadId: String
    public let engineId: String
    public let modelId: String?

    public init(
        id: String,
        threadId: String,
        engineId: String,
        modelId: String? = nil
    ) {
        self.id = id
        self.threadId = threadId
        self.engineId = engineId
        self.modelId = modelId
    }
}

/// Production `NativeExecutionContextSource` for the interactive Mac app (`BF-2689`),
/// replacing `UnavailableMacExecutionContext`.
///
/// Fails closed with `.held(.credentialsUnavailable)` whenever no profile is registered
/// for the bot, credentials are unavailable or malformed, or no confined workspace resolves.
public actor MacExecutionContext: NativeExecutionContextSource {
    private let workspaceSource: any NativeEventWaitWorkspaceSource
    private let credentials: any NativeServiceCredentialSource
    private var profiles: [String: MacBotExecutionProfile] = [:]
    private var generation: UInt64 = 0
    private var stopped = false

    public init(
        workspaceSource: any NativeEventWaitWorkspaceSource,
        credentials: any NativeServiceCredentialSource = UnavailableNativeServiceCredentials()
    ) {
        self.workspaceSource = workspaceSource
        self.credentials = credentials
    }

    /// Registers or replaces the execution profile for a bot.
    public func register(_ profile: MacBotExecutionProfile) async throws {
        guard !stopped else { throw NativeRuntimeServicesError.stopped }
        guard Self.safeBotId(profile.id),
              !profile.threadId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !profile.engineId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw MacExecutionContextError.invalidProfile("botId, threadId, and engineId must be valid.")
        }
        profiles[profile.id] = profile
        generation &+= 1
        if let cliCredentials = credentials as? DatabaseCliLoginCredentials {
            await cliCredentials.invalidateCache()
        }
    }

    /// Removes a bot's execution profile so future waits remain admission-held,
    /// and invalidates cached CLI credentials for deleted or rolled-back bots.
    public func unregister(botId: String) async {
        profiles.removeValue(forKey: botId)
        generation &+= 1
        await invalidateCredentialsCache()
    }

    /// Invalidates cached CLI credentials (for example right after persistence).
    public func invalidateCredentialsCache() async {
        if let cliCredentials = credentials as? DatabaseCliLoginCredentials {
            await cliCredentials.invalidateCache()
        }
    }

    /// Returns the registered execution profile for `botId`, if present.
    public func registeredProfile(forBotId botId: String) -> MacBotExecutionProfile? {
        profiles[botId]
    }

    /// Terminally stops admission for this execution context.
    public func stop() {
        stopped = true
        generation &+= 1
    }

    public func resolve(wait: NativeEventWait) async throws -> NativeExecutionAdmission {
        guard let threadId = wait.threadId, let prompt = wait.prompt else {
            guard !stopped else { throw NativeRuntimeServicesError.stopped }
            return .held(.credentialsUnavailable)
        }
        return try await resolveTurn(botId: wait.botId, threadId: threadId, prompt: prompt)
    }

    /// Resolves one turn for a registered bot on its registered thread, the
    /// same admission a satisfied wait gets.  The desktop chat sends through
    /// here (`BF-2705`), so a chat message and a wait follow-up are prepared
    /// by one rule set: same profile, credentials and confined workspace.
    public func resolveTurn(botId: String, threadId: String, prompt: String) async throws -> NativeExecutionAdmission {
        guard !stopped else { throw NativeRuntimeServicesError.stopped }
        guard let profile = profiles[botId],
              profile.threadId == threadId,
              !prompt.isEmpty else {
            return .held(.credentialsUnavailable)
        }
        let revision = generation
        let result: NativeServiceCredentialResult
        do {
            result = try await credentials.credentials(forBotId: profile.id)
        } catch {
            if stopped { throw NativeRuntimeServicesError.stopped }
            return .held(.credentialsUnavailable)
        }
        if stopped { throw NativeRuntimeServicesError.stopped }
        guard revision == generation else {
            return .held(.credentialsUnavailable)
        }
        guard case .available(let environment) = result else {
            return .held(.credentialsUnavailable)
        }
        guard environment.allSatisfy({ key, value in
            key.range(of: #"^[A-Za-z_][A-Za-z0-9_]*$"#, options: .regularExpression) != nil && !value.contains("\0")
        }) else {
            return .held(.credentialsUnavailable)
        }
        let workspace: URL?
        do {
            workspace = try await workspaceSource.workspaceRoot(forRegisteredBotId: profile.id)
        } catch {
            if stopped { throw NativeRuntimeServicesError.stopped }
            return .held(.credentialsUnavailable)
        }
        if stopped { throw NativeRuntimeServicesError.stopped }
        guard revision == generation, let workspace else {
            return .held(.credentialsUnavailable)
        }
        return .ready(
            TurnInput(
                threadId: profile.threadId,
                botId: profile.id,
                prompt: prompt,
                modelId: profile.modelId,
                workingDirectory: workspace.path,
                environment: environment
            )
        )
    }

    private static func safeBotId(_ value: String) -> Bool {
        !value.isEmpty &&
            value.utf8.count <= 128 &&
            value.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil
    }
}
