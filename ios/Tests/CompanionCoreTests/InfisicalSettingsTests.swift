import Foundation
import Testing
@testable import CompanionCore

@Suite("Native Infisical settings")
struct InfisicalSettingsTests {
    @Test("The native form accepts write-only sources and shares the server's 32-source limit")
    func sourceValidationMatchesServer() throws {
        var draft = InfisicalSettingsDraft()
        draft.readSources = (0..<32).map { index in
            var source = InfisicalTokenSourceSettings()
            source.name = "source-\(index)"; source.projectId = "project-\(index)"
            source.writeTokenEnv = "APP_WRITE_TOKEN_\(index)"
            return source
        }
        try draft.validate()
        var extra = InfisicalTokenSourceSettings()
        extra.name = "extra"; extra.projectId = "extra"; extra.tokenEnv = "EXTRA_READ_TOKEN"
        draft.readSources.append(extra)
        #expect(throws: (any Error).self) { try draft.validate() }
    }

    @Test("Settings patches contain metadata only and never assert external credential storage")
    func metadataOnlyRequest() throws {
        let host = HostRecord(name: "Fixture", origin: try HostOrigin("https://settings.test"))
        let credential = try HostGateCredential(origin: host.origin, token: RedactedSecret("fixture-gate"))
        var draft = InfisicalSettingsDraft(snapshot: try settingsSnapshot(project: "project-one"))
        var source = InfisicalTokenSourceSettings()
        source.name = "project-two"; source.projectId = "two"; source.environment = "dev"
        source.secretPath = "/folder"; source.tokenEnv = "APP_READ_TOKEN"; source.writeTokenFile = "/private/app/write-token"
        draft.readSources = [source]
        draft.enabled = true; draft.authMethod = .machineIdentity
        let request = try InfisicalSettingsClient.request(host: host, credential: credential, draft: draft)
        #expect(request.httpMethod == "PUT")
        #expect(request.url?.absoluteString == "https://settings.test/api/config")
        #expect(request.value(forHTTPHeaderField: "x-botfleet-gate-token") == "fixture-gate")
        let payload = try #require(request.httpBody)
        let object = try #require(JSONSerialization.jsonObject(with: payload) as? [String: Any])
        let patch = try #require(object["infisical"] as? [String: Any])
        #expect(Set(patch.keys) == ["enabled", "authMethod", "siteUrl", "projectId", "environment", "secretPath", "readSources"])
        #expect(patch["authMethod"] as? String == "machine-identity")
        let sources = try #require(patch["readSources"] as? [[String: Any]])
        #expect(Set(sources[0].keys) == ["name", "projectId", "environment", "secretPath", "tokenEnv", "writeTokenFile"])
        #expect(sources[0]["tokenEnv"] as? String == "APP_READ_TOKEN")
        #expect(sources[0]["writeTokenFile"] as? String == "/private/app/write-token")
        #expect(!String(decoding: payload, as: UTF8.self).contains("unexpected-raw-credential"))
    }

    @Test("Remote settings require a credential bound to the exact selected origin")
    func credentialOriginIsExact() throws {
        let first = HostRecord(name: "First", origin: try HostOrigin("https://one.test"))
        let other = HostRecord(name: "Other", origin: try HostOrigin("https://two.test"))
        let credential = try HostGateCredential(origin: first.origin, token: RedactedSecret("fixture-gate"))
        #expect(throws: SavedHostError.credentialUnavailable) { try InfisicalSettingsClient.request(host: first, credential: nil) }
        #expect(throws: (any Error).self) { try InfisicalSettingsClient.request(host: other, credential: credential) }
        let request = try InfisicalSettingsClient.request(host: .thisMac, credential: nil)
        #expect(request.url?.path == "/api/infisical/status")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test("Administrative HTTP refusals stay refusals without echoing the response body")
    func serverRefusalStaysVisible() async throws {
        let fixture = SettingsHTTPFixture(status: 403, data: Data("unexpected-raw-credential".utf8))
        let client = InfisicalSettingsClient(session: fixture.session)
        let host = HostRecord(name: "Fixture", origin: fixture.origin)
        let credential = try HostGateCredential(origin: host.origin, token: RedactedSecret("fixture-gate"))
        do {
            _ = try await client.fetch(host: host, credential: credential)
            Issue.record("An administrative refusal was accepted")
        } catch {
            #expect(error as? InfisicalSettingsError == .refused(403))
            #expect(!error.localizedDescription.contains("unexpected-raw-credential"))
        }
    }

    @Test("Status values and presence flags never become raw credentials in a later patch")
    func statusDoesNotRoundTripSecrets() throws {
        let snapshot = try settingsSnapshot(project: "one")
        #expect(snapshot.authMethod == .serviceToken)
        #expect(snapshot.hasToken)
        let data = try JSONEncoder().encode(InfisicalSettingsDraft(snapshot: snapshot))
        #expect(!String(decoding: data, as: UTF8.self).contains("unexpected-raw-credential"))
        #expect(!String(decoding: data, as: UTF8.self).contains("hasToken"))
    }

    @Test("An enabled but unconfigured host keeps its saved toggle and project metadata")
    func incompleteSetupRetainsMetadata() throws {
        let payload = #"{"enabled":false,"enabledSetting":true,"configured":false,"authMethod":"service-token","projectId":"partially-configured-project","siteUrl":"https://vault.test","environment":"dev","secretPath":"/app","hasToken":false}"#
        let snapshot = try JSONDecoder().decode(InfisicalSettingsSnapshot.self, from: Data(payload.utf8))
        let draft = InfisicalSettingsDraft(snapshot: snapshot)
        #expect(draft.enabled)
        #expect(draft.projectId == "partially-configured-project")
        #expect(draft.environment == "dev")
        #expect(draft.secretPath == "/app")
        #expect(!snapshot.hasToken)
    }

    @Test("Stale host fetches cannot replace the new host's form")
    @MainActor
    func staleFetchCannotCrossHosts() async throws {
        let first = HostRecord(name: "One", origin: try HostOrigin("https://one.test"))
        let second = HostRecord(name: "Two", origin: try HostOrigin("https://two.test"))
        let gate = SettingsFetchGate(firstID: first.id)
        let coordinator = InfisicalSettingsCoordinator(tokens: SettingsTestCredentials(),
            fetcher: { host, _ in try await gate.fetch(host) }, saver: { _, _, _ in })
        coordinator.syncHosts([first, second])
        let old = Task { await coordinator.refresh() }
        try await gate.waitForFirst()
        await coordinator.selectHost(id: second.id)
        #expect(coordinator.draft.projectId == "second")
        try await gate.releaseFirst()
        await old.value
        #expect(coordinator.selectedHostID == second.id)
        #expect(coordinator.snapshot?.projectId == "second")
        #expect(coordinator.draft.projectId == "second")
        #expect(!coordinator.isLoading)
    }

    @Test("A pending save keeps its captured host and cannot mark another host saved")
    @MainActor
    func staleSaveCannotCrossHosts() async throws {
        let first = HostRecord(name: "One", origin: try HostOrigin("https://one.test"))
        let second = HostRecord(name: "Two", origin: try HostOrigin("https://two.test"))
        let gate = SettingsSaveGate()
        let coordinator = InfisicalSettingsCoordinator(tokens: SettingsTestCredentials(),
            fetcher: { host, _ in try settingsSnapshot(project: host.id) },
            saver: { host, _, draft in await gate.save(host, draft) })
        coordinator.syncHosts([first, second])
        await coordinator.refresh()
        coordinator.draft.enabled = true
        let save = Task { await coordinator.save() }
        try await gate.waitForStart()
        await coordinator.selectHost(id: second.id)
        await gate.release()
        await save.value
        #expect(await gate.hostID == first.id)
        #expect(await gate.projectID == first.id)
        #expect(coordinator.snapshot?.projectId == second.id)
        #expect(coordinator.draft.projectId == second.id)
        #expect(coordinator.statusMessage == nil)
        #expect(!coordinator.isSaving)
    }

    @Test("An origin change invalidates a loaded form and Secrets has its own Settings route")
    @MainActor
    func originChangeInvalidatesDraft() async throws {
        let first = HostRecord(name: "One", origin: try HostOrigin("https://one.test"))
        let coordinator = InfisicalSettingsCoordinator(tokens: SettingsTestCredentials(),
            fetcher: { _, _ in try settingsSnapshot(project: "one") }, saver: { _, _, _ in })
        coordinator.syncHosts([first])
        await coordinator.refresh()
        var changed = first
        changed.origin = try HostOrigin("https://changed.test")
        coordinator.syncHosts([changed])
        #expect(coordinator.snapshot == nil)
        #expect(coordinator.draft.projectId.isEmpty)
        #expect(MacSettingsDeepLinkRouter.section(for: URL(string: "botfleet://settings/secrets")!) == .secrets)
    }
}

private func settingsSnapshot(project: String) throws -> InfisicalSettingsSnapshot {
    let object: [String: Any] = [
        "enabled": false, "authMethod": "service-token", "siteUrl": "https://vault.test",
        "projectId": project, "environment": "prod", "secretPath": "/",
        "hasToken": true, "hasWriteToken": false, "hasClientId": true, "hasClientSecret": true,
        "token": "unexpected-raw-credential", "clientSecret": "unexpected-raw-credential", "readSources": [],
    ]
    return try JSONDecoder().decode(InfisicalSettingsSnapshot.self, from: JSONSerialization.data(withJSONObject: object))
}

private struct SettingsTestCredentials: HostTokenStore {
    func read(for host: HostRecord) throws -> HostGateCredential? {
        if host.isLocal { return nil }
        return try HostGateCredential(origin: host.origin, token: RedactedSecret("fixture-gate"))
    }
    func write(_ token: RedactedSecret, for host: HostRecord) throws { Issue.record("Unexpected credential write") }
    func remove(recordID: String) throws { Issue.record("Unexpected credential removal") }
}

private actor SettingsFetchGate {
    let firstID: String
    private var started = false
    private var pending: CheckedContinuation<InfisicalSettingsSnapshot, Never>?
    init(firstID: String) { self.firstID = firstID }
    func fetch(_ host: HostRecord) async throws -> InfisicalSettingsSnapshot {
        if host.id != firstID { return try settingsSnapshot(project: "second") }
        started = true
        return await withCheckedContinuation { pending = $0 }
    }
    func waitForFirst() async throws {
        for _ in 0..<200 {
            if started { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw SettingsFixtureError.didNotStart
    }
    func releaseFirst() throws { pending?.resume(returning: try settingsSnapshot(project: "first")); pending = nil }
}

private actor SettingsSaveGate {
    private var started = false
    private var pending: CheckedContinuation<Void, Never>?
    private(set) var hostID: String?
    private(set) var projectID: String?
    func save(_ host: HostRecord, _ draft: InfisicalSettingsDraft) async {
        hostID = host.id; projectID = draft.projectId
        started = true
        await withCheckedContinuation { pending = $0 }
    }
    func waitForStart() async throws {
        for _ in 0..<200 {
            if started { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw SettingsFixtureError.didNotStart
    }
    func release() { pending?.resume(); pending = nil }
}

private enum SettingsFixtureError: Error { case didNotStart }

private final class SettingsFixtureProtocol: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    private static var responses: [String: (Int, Data)] = [:]
    static func set(_ host: String, _ status: Int, _ data: Data) {
        lock.lock(); defer { lock.unlock() }; responses[host] = (status, data)
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url else { return }
        Self.lock.lock(); let pair = Self.responses[url.host ?? ""]; Self.lock.unlock()
        guard let (status, data) = pair,
              let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private struct SettingsHTTPFixture {
    let session: URLSession
    let origin: HostOrigin
    init(status: Int, data: Data) {
        let host = "settings-\(UUID().uuidString.lowercased()).test"
        origin = try! HostOrigin("https://\(host)")
        SettingsFixtureProtocol.set(host, status, data)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SettingsFixtureProtocol.self]
        config.timeoutIntervalForRequest = 2
        session = URLSession(configuration: config)
    }
}
