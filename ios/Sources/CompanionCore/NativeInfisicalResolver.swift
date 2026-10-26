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

/// Errors thrown by `NativeInfisicalResolver`.  Error descriptions never echo
/// upstream response bodies or raw secret material.
public enum InfisicalResolverError: LocalizedError, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    case missingMachineIdentity
    case keychainUnavailable(status: OSStatus, message: String)
    case keychainWriteFailed(status: OSStatus)
    case loginFailed(statusCode: Int)
    case invalidLoginResponse
    case secretsFetchFailed(statusCode: Int)
    case invalidSecretsResponse
    case secretNotFound(key: String)
    case transportFailure(operation: String)

    public var errorDescription: String? {
        switch self {
        case .missingMachineIdentity:
            return "Infisical machine identity is missing from Keychain.  Configure machine identity credentials before making requests."
        case .keychainUnavailable(let status, let message):
            return "macOS Keychain is unavailable (OSStatus \(status)): \(message)"
        case .keychainWriteFailed(let status):
            return "macOS Keychain write failed (OSStatus \(status))."
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

/// In-memory-only Infisical secret resolver with Keychain machine-identity storage.
///
/// Security invariants:
/// 1. Machine identity lives in macOS Keychain under `app.botfleet.macos.infisical`.
/// 2. Keychain reads distinguish `.empty`, `.ok`, and `.unavailable`, retrying busy
///    keychain errors across `[100, 200, 400, 800]` ms before reporting `.unavailable`.
/// 3. Resolved secrets live exclusively in actor-isolated memory with a TTL and are
///    never persisted to SQLite, `UserDefaults`, disk files, or log lines.
/// 4. Fails closed (`InfisicalResolverError.missingMachineIdentity`) before opening
///    any network request if the machine identity is missing or empty.
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

    private let keychain: InfisicalKeychainStoreProtocol
    private let transport: InfisicalHTTPTransportProtocol
    private let ttlSeconds: TimeInterval
    private let now: @Sendable () -> Date
    private let sleepMs: @Sendable (UInt64) async -> Void

    private var secretCache: [String: CachedSecretEntry] = [:]
    private var cachedBearer: CachedBearerToken?

    public init(
        keychain: InfisicalKeychainStoreProtocol = MacKeychainInfisicalStore(),
        transport: InfisicalHTTPTransportProtocol = URLSessionInfisicalTransport(),
        ttlSeconds: TimeInterval = 300,
        now: @escaping @Sendable () -> Date = { Date() },
        sleepMs: @escaping @Sendable (UInt64) async -> Void = { ms in
            try? await Task.sleep(nanoseconds: ms * 1_000_000)
        }
    ) {
        self.keychain = keychain
        self.transport = transport
        self.ttlSeconds = ttlSeconds
        self.now = now
        self.sleepMs = sleepMs
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
    }

    // MARK: - Secret Resolution (In-Memory Only, Fail-Closed)

    /// Resolves a secret by name (`secretKey`), returning its value from the
    /// process environment first, then from the in-memory TTL cache, and
    /// finally by fetching a fresh snapshot from Infisical via Universal Auth.
    ///
    /// The process environment takes precedence over the vault so an operator
    /// can override a secret for one run without touching the vault.  The value
    /// is never logged or echoed.
    ///
    /// Fails closed before making any network request if the Keychain machine identity
    /// is `.empty` or `.unavailable`.
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

    /// Exchanges the Keychain machine identity for a Universal Auth bearer token and
    /// populates the in-memory secret cache from `/api/v3/secrets/raw`.
    /// Returns only the list of secret names present in the vault, never raw values.
    @discardableResult
    public func refreshSecretsSnapshot() async throws -> [String] {
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
        return try await fetchSecretsRaw(identity: identity, bearerToken: token.exposeSecret())
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

    private func fetchSecretsRaw(identity: InfisicalMachineIdentity, bearerToken: String) async throws -> [String] {
        let trimmedBearer = bearerToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBearer.isEmpty else {
            throw InfisicalResolverError.missingMachineIdentity
        }

        let base = identity.siteUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard var components = URLComponents(string: "\(base)/api/v3/secrets/raw") else {
            throw InfisicalResolverError.transportFailure(operation: "secrets list")
        }
        components.queryItems = [
            URLQueryItem(name: "workspaceId", value: identity.projectId),
            URLQueryItem(name: "environment", value: identity.environment),
            URLQueryItem(name: "secretPath", value: identity.secretPath),
            URLQueryItem(name: "viewSecretValue", value: "true"),
            URLQueryItem(name: "expandSecretReferences", value: "false"),
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
