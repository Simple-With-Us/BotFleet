import SwiftUI
import CompanionCore
#if canImport(AppKit)
import AppKit
#endif
#if canImport(CoreGraphics)
import CoreGraphics
#endif
#if canImport(CoreImage.CIFilterBuiltins)
import CoreImage.CIFilterBuiltins
#endif

/// Settings > Phone (BF-2652): pairing, devices, and routes.
///
/// The tab is read-only except for the listener toggle (owned by
/// `MacSession`), pairing windows, and revocation. It never renders
/// credentials except the active pairing code and invite, which die with
/// their window: device rows come from `publicDevice`, which carries no
/// push token by construction.
///
/// Below the Mac's own cards sits the server's: the same code, QR, phones
/// and routes, answered by the server's companion bridge through the owner
/// gate on the origin this Mac is enrolled on (`ServerPairingCard`). It
/// needs no listener on this Mac and follows the server the saved placement
/// names, or the one server this Mac is enrolled on.
struct MacPhoneSettings: View {
    @ObservedObject var session: MacSession
    @ObservedObject private var servers: ServersCoordinator

    @State private var serverBackend: ServerBridgePairingBackend?
    @State private var serverLabel: String = ""

    init(session: MacSession) {
        self.session = session
        self._servers = ObservedObject(wrappedValue: session.servers)
    }

    @State private var devices: [PairedDevice] = []
    @State private var window: NativePairingWindow?
    @State private var inviteURL: URL?
    @State private var routes: [PhoneRouteRow] = []
    @State private var serverName: String = ""
    @State private var errorMessage: String?
    @State private var renderedQR: NSImage? = nil
    @State private var renderedQRKey: String? = nil

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                GroupBox("Phone Pairing") {
                    VStack(alignment: .leading, spacing: 12) {
                        Toggle(
                            "Allow Phone Pairing",
                            isOn: Binding(
                                get: { session.companionListenerEnabled },
                                set: { newValue in
                                    Task { await session.setCompanionListenerEnabled(newValue) }
                                }
                            )
                        )
                        Text(session.companionListenerState.summary)
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                if session.companionListenerEnabled {
                    pairingCard
                    devicesCard
                    routesCard
                } else {
                    Text("Turn on phone pairing to show a code.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                if let serverBackend {
                    ServerPairingCard(backend: serverBackend, title: serverLabel)
                } else if servers.isLoaded {
                    Text("No server to pair a phone with.\u{00A0} Add one under Servers.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundColor(.red)
                }
            }
            .padding(24)
        }
        .task(id: session.companionListenerEnabled) { await reload() }
        .task(id: servers.hosts) { await prepareServerPairing() }
    }

    /// The server a phone can pair with: the one the saved placement names,
    /// or the only other server this Mac is enrolled on. The credential is
    /// the one enrolled for that host and no other. The backend is the one
    /// this process keeps for that server, so a pairing window it opened
    /// survives this tab closing and can still be closed when it reopens.
    /// Only a server list that was read says which backends to drop; one
    /// that was not read leaves them all where they are.
    private func prepareServerPairing() async {
        await servers.load()
        await ServerBridgePairingBackend.retainOnly(servers.enrolledServerIDs)
        let remote = servers.hosts.filter { !$0.isLocal }
        let placed = servers.placement.saved.serverID
        guard let server = remote.first(where: { $0.id == placed }) ?? remote.first else {
            serverBackend = nil
            serverLabel = ""
            return
        }
        let credential = await servers.credential(for: server)
        serverBackend = await ServerBridgePairingBackend.shared(host: server, credential: credential)
        serverLabel = server.name
    }

    private var pairingCard: some View {
        GroupBox("Pairing Code") {
            VStack(alignment: .leading, spacing: 12) {
                if let window, inviteURL != nil {
                    if let qr = renderedQR {
                        Image(nsImage: qr)
                            .resizable()
                            .interpolation(.none)
                            .frame(width: 180, height: 180)
                            .accessibilityLabel("Pairing Code QR")
                    }
                    Text(PhoneSettingsDisplay.groupedCode(window.code))
                        .font(.system(size: 32, weight: .semibold, design: .monospaced))
                    Text("Expires \(window.expiresAt, format: Date.FormatStyle(date: .omitted, time: .shortened)) · \(window.attemptsRemaining) attempts left")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Button("Close Code") {
                        Task {
                            await session.closePhonePairingWindow()
                            await reload()
                        }
                    }
                } else {
                    Button("Show Pairing Code") {
                        Task {
                            errorMessage = nil
                            if await session.openPhonePairingWindow() == nil {
                                errorMessage = "Could not open a pairing window.\u{00A0} Make sure the listener is on."
                            }
                            await reload()
                        }
                    }
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var devicesCard: some View {
        GroupBox("Paired Phones") {
            VStack(alignment: .leading, spacing: 8) {
                if devices.isEmpty {
                    Text("No phones paired.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                } else {
                    ForEach(devices) { device in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(device.name).font(.body)
                                Text("Added \(phoneDate(device.createdAt))")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                            Spacer()
                            Button("Revoke") {
                                Task {
                                    if await session.revokePairedPhone(id: device.id) {
                                        await reload()
                                    } else {
                                        errorMessage = "Could not revoke \(device.name). Try again."
                                    }
                                }
                            }
                        }
                        Divider()
                    }
                }
                Button("Refresh") {
                    Task { await reload() }
                }
                .font(.caption)
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var routesCard: some View {
        GroupBox("Advertised Routes (Read-Only)") {
            VStack(alignment: .leading, spacing: 8) {
                if routes.isEmpty {
                    Text(serverName.isEmpty ? "No routes advertised yet." : "\(serverName) advertises no routes yet.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Text("Routes appear here once the companion advertises them.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                } else {
                    ForEach(routes) { route in
                        HStack {
                            Text(route.url).font(.body)
                            Spacer()
                            Label(route.kindLabel, systemImage: route.protected ? "lock.fill" : "house")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        Divider()
                    }
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func reload() async {
        errorMessage = nil
        let snapshot = await session.loadPhoneSnapshot()
        devices = snapshot.devices
        window = snapshot.window
        inviteURL = snapshot.inviteURL
        serverName = snapshot.serverName
        routes = snapshot.routes
        if let inviteURL {
            let key = inviteURL.absoluteString
            if renderedQRKey != key {
                // Drop the old code at once: the new window's invite must
                // never show the previous window's QR while it renders.
                renderedQR = nil
                let image = await Task.detached(priority: .userInitiated) {
                    Self.makeQRImage(from: key)
                }.value
                guard self.inviteURL?.absoluteString == key else { return }
                if let image {
                    // The key is set only on success, so a failed render
                    // stays retryable: Refresh re-renders instead of
                    // serving the cached failure forever.
                    renderedQRKey = key
                    renderedQR = image
                } else {
                    renderedQRKey = nil
                    renderedQR = nil
                    errorMessage = "Could not draw the pairing code.\u{00A0} Select Refresh to try again."
                }
            }
        } else {
            renderedQRKey = nil
            renderedQR = nil
        }
    }

    private func phoneDate(_ seconds: Double) -> String {
        Self.phoneDateString(seconds)
    }

    static func phoneDateString(_ seconds: Double) -> String {
        Date(timeIntervalSince1970: seconds).formatted(date: .abbreviated, time: .omitted)
    }

    /// Renders off the main thread: reload() awaits this in a detached
    /// task and assigns the result back on the MainActor, so pairing-window
    /// fetches, toggles, and Refresh never stall interaction. The context
    /// is created per render because the shared one lives on the MainActor;
    /// renders happen once per pairing window, so setup cost is negligible.
    nonisolated static func makeQRImage(from string: String) -> NSImage? {
        #if canImport(CoreImage.CIFilterBuiltins)
        let context = CIContext()
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: 180, height: 180))
        #else
        return nil
        #endif
    }
}

/// The server's half of the Phone tab (BF-2713): what `MacPhoneSettings`
/// shows for this Mac, answered by the server's companion bridge. It owns
/// its own snapshot because the server's window and devices live there and
/// not in `MacSession`; like the Mac's cards it renders a credential only
/// while its window is open.
private struct ServerPairingCard: View {
    let backend: ServerBridgePairingBackend
    let title: String

    @State private var snapshot = PhoneSettingsSnapshot()
    @State private var errorMessage: String?
    @State private var renderedQR: NSImage? = nil
    @State private var renderedQRKey: String? = nil

    var body: some View {
        GroupBox("Pair With \(title.isEmpty ? "The Server" : title)") {
            VStack(alignment: .leading, spacing: 12) {
                Text("A phone paired here syncs with the server, not with this Mac.")
                    .font(.caption)
                    .foregroundColor(.secondary)

                if let window = snapshot.window, snapshot.inviteURL != nil {
                    if let qr = renderedQR {
                        Image(nsImage: qr)
                            .resizable()
                            .interpolation(.none)
                            .frame(width: 180, height: 180)
                            .accessibilityLabel("Server Pairing Code QR")
                    }
                    Text(PhoneSettingsDisplay.groupedCode(window.code))
                        .font(.system(size: 32, weight: .semibold, design: .monospaced))
                    Text("Expires \(window.expiresAt, format: Date.FormatStyle(date: .omitted, time: .shortened)) · \(window.attemptsRemaining) attempts left")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Button("Close Code") {
                        Task {
                            await backend.closePairingWindow()
                            await reload()
                        }
                    }
                } else {
                    Button("Show Server Pairing Code") {
                        Task {
                            if await backend.openPairingWindow() == nil {
                                errorMessage = (await backend.lastError)?.errorDescription
                                    ?? "Could not open a pairing window on the server.\u{00A0} Try again."
                            }
                            await reload()
                        }
                    }
                }

                Divider()
                Text(snapshot.devices.isEmpty ? "No phones paired with the server." : "Phones Paired With The Server")
                    .font(.caption)
                    .foregroundColor(.secondary)
                ForEach(snapshot.devices) { device in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(device.name).font(.body)
                            Text("Added \(MacPhoneSettings.phoneDateString(device.createdAt))")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        Spacer()
                        Button("Revoke") {
                            Task {
                                if await backend.revokeDevice(id: device.id) {
                                    await reload()
                                } else {
                                    errorMessage = (await backend.lastError)?.errorDescription
                                        ?? "Could not revoke \(device.name). Try again."
                                }
                            }
                        }
                    }
                    Divider()
                }

                Text(snapshot.routes.isEmpty
                     ? (snapshot.serverName.isEmpty ? "No routes advertised yet." : "\(snapshot.serverName) advertises no routes yet.")
                     : "Advertised Routes (Read-Only)")
                    .font(.caption)
                    .foregroundColor(.secondary)
                ForEach(snapshot.routes) { route in
                    HStack {
                        Text(route.url).font(.body)
                        Spacer()
                        Label(route.kindLabel, systemImage: route.protected ? "lock.fill" : "house")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    Divider()
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundColor(.red)
                }
                Button("Refresh") {
                    Task { await reload() }
                }
                .font(.caption)
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task { await reload() }
    }

    private func reload() async {
        snapshot = await PhoneSettingsSnapshotLoader(backend: backend).loadConsistent()
        if let inviteURL = snapshot.inviteURL {
            let key = inviteURL.absoluteString
            if renderedQRKey != key {
                // The same rule as the Mac's card: the previous window's QR
                // leaves before the new one's is drawn.
                renderedQR = nil
                let image = await Task.detached(priority: .userInitiated) {
                    MacPhoneSettings.makeQRImage(from: key)
                }.value
                guard snapshot.inviteURL?.absoluteString == key else { return }
                if let image {
                    renderedQRKey = key
                    renderedQR = image
                } else {
                    renderedQRKey = nil
                    renderedQR = nil
                    errorMessage = "Could not draw the pairing code.\u{00A0} Select Refresh to try again."
                }
            }
        } else {
            renderedQRKey = nil
            renderedQR = nil
        }
    }
}
