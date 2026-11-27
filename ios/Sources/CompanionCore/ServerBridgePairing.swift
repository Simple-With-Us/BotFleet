import Foundation

#if canImport(Network)
// MARK: - Server Phone Pairing (BF-2713)
//
// The Settings > Phone tab pairs phones with this Mac through
// `NativeCompanionListenerBackend`, and with the server through this backend:
// the same `PhonePairingBackend` seam, answered by the Linux companion
// bridge. The desktop never talks to the bridge directly. Its gate credential
// is bound to the one origin it enrolled on, so the owner gate on that origin
// answers five paths under `/api/companion/bridge/` by passing them to the
// bridge on loopback (`deploy/linux-server/owner-gate.mjs`), and the bridge
// makes the same owner decision again on its own listener.
//
// This backend opens no listener, binds no port and stores no credential
// beyond the one it was handed, which already belongs to the host.

/// A refusal from the server that the caller can tell apart.
public enum ServerBridgeError: Error, Equatable, LocalizedError, Sendable {
    /// A 404: the gate's own says this server has no companion bridge behind
    /// the prefix, and the bridge's names what it does not know.
    case notConfigured(String?)
    case authentication
    /// The gate answered 502: the bridge is not answering.
    case unavailable
    /// The bridge answered 503: it could not hold a change, so the change did not happen.
    case notSaved
    case invalidResponse

    public var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "This server has no phone pairing.\u{00A0} Its companion bridge is not set up."
        case .authentication:
            return "This Mac is not allowed to pair phones with that server.\u{00A0} Test the server again in Servers."
        case .unavailable:
            return "The server's phone pairing is not answering.\u{00A0} Try again."
        case .notSaved:
            return "The server could not save that change, so it did not happen.\u{00A0} Try again."
        case .invalidResponse:
            return "The server answered in a way this app could not read."
        }
    }
}

/// Pairs phones with the server's companion bridge, through the owner gate on
/// the origin this Mac is enrolled on.
public actor ServerBridgePairingBackend: PhonePairingBackend {
    private let host: HostRecord
    private var credential: HostGateCredential?
    private let session: URLSession

    /// The window this backend opened and the server has not closed. The
    /// bridge answers a window only when it opens one, so this is the only
    /// copy; it is dropped when it expires or is closed.
    private var opened: NativePairingWindow?

    /// Why the last request failed, for the tab to show. Nil after a request that succeeded.
    public private(set) var lastError: ServerBridgeError?

    /// The servers this process has a backend for, by record id.
    private static let registry = ServerBridgePairingRegistry()

    public init(host: HostRecord, credential: HostGateCredential?, session: URLSession = .shared) {
        self.host = host
        self.credential = credential
        self.session = session
    }

    /// The one backend for one enrolled server, for the life of the process.
    /// The bridge answers a window only when it opens one, so an open window
    /// lives here alone: a backend made anew by a tab that closed and
    /// reopened would know nothing about it, and its code could not be
    /// closed from the app until it expired. The credential is refreshed on
    /// every lookup that carries one, because a server can be enrolled again;
    /// a lookup with none leaves the enrolled one in place, because a read
    /// that failed once must not cost the tab its pairing until the next one.
    public static func shared(host: HostRecord, credential: HostGateCredential?, session: URLSession = .shared) async -> ServerBridgePairingBackend {
        let backend = await registry.backend(for: host, session: session)
        if let credential { await backend.updateCredential(credential) }
        return backend
    }

    /// Forgets every server that is no longer enrolled, with its credential
    /// and any window it remembers, which is closed on the server first. A
    /// list that was not read (`nil`) forgets nothing: it does not say that
    /// no server is enrolled, and a window a forgotten backend remembered
    /// would stay open on its server with nothing left to close it.
    public static func retainOnly(_ hostIDs: Set<String>?) async {
        guard let hostIDs else { return }
        await registry.retainOnly(hostIDs)
    }

    /// A credential enrolled again for the same server replaces the old one;
    /// the open window, if any, stays.
    public func updateCredential(_ credential: HostGateCredential?) {
        self.credential = credential
    }

    public func openPairingWindow() async -> NativePairingWindow? {
        let wire: PairingWindowWire
        do {
            wire = try await exchange(Request(path: "/api/companion/bridge/pairing/open", method: "POST", body: Data("{}".utf8)),
                                      as: PairingWindowWire.self)
        } catch {
            lastError = Self.bridgeError(error)
            return nil
        }
        let now = Date().timeIntervalSince1970 * 1_000
        guard wire.code.count == 6, wire.code.allSatisfy({ $0.isASCII && $0.isNumber }),
              wire.token.utf8.count <= 4_096,
              wire.expiresAtMs.isFinite, wire.expiresAtMs > now, wire.expiresAtMs <= now + 3_600_000,
              wire.attemptsLeft >= 1 else {
            lastError = .invalidResponse
            return nil
        }
        lastError = nil
        let window = NativePairingWindow(
            code: wire.code,
            qrCredential: Self.isQRCredential(wire.token) ? wire.token : nil,
            expiresAt: Date(timeIntervalSince1970: wire.expiresAtMs / 1_000),
            attemptsRemaining: wire.attemptsLeft
        )
        opened = window
        return window
    }

    /// The one QR credential shape the phone's parser accepts
    /// (`PairingInvite.parse`): `omb_pair_` and 43 more characters. A token of
    /// any other shape is left out of the QR, which then carries the code.
    static func isQRCredential(_ token: String) -> Bool {
        guard token.hasPrefix("omb_pair_"), token.utf8.count == 52 else { return false }
        return token.dropFirst("omb_pair_".count).utf8.allSatisfy { byte in
            (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte)
                || byte == 45 || byte == 95
        }
    }

    public func closePairingWindow() async {
        // Asked of the bridge whether or not this backend remembers a window.
        // The bridge keeps one window at a time, and one this backend never
        // saw, opened before the app last launched, closes the same way.
        do {
            _ = try await exchange(Request(path: "/api/companion/bridge/pairing/close", method: "POST", body: Data("{}".utf8)),
                                   as: CloseWire.self)
        } catch {
            // The bridge keeps a window whose close it could not hold, so the
            // tab keeps showing it too; the reason is what the tab shows.
            lastError = Self.bridgeError(error)
            return
        }
        lastError = nil
        opened = nil
    }

    /// Closes the window this backend remembers, and nothing else. For a
    /// backend the registry is forgetting: its server keeps that window open
    /// until it expires, and nothing would be left to close it. The answer
    /// is not read; a window the server could not close expires there.
    func closeRememberedWindow() async {
        guard await activePairingWindow() != nil else { return }
        await closePairingWindow()
    }

    public func activePairingWindow() async -> NativePairingWindow? {
        guard let window = opened else { return nil }
        guard window.expiresAt > Date() else {
            opened = nil
            return nil
        }
        return window
    }

    public func pairedDevices() async -> [PairedDevice] {
        let wire: DeviceListWire
        do {
            wire = try await exchange(Request(path: "/api/companion/bridge/devices", method: "GET", body: nil), as: DeviceListWire.self)
        } catch {
            lastError = Self.bridgeError(error)
            return []
        }
        lastError = nil
        return wire.devices.compactMap { row in
            guard !row.id.isEmpty, row.pairedAtMs.isFinite, row.pairedAtMs >= 0 else { return nil }
            return PairedDevice(id: row.id, name: row.name, createdAt: row.pairedAtMs / 1_000, lastSeenAt: row.pairedAtMs / 1_000)
        }
    }

    public func revokeDevice(id: String) async -> Bool {
        guard !id.isEmpty, id.utf8.count <= 128, id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else {
            return false
        }
        do {
            let wire: RevokedWire = try await exchange(Request(path: "/api/companion/bridge/devices/\(id)", method: "DELETE", body: nil), as: RevokedWire.self)
            guard wire.revoked else { throw ServerBridgeError.invalidResponse }
        } catch ServerBridgeError.notConfigured("unknown device") {
            // The bridge knows the route and not the device: it is already not
            // paired, which is what a revoke asks for.
            lastError = nil
            return true
        } catch {
            // Any other 404 is the gate's: this server has no bridge, and the
            // tab says so instead of calling that a revoke.
            lastError = Self.bridgeError(error)
            return false
        }
        lastError = nil
        return true
    }

    public func currentAdvertisement() async -> CompanionEndpointAdvertisement {
        let wire: AdvertisementWire
        do {
            wire = try await exchange(Request(path: "/api/companion/bridge/endpoints", method: "GET", body: nil), as: AdvertisementWire.self)
        } catch {
            lastError = Self.bridgeError(error)
            return CompanionEndpointAdvertisement()
        }
        lastError = nil
        return CompanionEndpointAdvertisement(serverName: wire.serverName, hosts: [], endpoints: wire.endpoints)
    }

    // MARK: - The wire

    private struct Request {
        let path: String
        let method: String
        let body: Data?
    }

    private struct PairingWindowWire: Decodable {
        let code: String
        let token: String
        let expiresAtMs: Double
        let attemptsLeft: Int
    }

    private struct CloseWire: Decodable {
        let closed: Bool
    }

    private struct DeviceListWire: Decodable {
        let devices: [DeviceRowWire]
    }

    private struct DeviceRowWire: Decodable {
        let id: String
        let name: String
        let pairedAtMs: Double
    }

    private struct RevokedWire: Decodable {
        let revoked: Bool
    }

    private struct RefusalWire: Decodable {
        let error: String
    }

    private struct AdvertisementWire: Decodable {
        let serverName: String
        let endpoints: [CompanionEndpoint]
    }

    /// One request to the enrolled origin, with the credential that belongs
    /// to it and to nothing else. A redirect to another origin is refused by
    /// the delegate before the credential could follow it.
    private func exchange<Wire: Decodable>(_ request: Request, as type: Wire.Type) async throws -> Wire {
        do { try host.validate() } catch { throw ServerBridgeError.invalidResponse }
        guard !host.isLocal else { throw ServerBridgeError.invalidResponse }
        guard let credential else { throw ServerBridgeError.authentication }
        guard let url = URL(string: request.path, relativeTo: host.origin.url)?.absoluteURL else { throw ServerBridgeError.invalidResponse }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method
        urlRequest.timeoutInterval = 20
        urlRequest.cachePolicy = .reloadIgnoringLocalCacheData
        if let body = request.body {
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            urlRequest.httpBody = body
        }
        do { try credential.authorize(&urlRequest) } catch { throw ServerBridgeError.authentication }
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: urlRequest, delegate: HostOriginRedirectPolicy(origin: host.origin))
        } catch {
            throw ServerBridgeError.unavailable
        }
        guard let http = response as? HTTPURLResponse, http.url.map(host.origin.contains) == true else {
            throw ServerBridgeError.invalidResponse
        }
        switch http.statusCode {
        case 200, 201:
            do { return try JSONDecoder().decode(Wire.self, from: data) } catch { throw ServerBridgeError.invalidResponse }
        case 401, 403:
            throw ServerBridgeError.authentication
        case 404:
            // The gate answers 404 for a server with no bridge behind the
            // prefix and the bridge for a device it does not know; the reason
            // travels with the answer so a caller can tell them apart.
            let reason = (try? JSONDecoder().decode(RefusalWire.self, from: data))?.error
            throw ServerBridgeError.notConfigured(reason)
        case 502:
            throw ServerBridgeError.unavailable
        case 503:
            throw ServerBridgeError.notSaved
        default:
            throw ServerBridgeError.invalidResponse
        }
    }

    private static func bridgeError(_ error: Error) -> ServerBridgeError {
        (error as? ServerBridgeError) ?? .invalidResponse
    }
}

/// One `ServerBridgePairingBackend` per enrolled server for the life of the
/// process, so an open pairing window outlives the tab that opened it.
private actor ServerBridgePairingRegistry {
    private var backends: [String: (host: HostRecord, backend: ServerBridgePairingBackend)] = [:]

    /// The backend for one server record. A record enrolled again with
    /// another address or identity is another server to this app, so it gets
    /// a new backend and the old one is forgotten, its window closed on the
    /// server it is still open on; a new name alone changes nothing. The
    /// session is the one given when the backend was first made.
    func backend(for host: HostRecord, session: URLSession) -> ServerBridgePairingBackend {
        if let existing = backends[host.id],
           existing.host.origin == host.origin, existing.host.hostId == host.hostId {
            return existing.backend
        }
        let created = ServerBridgePairingBackend(host: host, credential: nil, session: session)
        if let replaced = backends[host.id]?.backend { forget(replaced) }
        backends[host.id] = (host, created)
        return created
    }

    func retainOnly(_ hostIDs: Set<String>) {
        backends.values.filter { !hostIDs.contains($0.host.id) }.map(\.backend).forEach(forget)
        backends = backends.filter { hostIDs.contains($0.key) }
    }

    /// A forgotten backend's window is closed off this actor: the server may
    /// take a while to answer, and a lookup must not wait behind it.
    private func forget(_ backend: ServerBridgePairingBackend) {
        Task.detached(priority: .utility) { await backend.closeRememberedWindow() }
    }
}
#endif
