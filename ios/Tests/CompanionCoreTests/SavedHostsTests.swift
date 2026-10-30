import XCTest
import Darwin
@testable import CompanionCore

final class SavedHostsTests: XCTestCase {
    private func temporaryStore() throws -> (URL, HostStore) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("host-store-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("hosts.json")
        return (file, HostStore(fileURL: file))
    }
    func testOriginPolicy() throws {
        for value in ["https://EXAMPLE.test:443/", "http://localhost:1234", "http://127.23.1.2:8799", "http://[::1]:8799"] {
            XCTAssertNoThrow(try HostOrigin(value), value)
        }
        XCTAssertEqual(try HostOrigin("https://EXAMPLE.test:443/"), try HostOrigin("https://example.test"))
        for value in ["", "http://example.test", "http://127.999.1.1", "ftp://example.test", "https://user:secret@example.test", "https://example.test/path", "https://example.test/?", "https://example.test/#", "https://example.test:0", "https://example.test\\@other.test", "https://exa mple.test"] {
            XCTAssertThrowsError(try HostOrigin(value), value)
        }
    }
    func testStoreSeedsOnlyLocalAndWritesPrivateMetadata() async throws {
        let (file, store) = try temporaryStore()
        let initial = try await store.hosts()
        XCTAssertEqual(initial, [.thisMac])
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        let remote = HostRecord(name: "Test Server", origin: try HostOrigin("https://fixture.test"))
        try await store.upsert(remote)
        let loaded = try await HostStore(fileURL: file).hosts()
        XCTAssertEqual(loaded, [.thisMac, remote])
        let attrs = try FileManager.default.attributesOfItem(atPath: file.path)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        let text = try String(contentsOf: file, encoding: .utf8)
        XCTAssertFalse(text.contains("token"))
        XCTAssertFalse(text.contains("auth"))
        var changed = remote; changed.origin = try HostOrigin("https://different.test")
        do { try await store.upsert(changed); XCTFail("Changing origin must require new enrollment") }
        catch { XCTAssertEqual(error as? SavedHostError, .differentOrigin) }
    }
    func testUnreadableStoreIsPreservedAndCannotBeOverwritten() async throws {
        let (file, store) = try temporaryStore()
        let original = Data("{broken".utf8)
        try original.write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        do { try await store.upsert(.thisMac); XCTFail("Unreadable store must refuse save") }
        catch { XCTAssertEqual(error as? SavedHostError, .unreadableStore) }
        for _ in 0..<3 {
            do { _ = try await HostStore(fileURL: file).hosts(); XCTFail("Corruption must remain visible") }
            catch { XCTAssertEqual(error as? SavedHostError, .unreadableStore) }
        }
        XCTAssertEqual(try Data(contentsOf: file), original)
        let backups = try FileManager.default.contentsOfDirectory(atPath: file.deletingLastPathComponent().path)
        XCTAssertEqual(backups.filter { $0.contains(".corrupt.") }, ["hosts.json.corrupt.json"])
    }
    func testSymlinkIsRefusedWithoutFollowingOrReplacingIt() async throws {
        let (file, store) = try temporaryStore()
        let target = file.deletingLastPathComponent().appendingPathComponent("missing.json")
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: target)
        do { try await store.upsert(.thisMac); XCTFail("Symlink must be refused") }
        catch { XCTAssertEqual(error as? SavedHostError, .unreadableStore) }
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: file.path), target.path)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }
    func testNamedPipeIsRefusedWithoutWaitingForAWriter() async throws {
        let (file, store) = try temporaryStore()
        XCTAssertEqual(mkfifo(file.path, 0o600), 0)
        do { _ = try await store.hosts(); XCTFail("Nonregular store must fail") }
        catch { XCTAssertEqual(error as? SavedHostError, .unreadableStore) }
    }
    func testSharedWritableParentIsRefusedWithoutCreatingAStore() async throws {
        let (file, store) = try temporaryStore()
        try FileManager.default.setAttributes([.posixPermissions: 0o777], ofItemAtPath: file.deletingLastPathComponent().path)
        do { try await store.upsert(.thisMac); XCTFail("Unsafe parent must fail") }
        catch { XCTAssertEqual(error as? SavedHostError, .unreadableStore) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }
    func testHardLinkedStoreIsRefusedWithoutChangingEitherEntry() async throws {
        let (file, store) = try temporaryStore()
        try await store.upsert(.thisMac)
        let original = try Data(contentsOf: file)
        let alias = file.appendingPathExtension("alias")
        try FileManager.default.linkItem(at: file, to: alias)
        do { try await store.upsert(.thisMac); XCTFail("Hard-linked store must fail") }
        catch { XCTAssertEqual(error as? SavedHostError, .unreadableStore) }
        XCTAssertEqual(try Data(contentsOf: file), original)
        XCTAssertEqual(try Data(contentsOf: alias), original)
    }
    func testSavedAndAppliedRemainDistinctAndRemovalHonorsOwnership() async throws {
        let (_, store) = try temporaryStore()
        let hostID = "server:11111111-1111-4111-8111-111111111111"
        let remote = HostRecord(name: "Server", origin: try HostOrigin("https://fixture.test"), hostId: hostID)
        try await store.upsert(remote)
        for id in [HostRecord.localID, remote.id] {
            do { try await store.remove(id: id, controllerID: hostID, leasedHostIDs: []); XCTFail("Owned host must remain") }
            catch { XCTAssertEqual(error as? SavedHostError, id == HostRecord.localID ? .localAnchor : .hostInUse) }
        }
        let selection = PlacementSelection(mode: .serverFirst, serverID: remote.id, allowOverflowToThisMac: true)
        try await store.save(selection)
        let saved = try await store.settings()
        XCTAssertTrue(saved.hasUnappliedChanges)
        XCTAssertEqual(saved.applied.mode, .localOnly)
        try await store.recordApplied(selection)
        let applied = try await store.settings()
        XCTAssertFalse(applied.hasUnappliedChanges)
        do { try await store.remove(id: remote.id, controllerID: nil, leasedHostIDs: []); XCTFail("Applied selection must remain") }
        catch { XCTAssertEqual(error as? SavedHostError, .hostInUse) }
    }
    func testGateCredentialIsBoundToOriginAndRedirectsStayThere() throws {
        let origin = try HostOrigin("https://fixture.test")
        let gate = try HostGateCredential(origin: origin, token: RedactedSecret("fixture-only-secret"))
        var allowed = URLRequest(url: URL(string: "https://fixture.test/api/config")!)
        try gate.authorize(&allowed)
        XCTAssertEqual(allowed.value(forHTTPHeaderField: "x-botfleet-gate-token"), "fixture-only-secret")
        var other = URLRequest(url: URL(string: "https://other.test/api/config")!)
        XCTAssertThrowsError(try gate.authorize(&other))
        XCTAssertNil(other.value(forHTTPHeaderField: "x-botfleet-gate-token"))
        XCTAssertFalse(String(describing: gate).contains("fixture-only-secret"))
        let policy = HostOriginRedirectPolicy(origin: origin)
        XCTAssertTrue(policy.allows(allowed.url))
        XCTAssertFalse(policy.allows(other.url))
        XCTAssertFalse(policy.allows(URL(string: "http://fixture.test/api/config")))
        XCTAssertThrowsError(try HostGateCredential(origin: origin, token: RedactedSecret("bad\nheader")))
    }
    func testProtectedCredentialRestoresOnlyItsEnrolledOriginAndRecord() throws {
        let host = HostRecord(name: "Pinned", origin: try HostOrigin("https://fixture.test"), hostId: "server:11111111-1111-4111-8111-111111111111")
        let data = try KeychainHostTokenStore.encode(RedactedSecret("fixture-protected-token"), for: host)
        let gate = try KeychainHostTokenStore.decode(data, for: host)
        var request = URLRequest(url: host.origin.url.appendingPathComponent("health"))
        try gate.authorize(&request)
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-botfleet-gate-token"), "fixture-protected-token")
        var tampered = host; tampered.origin = try HostOrigin("https://other.test")
        XCTAssertThrowsError(try KeychainHostTokenStore.decode(data, for: tampered)) { error in
            XCTAssertEqual(error as? SavedHostError, .differentOrigin)
        }
        let other = HostRecord(name: host.name, origin: host.origin, hostId: host.hostId)
        XCTAssertThrowsError(try KeychainHostTokenStore.decode(data, for: other)) { error in
            XCTAssertEqual(error as? SavedHostError, .credentialUnavailable)
        }
        // Keychain lookup uses the metadata UUID; the pinned remote identity is a separate field.
        XCTAssertNoThrow(try KeychainHostTokenStore.query(recordID: host.id))
        XCTAssertThrowsError(try KeychainHostTokenStore.query(recordID: host.hostId!))
    }
    func testProtectedCredentialRejectsMalformedLegacyAndFutureDataWithoutEchoingSecrets() throws {
        let host = HostRecord(name: "Server", origin: try HostOrigin("https://fixture.test"))
        let valid = try KeychainHostTokenStore.encode(RedactedSecret("fixture-secret"), for: host)
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: valid) as? [String: Any])
        json["schema"] = 2
        let future = try JSONSerialization.data(withJSONObject: json)
        json["schema"] = 1; json["extra"] = "fixture-secret"
        let unknownField = try JSONSerialization.data(withJSONObject: json)
        for data in [Data("fixture-secret".utf8), Data("{broken".utf8), future, unknownField] {
            XCTAssertThrowsError(try KeychainHostTokenStore.decode(data, for: host)) { error in
                XCTAssertEqual(error as? SavedHostError, .credentialUnavailable)
                XCTAssertFalse(error.localizedDescription.contains("fixture-secret"))
            }
        }
    }
    func testProtectedCredentialRefusesChangedOrNewIdentityPinsUntilExplicitEnrollment() throws {
        var host = HostRecord(name: "Server", origin: try HostOrigin("https://fixture.test"))
        let beforePin = try KeychainHostTokenStore.encode(RedactedSecret("fixture-secret"), for: host)
        XCTAssertNoThrow(try KeychainHostTokenStore.decode(beforePin, for: host))
        host.hostId = "server:11111111-1111-4111-8111-111111111111"
        XCTAssertThrowsError(try KeychainHostTokenStore.decode(beforePin, for: host)) { error in
            XCTAssertEqual(error as? SavedHostError, .differentHost)
        }
        let enrolled = try KeychainHostTokenStore.encode(RedactedSecret("fixture-secret"), for: host)
        XCTAssertNoThrow(try KeychainHostTokenStore.decode(enrolled, for: host))
        for changedPin in [nil, "server:22222222-2222-4222-8222-222222222222"] as [String?] {
            var changed = host; changed.hostId = changedPin
            XCTAssertThrowsError(try KeychainHostTokenStore.decode(enrolled, for: changed)) { error in
                XCTAssertEqual(error as? SavedHostError, .differentHost)
            }
        }
    }
    func testLocalAnchorOriginCannotDrift() async throws {
        let (_, store) = try temporaryStore()
        var changed = HostRecord.thisMac
        changed.origin = try HostOrigin("http://127.0.0.1:8801")
        do { try await store.upsert(changed); XCTFail("Local origin must remain pinned") }
        catch { XCTAssertEqual(error as? SavedHostError, .differentOrigin) }
        let hosts = try await store.hosts()
        XCTAssertEqual(hosts, [.thisMac])
    }
    func testExplicitLocalAddressEditAllowsOnlyLoopbackHTTPAndCannotTouchRemote() async throws {
        let (_, store) = try temporaryStore()
        let remote = HostRecord(name: "Remote", origin: try HostOrigin("https://fixture.test"))
        try await store.upsert(remote)
        let edited = try HostOrigin("http://[::1]:8801")
        try await store.updateThisMacOrigin(edited)
        let records = try await store.hosts()
        XCTAssertEqual(records.first?.id, HostRecord.localID)
        XCTAssertEqual(records.first?.origin, edited)
        XCTAssertEqual(records.last, remote)
        do { try await store.updateThisMacOrigin(HostOrigin("https://fixture.test")); XCTFail("Remote local origin must fail") }
        catch { XCTAssertEqual(error as? SavedHostError, .invalidRecord) }
        do { try await store.updateThisMacOrigin(HostOrigin("https://localhost")); XCTFail("Local TLS origin must fail") }
        catch { XCTAssertEqual(error as? SavedHostError, .invalidRecord) }
        var changed = remote; changed.origin = try HostOrigin("https://other.test")
        do { try await store.upsert(changed); XCTFail("Remote origin remains immutable") }
        catch { XCTAssertEqual(error as? SavedHostError, .differentOrigin) }
    }
    func testUppercaseUUIDPinIsAcceptedAndRemainsExact() async throws {
        let (_, store) = try temporaryStore()
        let remote = HostRecord(name: "Server", origin: try HostOrigin("https://fixture.test"), hostId: "server:ABCDEF12-1234-4123-8123-ABCDEF123456")
        try await store.upsert(remote)
        let hosts = try await store.hosts()
        XCTAssertEqual(hosts.last?.hostId, remote.hostId)
        var changed = remote; changed.hostId = remote.hostId?.lowercased()
        do { try await store.upsert(changed); XCTFail("Accepted pin spelling must remain exact") }
        catch { XCTAssertEqual(error as? SavedHostError, .differentHost) }
    }
    func testEstablishedHostPinCannotBeClearedOrReplaced() async throws {
        let (_, store) = try temporaryStore()
        let pinned = HostRecord(name: "Pinned", origin: try HostOrigin("https://fixture.test"), hostId: "server:11111111-1111-4111-8111-111111111111")
        try await store.upsert(pinned)
        for value in [nil, "server:22222222-2222-4222-8222-222222222222"] as [String?] {
            var changed = pinned; changed.hostId = value
            do { try await store.upsert(changed); XCTFail("Pin must survive") }
            catch { XCTAssertEqual(error as? SavedHostError, .differentHost) }
        }
        let hosts = try await store.hosts()
        XCTAssertEqual(hosts.last, pinned)
    }
    func testSecondStoreDoesNotLoseEarlierWritesAndBusyLockRefusesMutation() async throws {
        let (file, first) = try temporaryStore()
        let second = HostStore(fileURL: file)
        let one = HostRecord(name: "One", origin: try HostOrigin("https://one.test"))
        let two = HostRecord(name: "Two", origin: try HostOrigin("https://two.test"))
        try await first.upsert(one); try await second.upsert(two)
        let hosts = try await first.hosts()
        XCTAssertEqual(Set(hosts.map(\.id)), Set([HostRecord.localID, one.id, two.id]))
        let fd = Darwin.open(file.appendingPathExtension("lock").path, O_RDWR | O_NOFOLLOW)
        XCTAssertGreaterThanOrEqual(fd, 0)
        defer { Darwin.close(fd) }
        XCTAssertEqual(flock(fd, LOCK_EX | LOCK_NB), 0)
        defer { flock(fd, LOCK_UN) }
        do { try await second.upsert(one); XCTFail("Busy lock must refuse mutation") }
        catch { XCTAssertEqual(error as? SavedHostError, .storeBusy) }
    }
}

private final class SavedHostURLProtocol: URLProtocol {
    static var reply: (URLRequest) -> (Int, [String: Any]) = { _ in (500, [:]) }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, body) = Self.reply(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class ServerHandshakeTests: XCTestCase {
    private let hostID = "server:11111111-1111-4111-8111-111111111111"
    private func client() throws -> (ServerHandshake, HostRecord, HostGateCredential) {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [SavedHostURLProtocol.self]
        let session = URLSession(configuration: config)
        addTeardownBlock { session.invalidateAndCancel() }
        let origin = try HostOrigin("https://fixture.test")
        return (ServerHandshake(session: session), HostRecord(name: "Fixture", origin: origin, hostId: hostID), try HostGateCredential(origin: origin, token: RedactedSecret("fixture-gate")))
    }
    private func responses(_ request: URLRequest, placementStatus: Int = 200) -> (Int, [String: Any]) {
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-botfleet-gate-token"), "fixture-gate")
        let common: [String: Any] = ["hostId": hostID, "version": "0.1.0", "platform": "linux", "capabilities": ["shell"]]
        switch request.url!.path {
        case "/api/health": return (200, common.merging(["app": "botfleet", "ready": true]) { _, new in new })
        case "/api/host/resources": return (200, common)
        case "/api/placement/identity": return (placementStatus, common.merging(["version": "fixture-protocol", "controllerId": hostID, "epoch": 3]) { _, new in new })
        default: XCTFail("Unexpected fixture route"); return (404, [:])
        }
    }
    func testHandshakeChecksEveryReadOnlyRoute() async throws {
        let (client, host, gate) = try client()
        var paths: [String] = []
        SavedHostURLProtocol.reply = { request in paths.append(request.url!.path); return self.responses(request) }
        let result = try await client.test(host: host, credential: gate, acceptedPlacementVersion: "fixture-protocol")
        XCTAssertEqual(result.hostId, hostID); XCTAssertEqual(result.epoch, 3)
        XCTAssertEqual(paths, ["/api/health", "/api/host/resources", "/api/placement/identity"])
    }
    func testMissingRoutesNeverEnableServerMode() async throws {
        let (client, host, gate) = try client()
        SavedHostURLProtocol.reply = { self.responses($0, placementStatus: 404) }
        do { _ = try await client.test(host: host, credential: gate, acceptedPlacementVersion: "fixture-protocol"); XCTFail("Missing routes must fail") }
        catch { XCTAssertEqual(error as? SavedHostError, .missingPlacementRoutes) }
    }
    func testChangedIdentityStopsBeforeSendingFurtherRequests() async throws {
        let (client, host, gate) = try client()
        SavedHostURLProtocol.reply = { request in
            XCTAssertEqual(request.url!.path, "/api/health")
            return (200, ["app": "botfleet", "ready": true, "hostId": "server:22222222-2222-4222-8222-222222222222", "version": "0.1.0"])
        }
        do { _ = try await client.test(host: host, credential: gate, acceptedPlacementVersion: "fixture-protocol"); XCTFail("Changed identity must fail") }
        catch { XCTAssertEqual(error as? SavedHostError, .differentHost) }
    }
    func testAuthenticationAndPlacementVersionFailures() async throws {
        let (client, host, gate) = try client()
        SavedHostURLProtocol.reply = { _ in (403, [:]) }
        do { _ = try await client.test(host: host, credential: gate, acceptedPlacementVersion: "fixture-protocol"); XCTFail("Auth must fail") }
        catch { XCTAssertEqual(error as? SavedHostError, .authentication) }
        SavedHostURLProtocol.reply = { self.responses($0) }
        do { _ = try await client.test(host: host, credential: gate, acceptedPlacementVersion: "other"); XCTFail("Protocol must fail") }
        catch { XCTAssertEqual(error as? SavedHostError, .incompatibleVersion) }
    }
    func testRemoteOriginCannotImpersonateLocalAnchor() async throws {
        let (client, host, _) = try client()
        let forged = HostRecord(id: HostRecord.localID, name: "Invalid", origin: host.origin)
        SavedHostURLProtocol.reply = { _ in XCTFail("Invalid anchor must make no request"); return (200, [:]) }
        do { _ = try await client.test(host: forged, credential: nil, acceptedPlacementVersion: "fixture-protocol"); XCTFail("Invalid anchor must fail") }
        catch { XCTAssertEqual(error as? SavedHostError, .invalidRecord) }
    }
    func testMissingResourceRouteRequiresServerUpdate() async throws {
        let (client, host, gate) = try client()
        SavedHostURLProtocol.reply = { request in request.url!.path == "/api/host/resources" ? (404, [:]) : self.responses(request) }
        do { _ = try await client.test(host: host, credential: gate, acceptedPlacementVersion: "fixture-protocol"); XCTFail("Missing resource route must fail") }
        catch { XCTAssertEqual(error as? SavedHostError, .missingPlacementRoutes) }
    }
    func testCapacityReportIsTypedOptionalAndUsesUnitsWithChicagoSampleTime() async throws {
        let (client, host, gate) = try client()
        SavedHostURLProtocol.reply = { request in
            var response = self.responses(request)
            if request.url!.path == "/api/host/resources" {
                response.1["sample"] = ["at": 1_793_386_800_000, "cores": 8, "ramTotalBytes": 32_000_000_000, "diskFreeBytes": 50_500_000_000] as [String: Any]
            }
            return response
        }
        let result = try await client.test(host: host, credential: gate, acceptedPlacementVersion: "fixture-protocol")
        XCTAssertEqual(result.capacity?.cores, 8)
        let text = ServerTestPresentation.reached(result, name: "Fixture")
        XCTAssertTrue(text.contains("Reached Fixture: BotFleet 0.1.0 on Linux, 8 cores, 32.0 GB RAM, 50.5 GB free"))
        XCTAssertTrue(text.contains("Capabilities: shell"))
        XCTAssertTrue(text.contains("Sampled at")); XCTAssertTrue(text.contains("AM") || text.contains("PM"))
        SavedHostURLProtocol.reply = { self.responses($0) }
        let missing = try await client.test(host: host, credential: gate, acceptedPlacementVersion: "fixture-protocol")
        XCTAssertNil(missing.capacity)
        XCTAssertTrue(ServerTestPresentation.reached(missing, name: "Fixture").contains("RAM capacity unknown"))
    }
    func testNullCapacityMeansUnknownAndInvalidCapacityFailsHandshake() async throws {
        let (client, host, gate) = try client()
        SavedHostURLProtocol.reply = { request in
            var response = self.responses(request)
            if request.url!.path == "/api/host/resources" { response.1["sample"] = ["cores": NSNull(), "ramTotalBytes": NSNull(), "diskFreeBytes": NSNull()] }
            return response
        }
        let unknown = try await client.test(host: host, credential: gate, acceptedPlacementVersion: "fixture-protocol")
        XCTAssertNil(unknown.capacity?.cores)
        for sample in [["cores": 0], ["ramTotalBytes": -1], ["diskFreeBytes": -1]] {
            SavedHostURLProtocol.reply = { request in
                var response = self.responses(request)
                if request.url!.path == "/api/host/resources" { response.1["sample"] = sample }
                return response
            }
            do { _ = try await client.test(host: host, credential: gate, acceptedPlacementVersion: "fixture-protocol"); XCTFail("Invalid capacity must fail") }
            catch { XCTAssertEqual(error as? SavedHostError, .invalidResponse) }
        }
    }
    func testCredentialFreeClientStillRequiresItsExactConfiguredOrigin() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [SavedHostURLProtocol.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        let origin = try HostOrigin("http://127.0.0.1:17891")
        let host = HostRecord(id: HostRecord.localID, name: "This Mac", origin: origin)
        SavedHostURLProtocol.reply = { request in
            XCTAssertTrue(origin.contains(request.url!)); return (200, [:])
        }
        _ = try await CompanionClient(connection: host.companionConnection(), token: nil, session: session, hostOrigin: origin).config()
        SavedHostURLProtocol.reply = { _ in XCTFail("Other origin must not make a request"); return (200, [:]) }
        do {
            _ = try await CompanionClient(connection: Connection(name: "Wrong", host: "127.0.0.1", port: 17892), token: nil, session: session, hostOrigin: origin).config()
            XCTFail("Other port must be refused")
        } catch { XCTAssertFalse(error.localizedDescription.contains("fixture-only-token")) }
        let policy = HostOriginRedirectPolicy(origin: origin)
        XCTAssertFalse(policy.allows(URL(string: "http://127.0.0.1:17892/api/config")))
        XCTAssertFalse(policy.allows(URL(string: "https://fixture.test/api/config")))
    }
    func testCompanionClientGateHookUsesTheSameOriginBoundary() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [SavedHostURLProtocol.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        let origin = try HostOrigin("https://fixture.test")
        let gate = try HostGateCredential(origin: origin, token: RedactedSecret("fixture-gate"))
        let endpoint = CompanionEndpoint(url: origin.url.absoluteString, kind: .hosted, priority: 0)!
        let connection = Connection(name: "Fixture", host: endpoint.host, port: endpoint.port, activeEndpoint: endpoint)
        SavedHostURLProtocol.reply = { request in
            XCTAssertEqual(request.url!.path, "/api/config")
            XCTAssertEqual(request.value(forHTTPHeaderField: "x-botfleet-gate-token"), "fixture-gate")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-companion")
            return (200, [:])
        }
        _ = try await CompanionClient(connection: connection, token: "fixture-companion", session: session, gateCredential: gate).config()
        let other = Connection(name: "Other", host: "other.test", port: 8799)
        SavedHostURLProtocol.reply = { _ in XCTFail("Wrong origin must not make a request"); return (200, [:]) }
        do { _ = try await CompanionClient(connection: other, token: nil, session: session, gateCredential: gate).config(); XCTFail("Wrong origin must fail") }
        catch { XCTAssertEqual(error as? SavedHostError, .differentOrigin) }
    }
}
