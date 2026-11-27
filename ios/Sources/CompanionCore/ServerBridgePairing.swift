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
    /// The gate answered 404: this server has no companion bridge.
    case notConfigured
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
    private let credential: HostGateCredential?
    private let session: URLSession

    /// The window this backend opened and the server has not closed. The
    /// bridge answers a window only when it opens one, so this is the only
    /// copy; it is dropped when it expires or is closed.
    private var opened: NativePairingWindow?

    /// Why the last request failed, for the tab to show. Nil after a request that succeeded.
    public private(set) var lastError: ServerBridgeError?

    public init(host: HostRecord, credential: HostGateCredential?, session: URLSession = .shared) {
        self.host = host
        self.credential = credential
        self.session = session
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
        guard opened != nil else { return }
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
            // A device the bridge no longer knows is already not paired, which
            // is what a revoke asks for; whether the bridge is set up at all
            // is the next device list's answer to give.
            guard wire.revoked else { throw ServerBridgeError.notConfigured }
        } catch ServerBridgeError.notConfigured {
            lastError = nil
            return true
        } catch {
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
            throw ServerBridgeError.notConfigured
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
#endif
