import Foundation
import SwiftUI
import CoreVideo
import CompanionCore
#if os(macOS)
import AppKit
#endif

public extension MacConnectionStatus {
    var statusColor: Color {
        switch self {
        case .connected: return .green
        case .connecting: return .yellow
        case .disconnected: return .gray
        case .failed: return .red
        }
    }
}

@MainActor
public final class MacSession: ObservableObject, MacSessionSourceProtocol {
    @Published public var state: CompanionState = CompanionState()
    @Published public var status: MacConnectionStatus = .disconnected
    @Published public var selection: SidebarSelection?
    @Published public var selectedThreadId: String?
    @Published public var isSending: Bool = false
    @Published public var host: String = "127.0.0.1"
    @Published public var port: Int = 8799

    // CUA Live Stream state
    @Published public var showCuaViewer: Bool = false
    @Published public var isCuaStreaming: Bool = false
    @Published public var cuaPixelBuffer: CVPixelBuffer?
    @Published public var cuaStatusMessage: String?

    // Phase 3: Voice, System Integration, Streaming Transcript & Settings Routing
    @Published public var voiceState: MacVoiceCaptureState = .idle
    @Published public var voiceRouteBanner: String?
    @Published public var activeSettingsSection: MacSettingsSection = .general
    @Published public var allBotsPaused: Bool = false

    public let voiceEngine = MacVoiceEngine()
    public let transcriptEngine = MacTranscriptEngine()
    public let hotkeyManager = MacGlobalHotkeyManager()
    public let notificationCoordinator = MacNotificationCoordinator()
    public let capabilities = MacDesktopCapabilities()
    #if os(macOS)
    public let menubarController = MacMenubarController()
    #endif

    private var client: CompanionClient?
    private var streamTask: Task<Void, Never>?
    private var reconnectAttempt = 0

    public init() {}

    public var unreadSummary: MacUnreadBadgeSummary {
        MacUnreadBadgeSummary.from(state: state)
    }

    public var menubarState: MacMenubarState {
        MacMenubarState.from(
            state: state,
            isConnected: status.isConnected,
            allBotsPaused: allBotsPaused
        )
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

    // MARK: - Voice & System Sync

    public func toggleComposerDictation(currentDraft: String) -> String {
        _ = voiceEngine.tapMicrophoneButton(mode: .composerDictation, currentDraft: currentDraft)
        voiceState = voiceEngine.state
        voiceRouteBanner = voiceEngine.routeBanner
        return voiceEngine.currentDraft
    }

    public func routeSettingsDeepLink(_ url: URL) {
        if let section = MacSettingsDeepLinkRouter.section(for: url) {
            activeSettingsSection = section
        }
    }

    private func syncSystemSurfaces() {
        notificationCoordinator.activeOnScreenThreadId = activeThreadId
        #if os(macOS)
        menubarController.apply(menubarState)
        NSApplication.shared.dockTile.badgeLabel = unreadSummary.dockBadgeLabel
        #endif
    }

    public func connect(host: String = "127.0.0.1", port: Int = 8799) {
        self.host = host
        self.port = port
        disconnect()

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

    public func disconnect() {
        streamTask?.cancel()
        streamTask = nil
        client = nil
        status = .disconnected
        syncSystemSurfaces()
    }

    private func runConnectionLoop(client: CompanionClient, endpoint: String) async {
        while !Task.isCancelled {
            do {
                let fleet = try await client.fleet()
                self.state.hydrate(fleet)
                if self.selection == nil, let first = fleet.bots.first {
                    self.selection = .bot(first.id)
                }
                self.status = .connected(endpoint: endpoint)
                self.reconnectAttempt = 0
                self.syncSystemSurfaces()

                let stream = try client.events(since: state.cursor, screens: true)
                for try await frame in stream {
                    if Task.isCancelled { break }
                    self.state.apply(frame)
                    if let threadKey = self.activeThreadId,
                       let streaming = self.state.streaming[threadKey] {
                        self.transcriptEngine.updateStreamingText(streaming, messageId: "streaming:\(threadKey)")
                    }
                    self.syncSystemSurfaces()
                }
            } catch {
                if Task.isCancelled { break }
                reconnectAttempt += 1
                let baseBackoff = min(Double(reconnectAttempt) * 1.5, 10.0)
                let jitter = Double.random(in: -0.2...0.2) * baseBackoff
                let backoff = max(1.0, baseBackoff + jitter)
                status = .failed("Connection lost. Retrying in \(Int(backoff))s…")
                syncSystemSurfaces()
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

    // MARK: - CUA Stream Controls

    public func toggleCuaStreaming() {
        if isCuaStreaming {
            stopCuaStreaming()
        } else {
            startCuaStreaming()
        }
    }

    public func startCuaStreaming() {
        Task {
            do {
                cuaStatusMessage = "Starting live capture…"
                try await ScreenStreamActor.shared.startStreaming { [weak self] buffer in
                    Task { @MainActor [weak self] in
                        self?.cuaPixelBuffer = buffer
                    }
                }
                isCuaStreaming = true
                cuaStatusMessage = "Live desktop shared"
            } catch {
                NSLog("CUA stream error: %@", error.localizedDescription)
                let hasScreenRecording = MacCuaDriver.shared.checkPermissions().hasScreenRecording
                if let streamError = error as? ScreenStreamError {
                    cuaStatusMessage = streamError.statusMessage(hasScreenRecording: hasScreenRecording)
                } else {
                    cuaStatusMessage = hasScreenRecording
                        ? "Live capture could not start"
                        : "Screen recording permission needed"
                }
                isCuaStreaming = false
            }
        }
    }

    public func stopCuaStreaming() {
        Task {
            await ScreenStreamActor.shared.stopStreaming()
            isCuaStreaming = false
            cuaPixelBuffer = nil
            cuaStatusMessage = "Stream stopped"
        }
    }
}
