import Foundation
import Testing
@testable import CompanionCore

/// The Phone tab's display rules and snapshot loading (BF-2652).
///
/// Most tests run against the fake backend below: the real
/// `NativeCompanionListenerBackend` is otherwise never started, and no
/// credential leaves a pairing window.  The stop-clears test starts a real
/// server on an ephemeral loopback port, like the runtime suites.
@Suite("Phone Settings Model (BF-2652)")
struct PhoneSettingsModelTests {
    /// In-test backend: scripted window, devices, and advertisement, with a
    /// ledger of revocations. Sendable by actor isolation, like the real one.
    actor FakePhoneBackend: PhonePairingBackend {
        var window: NativePairingWindow?
        var devices: [PairedDevice] = []
        var advertisement: CompanionEndpointAdvertisement = CompanionEndpointAdvertisement()
        var revokedIds: [String] = []
        /// Scripted answers for `activePairingWindow`, consumed in order.
        /// When empty the test falls back to `window`.
        var windowScript: [NativePairingWindow?] = []
        var activeCalls = 0

        /// A valid-shape pairing credential: the parser only accepts
        /// `omb_pair_` tokens of exactly 52 bytes.
        static let fakeQRCredential = "omb_pair_" + String(repeating: "a", count: 43)

        func openPairingWindow() async -> NativePairingWindow? {
            window = NativePairingWindow(
                code: "123456",
                qrCredential: Self.fakeQRCredential,
                expiresAt: Date(timeIntervalSince1970: 1_700_000_100),
                attemptsRemaining: 3
            )
            return window
        }

        func closePairingWindow() async {
            window = nil
        }

        func activePairingWindow() async -> NativePairingWindow? {
            activeCalls += 1
            if !windowScript.isEmpty { return windowScript.removeFirst() }
            return window
        }

        func pairedDevices() async -> [PairedDevice] {
            devices
        }

        func revokeDevice(id: String) async -> Bool {
            revokedIds.append(id)
            devices.removeAll { $0.id == id }
            return true
        }

        func currentAdvertisement() async -> CompanionEndpointAdvertisement {
            advertisement
        }
    }

    private func hostedAdvertisement() -> CompanionEndpointAdvertisement {
        CompanionEndpointAdvertisement.build(
            serverName: "Ada's Mac",
            port: 8810,
            hostedURL: "https://mac.botfleet.app",
            tailnetHost: "ada-mac.tail0000.ts.net",
            lanHosts: [],
            allowCleartextLAN: false
        )
    }

    @Test("A six-digit code groups for display; anything else passes through")
    func groupedCode() {
        #expect(PhoneSettingsDisplay.groupedCode("123456") == "123 456")
        #expect(PhoneSettingsDisplay.groupedCode("12345") == "12345")
        #expect(PhoneSettingsDisplay.groupedCode("") == "")
        #expect(PhoneSettingsDisplay.groupedCode("12a456") == "12a456")
    }

    @Test("The invite URL round-trips through the phone's parser")
    func inviteURLRoundTrip() async throws {
        let backend = FakePhoneBackend()
        _ = await backend.openPairingWindow()
        await backend.setAdvertisement(hostedAdvertisement())

        let loader = PhoneSettingsSnapshotLoader(backend: backend)
        let snapshot = await loader.load()

        let invite = try #require(snapshot.inviteURL)
        let parsed = try #require(PairingInvite.parse(invite))
        // The QR credential is what the window minted, not a device secret.
        #expect(parsed.credential == FakePhoneBackend.fakeQRCredential)
    }

    @Test("Revocation names the id and the device is gone on reload")
    func revokeRemovesDevice() async {
        let backend = FakePhoneBackend()
        await backend.setDevices([
            PairedDevice(id: "d-1", name: "Jay's iPhone", createdAt: 1_700_000_000, lastSeenAt: 1_700_000_050),
        ])
        let loader = PhoneSettingsSnapshotLoader(backend: backend)

        #expect(await loader.load().devices.count == 1)
        #expect(await backend.revokeDevice(id: "d-1") == true)
        #expect(await backend.revokedIdLog() == ["d-1"])
        #expect(await loader.load().devices.isEmpty)
    }

    @Test("Device rows carry no token material")
    func deviceRowsCarryNoTokenMaterial() throws {
        let row = PairedDevice(id: "d-1", name: "Jay's iPhone", createdAt: 1_700_000_000, lastSeenAt: 1_700_000_050)
        // The row encodes as exactly its four public fields: id, name,
        // and the two timestamps. A push token has nowhere to hide because
        // `PairedDevice` has no such field.
        let object = try JSONSerialization.jsonObject(with: try JSONEncoder().encode(row)) as? [String: Any]
        #expect(Set((object ?? [:]).keys.map { $0 }) == ["id", "name", "createdAt", "lastSeenAt"])
    }

    @Test("Route rows label and protect each advertised endpoint")
    func routeRows() {
        let rows = PhoneSettingsDisplay.routeRows(advertisement: hostedAdvertisement())
        #expect(rows.map(\.kindLabel) == ["Hosted HTTPS", "Tailscale"])
        #expect(rows.allSatisfy { $0.protected })
        #expect(rows.allSatisfy { !$0.url.isEmpty })
    }

    @Test("A closed advertisement carries no local-network row")
    func closedAdvertisementHasNoLANRow() {
        let closed = CompanionEndpointAdvertisement.build(
            serverName: "Ada's Mac",
            port: 8810,
            hostedURL: nil,
            tailnetHost: "ada-mac.tail0000.ts.net",
            lanHosts: ["192.168.1.25"],
            allowCleartextLAN: false
        )
        let rows = PhoneSettingsDisplay.routeRows(advertisement: closed)
        #expect(rows.map(\.kindLabel) == ["Tailscale"])
    }

    @Test("The backend never advertises what it did not serve")
    func backendAdvertisesOnlyWhatItServed() async {
        // The closure only runs on start; this test never starts the
        // listener, so nothing is bound and no store is opened.
        let backend = NativeCompanionListenerBackend { _ in
            fatalError("the cache test never starts the listener")
        }
        #expect(await backend.currentAdvertisement() == CompanionEndpointAdvertisement())
        // With no server running, asking for an advertisement must not
        // change what the tab shows: the cache records only advertisements
        // that were actually handed to a running server.
        await backend.setEndpointAdvertisement(hostedAdvertisement())
        #expect(await backend.currentAdvertisement() == CompanionEndpointAdvertisement())
    }

    @Test("Stopping clears the served advertisement on both sides of the backend")
    func stopClearsServedAdvertisement() async throws {
        struct EndpointSnapshot: Decodable {
            let serverName: String
            let endpoints: [CompanionEndpoint]
        }
        let database = try DatabaseService(path: ":memory:")
        // Fixture-only token, never a real pairing secret: the endpoints
        // route is bearer-gated, like every non-open route.  The header is
        // interpolated, matching the runtime suites, so no bearer literal
        // is stored in source.
        let pairingTag = "bf_test_" + "stop_clears"
        let server = NativeCompanionServer(database: database, pairedTokens: [pairingTag])
        let headers = ["Authorization": "Bearer \(pairingTag)"]
        let backend = NativeCompanionListenerBackend { _ in server }
        _ = try await backend.start(advertising: nil) { _ in }
        let hosted = hostedAdvertisement()
        await backend.setEndpointAdvertisement(hosted)
        #expect(await backend.currentAdvertisement() == hosted)
        let serving = await server.handleRequest(CompanionHTTPRequest(method: "GET", path: "/api/companion/endpoints", headers: headers))
        #expect(serving.statusCode == 200)
        let servingSnapshot = try serving.decodeJSON(EndpointSnapshot.self)
        #expect(!servingSnapshot.endpoints.isEmpty)
        await backend.stop()
        #expect(await backend.currentAdvertisement() == CompanionEndpointAdvertisement())
        let stopped = await server.handleRequest(CompanionHTTPRequest(method: "GET", path: "/api/companion/endpoints", headers: headers))
        #expect(stopped.statusCode == 200)
        #expect(try stopped.decodeJSON(EndpointSnapshot.self).endpoints.isEmpty)
        // A restart without a fresh advertisement serves nothing stale on
        // either side: the tab and the endpoints route agree.
        _ = try await backend.start(advertising: nil) { _ in }
        #expect(await backend.currentAdvertisement() == CompanionEndpointAdvertisement())
        let restarted = await server.handleRequest(CompanionHTTPRequest(method: "GET", path: "/api/companion/endpoints", headers: headers))
        #expect(try restarted.decodeJSON(EndpointSnapshot.self).endpoints.isEmpty)
        await backend.stop()
    }

    @Test("No window means no invite, and no devices means an empty list")
    func emptySnapshot() async {
        let loader = PhoneSettingsSnapshotLoader(backend: FakePhoneBackend())
        let snapshot = await loader.load()
        #expect(snapshot.window == nil)
        #expect(snapshot.inviteURL == nil)
        #expect(snapshot.devices.isEmpty)
        #expect(snapshot.routes.isEmpty)
    }

    @Test("A rotating window is re-read until the snapshot is self-consistent")
    func consistentLoadRetriesOnRotation() async {
        let first = NativePairingWindow(code: "111111", qrCredential: FakePhoneBackend.fakeQRCredential, expiresAt: Date(timeIntervalSince1970: 1_700_000_100), attemptsRemaining: 3)
        let second = NativePairingWindow(code: "222222", qrCredential: FakePhoneBackend.fakeQRCredential, expiresAt: Date(timeIntervalSince1970: 1_700_000_200), attemptsRemaining: 3)
        let backend = FakePhoneBackend()
        // First snapshot sees `first`; the re-read sees the rotated `second`,
        // so the loader reloads once more and settles on `second`.
        await backend.setWindowScript([first, second, second, second])
        let loader = PhoneSettingsSnapshotLoader(backend: backend)
        let snapshot = await loader.loadConsistent()
        #expect(snapshot.window == second)
        #expect(await backend.activeCallCount() >= 3)
    }

    @Test("A never-settling window still terminates within its attempt budget")
    func consistentLoadAlwaysTerminates() async {
        let first = NativePairingWindow(code: "111111", qrCredential: FakePhoneBackend.fakeQRCredential, expiresAt: Date(timeIntervalSince1970: 1_700_000_100), attemptsRemaining: 3)
        let second = NativePairingWindow(code: "222222", qrCredential: FakePhoneBackend.fakeQRCredential, expiresAt: Date(timeIntervalSince1970: 1_700_000_200), attemptsRemaining: 3)
        let backend = FakePhoneBackend()
        // The window flips on every read; the loader must still return after
        // maxAttempts snapshots instead of retrying forever.
        await backend.setWindowScript([first, second, first, second, first, second, first, second])
        let loader = PhoneSettingsSnapshotLoader(backend: backend)
        let snapshot = await loader.loadConsistent(maxAttempts: 3)
        #expect(snapshot.window == first || snapshot.window == second)
        #expect(await backend.activeCallCount() <= 2 * 3 + 1)
    }
}

// MARK: - Fake helpers (test-only setters; the protocol stays read-shaped)

extension PhoneSettingsModelTests.FakePhoneBackend {
    func setAdvertisement(_ advertisement: CompanionEndpointAdvertisement) {
        self.advertisement = advertisement
    }

    func setWindowScript(_ script: [NativePairingWindow?]) {
        self.windowScript = script
    }

    func activeCallCount() -> Int {
        self.activeCalls
    }

    func setDevices(_ devices: [PairedDevice]) {
        self.devices = devices
    }

    func revokedIdLog() -> [String] {
        revokedIds
    }
}
