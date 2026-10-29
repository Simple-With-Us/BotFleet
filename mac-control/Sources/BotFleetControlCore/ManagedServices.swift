import Foundation

/// The observed state of one managed service.
public enum ManagedServiceState: Equatable {
    case running
    case stopped
    /// The service is not running and nothing asked it to stop, so it
    /// failed.
    case failed
    /// The service is not installed on this Mac.
    case notInstalled
    case unknown

    public var label: String {
        switch self {
        case .running: return "running"
        case .stopped: return "stopped"
        case .failed: return "failed"
        case .notInstalled: return "not installed"
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
    public var summary: String {
        ManagedServices.summary(wanted: wanted, state: state)
    }
}

/// The change the Control app should make to bring one entry in line with
/// its wanted state.
public enum ManagedServiceAction: Equatable {
    case start
    case stop
    /// The service is stopped and started again.  This is never an
    /// automatic action: a wanted state says whether a service runs, not that
    /// it has to run again.
    case restart
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

        /// The state as the fleet services list shows it.
        public var managedState: ManagedServiceState {
            switch self {
            case .running: return .running
            case .stopped: return .stopped
            case .unknown: return .unknown
            }
        }
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
        action(wanted: entry.wanted, state: entry.state)
    }

    /// The action that brings one service in line with its wanted state.
    ///
    /// A service that failed is brought back up when it is wanted: it is not
    /// running and nothing asked it to stop.  A service that was stopped is
    /// not brought back: something did ask it to stop, and the Control app
    /// does not undo that on its own.
    public static func action(wanted: Bool?, state: ManagedServiceState) -> ManagedServiceAction {
        switch (wanted, state) {
        case (.some(true), .stopped): return .start
        case (.some(true), .failed): return .start
        case (.some(false), .running): return .stop
        default: return .none
        }
    }

    /// A short description of a service for the menu.
    ///
    /// The wanted state is optional, so the patterns spell out `.some` and
    /// `.none` rather than leaning on a bare `true` or `nil`.  A literal
    /// pattern matched against an `Optional` is only understood as exhaustive
    /// by newer Swift compilers; the explicit form is understood by every one
    /// of them, so the same source builds on the CI's toolchain and on a
    /// developer's Mac.
    public static func summary(wanted: Bool?, state: ManagedServiceState) -> String {
        switch (wanted, state) {
        case (.some(true), .running): return "running"
        case (.some(true), .stopped): return "stopped — wanted running"
        case (.some(true), .failed): return "failed — wanted running"
        case (.some(true), .notInstalled): return "not installed"
        case (.some(true), .unknown): return "unknown — wanted running"
        case (.some(false), .running): return "running — not wanted"
        case (.some(false), .stopped): return "stopped"
        case (.some(false), .failed): return "failed"
        case (.some(false), .notInstalled): return "not installed"
        case (.some(false), .unknown): return "unknown"
        case (.none, .running): return "running — wanted state unknown"
        case (.none, .stopped): return "stopped — wanted state unknown"
        case (.none, .failed): return "failed — wanted state unknown"
        case (.none, .notInstalled): return "not installed"
        case (.none, .unknown): return "unknown"
        }
    }

    /// Waits for a service to reach the wanted state and reports what was
    /// seen.
    ///
    /// The observed state after a change is what is reported, so a manager
    /// that refused the change is never reported as a success.  The state is
    /// read again after every attempt, because the manager and the service
    /// do not settle at the same moment.
    public static func settle(to wanted: ManagedServiceState,
                               attempts: Int,
                               interval: TimeInterval = 0.5,
                               observe: () async -> ManagedServiceState) async -> ManagedServiceState {
        // A negative or an enormous interval would trap the conversion to
        // nanoseconds, and this is public API, so the value is clamped
        // before it is used.
        let seconds = interval.isFinite ? min(max(interval, 0), 60) : 0
        for _ in 0..<attempts {
            let next = await observe()
            if next == wanted { return next }
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        }
        return await observe()
    }

    /// Waits for a service to reach the wanted state, with a wall-clock
    /// budget, and reports what was seen.
    ///
    /// A number of looks is not a budget on its own: a look can cost a
    /// whole request timeout, so forty looks can take far longer than the
    /// twenty seconds they were meant to be.  This wait is bounded by the
    /// time it is given, whatever each look costs.
    public static func settle(to wanted: ManagedServiceState,
                               within seconds: TimeInterval,
                               interval: TimeInterval = 0.5,
                               observe: () async -> ManagedServiceState) async -> ManagedServiceState {
        // Both values are clamped, because this is public API and a caller
        // must not be able to trap the app or wait forever.
        let budget = seconds.isFinite ? max(seconds, 0) : 0
        let step = interval.isFinite ? min(max(interval, 0), 60) : 0
        let deadline = Date().addingTimeInterval(budget)
        while true {
            let next = await observe()
            if next == wanted { return next }
            if Date() >= deadline { return next }
            try? await Task.sleep(nanoseconds: UInt64(step * 1_000_000_000))
        }
    }
}
