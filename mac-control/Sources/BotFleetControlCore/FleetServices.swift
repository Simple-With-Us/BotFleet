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

/// The services the owner stopped on purpose, and how that record changes.
///
/// A stop the owner asked for is not one the Control app undoes.  The record
/// belongs to the app, so it lasts as long as the app does, and a relaunch
/// hands the fleet back to its own rules.
public struct OwnerStops: Equatable {
    /// The services the owner stopped on purpose, by service id.
    public private(set) var ids: Set<String>

    public init(ids: Set<String> = []) {
        self.ids = ids
    }

    /// Records what the owner asked for, before the change is made.
    ///
    /// The reconciler runs as soon as the change is done, so the intent has
    /// to be recorded first.  A restart is a start as far as the record is
    /// concerned: the owner asked for the service to be running.
    public mutating func record(_ action: ManagedServiceAction, id: String) {
        switch action {
        case .stop: ids.insert(id)
        case .start, .restart: ids.remove(id)
        case .none: break
        }
    }

    /// Puts the record back the way it was, for a change that was refused.
    ///
    /// A refused change is not a stop the owner asked for, so the record
    /// goes back to what it was rather than to what the action would have
    /// made of it.
    public mutating func restore(_ previous: Set<String>) {
        ids = previous
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
    /// True when the owner stopped this service on purpose.
    public let stoppedByOwner: Bool
    /// False when the service's start and restart would change a startup
    /// policy the installed wrapper does not carry.
    public let canChangeStartupPolicy: Bool

    public init(descriptor: FleetServiceDescriptor,
                wanted: Bool?,
                state: ManagedServiceState,
                stoppedByOwner: Bool = false,
                canChangeStartupPolicy: Bool = true) {
        self.descriptor = descriptor
        self.wanted = wanted
        self.state = state
        self.stoppedByOwner = stoppedByOwner
        self.canChangeStartupPolicy = canChangeStartupPolicy
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
        let actions = FleetServices.availableActions(for: state,
                                                    wanted: wanted,
                                                    policy: policy,
                                                    stoppedByOwner: stoppedByOwner)
        // Only a start and a restart change the startup policy, and the
        // installed wrapper has to carry the contract for those.  A stop
        // asks the server itself, so it works with any wrapper and is
        // never taken away.
        guard canChangeStartupPolicy else {
            return actions.filter { $0 != .start && $0 != .restart }
        }
        return actions
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
    /// The services the owner stopped on purpose, by service id.
    ///
    /// A stop the owner asked for is not one the Control app undoes.  The
    /// set belongs to the app, so it lasts as long as the app does, and a
    /// relaunch hands the fleet back to its own rules.
    public let stoppedByOwner: Set<String>
    /// True when the installed wrapper carries the startup policy contract.
    ///
    /// The BotFleet Server's start and restart change that policy, so an
    /// older wrapper is offered nothing at all rather than an action that
    /// would always fail.
    public let startupPolicySupported: Bool

    public init(serverState: ManagedServices.ServerState,
                states: [String: ManagedServiceState],
                stoppedByOwner: Set<String> = [],
                startupPolicySupported: Bool = true) {
        self.serverState = serverState
        self.states = states
        self.stoppedByOwner = stoppedByOwner
        self.startupPolicySupported = startupPolicySupported
    }

    /// The wanted state of one service.
    ///
    /// The rule comes from the service's own policy, so the rule that
    /// follows the BotFleet Server is never used for a service that is
    /// wanted on its own.
    public func wanted(for descriptor: FleetServiceDescriptor) -> Bool? {
        switch descriptor.policy {
        case .whileServerRuns:
            // A service the owner stopped on purpose is not wanted, whatever
            // the service it follows is doing.
            if stoppedByOwner.contains(descriptor.id) { return false }
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
            let isServer = descriptor.id == FleetServiceRegistry.server.id
            return FleetServiceEntry(descriptor: descriptor,
                                     wanted: wanted(for: descriptor),
                                     state: states[descriptor.id] ?? .unknown,
                                     stoppedByOwner: stoppedByOwner.contains(descriptor.id),
                                     canChangeStartupPolicy: startupPolicySupported || !isServer)
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

    /// What stopping one fleet service does, for the confirmation.
    ///
    /// The copy has to promise only what the menu really offers.  On a
    /// wrapper that cannot carry the startup policy the row has no
    /// Restart, so the copy names the real recovery instead of a Restart
    /// the owner cannot pick.
    public static func stopBody(for service: FleetServiceMenuItem,
                                startupPolicySupported: Bool) -> String {
        if service.id == FleetServiceRegistry.server.id {
            let common = "The BotFleet Server stops itself, and its Local VMs go down with it.  The server refuses while work is in flight.  The installed wrapper stays down while the deliberate-stop marker exists, so a login does not bring it back"
            guard startupPolicySupported else {
                return common + ".  This version of BotFleet cannot restart the server from here, so remove ~/.botfleet/stopped.marker yourself to bring it back."
            }
            return common + "; Restart clears the marker."
        }
        if let descriptor = FleetServiceRegistry.descriptor(for: service.id),
           case .launchAgent = descriptor.kind {
            return "It stops right away.  macOS does not bring it back until the LaunchAgent is loaded again."
        }
        return "It stops right away, and pm2 leaves it stopped until you start it again."
    }

    /// The action the Control app takes on its own to bring one service in
    /// line with its wanted state.
    ///
    /// The rule is the same for every service: the wanted state says whether
    /// the service should be running, and a service that is not running the
    /// way it should be is brought back.  A service that was stopped on
    /// purpose is not one of those, because nothing asks it to stop.
    public static func automaticAction(for entry: FleetServiceEntry) -> ManagedServiceAction {
        // A service the owner stopped on purpose is left alone whatever
        // state it reads as now.  A service that was stopped can read as
        // failed, and a failed service is wanted, so without this the
        // reconciler would take the owner's stop back.
        if entry.stoppedByOwner { return .none }
        return ManagedServices.action(wanted: entry.wanted, state: entry.state)
    }

    /// The actions the owner may pick for a service in this state.
    ///
    /// An action is offered only when the observed state supports it: a
    /// service that is running can be stopped and restarted, one that is
    /// stopped can be started, and one that is not installed cannot be
    /// started at all.  A service the Control app cannot see is never
    /// stopped, but it can be restarted, because a restart only asks for a
    /// fresh copy of it.
    ///
    /// The wanted policy and the owner's own stops are part of the answer as
    /// well, because an action the Control app would take straight back is
    /// not an action worth offering.  A service the owner stopped on
    /// purpose can always be started again, and a service that cannot be
    /// wanted yet - the BotFleet MCP Server while the BotFleet Server is
    /// down - offers only a restart.
    public static func availableActions(for state: ManagedServiceState,
                                        wanted: Bool?,
                                        policy: FleetServiceWantedPolicy,
                                        stoppedByOwner: Bool = false) -> [ManagedServiceAction] {
        if policy == .whileServerRuns {
            // A service the owner stopped on purpose can always be started
            // again, because that is how the owner says they want it.
            if stoppedByOwner {
                return state == .running ? [.stop, .restart] : [.start, .restart]
            }
            // A service that follows another one is wanted exactly while the
            // one it follows runs.  While it is not wanted the reconciler
            // decides what happens to it, so no action is offered that the
            // reconciler would take straight back.
            if wanted == false { return [] }
        }
        switch state {
        case .running: return [.stop, .restart]
        case .stopped:
            if stoppedByOwner { return [.start, .restart] }
            if wanted == false && policy == .whileServerRuns { return [.restart] }
            return [.start, .restart]
        case .failed: return [.start, .restart]
        case .notInstalled: return []
        case .unknown: return [.restart]
        }
    }
}
