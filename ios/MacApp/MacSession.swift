import Foundation
import SwiftUI
import AppKit
import CoreVideo
import CompanionCore

public enum MacConnectionStatus: Equatable {
    case disconnected
    case connecting
    case connected(endpoint: String)
    case failed(String)

    public var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }

    public var statusColor: Color {
        switch self {
        case .connected: return .green
        case .connecting: return .yellow
        case .disconnected: return .gray
        case .failed: return .red
        }
    }

    public var displayText: String {
        switch self {
        case .connected(let endpoint): return "Connected (\(endpoint))"
        case .connecting: return "Connecting…"
        case .disconnected: return "Disconnected"
        case .failed(let msg): return "Error: \(msg)"
        }
    }
}

public enum SidebarSelection: Hashable, Sendable {
    case bot(String)
    case room(String)
}

@MainActor
public final class MacSession: ObservableObject {
    @Published public var state: CompanionState = CompanionState()
    @Published public var status: MacConnectionStatus = .disconnected
    @Published public var selection: SidebarSelection?
    @Published public var selectedThreadId: String?
    @Published public var isSending: Bool = false
    @Published public var host: String = "127.0.0.1"
    @Published public var port: Int = 8799

    // Lifecycle & Remote Wake state (BF-2497)
    @Published public var lifecycleSettings = MacLifecycleSettings()
    @Published public var isShuttingDownServer = false
    /// The last lifecycle-save failure, so the Settings panel can say why the
    /// toggles went back to their previous values.
    @Published public var lifecycleErrorMessage: String?

    // CUA Live Stream & Safety state (BF-2499)
    @Published public var showCuaViewer: Bool = false
    @Published public var isCuaStreaming: Bool = false
    @Published public var cuaPixelBuffer: CVPixelBuffer?
    @Published public var cuaStatusMessage: String?
    @Published public var cuaRevocationBanner: String?

    private var client: CompanionClient?
    private var streamTask: Task<Void, Never>?
    private var reconnectAttempt = 0
    private let policyStore: MacPersistencePolicyStore
    private let permissionMonitor: CuaPermissionMonitor
    private let cuaStatusState = CuaStatusState()
    private var hasLaunched = false
    private var didDeliberatelyStopServer = false
    private var mainWindowObserver: NSObjectProtocol?

    public init(
        policyStore: MacPersistencePolicyStore = MacPersistencePolicyStore(),
        permissionMonitor: CuaPermissionMonitor = CuaPermissionMonitor()
    ) {
        self.policyStore = policyStore
        self.permissionMonitor = permissionMonitor
        if let localPersist = policyStore.readPersistOnExit() {
            self.lifecycleSettings = MacLifecycleSettings(
                allowRemoteDesktopLaunch: nil,
                persistOnExit: localPersist
            )
        }
    }

    public var selectedBotId: String? {
        get {
            if case .bot(let id) = selection { return id }
            return nil
        }
        set {
            if let id = newValue {
                selection = .bot(id)
            } else if case .bot = selection {
                selection = nil
            }
        }
    }

    public var selectedRoomId: String? {
        get {
            if case .room(let id) = selection { return id }
            return nil
        }
        set {
            if let id = newValue {
                selection = .room(id)
            } else if case .room = selection {
                selection = nil
            }
        }
    }

    public var activeBot: Bot? {
        if let id = selectedBotId {
            return state.bots.first(where: { $0.id == id })
        }
        if selection == nil {
            return state.bots.first
        }
        return nil
    }

    public var activeRoom: Room? {
        guard let id = selectedRoomId else { return nil }
        return state.rooms.first(where: { $0.id == id })
    }

    public var activeTitle: String {
        if let bot = activeBot { return bot.name }
        if let room = activeRoom { return room.name }
        return "BotFleet"
    }

    public var activeSubtitle: String {
        if let bot = activeBot { return bot.modelSelection.model }
        if let room = activeRoom { return "\(room.memberIds.count) members" }
        return ""
    }

    public var activeThreadId: String? {
        if let selected = selectedThreadId { return selected }
        if let room = activeRoom { return room.threadId }
        return activeBot?.threadId
    }

    public var activeMessages: [Message] {
        guard let threadKey = activeThreadId else { return [] }
        return state.messages[threadKey] ?? []
    }

    public var activeStreamingText: String? {
        guard let threadKey = activeThreadId else { return nil }
        return state.streaming[threadKey]
    }

    public var activeReasoningText: String? {
        guard let threadKey = activeThreadId else { return nil }
        return state.reasoning[threadKey]
    }

    /// Connects to the local harness.
    ///
    /// A reconnect never clears the deliberate-stop sentinel: the marker is the
    /// only thing keeping the launchd `StartInterval` tick from resurrecting a
    /// harness the operator stopped on purpose.  Only `launch()` clears it.
    public func connect(host: String = "127.0.0.1", port: Int = 8799) {
        self.host = host
        self.port = port
        disconnect()

        if didDeliberatelyStopServer {
            // The harness was deliberately stopped in this session, so a
            // reconnect would only hammer a server that is meant to stay down.
            status = .failed("Server was deliberately stopped. Start the harness to reconnect.")
            return
        }

        status = .connecting

        let normalizedHost = Connection.urlHost(host)
        guard let url = URL(string: "http://\(normalizedHost):\(port)"),
              let endpoint = CompanionEndpoint(url: url.absoluteString, kind: .lan, priority: 1) else {
            status = .failed("Invalid server URL: http://\(normalizedHost):\(port)")
            return
        }

        let connection = Connection(
            name: "Local Mac",
            host: host,
            port: port,
            activeEndpoint: endpoint,
            endpoints: [endpoint],
            allowedRouteKinds: [.lan, .bonjour, .hosted],
            allowedLocalRouteURLs: [endpoint.url]
        )

        // Local loopback does not require a bearer token in dev mode
        let client = CompanionClient(connection: connection, token: nil)
        self.client = client

        streamTask = Task { [weak self] in
            await self?.runConnectionLoop(client: client, endpoint: "\(host):\(port)")
        }
    }

    /// Called once when the desktop app is deliberately launched.
    ///
    /// The launch clears the deliberate-stop sentinel so the launchd wrapper is
    /// allowed to start or supervise the harness again.
    public func launch(host: String = "127.0.0.1", port: Int = 8799) {
        if !hasLaunched {
            hasLaunched = true
            _ = try? policyStore.clearStoppedMarker(for: .appLaunch)
        }
        connect(host: host, port: port)
    }

    /// Observes the close of the app's main window.
    ///
    /// The observer is bound to the main window instance rather than to every
    /// `NSWindow`, so closing the Settings panel never applies the quit policy.
    public func registerMainWindow(_ window: NSWindow) {
        // SwiftUI can recreate the window, so the previous observer is dropped
        // rather than left pointing at a window that no longer exists.
        if let mainWindowObserver {
            NotificationCenter.default.removeObserver(mainWindowObserver)
            self.mainWindowObserver = nil
        }
        mainWindowObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.handleWindowClose()
            }
        }
    }

    public func disconnect() {
        streamTask?.cancel()
        streamTask = nil
        client = nil
        status = .disconnected
    }

    private func runConnectionLoop(client: CompanionClient, endpoint: String) async {
        while !Task.isCancelled {
            do {
                // The roster snapshot and the lifecycle settings are fetched once
                // per successful connection.  Fetching the settings on the
                // connect path as well would double the request count on every
                // reconnect, which is exactly when the harness is least able to
                // serve it.
                try await MacHarnessConnectionCycle.connect(
                    fetchFleet: { try await client.fleet() },
                    hydrate: { [weak self] fleet in
                        guard let self else { return }
                        self.state.hydrate(fleet)
                        if self.selection == nil, let first = fleet.bots.first {
                            self.selection = .bot(first.id)
                        }
                    },
                    refreshLifecycleSettings: { [weak self] in
                        await self?.refreshLifecycleSettings()
                    }
                )
                self.status = .connected(endpoint: endpoint)
                self.reconnectAttempt = 0

                // Open SSE stream
                let stream = try client.events(since: state.cursor, screens: true)
                for try await frame in stream {
                    if Task.isCancelled { break }
                    self.state.apply(frame)
                }
            } catch {
                if Task.isCancelled { break }
                reconnectAttempt += 1
                let baseBackoff = min(Double(reconnectAttempt) * 1.5, 10.0)
                let jitter = Double.random(in: -0.2...0.2) * baseBackoff
                let backoff = max(1.0, baseBackoff + jitter)
                status = .failed("Connection lost. Retrying in \(Int(backoff))s…")
                try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
            }
        }
    }

    @discardableResult
    public func sendMessage(_ text: String) async -> Bool {
        guard let client = client, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        guard let threadId = activeThreadId else { return false }
        isSending = true
        defer { isSending = false }

        do {
            if let bot = activeBot {
                _ = try await client.send(
                    text: text,
                    toBot: bot.id,
                    threadId: threadId,
                    idempotencyKey: UUID().uuidString
                )
                return true
            } else if let room = activeRoom {
                _ = try await client.send(
                    text: text,
                    toRoom: room.id,
                    threadId: threadId,
                    idempotencyKey: UUID().uuidString
                )
                return true
            }
            return false
        } catch {
            print("Failed to send turn: \(error)")
            status = .failed("Send failed: \(error.localizedDescription)")
            return false
        }
    }

    public func stopActiveTurn() async {
        guard let client = client else { return }
        guard let threadId = activeThreadId else { return }
        do {
            if let bot = activeBot {
                try await client.interrupt(botId: bot.id, threadId: threadId)
            } else if let room = activeRoom {
                try await client.interrupt(groupId: room.id, threadId: threadId)
            }
        } catch {
            print("Failed to steer turn: \(error)")
        }
    }

    // MARK: - Lifecycle Controls (BF-2497)

    private func makeLifecycleClient() -> MacLifecycleClient {
        MacLifecycleClient(host: host, port: port, policyStore: policyStore)
    }

    public func refreshLifecycleSettings() async {
        let lifecycleClient = makeLifecycleClient()
        guard let fetched = try? await lifecycleClient.fetchLifecycleSettings() else { return }
        // A grant the harness did not report stays unknown, so the next save
        // never writes back a `false` the app never read.
        var merged = fetched
        if merged.allowRemoteDesktopLaunch == nil {
            merged.allowRemoteDesktopLaunch = lifecycleSettings.allowRemoteDesktopLaunch
        }
        lifecycleSettings = merged
    }

    public func saveLifecycleSettings(_ settings: MacLifecycleSettings) async {
        let previous = lifecycleSettings
        let result = await makeLifecycleClient().saveLifecycleSettings(settings, restoring: previous)
        switch result {
        case .saved(let saved):
            lifecycleSettings = saved
            lifecycleErrorMessage = nil
        case .failed(let restored, let message):
            // The write was rejected, so the toggles go back to the last value
            // the harness actually accepted.
            lifecycleSettings = restored
            lifecycleErrorMessage = message
            NSLog("Failed to save lifecycle settings: %@", message)
        }
    }

    public func shutDownServerAndLocalVM() async {
        guard !isShuttingDownServer else { return }
        isShuttingDownServer = true
        defer { isShuttingDownServer = false }

        triggerCuaEmergencyStop()
        let lifecycleClient = makeLifecycleClient()
        switch await lifecycleClient.performDeliberateShutdown() {
        case .stopped:
            didDeliberatelyStopServer = true
            disconnect()
            status = .disconnected
        case .failed(let message):
            // A failed shutdown must not leave the deliberate-stop marker behind:
            // the harness is still running, and the marker would make the launchd
            // wrapper treat it as deliberately stopped forever.
            NSLog("Server shutdown failed: %@", message)
            status = .failed("Shutdown error: \(message)")
        }
    }

    /// Applies the exit policy when the desktop window closes.
    ///
    /// The Settings toggle reads "Keep Server Running When Window Closes", and
    /// closing the SwiftUI window does not terminate the app, so the policy has
    /// to be evaluated here as well as on termination.
    public func handleWindowClose() async {
        await applyExitPolicy()
    }

    /// Applies the exit policy when the app terminates.
    public func handleAppTermination() async {
        triggerCuaEmergencyStop()
        await applyExitPolicy()
    }

    private func applyExitPolicy() async {
        let persist = policyStore.readPersistOnExit() ?? lifecycleSettings.persistOnExit
        guard MacLifecycleClient.evaluateQuitAction(persistOnExit: persist) == .shutDownServerAndVM else {
            return
        }
        guard !didDeliberatelyStopServer else { return }
        await shutDownServerAndLocalVM()
    }

    // MARK: - CUA Stream & Emergency Safety Stop Controls (BF-2499)

    public func triggerCuaEmergencyStop() {
        _ = MacCuaDriver.shared.emergencyStop()
        permissionMonitor.stopMonitoring()
        if isCuaStreaming {
            stopCuaStreaming(updateStatusMessage: false)
        }
        setCuaStatus(.emergencyStopActivated)
    }

    public func toggleCuaStreaming() {
        if isCuaStreaming {
            stopCuaStreaming()
        } else {
            startCuaStreaming()
        }
    }

    public func startCuaStreaming() {
        let monitor = permissionMonitor
        Task { [weak self] in
            guard let self else { return }
            do {
                MacCuaDriver.shared.resetEmergencyStop()
                self.cuaStatusState.reset()
                self.cuaRevocationBanner = nil
                self.setCuaStatus(.starting)

                monitor.startMonitoring { [weak self] permissionState in
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        self.isCuaStreaming = false
                        self.cuaPixelBuffer = nil
                        self.cuaRevocationBanner = permissionState.bannerMessage
                        self.setCuaStatus(.screenRecordingPermissionNeeded)
                    }
                }

                try await ScreenStreamActor.shared.startStreaming(
                    onStreamStoppedWithError: { [weak self] error in
                        let permissionState = monitor.notifyStreamStoppedWithError(error)
                        Task { @MainActor [weak self] in
                            guard let self else { return }
                            self.isCuaStreaming = false
                            self.cuaPixelBuffer = nil
                            switch permissionState {
                            case .authorized:
                                // A benign capture failure is not a lost
                                // permission, so no revocation banner is shown.
                                self.cuaRevocationBanner = nil
                                self.setCuaStatus(.streamStopped)
                            case .missingPermissions, .revoked:
                                self.cuaRevocationBanner = permissionState.bannerMessage
                                self.setCuaStatus(.screenRecordingPermissionNeeded)
                            }
                        }
                    },
                    onFrame: { [weak self] buffer in
                        Task { @MainActor [weak self] in
                            self?.cuaPixelBuffer = buffer
                        }
                    }
                )
                self.isCuaStreaming = true
                self.setCuaStatus(.liveDesktopShared)
            } catch {
                // The raw error is a developer string (framework domain codes,
                // TCC denial text), so it goes to the log and the status bar
                // gets product copy.
                NSLog("CUA stream error: %@", error.localizedDescription)
                monitor.stopMonitoring()
                let hasScreenRecording = MacCuaDriver.shared.checkPermissions().hasScreenRecording
                if let streamError = error as? ScreenStreamError {
                    switch streamError {
                    case .notAuthorized:
                        self.setCuaStatus(.screenRecordingPermissionNeeded)
                    case .noDisplayFound:
                        self.setCuaStatus(.noDisplayAvailable)
                    case .streamInitializationFailed, .captureFailed:
                        self.setCuaStatus(
                            hasScreenRecording ? .liveCaptureUnavailable : .screenRecordingPermissionNeeded
                        )
                    }
                } else {
                    self.setCuaStatus(
                        hasScreenRecording ? .liveCaptureUnavailable : .screenRecordingPermissionNeeded
                    )
                }
                if !hasScreenRecording {
                    self.cuaRevocationBanner = CuaPermissionState.missingPermissions(
                        missingScreenRecording: true,
                        missingAccessibility: !MacCuaDriver.shared.checkPermissions().hasAccessibility
                    ).bannerMessage
                }
                self.isCuaStreaming = false
            }
        }
    }

    public func stopCuaStreaming(updateStatusMessage: Bool = true) {
        permissionMonitor.stopMonitoring()
        Task {
            await ScreenStreamActor.shared.stopStreaming()
            isCuaStreaming = false
            cuaPixelBuffer = nil
            if updateStatusMessage {
                setCuaStatus(.streamStopped)
            }
        }
    }

    /// Records a CUA inspector status update.
    ///
    /// The emergency-stop confirmation is sticky, so the asynchronous
    /// "stream stopped" update that lands right after an emergency stop cannot
    /// replace the safety message the operator just triggered.
    private func setCuaStatus(_ status: MacCuaStatus) {
        cuaStatusState.record(status)
        cuaStatusMessage = cuaStatusState.current?.message
    }
}
