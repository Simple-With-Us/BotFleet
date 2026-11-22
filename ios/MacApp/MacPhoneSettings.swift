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
struct MacPhoneSettings: View {
    @ObservedObject var session: MacSession

    @State private var devices: [PairedDevice] = []
    @State private var window: NativePairingWindow?
    @State private var inviteURL: URL?
    @State private var routes: [PhoneRouteRow] = []
    @State private var serverName: String = ""
    @State private var errorMessage: String?
    @State private var renderedQR: NSImage? = nil
    private static let qrContext = CIContext()

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

                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundColor(.red)
                }
            }
            .padding(24)
        }
        .task(id: session.companionListenerEnabled) { await reload() }
    }

    private var pairingCard: some View {
        GroupBox("Pairing Code") {
            VStack(alignment: .leading, spacing: 12) {
                if let window, let inviteURL {
                    if let qr = renderedQR {
                        Image(nsImage: qr)
                            .resizable()
                            .interpolation(.none)
                            .frame(width: 180, height: 180)
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
                                errorMessage = "Could not open a pairing window. Make sure the listener is on."
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
        devices = await session.pairedPhones()
        window = await session.activePhonePairingWindow()
        let advertisement = await session.phoneAdvertisement()
        serverName = advertisement.serverName
        routes = PhoneSettingsDisplay.routeRows(advertisement: advertisement)
        if let window {
            inviteURL = NativeCompanionServer.makePairingInviteURL(window: window, advertisement: advertisement)
        } else {
            inviteURL = nil
        }
        if let inviteURL {
            renderedQR = qrImage(from: inviteURL.absoluteString)
        } else {
            renderedQR = nil
        }
    }

    private func phoneDate(_ seconds: Double) -> String {
        Date(timeIntervalSince1970: seconds).formatted(date: .abbreviated, time: .omitted)
    }

    private func qrImage(from string: String) -> NSImage? {
        #if canImport(CoreImage.CIFilterBuiltins)
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        guard let cgImage = Self.qrContext.createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: 180, height: 180))
        #else
        return nil
        #endif
    }
}
