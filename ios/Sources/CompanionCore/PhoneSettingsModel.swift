import Foundation

#if canImport(Network)
// MARK: - Phone Settings Model (BF-2652)
//
// The Settings > Phone tab renders a `PhoneSettingsSnapshot` and forwards
// gestures through a `PhonePairingBackend`. Production passes the real
// `NativeCompanionListenerBackend`; tests inject the fake in
// `PhoneSettingsModelTests`, so no test turns the listener on, binds a port,
// or touches a credential. The tab is read-only except for the listener
// toggle (owned by `MacSession`), pairing windows, and revocation.

/// One advertised route row, for read-only display. Never a dial target.
public struct PhoneRouteRow: Equatable, Sendable, Identifiable {
    public let url: String
    public let kindLabel: String
    public let protected: Bool

    public var id: String { url }

    public init(url: String, kindLabel: String, protected: Bool) {
        self.url = url
        self.kindLabel = kindLabel
        self.protected = protected
    }
}

/// Everything the Phone tab renders in one refresh.
public struct PhoneSettingsSnapshot: Equatable, Sendable {
    public var window: NativePairingWindow?
    public var inviteURL: URL?
    public var devices: [PairedDevice]
    public var serverName: String
    public var routes: [PhoneRouteRow]

    public init(
        window: NativePairingWindow? = nil,
        inviteURL: URL? = nil,
        devices: [PairedDevice] = [],
        serverName: String = "",
        routes: [PhoneRouteRow] = []
    ) {
        self.window = window
        self.inviteURL = inviteURL
        self.devices = devices
        self.serverName = serverName
        self.routes = routes
    }
}

/// The seam the Phone tab is tested against: pairing windows, the public
/// device list, revocation, and the current advertisement. No listener
/// power, bind, or credential state travels through it.
public protocol PhonePairingBackend: Sendable {
    func openPairingWindow() async -> NativePairingWindow?
    func closePairingWindow() async
    func activePairingWindow() async -> NativePairingWindow?
    func pairedDevices() async -> [PairedDevice]
    func revokeDevice(id: String) async -> Bool
    func currentAdvertisement() async -> CompanionEndpointAdvertisement
}

extension NativeCompanionListenerBackend: PhonePairingBackend {}

/// Loads snapshots over any `PhonePairingBackend`.
public struct PhoneSettingsSnapshotLoader<Backend: PhonePairingBackend>: Sendable {
    public let backend: Backend

    public init(backend: Backend) {
        self.backend = backend
    }

    public func load() async -> PhoneSettingsSnapshot {
        let window = await backend.activePairingWindow()
        let devices = await backend.pairedDevices()
        let advertisement = await backend.currentAdvertisement()
        let invite = window.flatMap {
            NativeCompanionServer.makePairingInviteURL(window: $0, advertisement: advertisement)
        }
        return PhoneSettingsSnapshot(
            window: window,
            inviteURL: invite,
            devices: devices,
            serverName: advertisement.serverName,
            routes: PhoneSettingsDisplay.routeRows(advertisement: advertisement)
        )
    }
}

/// Display rules for the Phone tab. Pure, so every rule is unit-tested.
public enum PhoneSettingsDisplay {
    /// Groups a 6-digit code for readability ("123456" -> "123 456").
    /// Anything else passes through untouched.
    public static func groupedCode(_ code: String) -> String {
        guard code.count == 6, code.allSatisfy(\.isNumber) else { return code }
        return "\(code.prefix(3)) \(code.suffix(3))"
    }

    public static func kindLabel(for kind: CompanionEndpointKind) -> String {
        switch kind {
        case .hosted: return "Hosted HTTPS"
        case .tailnet: return "Tailscale"
        case .lan: return "Local network"
        case .bonjour: return "Bonjour"
        }
    }

    /// One row per advertised endpoint, in advertisement order, for
    /// read-only display. Uses the endpoint's own status copy, never raw
    /// host math in the view.
    public static func routeRows(advertisement: CompanionEndpointAdvertisement) -> [PhoneRouteRow] {
        advertisement.endpoints.map { endpoint in
            PhoneRouteRow(
                url: endpoint.displayAddress,
                kindLabel: kindLabel(for: endpoint.kind),
                protected: endpoint.protectsCredentials
            )
        }
    }
}
#endif
