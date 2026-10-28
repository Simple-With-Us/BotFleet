import Foundation
import Security

/// Redacted wrapper for secret material in memory.  String conversion always yields
/// `[REDACTED]` so string interpolation, `os_log`, and crash dumps never leak keys.
public struct RedactedSecret: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    private let rawValue: String

    public init(_ rawValue: String) {
        self.rawValue = rawValue
    }

    /// Deliberately named so call sites acknowledge they are unwrapping secret material.
    public func exposeSecret() -> String {
        rawValue
    }

    public var isEmpty: Bool {
        rawValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public var description: String { "[REDACTED]" }
    public var debugDescription: String { "[REDACTED]" }
}

/// Machine-identity credentials for Infisical Universal Auth stored in the macOS Keychain.
/// Custom string descriptions are redacted to prevent accidental logging.
public struct InfisicalMachineIdentity: Codable, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let clientId: String
    public let clientSecret: String
    public let projectId: String
    public let environment: String
    public let siteUrl: String
    public let secretPath: String

    public init(
        clientId: String,
        clientSecret: String,
        projectId: String,
        environment: String = "prod",
        siteUrl: String = "https://app.infisical.com",
        secretPath: String = "/"
    ) {
        self.clientId = clientId
        self.clientSecret = clientSecret
        self.projectId = projectId
        self.environment = environment
        self.siteUrl = siteUrl
        self.secretPath = secretPath
    }

    public var isValid: Bool {
        !clientId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !clientSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !projectId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !environment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public var description: String { "[REDACTED]" }
    public var debugDescription: String { "[REDACTED]" }
}

/// Three-way Keychain read status mirroring `electron/secure-credentials.mjs`.
///
/// `empty` and `ok` are facts about what is stored.  `unavailable` is ignorance
/// (a locked or busy Keychain, or undecodable bytes) and must never be treated as
/// `empty`, or the app acts as though no machine identity was ever configured.
public enum InfisicalKeychainReadStatus: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    case empty
    case ok(InfisicalMachineIdentity)
    case unavailable(status: OSStatus, message: String)

    public var description: String {
        switch self {
        case .empty:
            return "InfisicalKeychainReadStatus.empty"
        case .ok:
            return "InfisicalKeychainReadStatus.ok([REDACTED])"
        case .unavailable(let status, let message):
            return "InfisicalKeychainReadStatus.unavailable(status: \(status), message: \(message))"
        }
    }

    public var debugDescription: String { description }
}

/// A read-only Infisical service token.
///
/// A service token is the credential the fleet moved to: it authenticates a
/// request by itself, with no login step and no machine identity.  The value
/// never appears in a description, a log line or an error message.
public struct InfisicalServiceToken: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    /// Every service token starts with this prefix.
    public static let prefix = "st."
    /// The shortest service token this resolver accepts, prefix included.
    public static let minimumLength = 20
    /// The longest service token this resolver accepts, prefix included.
    public static let maximumLength = 2048

    private let rawValue: String

    public init(_ rawValue: String) {
        self.rawValue = rawValue
    }

    /// Whether a value is an Infisical service token.
    ///
    /// This mirrors `validateServiceToken()` in `electron/infisical-read.mjs`:
    /// the value starts with `st.`, is between 20 and 2048 characters long and
    /// carries no whitespace.  A value that fails the test is refused, so a
    /// truncated or mistyped credential never reaches the vault.
    public static func isValid(_ value: String) -> Bool {
        let token = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard token.hasPrefix(prefix) else { return false }
        let length = token.count
        guard length >= minimumLength, length <= maximumLength else { return false }
        return !token.unicodeScalars.contains { $0.properties.isWhitespace }
    }

    /// Whether this token is usable.
    public var isValid: Bool { InfisicalServiceToken.isValid(rawValue) }

    /// Deliberately named so call sites acknowledge they are unwrapping secret material.
    public func exposeSecret() -> String {
        rawValue
    }

    public var description: String { "[REDACTED]" }
    public var debugDescription: String { "[REDACTED]" }
}

/// Four-way Keychain read status for the Infisical service token.
///
/// `empty`, `ok` and `invalid` are facts about what is stored.  `unavailable`
/// is ignorance (a locked or busy Keychain, or bytes that could not be read)
/// and must never be treated as `empty`, or the app acts as though no
/// credential was ever configured.
public enum InfisicalServiceTokenReadStatus: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    /// Nothing is stored under the service-token item.
    case empty
    /// A well-formed service token is stored.
    case ok(InfisicalServiceToken)
    /// Something is stored, but it is not a usable service token.  It is
    /// refused, never used.
    case invalid
    /// The credential store could not be read.
    case unavailable(status: OSStatus, message: String)

    public var description: String {
        switch self {
        case .empty:
            return "InfisicalServiceTokenReadStatus.empty"
        case .ok:
            return "InfisicalServiceTokenReadStatus.ok([REDACTED])"
        case .invalid:
            return "InfisicalServiceTokenReadStatus.invalid"
        case .unavailable(let status, let message):
            return "InfisicalServiceTokenReadStatus.unavailable(status: \(status), message: \(message))"
        }
    }

    public var debugDescription: String { description }
}

/// The part of the vault a read is scoped to: the site, the project, the
/// environment and the path inside the project.
///
/// The scope is explicit and configurable because a service token carries no
/// scope of its own: the token says WHO may read, the scope says WHAT is read.
public struct InfisicalVaultScope: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let siteUrl: String
    public let projectId: String
    public let environment: String
    public let secretPath: String

    /// The BotFleet project, the prod environment and the path the server's
    /// own secrets live under.  It is the scope `electron/infisical-read.mjs`
    /// reads.
    public static let botFleetServer = InfisicalVaultScope(
        siteUrl: "https://app.infisical.com",
        projectId: "836aebe2-c8f7-4e09-978e-7e3e82500bce",
        environment: "prod",
        secretPath: "/botfleet-server"
    )

    public init(siteUrl: String, projectId: String, environment: String, secretPath: String) {
        self.siteUrl = siteUrl
        self.projectId = projectId
        self.environment = environment
        self.secretPath = secretPath
    }

    public var description: String {
        "Infisical scope (environment: \(environment), path: \(secretPath))"
    }

    public var debugDescription: String { description }
}

/// Errors thrown by `NativeInfisicalResolver`.  Error descriptions never echo
/// upstream response bodies or raw secret material.
public enum InfisicalResolverError: LocalizedError, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    /// No usable vault credential is available: the Keychain holds neither a
    /// read-only service token nor a valid machine identity.
    ///
    /// The name is the original one and is kept because the direct LLM client
    /// maps it; the message names both credentials that can open the vault.
    case missingMachineIdentity
    case keychainUnavailable(status: OSStatus, message: String)
    case keychainWriteFailed(status: OSStatus)
    /// The stored credential is not a service token.  The value never appears
    /// in the message.
    case invalidServiceToken
    case loginFailed(statusCode: Int)
    case invalidLoginResponse
    case secretsFetchFailed(statusCode: Int)
    case invalidSecretsResponse
    case secretNotFound(key: String)
    case transportFailure(operation: String)

    public var errorDescription: String? {
        switch self {
        case .missingMachineIdentity:
            return "No Infisical credential is available: the macOS Keychain holds neither a read-only service token nor a valid machine identity."
        case .keychainUnavailable(let status, let message):
            return "macOS Keychain is unavailable (OSStatus \(status)): \(message)"
        case .keychainWriteFailed(let status):
            return "macOS Keychain write failed (OSStatus \(status))."
        case .invalidServiceToken:
            return "The stored Infisical credential is not a service token.  Store a read-only service token (st. ...) in the Keychain."
        case .loginFailed(let statusCode):
            return "Infisical login failed: HTTP \(statusCode)"
        case .invalidLoginResponse:
            return "Infisical login response carried no accessToken"
        case .secretsFetchFailed(let statusCode):
            return "Infisical secrets list failed: HTTP \(statusCode)"
        case .invalidSecretsResponse:
            return "Infisical secrets list response carried no secrets array"
        case .secretNotFound(let key):
            return "Required secret '\(key)' is missing or empty in Infisical."
        case .transportFailure(let operation):
            return "Infisical \(operation) failed: network error"
        }
    }

    public var description: String {
        errorDescription ?? "InfisicalResolverError"
    }

    public var debugDescription: String {
        description
    }
}

/// Raw result of a single Keychain lookup attempt before retry classification.
public enum KeychainRawQueryResult: Equatable, Sendable {
    case itemData(Data)
    case itemNotFound
    case statusError(OSStatus)
}

/// Protocol abstracting macOS Keychain calls so unit tests can deterministically
/// simulate `errSecNotAvailable` / `errSecInteractionNotAllowed` busy states.
public protocol InfisicalKeychainStoreProtocol: Sendable {
    var serviceName: String { get }
    var accountName: String { get }
    func queryRaw() -> KeychainRawQueryResult
    func saveRaw(_ data: Data) throws
    func deleteRaw() throws
}

/// Production macOS Keychain store using `SecItemCopyMatching`, `SecItemAdd`,
/// `SecItemUpdate`, and `SecItemDelete` under service `app.botfleet.macos.infisical`.
public struct MacKeychainInfisicalStore: InfisicalKeychainStoreProtocol {
    public static let defaultService = "app.botfleet.macos.infisical"
    public static let defaultAccount = "machine-identity"

    /// The Keychain item the read-only Infisical service token lives in.
    ///
    /// It is the same item the Electron main process reads, so the token is
    /// stored once on this Mac and both halves of the app read the same copy.
    /// It is `KEYCHAIN_SERVICE` in `electron/server-target.mjs`.
    public static let serviceTokenService = "BotFleet Infisical read token"

    /// The account of that Keychain item.  It is `KEYCHAIN_ACCOUNT` in
    /// `electron/server-target.mjs`.
    public static let serviceTokenAccount = "botfleet"

    public let serviceName: String
    public let accountName: String

    public init(
        serviceName: String = MacKeychainInfisicalStore.defaultService,
        accountName: String = MacKeychainInfisicalStore.defaultAccount
    ) {
        self.serviceName = serviceName
        self.accountName = accountName
    }

    public func queryRaw() -> KeychainRawQueryResult {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: accountName,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return .itemNotFound
        }
        guard status == errSecSuccess else {
            return .statusError(status)
        }
        guard let data = item as? Data else {
            return .statusError(errSecDecode)
        }
        return .itemData(data)
    }

    public func saveRaw(_ data: Data) throws {
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: accountName,
        ]
        let attributesToUpdate: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, attributesToUpdate as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }
        if updateStatus == errSecItemNotFound {
            var addQuery = baseQuery
            for (k, v) in attributesToUpdate {
                addQuery[k] = v
            }
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw InfisicalResolverError.keychainWriteFailed(status: addStatus)
            }
            return
        }
        throw InfisicalResolverError.keychainWriteFailed(status: updateStatus)
    }

    public func deleteRaw() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: accountName,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw InfisicalResolverError.keychainWriteFailed(status: status)
        }
    }
}

/// HTTP transport abstraction for `NativeInfisicalResolver` so tests can verify
/// fail-closed behavior and exact wire requests without live network calls.
public protocol InfisicalHTTPTransportProtocol: Sendable {
    func execute(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

/// Default `URLSession` transport with ephemeral configuration (no disk cache or cookies).
public struct URLSessionInfisicalTransport: InfisicalHTTPTransportProtocol {
    private let session: URLSession

    public init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.urlCache = nil
            config.httpCookieAcceptPolicy = .never
            config.httpShouldSetCookies = false
            config.timeoutIntervalForRequest = 30
            self.session = URLSession(configuration: config)
        }
    }

    public func execute(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw InfisicalResolverError.transportFailure(operation: "http")
        }
        return (data, http)
    }
}

/// In-memory-only Infisical secret resolver with Keychain credential storage.
///
/// Two credentials can open the vault and the service token wins.  A read-only
/// Infisical service token is the credential the fleet moved to: it is the
/// bearer token itself, so the service-token path sends NO Universal Auth
/// login request at all.  The machine identity is the fallback for an install
/// that has not been provisioned with a token yet.
///
/// Security invariants:
/// 1. The service token lives in the macOS Keychain under the same item the
///    Electron main process reads (`BotFleet Infisical read token` /
///    `botfleet`), and the machine identity under `app.botfleet.macos.infisical`.
/// 2. Keychain reads distinguish `.empty`, `.ok`, `.invalid` and `.unavailable`,
///    retrying busy keychain errors across `[100, 200, 400, 800]` ms before
///    reporting `.unavailable`.
/// 3. Resolved secrets live exclusively in actor-isolated memory with a TTL and are
///    never persisted to SQLite, `UserDefaults`, disk files, or log lines.
/// 4. Fails closed before opening any network request if no credential is
///    available, if the stored token is not a service token, or if the
///    credential store cannot be read.
public actor NativeInfisicalResolver: CustomStringConvertible, CustomDebugStringConvertible {
    /// Retry schedule matching `CREDENTIAL_READ_DELAYS_MS` in `electron/secure-credentials.mjs`.
    public static let credentialReadDelaysMs: [UInt64] = [100, 200, 400, 800]

    private struct CachedSecretEntry: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
        let secret: RedactedSecret
        let expiresAt: Date

        var description: String { "[REDACTED]" }
        var debugDescription: String { "[REDACTED]" }
    }

    private struct CachedBearerToken: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
        let token: RedactedSecret
        let expiresAt: Date

        var description: String { "[REDACTED]" }
        var debugDescription: String { "[REDACTED]" }
    }

    private struct CachedServiceToken: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
        let token: InfisicalServiceToken
        let expiresAt: Date

        var description: String { "[REDACTED]" }
        var debugDescription: String { "[REDACTED]" }
    }

    private let keychain: InfisicalKeychainStoreProtocol
    private let serviceTokenStore: InfisicalKeychainStoreProtocol?
    private let scope: InfisicalVaultScope
    private let transport: InfisicalHTTPTransportProtocol
    private let ttlSeconds: TimeInterval
    private let now: @Sendable () -> Date
    private let sleepMs: @Sendable (UInt64) async -> Void

    private var secretCache: [String: CachedSecretEntry] = [:]
    private var cachedBearer: CachedBearerToken?
    private var cachedServiceToken: CachedServiceToken?

    /// - Parameters:
    ///   - keychain: Where the machine identity lives.
    ///   - serviceTokenStore: Where the read-only service token lives.  `nil`
    ///     means the production Keychain item the Electron main process reads,
    ///     but only when `keychain` is the production machine-identity item as
    ///     well.  A caller that hands the resolver its own credential store has
    ///     taken over the resolver's credentials, so the resolver then uses
    ///     only the stores it was given and never reaches into the operator's
    ///     login Keychain behind the caller's back.  That is what keeps every
    ///     unit test deterministic on any machine.
    ///   - scope: The site, project, environment and path a service-token read
    ///     is scoped to.  A service token carries no scope of its own.
    ///   - transport: How requests leave the process.
    ///   - ttlSeconds: How long a resolved secret or a bearer stays in memory.
    ///   - now: The clock, injectable for tests.
    ///   - sleepMs: The backoff sleep, injectable for tests.
    public init(
        keychain: InfisicalKeychainStoreProtocol = MacKeychainInfisicalStore(),
        serviceTokenStore: InfisicalKeychainStoreProtocol? = nil,
        scope: InfisicalVaultScope = .botFleetServer,
        transport: InfisicalHTTPTransportProtocol = URLSessionInfisicalTransport(),
        ttlSeconds: TimeInterval = 300,
        now: @escaping @Sendable () -> Date = { Date() },
        sleepMs: @escaping @Sendable (UInt64) async -> Void = { ms in
            try? await Task.sleep(nanoseconds: ms * 1_000_000)
        }
    ) {
        self.keychain = keychain
        self.serviceTokenStore = serviceTokenStore ?? NativeInfisicalResolver.productionServiceTokenStore(for: keychain)
        self.scope = scope
        self.transport = transport
        self.ttlSeconds = ttlSeconds
        self.now = now
        self.sleepMs = sleepMs
    }

    /// The service-token store the resolver falls back to when the caller did
    /// not hand it one.
    ///
    /// The production store reads the login Keychain item the Electron main
    /// process reads, so the token is stored once on this Mac and both halves
    /// of the app read the same copy.  A caller that supplies its own
    /// machine-identity store owns the resolver's credentials, so the resolver
    /// does not silently reach for the operator's login Keychain.
    private static func productionServiceTokenStore(
        for keychain: InfisicalKeychainStoreProtocol
    ) -> InfisicalKeychainStoreProtocol? {
        guard keychain.serviceName == MacKeychainInfisicalStore.defaultService,
              keychain.accountName == MacKeychainInfisicalStore.defaultAccount else {
            return nil
        }
        return MacKeychainInfisicalStore(
            serviceName: MacKeychainInfisicalStore.serviceTokenService,
            accountName: MacKeychainInfisicalStore.serviceTokenAccount
        )
    }

    public nonisolated var description: String {
        "NativeInfisicalResolver(secrets: [REDACTED])"
    }

    public nonisolated var debugDescription: String {
        description
    }

    // MARK: - Keychain Machine Identity Lifecycle

    /// Reads the machine identity from Keychain with `[100, 200, 400, 800]` ms backoff
    /// when the OS credential store is temporarily busy or locked.
    public func readMachineIdentity(
        delaysMs: [UInt64] = NativeInfisicalResolver.credentialReadDelaysMs
    ) async -> InfisicalKeychainReadStatus {
        var lastStatus: OSStatus = errSecNotAvailable
        var lastMessage = "the operating-system credential store is unavailable"

        for attempt in 0...delaysMs.count {
            if attempt > 0 {
                await sleepMs(delaysMs[attempt - 1])
            }
            switch keychain.queryRaw() {
            case .itemNotFound:
                return .empty
            case .itemData(let data):
                do {
                    let identity = try JSONDecoder().decode(InfisicalMachineIdentity.self, from: data)
                    guard identity.isValid else {
                        return .empty
                    }
                    return .ok(identity)
                } catch {
                    // Corrupt JSON is not a timing problem; report immediately as unavailable
                    // rather than retrying or mistaking it for empty.
                    return .unavailable(status: errSecDecode, message: "the credential store is not readable")
                }
            case .statusError(let status):
                lastStatus = status
                lastMessage = "the operating-system credential store is unavailable (OSStatus \(status))"
                if status == errSecDecode {
                    return .unavailable(status: status, message: "the credential store is not readable")
                }
            }
        }
        return .unavailable(status: lastStatus, message: lastMessage)
    }

    /// Reads the Infisical service token from the Keychain with
    /// `[100, 200, 400, 800]` ms backoff when the OS credential store is
    /// temporarily busy or locked.
    ///
    /// A stored value that is not a service token is refused: the store holds
    /// something, so the read is `.invalid` and never `.empty`, and the caller
    /// must not treat it as "no credential was ever configured".
    public func readServiceToken(
        delaysMs: [UInt64] = NativeInfisicalResolver.credentialReadDelaysMs
    ) async -> InfisicalServiceTokenReadStatus {
        guard let serviceTokenStore else {
            return .empty
        }

        var lastStatus: OSStatus = errSecNotAvailable
        var lastMessage = "the operating-system credential store is unavailable"

        for attempt in 0...delaysMs.count {
            if attempt > 0 {
                await sleepMs(delaysMs[attempt - 1])
            }
            switch serviceTokenStore.queryRaw() {
            case .itemNotFound:
                return .empty
            case .itemData(let data):
                guard let text = String(data: data, encoding: .utf8) else {
                    return .unavailable(status: errSecDecode, message: "the credential store is not readable")
                }
                let token = text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard InfisicalServiceToken.isValid(token) else {
                    return .invalid
                }
                return .ok(InfisicalServiceToken(token))
            case .statusError(let status):
                lastStatus = status
                lastMessage = "the operating-system credential store is unavailable (OSStatus \(status))"
                if status == errSecDecode {
                    return .unavailable(status: status, message: "the credential store is not readable")
                }
            }
        }
        return .unavailable(status: lastStatus, message: lastMessage)
    }

    /// Saves a machine identity into Keychain and clears any cached tokens/secrets.
    public func saveMachineIdentity(_ identity: InfisicalMachineIdentity) throws {
        guard identity.isValid else {
            throw InfisicalResolverError.missingMachineIdentity
        }
        let encoded = try JSONEncoder().encode(identity)
        try keychain.saveRaw(encoded)
        invalidateCache()
    }

    /// Removes the machine identity from Keychain and clears in-memory caches.
    public func clearMachineIdentity() throws {
        try keychain.deleteRaw()
        invalidateCache()
    }

    /// Evicts all in-memory cached secrets and bearer tokens.
    public func invalidateCache() {
        secretCache.removeAll()
        cachedBearer = nil
        cachedServiceToken = nil
    }

    // MARK: - Secret Resolution (In-Memory Only, Fail-Closed)

    /// Resolves a secret by name (`secretKey`), returning its value from the
    /// process environment first, then from the in-memory TTL cache, and
    /// finally by fetching a fresh snapshot from Infisical.
    ///
    /// The process environment takes precedence over the vault so an operator
    /// can override a secret for one run without touching the vault.  The value
    /// is never logged or echoed.
    ///
    /// Fails closed before making any network request when the Keychain holds
    /// no usable credential: the service token is `.empty`, `.invalid` or
    /// `.unavailable`, and so is the machine identity.
    public func resolveSecret(forKey key: String) async throws -> RedactedSecret {
        let trimmedKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedKey.isEmpty else {
            throw InfisicalResolverError.secretNotFound(key: key)
        }

        if let environmentValue = ProcessInfo.processInfo.environment[trimmedKey] {
            let trimmedValue = environmentValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedValue.isEmpty {
                return RedactedSecret(trimmedValue)
            }
        }

        let currentTime = now()
        if let entry = secretCache[trimmedKey], entry.expiresAt > currentTime, !entry.secret.isEmpty {
            return entry.secret
        }

        _ = try await refreshSecretsSnapshot()

        let afterRefresh = now()
        guard let resolved = secretCache[trimmedKey], resolved.expiresAt > afterRefresh, !resolved.secret.isEmpty else {
            throw InfisicalResolverError.secretNotFound(key: trimmedKey)
        }
        return resolved.secret
    }

    /// Reads the secrets in scope and populates the in-memory secret cache from
    /// `/api/v3/secrets/raw`.  Returns only the list of secret names present in
    /// the vault, never raw values.
    ///
    /// Two credentials can open the vault, and the service token wins:
    ///
    /// 1. A read-only service token, when one is stored.  It is the bearer
    ///    token itself, so this path sends NO Universal Auth login request.
    /// 2. Otherwise the machine identity, which is exchanged for a bearer token
    ///    through `/api/v1/auth/universal-auth/login`.
    ///
    /// Fails closed before any network request is opened: an unreadable
    /// credential store, a stored value that is not a service token, and a
    /// missing credential are all reported, never worked around.
    @discardableResult
    public func refreshSecretsSnapshot() async throws -> [String] {
        switch await serviceTokenStatus() {
        case .ok(let token):
            return try await fetchSecretsRaw(
                scope: scope,
                bearerToken: token.exposeSecret(),
                expandSecretReferences: true
            )
        case .empty:
            break
        case .invalid:
            throw InfisicalResolverError.invalidServiceToken
        case .unavailable(let status, let message):
            throw InfisicalResolverError.keychainUnavailable(status: status, message: message)
        }

        let identity: InfisicalMachineIdentity
        switch await readMachineIdentity() {
        case .empty:
            throw InfisicalResolverError.missingMachineIdentity
        case .unavailable(let status, let message):
            throw InfisicalResolverError.keychainUnavailable(status: status, message: message)
        case .ok(let loaded):
            guard loaded.isValid else {
                throw InfisicalResolverError.missingMachineIdentity
            }
            identity = loaded
        }

        let token = try await obtainBearerToken(for: identity)
        let identityScope = InfisicalVaultScope(
            siteUrl: identity.siteUrl,
            projectId: identity.projectId,
            environment: identity.environment,
            secretPath: identity.secretPath
        )
        return try await fetchSecretsRaw(
            scope: identityScope,
            bearerToken: token.exposeSecret(),
            expandSecretReferences: false
        )
    }

    /// The service token to authenticate with, when one is available.
    ///
    /// The token is cached for the TTL so a refresh inside the window reads
    /// the credential store once, and so `redactSecrets(in:)` can scrub it out
    /// of a log line.
    private func serviceTokenStatus() async -> InfisicalServiceTokenReadStatus {
        let currentTime = now()
        if let cached = cachedServiceToken, cached.expiresAt > currentTime {
            return .ok(cached.token)
        }

        let status = await readServiceToken()
        if case .ok(let token) = status {
            cachedServiceToken = CachedServiceToken(
                token: token,
                expiresAt: now().addingTimeInterval(ttlSeconds)
            )
        }
        return status
    }

    /// Scrubs any known in-memory secret values from an arbitrary string so logs or
    /// error surfaces never leak credential material.
    public func redactSecrets(in text: String) -> String {
        guard !text.isEmpty else { return text }
        var output = text
        for entry in secretCache.values {
            let raw = entry.secret.exposeSecret()
            if raw.count >= 4 && output.contains(raw) {
                output = output.replacingOccurrences(of: raw, with: "[REDACTED]")
            }
        }
        if let bearer = cachedBearer?.token.exposeSecret(), bearer.count >= 4, output.contains(bearer) {
            output = output.replacingOccurrences(of: bearer, with: "[REDACTED]")
        }
        if let serviceToken = cachedServiceToken?.token.exposeSecret(),
           serviceToken.count >= 4,
           output.contains(serviceToken) {
            output = output.replacingOccurrences(of: serviceToken, with: "[REDACTED]")
        }
        return output
    }

    // MARK: - Universal Auth & Secrets Raw Wire Calls

    private func obtainBearerToken(for identity: InfisicalMachineIdentity) async throws -> RedactedSecret {
        let currentTime = now()
        if let cached = cachedBearer, cached.expiresAt > currentTime, !cached.token.isEmpty {
            return cached.token
        }

        let base = identity.siteUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: "\(base)/api/v1/auth/universal-auth/login") else {
            throw InfisicalResolverError.transportFailure(operation: "login")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let payload = [
            "clientId": identity.clientId,
            "clientSecret": identity.clientSecret,
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: payload, options: [])

        let (data, response): (Data, HTTPURLResponse)
        do {
            (data, response) = try await transport.execute(request)
        } catch let error as InfisicalResolverError {
            throw error
        } catch {
            throw InfisicalResolverError.transportFailure(operation: "login")
        }

        guard (200..<300).contains(response.statusCode) else {
            throw InfisicalResolverError.loginFailed(statusCode: response.statusCode)
        }

        guard
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let accessToken = json["accessToken"] as? String,
            !accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            throw InfisicalResolverError.invalidLoginResponse
        }

        let redacted = RedactedSecret(accessToken)
        cachedBearer = CachedBearerToken(
            token: redacted,
            expiresAt: now().addingTimeInterval(ttlSeconds)
        )
        return redacted
    }

    /// Reads the secrets in `scope` and caches them in memory.
    ///
    /// `expandSecretReferences` mirrors `electron/infisical-read.mjs`, which
    /// asks the vault to expand a stored `${...}` reference; the machine
    /// identity path keeps the value it has always sent.
    private func fetchSecretsRaw(
        scope: InfisicalVaultScope,
        bearerToken: String,
        expandSecretReferences: Bool
    ) async throws -> [String] {
        let trimmedBearer = bearerToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBearer.isEmpty else {
            throw InfisicalResolverError.missingMachineIdentity
        }

        let base = scope.siteUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard var components = URLComponents(string: "\(base)/api/v3/secrets/raw") else {
            throw InfisicalResolverError.transportFailure(operation: "secrets list")
        }
        components.queryItems = [
            URLQueryItem(name: "workspaceId", value: scope.projectId),
            URLQueryItem(name: "environment", value: scope.environment),
            URLQueryItem(name: "secretPath", value: scope.secretPath),
            URLQueryItem(name: "viewSecretValue", value: "true"),
            URLQueryItem(name: "expandSecretReferences", value: expandSecretReferences ? "true" : "false"),
            URLQueryItem(name: "include_imports", value: "false"),
        ]
        guard let url = components.url else {
            throw InfisicalResolverError.transportFailure(operation: "secrets list")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(trimmedBearer)", forHTTPHeaderField: "Authorization")

        let (data, response): (Data, HTTPURLResponse)
        do {
            (data, response) = try await transport.execute(request)
        } catch let error as InfisicalResolverError {
            throw error
        } catch {
            throw InfisicalResolverError.transportFailure(operation: "secrets list")
        }

        guard (200..<300).contains(response.statusCode) else {
            throw InfisicalResolverError.secretsFetchFailed(statusCode: response.statusCode)
        }

        guard
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let rows = json["secrets"] as? [[String: Any]]
        else {
            throw InfisicalResolverError.invalidSecretsResponse
        }

        let expiry = now().addingTimeInterval(ttlSeconds)
        var names: [String] = []
        for row in rows {
            guard let key = row["secretKey"] as? String, !key.isEmpty else { continue }
            names.append(key)
            if let value = row["secretValue"] as? String, !value.isEmpty {
                secretCache[key] = CachedSecretEntry(secret: RedactedSecret(value), expiresAt: expiry)
            }
        }
        return names
    }
}
