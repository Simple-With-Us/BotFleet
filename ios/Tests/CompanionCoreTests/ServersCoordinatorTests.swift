import XCTest
@testable import CompanionCore

private actor FixtureHosts: ServersHostStore {
    var records: [HostRecord] = [.thisMac]
    var placement = PlacementSettings()
    var failPin = false
    var failRemove = false
    var holdPin = false
    var holdAdd = false
    var pending: CheckedContinuation<Void, Never>?
    func hosts() -> [HostRecord] { records }
    func settings() -> PlacementSettings { placement }
    func configure(failPin: Bool = false, failRemove: Bool = false, placement: PlacementSettings = PlacementSettings()) {
        self.failPin = failPin; self.failRemove = failRemove; self.placement = placement
    }
    func hold(pin: Bool = false, add: Bool = false) { holdPin = pin; holdAdd = add }
    func isHeld() -> Bool { pending != nil }
    func resume() { pending?.resume(); pending = nil; holdPin = false; holdAdd = false }
    func upsert(_ host: HostRecord) async throws {
        if failPin && host.hostId != nil { throw SavedHostError.unreadableStore }
        if holdPin && host.hostId != nil || holdAdd && !records.contains(where: { $0.id == host.id }) {
            await withCheckedContinuation { pending = $0 }
        }
        if let index = records.firstIndex(where: { $0.id == host.id }) { records[index] = host }
        else { records.append(host) }
    }
    func updateThisMacOrigin(_ origin: HostOrigin) { records[0].origin = origin }
    func remove(id: String, controllerID: String?, leasedHostIDs: Set<String>) throws {
        if failRemove { throw SavedHostError.unreadableStore }
        records.removeAll { $0.id == id }
    }
}

private final class FixtureTokens: HostTokenStore, @unchecked Sendable {
    let lock = NSLock()
    private var values: [String: Data] = [:]
    var failDelete = false
    var failWrite = false
    func read(for host: HostRecord) throws -> HostGateCredential? {
        lock.lock(); defer { lock.unlock() }
        return try values[host.id].map { try KeychainHostTokenStore.decode($0, for: host) }
    }
    func write(_ token: RedactedSecret, for host: HostRecord) throws {
        lock.lock(); defer { lock.unlock() }
        if failWrite { throw SavedHostError.credentialUnavailable }
        values[host.id] = try KeychainHostTokenStore.encode(token, for: host)
    }
    func enrollIfAbsent(_ token: RedactedSecret, for host: HostRecord) throws {
        lock.lock(); defer { lock.unlock() }
        guard values[host.id] == nil else { throw SavedHostError.credentialExists }
        if failWrite { throw SavedHostError.credentialUnavailable }
        values[host.id] = try KeychainHostTokenStore.encode(token, for: host)
    }
    func remove(recordID: String) throws {
        lock.lock(); defer { lock.unlock() }
        if failDelete { throw SavedHostError.credentialUnavailable }
        values[recordID] = nil
    }
    func contains(_ id: String) -> Bool { lock.lock(); defer { lock.unlock() }; return values[id] != nil }
}

private actor HeldHandshake {
    var continuation: CheckedContinuation<VerifiedServer, Never>?
    func run() async -> VerifiedServer { await withCheckedContinuation { continuation = $0 } }
    func started() -> Bool { continuation != nil }
    func finish(_ result: VerifiedServer) { continuation?.resume(returning: result); continuation = nil }
}

@MainActor
final class ServersCoordinatorTests: XCTestCase {
    private let hostID = "server:11111111-1111-4111-8111-111111111111"
    private var verified: VerifiedServer { VerifiedServer(hostId: hostID, version: "0.1.0", platform: "linux", capabilities: ["shell"], controllerId: hostID, epoch: 1) }
    private func settled(_ model: ServersCoordinator) async throws {
        for _ in 0..<500 {
            if model.testing.isEmpty && !model.isBusy { return }
            try await Task.sleep(nanoseconds: 2_000_000)
        }
        XCTFail("Fixture test did not settle")
    }
    private func fixture() async -> (ServersCoordinator, FixtureHosts, FixtureTokens) {
        let store = FixtureHosts(), tokens = FixtureTokens(), result = verified
        let model = ServersCoordinator(store: store, tokens: tokens, handshake: { _, _ in result })
        await model.load()
        return (model, store, tokens)
    }
    private func add(_ model: ServersCoordinator) async -> HostRecord {
        let saved = await model.add(name: "Fixture", origin: "https://fixture.test")
        XCTAssertTrue(saved)
        return model.hosts.last!
    }
    func testDefaultAndMetadataOnlySaveNeverEnrollOrApply() async throws {
        let (model, store, tokens) = await fixture()
        XCTAssertEqual(model.hosts, [.thisMac])
        let host = await add(model)
        XCTAssertNil(host.hostId); XCTAssertFalse(tokens.contains(host.id))
        model.test(host)
        try await settled(model)
        XCTAssertTrue(model.statuses[host.id]!.contains("fresh server token"))
        let settings = await store.settings()
        XCTAssertEqual(settings.saved.mode, .localOnly); XCTAssertEqual(settings.applied.mode, .localOnly)
        XCTAssertEqual(model.connectedRecordID, HostRecord.localID)
    }
    func testFreshTestPinsAndStoresCredentialForExactPinWithoutConnecting() async throws {
        let (model, store, tokens) = await fixture()
        let host = await add(model)
        model.test(host, token: RedactedSecret("fixture-only-token"))
        try await settled(model)
        let pinned = try XCTUnwrap(model.hosts.last)
        XCTAssertEqual(pinned.hostId, hostID)
        XCTAssertNotNil(try tokens.read(for: pinned))
        XCTAssertThrowsError(try tokens.read(for: host))
        let records = await store.hosts()
        XCTAssertEqual(records.last?.hostId, hostID)
        XCTAssertEqual(model.connectedRecordID, HostRecord.localID)
        model.test(pinned)
        try await settled(model)
        XCTAssertTrue(model.statuses[pinned.id]!.contains("Reached"))
    }
    func testMetadataFailureCompensatesNewCredentialAndDoesNotPublishPin() async throws {
        let (model, store, tokens) = await fixture()
        let host = await add(model)
        await store.configure(failPin: true)
        model.test(host, token: RedactedSecret("fixture-only-token"))
        try await settled(model)
        XCTAssertNil(model.hosts.last?.hostId); XCTAssertFalse(tokens.contains(host.id))
        XCTAssertFalse(model.statuses[host.id]!.contains("Reached"))
    }
    func testFailedCompensationRetainsHonestRecoveryStatus() async throws {
        let (model, store, tokens) = await fixture()
        let host = await add(model)
        await store.configure(failPin: true); tokens.failDelete = true
        model.test(host, token: RedactedSecret("fixture-only-token"))
        try await settled(model)
        XCTAssertNil(model.hosts.last?.hostId); XCTAssertTrue(tokens.contains(host.id))
        XCTAssertTrue(model.statuses[host.id]!.contains("could not be cleared"))
    }
    func testCredentialWriteFailureNeverPinsMetadata() async throws {
        let (model, _, tokens) = await fixture()
        let host = await add(model); tokens.failWrite = true
        model.test(host, token: RedactedSecret("fixture-only-token"))
        try await settled(model)
        XCTAssertNil(model.hosts.last?.hostId); XCTAssertFalse(tokens.contains(host.id))
    }
    func testExistingUnpinnedCredentialIsNeverOverwrittenOrDeleted() async throws {
        let (model, _, tokens) = await fixture()
        let host = await add(model)
        try tokens.write(RedactedSecret("existing-fixture-token"), for: host)
        model.test(host, token: RedactedSecret("new-fixture-token"))
        try await settled(model)
        XCTAssertNotNil(try tokens.read(for: host)); XCTAssertNil(model.hosts.last?.hostId)
        XCTAssertTrue(model.statuses[host.id]!.contains("already exists"))
    }
    func testRemoveRefusesDeleteFailureAndReportsMetadataPartialFailure() async throws {
        let (model, store, tokens) = await fixture()
        let host = await add(model)
        tokens.failDelete = true
        let refused = await model.remove(host)
        XCTAssertFalse(refused); XCTAssertTrue(model.hosts.contains(host))
        tokens.failDelete = false
        await store.configure(failRemove: true)
        let partial = await model.remove(host)
        XCTAssertFalse(partial); XCTAssertTrue(model.hosts.contains(host))
        XCTAssertTrue(model.errorMessage!.contains("saved server remains"))
    }
    func testRemovalGuardsConnectionControllerLeaseAndSavedAppliedSelection() async throws {
        let (model, store, _) = await fixture()
        let host = await add(model)
        model.connectedRecordID = host.id
        let connected = await model.remove(host); XCTAssertFalse(connected)
        model.connectedRecordID = nil; model.controllerID = host.id
        let controlled = await model.remove(host); XCTAssertFalse(controlled)
        model.controllerID = nil; model.leasedHostIDs = [host.id]
        let leased = await model.remove(host); XCTAssertFalse(leased)
        model.leasedHostIDs = []
        var settings = PlacementSettings(); settings.applied = PlacementSelection(mode: .serverFirst, serverID: host.id)
        await store.configure(placement: settings)
        let selected = await model.remove(host); XCTAssertFalse(selected)
        let local = await model.remove(.thisMac); XCTAssertFalse(local)
    }
    func testRemovedOrRenamedServerCannotBeRepinnedByStaleHandshake() async throws {
        for rename in [false, true] {
            let store = FixtureHosts(), tokens = FixtureTokens(), held = HeldHandshake()
            let model = ServersCoordinator(store: store, tokens: tokens, handshake: { _, _ in await held.run() })
            await model.load(); let host = await add(model)
            model.test(host, token: RedactedSecret("fixture-only-token"))
            for _ in 0..<500 { if await held.started() { break }; await Task.yield() }
            if rename { let renamed = await model.rename(host, name: "Renamed"); XCTAssertTrue(renamed) }
            else { let removed = await model.remove(host); XCTAssertTrue(removed) }
            await held.finish(verified)
            for _ in 0..<30 { await Task.yield() }
            XCTAssertFalse(tokens.contains(host.id)); XCTAssertNil(model.hosts.last?.hostId)
            XCTAssertNil(model.statuses[host.id])
        }
    }
    func testExactOriginConnectionHasNoAlternateEndpoints() throws {
        let host = HostRecord(name: "Fixture", origin: try HostOrigin("https://fixture.test:8443"))
        let connection = try host.companionConnection()
        XCTAssertEqual(connection.baseURL?.absoluteString, host.origin.url.absoluteString)
        XCTAssertEqual(connection.endpoints?.count, 1); XCTAssertNil(connection.hosts)
        XCTAssertEqual(connection.allowedRouteKinds, [.hosted]); XCTAssertEqual(connection.allowedLocalRouteURLs, [])
    }
    func testCancelDuringCredentialMetadataCommitCannotInvalidateEnrollment() async throws {
        let (model, store, tokens) = await fixture()
        let host = await add(model)
        await store.hold(pin: true)
        model.test(host, token: RedactedSecret("fixture-only-token"))
        for _ in 0..<500 { if await store.isHeld() { break }; await Task.yield() }
        XCTAssertTrue(model.isBusy); XCTAssertTrue(tokens.contains(host.id))
        model.cancelTest(host.id)
        XCTAssertTrue(model.testing.contains(host.id))
        let removed = await model.remove(host); XCTAssertFalse(removed)
        await store.resume(); try await settled(model)
        XCTAssertEqual(model.hosts.last?.hostId, hostID)
        XCTAssertTrue(model.statuses[host.id]!.contains("Reached"))
    }
    func testUnrelatedMutationInterruptsHandshakeWithReadableRetestStatus() async throws {
        let store = FixtureHosts(), tokens = FixtureTokens(), held = HeldHandshake()
        let model = ServersCoordinator(store: store, tokens: tokens, handshake: { _, _ in await held.run() })
        await model.load(); let host = await add(model)
        model.test(host, token: RedactedSecret("fixture-only-token"))
        for _ in 0..<500 { if await held.started() { break }; await Task.yield() }
        await store.hold(add: true)
        let adding = Task { await model.add(name: "Other", origin: "https://other.test") }
        for _ in 0..<500 { if await store.isHeld() { break }; await Task.yield() }
        await held.finish(verified)
        for _ in 0..<30 { await Task.yield() }
        XCTAssertFalse(model.testing.contains(host.id))
        XCTAssertTrue(model.statuses[host.id]!.contains("Test the server again"))
        XCTAssertFalse(tokens.contains(host.id))
        await store.resume(); let added = await adding.value; XCTAssertTrue(added)
    }
    func testCancelOrLocalEditBeforeHandshakeReturnCannotPublishOrPin() async throws {
        for edit in [false, true] {
            let store = FixtureHosts(), tokens = FixtureTokens(), held = HeldHandshake()
            let model = ServersCoordinator(store: store, tokens: tokens, handshake: { _, _ in await held.run() })
            await model.load(); model.test(.thisMac)
            for _ in 0..<500 { if await held.started() { break }; await Task.yield() }
            if edit { _ = await model.updateThisMac(origin: "http://127.0.0.1:8801") }
            else { model.cancelTest(HostRecord.localID) }
            await held.finish(verified)
            for _ in 0..<30 { await Task.yield() }
            XCTAssertNil(model.hosts.first?.hostId); XCTAssertNil(model.statuses[HostRecord.localID])
        }
    }
    func testWireVersionUsesSharedFixtureAndServersDeepLinks() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "placement-wire-version", withExtension: "json", subdirectory: "Fixtures"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: String])
        XCTAssertEqual(json["placementWireVersion"], PlacementWireVersion.current)
        XCTAssertEqual(MacSettingsDeepLinkRouter.section(for: URL(string: "botfleet://settings/servers")!), .servers)
    }
}
