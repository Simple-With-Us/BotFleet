import Foundation

/// The observed state of one wheelhouse service.
public enum WheelhouseState: Equatable {
    case running
    case stopped
    case unknown

    public var label: String {
        switch self {
        case .running: return "running"
        case .stopped: return "stopped"
        case .unknown: return "unknown"
        }
    }
}

/// One managed BotFleet service in the Control app's wheelhouse.
public struct WheelhouseEntry: Equatable {
    public let id: String
    public let title: String
    /// The desired state.  This is derived from the BotFleet Server's own
    /// state and never stored, so it cannot drift away from the truth.
    /// `nil` means the server's state is not known yet, so nothing is wanted
    /// either way.
    public let wanted: Bool?
    /// The observed state, probed rather than assumed.
    public let state: WheelhouseState

    public init(id: String, title: String, wanted: Bool?, state: WheelhouseState) {
        self.id = id
        self.title = title
        self.wanted = wanted
        self.state = state
    }

    /// A short description of the entry for the menu.
    public var summary: String {
        switch (wanted, state) {
        case (true, .running): return "running"
        case (true, .stopped): return "stopped — wanted running"
        case (true, .unknown): return "unknown — wanted running"
        case (false, .running): return "running — not wanted"
        case (false, .stopped): return "stopped"
        case (false, .unknown): return "unknown"
        case (nil, .running): return "running — wanted state unknown"
        case (nil, .stopped): return "stopped — wanted state unknown"
        case (nil, .unknown): return "unknown"
        }
    }
}

/// The change the Control app should make to bring one entry in line with
/// its wanted state.
public enum WheelhouseAction: Equatable {
    case start
    case stop
    case none
}

/// The BotFleet services the Control app keeps in step with the BotFleet
/// Server.
///
/// The wanted state is derived from the server's own state, so it never has to
/// be stored and it cannot drift away from the truth.
public struct Wheelhouse: Equatable {
    public static let mcpServerID = "botfleet-mcp"
    public static let mcpServerTitle = "BotFleet MCP Server"

    /// What the Control app knows about the BotFleet Server itself.
    public enum ServerState: Equatable {
        case running
        case stopped
        case unknown
    }

    public let serverState: ServerState
    public let mcpServerState: WheelhouseState

    public init(serverState: ServerState, mcpServerState: WheelhouseState) {
        self.serverState = serverState
        self.mcpServerState = mcpServerState
    }

    /// Reads the server's state out of what the Control app already knows.
    ///
    /// A server that is answering is running.  A server with a live process
    /// behind it is running too, even while its API is still coming up.  A
    /// server that cannot be reached and has no process behind it is stopped.
    /// Anything else — booting, unresponsive, or not installed — is unknown,
    /// and the Control app does not act on it.
    public static func serverState(statusAvailable: Bool,
                                    apiUnavailable: Bool,
                                    installedServerState: InstalledServerState) -> ServerState {
        if statusAvailable { return .running }
        if installedServerState == .running { return .running }
        if apiUnavailable && installedServerState == .stopped { return .stopped }
        return .unknown
    }

    /// The MCP server proxies every tool call to the BotFleet Server, so it
    /// has nothing to offer while that server is down.  It is wanted exactly
    /// while the server is running.
    public var mcpServerWanted: Bool? {
        switch serverState {
        case .running: return true
        case .stopped: return false
        case .unknown: return nil
        }
    }

    public var entries: [WheelhouseEntry] {
        [WheelhouseEntry(id: Self.mcpServerID, title: Self.mcpServerTitle,
                          wanted: mcpServerWanted, state: mcpServerState)]
    }

    /// The action that brings one entry in line with its wanted state.
    ///
    /// An unknown wanted state is never acted on, and an unknown observed
    /// state is never acted on either: the Control app does not stop a service
    /// it cannot see, and it does not start one it cannot prove is missing.
    public static func action(for entry: WheelhouseEntry) -> WheelhouseAction {
        switch (entry.wanted, entry.state) {
        case (true, .stopped): return .start
        case (false, .running): return .stop
        default: return .none
        }
    }
}
