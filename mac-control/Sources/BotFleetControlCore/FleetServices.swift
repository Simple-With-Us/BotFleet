import Foundation

/// How the Control app supervises one fleet service.
public enum FleetServiceKind: Equatable {
    /// A pm2 application.
    case pm2(appName: String)
    /// A launchd agent.
    case launchAgent(label: String)
}

/// How the wanted state of a fleet service is decided.
///
/// The BotFleet MCP Server proxies every tool call to the BotFleet Server,
/// so it is wanted exactly while that server is running.
///
/// Every other fleet service is wanted on its own.  It is wanted unless
/// something explicitly says otherwise, and the only thing that says
/// otherwise is the service itself: one that was stopped on purpose stays
/// stopped, and one that failed is brought back up.
public enum FleetServiceWantedPolicy: Equatable {
    case whileServerRuns
    case alwaysOn
}

/// One fleet service the Control app knows about.
public struct FleetServiceDescriptor: Equatable {
    public let id: String
    public let title: String
    public let kind: FleetServiceKind
    public let policy: FleetServiceWantedPolicy

    public init(id: String, title: String, kind: FleetServiceKind, policy: FleetServiceWantedPolicy) {
        self.id = id
        self.title = title
        self.kind = kind
        self.policy = policy
    }
}

/// The fleet services the Control app watches on this Mac.
///
/// The BotFleet MCP Server comes first: it is the service the fleet is
/// judged by, and it is the only one with an authoritative health probe.
/// The pm2 applications are the ones the pm2 ecosystem file defines, and the
/// launchd agents are the BotFleet's own.
public enum FleetServiceRegistry {
    /// The BotFleet MCP Server, which is supervised through pm2 but observed
    /// through its own health endpoint.
    public static let mcpServer = FleetServiceDescriptor(
        id: ManagedServices.mcpServerID,
        title: ManagedServices.mcpServerTitle,
        kind: .pm2(appName: PM2Client.mcpAppName),
        policy: .whileServerRuns)

    /// The BotFleet Server, which is supervised by launchd.
    public static let server = FleetServiceDescriptor(
        id: "app.botfleet.server",
        title: "BotFleet Server",
        kind: .launchAgent(label: "app.botfleet.server"),
        policy: .alwaysOn)

    /// The BotFleet Companion, which is supervised by launchd.
    public static let companion = FleetServiceDescriptor(
        id: "app.botfleet.companion",
        title: "BotFleet Companion",
        kind: .launchAgent(label: "app.botfleet.companion"),
        policy: .alwaysOn)

    /// Every fleet service, in the order the menu shows them.
    public static let all: [FleetServiceDescriptor] = [
        mcpServer,
        server,
        companion,
        pm2("shellular", "Shellular"),
        pm2("code-main-keeper", "Code Main Keeper"),
        pm2("vision-worker", "Vision Worker"),
        pm2("xcode-health", "Xcode Health"),
        pm2("agy-acp", "Antigravity ACP"),
        pm2("grok-leader", "Grok Leader"),
        pm2("grok-acp", "Grok ACP"),
        pm2("clutch-web", "Clutch Web"),
        pm2("seat-mcp", "Seat MCP"),
    ]

    /// The descriptor with this id, when the registry knows it.
    public static func descriptor(for id: String) -> FleetServiceDescriptor? {
        all.first { $0.id == id }
    }

    /// A pm2 application that is wanted on its own.
    private static func pm2(_ appName: String, _ title: String) -> FleetServiceDescriptor {
        FleetServiceDescriptor(id: appName, title: title,
                               kind: .pm2(appName: appName), policy: .alwaysOn)
    }
}

/// One fleet service as the Control app sees it right now.
public struct FleetServiceEntry: Equatable {
    public let descriptor: FleetServiceDescriptor
    /// The desired state.  It comes from the service's own policy and is
    /// never stored, so it cannot drift away from the truth.
    public let wanted: Bool?
    /// The observed state, probed rather than assumed.
    public let state: ManagedServiceState

    public init(descriptor: FleetServiceDescriptor, wanted: Bool?, state: ManagedServiceState) {
        self.descriptor = descriptor
        self.wanted = wanted
        self.state = state
    }

    public var id: String { descriptor.id }
    public var title: String { descriptor.title }
    public var kind: FleetServiceKind { descriptor.kind }
    public var policy: FleetServiceWantedPolicy { descriptor.policy }

    /// A short description of the entry for the menu.
    public var summary: String {
        ManagedServices.summary(wanted: wanted, state: state)
    }

    /// The actions the owner may pick for this service right now.
    public var availableActions: [ManagedServiceAction] {
        FleetServices.availableActions(for: state)
    }
}

/// One row of the Fleet Services submenu.
public struct FleetServiceMenuItem: Equatable {
    public let id: String
    public let title: String
    /// What the Control app saw, and what it wants.
    public let summary: String
    /// The actions the owner may pick for this service.
    public let actions: [ManagedServiceAction]

    public init(id: String, title: String, summary: String, actions: [ManagedServiceAction]) {
        self.id = id
        self.title = title
        self.summary = summary
        self.actions = actions
    }
}

/// The fleet services the Control app watches, and what it wants of them.
public struct FleetServices: Equatable {
    /// The BotFleet Server's own state.  It decides whether the BotFleet MCP
    /// Server is wanted, because that server has nothing to offer while the
    /// BotFleet Server is down.
    public let serverState: ManagedServices.ServerState
    /// The observed state of every service, by service id.
    public let states: [String: ManagedServiceState]

    public init(serverState: ManagedServices.ServerState, states: [String: ManagedServiceState]) {
        self.serverState = serverState
        self.states = states
    }

    /// The wanted state of one service.
    ///
    /// The rule comes from the service's own policy, so the rule that
    /// follows the BotFleet Server is never used for a service that is
    /// wanted on its own.
    public func wanted(for descriptor: FleetServiceDescriptor) -> Bool? {
        switch descriptor.policy {
        case .whileServerRuns:
            switch serverState {
            case .running: return true
            case .stopped: return false
            case .unknown: return nil
            }
        case .alwaysOn:
            switch states[descriptor.id] {
            case .some(.running): return true
            case .some(.failed): return true
            case .some(.stopped): return false
            case .some(.notInstalled): return false
            default: return nil
            }
        }
    }

    /// Every fleet service, in the order the menu shows them.
    public var entries: [FleetServiceEntry] {
        FleetServiceRegistry.all.map { descriptor in
            FleetServiceEntry(descriptor: descriptor,
                             wanted: wanted(for: descriptor),
                             state: states[descriptor.id] ?? .unknown)
        }
    }

    /// The rows the Fleet Services submenu shows, one per service.
    ///
    /// Each row carries the service's state and the actions the owner may
    /// pick for it, so the menu itself only draws what the policy decided.
    public var menuItems: [FleetServiceMenuItem] {
        entries.map { entry in
            FleetServiceMenuItem(id: entry.id, title: entry.title, summary: entry.summary,
                                 actions: entry.availableActions)
        }
    }

    /// The title of the Fleet Services submenu.
    public var menuTitle: String {
        "Fleet Services (\(entries.count))"
    }

    /// The action the Control app takes on its own to bring one service in
    /// line with its wanted state.
    ///
    /// The rule is the same for every service: the wanted state says whether
    /// the service should be running, and a service that is not running the
    /// way it should be is brought back.  A service that was stopped on
    /// purpose is not one of those, because nothing asks it to stop.
    public static func automaticAction(for entry: FleetServiceEntry) -> ManagedServiceAction {
        ManagedServices.action(wanted: entry.wanted, state: entry.state)
    }

    /// The actions the owner may pick for a service in this state.
    ///
    /// An action is offered only when the observed state supports it: a
    /// service that is running can be stopped and restarted, one that is
    /// stopped can be started, and one that is not installed cannot be
    /// started at all.  A service the Control app cannot see is never
    /// stopped, but it can be restarted, because a restart only asks for a
    /// fresh copy of it.
    public static func availableActions(for state: ManagedServiceState) -> [ManagedServiceAction] {
        switch state {
        case .running: return [.stop, .restart]
        case .stopped: return [.start, .restart]
        case .failed: return [.start, .restart]
        case .notInstalled: return []
        case .unknown: return [.restart]
        }
    }
}
