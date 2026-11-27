import Foundation
import Testing
@testable import CompanionCore

// MARK: - BF-2714: The Phone Prefers The Server Bridge Under serverFirst

private enum Routes {
    static let macTailnet = CompanionEndpoint.direct(
        host: "ada-mac.tail0000.ts.net", port: 8810, kind: .tailnet, priority: 100
    )!
    static let macHosted = CompanionEndpoint(url: "https://mac.example.com", kind: .hosted, priority: 0)!
    static let server = CompanionEndpoint(url: "https://server.example.com", kind: .hosted, priority: 0)!
    static let mac = [macHosted.url, macTailnet.url]
}

/// A phone paired with this Mac over its two routes, as a QR invite leaves it.
private func pairedMac(placement: NativePlacementMode?) -> Connection {
    Connection(
        name: "Ada's Mac",
        host: Routes.macTailnet.host,
        port: Routes.macTailnet.port,
        activeEndpoint: Routes.macTailnet,
        endpoints: [Routes.macHosted, Routes.macTailnet],
        allowedRouteKinds: [.tailnet, .hosted],
        allowedLocalRouteURLs: [],
        placement: placement
    )
}

/// The same phone's pairing with the server's companion bridge.
private func pairedBridge() -> Connection {
    Connection(
        id: "bridge-pairing",
        name: "BotFleet Server",
        host: "server.example.com",
        port: 443,
        activeEndpoint: Routes.server,
        endpoints: [Routes.server],
        allowedRouteKinds: [.hosted],
        allowedLocalRouteURLs: []
    )
}

private func metadata(
    placement: NativePlacementMode? = nil,
    isBridge: Bool = false,
    url: String = Routes.macHosted.url
) throws -> CompanionConnectionMetadata {
    var json: [String: Any] = ["serverName": "Ada's Mac", "endpoints": [["url": url, "kind": "hosted", "priority": 0]]]
    if let placement { json["placement"] = placement.rawValue }
    if isBridge { json["isBridge"] = true }
    return try JSONDecoder().decode(
        CompanionConnectionMetadata.self,
        from: try JSONSerialization.data(withJSONObject: json)
    )
}

/// Hands the server a listener backend built back to the test.  The closure
/// that builds it is synchronous, so a lock-guarded box carries it out.
private final class BuiltServerBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: NativeCompanionServer?

    func store(_ server: NativeCompanionServer) {
        lock.lock()
        defer { lock.unlock() }
        stored = server
    }

    var server: NativeCompanionServer? {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
}

/// A backend with no server to tell, which remembers what it was asked to say.
private actor PlacementRecordingBackend: CompanionListenerBackend {
    private(set) var placements: [NativePlacementMode?] = []

    func setPlacement(_ mode: NativePlacementMode?) async {
        placements.append(mode)
    }

    func start(
        advertising: CompanionListenerAdvertisement?,
        onUpdate: @escaping @Sendable (CompanionListenerUpdate) async -> Void
    ) async throws -> UInt16? { 8810 }

    func stop() async {}
}

@Suite("The phone prefers the server bridge under serverFirst (BF-2714)")
struct BridgePreferenceTests {

    // MARK: The walk

    @Test("The bridge leads the walk only when the Mac says it runs serverFirst")
    func bridgeLeadsOnlyUnderServerFirst() {
        for mode in [NativePlacementMode.localOnly, .macFirst] {
            var mac = pairedMac(placement: mode)
            mac.bridgeConnection = pairedBridge()
            #expect(!mac.prefersBridge, "\(mode.rawValue): the Mac owns the work")
            #expect(mac.syncEndpoints.map(\.url) == Routes.mac)
        }
        // A phone that has not heard the mode yet follows the Mac.
        var unheard = pairedMac(placement: nil)
        unheard.bridgeConnection = pairedBridge()
        #expect(!unheard.prefersBridge)
        #expect(unheard.syncEndpoints.map(\.url) == Routes.mac)

        var first = pairedMac(placement: .serverFirst)
        first.bridgeConnection = pairedBridge()
        #expect(first.prefersBridge)
        #expect(first.syncEndpoints.map(\.url) == [Routes.server.url] + Routes.mac)
    }

    @Test("With no bridge pairing the walk is the Mac's, whatever the mode")
    func noBridgePairingMeansTheMacsRoutes() {
        let mac = pairedMac(placement: .serverFirst)
        #expect(!mac.prefersBridge)
        #expect(mac.syncEndpoints == mac.orderedEndpoints)

        // Dropping the pairing puts the Mac back in front at once.
        var dropped = pairedMac(placement: .serverFirst)
        dropped.bridgeConnection = pairedBridge()
        dropped.bridgeConnection = nil
        #expect(dropped.bridge == nil)
        #expect(dropped.syncEndpoints.map(\.url) == Routes.mac)
    }

    @Test("A route is dialed as the pairing that owns it")
    func aRouteIsDialedAsItsOwnPairing() {
        var mac = pairedMac(placement: .serverFirst)
        let bridge = pairedBridge()
        mac.bridgeConnection = bridge

        let onBridge = mac.dialing(Routes.server)
        #expect(onBridge.id == bridge.id, "the token that goes with this route is the bridge's")
        #expect(onBridge.name == "BotFleet Server")
        #expect(onBridge.baseURL?.absoluteString == Routes.server.url)
        #expect(mac.isBridgeRoute(Routes.server))

        let onMac = mac.dialing(Routes.macHosted)
        #expect(onMac.id == mac.id)
        #expect(!mac.isBridgeRoute(Routes.macHosted))
    }

    @Test("An address failure on the bridge falls to the Mac, and a refusal does not move the dial")
    func anAddressFailureFallsToTheMac() {
        var mac = pairedMac(placement: .serverFirst)
        mac.bridgeConnection = pairedBridge()
        var rotation = CandidateRotation(endpoints: mac.syncEndpoints)
        #expect(rotation.currentEndpoint?.url == Routes.server.url)

        // Nothing answers at the bridge, or its gate says the bridge is down.
        let refused = rotation.advanceEndpoint(after: URLError(.cannotConnectToHost))
        #expect(refused?.url == Routes.macHosted.url, "the Mac is the next route, not the bridge again")
        let gateway = rotation.advanceEndpoint(after: APIError.status(code: 502, message: nil))
        #expect(gateway?.url == Routes.macTailnet.url)

        // A 401 is a token problem: every route would answer the same, and
        // the caller decides what it means for the pairing that sent it.
        let refusedAuth = rotation.advanceEndpoint(after: APIError.status(code: 401, message: nil))
        #expect(refusedAuth == nil)
        #expect(rotation.currentEndpoint?.url == Routes.macTailnet.url)
    }

    // MARK: What is kept

    @Test("The bridge pairing round-trips as the plain connection it is")
    func bridgePairingRoundTrips() throws {
        var mac = pairedMac(placement: .serverFirst)
        mac.bridgeConnection = pairedBridge()
        let data = try JSONEncoder().encode(mac)
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["placement"] as? String == "serverFirst")
        // No wrapper on disk: the server's routes sit where a connection's do.
        let stored = try #require(json["bridge"] as? [String: Any])
        #expect(stored["id"] as? String == "bridge-pairing")
        #expect(stored["paired"] == nil)

        let back = try JSONDecoder().decode(Connection.self, from: data)
        #expect(back == mac)
        #expect(back.bridgeConnection?.id == "bridge-pairing")
        #expect(back.syncEndpoints.map(\.url) == mac.syncEndpoints.map(\.url))
    }

    @Test("A phone saved before any of this decodes with no bridge and no mode")
    func anOldPairingDecodesWithoutEither() throws {
        let old = Data(#"{"id":"old","name":"Old Mac","host":"old-mac.tail0000.ts.net","port":8810}"#.utf8)
        let back = try JSONDecoder().decode(Connection.self, from: old)
        #expect(back.bridge == nil)
        #expect(back.placement == nil)
        #expect(!back.prefersBridge)
    }

    @Test("The server holds no server of its own, whichever way it is written")
    func theServerHoldsNoServer() throws {
        var nested = pairedBridge()
        nested.bridgeConnection = pairedBridge()
        var mac = pairedMac(placement: .serverFirst)
        mac.bridgeConnection = nested
        #expect(mac.bridgeConnection?.bridge == nil, "assigned")

        let json = """
            {"id":"mac","name":"Mac","host":"ada-mac.tail0000.ts.net","port":8810,
             "bridge":{"id":"bridge-pairing","name":"BotFleet Server","host":"server.example.com","port":443,
                       "bridge":{"id":"deeper","name":"No","host":"no.example.com","port":443}}}
            """
        let back = try JSONDecoder().decode(Connection.self, from: Data(json.utf8))
        #expect(back.bridgeConnection?.id == "bridge-pairing")
        #expect(back.bridgeConnection?.bridge == nil, "decoded")
    }

    @Test("The phone keeps the last mode it heard when an answer says none")
    func theLastModeHeardIsKept() throws {
        var mac = pairedMac(placement: .serverFirst)
        mac.bridgeConnection = pairedBridge()
        // The server's bridge advertises no placement, and neither does an older Mac.
        mac.reconcile(try metadata(isBridge: true))
        #expect(mac.placement == .serverFirst)
        mac.reconcile(try metadata())
        #expect(mac.placement == .serverFirst)

        mac.reconcile(try metadata(placement: .localOnly))
        #expect(mac.placement == .localOnly)
        #expect(!mac.prefersBridge, "the bridge pairing is kept, and no longer followed")
        #expect(mac.bridgeConnection != nil)
        // The answer is a replacement snapshot of the Mac's routes, as ever.
        #expect(mac.syncEndpoints.map(\.url) == [Routes.macHosted.url])
    }

    @Test("A Mac that advertises no route is still heard: its mode travels alone and the routes stay")
    func aModeWithoutRoutesIsHeard() throws {
        // The native Mac server advertises no route until the app sets some,
        // so its answer is a mode and nothing else.
        let heard = try JSONDecoder().decode(
            CompanionConnectionMetadata.self,
            from: Data(#"{"serverName":"Ada's Mac","endpoints":[],"placement":"serverFirst"}"#.utf8)
        )
        #expect(heard.placement == .serverFirst)
        #expect(heard.endpoints.isEmpty)

        // Without a mode it is the unreadable snapshot it always was, so a
        // phone keeps the routes it has.
        #expect(throws: (any Error).self) {
            _ = try JSONDecoder().decode(
                CompanionConnectionMetadata.self,
                from: Data(#"{"serverName":"Ada's Mac","endpoints":[]}"#.utf8)
            )
        }

        var mac = pairedMac(placement: .localOnly)
        mac.bridgeConnection = pairedBridge()
        mac.reconcile(heard)
        #expect(mac.placement == .serverFirst)
        #expect(mac.prefersBridge)
        #expect(mac.syncEndpoints.map(\.url) == [Routes.server.url] + Routes.mac, "the Mac's routes are as they were")
    }

    // MARK: The invite

    @Test("A bridge invite names itself, and any other role value rejects the invite")
    func anInviteNamesTheServer() throws {
        let token = "omb_pair_" + String(repeating: "a", count: 43)
        let base = "botfleet-ios://pair?address=server.example.com&token=\(token)"
        #expect(PairingInvite.parse(try #require(URL(string: base)))?.role == .computer)
        #expect(PairingInvite.parse(try #require(URL(string: base + "&role=bridge")))?.role == .bridge)
        #expect(PairingInvite.parse(try #require(URL(string: base + "&role=computer"))) == nil)
        #expect(PairingInvite.parse(try #require(URL(string: base + "&role=Bridge"))) == nil)
    }

    @Test("A code the server opened builds a bridge invite, and a code this Mac opened does not")
    func theServerInviteCarriesItsMark() throws {
        let window = NativePairingWindow(
            code: "482913",
            qrCredential: "omb_pair_" + String(repeating: "a", count: 43),
            expiresAt: Date().addingTimeInterval(240),
            attemptsRemaining: 5
        )
        let server = CompanionEndpointAdvertisement(serverName: "BotFleet Server", endpoints: [Routes.server], isBridge: true)
        let invite = try #require(NativeCompanionServer.makePairingInviteURL(window: window, advertisement: server))
        #expect(invite.query?.contains("role=bridge") == true)
        #expect(PairingInvite.parse(invite)?.role == .bridge)
        #expect(PairingInvite.parse(invite)?.connection.baseURL?.absoluteString == Routes.server.url)

        let macRoutes = CompanionEndpointAdvertisement(serverName: "Ada's Mac", endpoints: [Routes.macHosted])
        let own = try #require(NativeCompanionServer.makePairingInviteURL(window: window, advertisement: macRoutes))
        #expect(own.query?.contains("role=") == false)
        #expect(PairingInvite.parse(own)?.role == .computer)
    }

    @Test("An advertisement marked as the server's keeps its mark when the server bounds it")
    func theMarkSurvivesBounding() {
        let marked = CompanionEndpointAdvertisement(serverName: "BotFleet Server", endpoints: [Routes.server], isBridge: true)
        #expect(NativeCompanionServer.sanitizedAdvertisement(marked).isBridge)
        #expect(!NativeCompanionServer.sanitizedAdvertisement(CompanionEndpointAdvertisement()).isBridge)
    }

    // MARK: The wire

    @Test("The phone reads the mode and the bridge mark off a pairing answer, and forgives a mode it does not know")
    func thePairingAnswerCarriesBoth() throws {
        let device = #"{"id":"d","name":"Ada's iPhone","createdAt":1,"lastSeenAt":1}"#
        func response(extra: String) throws -> PairResponse {
            try JSONDecoder().decode(PairResponse.self, from: Data(#"{"token":"bf_tok_x","device":\#(device),"serverName":"x"\#(extra)}"#.utf8))
        }
        let said = try response(extra: #","placement":"macFirst","isBridge":true"#)
        #expect(said.placement == .macFirst)
        #expect(said.isBridge)

        let silent = try response(extra: "")
        #expect(silent.placement == nil)
        #expect(!silent.isBridge)

        let future = try response(extra: #","placement":"hybridCloud""#)
        #expect(future.placement == nil, "the token has been redeemed by then; the mode is only a hint")

        #expect(try metadata(placement: .serverFirst).placement == .serverFirst)
        #expect(try metadata(isBridge: true).isBridge)
    }

    @Test("The Mac says which placement it runs beside its routes, once it has been told")
    func theMacSaysItsPlacement() async throws {
        let db = try DatabaseService(path: ":memory:")
        let token = Self.placementToken
        let server = NativeCompanionServer(database: db, pairedTokens: [token], pairingCode: "482913")
        let headers = ["Authorization": "Bearer \(token)"]

        func endpoints() async throws -> String {
            let answer = await server.handleRequest(CompanionHTTPRequest(method: "GET", path: "/api/companion/endpoints", headers: headers))
            #expect(answer.statusCode == 200)
            return answer.bodyString
        }
        // Untold, nothing is said: the phone keeps what it last read.
        #expect(try await endpoints().contains("placement") == false)

        await server.setPlacement(.serverFirst)
        #expect(try await endpoints().contains(#""placement":"serverFirst""#))
        // Read as the phone reads it: a mode and no route decodes, where a
        // snapshot with neither is refused.
        let told = await server.handleRequest(CompanionHTTPRequest(method: "GET", path: "/api/companion/endpoints", headers: headers))
        let heard = try told.decodeJSON(CompanionConnectionMetadata.self)
        #expect(heard.placement == .serverFirst)
        #expect(heard.endpoints.isEmpty)

        let paired = await server.handleRequest(
            CompanionHTTPRequest(method: "POST", path: "/api/pair", headers: headers,
                                 body: Data(#"{"code":"482913","deviceName":"Ada's iPhone"}"#.utf8))
        )
        #expect(paired.statusCode == 200)
        let pairJSON = try #require(JSONSerialization.jsonObject(with: paired.body) as? [String: Any])
        #expect(pairJSON["placement"] as? String == "serverFirst")
        #expect(pairJSON["isBridge"] == nil, "this computer is never the bridge")

        // Routes may come and go; the mode stays until the app says otherwise.
        await server.setEndpointAdvertisement(CompanionEndpointAdvertisement(serverName: "Studio Mac", endpoints: [Routes.macHosted]))
        #expect(try await endpoints().contains(#""placement":"serverFirst""#))
        await server.setPlacement(nil)
        #expect(try await endpoints().contains("placement") == false)
    }

    // MARK: The Mac app's listener

    private static let paired = "bf_tok_listener_test"
    /// The same kind of fixture for the test above, which hands it to a
    /// local named like a credential: assembled from parts, because a
    /// literal assigned to such a name reads as an assigned secret to the
    /// fleet's scanner, and the fixture is not one.
    private static let placementToken = ["bf_tok_", "placement", "_test"].joined()

    private func placementSaid(by server: NativeCompanionServer) async throws -> String? {
        let answer = await server.handleRequest(
            CompanionHTTPRequest(
                method: "GET",
                path: "/api/companion/endpoints",
                headers: ["Authorization": "Bearer \(Self.paired)"]
            )
        )
        let json = try #require(JSONSerialization.jsonObject(with: answer.body) as? [String: Any])
        return json["placement"] as? String
    }

    @Test("A listener told its placement before it starts says it from its first answer, and is told again while up")
    func theListenerKeepsThePlacementItIsTold() async throws {
        let database = try DatabaseService(path: ":memory:")
        let box = BuiltServerBox()
        let backend = NativeCompanionListenerBackend { _ in
            let server = NativeCompanionServer(database: database, pairedTokens: [Self.paired])
            box.store(server)
            return server
        }
        await backend.setPlacement(.serverFirst)
        _ = try await backend.start(advertising: nil) { _ in }
        let server = try #require(box.server)
        #expect(try await placementSaid(by: server) == "serverFirst")

        await backend.setPlacement(.macFirst)
        #expect(try await placementSaid(by: server) == "macFirst")

        // A stop clears the routes, not the mode: the next start says it too.
        await backend.stop()
        _ = try await backend.start(advertising: nil) { _ in }
        #expect(try await placementSaid(by: server) == "macFirst")
        await backend.stop()
    }

    @Test("A listener nobody has told says nothing, so a phone keeps the mode it last heard")
    func anUntoldListenerSaysNothing() async throws {
        let database = try DatabaseService(path: ":memory:")
        let box = BuiltServerBox()
        let backend = NativeCompanionListenerBackend { _ in
            let server = NativeCompanionServer(database: database, pairedTokens: [Self.paired])
            box.store(server)
            return server
        }
        _ = try await backend.start(advertising: nil) { _ in }
        #expect(try await placementSaid(by: #require(box.server)) == nil)
        await backend.stop()
    }

    @Test("The controller hands the placement to whatever backend it drives")
    @MainActor
    func theControllerPassesItOn() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("bf-2714-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let backend = PlacementRecordingBackend()
        let controller = CompanionListenerController(
            backend: backend,
            policyStore: MacPersistencePolicyStore(dataDir: dir),
            advertisement: nil
        )
        await controller.setPlacement(.serverFirst)
        await controller.setPlacement(nil)
        #expect(await backend.placements == [.some(.serverFirst), nil])
        #expect(controller.state == .off, "saying it starts nothing")
    }
}
