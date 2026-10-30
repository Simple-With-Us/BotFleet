import Foundation
import Testing
@testable import CompanionCore

// MARK: - Client-To-Server Bridge

/// Carries each request the real `CompanionClient` makes into one
/// `NativeCompanionServer` and its answer back, with no socket in between.
/// The server is chosen by the request's host, so tests running in parallel
/// each reach their own server.  Registered only on a test's own ephemeral
/// session, never globally.
private final class NativeServerURLProtocol: URLProtocol, @unchecked Sendable {
    private struct Route {
        let server: NativeCompanionServer
        let extraHeaders: [String: String]
    }

    /// The address a phone on the tailnet would arrive from.  Pairing,
    /// health and endpoints do not depend on it.
    static let phoneAddress = "100.101.102.103"

    private static let lock = NSLock()
    private static var routes: [String: Route] = [:]

    private var serving: Task<Void, Never>?

    /// `extraHeaders` are added to every request after the client's own,
    /// standing in for what a hostile peer or proxy could put on the wire.
    static func register(_ server: NativeCompanionServer, host: String, extraHeaders: [String: String]) {
        lock.lock()
        routes[host] = Route(server: server, extraHeaders: extraHeaders)
        lock.unlock()
    }

    static func unregister(host: String) {
        lock.lock()
        routes[host] = nil
        lock.unlock()
    }

    private static func route(for host: String) -> Route? {
        lock.lock()
        defer { lock.unlock() }
        return routes[host]
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url,
              let host = url.host?.lowercased(),
              let route = Self.route(for: host)
        else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        let companionRequest = Self.companionRequest(from: request, url: url, extraHeaders: route.extraHeaders)
        let server = route.server
        serving = Task { [weak self] in
            let response = await server.handleRequest(companionRequest)
            guard !Task.isCancelled else { return }
            self?.deliver(response, for: url)
        }
    }

    override func stopLoading() {
        serving?.cancel()
        serving = nil
    }

    private func deliver(_ response: CompanionHTTPResponse, for url: URL) {
        guard let http = HTTPURLResponse(
            url: url,
            statusCode: response.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: response.headers
        ) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: response.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    /// The request as the server's socket parser would hand it over: the
    /// percent-encoded request target, the client's headers plus the `Host`
    /// a real connection carries, and the body.
    private static func companionRequest(
        from request: URLRequest,
        url: URL,
        extraHeaders: [String: String]
    ) -> CompanionHTTPRequest {
        var target = "/"
        if let components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            target = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
            if let query = components.percentEncodedQuery {
                target += "?" + query
            }
        }
        var headers = request.allHTTPHeaderFields ?? [:]
        if let host = url.host {
            headers["Host"] = url.port.map { "\(host):\($0)" } ?? host
        }
        for (name, value) in extraHeaders {
            headers[name] = value
        }
        return CompanionHTTPRequest(
            method: request.httpMethod ?? "GET",
            path: target,
            headers: headers,
            body: body(of: request),
            remoteAddress: phoneAddress
        )
    }

    /// URL loading moves an `httpBody` into `httpBodyStream` before a
    /// protocol sees the request, so read whichever one is there.
    private static func body(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { return nil }
            if count == 0 { break }
            result.append(buffer, count: count)
        }
        return result.isEmpty ? nil : result
    }
}

/// One server the real client reaches over a stubbed session, at a tailnet
/// host no other test uses.  `close()` runs from a `defer`, which also keeps
/// the harness alive until the test is done with it.
private final class ClientHarness {
    let session: URLSession
    let connection: Connection
    private let host: String

    init(server: NativeCompanionServer, extraHeaders: [String: String] = [:]) {
        let host = "mac-\(UUID().uuidString.lowercased()).tail0000.ts.net"
        NativeServerURLProtocol.register(server, host: host, extraHeaders: extraHeaders)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [NativeServerURLProtocol.self]
        self.host = host
        self.session = URLSession(configuration: configuration)
        self.connection = Connection(name: "Mac", host: host, port: 8810)
    }

    func client(token: String?) -> CompanionClient {
        CompanionClient(connection: connection, token: token, session: session)
    }

    func close() {
        session.invalidateAndCancel()
        NativeServerURLProtocol.unregister(host: host)
    }
}

/// A clock a test moves by hand, so expiry is exact instead of slept for.
private final class ManualClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_800_000_000)

    func now() -> Date {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    func advance(by seconds: TimeInterval) {
        lock.lock()
        current = current.addingTimeInterval(seconds)
        lock.unlock()
    }
}

private enum PairingFixture {
    static let code = "482913"
    static let wrongCode = "000000"
    static let qrCredential = "omb_pair_" + String(repeating: "Q", count: 43)
    static let wrongQRCredential = "omb_pair_" + String(repeating: "z", count: 43)
    static let deviceName = "Ada's iPhone"
    static let serverName = "Ada's Mac"
}

// MARK: - BF-2591: The Native Server Speaks The iOS Pairing Contract

@Suite("Native companion server speaks the iOS pairing contract (BF-2591)")
struct NativeCompanionPairingContractTests {

    /// Two routes the app might advertise: hosted HTTPS first, then the
    /// tailnet.
    private static func advertisement() throws -> CompanionEndpointAdvertisement {
        let hosted = try #require(CompanionEndpoint(url: "https://mac.example.com", kind: .hosted, priority: 0))
        let tailnet = try #require(
            CompanionEndpoint(url: "http://ada-mac.tail0000.ts.net:8810", kind: .tailnet, priority: 100)
        )
        return CompanionEndpointAdvertisement(
            serverName: PairingFixture.serverName,
            hosts: ["ada-mac.tail0000.ts.net"],
            endpoints: [hosted, tailnet]
        )
    }

    /// The refusal a pairing attempt got through the real client, or `nil`
    /// when it paired (or failed some other way, which the caller's status
    /// check then reports).
    private static func pairRefusal(
        _ harness: ClientHarness,
        credential: String,
        pairRequestId: String? = nil
    ) async -> APIError? {
        do {
            _ = try await CompanionClient.pair(
                connection: harness.connection,
                credential: credential,
                deviceName: PairingFixture.deviceName,
                pairRequestId: pairRequestId,
                session: harness.session
            )
            return nil
        } catch {
            return error as? APIError
        }
    }

    @Test("GET /api/health carries the identity the phone checks before it pairs")
    func healthIdentityIsAcceptedByTheClient() async throws {
        let db = try DatabaseService(path: ":memory:")
        // No window is open, so the pairing POST is refused.  The client only
        // sends that POST after it accepts the health probe; a probe it
        // rejects ends in `PairingRouteError` instead.
        let server = NativeCompanionServer(database: db)
        let harness = ClientHarness(server: server)
        defer { harness.close() }

        let refusal = await #expect(throws: APIError.self) {
            _ = try await CompanionClient.pairFirstReachable(
                connection: harness.connection,
                credential: PairingFixture.code,
                deviceName: PairingFixture.deviceName,
                session: harness.session
            )
        }
        #expect(refusal?.statusCode == 401)

        struct HealthIdentity: Decodable {
            let app: String
            let ready: Bool?
        }
        let health = await server.handleRequest(CompanionHTTPRequest(method: "GET", path: "/api/health"))
        #expect(health.statusCode == 200)
        let identity = try health.decodeJSON(HealthIdentity.self)
        #expect(identity.app == NativeCompanionServer.healthAppIdentity)
        #expect(identity.ready == true)
    }

    @Test("The manual code pairs the real client, and the envelope decodes as PairResponse")
    func manualCodePairsThroughTheRealClient() async throws {
        let db = try DatabaseService(path: ":memory:")
        let advertisement = try Self.advertisement()
        let server = NativeCompanionServer(
            database: db,
            pairingCode: PairingFixture.code,
            endpointAdvertisement: advertisement
        )
        let harness = ClientHarness(server: server)
        defer { harness.close() }

        let outcome = try await CompanionClient.pairFirstReachable(
            connection: harness.connection,
            credential: PairingFixture.code,
            deviceName: PairingFixture.deviceName,
            pairRequestId: UUID().uuidString,
            session: harness.session
        )
        let paired = outcome.response
        #expect(paired.token.hasPrefix("bf_tok_"))
        #expect(!paired.device.id.isEmpty)
        #expect(paired.device.name == PairingFixture.deviceName)
        #expect(paired.device.createdAt > 0)
        #expect(paired.device.lastSeenAt == paired.device.createdAt)
        #expect(paired.serverName == PairingFixture.serverName)
        #expect(paired.hosts == ["ada-mac.tail0000.ts.net"])
        #expect(paired.endpoints?.map(\.url) == advertisement.endpoints.map(\.url))

        // The minted token is a working device credential.
        let metadata = try await harness.client(token: paired.token).connectionMetadata()
        #expect(metadata.serverName == PairingFixture.serverName)
    }

    @Test("The QR credential pairs the real client and spends the manual code with it")
    func qrCredentialPairsThroughTheRealClient() async throws {
        let db = try DatabaseService(path: ":memory:")
        let qrCredential = NativeCompanionServer.makePairingQRCredential()
        // The minted credential is one the phone's own invite parser accepts.
        let inviteURL = try #require(
            URL(string: "botfleet-ios://pair?address=ada-mac.tail0000.ts.net:8810&token=\(qrCredential)")
        )
        #expect(PairingInvite.parse(inviteURL)?.credential == qrCredential)

        let server = NativeCompanionServer(database: db)
        await server.openPairingWindow(code: PairingFixture.code, qrCredential: qrCredential)
        let harness = ClientHarness(server: server)
        defer { harness.close() }

        let outcome = try await CompanionClient.pairFirstReachable(
            connection: harness.connection,
            credential: qrCredential,
            deviceName: PairingFixture.deviceName,
            session: harness.session
        )
        #expect(outcome.response.token.hasPrefix("bf_tok_"))
        // With nothing advertised, hosts and endpoints are absent, not empty.
        #expect(outcome.response.serverName.isEmpty)
        #expect(outcome.response.hosts == nil)
        #expect(outcome.response.endpoints == nil)

        // One window, one device: the code still on screen no longer redeems.
        let second = await Self.pairRefusal(harness, credential: PairingFixture.code)
        #expect(second?.statusCode == 401)
    }

    @Test("Wrong guesses at the code and the QR credential spend one shared budget")
    func wrongGuessesShareOneBudget() async throws {
        let db = try DatabaseService(path: ":memory:")

        // Four wrong guesses, two of each variant, leave the window open.
        let survives = NativeCompanionServer(
            database: db,
            pairingCode: PairingFixture.code,
            pairingQRCredential: PairingFixture.qrCredential
        )
        let survivesHarness = ClientHarness(server: survives)
        defer { survivesHarness.close() }
        for guess in [
            PairingFixture.wrongCode, PairingFixture.wrongQRCredential,
            PairingFixture.wrongCode, PairingFixture.wrongQRCredential,
        ] {
            let refusal = await Self.pairRefusal(survivesHarness, credential: guess)
            #expect(refusal?.statusCode == 403)
        }
        let paired = try await CompanionClient.pair(
            connection: survivesHarness.connection,
            credential: PairingFixture.qrCredential,
            deviceName: PairingFixture.deviceName,
            session: survivesHarness.session
        )
        #expect(paired.token.hasPrefix("bf_tok_"))

        // A fifth wrong guess, whichever variant, burns the window for both.
        let burns = NativeCompanionServer(
            database: db,
            pairingCode: PairingFixture.code,
            pairingQRCredential: PairingFixture.qrCredential
        )
        let burnsHarness = ClientHarness(server: burns)
        defer { burnsHarness.close() }
        var statuses: [Int?] = []
        for guess in [
            PairingFixture.wrongQRCredential, PairingFixture.wrongCode,
            PairingFixture.wrongQRCredential, PairingFixture.wrongCode,
            PairingFixture.wrongQRCredential,
        ] {
            let refusal = await Self.pairRefusal(burnsHarness, credential: guess)
            statuses.append(refusal?.statusCode)
        }
        #expect(statuses == [403, 403, 403, 403, 429])
        #expect(await Self.pairRefusal(burnsHarness, credential: PairingFixture.code)?.statusCode == 401)
        #expect(await Self.pairRefusal(burnsHarness, credential: PairingFixture.qrCredential)?.statusCode == 401)
    }

    @Test("The window expires for both variants at its TTL")
    func windowExpiresForBothVariants() async throws {
        let db = try DatabaseService(path: ":memory:")
        let time = ManualClock()
        let server = NativeCompanionServer(
            database: db,
            pairingCode: PairingFixture.code,
            pairingQRCredential: PairingFixture.qrCredential,
            clock: { time.now() }
        )
        let harness = ClientHarness(server: server)
        defer { harness.close() }

        // A second before the TTL the window is open: a wrong guess is wrong,
        // not expired.
        time.advance(by: NativeCompanionServer.pairingWindowTTL - 1)
        #expect(await Self.pairRefusal(harness, credential: PairingFixture.wrongCode)?.statusCode == 403)

        time.advance(by: 1)
        let expired = await Self.pairRefusal(harness, credential: PairingFixture.qrCredential)
        #expect(expired?.statusCode == 401)
        #expect(expired?.errorDescription == "pairing_code_expired")
        #expect(await Self.pairRefusal(harness, credential: PairingFixture.code)?.statusCode == 401)
    }

    @Test("A repeated pairRequestId with the same credential recovers the same token")
    func pairRequestIdRecoversALostReply() async throws {
        let db = try DatabaseService(path: ":memory:")
        let time = ManualClock()
        let server = NativeCompanionServer(
            database: db,
            pairingCode: PairingFixture.code,
            pairingQRCredential: PairingFixture.qrCredential,
            clock: { time.now() }
        )
        let harness = ClientHarness(server: server)
        defer { harness.close() }
        let requestId = UUID().uuidString

        let first = try await CompanionClient.pair(
            connection: harness.connection,
            credential: PairingFixture.qrCredential,
            deviceName: PairingFixture.deviceName,
            pairRequestId: requestId,
            session: harness.session
        )

        // The reply was lost, and the phone repeats the same logical request.
        time.advance(by: 30)
        let recovered = try await CompanionClient.pair(
            connection: harness.connection,
            credential: PairingFixture.qrCredential,
            deviceName: PairingFixture.deviceName,
            pairRequestId: requestId,
            session: harness.session
        )
        #expect(recovered.token == first.token)
        #expect(recovered.device.id == first.device.id)

        // A different credential under the known id gets no token, even the
        // window's other credential.
        let wrongUnderKnownId = await Self.pairRefusal(
            harness,
            credential: PairingFixture.wrongQRCredential,
            pairRequestId: requestId
        )
        #expect(wrongUnderKnownId?.statusCode == 401)
        let codeUnderKnownId = await Self.pairRefusal(harness, credential: PairingFixture.code, pairRequestId: requestId)
        #expect(codeUnderKnownId?.statusCode == 401)
        // The same credential under a new id is a second redemption of a
        // spent window.
        let sameCredentialNewId = await Self.pairRefusal(
            harness,
            credential: PairingFixture.qrCredential,
            pairRequestId: UUID().uuidString
        )
        #expect(sameCredentialNewId?.statusCode == 401)

        // None of those refusals spent the replay.
        let again = try await CompanionClient.pair(
            connection: harness.connection,
            credential: PairingFixture.qrCredential,
            deviceName: PairingFixture.deviceName,
            pairRequestId: requestId,
            session: harness.session
        )
        #expect(again.token == first.token)
    }

    @Test("pairRequestId recovery ends at the window's original expiry, not a TTL after redemption")
    func pairRequestIdRecoveryEndsAtTheOriginalExpiry() async throws {
        let db = try DatabaseService(path: ":memory:")
        let time = ManualClock()
        let server = NativeCompanionServer(database: db, pairingCode: PairingFixture.code, clock: { time.now() })
        let harness = ClientHarness(server: server)
        defer { harness.close() }
        let requestId = UUID().uuidString

        // Redeemed with the manual code 100 seconds into a 120-second window.
        time.advance(by: 100)
        let first = try await CompanionClient.pair(
            connection: harness.connection,
            credential: PairingFixture.code,
            deviceName: PairingFixture.deviceName,
            pairRequestId: requestId,
            session: harness.session
        )

        time.advance(by: 19)
        let recovered = try await CompanionClient.pair(
            connection: harness.connection,
            credential: PairingFixture.code,
            deviceName: PairingFixture.deviceName,
            pairRequestId: requestId,
            session: harness.session
        )
        #expect(recovered.token == first.token)

        // Twenty seconds after redemption the window's original expiry has
        // passed, and the token is not handed out again.
        time.advance(by: 1)
        let refused = await Self.pairRefusal(harness, credential: PairingFixture.code, pairRequestId: requestId)
        #expect(refused?.statusCode == 401)
    }

    @Test("Closing or reopening the window forgets the replay")
    func closingOrReopeningTheWindowForgetsTheReplay() async throws {
        let db = try DatabaseService(path: ":memory:")
        let requestId = UUID().uuidString

        let closed = NativeCompanionServer(database: db, pairingCode: PairingFixture.code)
        let closedHarness = ClientHarness(server: closed)
        defer { closedHarness.close() }
        _ = try await CompanionClient.pair(
            connection: closedHarness.connection,
            credential: PairingFixture.code,
            deviceName: PairingFixture.deviceName,
            pairRequestId: requestId,
            session: closedHarness.session
        )
        await closed.closePairingWindow()
        let afterClose = await Self.pairRefusal(closedHarness, credential: PairingFixture.code, pairRequestId: requestId)
        #expect(afterClose?.statusCode == 401)

        // A new window has its own credentials, so the old request is just a
        // wrong guess against it.
        let reopened = NativeCompanionServer(database: db, pairingCode: PairingFixture.code)
        let reopenedHarness = ClientHarness(server: reopened)
        defer { reopenedHarness.close() }
        _ = try await CompanionClient.pair(
            connection: reopenedHarness.connection,
            credential: PairingFixture.code,
            deviceName: PairingFixture.deviceName,
            pairRequestId: requestId,
            session: reopenedHarness.session
        )
        await reopened.openPairingWindow(code: "111111")
        let afterReopen = await Self.pairRefusal(reopenedHarness, credential: PairingFixture.code, pairRequestId: requestId)
        #expect(afterReopen?.statusCode == 403)
    }

    @Test("GET /api/companion/endpoints needs a paired token and answers from the injected advertisement")
    func endpointsRequireAuthentication() async throws {
        let db = try DatabaseService(path: ":memory:")
        let token = "bf_tok_endpoints_test"
        let advertisement = try Self.advertisement()
        let server = NativeCompanionServer(database: db, pairedTokens: [token], endpointAdvertisement: advertisement)
        let harness = ClientHarness(server: server)
        defer { harness.close() }

        let unauthenticated = await #expect(throws: APIError.self) {
            _ = try await harness.client(token: nil).connectionMetadata()
        }
        #expect(unauthenticated?.isUnauthorized == true)
        let unpaired = await #expect(throws: APIError.self) {
            _ = try await harness.client(token: "bf_tok_not_paired").connectionMetadata()
        }
        #expect(unpaired?.isUnauthorized == true)

        let metadata = try await harness.client(token: token).connectionMetadata()
        #expect(metadata.serverName == PairingFixture.serverName)
        #expect(metadata.endpoints.map(\.url) == advertisement.endpoints.map(\.url))
        #expect(metadata.endpoints.map(\.kind) == [.hosted, .tailnet])
        // Like the Node sidecar's snapshot, this answer carries no legacy hosts.
        #expect(metadata.hosts == nil)

        // The app can change what is advertised while the server runs.
        let studio = try #require(CompanionEndpoint(url: "https://studio.example.com", kind: .hosted, priority: 0))
        await server.setEndpointAdvertisement(
            CompanionEndpointAdvertisement(serverName: "Studio Mac", endpoints: [studio])
        )
        let refreshed = try await harness.client(token: token).connectionMetadata()
        #expect(refreshed.serverName == "Studio Mac")
        #expect(refreshed.endpoints.map(\.url) == ["https://studio.example.com"])
    }

    @Test("Endpoints and the pairing response ignore a forged Host or X-Forwarded-Host")
    func endpointsIgnoreForgedForwardingHeaders() async throws {
        let db = try DatabaseService(path: ":memory:")
        let token = "bf_tok_forwarding_test"
        let advertisement = try Self.advertisement()
        let server = NativeCompanionServer(
            database: db,
            pairedTokens: [token],
            pairingCode: PairingFixture.code,
            endpointAdvertisement: advertisement
        )
        let forged = [
            "Host": "attacker.example",
            "X-Forwarded-Host": "attacker.example",
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Port": "443",
            "Forwarded": "host=attacker.example;proto=https",
        ]
        let harness = ClientHarness(server: server, extraHeaders: forged)
        defer { harness.close() }

        let metadata = try await harness.client(token: token).connectionMetadata()
        #expect(metadata.serverName == PairingFixture.serverName)
        #expect(metadata.endpoints.map(\.url) == advertisement.endpoints.map(\.url))
        let advertisesForgedHost = metadata.endpoints.contains(where: { $0.url.contains("attacker") })
        #expect(!advertisesForgedHost)

        let paired = try await CompanionClient.pair(
            connection: harness.connection,
            credential: PairingFixture.code,
            deviceName: PairingFixture.deviceName,
            session: harness.session
        )
        #expect(paired.endpoints?.map(\.url) == advertisement.endpoints.map(\.url))
        #expect(paired.hosts == ["ada-mac.tail0000.ts.net"])
    }

    @Test("With nothing injected, endpoints advertise nothing and the phone keeps its last routes")
    func endpointsDefaultAdvertisesNothing() async throws {
        let db = try DatabaseService(path: ":memory:")
        let token = "bf_tok_default_test"
        let server = NativeCompanionServer(database: db, pairedTokens: [token])

        struct EndpointSnapshot: Decodable {
            let serverName: String
            let endpoints: [CompanionEndpoint]
        }
        let raw = await server.handleRequest(
            CompanionHTTPRequest(
                method: "GET",
                path: "/api/companion/endpoints",
                headers: ["Authorization": "Bearer \(token)", "X-Forwarded-Host": "attacker.example"]
            )
        )
        #expect(raw.statusCode == 200)
        #expect(!raw.bodyString.contains("attacker"))
        let snapshot = try raw.decodeJSON(EndpointSnapshot.self)
        #expect(snapshot.serverName.isEmpty)
        #expect(snapshot.endpoints.isEmpty)

        // The client refuses an empty snapshot as unreadable, which is what
        // keeps the routes it already has.
        let harness = ClientHarness(server: server)
        defer { harness.close() }
        let refusal = await #expect(throws: APIError.self) {
            _ = try await harness.client(token: token).connectionMetadata()
        }
        guard let refusal else { return }
        switch refusal {
        case .transport:
            break
        default:
            Issue.record("Expected the client to refuse an empty snapshot as unreadable, got \(refusal)")
        }
    }

    @Test("Device names and pairRequestIds follow the Node sidecar's rules")
    func deviceNameAndPairRequestIdRules() {
        #expect(NativeCompanionServer.cleanDeviceName("  Ada's\u{0007}iPhone\n ") == "Ada's iPhone")
        #expect(NativeCompanionServer.cleanDeviceName(nil) == "Companion")
        #expect(NativeCompanionServer.cleanDeviceName(String(repeating: "x", count: 80)).count == 60)

        #expect(NativeCompanionServer.validPairRequestId(UUID().uuidString) != nil)
        #expect(NativeCompanionServer.validPairRequestId("too-short") == nil)
        #expect(NativeCompanionServer.validPairRequestId("sixteen chars or more, with spaces") == nil)
        #expect(NativeCompanionServer.validPairRequestId(String(repeating: "a", count: 129)) == nil)
        #expect(NativeCompanionServer.validPairRequestId(nil) == nil)
    }
}
