import XCTest
@testable import CompanionCore

private struct CapturedBridgeRequest {
    let method: String
    let url: URL
    let gate: String?
    let companion: String?
    let contentType: String?
    let body: Data?
}

private final class ServerBridgeURLProtocol: URLProtocol {
    static var handler: (URLRequest) -> (Int, Any) = { _ in (500, [:]) }
    static var captured: [CapturedBridgeRequest] = []

    static func reset() {
        handler = { _ in (500, [:]) }
        captured = []
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        ServerBridgeURLProtocol.captured.append(CapturedBridgeRequest(
            method: request.httpMethod ?? "GET",
            url: request.url ?? URL(string: "https://invalid/")!,
            gate: request.value(forHTTPHeaderField: "x-botfleet-gate-token"),
            companion: request.value(forHTTPHeaderField: "x-botfleet-companion"),
            contentType: request.value(forHTTPHeaderField: "Content-Type"),
            body: Self.readBody(request)
        ))
        let (status, body) = Self.handler(request)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let data = (body as? Data) ?? (try! JSONSerialization.data(withJSONObject: body))
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

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
final class ServerBridgePairingTests: XCTestCase {
    private let hostID = "server:22222222-2222-4222-8222-222222222222"
    private let origin = "https://fixture.test"
    private var nowMs: Double { Date().timeIntervalSince1970 * 1_000 }

    override func tearDown() {
        ServerBridgeURLProtocol.reset()
        super.tearDown()
    }

    private func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ServerBridgeURLProtocol.self]
        let session = URLSession(configuration: config)
        addTeardownBlock { session.invalidateAndCancel() }
        return session
    }

    private func host() throws -> (HostRecord, HostGateCredential) {
        let origin = try HostOrigin(self.origin)
        let host = HostRecord(name: "Fixture server", origin: origin, hostId: hostID)
        return (host, try HostGateCredential(origin: origin, token: RedactedSecret("fixture-gate")))
    }

    /// The one QR credential shape the phone's parser accepts.
    private let qrToken = "omb_pair_" + String(repeating: "a", count: 43)

    /// A credential of another shape, assembled from parts so it reads as the
    /// fixture it is.
    private let otherShapeCredential = ["not", "the", "shape", "the", "phone", "reads"].joined(separator: "-")

    private func backend() throws -> ServerBridgePairingBackend {
        let (host, enrolled) = try host()
        return ServerBridgePairingBackend(host: host, credential: enrolled, session: session())
    }

    private func backendWithoutCredential() throws -> ServerBridgePairingBackend {
        let (host, _) = try host()
        return ServerBridgePairingBackend(host: host, credential: nil, session: session())
    }

    private func windowBody(code: String = "123456", token: String? = nil, expiresAtMs: Double? = nil, attemptsLeft: Int = 5) -> [String: Any] {
        [
            "code": code,
            "token": token ?? qrToken,
            "expiresAtMs": expiresAtMs ?? (nowMs + 240_000),
            "attemptsLeft": attemptsLeft,
        ]
    }

    private func json(_ data: Data?) throws -> [String: Any] {
        let data = try XCTUnwrap(data)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - The window

    func testOpenPairingWindowSendsTheAppCredentialToTheEnrolledOriginOnly() async throws {
        let backend = try backend()
        ServerBridgeURLProtocol.handler = { _ in (200, self.windowBody()) }

        let window = await backend.openPairingWindow()

        let opened = try XCTUnwrap(window)
        XCTAssertEqual(opened.code, "123456")
        XCTAssertEqual(opened.qrCredential, qrToken)
        XCTAssertEqual(opened.attemptsRemaining, 5)
        XCTAssertEqual(opened.expiresAt.timeIntervalSince1970, (nowMs + 240_000) / 1_000, accuracy: 5)
        let after = await backend.lastError
        XCTAssertNil(after)

        let sent = try XCTUnwrap(ServerBridgeURLProtocol.captured.first)
        XCTAssertEqual(sent.method, "POST")
        XCTAssertEqual(sent.url.absoluteString, "\(origin)/api/companion/bridge/pairing/open")
        XCTAssertEqual(sent.gate, "fixture-gate")
        XCTAssertNil(sent.companion, "the companion header would make the gate refuse the caller")
        XCTAssertEqual(sent.contentType, "application/json")
        XCTAssertTrue(try json(sent.body).isEmpty, "an empty JSON object is the whole request")
        XCTAssertEqual(ServerBridgeURLProtocol.captured.count, 1)
    }

    func testAWindowTheBridgeDidNotAnswerWellIsNotShown() async throws {
        let malformed: [([String: Any], String)] = [
            (windowBody(code: "12345"), "a five-digit code"),
            (windowBody(code: "12a456"), "a code with a letter"),
            (windowBody(expiresAtMs: nowMs - 1), "a window that already expired"),
            (windowBody(expiresAtMs: nowMs + 7_200_000), "a window two hours long"),
            (windowBody(attemptsLeft: 0), "a window with no attempts left"),
        ]
        for (body, label) in malformed {
            ServerBridgeURLProtocol.reset()
            let backend = try backend()
            ServerBridgeURLProtocol.handler = { _ in (200, body) }
            let window = await backend.openPairingWindow()
            XCTAssertNil(window, label)
            let error = await backend.lastError
            XCTAssertEqual(error, .invalidResponse, label)
            let active = await backend.activePairingWindow()
            XCTAssertNil(active, label)
        }
    }

    func testAnExpiredWindowStopsBeingTheActiveOne() async throws {
        let backend = try backend()
        ServerBridgeURLProtocol.handler = { _ in (200, self.windowBody(expiresAtMs: self.nowMs + 400)) }
        let window = await backend.openPairingWindow()
        XCTAssertNotNil(window)
        try await Task.sleep(for: .milliseconds(600))
        let active = await backend.activePairingWindow()
        XCTAssertNil(active)
    }

    func testATokenOfAnotherShapeIsLeftOutOfTheQRWhichThenCarriesTheCode() async throws {
        let backend = try backend()
        let odd = otherShapeCredential
        ServerBridgeURLProtocol.handler = { _ in (200, self.windowBody(token: odd)) }
        let window = await backend.openPairingWindow()
        let opened = try XCTUnwrap(window)
        XCTAssertNil(opened.qrCredential, "the phone's parser would refuse the QR")
        XCTAssertEqual(opened.code, "123456")
    }

    func testTheQRCredentialShapeIsTheOneThePhoneParses() {
        XCTAssertTrue(ServerBridgePairingBackend.isQRCredential(qrToken))
        XCTAssertFalse(ServerBridgePairingBackend.isQRCredential("omb_pair_" + String(repeating: "a", count: 42)))
        XCTAssertFalse(ServerBridgePairingBackend.isQRCredential("omb_pair_" + String(repeating: "a", count: 44)))
        XCTAssertFalse(ServerBridgePairingBackend.isQRCredential("omb_pair_" + String(repeating: "a", count: 42) + "!"))
        XCTAssertFalse(ServerBridgePairingBackend.isQRCredential("omb_pair_" + String(repeating: "a", count: 42) + "."))
        XCTAssertFalse(ServerBridgePairingBackend.isQRCredential(String(repeating: "a", count: 52)))
    }

    func testClosingTheWindowCrossesToTheBridgeAndForgetsIt() async throws {
        let backend = try backend()
        ServerBridgeURLProtocol.handler = { request in
            request.url!.path.hasSuffix("/close") ? (200, ["closed": true]) : (200, self.windowBody())
        }
        _ = await backend.openPairingWindow()
        await backend.closePairingWindow()

        let active = await backend.activePairingWindow()
        XCTAssertNil(active)
        let error = await backend.lastError
        XCTAssertNil(error)
        let close = try XCTUnwrap(ServerBridgeURLProtocol.captured.last)
        XCTAssertEqual(close.method, "POST")
        XCTAssertEqual(close.url.absoluteString, "\(origin)/api/companion/bridge/pairing/close")
        XCTAssertEqual(close.gate, "fixture-gate")
    }

    func testACloseTheBridgeCouldNotHoldKeepsTheWindowOnScreen() async throws {
        let backend = try backend()
        ServerBridgeURLProtocol.handler = { request in
            request.url!.path.hasSuffix("/close")
                ? (503, ["error": "the durable state could not be saved, so the change is not confirmed"])
                : (200, self.windowBody())
        }
        _ = await backend.openPairingWindow()
        await backend.closePairingWindow()

        let active = await backend.activePairingWindow()
        XCTAssertNotNil(active, "the bridge keeps a window whose close it could not hold")
        let error = await backend.lastError
        XCTAssertEqual(error, .notSaved, "a 503 from the bridge is its own refusal, not an unreachable bridge")
    }

    func testClosingWithNothingOpenStillAsksTheBridge() async throws {
        let backend = try backend()
        ServerBridgeURLProtocol.handler = { _ in (200, ["closed": false]) }
        await backend.closePairingWindow()
        let close = try XCTUnwrap(ServerBridgeURLProtocol.captured.first)
        XCTAssertEqual(close.url.path, "/api/companion/bridge/pairing/close", "a window this backend never saw closes the same way")
        let error = await backend.lastError
        XCTAssertNil(error)
    }

    // MARK: - One backend per server

    func testAServerKeepsOneBackendForTheLifeOfTheProcess() async throws {
        let (host, enrolled) = try host()
        let first = await ServerBridgePairingBackend.shared(host: host, credential: enrolled, session: session())
        let again = await ServerBridgePairingBackend.shared(host: host, credential: enrolled, session: session())
        XCTAssertTrue(first === again)

        let other = HostRecord(name: "Other server", origin: try HostOrigin("https://other.fixture.test"))
        let second = await ServerBridgePairingBackend.shared(host: other, credential: nil, session: session())
        XCTAssertFalse(first === second)

        await ServerBridgePairingBackend.retainOnly([host.id])
        let afterForgetting = await ServerBridgePairingBackend.shared(host: other, credential: nil, session: session())
        XCTAssertFalse(second === afterForgetting, "a server no longer enrolled gets a fresh backend, with no window and no credential")
        let kept = await ServerBridgePairingBackend.shared(host: host, credential: enrolled, session: session())
        XCTAssertTrue(first === kept)
    }

    func testAWindowOpenedBeforeTheTabReopenedIsStillShownAndCanBeClosed() async throws {
        let (host, enrolled) = try host()
        ServerBridgeURLProtocol.handler = { request in
            request.url!.path.hasSuffix("/close") ? (200, ["closed": true]) : (200, self.windowBody())
        }
        let first = await ServerBridgePairingBackend.shared(host: host, credential: enrolled, session: session())
        _ = await first.openPairingWindow()

        // The tab closed and opened again, and asks for the server's backend anew.
        let again = await ServerBridgePairingBackend.shared(host: host, credential: enrolled, session: session())
        let shown = await again.activePairingWindow()
        XCTAssertEqual(shown?.code, "123456")

        await again.closePairingWindow()
        XCTAssertEqual(ServerBridgeURLProtocol.captured.last?.url.path, "/api/companion/bridge/pairing/close")
        let after = await again.activePairingWindow()
        XCTAssertNil(after)
    }

    // MARK: - Devices and the advertisement

    func testPairedDevicesReadTheBridgeRowsIntoSecondsAndDropWhatHasNoId() async throws {
        let backend = try backend()
        ServerBridgeURLProtocol.handler = { _ in
            (200, ["devices": [
                ["id": "phone-1", "name": "Jay's iPhone", "pairedAtMs": 1_797_000_000_000],
                ["id": "phone-2", "name": "iPad", "pairedAtMs": 1_797_000_001_500],
                ["id": "", "name": "broken", "pairedAtMs": 1],
            ]])
        }
        let devices = await backend.pairedDevices()
        XCTAssertEqual(devices, [
            PairedDevice(id: "phone-1", name: "Jay's iPhone", createdAt: 1_797_000_000, lastSeenAt: 1_797_000_000),
            PairedDevice(id: "phone-2", name: "iPad", createdAt: 1_797_000_001.5, lastSeenAt: 1_797_000_001.5),
        ])
        let sent = try XCTUnwrap(ServerBridgeURLProtocol.captured.first)
        XCTAssertEqual(sent.method, "GET")
        XCTAssertEqual(sent.url.absoluteString, "\(origin)/api/companion/bridge/devices")
        XCTAssertNil(sent.body)
    }

    func testRevokeSendsDeleteForTheOneDeviceAndNeverForAnIdItCannotName() async throws {
        let backend = try backend()
        ServerBridgeURLProtocol.handler = { _ in (200, ["revoked": true, "deviceId": "phone-1"]) }
        let revoked = await backend.revokeDevice(id: "phone-1")
        XCTAssertTrue(revoked)
        let sent = try XCTUnwrap(ServerBridgeURLProtocol.captured.first)
        XCTAssertEqual(sent.method, "DELETE")
        XCTAssertEqual(sent.url.absoluteString, "\(origin)/api/companion/bridge/devices/phone-1")
        XCTAssertEqual(sent.gate, "fixture-gate")

        for bad in ["", "../pairing", "a/b", "phone%20one", "phone one", String(repeating: "a", count: 129)] {
            let answer = await backend.revokeDevice(id: bad)
            XCTAssertFalse(answer, bad)
        }
        XCTAssertEqual(ServerBridgeURLProtocol.captured.count, 1, "a bad id never becomes a request")
    }

    func testRevokeOfADeviceTheBridgeNoLongerKnowsCountsAsRevoked() async throws {
        let backend = try backend()
        ServerBridgeURLProtocol.handler = { _ in (404, ["error": "unknown device"]) }
        let revoked = await backend.revokeDevice(id: "phone-9")
        XCTAssertTrue(revoked)
        let error = await backend.lastError
        XCTAssertNil(error)
    }

    func testRevokeOnAServerWithNoBridgeIsNotARevokeAndSaysSo() async throws {
        let backend = try backend()
        // The gate's 404, or the harness's own: the reason is not the bridge's.
        for body in [["error": "no such companion bridge route"], ["error": "not found"]] {
            ServerBridgeURLProtocol.reset()
            ServerBridgeURLProtocol.handler = { _ in (404, body) }
            let revoked = await backend.revokeDevice(id: "phone-1")
            XCTAssertFalse(revoked, body["error"]!)
            let error = await backend.lastError
            XCTAssertEqual(error, .notConfigured(body["error"]), "the tab must say the server has no phone pairing")
        }
    }

    func testRevokeRefusedByTheOwnerCheckIsNotARevoke() async throws {
        let backend = try backend()
        ServerBridgeURLProtocol.handler = { _ in (403, ["error": "owner identity required"]) }
        let revoked = await backend.revokeDevice(id: "phone-1")
        XCTAssertFalse(revoked)
        let error = await backend.lastError
        XCTAssertEqual(error, .authentication)
    }

    func testTheAdvertisementIsTheBridgeRowsUnderTheBridgeName() async throws {
        let backend = try backend()
        ServerBridgeURLProtocol.handler = { _ in
            (200, ["serverName": "BotFleet Server", "endpoints": [
                ["url": "https://box.fixture-ts.net:8800", "kind": "hosted", "priority": 0],
            ]])
        }
        let advertisement = await backend.currentAdvertisement()
        XCTAssertEqual(advertisement.serverName, "BotFleet Server")
        XCTAssertEqual(advertisement.hosts, [])
        XCTAssertEqual(advertisement.endpoints.count, 1)
        XCTAssertEqual(advertisement.endpoints.first?.kind, .hosted)
        XCTAssertEqual(advertisement.endpoints.first?.url, "https://box.fixture-ts.net:8800")
        let sent = try XCTUnwrap(ServerBridgeURLProtocol.captured.first)
        XCTAssertEqual(sent.url.absoluteString, "\(origin)/api/companion/bridge/endpoints")
    }

    func testAnAdvertisementWithNoRouteIsStillAnAdvertisement() async throws {
        let backend = try backend()
        ServerBridgeURLProtocol.handler = { _ in (200, ["serverName": "BotFleet Server", "endpoints": []]) }
        let advertisement = await backend.currentAdvertisement()
        XCTAssertEqual(advertisement.endpoints, [])
        let error = await backend.lastError
        XCTAssertNil(error)
    }

    // MARK: - What the answers mean

    func testEachRefusalIsNamedForTheTab() async throws {
        let cases: [(Int, [String: Any], ServerBridgeError, String)] = [
            (404, ["error": "no such companion bridge route"], .notConfigured("no such companion bridge route"), "a server without the bridge"),
            (404, ["unrelated": true], .notConfigured(nil), "a 404 with no reason in it"),
            (502, ["error": "companion bridge unavailable"], .unavailable, "a bridge that is not answering"),
            (401, ["error": "owner identity required"], .authentication, "a credential the gate refused"),
            (403, ["error": "owner identity required"], .authentication, "a credential the gate refused"),
            (200, ["unexpected": true], .invalidResponse, "an answer of another shape"),
            (500, [:], .invalidResponse, "anything else"),
        ]
        for (status, body, expected, label) in cases {
            ServerBridgeURLProtocol.reset()
            let backend = try backend()
            ServerBridgeURLProtocol.handler = { _ in (status, body) }
            _ = await backend.openPairingWindow()
            let error = await backend.lastError
            XCTAssertEqual(error, expected, label)
        }
    }

    func testWithoutACredentialNothingIsSentAndTheReasonIsAuthentication() async throws {
        let backend = try backendWithoutCredential()
        let window = await backend.openPairingWindow()
        XCTAssertNil(window)
        let devices = await backend.pairedDevices()
        XCTAssertEqual(devices, [])
        let advertisement = await backend.currentAdvertisement()
        XCTAssertEqual(advertisement.endpoints, [])
        let revoked = await backend.revokeDevice(id: "phone-1")
        XCTAssertFalse(revoked)
        let error = await backend.lastError
        XCTAssertEqual(error, .authentication)
        XCTAssertTrue(ServerBridgeURLProtocol.captured.isEmpty)
    }

    func testThisMacIsNotAServerToPairWith() async throws {
        let local = HostRecord.thisMac
        let origin = try HostOrigin("http://127.0.0.1:8799")
        let backend = ServerBridgePairingBackend(
            host: local, credential: try HostGateCredential(origin: origin, token: RedactedSecret("fixture-gate")),
            session: session()
        )
        let advertisement = await backend.currentAdvertisement()
        XCTAssertEqual(advertisement.endpoints, [])
        let error = await backend.lastError
        XCTAssertEqual(error, .invalidResponse)
        XCTAssertTrue(ServerBridgeURLProtocol.captured.isEmpty)
    }

    // MARK: - With the tab's loader

    func testTheLoaderDrawsTheSameCardForTheServerAsForThisMac() async throws {
        let backend = try backend()
        let address = "https://box.fixture-ts.net:8800"
        ServerBridgeURLProtocol.handler = { request in
            switch request.url!.path {
            case "/api/companion/bridge/pairing/open":
                return (200, self.windowBody(code: "654321"))
            case "/api/companion/bridge/devices":
                return (200, ["devices": [["id": "phone-1", "name": "Jay's iPhone", "pairedAtMs": 1_797_000_000_000]]])
            default:
                return (200, ["serverName": "BotFleet Server", "endpoints": [["url": address, "kind": "hosted", "priority": 0]]])
            }
        }
        _ = await backend.openPairingWindow()
        let snapshot = await PhoneSettingsSnapshotLoader(backend: backend).load()

        XCTAssertEqual(snapshot.serverName, "BotFleet Server")
        XCTAssertEqual(snapshot.window?.code, "654321")
        XCTAssertEqual(snapshot.routes.map(\.url), [address])
        XCTAssertEqual(snapshot.devices.map(\.name), ["Jay's iPhone"])
        let invite = try XCTUnwrap(snapshot.inviteURL)
        let parsed = try XCTUnwrap(PairingInvite.parse(invite), "the shipped app accepts the QR")
        XCTAssertEqual(parsed.credential, qrToken)
        XCTAssertEqual(parsed.connection.endpoints?.first?.url, address)
        XCTAssertEqual(parsed.connection.name, "BotFleet Server")
    }

    func testTheLoaderStillDrawsAPhoneReadableQRWhenTheTokenHasAnotherShape() async throws {
        let backend = try backend()
        let odd = otherShapeCredential
        let address = "https://box.fixture-ts.net:8800"
        ServerBridgeURLProtocol.handler = { request in
            switch request.url!.path {
            case "/api/companion/bridge/pairing/open":
                return (200, self.windowBody(code: "654321", token: odd))
            case "/api/companion/bridge/devices":
                return (200, ["devices": []])
            default:
                return (200, ["serverName": "BotFleet Server", "endpoints": [["url": address, "kind": "hosted", "priority": 0]]])
            }
        }
        _ = await backend.openPairingWindow()
        let snapshot = await PhoneSettingsSnapshotLoader(backend: backend).load()

        let parsed = try XCTUnwrap(PairingInvite.parse(try XCTUnwrap(snapshot.inviteURL)), "the QR carries the code")
        XCTAssertEqual(parsed.credential, "654321")
        XCTAssertEqual(parsed.connection.endpoints?.first?.url, address)
    }
}
