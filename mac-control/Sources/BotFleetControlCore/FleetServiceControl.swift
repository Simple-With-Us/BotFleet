import Foundation

/// Why the Control app could not change a fleet service.
public enum FleetServiceError: LocalizedError, Equatable {
    case managerMissing
    case refused(String)

    public var errorDescription: String? {
        switch self {
        case .managerMissing:
            return "The process manager for this service is not installed on this Mac."
        case .refused(let message):
            return message
        }
    }
}

/// Watches the fleet services on this Mac, and changes them when the owner
/// asks.
///
/// Every service is observed and changed through the manager that owns it: a
/// pm2 application through pm2, a launchd agent through launchctl.  The
/// BotFleet MCP Server is the one exception, because its own health endpoint
/// is the only authority on whether it is running.
public final class FleetServiceControl {
    /// How often the BotFleet Server's own stop is looked for.
    ///
    /// The server answers the stop request before it has exited, so the
    /// Control app waits for it to go rather than assuming it did.  The
    /// window is the same twenty seconds the pm2 wait gives: eight looks
    /// two and a half seconds apart.
    public static let settleInterval: TimeInterval = 2.5

    private let pm2: PM2Client
    private let startup: StartupPolicy
    private let mcpServer: McpServerControl?
    /// How the BotFleet Server is asked to stop.
    ///
    /// The server stops itself.  launchd does not always own the process:
    /// the installed wrapper exits when the harness is already healthy, and
    /// the desktop app forks its own harness when nothing answers on the
    /// port, so booting the agent out can leave a server that is still
    /// serving.  Asking the server is the only stop that is the server's.
    private let stopServer: (() async throws -> Void)?

    public init(pm2: PM2Client = PM2Client(),
                startup: StartupPolicy = StartupPolicy(),
                mcpServer: McpServerControl? = nil,
                stopServer: (() async throws -> Void)? = nil) {
        self.pm2 = pm2
        self.startup = startup
        self.mcpServer = mcpServer
        self.stopServer = stopServer
    }

    /// Reads the state of every fleet service.
    ///
    /// The pm2 applications are read in one command, so the menu never waits
    /// for ten separate calls.
    public func states(serverState: ManagedServices.ServerState) async -> [String: ManagedServiceState] {
        let pm2States = pm2.appStates()
        var states: [String: ManagedServiceState] = [:]
        for descriptor in FleetServiceRegistry.all {
            switch descriptor.kind {
            case .pm2(let appName):
                if descriptor.policy == .whileServerRuns {
                    // The MCP server's health endpoint is the only authority
                    // on whether it is running, so it decides the state and
                    // pm2 only changes it.
                    states[descriptor.id] = await mcpServer?.state() ?? .unknown
                } else if let pm2States {
                    // An application pm2 has no record of is not running.
                    states[descriptor.id] = pm2States[appName] ?? .stopped
                } else {
                    states[descriptor.id] = .unknown
                }
            case .launchAgent(let label):
                if descriptor.id == FleetServiceRegistry.server.id {
                    // The BotFleet Server's own agent is a wrapper that
                    // exits as soon as the harness is healthy, so what the
                    // Control app knows about the server is the truth
                    // about it.
                    states[descriptor.id] = serverState.managedState
                } else {
                    states[descriptor.id] = startup.state(ofAgent: label).managedState
                }
            }
        }
        return states
    }

    /// Starts, stops or restarts one fleet service and reports what the
    /// Control app can see afterwards.
    ///
    /// The state that is reported is the one observed after the change, so a
    /// manager that refused the change is never reported as a success.
    @discardableResult
    public func perform(_ action: ManagedServiceAction,
                        serviceID: String,
                        attempts: Int = PM2Client.settleAttempts) async throws -> ManagedServiceState {
        guard let descriptor = FleetServiceRegistry.descriptor(for: serviceID) else {
            throw FleetServiceError.refused("That is not a fleet service.")
        }
        switch action {
        case .start:
            return try await setRunning(true, descriptor: descriptor, attempts: attempts)
        case .stop:
            return try await setRunning(false, descriptor: descriptor, attempts: attempts)
        case .restart:
            return try await restart(descriptor, attempts: attempts)
        case .none:
            return await state(of: descriptor)
        }
    }

    /// Brings one service to the wanted state and reports what was seen.
    private func setRunning(_ running: Bool,
                            descriptor: FleetServiceDescriptor,
                            attempts: Int) async throws -> ManagedServiceState {
        switch descriptor.kind {
        case .pm2(let appName):
            if descriptor.policy == .whileServerRuns {
                guard let mcpServer else { throw FleetServiceError.managerMissing }
                do {
                    return try await mcpServer.setRunning(running, within: PM2Client.mcpSettleWindow)
                } catch let error as McpServerError {
                    throw FleetServiceError.refused(error.errorDescription
                        ?? "The BotFleet MCP Server could not be changed.")
                }
            }
            do {
                return try await pm2.setRunning(running, appName: appName, attempts: attempts)
            } catch {
                throw pm2Failure(error, action: "change", appName: appName)
            }
        case .launchAgent(let label):
            if descriptor.id == FleetServiceRegistry.server.id {
                // The BotFleet Server has a start of its own: it checks
                // the installed wrapper and clears the deliberate-stop
                // marker, so the server stays up afterwards.
                if running {
                    try startup.startServer()
                } else {
                    guard let stopServer else {
                        throw FleetServiceError.refused("The BotFleet Server has to stop itself, and the Control app could not ask it to.")
                    }
                    try await stopServer()
                    // The server's own shutdown is asynchronous, so what is
                    // reported is the state that was observed after it, not
                    // a constant that happens to be the expected one.
                    return await ManagedServices.settle(to: .stopped,
                                                        attempts: attempts,
                                                        interval: FleetServiceControl.settleInterval) {
                        await self.state(of: descriptor)
                    }
                }
            } else if running {
                try startup.startAgent(label: label)
            } else {
                try startup.stopAgent(label: label)
            }
            return startup.state(ofAgent: label).managedState
        }
    }

    /// Restarts one service and reports what was seen.
    private func restart(_ descriptor: FleetServiceDescriptor,
                         attempts: Int) async throws -> ManagedServiceState {
        switch descriptor.kind {
        case .pm2(let appName):
            if descriptor.policy == .whileServerRuns {
                guard let mcpServer else { throw FleetServiceError.managerMissing }
                do {
                    return try await mcpServer.restart(within: PM2Client.mcpSettleWindow)
                } catch let error as McpServerError {
                    throw FleetServiceError.refused(error.errorDescription
                        ?? "The BotFleet MCP Server could not be restarted.")
                }
            }
            do {
                try pm2.restart(appName: appName)
            } catch {
                throw pm2Failure(error, action: "restart", appName: appName)
            }
            return await ManagedServices.settle(to: .running,
                                                attempts: attempts,
                                                interval: PM2Client.settleInterval) {
                self.pm2.state(ofApp: appName)
            }
        case .launchAgent(let label):
            if descriptor.id == FleetServiceRegistry.server.id {
                // The BotFleet Server has a restart of its own: it clears the
                // deliberate-stop marker first, because the installed wrapper
                // stays down while that marker exists.
                let deliberateStop = try startup.restartServer()
                // A restart replaces the process the launchd job owns.  When
                // the job owns no process - the server was started by
                // something else, such as the desktop app's own fork - a
                // kickstart cannot replace it, and the restart is not
                // reported as a success.
                let observed = await ManagedServices.settle(to: .running,
                                                            attempts: attempts,
                                                            interval: 0.25) {
                    startup.state(ofAgent: label).managedState
                }
                if observed != .running {
                    // Only an observation that proves the server is not
                    // running puts the marker back.  An unknown state means
                    // launchctl could not be asked, not that the restart
                    // failed, and the marker must not be re-created on it.
                    if observed != .unknown { deliberateStop.restore() }
                    throw FleetServiceError.refused(observed == .unknown
                        ? "The BotFleet Server could not be checked after the restart, so nothing can be said about it."
                        : "The BotFleet Server was not replaced: its LaunchAgent owns no process, so the server that is running was not started by launchd.")
                }
                return observed
            }
            try startup.restartAgent(label: label)
            return startup.state(ofAgent: label).managedState
        }
    }

    /// The state of one service, as the Control app sees it.
    private func state(of descriptor: FleetServiceDescriptor) async -> ManagedServiceState {
        switch descriptor.kind {
        case .pm2(let appName):
            if descriptor.policy == .whileServerRuns {
                return await mcpServer?.state() ?? .unknown
            }
            return pm2.state(ofApp: appName)
        case .launchAgent(let label):
            return startup.state(ofAgent: label).managedState
        }
    }

    /// The error the Control app reports when pm2 refused a change.
    private func pm2Failure(_ error: Error, action: String, appName: String) -> FleetServiceError {
        switch error {
        case let failure as McpServerError:
            if case .managerMissing = failure { return .managerMissing }
            return .refused(failure.errorDescription ?? "pm2 could not \(action) \(appName).")
        case let failure as CommandExitError:
            return .refused(failure.output.isEmpty
                ? "pm2 could not \(action) \(appName)."
                : failure.output)
        case StartupPolicyError.commandFailed:
            return .refused("pm2 timed out before it could \(action) \(appName).")
        default:
            return .refused("pm2 could not \(action) \(appName).")
        }
    }
}
