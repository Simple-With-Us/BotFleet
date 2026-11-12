import Foundation
import Testing
@testable import CompanionCore

// MARK: - BF-2511 acceptance: durable device credentials, Origin rejection

/// The acceptance the Mac listener's LAN gating waited on: a paired
/// phone's credential is durable (digest-only on disk), revocable, and
/// no device route answers a browser.  Until these held, the listener
/// bound loopback and advertised nothing.
@Suite("Native companion device acceptance (BF-2511)")
struct CompanionDeviceAcceptanceTests {

    private static let code = "482913"

    /// A throwaway directory holding one server's `devices.json`.
    private static func deviceStoreURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("bf2511-\(UUID().uuidString.lowercased())", isDirectory: true)
            .appendingPathComponent("devices.json")
    }

    private static func pairRequest(
        credential: String,
        deviceName: String = "Ada's iPhone",
        pairRequestId: String? = nil,
        extraHeaders: [String: String] = [:]
    ) -> CompanionHTTPRequest {
        var body: [String: String] = ["credential": credential, "deviceName": deviceName]
        if let pairRequestId { body["pairRequestId"] = pairRequestId }
        let data = try! JSONSerialization.data(withJSONObject: body)
        var headers = ["Content-Type": "application/json"]
        for (name, value) in extraHeaders { headers[name] = value }
        return CompanionHTTPRequest(
            method: "POST",
            path: "/api/pair",
            headers: headers,
            body: data,
            remoteAddress: "192.168.1.50"
        )
    }

    private static func authedRequest(
        path: String,
        token: String?,
        extraHeaders: [String: String] = [:]
    ) -> CompanionHTTPRequest {
        var headers = extraHeaders
        if let token { headers["Authorization"] = "Bearer \(token)" }
        return CompanionHTTPRequest(
            method: "GET",
            path: path,
            headers: headers,
            remoteAddress: "192.168.1.50"
        )
    }

    @Test("A valid pairing is accepted, durable across a restart, and only its digest reaches disk")
    func pairingIsDurableAndDigestOnly() async throws {
        let storeURL = Self.deviceStoreURL()
        let db = try DatabaseService(path: ":memory:")
        let server = NativeCompanionServer(
            database: db,
            deviceStoreURL: storeURL,
            pairingCode: Self.code
        )

        let paired = await server.handleRequest(Self.pairRequest(credential: Self.code))
        #expect(paired.statusCode == 200)
        let response = try paired.decodeJSON(PairResponse.self)
        #expect(response.token.hasPrefix("bf_tok_"))
        #expect(response.device.name == "Ada's iPhone")
        #expect(await server.pairedDeviceCount == 1)

        // The file holds the digest, never the credential itself.
        let onDisk = try String(contentsOf: storeURL, encoding: .utf8)
        #expect(!onDisk.contains(response.token))
        #expect(onDisk.contains(CompanionDeviceRegistry.tokenHash(for: response.token)))

        // A fresh server over the same file — the app restarted — still
        // authenticates the phone and lists the same device.
        let restarted = NativeCompanionServer(database: db, deviceStoreURL: storeURL)
        let afterRestart = await restarted.handleRequest(
            Self.authedRequest(path: "/api/fleet", token: response.token)
        )
        #expect(afterRestart.statusCode == 200)
        #expect(await restarted.pairedDevices().map(\.id) == [response.device.id])
    }

    @Test("An Origin header is refused on every device route, before any credential is read")
    func originIsRejectedEverywhere() async throws {
        let db = try DatabaseService(path: ":memory:")
        let token = "bf_tok_origin_test"
        let server = NativeCompanionServer(
            database: db,
            pairedTokens: [token],
            pairingCode: Self.code
        )
        let browser = ["Origin": "https://attacker.example"]

        // Even the open health probe refuses a browser.
        let health = await server.handleRequest(
            CompanionHTTPRequest(method: "GET", path: "/api/health", headers: browser)
        )
        #expect(health.statusCode == 403)

        // A valid bearer token does not rescue a cross-origin request.
        let fleet = await server.handleRequest(
            Self.authedRequest(path: "/api/fleet", token: token, extraHeaders: browser)
        )
        #expect(fleet.statusCode == 403)
        #expect(fleet.bodyString.contains("cross-origin"))

        // Pairing from a browser is refused and spends nothing: the same
        // credential from the native app still pairs afterwards.
        let refusedPair = await server.handleRequest(
            Self.pairRequest(credential: Self.code, extraHeaders: browser)
        )
        #expect(refusedPair.statusCode == 403)
        let paired = await server.handleRequest(Self.pairRequest(credential: Self.code))
        #expect(paired.statusCode == 200)
    }

    @Test("A revoked or unknown device credential no longer authenticates, and cannot replay")
    func revokedAndUnknownCredentialsAreRejected() async throws {
        let storeURL = Self.deviceStoreURL()
        let db = try DatabaseService(path: ":memory:")
        let server = NativeCompanionServer(
            database: db,
            deviceStoreURL: storeURL,
            pairingCode: Self.code
        )
        let requestId = UUID().uuidString
        let paired = await server.handleRequest(
            Self.pairRequest(credential: Self.code, pairRequestId: requestId)
        )
        let response = try paired.decodeJSON(PairResponse.self)

        // Unknown tokens were never credentials.
        let unknown = await server.handleRequest(
            Self.authedRequest(path: "/api/fleet", token: "bf_tok_never_paired")
        )
        #expect(unknown.statusCode == 401)

        #expect(await server.revokeDevice(id: response.device.id))
        #expect(await server.revokeDevice(id: response.device.id) == false)
        let revoked = await server.handleRequest(
            Self.authedRequest(path: "/api/fleet", token: response.token)
        )
        #expect(revoked.statusCode == 401)

        // Nor can the lost-reply replay hand the revoked token out again.
        let replay = await server.handleRequest(
            Self.pairRequest(credential: Self.code, pairRequestId: requestId)
        )
        #expect(replay.statusCode == 401)

        // And the revocation is durable, not just in this process.
        let restarted = NativeCompanionServer(database: db, deviceStoreURL: storeURL)
        let afterRestart = await restarted.handleRequest(
            Self.authedRequest(path: "/api/fleet", token: response.token)
        )
        #expect(afterRestart.statusCode == 401)
        #expect(await restarted.pairedDeviceCount == 0)
    }

    @Test("Malformed device files and digests fail closed")
    func malformedDeviceStoreFailsClosed() async throws {
        let storeURL = Self.deviceStoreURL()
        try FileManager.default.createDirectory(
            at: storeURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let db = try DatabaseService(path: ":memory:")

        // A corrupt file loads as an empty fleet: nothing authenticates,
        // and a fresh pairing still works.
        try Data("{\"devices\": [torn".utf8).write(to: storeURL)
        let corrupt = NativeCompanionServer(
            database: db,
            deviceStoreURL: storeURL,
            pairingCode: Self.code
        )
        #expect(await corrupt.pairedDeviceCount == 0)
        let paired = await corrupt.handleRequest(Self.pairRequest(credential: Self.code))
        #expect(paired.statusCode == 200)

        // A record whose digest is not a SHA-256 is not a credential,
        // even when a request presents the very string the file holds.
        let planted = """
        {"devices": [{"id": "planted", "name": "Planted", "tokenHash": "let-me-in", \
        "createdAt": 1, "lastSeenAt": 1, "cloudDesktopAccess": false}]}
        """
        try Data(planted.utf8).write(to: storeURL)
        let server = NativeCompanionServer(database: db, deviceStoreURL: storeURL)
        #expect(await server.pairedDeviceCount == 0)
        let attempt = await server.handleRequest(
            Self.authedRequest(path: "/api/fleet", token: "let-me-in")
        )
        #expect(attempt.statusCode == 401)
    }

    @Test("A full fleet refuses a new pairing after the credential check, and the window survives")
    func fullFleetRefusesAfterCredentialCheck() async throws {
        let db = try DatabaseService(path: ":memory:")
        let tokens = Set((0..<CompanionDeviceRegistry.maxDevices).map { "bf_tok_filled_\($0)" })
        let server = NativeCompanionServer(
            database: db,
            pairedTokens: tokens,
            pairingCode: Self.code
        )
        #expect(await server.pairedDeviceCount == CompanionDeviceRegistry.maxDevices)

        // A wrong guess is still just wrong — the full fleet is not
        // revealed before the credential check.
        let wrong = await server.handleRequest(Self.pairRequest(credential: "000000"))
        #expect(wrong.statusCode == 403)

        let full = await server.handleRequest(Self.pairRequest(credential: Self.code))
        #expect(full.statusCode == 401)
        #expect(full.bodyString.contains("too_many_paired_devices"))

        // Removing one phone makes room, and the same code still redeems.
        let first = try #require(await server.pairedDevices().first)
        #expect(await server.revokeDevice(id: first.id))
        let paired = await server.handleRequest(Self.pairRequest(credential: Self.code))
        #expect(paired.statusCode == 200)
    }

    @Test("The LAN opt-in defaults to loopback with no advertisement; only explicit consent opens it")
    func lanPolicyDefaultsClosed() {
        // Nothing configured, and every near-miss word: closed.
        for value in [nil, "", "0", "false", "yes", "on", "enabled", "tru"] {
            let policy = CompanionLANPolicy.read(value: value)
            #expect(policy.allowCleartextLAN == false)
            #expect(policy.deviceBindHost == "127.0.0.1")
            #expect(policy.advertisesOnLAN == false)
        }
        #expect(CompanionLANPolicy.read(value: nil).source == .default)
        #expect(CompanionLANPolicy.read(value: "yes").source == .invalid)

        // The listener's own defaults agree: loopback, nothing advertised.
        let defaults = NativeCompanionServer.ListenerOptions()
        #expect(defaults.allowCleartextLAN == false)
        #expect(defaults.resolvedBindAddress == "127.0.0.1")
        #expect(defaults.advertisedName == nil)

        // Only the literal affirmative words are consent, and then the
        // bind and the advertisement open together.
        for value in ["1", "true", " TRUE "] {
            let policy = CompanionLANPolicy.read(value: value)
            #expect(policy.allowCleartextLAN)
            #expect(policy.deviceBindHost == "0.0.0.0")
            #expect(policy.advertisesOnLAN)
            #expect(policy.source == .environment)
            let options = NativeCompanionServer.ListenerOptions(
                allowCleartextLAN: policy.allowCleartextLAN
            )
            #expect(options.resolvedBindAddress == "0.0.0.0")
        }
    }

    @Test("The bearer parser follows the one shared contract")
    func bearerParserContract() {
        #expect(CompanionDeviceRegistry.bearerToken(fromAuthorizationHeader: "Bearer abc") == "abc")
        #expect(CompanionDeviceRegistry.bearerToken(fromAuthorizationHeader: "bearer abc") == "abc")
        #expect(CompanionDeviceRegistry.bearerToken(fromAuthorizationHeader: "Bearer\tabc") == "abc")
        #expect(CompanionDeviceRegistry.bearerToken(fromAuthorizationHeader: "Bearer ") == nil)
        #expect(CompanionDeviceRegistry.bearerToken(fromAuthorizationHeader: "Bearerabc") == nil)
        #expect(CompanionDeviceRegistry.bearerToken(fromAuthorizationHeader: "Basic abc") == nil)
        #expect(CompanionDeviceRegistry.bearerToken(fromAuthorizationHeader: nil) == nil)
        #expect(CompanionDeviceRegistry.bearerToken(fromAuthorizationHeader: "") == nil)
    }
    @Test("Socket events authorization rejects a bad Origin and streams for a native request")
    func eventsStreamOriginGate() async throws {
        let db = try DatabaseService(path: ":memory:")
        let token = "bf_tok_events_origin"
        let server = NativeCompanionServer(database: db, pairedTokens: [token])
        let device = try #require(await server.pairedDevices().first)

        // The socket path (`authorizeEventsStream`, used by `streamEvents`)
        // applies the same Origin gate as `handleRequest`, before auth.
        let badOrigin = await server.authorizeEventsStream(
            Self.authedRequest(path: "/api/events", token: token, extraHeaders: ["Origin": "https://attacker.example"])
        )
        guard case .rejected(let badResponse) = badOrigin else {
            Issue.record("cross-origin events request must be rejected")
            return
        }
        #expect(badResponse.statusCode == 403)
        #expect(badResponse.bodyString.contains("cross-origin"))

        // Even with no credential at all, Origin is refused first (403, not 401).
        let badOriginNoToken = await server.authorizeEventsStream(
            Self.authedRequest(path: "/api/events", token: nil, extraHeaders: ["Origin": "https://attacker.example"])
        )
        guard case .rejected(let noTokenResponse) = badOriginNoToken else {
            Issue.record("cross-origin events request must be rejected before auth")
            return
        }
        #expect(noTokenResponse.statusCode == 403)

        // A native request (no Origin) with a good credential is authorized
        // as its device and actually streams the connected frame.
        let good = await server.authorizeEventsStream(
            Self.authedRequest(path: "/api/events", token: token)
        )
        guard case .authorized(let deviceId) = good else {
            Issue.record("native events request with a paired token must be authorized")
            return
        }
        #expect(deviceId == device.id)
        let stream = await server.subscribeSSE(deviceId: deviceId)
        var iterator = stream.makeAsyncIterator()
        let first = await iterator.next()
        #expect(first?.contains("event: connected") == true)
    }

    @Test("Revoking a device finishes its SSE stream and leaves another device's stream live")
    func revokeTerminatesOnlyThatDevicesStream() async throws {
        let db = try DatabaseService(path: ":memory:")
        let server = NativeCompanionServer(database: db)
        await server.addPairedToken("bf_tok_revoked_stream")
        let victim = try #require(await server.pairedDevices().first)
        await server.addPairedToken("bf_tok_surviving_stream")
        let survivor = try #require(await server.pairedDevices().first { $0.id != victim.id })

        let victimStream = await server.subscribeSSE(deviceId: victim.id)
        let survivorStream = await server.subscribeSSE(deviceId: survivor.id)
        var victimIterator = victimStream.makeAsyncIterator()
        var survivorIterator = survivorStream.makeAsyncIterator()
        #expect(await victimIterator.next()?.contains("event: connected") == true)
        #expect(await survivorIterator.next()?.contains("event: connected") == true)

        #expect(await server.revokeDevice(id: victim.id))

        // The revoked device's stream is finished.
        #expect(await victimIterator.next() == nil)

        // The other device's stream still receives broadcasts: trigger one
        // through its own authenticated interrupt route.
        let interrupt = await server.handleRequest(CompanionHTTPRequest(
            method: "POST",
            path: "/api/threads/thread-1/interrupt",
            headers: ["Authorization": "Bearer bf_tok_surviving_stream"],
            remoteAddress: "192.168.1.50"
        ))
        #expect(interrupt.statusCode == 200)
        let frame = await survivorIterator.next()
        #expect(frame?.contains("thread.interrupted") == true)
    }

}

// MARK: - PR #1477 round 2: 0600-from-creation, coalesced lastSeen, cap on every path

private final class DeviceTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_800_000_000)
    func now() -> Date { lock.lock(); defer { lock.unlock() }; return current }
    func advance(by seconds: TimeInterval) {
        lock.lock(); current = current.addingTimeInterval(seconds); lock.unlock()
    }
}

@Suite("Native companion devices, round 2 (PR #1477)")
struct CompanionDeviceRound2Tests {

    private static func tempDir() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("bf1477r2-\(UUID().uuidString.lowercased())", isDirectory: true)
    }

    private static func fleetRequest(token: String) -> CompanionHTTPRequest {
        CompanionHTTPRequest(
            method: "GET", path: "/api/fleet",
            headers: ["Authorization": "Bearer \(token)"],
            remoteAddress: "192.168.1.50"
        )
    }

    @Test("devices.json is 0600 after persist, replaces a world-readable file, and leaves no temp behind")
    func persistHardensPermissionsAtomically() throws {
        let dir = Self.tempDir()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let storeURL = dir.appendingPathComponent("devices.json")
        // A pre-existing world-readable file must not survive a persist.
        try Data("{}".utf8).write(to: storeURL)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: storeURL.path)

        var registry = CompanionDeviceRegistry()
        registry.register(name: "Ada", token: "bf_tok_perms", nowMs: 1_800_000_000_000)
        try registry.persist(to: storeURL)

        let attrs = try FileManager.default.attributesOfItem(atPath: storeURL.path)
        #expect((attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        #expect(CompanionDeviceRegistry.load(from: storeURL).count == 1)
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: dir.path)
            .filter { $0.hasSuffix(".tmp") }
        #expect(leftovers.isEmpty)
    }

    @Test("A persist that cannot create its file throws and keeps the old bytes")
    func persistPropagatesWriteErrors() throws {
        let dir = Self.tempDir()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
            try? FileManager.default.removeItem(at: dir)
        }
        let storeURL = dir.appendingPathComponent("devices.json")
        var registry = CompanionDeviceRegistry()
        registry.register(name: "Ada", token: "bf_tok_errs", nowMs: 1_800_000_000_000)
        try registry.persist(to: storeURL)
        let before = try Data(contentsOf: storeURL)

        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: dir.path)
        registry.register(name: "Bo", token: "bf_tok_errs_2", nowMs: 1_800_000_000_000)
        #expect(throws: (any Error).self) { try registry.persist(to: storeURL) }
        #expect(try Data(contentsOf: storeURL) == before)
    }

    @Test("The fleet cap bounds seeding, addPairedToken, and a hand-built registry alike")
    func capOnEveryInsertionPath() async throws {
        let db = try DatabaseService(path: ":memory:")
        let seeded = Set((0..<25).map { String(format: "bf_tok_cap_%02d", $0) })
        let server = NativeCompanionServer(database: db, pairedTokens: seeded)
        #expect(await server.pairedDeviceCount == CompanionDeviceRegistry.maxDevices)
        // Deterministic truncation: the sorted-first tokens pair, the rest do not.
        #expect(await server.handleRequest(Self.fleetRequest(token: "bf_tok_cap_00")).statusCode == 200)
        #expect(await server.handleRequest(Self.fleetRequest(token: "bf_tok_cap_24")).statusCode == 401)

        await server.addPairedToken("bf_tok_cap_extra")
        #expect(await server.pairedDeviceCount == CompanionDeviceRegistry.maxDevices)
        #expect(await server.handleRequest(Self.fleetRequest(token: "bf_tok_cap_extra")).statusCode == 401)

        let records = (0..<25).map { i in
            CompanionDeviceRecord(
                id: "dev-\(i)", name: "Companion",
                tokenHash: CompanionDeviceRegistry.tokenHash(for: "bf_tok_reg_\(i)"),
                createdAt: 1, lastSeenAt: 1
            )
        }
        #expect(CompanionDeviceRegistry(devices: records).count == CompanionDeviceRegistry.maxDevices)
    }

    @Test("lastSeenAt flushes are coalesced across devices, then land after the window")
    func lastSeenFlushesCoalesce() async throws {
        let dir = Self.tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let storeURL = dir.appendingPathComponent("devices.json")
        let db = try DatabaseService(path: ":memory:")
        let time = DeviceTestClock()
        let tokenA = "bf_tok_coalesce_a", tokenB = "bf_tok_coalesce_b"
        let server = NativeCompanionServer(
            database: db, pairedTokens: [tokenA, tokenB],
            deviceStoreURL: storeURL, clock: { time.now() }
        )
        func onDiskSeen(_ token: String) -> Double? {
            CompanionDeviceRegistry.load(from: storeURL).devices
                .first { $0.tokenHash == CompanionDeviceRegistry.tokenHash(for: token) }?.lastSeenAt
        }
        let t0 = 1_800_000_000_000.0

        // First sighting of the window flushes immediately.
        #expect(await server.handleRequest(Self.fleetRequest(token: tokenA)).statusCode == 200)
        let afterFirst = try Data(contentsOf: storeURL)
        #expect(onDiskSeen(tokenA) == t0)

        // A second device one second later updates memory only: the file
        // is not rewritten inside the coalescing window.
        time.advance(by: 1)
        #expect(await server.handleRequest(Self.fleetRequest(token: tokenB)).statusCode == 200)
        #expect(await server.pairedDevices().map(\.lastSeenAt) == [t0, t0 + 1_000])
        #expect(try Data(contentsOf: storeURL) == afterFirst)
        #expect(onDiskSeen(tokenB) == t0)

        // The first sighting after the window flushes every pending one.
        time.advance(by: 61)
        #expect(await server.handleRequest(Self.fleetRequest(token: tokenA)).statusCode == 200)
        #expect(onDiskSeen(tokenA) == t0 + 62_000)
        #expect(onDiskSeen(tokenB) == t0 + 1_000)
    }
}
