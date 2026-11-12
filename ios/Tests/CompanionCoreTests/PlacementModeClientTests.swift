import XCTest
@testable import CompanionCore

private actor PlacementFixtureHosts: ServersHostStore {
    var records: [HostRecord]
    var placement = PlacementSettings()
    init(records: [HostRecord]) { self.records = records }
    func hosts() -> [HostRecord] { records }
    func settings() -> PlacementSettings { placement }
    func upsert(_ host: HostRecord) {
        if let index = records.firstIndex(where: { $0.id == host.id }) { records[index] = host }
        else { records.append(host) }
    }
    func updateThisMacOrigin(_ origin: HostOrigin) { records[0].origin = origin }
    func save(_ selection: PlacementSelection) { placement.saved = selection }
    func recordApplied(_ selection: PlacementSelection) { placement.applied = selection }
    func remove(id: String, controllerID: String?, leasedHostIDs: Set<String>) {
        records.removeAll { $0.id == id }
    }
}

private struct UnusedTokens: HostTokenStore {
    func read(for host: HostRecord) throws -> HostGateCredential? { nil }
    func write(_ token: RedactedSecret, for host: HostRecord) throws {}
    func remove(recordID: String) throws {}
    func enrollIfAbsent(_ token: RedactedSecret, for host: HostRecord) throws {}
}

private struct CapturedPlacementRequest {
    let method: String
    let path: String
    let companion: String?
    let gate: String?
    let body: Data?
}

private final class PlacementModeURLProtocol: URLProtocol {
    static var handler: (URLRequest) -> (Int, Any) = { _ in (500, [:]) }
    static var captured: [CapturedPlacementRequest] = []

    static func reset() {
        handler = { _ in (500, [:]) }
        captured = []
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.captured.append(CapturedPlacementRequest(
            method: request.httpMethod ?? "GET",
            path: request.url?.path ?? "",
            companion: request.value(forHTTPHeaderField: "x-botfleet-companion"),
            gate: request.value(forHTTPHeaderField: "x-botfleet-gate-token"),
            body: Self.readBody(request)
        ))
        let (status, body) = Self.handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let data = (body as? Data) ?? (try! JSONSerialization.data(withJSONObject: body))
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

    /// URL loading moves an `httpBody` into `httpBodyStream` before a protocol sees it.
    private static func readBody(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data.isEmpty ? nil : data
    }
}

@MainActor
final class PlacementModeClientTests: XCTestCase {
    private let hostID = "server:11111111-1111-4111-8111-111111111111"
    private let macID = "mac:33333333-3333-4333-8333-333333333333"

    override func tearDown() {
        PlacementModeURLProtocol.reset()
        super.tearDown()
    }

    private func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PlacementModeURLProtocol.self]
        let session = URLSession(configuration: config)
        addTeardownBlock { session.invalidateAndCancel() }
        return session
    }

    private func remoteHost() throws -> (HostRecord, HostGateCredential) {
        let origin = try HostOrigin("https://fixture.test")
        let host = HostRecord(name: "Fixture", origin: origin, hostId: hostID)
        return (host, try HostGateCredential(origin: origin, token: RedactedSecret("fixture-gate")))
    }

    private func coordinator(session: URLSession, records: [HostRecord]) -> ServersCoordinator {
        let model = ServersCoordinator(
            store: PlacementFixtureHosts(records: records),
            tokens: UnusedTokens(),
            handshake: { _, _ in throw SavedHostError.invalidResponse },
            placementClient: PlacementModeClient(session: session)
        )
        return model
    }

    private func modeFrame(controllerId: String, epoch: Int, mode: String, serverId: Any, overflow: Bool, acknowledged: Bool, appliedAt: Any, reason: Any) -> [String: Any] {
        [
            "controllerId": controllerId,
            "epoch": epoch,
            "mode": mode,
            "serverId": serverId,
            "allowOverflowToThisMac": overflow,
            "acknowledged": acknowledged,
            "appliedAt": appliedAt,
            "reason": reason,
        ]
    }

    private func json(_ data: Data?) throws -> [String: Any] {
        let data = try XCTUnwrap(data)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func assertNoCompanionHeader() {
        XCTAssertFalse(PlacementModeURLProtocol.captured.isEmpty)
        for request in PlacementModeURLProtocol.captured {
            XCTAssertNil(request.companion)
        }
    }

    func testAcknowledgedWriteRecordsAppliedAndOmitsCompanionHeader() async throws {
        let (host, gate) = try remoteHost()
        let session = session()
        let model = coordinator(session: session, records: [.thisMac, host])
        await model.load()
        let selection = PlacementSelection(mode: .serverFirst, serverID: host.id, allowOverflowToThisMac: true)
        let saved = await model.savePlacement(selection)
        XCTAssertTrue(saved)
        PlacementModeURLProtocol.handler = { _ in
            (200, self.modeFrame(controllerId: self.hostID, epoch: 3, mode: "serverFirst", serverId: self.hostID, overflow: true, acknowledged: true, appliedAt: 1_700_000_000_000, reason: NSNull()))
        }
        let applied = await model.applySavedPlacement(on: host, credential: gate, controller: ControllerAcknowledgement(controllerId: hostID, epoch: 3))
        XCTAssertTrue(applied)
        XCTAssertFalse(model.placement.hasUnappliedChanges)
        XCTAssertEqual(model.placement.applied, selection)
        XCTAssertEqual(PlacementModeURLProtocol.captured.count, 1)
        let request = try XCTUnwrap(PlacementModeURLProtocol.captured.first)
        XCTAssertEqual(request.method, "PUT")
        XCTAssertEqual(request.path, "/api/placement/mode")
        XCTAssertNil(request.companion)
        XCTAssertEqual(request.gate, "fixture-gate")
        let body = try json(request.body)
        XCTAssertEqual(Set(body.keys), ["mode", "controllerId", "epoch", "serverId", "allowOverflowToThisMac"])
        XCTAssertEqual(body["mode"] as? String, "serverFirst")
        XCTAssertEqual(body["controllerId"] as? String, hostID)
        XCTAssertEqual((body["epoch"] as? NSNumber)?.intValue, 3)
        XCTAssertEqual(body["serverId"] as? String, hostID)
        XCTAssertEqual(body["allowOverflowToThisMac"] as? Bool, true)
    }

    func testAcknowledgedFalseDoesNotRecordApplied() async throws {
        let (host, gate) = try remoteHost()
        let session = session()
        let model = coordinator(session: session, records: [.thisMac, host])
        await model.load()
        let selection = PlacementSelection(mode: .serverFirst, serverID: host.id, allowOverflowToThisMac: true)
        let saved = await model.savePlacement(selection)
        XCTAssertTrue(saved)
        PlacementModeURLProtocol.handler = { _ in
            (200, self.modeFrame(controllerId: self.hostID, epoch: 3, mode: "serverFirst", serverId: self.hostID, overflow: true, acknowledged: false, appliedAt: 1_700_000_000_000, reason: "The mode record was written at an older epoch"))
        }
        let applied = await model.applySavedPlacement(on: host, credential: gate, controller: ControllerAcknowledgement(controllerId: hostID, epoch: 3))
        XCTAssertFalse(applied)
        XCTAssertEqual(model.placement.applied.mode, .localOnly)
        XCTAssertTrue(model.placement.hasUnappliedChanges)
        XCTAssertTrue(model.errorMessage!.contains("has not confirmed"))
        XCTAssertEqual(PlacementModeURLProtocol.captured.count, 1)
        assertNoCompanionHeader()
    }

    func testStaleFenceRetriesOnceWithReturnedPair() async throws {
        let (host, gate) = try remoteHost()
        let session = session()
        let model = coordinator(session: session, records: [.thisMac, host])
        await model.load()
        let selection = PlacementSelection(mode: .serverFirst, serverID: host.id, allowOverflowToThisMac: false)
        let saved = await model.savePlacement(selection)
        XCTAssertTrue(saved)
        let returnedController = hostID
        let returnedEpoch = 8
        PlacementModeURLProtocol.handler = { request in
            let count = PlacementModeURLProtocol.captured.count
            if count == 1 {
                return (409, ["error": "stale controller epoch 3", "controllerId": returnedController, "epoch": returnedEpoch])
            }
            return (200, self.modeFrame(controllerId: returnedController, epoch: returnedEpoch, mode: "serverFirst", serverId: self.hostID, overflow: false, acknowledged: true, appliedAt: 1_700_000_000_000, reason: NSNull()))
        }
        let applied = await model.applySavedPlacement(on: host, credential: gate, controller: ControllerAcknowledgement(controllerId: hostID, epoch: 3))
        XCTAssertTrue(applied)
        XCTAssertEqual(model.placement.applied, selection)
        XCTAssertEqual(PlacementModeURLProtocol.captured.count, 2)
        assertNoCompanionHeader()
        let first = try json(PlacementModeURLProtocol.captured[0].body)
        let second = try json(PlacementModeURLProtocol.captured[1].body)
        XCTAssertEqual((first["epoch"] as? NSNumber)?.intValue, 3)
        XCTAssertEqual(first["controllerId"] as? String, hostID)
        XCTAssertEqual(second["controllerId"] as? String, returnedController)
        XCTAssertEqual((second["epoch"] as? NSNumber)?.intValue, returnedEpoch)
        XCTAssertEqual(second["serverId"] as? String, hostID)
        XCTAssertEqual(PlacementModeURLProtocol.captured[1].gate, "fixture-gate")
    }

    func testSecondStaleFenceDoesNotRecordApplied() async throws {
        let (host, gate) = try remoteHost()
        let session = session()
        let model = coordinator(session: session, records: [.thisMac, host])
        await model.load()
        let selection = PlacementSelection(mode: .serverFirst, serverID: host.id)
        let saved = await model.savePlacement(selection)
        XCTAssertTrue(saved)
        PlacementModeURLProtocol.handler = { _ in
            let epoch = PlacementModeURLProtocol.captured.count == 1 ? 8 : 9
            return (409, ["error": "stale controller epoch", "controllerId": self.hostID, "epoch": epoch])
        }
        let applied = await model.applySavedPlacement(on: host, credential: gate, controller: ControllerAcknowledgement(controllerId: hostID, epoch: 3))
        XCTAssertFalse(applied)
        XCTAssertEqual(PlacementModeURLProtocol.captured.count, 2)
        XCTAssertEqual(model.placement.applied.mode, .localOnly)
        XCTAssertTrue(model.placement.hasUnappliedChanges)
        XCTAssertTrue(model.errorMessage!.contains("left unchanged"))
        let second = try json(PlacementModeURLProtocol.captured[1].body)
        XCTAssertEqual((second["epoch"] as? NSNumber)?.intValue, 8)
        assertNoCompanionHeader()
    }

    func testBadRequestDoesNotRecordApplied() async throws {
        let (host, gate) = try remoteHost()
        let session = session()
        let model = coordinator(session: session, records: [.thisMac, host])
        await model.load()
        let selection = PlacementSelection(mode: .serverFirst, serverID: host.id, allowOverflowToThisMac: true)
        let saved = await model.savePlacement(selection)
        XCTAssertTrue(saved)
        PlacementModeURLProtocol.handler = { _ in (400, ["error": "invalid placement mode message"]) }
        let applied = await model.applySavedPlacement(on: host, credential: gate, controller: ControllerAcknowledgement(controllerId: hostID, epoch: 3))
        XCTAssertFalse(applied)
        XCTAssertEqual(PlacementModeURLProtocol.captured.count, 1)
        XCTAssertEqual(model.placement.applied.mode, .localOnly)
        XCTAssertTrue(model.placement.hasUnappliedChanges)
        XCTAssertTrue(model.errorMessage!.contains("was refused"))
        assertNoCompanionHeader()
        XCTAssertEqual(PlacementModeURLProtocol.captured[0].gate, "fixture-gate")
    }

    func testAuthenticationAndUnavailableLeaveAppliedUnchanged() async throws {
        for status in [403, 503] {
            PlacementModeURLProtocol.reset()
            let (host, gate) = try remoteHost()
            let session = session()
            let model = coordinator(session: session, records: [.thisMac, host])
            await model.load()
            let selection = PlacementSelection(mode: .serverFirst, serverID: host.id)
            let saved = await model.savePlacement(selection)
            XCTAssertTrue(saved)
            PlacementModeURLProtocol.handler = { _ in (status, ["error": "refused"]) }
            let applied = await model.applySavedPlacement(on: host, credential: gate, controller: ControllerAcknowledgement(controllerId: hostID, epoch: 4))
            XCTAssertFalse(applied, "status \(status) must not record applied")
            XCTAssertEqual(PlacementModeURLProtocol.captured.count, 1, "status \(status) must not retry")
            XCTAssertEqual(model.placement.applied.mode, .localOnly)
            assertNoCompanionHeader()
            if status == 403 {
                XCTAssertTrue(model.errorMessage!.contains("did not accept"))
            } else {
                XCTAssertTrue(model.errorMessage!.contains("was refused"))
            }
        }
    }

    func testLocalOnlyWriteSendsNullServerIdAndRecordsApplied() async throws {
        let origin = try HostOrigin("http://127.0.0.1:17891")
        var local = HostRecord(id: HostRecord.localID, name: "This Mac", origin: origin)
        local.hostId = macID
        let session = session()
        let model = coordinator(session: session, records: [local])
        await model.load()
        let selection = PlacementSelection(mode: .localOnly, allowOverflowToThisMac: true)
        let saved = await model.savePlacement(selection)
        XCTAssertTrue(saved)
        PlacementModeURLProtocol.handler = { _ in
            (200, self.modeFrame(controllerId: self.macID, epoch: 2, mode: "localOnly", serverId: NSNull(), overflow: true, acknowledged: true, appliedAt: 1_700_000_000_000, reason: NSNull()))
        }
        let applied = await model.applySavedPlacement(on: local, credential: nil, controller: ControllerAcknowledgement(controllerId: macID, epoch: 2))
        XCTAssertTrue(applied)
        XCTAssertEqual(model.placement.applied, selection)
        let request = try XCTUnwrap(PlacementModeURLProtocol.captured.first)
        XCTAssertNil(request.companion)
        XCTAssertNil(request.gate)
        let body = try json(request.body)
        XCTAssertEqual(body["mode"] as? String, "localOnly")
        XCTAssertTrue(body["serverId"] is NSNull)
        XCTAssertEqual((body["epoch"] as? NSNumber)?.intValue, 2)
        XCTAssertEqual(body["controllerId"] as? String, macID)
    }

    func testReadDecodesTheModeFrameAndMissingAcknowledgedFails() async throws {
        let (host, gate) = try remoteHost()
        let client = PlacementModeClient(session: session())
        PlacementModeURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertNil(request.value(forHTTPHeaderField: "x-botfleet-companion"))
            XCTAssertEqual(request.value(forHTTPHeaderField: "x-botfleet-gate-token"), "fixture-gate")
            return (200, self.modeFrame(controllerId: self.hostID, epoch: 0, mode: "localOnly", serverId: NSNull(), overflow: false, acknowledged: false, appliedAt: NSNull(), reason: "No mode record is written"))
        }
        let unread = try await client.read(host: host, credential: gate)
        XCTAssertFalse(unread.acknowledged)
        XCTAssertEqual(unread.mode, .localOnly)
        XCTAssertNil(unread.serverId)
        XCTAssertNil(unread.appliedAt)
        XCTAssertEqual(unread.reason, "No mode record is written")
        XCTAssertEqual(unread.controllerId, hostID)

        var dropped = modeFrame(controllerId: hostID, epoch: 0, mode: "localOnly", serverId: NSNull(), overflow: false, acknowledged: true, appliedAt: NSNull(), reason: NSNull())
        dropped.removeValue(forKey: "acknowledged")
        PlacementModeURLProtocol.handler = { _ in (200, dropped) }
        do {
            _ = try await client.read(host: host, credential: gate)
            XCTFail("A missing acknowledged flag must fail")
        } catch {
            XCTAssertEqual(error as? SavedHostError, .invalidResponse)
        }

        var extra = modeFrame(controllerId: hostID, epoch: 1, mode: "serverFirst", serverId: hostID, overflow: false, acknowledged: true, appliedAt: 1, reason: NSNull())
        extra["pendingHandoff"] = "no"
        PlacementModeURLProtocol.handler = { _ in (200, extra) }
        do {
            _ = try await client.read(host: host, credential: gate)
            XCTFail("An unknown key must fail")
        } catch {
            XCTAssertEqual(error as? SavedHostError, .invalidResponse)
        }
    }

    func testStatusMappingOnTheClient() async throws {
        let (host, gate) = try remoteHost()
        let client = PlacementModeClient(session: session())
        let submission = PlacementModeSubmission(mode: .serverFirst, controllerId: hostID, epoch: 1, serverId: hostID, allowOverflowToThisMac: false)
        PlacementModeURLProtocol.handler = { _ in (401, ["error": "unauthorized"]) }
        do {
            _ = try await client.write(submission, host: host, credential: gate)
            XCTFail("401 must fail")
        } catch {
            XCTAssertEqual(error as? SavedHostError, .authentication)
        }
        PlacementModeURLProtocol.handler = { _ in (409, ["error": "stale controller epoch 1", "controllerId": self.hostID, "epoch": 6]) }
        do {
            _ = try await client.write(submission, host: host, credential: gate)
            XCTFail("409 must fail")
        } catch let error as PlacementModeTransportError {
            XCTAssertEqual(error, .staleFence(controllerId: hostID, epoch: 6))
        }
        PlacementModeURLProtocol.handler = { _ in (503, ["error": "The mode record could not be written; the placement mode is unavailable"]) }
        do {
            _ = try await client.write(submission, host: host, credential: gate)
            XCTFail("503 must fail closed")
        } catch {
            XCTAssertEqual(error as? PlacementModeTransportError, .failClosed)
        }
        PlacementModeURLProtocol.handler = { _ in (400, ["error": "invalid placement mode message"]) }
        do {
            _ = try await client.write(submission, host: host, credential: gate)
            XCTFail("400 must fail closed")
        } catch {
            XCTAssertEqual(error as? PlacementModeTransportError, .failClosed)
        }
        assertNoCompanionHeader()
    }

    func testRetryUsesReturnedControllerAndDoesNotApplyADifferentOne() async throws {
        let (host, gate) = try remoteHost()
        let session = session()
        let model = coordinator(session: session, records: [.thisMac, host])
        await model.load()
        let selection = PlacementSelection(mode: .serverFirst, serverID: host.id)
        let saved = await model.savePlacement(selection)
        XCTAssertTrue(saved)
        let other = "server:22222222-2222-4222-8222-222222222222"
        PlacementModeURLProtocol.handler = { _ in
            if PlacementModeURLProtocol.captured.count == 1 {
                return (409, ["error": "stale controller epoch 3", "controllerId": other, "epoch": 4])
            }
            return (200, self.modeFrame(controllerId: other, epoch: 4, mode: "serverFirst", serverId: self.hostID, overflow: false, acknowledged: true, appliedAt: 1_700_000_000_000, reason: NSNull()))
        }
        let applied = await model.applySavedPlacement(on: host, credential: gate, controller: ControllerAcknowledgement(controllerId: hostID, epoch: 3))
        XCTAssertFalse(applied)
        XCTAssertEqual(PlacementModeURLProtocol.captured.count, 2)
        let second = try json(PlacementModeURLProtocol.captured[1].body)
        XCTAssertEqual(second["controllerId"] as? String, other)
        XCTAssertEqual((second["epoch"] as? NSNumber)?.intValue, 4)
        XCTAssertEqual(model.placement.applied.mode, .localOnly)
        assertNoCompanionHeader()
    }
}
