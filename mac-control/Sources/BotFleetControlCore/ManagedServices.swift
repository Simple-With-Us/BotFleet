import Foundation

/// The observed state of one managed service.
public enum ManagedServiceState: Equatable {
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

/// One managed BotFleet service in the Control app's managed service list.
public struct ManagedServiceEntry: Equatable {
    public let id: String
    public let title: String
    /// The desired state.  This is derived from the BotFleet Server's own
    /// state and never stored, so it cannot drift away from the truth.
    /// `nil` means the server's state is not known yet, so nothing is wanted
    /// either way.
    public let wanted: Bool?
    /// The observed state, probed rather than assumed.
    public let state: ManagedServiceState

    public init(id: String, title: String, wanted: Bool?, state: ManagedServiceState) {
        self.id = id
        self.title = title
        self.wanted = wanted
        self.state = state
    }

    /// A short description of the entry for the menu.
    ///
    /// The wanted state is optional, so the patterns spell out `.some` and
    /// `.none` rather than leaning on a bare `true` or `nil`.  A literal
    /// pattern matched against an `Optional` is only understood as exhaustive
    /// by newer Swift compilers; the explicit form is understood by every one
    /// of them, so the same source builds on the CI's toolchain and on a
    /// developer's Mac.
    public var summary: String {
        switch (wanted, state) {
        case (.some(true), .running): return "running"
        case (.some(true), .stopped): return "stopped — wanted running"
        case (.some(true), .unknown): return "unknown — wanted running"
        case (.some(false), .running): return "running — not wanted"
        case (.some(false), .stopped): return "stopped"
        case (.some(false), .unknown): return "unknown"
        case (.none, .running): return "running — wanted state unknown"
        case (.none, .stopped): return "stopped — wanted state unknown"
        case (.none, .unknown): return "unknown"
        }
    }
}

/// The change the Control app should make to bring one entry in line with
/// its wanted state.
public enum ManagedServiceAction: Equatable {
    case start
    case stop
    case none
}

/// The BotFleet services the Control app keeps in step with the BotFleet
/// Server.
///
/// The wanted state is derived from the server's own state, so it never has to
/// be stored and it cannot drift away from the truth.
public struct ManagedServices: Equatable {
    public static let mcpServerID = "botfleet-mcp"
    public static let mcpServerTitle = "BotFleet MCP Server"

    /// What the Control app knows about the BotFleet Server itself.
    public enum ServerState: Equatable {
        case running
        case stopped
        case unknown
    }

    public let serverState: ServerState
    public let mcpServerState: ManagedServiceState

    public init(serverState: ServerState, mcpServerState: ManagedServiceState) {
        self.serverState = serverState
        self.mcpServerState = mcpServerState
    }

    /// Reads the server's state out of what the Control app already knows.
    ///
    /// A server that is answering is running.  A server with a live process
    /// behind it is running too, even while its API is still coming up.
    ///
    /// A server that cannot be reached is not proof of anything.  The request
    /// may have timed out, or the server may be busy under load, and a
    /// timeout must never be read as "the server is gone": doing that would
    /// stop a service that is still serving.  Only a port with nothing
    /// listening behind it is proof that no server is running, and only then
    /// is the server stopped.  Anything else — booting, busy, or not
    /// installed — is unknown, and the Control app does not act on it.
    public static func serverState(statusAvailable: Bool,
                                    installedServerState: InstalledServerState,
                                    serverPresence: ServerPresence) -> ServerState {
        if statusAvailable { return .running }
        if installedServerState == .running { return .running }
        switch serverPresence {
        case .present: return .unknown
        case .absent: return .stopped
        case .unknown: return .unknown
        }
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

    public var entries: [ManagedServiceEntry] {
        [ManagedServiceEntry(id: Self.mcpServerID, title: Self.mcpServerTitle,
                          wanted: mcpServerWanted, state: mcpServerState)]
    }

    /// The action that brings one entry in line with its wanted state.
    ///
    /// An unknown wanted state is never acted on, and an unknown observed
    /// state is never acted on either: the Control app does not stop a service
    /// it cannot see, and it does not start one it cannot prove is missing.
    public static func action(for entry: ManagedServiceEntry) -> ManagedServiceAction {
        switch (entry.wanted, entry.state) {
        case (.some(true), .stopped): return .start
        case (.some(false), .running): return .stop
        default: return .none
        }
    }
}
