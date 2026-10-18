import Foundation
import SwiftUI
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

    private var client: CompanionClient?
    private var streamTask: Task<Void, Never>?
    private var reconnectAttempt = 0

    public init() {}

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

    public func connect(host: String = "127.0.0.1", port: Int = 8799) {
        self.host = host
        self.port = port
        disconnect()

        status = .connecting

        guard let url = URL(string: "http://\(host):\(port)"),
              let endpoint = CompanionEndpoint(url: url.absoluteString, kind: .lan, priority: 1) else {
            status = .failed("Invalid server URL: http://\(host):\(port)")
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
    }

    private func runConnectionLoop(client: CompanionClient, endpoint: String) async {
        while !Task.isCancelled {
            do {
                // Fetch initial fleet roster snapshot
                let fleet = try await client.fleet()
                self.state.hydrate(fleet)
                if self.selection == nil, let first = fleet.bots.first {
                    self.selection = .bot(first.id)
                }
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
                let backoff = min(Double(reconnectAttempt) * 1.5, 10.0)
                status = .failed("Connection lost. Retrying in \(Int(backoff))s…")
                try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
            }
        }
    }

    public func sendMessage(_ text: String) async {
        guard let client = client, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard let threadId = activeThreadId else { return }
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
            } else if let room = activeRoom {
                _ = try await client.send(
                    text: text,
                    toRoom: room.id,
                    threadId: threadId,
                    idempotencyKey: UUID().uuidString
                )
            }
        } catch {
            print("Failed to send turn: \(error)")
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
}
