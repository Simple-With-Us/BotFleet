import Foundation

/// The state of the machine that runs a BotFleet server.
public enum RemoteVMState: Equatable, Sendable {
    case running
    case off
    case unknown

    public var label: String {
        switch self {
        case .running: return "Running 🟢"
        case .off: return "Off ⚪"
        case .unknown: return "Unknown"
        }
    }

    /// The badge the menu shows next to the state.
    public var badge: String {
        switch self {
        case .running: return "🟢"
        case .off: return "⚪"
        case .unknown: return "⚫"
        }
    }
}

/// Why a remote machine could not be read or changed.
public enum VMProviderError: LocalizedError, Equatable {
    case notConfigured
    case refused(String)
    case invalidResponse

    public var errorDescription: String? {
        switch self {
        case .notConfigured: return "No remote VM provider is configured for this server."
        case .refused(let message): return message
        case .invalidResponse: return "The provider returned an answer BotFleet Control could not read."
        }
    }
}

/// A plugin that can power a remote machine on and off.
///
/// The Control app does not know how a machine is hosted, so the owner picks a
/// provider and the app asks that provider.  A new provider is a new type
/// that implements this protocol; nothing else in the app has to change.
public protocol VMProviderPlugin: AnyObject {
    /// A stable identifier, used to remember the configuration.
    var providerID: String { get }
    /// The name the menu shows.
    var displayName: String { get }
    /// The state of the machine right now.
    func remoteVMState() async throws -> RemoteVMState
    /// Powers the machine on.
    func startRemoteVM() async throws
    /// Powers the machine off.
    func stopRemoteVM() async throws
    /// Asks the machine to shut down cleanly.
    func shutdownRemoteVM() async throws
}

/// The default provider: the BotFleet server's own control API.
///
/// The server knows about the virtual machine it runs on, so it can start and
/// stop that machine without the app needing a cloud account.
public final class BotFleetServerVMProvider: VMProviderPlugin {
    public let providerID = "botfleet-server"
    public let displayName = "BotFleet Server VM"
    private let api: ControlAPI

    public init(api: ControlAPI) {
        self.api = api
    }

    public func remoteVMState() async throws -> RemoteVMState {
        let status = try await api.status()
        if status.isSharedVMRunning { return .running }
        if status.canStartSharedVM { return .off }
        return .unknown
    }

    public func startRemoteVM() async throws { try await api.startVM() }

    public func stopRemoteVM() async throws { try await api.stopVMs() }

    public func shutdownRemoteVM() async throws { try await api.stopVMs() }
}

/// The provider for a Hetzner Cloud server.
///
/// The API token is the caller's; the app never keeps one of its own.
public final class HetznerCloudVMProvider: VMProviderPlugin {
    /// The provider's API endpoint.
    ///
    /// It is read at runtime rather than forced, because a parsing failure
    /// here would otherwise take the menu down with it.
    public static var apiBase: URL? { URL(string: "https://api.hetzner.cloud/v1") }

    public let providerID = "hetzner-cloud"
    public let displayName = "Hetzner Cloud VM"
    private let serverID: String
    private let token: String
    private let session: URLSession

    public init(serverID: String, token: String, session: URLSession = .shared) {
        self.serverID = serverID
        self.token = token
        self.session = session
    }

    public func remoteVMState() async throws -> RemoteVMState {
        let data = try await send(path: "servers/\(try validatedServerID())", method: "GET", timeout: 15)
        guard let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let server = payload["server"] as? [String: Any],
              let status = server["status"] as? String else {
            throw VMProviderError.invalidResponse
        }
        switch status {
        case "running": return .running
        case "off": return .off
        default: return .unknown
        }
    }

    public func startRemoteVM() async throws {
        try await action("poweron")
    }

    public func stopRemoteVM() async throws {
        try await action("poweroff")
    }

    public func shutdownRemoteVM() async throws {
        try await action("shutdown")
    }

    private func action(_ name: String) async throws {
        _ = try await send(path: "servers/\(try validatedServerID())/actions/\(name)", method: "POST", timeout: 30)
    }

    /// The server's identifier, checked before it reaches the URL.
    ///
    /// A Hetzner server id is a number.  A stored value with a `/`, a `?` or a
    /// `..` in it would change the path or the query that the bearer token is
    /// sent with, so anything that is not a number is refused.
    private func validatedServerID() throws -> String {
        guard !serverID.isEmpty,
              serverID.range(of: "[^0-9]", options: .regularExpression) == nil else {
            throw VMProviderError.refused("The Hetzner server ID is not a number.")
        }
        return serverID
    }

    private func send(path: String, method: String, timeout: TimeInterval) async throws -> Data {
        guard let base = Self.apiBase else {
            throw VMProviderError.refused("The Hetzner Cloud endpoint could not be read.")
        }
        let url = base.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if method == "POST" { request.httpBody = Data("{}".utf8) }
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch { throw VMProviderError.refused("Hetzner Cloud did not answer.") }
        guard let http = response as? HTTPURLResponse else { throw VMProviderError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? [String: Any]
            throw VMProviderError.refused((message?["message"] as? String)
                ?? "Hetzner Cloud refused the request (HTTP \(http.statusCode)).")
        }
        return data
    }
}

/// The provider for a machine the owner drives with their own script.
///
/// The script is called with one argument: `status`, `start`, `stop` or
/// `shutdown`.  A status call succeeds when the script exits 0 and prints
/// `running` or `off`.
public final class CustomScriptVMProvider: VMProviderPlugin {
    public let providerID = "custom-script"
    public let displayName = "Custom Script VM"
    private let command: String
    private let arguments: [String]
    private let commands: CommandRunning

    public init(command: String, arguments: [String] = [], commands: CommandRunning = ProcessCommandRunner()) {
        self.command = command
        self.arguments = arguments
        self.commands = commands
    }

    public func remoteVMState() async throws -> RemoteVMState {
        let output = (try? commands.run(command, arguments + ["status"])) ?? ""
        // The script's answer is compared exactly, because a substring match
        // would read "not running" as running.
        let answer = output.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if answer == "running" { return .running }
        if answer == "off" || answer == "stopped" { return .off }
        return .unknown
    }

    public func startRemoteVM() async throws { try run("start") }

    public func stopRemoteVM() async throws { try run("stop") }

    public func shutdownRemoteVM() async throws { try run("shutdown") }

    private func run(_ action: String) throws {
        do {
            _ = try commands.run(command, arguments + [action], timeout: 60)
        } catch let error as CommandExitError {
            throw VMProviderError.refused(error.output.isEmpty
                ? "The script refused to \(action) the machine."
                : error.output)
        }
    }
}

/// How one server's remote machine is driven.
public struct VMProviderConfiguration: Codable, Equatable, Identifiable, Sendable {
    /// The server this provider belongs to.
    public let id: String
    /// Which provider to use: `botfleet-server`, `hetzner-cloud` or
    /// `custom-script`.
    public var providerID: String
    /// The name the menu shows.
    public var displayName: String
    /// The machine's identifier at the provider: a Hetzner server id or a
    /// BotFleet VM key.
    public var remoteVMID: String?
    /// The provider's API token, when it needs one.
    public var apiToken: String?
    /// The script to run, for the custom provider.
    public var command: String?
    /// The arguments to pass to the script, before the action.
    public var arguments: [String]

    public init(id: String, providerID: String, displayName: String,
                remoteVMID: String? = nil, apiToken: String? = nil,
                command: String? = nil, arguments: [String] = []) {
        self.id = id
        self.providerID = providerID
        self.displayName = displayName
        self.remoteVMID = remoteVMID
        self.apiToken = apiToken
        self.command = command
        self.arguments = arguments
    }

    /// The provider kinds the app offers.
    public static let providerIDs = ["botfleet-server", "hetzner-cloud", "custom-script"]

    /// The name a provider kind shows in the menu.
    public static func displayName(for providerID: String) -> String {
        switch providerID {
        case "botfleet-server": return "BotFleet Server VM"
        case "hetzner-cloud": return "Hetzner Cloud VM"
        case "custom-script": return "Custom Script VM"
        default: return providerID
        }
    }
}

/// Keeps the provider configuration on disk.
///
/// The file holds API tokens, so it is written with owner-only permissions.
public final class VMProviderStore {
    private let fileURL: URL
    private let lock = NSLock()

    public init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
        } else {
            let home = FileManager.default.homeDirectoryForCurrentUser
            self.fileURL = home.appendingPathComponent(".botfleet/control-vm-plugins.json")
        }
    }

    /// The file the configuration lives in.
    public var configurationURL: URL { fileURL }

    /// Reads every configuration, or an empty list when there are none.
    public func loadConfigurations() -> [VMProviderConfiguration] {
        lock.lock()
        defer { lock.unlock() }
        guard FileManager.default.fileExists(atPath: fileURL.path),
              let data = try? Data(contentsOf: fileURL),
              let configs = try? JSONDecoder().decode([VMProviderConfiguration].self, from: data) else {
            return []
        }
        return configs
    }

    /// The configuration for one server, when it has one.
    public func configuration(for serverID: String) -> VMProviderConfiguration? {
        loadConfigurations().first { $0.id == serverID }
    }

    /// Saves the configuration list atomically with owner-only permissions.
    public func saveConfigurations(_ configs: [VMProviderConfiguration]) throws {
        lock.lock()
        defer { lock.unlock() }
        let dir = fileURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(configs)
        let tempURL = dir.appendingPathComponent("control-vm-plugins.\(UUID().uuidString).tmp")
        defer { try? FileManager.default.removeItem(at: tempURL) }
        // The file holds an API token, so it is created with owner-only
        // permissions rather than written wide and tightened afterwards.
        guard FileManager.default.createFile(atPath: tempURL.path, contents: nil,
                                             attributes: [.posixPermissions: 0o600]) else {
            throw VMProviderError.refused("The provider configuration could not be written.")
        }
        try data.write(to: tempURL)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tempURL.path)
        if FileManager.default.fileExists(atPath: fileURL.path) {
            _ = try FileManager.default.replaceItemAt(fileURL, withItemAt: tempURL)
        } else {
            try FileManager.default.moveItem(at: tempURL, to: fileURL)
        }
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }

    /// Adds or replaces one server's configuration.
    public func upsert(_ config: VMProviderConfiguration) throws {
        var configs = loadConfigurations()
        configs.removeAll { $0.id == config.id }
        configs.append(config)
        try saveConfigurations(configs)
    }

    /// Removes one server's configuration.
    @discardableResult
    public func remove(id: String) throws -> Bool {
        var configs = loadConfigurations()
        let before = configs.count
        configs.removeAll { $0.id == id }
        guard configs.count != before else { return false }
        try saveConfigurations(configs)
        return true
    }
}

/// Builds the plugin a configuration asks for.
public enum VMProviderFactory {
    /// The plugin for one configuration, or nil when it cannot be built.
    ///
    /// A configuration whose server has been removed builds nothing.  Falling
    /// back to the local server would mean that "Stop Remote VM" on a server
    /// that is gone would stop the local machine's virtual machines instead.
    public static func makeProvider(for config: VMProviderConfiguration,
                                    hosts: [ServerHost],
                                    session: URLSession = .shared) -> VMProviderPlugin? {
        switch config.providerID {
        case "botfleet-server":
            guard let host = hosts.first(where: { $0.id == config.id }) else { return nil }
            return BotFleetServerVMProvider(api: ControlAPI(session: session, host: host))
        case "hetzner-cloud":
            guard let serverID = config.remoteVMID, !serverID.isEmpty,
                  let token = config.apiToken, !token.isEmpty else { return nil }
            return HetznerCloudVMProvider(serverID: serverID, token: token, session: session)
        case "custom-script":
            guard let command = config.command, !command.isEmpty else { return nil }
            return CustomScriptVMProvider(command: command, arguments: config.arguments)
        default:
            return nil
        }
    }
}
