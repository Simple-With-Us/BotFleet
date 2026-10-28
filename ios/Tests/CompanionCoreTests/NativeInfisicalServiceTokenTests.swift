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

/// An HTTP transport that records every request and answers the two Infisical
/// endpoints the resolver uses.  No network is touched.
private final class RecordingInfisicalTransport: InfisicalHTTPTransportProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var requests: [URLRequest] = []
    private let secrets: [[String: String]]
    private let loginToken: String

    init(secrets: [String: String] = [:], loginToken: String = "universal-auth-access-token-fixture") {
        self.secrets = secrets.map { ["secretKey": $0.key, "secretValue": $0.value] }
        self.loginToken = loginToken
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
        if url.path.hasSuffix("/api/v3/secrets/raw") {
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

    @Test("A stored service token is the bearer and no Universal Auth login is sent")
    func testServiceTokenAuthenticatesWithoutALoginRequest() async throws {
        let tokenStore = ScriptedKeychainStore(stored: Data(fixtureServiceToken.utf8))
        let identityStore = ScriptedKeychainStore()
        let transport = RecordingInfisicalTransport(secrets: ["BOTFLEET_SERVER_MODE": "local"])
        let resolver = NativeInfisicalResolver(
            keychain: identityStore,
            serviceTokenStore: tokenStore,
            transport: transport
        )

        let names = try await resolver.refreshSecretsSnapshot()

        #expect(names == ["BOTFLEET_SERVER_MODE"])
        #expect(transport.requests.count == 1)
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
            keychain: ScriptedKeychainStore(),
            serviceTokenStore: tokenStore,
            transport: transport
        )

        _ = try await resolver.refreshSecretsSnapshot()

        let request = transport.requests[0]
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
        let transport = RecordingInfisicalTransport()
        let resolver = NativeInfisicalResolver(
            keychain: ScriptedKeychainStore(),
            serviceTokenStore: tokenStore,
            scope: scope,
            transport: transport
        )

        _ = try await resolver.refreshSecretsSnapshot()

        let query = queryPairs(of: transport.requests[0])
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

    @Test("Without a service token the machine identity still opens the vault through Universal Auth")
    func testMachineIdentityFallbackStillLogsIn() async throws {
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
            keychain: ScriptedKeychainStore(),
            serviceTokenStore: tokenStore,
            transport: transport
        )

        let first = try await resolver.resolveSecret(forKey: fixtureSecretName)
        let second = try await resolver.resolveSecret(forKey: fixtureSecretName)

        #expect(first.exposeSecret() == "cached-value")
        #expect(second.exposeSecret() == "cached-value")
        #expect(transport.requests.count == 1)
        #expect(tokenStore.queryCount == 1)
    }
}
