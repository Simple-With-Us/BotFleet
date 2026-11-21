import CryptoKit
import Foundation
import Testing
@testable import CompanionCore

// MARK: - Ephemeral Test Harnesses

private final class SyncContractURLProtocol: URLProtocol, @unchecked Sendable {
    private struct Route {
        let server: NativeCompanionServer
        let extraHeaders: [String: String]
    }

    static let phoneAddress = "100.101.102.104"

    private static let lock = NSLock()
    private static var routes: [String: Route] = [:]

    private var serving: Task<Void, Never>?

    static func register(_ server: NativeCompanionServer, host: String, extraHeaders: [String: String] = [:]) {
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

private final class SyncContractHarness {
    let session: URLSession
    let connection: Connection
    private let host: String

    init(server: NativeCompanionServer, host: String? = nil) {
        let resolvedHost = host ?? "sync-\(UUID().uuidString.lowercased()).tail0000.ts.net"
        SyncContractURLProtocol.register(server, host: resolvedHost)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SyncContractURLProtocol.self]
        self.host = resolvedHost
        self.session = URLSession(configuration: configuration)
        self.connection = Connection(name: "Mac", host: resolvedHost, port: 8810)
    }

    func client(token: String?) -> CompanionClient {
        CompanionClient(connection: connection, token: token, session: session)
    }

    func eventsRequest(token: String, since: String? = nil, lastEventId: String? = nil) throws -> URLRequest {
        var components = URLComponents()
        components.scheme = "http"
        components.host = host
        components.port = 8810
        components.path = "/api/events"
        var query = [URLQueryItem(name: "screens", value: "off")]
        if let since {
            query.append(URLQueryItem(name: "since", value: since))
        }
        components.queryItems = query
        guard let url = components.url else { throw APIError.badURL }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if let lastEventId {
            request.setValue(lastEventId, forHTTPHeaderField: "Last-Event-ID")
        }
        return request
    }

    func close() {
        session.invalidateAndCancel()
        SyncContractURLProtocol.unregister(host: host)
    }
}

private final class SyncTestClock: @unchecked Sendable {
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

private actor MockAPNsTransport {
    struct CapturedPush: Sendable {
        let url: URL?
        let authorization: String?
        let topic: String?
        let pushType: String?
        let priority: String?
        let body: Data?
    }

    private var queuedResponses: [(statusCode: Int, body: Data)] = []
    private(set) var captured: [CapturedPush] = []

    func enqueue(statusCode: Int, jsonBody: String = "{}") {
        queuedResponses.append((statusCode, Data(jsonBody.utf8)))
    }

    func send(_ request: URLRequest) -> (statusCode: Int, body: Data) {
        captured.append(CapturedPush(
            url: request.url,
            authorization: request.value(forHTTPHeaderField: "authorization"),
            topic: request.value(forHTTPHeaderField: "apns-topic"),
            pushType: request.value(forHTTPHeaderField: "apns-push-type"),
            priority: request.value(forHTTPHeaderField: "apns-priority"),
            body: request.httpBody
        ))
        if !queuedResponses.isEmpty {
            return queuedResponses.removeFirst()
        }
        return (200, Data("{}".utf8))
    }

    func count() -> Int {
        captured.count
    }

    func resetCaptured() {
        captured.removeAll()
    }
}

private func parseSSEFrames(from wireText: String) throws -> [StreamFrame] {
    var parser = SSEParser()
    let decoder = JSONDecoder()
    var frames: [StreamFrame] = []
    for line in wireText.components(separatedBy: "\n") {
        guard let event = parser.line(line),
              let data = event.data.data(using: .utf8) else { continue }
        frames.append(try decoder.decode(StreamFrame.self, from: data))
    }
    return frames
}

// MARK: - BF-2652 Companion Sync Contracts

@Suite("iOS companion sync source contracts across endpoint, pairing, SSE, and push (BF-2652)")
struct CompanionSyncContractsTests {

    private static func tempDeviceStoreURL() -> (dir: URL, store: URL) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("bf2652-sync-\(UUID().uuidString.lowercased())", isDirectory: true)
        return (dir, dir.appendingPathComponent("devices.json"))
    }

    // MARK: - Pillar 1: Server Endpoint

    @Test("Every companion response carries private no-store headers and proper HTTP reason phrases")
    func privateResponseHeadersAndWireStatusLines() async throws {
        let db = try DatabaseService(path: ":memory:")
        let token = "bf_tok_headers_test"
        let server = NativeCompanionServer(database: db, pairedTokens: [token], pairingCode: "123456")

        let checks: [CompanionHTTPResponse] = [
            await server.handleRequest(CompanionHTTPRequest(method: "GET", path: "/api/health")),
            await server.handleRequest(CompanionHTTPRequest(method: "GET", path: "/api/fleet")),
            await server.handleRequest(CompanionHTTPRequest(
                method: "GET",
                path: "/api/health",
                headers: ["Origin": "https://attacker.example"]
            )),
            await server.handleRequest(CompanionHTTPRequest(
                method: "GET",
                path: "/api/companion/push-health",
                headers: ["Authorization": "Bearer \(token)"]
            )),
        ]

        for response in checks {
            #expect(response.headers["Cache-Control"] == "private, no-store")
            #expect(response.headers["CDN-Cache-Control"] == "no-store")
            #expect(response.headers["Cloudflare-CDN-Cache-Control"] == "no-store")
            #expect(response.headers["Pragma"] == "no-cache")
            #expect(response.headers["Vary"] == "Authorization")
        }

        #if canImport(Network)
        let unauthWire = String(decoding: NativeCompanionServer.serializeHTTPResponse(checks[1]), as: UTF8.self)
        #expect(unauthWire.hasPrefix("HTTP/1.1 401 Unauthorized\r\n"))
        #expect(unauthWire.contains("Cache-Control: private, no-store\r\n"))

        let originWire = String(decoding: NativeCompanionServer.serializeHTTPResponse(checks[2]), as: UTF8.self)
        #expect(originWire.hasPrefix("HTTP/1.1 403 Forbidden\r\n"))
        #endif
    }

    @Test("CompanionEndpointAdvertisement.build orders protected routes and gates LAN routes on opt-in")
    func endpointAdvertisementBuilderAndMetadataDecode() async throws {
        let closed = CompanionEndpointAdvertisement.build(
            serverName: "Ada's Mac",
            port: 8810,
            hostedURL: "https://mac.botfleet.app",
            tailnetHost: "ada-mac.tail0000.ts.net",
            lanHosts: ["192.168.1.25", "ada-mac.local"],
            allowCleartextLAN: false
        )
        #expect(closed.endpoints.map(\.kind) == [.hosted, .tailnet])
        #expect(closed.endpoints.map(\.priority) == [0, 100])
        #expect(closed.hosts == ["ada-mac.tail0000.ts.net"])

        let opened = CompanionEndpointAdvertisement.build(
            serverName: "Ada's Mac",
            port: 8810,
            hostedURL: "https://mac.botfleet.app",
            tailnetHost: "ada-mac.tail0000.ts.net",
            lanHosts: ["192.168.1.25", "ada-mac.local"],
            allowCleartextLAN: true
        )
        #expect(opened.endpoints.map(\.kind) == [.hosted, .tailnet, .lan, .bonjour])
        #expect(opened.endpoints.map(\.priority) == [0, 100, 200, 201])
        #expect(opened.hosts == ["ada-mac.tail0000.ts.net", "192.168.1.25", "ada-mac.local"])

        let db = try DatabaseService(path: ":memory:")
        let token = "bf_tok_adv_meta"
        let server = NativeCompanionServer(database: db, pairedTokens: [token], endpointAdvertisement: opened)
        let harness = SyncContractHarness(server: server)
        defer { harness.close() }

        let metadata = try await harness.client(token: token).connectionMetadata()
        #expect(metadata.serverName == "Ada's Mac")
        #expect(metadata.endpoints.map(\.url) == opened.endpoints.map(\.url))
    }

    // MARK: - Pillar 2: Pairing

    @Test("Generated pairing window and invite URL round-trip through PairingInvite.parse and pairFirstReachable")
    func generatedPairingWindowAndInviteRoundTrip() async throws {
        let db = try DatabaseService(path: ":memory:")
        let time = SyncTestClock()
        let advertisement = CompanionEndpointAdvertisement.build(
            serverName: "Studio Mac",
            port: 8810,
            tailnetHost: "studio-mac.tail0000.ts.net",
            allowCleartextLAN: false
        )
        let server = NativeCompanionServer(
            database: db,
            endpointAdvertisement: advertisement,
            clock: { time.now() }
        )

        #expect(await server.activePairingWindow() == nil)
        let window = await server.openPairingWindow()
        #expect(window.code.count == 6)
        #expect(window.code.allSatisfy(\.isNumber))
        #expect(window.qrCredential?.hasPrefix("omb_pair_") == true)
        #expect(window.qrCredential?.utf8.count == 52)
        #expect(await server.activePairingWindow() == window)

        let inviteURL = try #require(
            NativeCompanionServer.makePairingInviteURL(window: window, advertisement: advertisement)
        )
        let invite = try #require(PairingInvite.parse(inviteURL))
        #expect(invite.credential == window.qrCredential)
        #expect(invite.connection.name == "Studio Mac")
        #expect(invite.connection.endpoints?.map(\.url) == advertisement.endpoints.map(\.url))

        let harness = SyncContractHarness(server: server, host: "studio-mac.tail0000.ts.net")
        defer { harness.close() }

        let outcome = try await CompanionClient.pairFirstReachable(
            connection: invite.connection,
            credential: invite.credential,
            deviceName: "Jay's iPhone",
            pairRequestId: UUID().uuidString,
            session: harness.session
        )
        #expect(outcome.response.token.hasPrefix("bf_tok_"))
        #expect(outcome.response.serverName == "Studio Mac")
        #expect(await server.activePairingWindow() == nil)

        // Window expiry is enforced honestly on inspection too.
        _ = await server.openPairingWindow(ttl: 30)
        #expect(await server.activePairingWindow() != nil)
        time.advance(by: 30)
        #expect(await server.activePairingWindow() == nil)
    }

    // MARK: - Pillar 3: Live Updates (SSE)

    @Test("SSE emits hello cursor, sequenced Frame.message events, cursor replay, and 400 on invalid cursor")
    func sseHandshakeReplayAndMessageFrames() async throws {
        let db = try DatabaseService(path: ":memory:")
        let token = "bf_tok_sse_sync"
        let server = NativeCompanionServer(database: db, pairedTokens: [token])
        let harness = SyncContractHarness(server: server)
        defer { harness.close() }

        // 1. Cold start yields hello(resumed: false) with <streamId>:0.
        var initialFrames: [StreamFrame] = []
        for try await frame in eventStream(
            request: try harness.eventsRequest(token: token),
            session: harness.session
        ) {
            initialFrames.append(frame)
        }
        #expect(initialFrames.count == 1)
        guard case let .hello(initialCursor, initialResumed) = initialFrames[0].frame else {
            Issue.record("Expected initial SSE hello frame")
            return
        }
        #expect(NativeCompanionServer.isValidSSECursor(initialCursor))
        #expect(initialCursor.hasSuffix(":0"))
        #expect(initialResumed == false)

        // 2. Posting a message broadcasts a sequenced Frame.message frame.
        let liveStream = await server.subscribeSSE()
        var liveIterator = liveStream.makeAsyncIterator()
        _ = await liveIterator.next() // consume hello

        let posted = await server.handleRequest(CompanionHTTPRequest(
            method: "POST",
            path: "/api/threads/thread-sync-1/messages",
            headers: ["Authorization": "Bearer \(token)"],
            jsonString: "{\"id\":\"msg-1\",\"role\":\"assistant\",\"content\":\"Hello from server\"}"
        ))
        #expect(posted.statusCode == 201)

        let rawLiveFrame = try #require(await liveIterator.next())
        let decodedLive = try parseSSEFrames(from: rawLiveFrame)
        #expect(decodedLive.count == 1)
        #expect(decodedLive[0].seq == 1)
        guard case let .message(threadId, message) = decodedLive[0].frame else {
            Issue.record("Expected decoded Frame.message")
            return
        }
        #expect(threadId == "thread-sync-1")
        #expect(message.id == "msg-1")
        #expect(message.role == .bot)
        #expect(message.text == "Hello from server")

        // 3. Reconnecting with ?since=<initialCursor> replays missed seq 1 with resumed: true.
        var resumedQueryFrames: [StreamFrame] = []
        for try await frame in eventStream(
            request: try harness.eventsRequest(token: token, since: initialCursor),
            session: harness.session
        ) {
            resumedQueryFrames.append(frame)
        }
        #expect(resumedQueryFrames.count == 2)
        guard case let .hello(resumedCursor, resumedFlag) = resumedQueryFrames[0].frame else {
            Issue.record("Expected hello on ?since= reconnect")
            return
        }
        #expect(resumedCursor.hasSuffix(":1"))
        #expect(resumedFlag == true)
        guard case let .message(replayThread, replayMessage) = resumedQueryFrames[1].frame else {
            Issue.record("Expected replayed Frame.message")
            return
        }
        #expect(replayThread == "thread-sync-1")
        #expect(replayMessage.id == "msg-1")

        // 4. Last-Event-ID header works identically to ?since=.
        var headerResumedFrames: [StreamFrame] = []
        for try await frame in eventStream(
            request: try harness.eventsRequest(token: token, lastEventId: initialCursor),
            session: harness.session
        ) {
            headerResumedFrames.append(frame)
        }
        #expect(headerResumedFrames.count == 2)
        if case let .hello(_, headerResumed) = headerResumedFrames[0].frame {
            #expect(headerResumed == true)
        } else {
            Issue.record("Expected hello on Last-Event-ID reconnect")
        }

        // 5. Foreign stream id degrades cleanly to resumed: false with no partial replay.
        var foreignFrames: [StreamFrame] = []
        for try await frame in eventStream(
            request: try harness.eventsRequest(token: token, since: "foreignstream:0"),
            session: harness.session
        ) {
            foreignFrames.append(frame)
        }
        #expect(foreignFrames.count == 1)
        if case let .hello(cursor, resumed) = foreignFrames[0].frame {
            #expect(cursor == resumedCursor)
            #expect(resumed == false)
        } else {
            Issue.record("Expected hello for foreign cursor")
        }

        // 6. Malformed cursor is rejected with 400 invalid_cursor.
        let badCursor = await server.handleRequest(CompanionHTTPRequest(
            method: "GET",
            path: "/api/events?since=not-a-cursor",
            headers: ["Authorization": "Bearer \(token)"]
        ))
        #expect(badCursor.statusCode == 400)
        #expect(badCursor.bodyString.contains("invalid_cursor"))

        // 7. Overflowing the replay buffer forces resumed: false for evicted cursors.
        for index in 2...(NativeCompanionServer.sseReplayBufferCapacity + 5) {
            _ = await server.handleRequest(CompanionHTTPRequest(
                method: "POST",
                path: "/api/threads/thread-sync-1/messages",
                headers: ["Authorization": "Bearer \(token)"],
                jsonString: "{\"id\":\"msg-\(index)\",\"role\":\"user\",\"content\":\"Turn \(index)\"}"
            ))
        }
        var evictedFrames: [StreamFrame] = []
        for try await frame in eventStream(
            request: try harness.eventsRequest(token: token, since: initialCursor),
            session: harness.session
        ) {
            evictedFrames.append(frame)
        }
        #expect(evictedFrames.count == 1)
        if case let .hello(_, evictedResumed) = evictedFrames[0].frame {
            #expect(evictedResumed == false)
        } else {
            Issue.record("Expected hello with resumed: false after eviction")
        }
    }

    // MARK: - Pillar 4: Push Notifications & Live Activity Tokens

    @Test("Push and Live Activity tokens persist per device, validate kind, and clear on revoke")
    func pushAndLiveActivityTokenPersistenceAndValidation() async throws {
        let paths = Self.tempDeviceStoreURL()
        defer { try? FileManager.default.removeItem(at: paths.dir) }

        let db = try DatabaseService(path: ":memory:")
        let server = NativeCompanionServer(database: db, deviceStoreURL: paths.store, pairingCode: "654321")
        let harness = SyncContractHarness(server: server)
        defer { harness.close() }

        let paired = try await CompanionClient.pairFirstReachable(
            connection: harness.connection,
            credential: "654321",
            deviceName: "Jay's iPhone",
            session: harness.session
        )
        let client = harness.client(token: paired.response.token)
        let alertToken = String(repeating: "ab", count: 32)
        let liveToken = String(repeating: "cd", count: 32)

        try await client.registerPushToken(alertToken)
        try await client.registerLiveActivityToken(liveToken, kind: .pushToStart)

        let updateError = await #expect(throws: APIError.self) {
            try await client.registerLiveActivityToken(liveToken, kind: .update)
        }
        #expect(updateError?.statusCode == 400)

        let badField = await server.handleRequest(CompanionHTTPRequest(
            method: "POST",
            path: "/api/companion/live-activity-token",
            headers: ["Authorization": "Bearer \(paired.response.token)"],
            jsonString: "{\"token\":\"\(liveToken)\",\"environment\":\"production\"}"
        ))
        #expect(badField.statusCode == 400)

        let fleetResp = await server.handleRequest(CompanionHTTPRequest(
            method: "GET",
            path: "/api/fleet",
            headers: ["Authorization": "Bearer \(paired.response.token)"]
        ))
        #expect(fleetResp.bodyString.contains("\"pushTokensRegistered\":1"))

        let health = try await client.pushHealth()
        #expect(health.configured == false)
        #expect(health.tokensRegistered == 1)

        // Public device listing never leaks push tokens.
        let onDisk = try String(contentsOf: paths.store, encoding: .utf8)
        #expect(onDisk.contains(alertToken))
        #expect(onDisk.contains(liveToken))

        // Restarting server from devices.json preserves registered tokens.
        let restarted = NativeCompanionServer(database: db, deviceStoreURL: paths.store)
        let restartedHarness = SyncContractHarness(server: restarted)
        defer { restartedHarness.close() }
        let restartedHealth = try await restartedHarness.client(token: paired.response.token).pushHealth()
        #expect(restartedHealth.tokensRegistered == 1)

        // Revoking the device drops its push & Live Activity tokens from disk.
        #expect(await restarted.revokeDevice(id: paired.response.device.id))
        let afterRevoke = try String(contentsOf: paths.store, encoding: .utf8)
        #expect(!afterRevoke.contains(alertToken))
        #expect(!afterRevoke.contains(liveToken))
    }

    @Test("publishNotification skips streaming devices, matches PushDeliveryLedger, and handles APNs 410 and 403")
    func publishNotificationDispatchDedupeAndErrorHandling() async throws {
        let paths = Self.tempDeviceStoreURL()
        defer { try? FileManager.default.removeItem(at: paths.dir) }

        let db = try DatabaseService(path: ":memory:")
        let time = SyncTestClock()
        let key = P256.Signing.PrivateKey()
        let provider = try NativeAPNsProvider(
            p8PEM: key.pemRepresentation,
            keyId: "KEY1234567",
            teamId: "CC8UTF7ATG",
            bundleId: "app.botfleet.ios",
            production: true
        )
        let transport = MockAPNsTransport()
        let tokenConnected = "bf_tok_push_connected"
        let tokenDisconnected = "bf_tok_push_disconnected"
        let server = NativeCompanionServer(
            database: db,
            pairedTokens: [tokenConnected, tokenDisconnected],
            deviceStoreURL: paths.store,
            apnsProvider: provider,
            apnsTransport: { request in await transport.send(request) },
            clock: { time.now() }
        )
        let harness = SyncContractHarness(server: server)
        defer { harness.close() }

        let devices = await server.pairedDevices()
        #expect(devices.count == 2)

        let connectedHex = String(repeating: "11", count: 32)
        let disconnectedHex = String(repeating: "22", count: 32)
        try await harness.client(token: tokenConnected).registerPushToken(connectedHex)
        try await harness.client(token: tokenDisconnected).registerPushToken(disconnectedHex)

        // Identify which device id belongs to `tokenConnected`.
        let authConnected = await server.authorizeEventsStream(
            CompanionHTTPRequest(
                method: "GET",
                path: "/api/events",
                headers: ["Authorization": "Bearer \(tokenConnected)"]
            )
        )
        guard case let .authorized(connectedDeviceId, _) = authConnected else {
            Issue.record("Expected authorized connected device")
            return
        }
        let connectedStream = await server.subscribeSSE(deviceId: connectedDeviceId)
        var connectedIterator = connectedStream.makeAsyncIterator()
        _ = await connectedIterator.next() // hello

        let approval = NotificationFrame(
            kind: "approval",
            botId: "bot-1",
            botName: "Scout",
            threadId: "thread-push-1",
            title: "Scout needs approval",
            body: "Run git status",
            requestId: "req-123",
            tool: "Bash"
        )
        let seq1 = await server.publishNotification(approval)
        #expect(seq1 == 1)

        // Connected device receives the SSE notify frame and is NOT sent an APNs push.
        let sseNotify = try #require(await connectedIterator.next())
        let decodedSSE = try parseSSEFrames(from: sseNotify)
        #expect(decodedSSE.count == 1)
        #expect(decodedSSE[0].seq == seq1)
        if case let .notify(frame) = decodedSSE[0].frame {
            #expect(frame.requestId == "req-123")
        } else {
            Issue.record("Expected Frame.notify on SSE stream")
        }

        let sentFirst = await transport.captured
        #expect(sentFirst.count == 1)
        #expect(sentFirst[0].url?.path == "/3/device/\(disconnectedHex)")
        #expect(sentFirst[0].pushType == "alert")
        #expect(sentFirst[0].priority == "10")
        let bodyData = try #require(sentFirst[0].body)
        let pushJSON = try #require(JSONSerialization.jsonObject(with: bodyData) as? [String: Any])
        #expect(PushDeliveryLedger.sequence(inPushUserInfo: pushJSON) == seq1)
        let aps = try #require(pushJSON["aps"] as? [String: Any])
        #expect(aps["content-available"] as? Int == 1)
        #expect(aps["interruption-level"] as? String == "time-sensitive")
        #expect(aps["category"] as? String == NotificationCategoryIdentifier.approval)

        var ledger = PushDeliveryLedger()
        #expect(ledger.record(pushUserInfo: pushJSON) == seq1)
        #expect(ledger.isAlreadyDelivered(decodedSSE[0].seq))

        // 410 Unregistered retires only the rejected token.
        await transport.resetCaptured()
        await transport.enqueue(statusCode: 410, jsonBody: "{\"reason\":\"Unregistered\"}")
        _ = await server.publishNotification(approval)
        let after410 = try await harness.client(token: tokenDisconnected).pushHealth()
        #expect(after410.sent == 1)
        #expect(after410.failed == 1)
        #expect(after410.tokensRegistered == 1) // connectedHex remains registered; disconnectedHex was cleared

        // Re-registering allows pushes again; 403 InvalidProviderToken latches provider keyRejected.
        let replacementHex = String(repeating: "33", count: 32)
        try await harness.client(token: tokenDisconnected).registerPushToken(replacementHex)
        await transport.resetCaptured()
        await transport.enqueue(statusCode: 403, jsonBody: "{\"reason\":\"InvalidProviderToken\"}")
        _ = await server.publishNotification(approval)
        let after403 = try await harness.client(token: tokenDisconnected).pushHealth()
        #expect(after403.keyRejected == "403 InvalidProviderToken")

        // Subsequent publishNotification must not call APNs transport while keyRejected is latched.
        await transport.resetCaptured()
        _ = await server.publishNotification(approval)
        #expect(await transport.count() == 0)
    }
}
