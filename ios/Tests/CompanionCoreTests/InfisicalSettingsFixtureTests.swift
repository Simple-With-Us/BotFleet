import Foundation
import Testing
@testable import CompanionCore

/// The fake-credential fixture for BF-2622.
///
/// One operator selection for the optional secret store is saved and read back
/// over the real wire format: the same `PUT /api/config` body and the same
/// `GET /api/infisical/status` answer the native Settings form uses.
///
/// Nothing here touches a real credential, a live workspace or the network.
/// Every token reference is a fake path or a fake environment variable name,
/// and no value that could be a credential is ever written, read or asserted.
@Suite("Infisical settings fixture")
struct InfisicalSettingsFixtureTests {
    @Test("The selected primary project, environment and folder survive the save and read back")
    @MainActor
    func primarySelectionSurvivesTheRoundTrip() async throws {
        let server = FixtureSettingsServer()
        let endpoint = try FixtureSettingsEndpoint(server: server)
        let coordinator = FixtureSettingsCoordinator.make(endpoint: endpoint)

        coordinator.syncHosts([endpoint.host])
        await coordinator.refresh()
        #expect(coordinator.snapshot != nil)

        coordinator.draft.enabled = true
        coordinator.draft.authMethod = .serviceToken
        coordinator.draft.projectId = "primary-project"
        coordinator.draft.environment = "prod"
        coordinator.draft.secretPath = "/app"
        await coordinator.save()

        #expect(coordinator.errorMessage == nil)
        #expect(coordinator.statusMessage == "Secrets settings saved.")
        let saved = try #require(server.saved.first)
        #expect(saved["projectId"] as? String == "primary-project")
        #expect(saved["environment"] as? String == "prod")
        #expect(saved["secretPath"] as? String == "/app")

        // The readback answers with the selection the operator made, and the
        // form shows that same selection again.
        #expect(coordinator.snapshot?.projectId == "primary-project")
        #expect(coordinator.snapshot?.environment == "prod")
        #expect(coordinator.snapshot?.secretPath == "/app")
        #expect(coordinator.draft.projectId == "primary-project")
        #expect(coordinator.draft.environment == "prod")
        #expect(coordinator.draft.secretPath == "/app")
    }

    @Test("A read reference and a write reference stay separate across the save and the readback")
    @MainActor
    func readAndWriteReferencesStaySeparate() async throws {
        let server = FixtureSettingsServer()
        let endpoint = try FixtureSettingsEndpoint(server: server)
        let coordinator = FixtureSettingsCoordinator.make(endpoint: endpoint)

        coordinator.syncHosts([endpoint.host])
        await coordinator.refresh()

        var both = InfisicalTokenSourceSettings()
        both.name = "primary-app"
        both.projectId = "primary-project"
        both.environment = "prod"
        both.secretPath = "/app"
        both.tokenEnv = "BF_FIXTURE_READ_TOKEN"
        both.writeTokenFile = "/fixture/write-token"

        var writeOnly = InfisicalTokenSourceSettings()
        writeOnly.name = "write-only"
        writeOnly.projectId = "write-project"
        writeOnly.environment = "prod"
        writeOnly.secretPath = "/write-only"
        writeOnly.writeTokenEnv = "BF_FIXTURE_WRITE_ONLY_TOKEN"

        var readOnly = InfisicalTokenSourceSettings()
        readOnly.name = "read-only"
        readOnly.projectId = "read-project"
        readOnly.environment = "prod"
        readOnly.secretPath = "/read-only"
        readOnly.tokenEnv = "BF_FIXTURE_READ_ONLY_TOKEN"

        coordinator.draft.enabled = true
        coordinator.draft.projectId = "primary-project"
        coordinator.draft.environment = "prod"
        coordinator.draft.secretPath = "/app"
        coordinator.draft.readSources = [both, writeOnly, readOnly]
        await coordinator.save()

        #expect(coordinator.errorMessage == nil)

        // The saved body carries the read reference and the write reference as
        // two separate fields, and a reference that was never set is absent.
        let savedSection = try #require(server.saved.first)
        let savedSources = try #require(savedSection["readSources"] as? [[String: Any]])
        #expect(savedSources.count == 3)
        let savedPrimary = try #require(savedSources[safe: 0])
        let savedWriteOnly = try #require(savedSources[safe: 1])
        let savedReadOnly = try #require(savedSources[safe: 2])
        #expect(savedPrimary["tokenEnv"] as? String == "BF_FIXTURE_READ_TOKEN")
        #expect(savedPrimary["writeTokenFile"] as? String == "/fixture/write-token")
        #expect(savedPrimary.keys.contains("tokenFile") == false)
        #expect(savedWriteOnly.keys.contains("tokenEnv") == false)
        #expect(savedWriteOnly.keys.contains("tokenFile") == false)
        #expect(savedWriteOnly["writeTokenEnv"] as? String == "BF_FIXTURE_WRITE_ONLY_TOKEN")
        #expect(savedReadOnly.keys.contains("writeTokenFile") == false)
        #expect(savedReadOnly.keys.contains("writeTokenEnv") == false)

        // The readback keeps the same separation: a write-only source comes
        // back without a read reference, and a read-only source comes back
        // without a write reference.
        let readback = try #require(coordinator.snapshot?.readSources)
        #expect(readback.count == 3)
        let primary = try #require(readback.first { $0.name == "primary-app" })
        #expect(primary.tokenEnv == "BF_FIXTURE_READ_TOKEN")
        #expect(primary.writeTokenFile == "/fixture/write-token")
        #expect(primary.tokenFile.isEmpty)
        let writeOnlySource = try #require(readback.first { $0.name == "write-only" })
        #expect(writeOnlySource.writeTokenEnv == "BF_FIXTURE_WRITE_ONLY_TOKEN")
        #expect(writeOnlySource.tokenEnv.isEmpty)
        #expect(writeOnlySource.tokenFile.isEmpty)
        let readOnlySource = try #require(readback.first { $0.name == "read-only" })
        #expect(readOnlySource.tokenEnv == "BF_FIXTURE_READ_ONLY_TOKEN")
        #expect(readOnlySource.writeTokenEnv.isEmpty)
        #expect(readOnlySource.writeTokenFile.isEmpty)
    }

    @Test("The optional connection and the selected authentication method never activate one another")
    @MainActor
    func optionalConnectionAndAuthenticationMethodStayIndependent() async throws {
        let server = FixtureSettingsServer()
        let endpoint = try FixtureSettingsEndpoint(server: server)
        let coordinator = FixtureSettingsCoordinator.make(endpoint: endpoint)

        coordinator.syncHosts([endpoint.host])
        await coordinator.refresh()

        // The connection off with the machine identity selected.
        coordinator.draft.enabled = false
        coordinator.draft.authMethod = .machineIdentity
        coordinator.draft.projectId = "primary-project"
        await coordinator.save()

        #expect(coordinator.errorMessage == nil)
        let savedOff = try #require(server.saved[safe: 0])
        #expect(savedOff["enabled"] as? Bool == false)
        #expect(savedOff["authMethod"] as? String == "machine-identity")
        #expect(coordinator.snapshot?.enabled == false)
        #expect(coordinator.snapshot?.authMethod == .machineIdentity)
        // The form still shows the two switches as they were chosen.
        #expect(coordinator.draft.enabled == false)
        #expect(coordinator.draft.authMethod == .machineIdentity)

        // The connection on with the service token selected: neither switch
        // rewrites the other on the way through the save.
        coordinator.draft.enabled = true
        coordinator.draft.authMethod = .serviceToken
        await coordinator.save()

        #expect(coordinator.errorMessage == nil)
        let savedOn = try #require(server.saved[safe: 1])
        #expect(savedOn["enabled"] as? Bool == true)
        #expect(savedOn["authMethod"] as? String == "service-token")
        #expect(coordinator.snapshot?.enabled == true)
        #expect(coordinator.snapshot?.authMethod == .serviceToken)
        #expect(coordinator.draft.enabled == true)
        #expect(coordinator.draft.authMethod == .serviceToken)

        // A credential value never rides along with either mode.
        let encoded = String(decoding: try JSONEncoder().encode(coordinator.draft), as: UTF8.self)
        #expect(!encoded.contains("fixture-raw-credential-never-stored"))
    }
}

/// The coordinator under test, wired to the real settings client so the wire
/// format is the one the product sends.
private enum FixtureSettingsCoordinator {
    @MainActor
    static func make(endpoint: FixtureSettingsEndpoint) -> InfisicalSettingsCoordinator {
        InfisicalSettingsCoordinator(tokens: FixtureGateCredentials(),
            fetcher: { host, credential in
                try await InfisicalSettingsClient(session: endpoint.session).fetch(host: host, credential: credential)
            },
            saver: { host, credential, draft in
                try await InfisicalSettingsClient(session: endpoint.session).save(host: host, credential: credential, draft: draft)
            })
    }
}

/// The stand-in for the settings server: it stores what the form saved and
/// answers the status route from that stored section.
private final class FixtureSettingsServer: @unchecked Sendable {
    private let lock = NSLock()
    private var savedSections: [[String: Any]] = []

    func save(_ section: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        savedSections.append(section)
    }

    var saved: [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return savedSections
    }

    /// The status payload the server would answer with, built from the last
    /// section the form saved.
    func status() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let section = savedSections.last ?? [:]
        let enabled = section["enabled"] as? Bool ?? false
        let sources = (section["readSources"] as? [[String: Any]]) ?? []
        return [
            "enabled": enabled,
            "enabledSetting": enabled,
            "authMethod": section["authMethod"] as? String ?? "service-token",
            "siteUrl": section["siteUrl"] as? String ?? "https://vault.fixture.test",
            "projectId": section["projectId"] as? String ?? "",
            "environment": section["environment"] as? String ?? "prod",
            "secretPath": section["secretPath"] as? String ?? "/",
            "hasClientId": false,
            "hasClientSecret": false,
            "hasToken": false,
            "hasWriteToken": false,
            "readSources": sources.map { source in
                var row: [String: Any] = [
                    "name": source["name"] as? String ?? "",
                    "projectId": source["projectId"] as? String ?? "",
                    "environment": source["environment"] as? String ?? "prod",
                    "secretPath": source["secretPath"] as? String ?? "/",
                ]
                for key in ["tokenFile", "tokenEnv", "writeTokenFile", "writeTokenEnv"] {
                    if let value = source[key] as? String, !value.isEmpty { row[key] = value }
                }
                return row
            },
        ]
    }
}

private final class FixtureSettingsProtocol: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    private static var servers: [String: FixtureSettingsServer] = [:]

    static func register(_ host: String, _ server: FixtureSettingsServer) {
        lock.lock()
        defer { lock.unlock() }
        servers[host] = server
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        Self.lock.lock()
        let server = Self.servers[url.host ?? ""]
        Self.lock.unlock()
        guard let server else { return }

        var payload: [String: Any] = [:]
        if request.httpMethod == "PUT" {
            // URLSession hands a body to a custom protocol as a stream, so
            // the bytes are read from there and not from `httpBody`.
            let body = requestBody(request)
            if let body, let object = try? JSONSerialization.jsonObject(with: body),
               let patch = object as? [String: Any],
               let section = patch["infisical"] as? [String: Any] {
                server.save(section)
            }
            payload = ["infisical": server.saved.last ?? [:]]
        } else {
            payload = ["infisical": server.status()]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// The bytes of a request body, whether URLSession left them in the request
/// or moved them into a stream.
private func requestBody(_ request: URLRequest) -> Data? {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    let size = 4096
    var buffer = [UInt8](repeating: 0, count: size)
    while stream.hasBytesAvailable {
        let read = stream.read(&buffer, maxLength: size)
        if read <= 0 { break }
        data.append(contentsOf: buffer[0..<read])
    }
    return data
}

private struct FixtureSettingsEndpoint {
    let host: HostRecord
    let session: URLSession

    init(server: FixtureSettingsServer) throws {
        let name = "settings-\(UUID().uuidString.lowercased()).test"
        host = HostRecord(name: "Fixture", origin: try HostOrigin("https://\(name)"))
        FixtureSettingsProtocol.register(name, server)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FixtureSettingsProtocol.self]
        config.timeoutIntervalForRequest = 2
        session = URLSession(configuration: config)
    }
}

/// A subscript that fails the test instead of trapping the whole run when
/// the list is shorter than the test expects.
private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

private struct FixtureGateCredentials: HostTokenStore {
    func read(for host: HostRecord) throws -> HostGateCredential? {
        try HostGateCredential(origin: host.origin, token: RedactedSecret("fixture-gate-token"))
    }
    func write(_ token: RedactedSecret, for host: HostRecord) throws { Issue.record("Unexpected credential write") }
    func remove(recordID: String) throws { Issue.record("Unexpected credential removal") }
}
