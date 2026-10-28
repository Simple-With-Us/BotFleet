import Foundation

/// The health the BotFleet MCP server reports about itself.
public struct McpServerHealth: Decodable, Equatable {
    public let status: String
    public let app: String
    public let tools: Int?
}

/// Why the Control app could not manage the BotFleet MCP server.
public enum McpServerError: LocalizedError, Equatable {
    case managerMissing
    case refused(String)

    public var errorDescription: String? {
        switch self {
        case .managerMissing:
            return "The BotFleet MCP Server manager is not installed on this Mac."
        case .refused(let message):
            return message
        }
    }
}

/// One pm2 application, as `pm2 jlist` reports it.
struct PM2Application: Decodable {
    let name: String
    /// The state pm2 has for the application.
    let status: String?

    private enum CodingKeys: String, CodingKey {
        case name
        case environment = "pm2_env"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        if let environment = try? container.decode(PM2Environment.self, forKey: .environment) {
            status = environment.status
        } else {
            status = nil
        }
    }
}

/// The part of a pm2 application the Control app reads.
private struct PM2Environment: Decodable {
    let status: String?
}

/// Runs the pm2 client that owns the BotFleet MCP server.
///
/// The MCP server is a long-running pm2 job, so pm2 is the only thing that may
/// start or stop it.  The Control app never spawns a second copy.
public struct PM2Client {
    /// The pm2 application name for the BotFleet MCP server.
    public static let mcpAppName = "botfleet-mcp"
    /// The pm2 ecosystem file that defines it.
    public static let ecosystemPath = "apps/pm2-ecosystem.config.cjs"

    /// How long a pm2 change is waited for, and how often it is looked at.
    ///
    /// Every look at a pm2 application spawns a node client, so the wait is
    /// made of a few wide looks rather than many narrow ones.  The window is
    /// the same twenty seconds the narrow looks gave, with a quarter of the
    /// processes.
    public static let settleAttempts = 8
    public static let settleInterval: TimeInterval = 2.5

    /// How long the MCP server's own health is waited for.
    ///
    /// The MCP server is observed through an HTTP health endpoint, so a look
    /// at it costs no process, and its window stays the twenty seconds it
    /// always was.  The window is a wall-clock one, because a look that
    /// hangs costs its whole request timeout: a count of looks would let
    /// the menu bar app sit busy for far longer than twenty seconds.
    public static let mcpSettleWindow: TimeInterval = 20

    private let commands: CommandRunning
    private let environment: [String: String]
    private let nodePath: String?
    private let pm2Path: String?
    private let home: URL

    public init(commands: CommandRunning = ProcessCommandRunner(),
                environment: [String: String] = ProcessInfo.processInfo.environment,
                nodePath: String? = nil,
                pm2Path: String? = nil,
                home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        self.commands = commands
        self.environment = environment
        self.home = home
        // A nil path means "find it".  An empty path means it is not there.
        self.nodePath = nodePath ?? PM2Client.discoverNode()
        self.pm2Path = pm2Path ?? PM2Client.discoverPm2()
    }

    public var isAvailable: Bool {
        guard let nodePath, let pm2Path else { return false }
        return !nodePath.isEmpty && !pm2Path.isEmpty
    }

    /// Runs pm2 with an argument list.
    public func run(_ arguments: [String], timeout: TimeInterval = 60) throws -> String {
        guard let nodePath, let pm2Path, !nodePath.isEmpty, !pm2Path.isEmpty else {
            throw McpServerError.managerMissing
        }
        return try commands.run(nodePath, [pm2Path] + arguments,
                                 environment: PM2Client.pm2Environment(environment, home: home),
                                 timeout: timeout)
    }

    /// The environment pm2 needs to find its own daemon and its home.
    static func pm2Environment(_ environment: [String: String], home: URL) -> [String: String] {
        var out = environment
        out["HOME"] = home.path
        out["PM2_HOME"] = environment["PM2_HOME"] ?? home.appendingPathComponent(".pm2").path
        if out["PATH"] == nil || out["PATH"]?.isEmpty == true {
            out["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        }
        return out
    }

    /// The node that runs pm2.  A menu bar app inherits no shell PATH, so the
    /// path has to be absolute.
    public static func discoverNode() -> String? {
        ["/opt/homebrew/bin/node", "/usr/local/bin/node"].first { isExecutable($0) }
    }

    /// The pm2 client script.
    public static func discoverPm2() -> String? {
        ["/opt/homebrew/lib/node_modules/pm2/bin/pm2",
         "/usr/local/lib/node_modules/pm2/bin/pm2"].first { isExecutable($0) }
    }

    /// The state of every pm2 application pm2 knows about, by name.
    ///
    /// `nil` means pm2 could not be asked at all, so nothing is known about
    /// any application.  That is not the same as an empty answer, which
    /// means pm2 knows about no application at all.
    public func appStates() -> [String: ManagedServiceState]? {
        guard isAvailable else { return nil }
        guard let listing = try? run(["jlist"]) else { return nil }
        return PM2Client.parseAppStates(listing)
    }

    /// The state of one pm2 application.
    ///
    /// An application pm2 has no record of is not running: it was never
    /// started, and nothing asked it to stop.  A pm2 that cannot be reached
    /// knows nothing, so the state is unknown.
    public func state(ofApp name: String) -> ManagedServiceState {
        guard let states = appStates() else { return .unknown }
        return states[name] ?? .stopped
    }

    /// Reads the states out of what `pm2 jlist` printed.
    ///
    /// pm2 reports every application it knows about as JSON, with the state
    /// of each one under its own environment.
    public static func parseAppStates(_ listing: String) -> [String: ManagedServiceState] {
        guard let data = listing.data(using: .utf8),
              let applications = try? JSONDecoder().decode([PM2Application].self, from: data) else { return [:] }
        var states: [String: ManagedServiceState] = [:]
        for application in applications {
            states[application.name] = state(forStatus: application.status)
        }
        return states
    }

    /// The state pm2's own status means.
    ///
    /// An application that errored is not running and nothing asked it to
    /// stop, so it failed.  A status the Control app does not know is
    /// unknown, and an unknown service is never acted on.
    public static func state(forStatus status: String?) -> ManagedServiceState {
        switch status {
        case "online": return .running
        case "stopped": return .stopped
        case "errored": return .failed
        default: return .unknown
        }
    }

    /// Starts a pm2 application.
    ///
    /// `pm2 start <name>` only works while pm2 still remembers the job.  When
    /// it does not, the ecosystem file is the way back, so it is tried second.
    public func start(appName: String) throws {
        do {
            _ = try run(["start", appName])
        } catch {
            let ecosystem = home.appendingPathComponent(PM2Client.ecosystemPath)
            guard FileManager.default.fileExists(atPath: ecosystem.path) else { throw error }
            _ = try run(["start", ecosystem.path, "--only", appName])
        }
    }

    /// Stops a pm2 application.
    public func stop(appName: String) throws {
        _ = try run(["stop", appName])
    }

    /// Restarts a pm2 application.
    ///
    /// The same fallback as a start: when pm2 no longer remembers the
    /// application, the ecosystem file is the way back, so it is tried second.
    public func restart(appName: String) throws {
        do {
            _ = try run(["restart", appName])
        } catch {
            let ecosystem = home.appendingPathComponent(PM2Client.ecosystemPath)
            guard FileManager.default.fileExists(atPath: ecosystem.path) else { throw error }
            _ = try run(["start", ecosystem.path, "--only", appName])
        }
    }

    /// Brings one pm2 application to the wanted state and reports what was
    /// seen.
    ///
    /// The observed state after the change is what is reported, so a manager
    /// that refused the change is never reported as a success.  An unknown
    /// observed state is never acted on: the Control app does not stop a
    /// service it cannot see, and it does not start one it cannot prove is
    /// missing.
    @discardableResult
    public func setRunning(_ running: Bool,
                           appName: String,
                           attempts: Int = PM2Client.settleAttempts,
                           interval: TimeInterval = PM2Client.settleInterval) async throws -> ManagedServiceState {
        let wanted: ManagedServiceState = running ? .running : .stopped
        let current = state(ofApp: appName)
        if current == wanted { return current }
        if current == .unknown { return current }
        if running {
            try start(appName: appName)
        } else {
            try stop(appName: appName)
        }
        return await ManagedServices.settle(to: wanted,
                                            attempts: attempts,
                                            interval: interval) {
            self.state(ofApp: appName)
        }
    }
}

private extension PM2Client {
    static func isExecutable(_ path: String) -> Bool {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else { return false }
        return !isDirectory.boolValue
    }
}

/// The BotFleet MCP server as the Control app sees it: the loopback HTTP and
/// SSE adapter that proxies every tool call to the BotFleet Server.
public final class McpServerControl {
    /// The default loopback port of the MCP server.
    public static let defaultPort = 8794
    /// The app identity the MCP server reports.
    public static let appIdentity = "botfleet-admin-mcp"

    private let session: URLSession
    private let baseURL: URL
    private let pm2: PM2Client

    /// Prepares the MCP server control.
    ///
    /// The endpoint is optional so that a missing one is reported rather than
    /// forced open: a crash over a URL would take the whole Control app down
    /// for a problem the owner can read about in the menu.
    public init(session: URLSession = .shared,
                baseURL: URL? = URL(string: "http://127.0.0.1:\(McpServerControl.defaultPort)"),
                pm2: PM2Client = PM2Client()) throws {
        guard let baseURL else {
            throw McpServerError.refused("Could not determine the BotFleet MCP Server endpoint.")
        }
        self.session = session
        self.baseURL = baseURL
        self.pm2 = pm2
    }

    /// The observed state of the MCP server.
    ///
    /// Nothing is assumed: the server is running only when it answers its own
    /// health endpoint as the BotFleet MCP server.  A port that nothing
    /// answers is stopped; a port that answers as something else is unknown.
    public func state() async -> ManagedServiceState {
        guard let url = URL(string: "/health", relativeTo: baseURL)?.absoluteURL else { return .unknown }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 3
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch let error as URLError {
            switch error.code {
            case .cannotConnectToHost, .networkConnectionLost, .cannotFindHost:
                return .stopped
            default:
                return .unknown
            }
        }
        catch { return .unknown }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              http.url?.host == "127.0.0.1" else { return .unknown }
        guard let health = try? JSONDecoder().decode(McpServerHealth.self, from: data),
              health.app == McpServerControl.appIdentity, health.status == "ok" else { return .unknown }
        return .running
    }

    /// Brings the MCP server to the wanted state.
    ///
    /// The observed state after the change is what is reported, so a manager
    /// that refused the change is never reported as a success.  An unknown
    /// observed state is never acted on: the Control app does not stop a
    /// service it cannot see, and it does not start one it cannot prove is
    /// missing.
    @discardableResult
    public func setRunning(_ running: Bool, within: TimeInterval = PM2Client.mcpSettleWindow) async throws -> ManagedServiceState {
        let wanted: ManagedServiceState = running ? .running : .stopped
        let current = await state()
        if current == wanted { return current }
        if current == .unknown { return current }
        do {
            if running {
                try pm2.start(appName: PM2Client.mcpAppName)
            } else {
                try pm2.stop(appName: PM2Client.mcpAppName)
            }
        } catch let error as McpServerError {
            throw error
        } catch let error as CommandExitError {
            throw McpServerError.refused(error.output.isEmpty
                ? "pm2 could not change the BotFleet MCP Server."
                : error.output)
        } catch StartupPolicyError.commandFailed {
            // The command runner reports a timeout as a generic command
            // failure.  Say which command it was, so a slow pm2 is never
            // reported as a problem with the BotFleet Server LaunchAgent.
            throw McpServerError.refused("pm2 timed out before it could change the BotFleet MCP Server.")
        } catch {
            throw McpServerError.refused("pm2 could not change the BotFleet MCP Server.")
        }
        return await ManagedServices.settle(to: wanted, within: within) { await self.state() }
    }

    /// Restarts the MCP server and reports what was seen.
    ///
    /// The MCP server keeps its own health endpoint as the only authority on
    /// whether it is running, so the state that is reported is the one that
    /// endpoint answers with.
    @discardableResult
    public func restart(within: TimeInterval = PM2Client.mcpSettleWindow) async throws -> ManagedServiceState {
        do {
            try pm2.restart(appName: PM2Client.mcpAppName)
        } catch let error as McpServerError {
            throw error
        } catch let error as CommandExitError {
            throw McpServerError.refused(error.output.isEmpty
                ? "pm2 could not restart the BotFleet MCP Server."
                : error.output)
        } catch StartupPolicyError.commandFailed {
            throw McpServerError.refused("pm2 timed out before it could restart the BotFleet MCP Server.")
        } catch {
            throw McpServerError.refused("pm2 could not restart the BotFleet MCP Server.")
        }
        return await ManagedServices.settle(to: .running, within: within) { await self.state() }
    }
}
