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

@MainActor
public final class MacSession: ObservableObject {
    @Published public var state: CompanionState = CompanionState()
    @Published public var status: MacConnectionStatus = .disconnected
    @Published public var selectedBotId: String?
    @Published public var selectedThreadId: String?
    @Published public var isSending: Bool = false
    @Published public var host: String = "127.0.0.1"
    @Published public var port: Int = 8799

    private var client: CompanionClient?
    private var streamTask: Task<Void, Never>?
    private var reconnectAttempt = 0

    public init() {}

    public var activeBot: Bot? {
        guard let id = selectedBotId else { return state.bots.first }
        return state.bots.first(where: { $0.id == id }) ?? state.bots.first
    }

    public var activeMessages: [Message] {
        guard let bot = activeBot else { return [] }
        let threadKey = selectedThreadId ?? bot.id
        return state.messages[threadKey] ?? []
    }

    public var activeStreamingText: String? {
        guard let bot = activeBot else { return nil }
        let threadKey = selectedThreadId ?? bot.id
        return state.streaming[threadKey]
    }

    public var activeReasoningText: String? {
        guard let bot = activeBot else { return nil }
        let threadKey = selectedThreadId ?? bot.id
        return state.reasoning[threadKey]
    }

    public func connect(host: String = "127.0.0.1", port: Int = 8799) {
        self.host = host
        self.port = port
        disconnect()

        status = .connecting
        let connection = Connection(
            name: "Local Mac",
            host: host,
            port: port,
            activeEndpoint: CompanionEndpoint(url: "http://\(host):\(port)", kind: .lan, priority: 1),
            endpoints: [
                CompanionEndpoint(url: "http://\(host):\(port)", kind: .lan, priority: 1)!
            ],
            allowedRouteKinds: [.lan, .bonjour, .hosted],
            allowedLocalRouteURLs: ["http://\(host):\(port)"]
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
                if self.selectedBotId == nil, let first = fleet.bots.first {
                    self.selectedBotId = first.id
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
        guard let client = client, let bot = activeBot, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let threadId = selectedThreadId ?? bot.id
        isSending = true
        defer { isSending = false }

        do {
            _ = try await client.send(
                text: text,
                toBot: bot.id,
                threadId: threadId,
                idempotencyKey: UUID().uuidString
            )
        } catch {
            print("Failed to send turn: \(error)")
        }
    }

    public func stopActiveTurn() async {
        guard let client = client, let bot = activeBot else { return }
        let threadId = selectedThreadId ?? bot.id
        do {
            try await client.interrupt(botId: bot.id, threadId: threadId)
        } catch {
            print("Failed to steer turn: \(error)")
        }
    }
}
