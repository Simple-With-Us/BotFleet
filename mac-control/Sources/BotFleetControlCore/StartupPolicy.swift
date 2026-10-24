import Foundation

public protocol CommandRunning {
    func run(_ executable: String, _ arguments: [String]) throws -> String
    func run(_ executable: String, _ arguments: [String], timeout: TimeInterval) throws -> String
    /// Runs a command with an explicit environment.  A menu bar app inherits
    /// no shell PATH, so a command that needs one has to be given it.
    func run(_ executable: String, _ arguments: [String], environment: [String: String], timeout: TimeInterval) throws -> String
}

public struct CommandExitError: LocalizedError {
    public let output: String
    public var errorDescription: String? { "The system command failed." }
}

public extension CommandRunning {
    func run(_ executable: String, _ arguments: [String], timeout: TimeInterval) throws -> String {
        try run(executable, arguments)
    }

    func run(_ executable: String, _ arguments: [String], environment: [String: String], timeout: TimeInterval) throws -> String {
        try run(executable, arguments, timeout: timeout)
    }
}

public struct ProcessCommandRunner: CommandRunning {
    public init() {}
    public func run(_ executable: String, _ arguments: [String]) throws -> String {
        try run(executable, arguments, timeout: 15)
    }
    public func run(_ executable: String, _ arguments: [String], timeout: TimeInterval) throws -> String {
        try run(executable, arguments, environment: ProcessInfo.processInfo.environment, timeout: timeout)
    }
    public func run(_ executable: String, _ arguments: [String], environment: [String: String], timeout: TimeInterval) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = environment
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        let readerDone = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0)
        var data = Data()
        process.terminationHandler = { _ in finished.signal() }
        try process.run()
        DispatchQueue.global(qos: .utility).async {
            data = output.fileHandleForReading.readDataToEndOfFile()
            readerDone.signal()
        }
        if finished.wait(timeout: .now() + timeout) == .timedOut {
            if process.isRunning { process.terminate() }
            if finished.wait(timeout: .now() + 2) == .timedOut && process.isRunning {
                Darwin.kill(process.processIdentifier, SIGKILL)
            }
            throw StartupPolicyError.commandFailed
        }
        guard readerDone.wait(timeout: .now() + 2) == .success else { throw StartupPolicyError.commandFailed }
        let result = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard process.terminationStatus == 0 else { throw CommandExitError(output: result) }
        return result
    }
}

public enum StartupPolicyError: LocalizedError {
    case updateRequired
    case bootIdentityUnavailable
    case launchAgentMissing
    case commandFailed

    public var errorDescription: String? {
        switch self {
        case .updateRequired: return "Update BotFleet before changing server startup settings."
        case .bootIdentityUnavailable: return "Could not identify the current Mac boot session."
        case .launchAgentMissing: return "The BotFleet Server LaunchAgent is not installed.  Reinstall BotFleet."
        case .commandFailed: return "macOS could not change the BotFleet Server LaunchAgent.  Check its installation."
        }
    }
}

public enum ServerLoginPolicy: Equatable {
    case legacy
    case enabled
    case disabled
}

public enum InstalledServerState: Equatable {
    case notInstalled
    case stopped
    case running
    case unknown
}

public final class StartupPolicy {
    private let home: URL
    private let files: FileManager
    private let commands: CommandRunning
    private let uid: UInt32
    private let environment: [String: String]

    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser,
                files: FileManager = .default,
                commands: CommandRunning = ProcessCommandRunner(),
                uid: UInt32 = getuid(),
                environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.home = home
        self.files = files
        self.commands = commands
        self.uid = uid
        self.environment = environment
    }

    private var dataDirectory: URL {
        if let value = environment["OMB_DATA_DIR"], !value.isEmpty, value.hasPrefix("/") {
            return URL(fileURLWithPath: value, isDirectory: true)
        }
        return home.appendingPathComponent(".botfleet", isDirectory: true)
    }
    private var wrapper: URL { home.appendingPathComponent("apps/botfleet-server-start.sh") }
    private var agent: URL { home.appendingPathComponent("Library/LaunchAgents/app.botfleet.server.plist") }
    private var disabled: URL { dataDirectory.appendingPathComponent("startup-disabled.marker") }
    private var enabled: URL { dataDirectory.appendingPathComponent("startup-enabled.marker") }
    private var session: URL { dataDirectory.appendingPathComponent("startup-session") }
    private var stopped: URL { dataDirectory.appendingPathComponent("stopped.marker") }

    public var supportsPolicy: Bool {
        guard let data = try? Data(contentsOf: wrapper),
              let source = String(data: data, encoding: .utf8) else { return false }
        return source.contains("BF_CONTROL_STARTUP_POLICY_V1")
    }

    public var loginPolicy: ServerLoginPolicy {
        if files.fileExists(atPath: disabled.path) { return .disabled }
        if files.fileExists(atPath: enabled.path) { return .enabled }
        return .legacy
    }

    public var startsAtLogin: Bool { loginPolicy == .enabled }

    public var installedServerState: InstalledServerState {
        guard files.fileExists(atPath: agent.path) else { return .notInstalled }
        let listing: String
        do { listing = try commands.run("/bin/launchctl", ["list"]) }
        catch { return .unknown }
        let row = listing.split(separator: "\n").first { line in
            line.split(whereSeparator: \.isWhitespace).last == "app.botfleet.server"
        }
        guard let row else { return .stopped }
        let pid = row.split(whereSeparator: \.isWhitespace).first ?? "-"
        return UInt32(pid) == nil ? .stopped : .running
    }

    public func setStartsAtLogin(_ enabled: Bool) throws {
        guard supportsPolicy else { throw StartupPolicyError.updateRequired }
        let boot = try bootID()
        try files.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        try Data((boot + "\n").utf8).write(to: session, options: .atomic)
        if enabled {
            try Data().write(to: self.enabled, options: .atomic)
            if files.fileExists(atPath: disabled.path) { try files.removeItem(at: disabled) }
        } else {
            try Data().write(to: disabled, options: .atomic)
            if files.fileExists(atPath: self.enabled.path) { try files.removeItem(at: self.enabled) }
        }
    }

    public func startServer() throws {
        guard supportsPolicy else { throw StartupPolicyError.updateRequired }
        guard files.fileExists(atPath: agent.path) else { throw StartupPolicyError.launchAgentMissing }
        let boot = try bootID()
        try files.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        try Data((boot + "\n").utf8).write(to: session, options: .atomic)
        let domain = "gui/\(uid)"
        let label = "\(domain)/app.botfleet.server"
        _ = try commands.run("/bin/launchctl", ["enable", label])
        if (try? commands.run("/bin/launchctl", ["print", label])) == nil {
            _ = try commands.run("/bin/launchctl", ["bootstrap", domain, agent.path])
        }
        let wasStopped = files.fileExists(atPath: stopped.path)
        if wasStopped { try files.removeItem(at: stopped) }
        do {
            _ = try commands.run("/bin/launchctl", ["kickstart", label])
        } catch {
            if wasStopped { try? Data().write(to: stopped, options: .atomic) }
            throw error
        }
    }

    private func bootID() throws -> String {
        let value = (try? commands.run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"])) ?? ""
        guard UUID(uuidString: value) != nil else { throw StartupPolicyError.bootIdentityUnavailable }
        return value
    }
}
