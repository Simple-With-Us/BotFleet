import Foundation
import Security
import Testing
@testable import CompanionCore

// MARK: - Test doubles

/// A Keychain store whose answers the test scripts.
private final class ScriptedKeychainStore: InfisicalKeychainStoreProtocol, @unchecked Sendable {
    let serviceName: String
    let accountName: String

    private let lock = NSLock()
    private var scripted: [KeychainRawQueryResult]
    private var stored: Data?
    private(set) var queryCount = 0

    init(
        serviceName: String = "app.botfleet.macos.infisical.test",
        accountName: String = "machine-identity",
        scripted: [KeychainRawQueryResult] = [],
        stored: Data? = nil
    ) {
        self.serviceName = serviceName
        self.accountName = accountName
        self.scripted = scripted
        self.stored = stored
    }

    func queryRaw() -> KeychainRawQueryResult {
        lock.lock()
        defer { lock.unlock() }
        queryCount += 1
        if !scripted.isEmpty {
            return scripted.removeFirst()
        }
        if let stored {
            return .itemData(stored)
        }
        return .itemNotFound
    }

    func saveRaw(_ data: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        stored = data
    }

    func deleteRaw() throws {
        lock.lock()
        defer { lock.unlock() }
        stored = nil
    }
}

/// An HTTP transport that records every request and answers the Infisical
/// endpoints the resolver uses.  No network is touched.
private final class RecordingInfisicalTransport: InfisicalHTTPTransportProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var requests: [URLRequest] = []
    private let secrets: [[String: String]]
    private let loginToken: String
    private var metadataData: Data
    private let metadataStatus: Int
    private let beforeSecretsResponse: (@Sendable () -> Void)?
    private let metadataResponseURL: URL?

    init(secrets: [String: String] = [:], loginToken: String = "universal-auth-access-token-fixture",
         metadata: [String: Any]? = nil, metadataData: Data? = nil, metadataStatus: Int = 200,
         beforeSecretsResponse: (@Sendable () -> Void)? = nil, metadataResponseURL: URL? = nil) {
        self.secrets = secrets.map { ["secretKey": $0.key, "secretValue": $0.value] }
        self.loginToken = loginToken
        self.metadataData = metadataData ?? (try! JSONSerialization.data(withJSONObject: metadata ?? fixtureTokenGrant()))
        self.metadataStatus = metadataStatus
        self.beforeSecretsResponse = beforeSecretsResponse
        self.metadataResponseURL = metadataResponseURL
    }

    func replaceMetadata(_ metadata: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: metadata)
        lock.lock(); defer { lock.unlock() }; metadataData = data
    }

    private func currentMetadata() -> Data {
        lock.lock(); defer { lock.unlock() }; return metadataData
    }

    /// Records the request.  The lock is taken here, in a non-async
    /// function, because `NSLock` is unavailable from an async context.
    private func record(_ request: URLRequest) {
        lock.lock()
        requests.append(request)
        lock.unlock()
    }

    func execute(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        record(request)

        guard let url = request.url else {
            throw InfisicalResolverError.transportFailure(operation: "http")
        }
        if url.path.hasSuffix("/api/v1/auth/universal-auth/login") {
            let body = try JSONSerialization.data(withJSONObject: ["accessToken": loginToken], options: [])
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
            return (body, response)
        }
        if url.path == "/api/v2/service-token" {
            let response = HTTPURLResponse(url: metadataResponseURL ?? url, statusCode: metadataStatus, httpVersion: "HTTP/1.1", headerFields: nil)!
            return (currentMetadata(), response)
        }
        if url.path.hasSuffix("/api/v3/secrets/raw") {
            beforeSecretsResponse?()
            let body = try JSONSerialization.data(withJSONObject: ["secrets": secrets], options: [])
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
            return (body, response)
        }
        let response = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (Data(), response)
    }
}

/// A thread-safe recorder for the backoff delays the resolver asks for.
private final class DelayRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var delays: [UInt64] = []

    func record(_ delay: UInt64) {
        lock.lock()
        delays.append(delay)
        lock.unlock()
    }

    var recorded: [UInt64] {
        lock.lock()
        defer { lock.unlock() }
        return delays
    }
}

/// A well-formed service token.  It is a fixture, not a credential.
private let fixtureServiceToken = "st." + String(repeating: "a", count: 40)

/// A secret name that cannot collide with a name in the process environment.
private let fixtureSecretName = "FIXTURE_VAULT_SECRET"

private func fixtureTokenGrant(projectId: String = InfisicalVaultScope.botFleetServer.projectId,
                               environment: String = "prod", path: String = "/botfleet-server") -> [String: Any] {
    ["workspace": projectId, "projectId": projectId, "scopes": [["environment": environment, "secretPath": path]],
     "permissions": ["read"], "expiresAt": NSNull()]
}

enum InvalidTokenGrant: String, CaseIterable, Sendable {
    case wrongProject, conflictingProjectId, wrongEnvironment, wrongFolder, parentFolder, wildcardFolder, whitespaceFolder
    case writeCapable, writeOnly, unknownPermission, emptyPermissions, malformedScopes, malformedSerializedScopes
    case malformedRow, missingWorkspace, wrappedMetadata, missingExpiry, invalidExpiry, numericExpiry, invalidCalendar, expired, redirectedResponse

    var metadata: [String: Any] {
        var value = fixtureTokenGrant()
        switch self {
        case .wrongProject: return fixtureTokenGrant(projectId: "other-project")
        case .conflictingProjectId: value["projectId"] = "other-project"
        case .wrongEnvironment: return fixtureTokenGrant(environment: "dev")
        case .wrongFolder: return fixtureTokenGrant(path: "/another-folder")
        case .parentFolder: return fixtureTokenGrant(path: "/")
        case .wildcardFolder: return fixtureTokenGrant(path: "/botfleet-server/*")
        case .whitespaceFolder: return fixtureTokenGrant(path: "/botfleet-server ")
        case .writeCapable: value["permissions"] = ["read", "write"]
        case .writeOnly: value["permissions"] = ["write"]
        case .unknownPermission: value["permissions"] = ["read", "admin"]
        case .emptyPermissions: value["permissions"] = [String]()
        case .malformedScopes: value["scopes"] = ["environment": "prod", "secretPath": "/botfleet-server"]
        case .malformedSerializedScopes: value["scopes"] = "not-json"
        case .malformedRow: value["scopes"] = [["secretPath": "/botfleet-server"]]
        case .missingWorkspace: value.removeValue(forKey: "workspace")
        case .wrappedMetadata: return ["serviceTokenData": value]
        case .missingExpiry: value.removeValue(forKey: "expiresAt")
        case .invalidExpiry: value["expiresAt"] = "2999-01-01"
        case .numericExpiry: value["expiresAt"] = 2_000_000_100
        case .invalidCalendar: value["expiresAt"] = "2999-02-30T00:00:00.000Z"
        case .expired: value["expiresAt"] = "2001-01-01T00:00:00.000Z"
        case .redirectedResponse: break
        }
        return value
    }

    var error: InfisicalResolverError {
        switch self {
        case .wrongProject, .wrongEnvironment, .wrongFolder, .parentFolder, .whitespaceFolder:
            return .serviceTokenScopeMismatch
        case .writeCapable, .writeOnly: return .readOnlyServiceTokenRequired
        case .expired: return .expiredServiceToken
        default: return .invalidServiceTokenMetadata
        }
    }
}

private final class GrantFixtureClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Date(timeIntervalSince1970: 2_000_000_000)
    func now() -> Date { lock.lock(); defer { lock.unlock() }; return value }
    func advance(_ seconds: TimeInterval) { lock.lock(); defer { lock.unlock() }; value.addTimeInterval(seconds) }
}

/// The query of a request as `name=value` pairs, in the order they were sent.
private func queryPairs(of request: URLRequest) -> [String] {
    guard let url = request.url,
          let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
        return []
    }
    return (components.queryItems ?? []).map { "\($0.name)=\($0.value ?? "")" }
}

// MARK: - Tests

@Suite("Native Infisical service-token authentication")
struct NativeInfisicalServiceTokenTests {

    @Test("Matching wildcard request and grant folders fail before network access", arguments: ["*", "?", "[", "]", "{", "}"])
    func matchingWildcardFoldersNeverRequestMetadata(_ character: String) async throws {
        let path = "/folder/\(character)"
        let standard = InfisicalVaultScope.botFleetServer
        let scope = InfisicalVaultScope(siteUrl: standard.siteUrl, projectId: standard.projectId,
            environment: standard.environment, secretPath: path)
        let transport = RecordingInfisicalTransport(metadata: fixtureTokenGrant(path: path))
        let resolver = NativeInfisicalResolver(enabled: true, keychain: ScriptedKeychainStore(),
            serviceTokenStore: ScriptedKeychainStore(stored: Data(fixtureServiceToken.utf8)), scope: scope, transport: transport)
        await #expect(throws: InfisicalResolverError.serviceTokenScopeMismatch) {
            try await resolver.resolveSecret(forKey: fixtureSecretName)
        }
        #expect(transport.requests.isEmpty)
    }

    @Test("A wildcard metadata row invalidates a grant beside an exact folder", arguments: ["*", "?", "[", "]", "{", "}"])
    func wildcardMetadataRowNeverFetchesSecrets(_ character: String) async throws {
        var grant = fixtureTokenGrant()
        grant["scopes"] = [
            ["environment": "prod", "secretPath": "/botfleet-server"],
            ["environment": "prod", "secretPath": "/other/\(character)"]
        ]
        let transport = RecordingInfisicalTransport(metadata: grant)
        let resolver = NativeInfisicalResolver(enabled: true, keychain: ScriptedKeychainStore(),
            serviceTokenStore: ScriptedKeychainStore(stored: Data(fixtureServiceToken.utf8)), transport: transport)
        await #expect(throws: InfisicalResolverError.invalidServiceTokenMetadata) {
            try await resolver.resolveSecret(forKey: fixtureSecretName)
        }
        #expect(transport.requests.map { $0.url?.path } == ["/api/v2/service-token"])
    }

    @Test("Literal folder spaces and punctuation remain valid")
    func literalFolderPunctuation() async throws {
        let path = "/folder name/ship.v2+test_(safe)!"
        let standard = InfisicalVaultScope.botFleetServer
        let scope = InfisicalVaultScope(siteUrl: standard.siteUrl, projectId: standard.projectId,
            environment: standard.environment, secretPath: path)
        let transport = RecordingInfisicalTransport(secrets: [fixtureSecretName: "literal-value"], metadata: fixtureTokenGrant(path: path))
        let resolver = NativeInfisicalResolver(enabled: true, keychain: ScriptedKeychainStore(),
            serviceTokenStore: ScriptedKeychainStore(stored: Data(fixtureServiceToken.utf8)), scope: scope, transport: transport)
        #expect(try await resolver.resolveSecret(forKey: fixtureSecretName).exposeSecret() == "literal-value")
        #expect(transport.requests.map { $0.url?.path } == ["/api/v2/service-token", "/api/v3/secrets/raw"])
    }

    @Test("Rejected token grants never fetch or cache secrets or probe a machine identity", arguments: InvalidTokenGrant.allCases)
    func rejectedGrantNeverReadsSecrets(_ invalid: InvalidTokenGrant) async throws {
        let tokenStore = ScriptedKeychainStore(stored: Data(fixtureServiceToken.utf8))
        let identity = InfisicalMachineIdentity(clientId: "fixture-app", clientSecret: "fixture-secret", projectId: "other")
        let identityStore = ScriptedKeychainStore(stored: try JSONEncoder().encode(identity))
        let transport = RecordingInfisicalTransport(secrets: [fixtureSecretName: "must-not-be-read"], metadata: invalid.metadata,
            metadataResponseURL: invalid == .redirectedResponse ? URL(string: "https://other.test/api/v2/service-token")! : nil)
        let resolver = NativeInfisicalResolver(enabled: true, keychain: identityStore, serviceTokenStore: tokenStore,
            transport: transport, now: { Date(timeIntervalSince1970: 2_000_000_000) })
        for _ in 0..<2 {
            await #expect(throws: invalid.error) { try await resolver.resolveSecret(forKey: fixtureSecretName) }
        }
        #expect(transport.requests.map { $0.url?.path } == ["/api/v2/service-token", "/api/v2/service-token"])
        #expect(tokenStore.queryCount == 2)
        #expect(identityStore.queryCount == 0)
    }

    @Test("Array and serialized-array grants accept only the exact normalized folder", arguments: [false, true])
    func matchingReadOnlyGrantAllowsSecrets(serialized: Bool) async throws {
        var grant = fixtureTokenGrant(path: "/botfleet-server///")
        if serialized {
            grant["scopes"] = String(decoding: try JSONSerialization.data(withJSONObject: grant["scopes"]!), as: UTF8.self)
        }
        let transport = RecordingInfisicalTransport(secrets: [fixtureSecretName: "verified-value"], metadata: grant)
        let resolver = NativeInfisicalResolver(enabled: true, keychain: ScriptedKeychainStore(),
            serviceTokenStore: ScriptedKeychainStore(stored: Data(fixtureServiceToken.utf8)), transport: transport)
        #expect(try await resolver.resolveSecret(forKey: fixtureSecretName).exposeSecret() == "verified-value")
        #expect(transport.requests.map { $0.url?.path } == ["/api/v2/service-token", "/api/v3/secrets/raw"])
        #expect(transport.requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer \(fixtureServiceToken)" })
    }

    @Test("A failed later grant verification evicts earlier cached secrets")
    func rejectedRefreshEvictsCachedSecrets() async throws {
        let transport = RecordingInfisicalTransport(secrets: [fixtureSecretName: "verified-value"])
        let resolver = NativeInfisicalResolver(enabled: true, keychain: ScriptedKeychainStore(),
            serviceTokenStore: ScriptedKeychainStore(stored: Data(fixtureServiceToken.utf8)), transport: transport)
        _ = try await resolver.resolveSecret(forKey: fixtureSecretName)
        try transport.replaceMetadata(fixtureTokenGrant(projectId: "other-project"))
        await #expect(throws: InfisicalResolverError.serviceTokenScopeMismatch) { try await resolver.refreshSecretsSnapshot() }
        await #expect(throws: InfisicalResolverError.serviceTokenScopeMismatch) { try await resolver.resolveSecret(forKey: fixtureSecretName) }
        #expect(transport.requests.filter { $0.url?.path == "/api/v3/secrets/raw" }.count == 1)
    }

    @Test("A known token expiry bounds secret cache lifetime and response acceptance", arguments: [false, true])
    func expiryBoundsCacheAndAwaitedResponse(expireDuringRead: Bool) async throws {
        let clock = GrantFixtureClock()
        var metadata = fixtureTokenGrant()
        metadata["expiresAt"] = ISO8601DateFormatter().string(from: clock.now().addingTimeInterval(5))
        let beforeResponse: (@Sendable () -> Void)?
        if expireDuringRead { beforeResponse = { clock.advance(6) } }
        else { beforeResponse = nil }
        let transport = RecordingInfisicalTransport(secrets: [fixtureSecretName: "verified-value"], metadata: metadata,
            beforeSecretsResponse: beforeResponse)
        let resolver = NativeInfisicalResolver(enabled: true, keychain: ScriptedKeychainStore(),
            serviceTokenStore: ScriptedKeychainStore(stored: Data(fixtureServiceToken.utf8)), transport: transport, now: { clock.now() })
        if expireDuringRead {
            await #expect(throws: InfisicalResolverError.expiredServiceToken) { try await resolver.resolveSecret(forKey: fixtureSecretName) }
        } else {
            #expect(try await resolver.resolveSecret(forKey: fixtureSecretName).exposeSecret() == "verified-value")
            clock.advance(6)
        }
        await #expect(throws: InfisicalResolverError.expiredServiceToken) { try await resolver.resolveSecret(forKey: fixtureSecretName) }
        #expect(transport.requests.filter { $0.url?.path == "/api/v3/secrets/raw" }.count == 1)
    }

    @Test("A metadata HTTP refusal remains redacted and never reaches the secrets endpoint")
    func metadataRefusalNeverFetchesSecrets() async throws {
        let transport = RecordingInfisicalTransport(metadataData: Data("must-not-echo".utf8), metadataStatus: 403)
        let resolver = NativeInfisicalResolver(enabled: true, keychain: ScriptedKeychainStore(),
            serviceTokenStore: ScriptedKeychainStore(stored: Data(fixtureServiceToken.utf8)), transport: transport)
        let error = await #expect(throws: InfisicalResolverError.serviceTokenMetadataFailed(statusCode: 403)) {
            try await resolver.refreshSecretsSnapshot()
        }
        #expect(transport.requests.count == 1)
        #expect(!String(describing: error).contains("must-not-echo"))
    }

    @Test("A malformed metadata body never reaches the secrets endpoint")
    func malformedMetadataNeverFetchesSecrets() async throws {
        let transport = RecordingInfisicalTransport(metadataData: Data("not-json".utf8))
        let resolver = NativeInfisicalResolver(enabled: true, keychain: ScriptedKeychainStore(),
            serviceTokenStore: ScriptedKeychainStore(stored: Data(fixtureServiceToken.utf8)), transport: transport)
        await #expect(throws: InfisicalResolverError.invalidServiceTokenMetadata) { try await resolver.refreshSecretsSnapshot() }
        #expect(transport.requests.map { $0.url?.path } == ["/api/v2/service-token"])
    }

    @Test("Explicit environment overrides bypass disabled and enabled vault credential queries", arguments: [false, true])
    func environmentOverrideMakesNoVaultQuery(enabled: Bool) async throws {
        let identity = ScriptedKeychainStore(scripted: [.statusError(errSecNotAvailable)])
        let token = ScriptedKeychainStore(stored: Data(fixtureServiceToken.utf8))
        let transport = RecordingInfisicalTransport(metadataData: Data("invalid".utf8))
        let resolver = NativeInfisicalResolver(enabled: enabled, keychain: identity, serviceTokenStore: token,
            transport: transport, environmentValue: { $0 == fixtureSecretName ? "process-override" : nil })
        #expect(try await resolver.resolveSecret(forKey: fixtureSecretName).exposeSecret() == "process-override")
        #expect(identity.queryCount == 0)
        #expect(token.queryCount == 0)
        #expect(transport.requests.isEmpty)
    }

    @Test("Disabled native resolution reads no credential store and makes no request")
    func disabledIntegrationIsInert() async throws {
        let identity = ScriptedKeychainStore(scripted: [.statusError(errSecNotAvailable)])
        let token = ScriptedKeychainStore(stored: Data(fixtureServiceToken.utf8))
        let transport = RecordingInfisicalTransport()
        let resolver = NativeInfisicalResolver(keychain: identity, serviceTokenStore: token, transport: transport)
        await #expect(throws: InfisicalResolverError.integrationDisabled) { try await resolver.refreshSecretsSnapshot() }
        await #expect(throws: InfisicalResolverError.integrationDisabled) { try await resolver.resolveSecret(forKey: fixtureSecretName) }
        #expect(identity.queryCount == 0)
        #expect(token.queryCount == 0)
        #expect(transport.requests.isEmpty)
    }

    @Test("A missing service token never falls back to a stored machine identity")
    func missingTokenNeverSelectsMachineIdentity() async throws {
        let identity = InfisicalMachineIdentity(clientId: "fixture-app", clientSecret: "fixture-secret", projectId: "fixture-project")
        let identityStore = ScriptedKeychainStore(stored: try JSONEncoder().encode(identity))
        let transport = RecordingInfisicalTransport()
        let resolver = NativeInfisicalResolver(enabled: true, keychain: identityStore,
            serviceTokenStore: ScriptedKeychainStore(), transport: transport)
        await #expect(throws: InfisicalResolverError.missingMachineIdentity) { try await resolver.refreshSecretsSnapshot() }
        #expect(identityStore.queryCount == 0)
        #expect(transport.requests.isEmpty)
    }

    @Test("Explicit machine identity authentication never consults the service token store")
    func explicitIdentityDoesNotReadTokenStore() async throws {
        let identity = InfisicalMachineIdentity(clientId: "fixture-app", clientSecret: "fixture-secret", projectId: "fixture-project")
        let identityStore = ScriptedKeychainStore(stored: try JSONEncoder().encode(identity))
        let tokenStore = ScriptedKeychainStore(scripted: [.statusError(errSecNotAvailable)])
        let transport = RecordingInfisicalTransport()
        let resolver = NativeInfisicalResolver(enabled: true, authMethod: .machineIdentity,
            keychain: identityStore, serviceTokenStore: tokenStore, transport: transport)
        _ = try await resolver.refreshSecretsSnapshot()
        #expect(tokenStore.queryCount == 0)
        #expect(transport.requests.count == 2)
        #expect(transport.requests.first?.httpMethod == "POST")
    }

    @Test("Independent project resolvers keep credentials, scopes and same-name cached secrets separate")
    func projectsRemainIsolated() async throws {
        let firstToken = ScriptedKeychainStore(stored: Data(fixtureServiceToken.utf8))
        let secondValue = "st." + String(repeating: "b", count: 40)
        let secondToken = ScriptedKeychainStore(stored: Data(secondValue.utf8))
        let firstTransport = RecordingInfisicalTransport(secrets: [fixtureSecretName: "first-project"], metadata: fixtureTokenGrant(projectId: "first", path: "/one"))
        let secondTransport = RecordingInfisicalTransport(secrets: [fixtureSecretName: "second-project"], metadata: fixtureTokenGrant(projectId: "second", environment: "dev", path: "/two"))
        let first = NativeInfisicalResolver(enabled: true, keychain: ScriptedKeychainStore(), serviceTokenStore: firstToken,
            scope: .init(siteUrl: "https://vault.test", projectId: "first", environment: "prod", secretPath: "/one"), transport: firstTransport)
        let second = NativeInfisicalResolver(enabled: true, keychain: ScriptedKeychainStore(), serviceTokenStore: secondToken,
            scope: .init(siteUrl: "https://vault.test", projectId: "second", environment: "dev", secretPath: "/two"), transport: secondTransport)
        #expect(try await first.resolveSecret(forKey: fixtureSecretName).exposeSecret() == "first-project")
        #expect(try await second.resolveSecret(forKey: fixtureSecretName).exposeSecret() == "second-project")
        #expect(try await first.resolveSecret(forKey: fixtureSecretName).exposeSecret() == "first-project")
        #expect(firstTransport.requests.count == 2)
        #expect(secondTransport.requests.count == 2)
        #expect(firstTransport.requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer \(fixtureServiceToken)" })
        #expect(secondTransport.requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer \(secondValue)" })
        #expect(queryPairs(of: firstTransport.requests[1]).contains("workspaceId=first"))
        #expect(queryPairs(of: secondTransport.requests[1]).contains("workspaceId=second"))
        #expect(queryPairs(of: firstTransport.requests[1]).contains("secretPath=/one"))
        #expect(queryPairs(of: secondTransport.requests[1]).contains("secretPath=/two"))
    }

    @Test("A stored service token is the bearer and no Universal Auth login is sent")
    func testServiceTokenAuthenticatesWithoutALoginRequest() async throws {
        let tokenStore = ScriptedKeychainStore(stored: Data(fixtureServiceToken.utf8))
        let identityStore = ScriptedKeychainStore()
        let transport = RecordingInfisicalTransport(secrets: ["BOTFLEET_SERVER_MODE": "local"])
        let resolver = NativeInfisicalResolver(
            enabled: true,
            keychain: identityStore,
            serviceTokenStore: tokenStore,
            transport: transport
        )

        let names = try await resolver.refreshSecretsSnapshot()

        #expect(names == ["BOTFLEET_SERVER_MODE"])
        #expect(transport.requests.count == 2)
        #expect(transport.requests.allSatisfy {
            $0.url?.path.hasSuffix("/api/v1/auth/universal-auth/login") == false
        })
        // The machine identity is never consulted on the service-token path.
        #expect(identityStore.queryCount == 0)
    }

    @Test("The service-token request is the exact secrets-raw read the Electron reader sends")
    func testServiceTokenRequestShape() async throws {
        let tokenStore = ScriptedKeychainStore(stored: Data(fixtureServiceToken.utf8))
        let transport = RecordingInfisicalTransport()
        let resolver = NativeInfisicalResolver(
            enabled: true,
            keychain: ScriptedKeychainStore(),
            serviceTokenStore: tokenStore,
            transport: transport
        )

        _ = try await resolver.refreshSecretsSnapshot()

        #expect(transport.requests.map { $0.url?.path } == ["/api/v2/service-token", "/api/v3/secrets/raw"])
        #expect(transport.requests[0].url?.query == nil)
        #expect(transport.requests[0].value(forHTTPHeaderField: "Authorization") == "Bearer \(fixtureServiceToken)")
        let request = transport.requests[1]
        #expect(request.httpMethod == "GET")
        #expect(request.url?.scheme == "https")
        #expect(request.url?.host == "app.infisical.com")
        #expect(request.url?.path == "/api/v3/secrets/raw")
        let query = queryPairs(of: request)
        #expect(query == [
            "workspaceId=836aebe2-c8f7-4e09-978e-7e3e82500bce",
            "environment=prod",
            "secretPath=/botfleet-server",
            "viewSecretValue=true",
            "expandSecretReferences=true",
            "include_imports=false",
        ])
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(fixtureServiceToken)")
    }

    @Test("The scope is explicit and configurable")
    func testScopeIsConfigurable() async throws {
        let scope = InfisicalVaultScope(
            siteUrl: "https://app.infisical.com",
            projectId: "project-fixture",
            environment: "staging",
            secretPath: "/native-app"
        )
        let tokenStore = ScriptedKeychainStore(stored: Data(fixtureServiceToken.utf8))
        let transport = RecordingInfisicalTransport(metadata: fixtureTokenGrant(projectId: "project-fixture", environment: "staging", path: "/native-app"))
        let resolver = NativeInfisicalResolver(
            enabled: true,
            keychain: ScriptedKeychainStore(),
            serviceTokenStore: tokenStore,
            scope: scope,
            transport: transport
        )

        _ = try await resolver.refreshSecretsSnapshot()

        let query = queryPairs(of: transport.requests[1])
        #expect(query.contains("workspaceId=project-fixture"))
        #expect(query.contains("environment=staging"))
        #expect(query.contains("secretPath=/native-app"))
    }

    @Test("Service token validation refuses anything that is not a service token")
    func testServiceTokenValidation() {
        // The shortest and the longest accepted token, prefix included.
        #expect(InfisicalServiceToken.isValid("st." + String(repeating: "a", count: 17)))
        #expect(InfisicalServiceToken.isValid("st." + String(repeating: "a", count: 2045)))
        // The wrong prefix.
        #expect(!InfisicalServiceToken.isValid("pk." + String(repeating: "a", count: 40)))
        // Too short.
        #expect(!InfisicalServiceToken.isValid("st." + String(repeating: "a", count: 16)))
        // Too long.
        #expect(!InfisicalServiceToken.isValid("st." + String(repeating: "a", count: 2046)))
        // Carries whitespace.
        #expect(!InfisicalServiceToken.isValid(
            "st." + String(repeating: "a", count: 10) + " " + String(repeating: "b", count: 10)
        ))
        // Not a token at all.
        #expect(!InfisicalServiceToken.isValid("st.short"))
    }

    @Test("A stored credential that is not a service token is refused and never used")
    func testInvalidStoredTokenIsRefused() async throws {
        let tokenStore = ScriptedKeychainStore(stored: Data("not-a-service-token".utf8))
        let transport = RecordingInfisicalTransport()
        let resolver = NativeInfisicalResolver(
            enabled: true,
            keychain: ScriptedKeychainStore(),
            serviceTokenStore: tokenStore,
            transport: transport
        )

        await #expect(throws: InfisicalResolverError.invalidServiceToken) {
            _ = try await resolver.refreshSecretsSnapshot()
        }
        #expect(transport.requests.isEmpty)
    }

    @Test("An empty service-token item leaves the vault locked, with no network request")
    func testEmptyServiceTokenFailsClosed() async throws {
        let tokenStore = ScriptedKeychainStore()
        let identityStore = ScriptedKeychainStore()
        let transport = RecordingInfisicalTransport()
        let resolver = NativeInfisicalResolver(
            enabled: true,
            keychain: identityStore,
            serviceTokenStore: tokenStore,
            transport: transport
        )

        await #expect(throws: InfisicalResolverError.missingMachineIdentity) {
            _ = try await resolver.refreshSecretsSnapshot()
        }
        #expect(transport.requests.isEmpty)
    }

    @Test("A busy credential store is unavailable, not empty, and is never worked around")
    func testUnavailableServiceTokenStoreFailsClosed() async throws {
        let tokenStore = ScriptedKeychainStore(
            scripted: Array(repeating: .statusError(errSecInteractionNotAllowed), count: 10)
        )
        let identityStore = ScriptedKeychainStore()
        let transport = RecordingInfisicalTransport()
        let resolver = NativeInfisicalResolver(
            enabled: true,
            keychain: identityStore,
            serviceTokenStore: tokenStore,
            transport: transport,
            sleepMs: { _ in }
        )

        let error = await #expect(throws: InfisicalResolverError.self) {
            _ = try await resolver.refreshSecretsSnapshot()
        }
        #expect(transport.requests.isEmpty)
        // Not treated as empty: the machine identity is not tried as a fallback.
        #expect(identityStore.queryCount == 0)
        guard let error else {
            Issue.record("Expected the resolver to refuse the unreadable credential store")
            return
        }
        guard case .keychainUnavailable(let status, let message) = error else {
            Issue.record("Expected .keychainUnavailable, got \(error)")
            return
        }
        #expect(status == errSecInteractionNotAllowed)
        #expect(message.contains("credential store"))
    }

    @Test("A busy credential store is retried across 100, 200, 400 and 800 ms")
    func testServiceTokenReadBacksOff() async throws {
        let recorder = DelayRecorder()
        let tokenStore = ScriptedKeychainStore(
            scripted: Array(repeating: .statusError(errSecNotAvailable), count: 10)
        )
        let resolver = NativeInfisicalResolver(
            enabled: true,
            keychain: ScriptedKeychainStore(),
            serviceTokenStore: tokenStore,
            transport: RecordingInfisicalTransport(),
            sleepMs: { ms in recorder.record(ms) }
        )

        let status = await resolver.readServiceToken()

        #expect(recorder.recorded == [100, 200, 400, 800])
        guard case .unavailable(let osStatus, _) = status else {
            Issue.record("Expected .unavailable when the credential store is locked, got \(status)")
            return
        }
        #expect(osStatus == errSecNotAvailable)
    }

    @Test("Only explicit machine identity authentication opens the vault through Universal Auth")
    func testExplicitMachineIdentityLogsIn() async throws {
        let identity = InfisicalMachineIdentity(
            clientId: "cid-fixture",
            clientSecret: "client-secret-fixture",
            projectId: "0be350b7-598a-4ac8-8497-81dc3c53ec44",
            environment: "prod"
        )
        let identityStore = ScriptedKeychainStore(stored: try JSONEncoder().encode(identity))
        let tokenStore = ScriptedKeychainStore()
        let transport = RecordingInfisicalTransport(secrets: ["BOTFLEET_SERVER_MODE": "local"])
        let resolver = NativeInfisicalResolver(
            enabled: true,
            authMethod: .machineIdentity,
            keychain: identityStore,
            serviceTokenStore: tokenStore,
            transport: transport
        )

        let names = try await resolver.refreshSecretsSnapshot()

        #expect(names == ["BOTFLEET_SERVER_MODE"])
        #expect(transport.requests.count == 2)
        #expect(transport.requests[0].url?.path.hasSuffix("/api/v1/auth/universal-auth/login") == true)
        #expect(transport.requests[1].url?.path == "/api/v3/secrets/raw")
    }

    @Test("A resolver that was handed its own credential store never reaches into the login Keychain")
    func testInjectedCredentialStoreKeepsTheResolverDeterministic() async throws {
        let identityStore = ScriptedKeychainStore()
        let resolver = NativeInfisicalResolver(
            enabled: true,
            keychain: identityStore,
            transport: RecordingInfisicalTransport()
        )

        let status = await resolver.readServiceToken()

        #expect(status == .empty)
        #expect(identityStore.queryCount == 0)
    }

    @Test("The production service token lives in the Keychain item the Electron main process reads")
    func testProductionServiceTokenKeychainItem() {
        #expect(MacKeychainInfisicalStore.serviceTokenService == "BotFleet Infisical read token")
        #expect(MacKeychainInfisicalStore.serviceTokenAccount == "botfleet")
    }

    @Test("A secret value and the service token never appear in a description or an error")
    func testSecretsAndTokensAreRedacted() async throws {
        let secretValue = "provider-key-fixture-value"
        let tokenStore = ScriptedKeychainStore(stored: Data(fixtureServiceToken.utf8))
        let transport = RecordingInfisicalTransport(secrets: [fixtureSecretName: secretValue])
        let resolver = NativeInfisicalResolver(
            enabled: true,
            keychain: ScriptedKeychainStore(),
            serviceTokenStore: tokenStore,
            transport: transport
        )

        let resolved = try await resolver.resolveSecret(forKey: fixtureSecretName)
        #expect(resolved.exposeSecret() == secretValue)
        #expect(String(describing: resolved) == "[REDACTED]")
        #expect(String(reflecting: resolved) == "[REDACTED]")
        #expect(String(describing: resolver).contains(secretValue) == false)
        #expect(String(reflecting: resolver).contains(secretValue) == false)
        #expect(String(describing: resolver).contains(fixtureServiceToken) == false)

        let status = await resolver.readServiceToken()
        #expect(String(describing: status).contains(fixtureServiceToken) == false)
        #expect(String(reflecting: status).contains(fixtureServiceToken) == false)

        let scrubbed = await resolver.redactSecrets(
            in: "token \(fixtureServiceToken) and key \(secretValue)"
        )
        #expect(scrubbed.contains(fixtureServiceToken) == false)
        #expect(scrubbed.contains(secretValue) == false)
        #expect(scrubbed.contains("[REDACTED]"))
    }

    @Test("A second resolve inside the TTL does not refetch the vault")
    func testSecretsAreCachedInsideTheTTL() async throws {
        let tokenStore = ScriptedKeychainStore(stored: Data(fixtureServiceToken.utf8))
        let transport = RecordingInfisicalTransport(secrets: [fixtureSecretName: "cached-value"])
        let resolver = NativeInfisicalResolver(
            enabled: true,
            keychain: ScriptedKeychainStore(),
            serviceTokenStore: tokenStore,
            transport: transport
        )

        let first = try await resolver.resolveSecret(forKey: fixtureSecretName)
        let second = try await resolver.resolveSecret(forKey: fixtureSecretName)

        #expect(first.exposeSecret() == "cached-value")
        #expect(second.exposeSecret() == "cached-value")
        #expect(transport.requests.count == 2)
        #expect(tokenStore.queryCount == 1)
    }
}
