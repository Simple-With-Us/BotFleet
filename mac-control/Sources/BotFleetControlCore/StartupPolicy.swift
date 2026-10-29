import Foundation

public protocol CommandRunning {
    func run(_ executable: String, _ arguments: [String]) throws -> String
    func run(_ executable: String, _ arguments: [String], timeout: TimeInterval) throws -> String
    /// Runs a command with an explicit environment.  A menu bar app inherits
    /// no shell PATH, so a command that needs one has to be given it.
    func run(_ executable: String, _ arguments: [String], environment: [String: String], timeout: TimeInterval) throws -> String
    /// Runs a command and keeps what it printed, whatever its exit status.
    ///
    /// A command that warns and still answers is not a command that failed.
    /// `lsof` exits with 1 when it could not examine one of the processes it
    /// was asked about, and the answer for the ones it could examine is in
    /// its output all the same.  Throwing that away would leave the caller
    /// with nothing, and the caller cannot tell an empty answer from a lost
    /// one.
    func runKeepingOutput(_ executable: String, _ arguments: [String]) -> String
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

    /// The default keeps what the command printed, whatever it exited with.
    ///
    /// A command that warns and still answers is not a command that failed,
    /// and the answer it printed is in the failure itself.  A conformer that
    /// does not override this has to keep that answer too, or the same probe
    /// would come back empty from one conformer and full from another.
    func runKeepingOutput(_ executable: String, _ arguments: [String]) -> String {
        do { return try run(executable, arguments) }
        catch let failure as CommandExitError { return failure.output }
        catch { return "" }
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
        let (result, status) = try execute(executable, arguments, environment: environment, timeout: timeout)
        guard status == 0 else { throw CommandExitError(output: result) }
        return result
    }
    public func runKeepingOutput(_ executable: String, _ arguments: [String]) -> String {
        runKeepingOutput(executable, arguments, environment: ProcessInfo.processInfo.environment, timeout: 15)
    }
    public func runKeepingOutput(_ executable: String, _ arguments: [String], environment: [String: String], timeout: TimeInterval) -> String {
        (try? execute(executable, arguments, environment: environment, timeout: timeout)).map { $0.0 } ?? ""
    }
    /// Runs a command and reports what it printed and how it ended.
    private func execute(_ executable: String, _ arguments: [String], environment: [String: String], timeout: TimeInterval) throws -> (String, Int32) {
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
        return (result, process.terminationStatus)
    }
}

public enum StartupPolicyError: LocalizedError {
    case updateRequired
    case bootIdentityUnavailable
    case launchAgentMissing
    case commandFailed
    case refused(String)

    public var errorDescription: String? {
        switch self {
        case .updateRequired: return "Update BotFleet before changing server startup settings."
        case .bootIdentityUnavailable: return "Could not identify the current Mac boot session."
        case .launchAgentMissing: return "The BotFleet Server LaunchAgent is not installed.  Reinstall BotFleet."
        case .commandFailed: return "macOS could not change the BotFleet Server LaunchAgent.  Check its installation."
        case .refused(let message): return message
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

    /// The state as the fleet services list shows it.
    public var managedState: ManagedServiceState {
        switch self {
        case .running: return .running
        case .stopped: return .stopped
        case .notInstalled: return .notInstalled
        case .unknown: return .unknown
        }
    }
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

    /// The label of the BotFleet Server LaunchAgent.
    public static let serverAgentLabel = "app.botfleet.server"

    /// The LaunchAgent plist that installs a label.
    public func launchAgentPlist(label: String) -> URL {
        home.appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

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
        state(ofAgent: StartupPolicy.serverAgentLabel)
    }

    /// The state of a launchd agent, by its label.
    ///
    /// An agent with a live process behind it is running.  An agent that is
    /// loaded without one is stopped, and so is one that is not loaded at
    /// all.  An agent whose plist is not installed is not installed, and a
    /// launchctl that could not be asked is unknown.
    public func state(ofAgent label: String) -> InstalledServerState {
        guard files.fileExists(atPath: launchAgentPlist(label: label).path) else { return .notInstalled }
        let listing: String
        do { listing = try commands.run("/bin/launchctl", ["list"]) }
        catch { return .unknown }
        let row = listing.split(separator: "\n").first { line in
            line.split(whereSeparator: \.isWhitespace).last == Substring(label)
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
        let wasStopped = files.fileExists(atPath: stopped.path)
        if wasStopped { try files.removeItem(at: stopped) }
        do {
            try startAgent(label: StartupPolicy.serverAgentLabel)
        } catch {
            if wasStopped { try? Data().write(to: stopped, options: .atomic) }
            throw error
        }
    }

    /// Restarts the BotFleet Server.
    ///
    /// A restart asks for a fresh copy of the server, so the deliberate-stop
    /// marker is cleared first: the installed wrapper stays down while that
    /// marker exists, and a restart that left it in place would report a
    /// server that never came back.  The marker is put back when the restart
    /// fails, so a refused restart does not lift a deliberate stop.
    ///
    /// The returned handle puts the marker back as well, for a restart that
    /// does not throw but does not replace the server either.
    @discardableResult
    public func restartServer() throws -> DeliberateStop {
        guard supportsPolicy else { throw StartupPolicyError.updateRequired }
        guard files.fileExists(atPath: agent.path) else { throw StartupPolicyError.launchAgentMissing }
        let boot = try bootID()
        try files.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        try Data((boot + "\n").utf8).write(to: session, options: .atomic)
        let wasStopped = files.fileExists(atPath: stopped.path)
        if wasStopped { try files.removeItem(at: stopped) }
        do {
            try restartAgent(label: StartupPolicy.serverAgentLabel)
        } catch {
            if wasStopped { try? Data().write(to: stopped, options: .atomic) }
            throw error
        }
        return DeliberateStop(marker: stopped, files: files, wasStopped: wasStopped)
    }

    /// What a restart of the BotFleet Server did to the deliberate-stop
    /// marker.
    ///
    /// A restart clears the marker so the installed wrapper can start the
    /// server again.  When the restart does not replace the server, the
    /// marker goes back, because a refused restart must not lift a
    /// deliberate stop.
    public struct DeliberateStop {
        private let marker: URL
        private let files: FileManager
        private let wasStopped: Bool

        fileprivate init(marker: URL, files: FileManager, wasStopped: Bool) {
            self.marker = marker
            self.files = files
            self.wasStopped = wasStopped
        }

        /// True when the marker was there before the restart.
        public var wasStoppedByOwner: Bool { wasStopped }

        /// Puts the deliberate-stop marker back, when it was there before.
        public func restore() {
            guard wasStopped else { return }
            try? files.createDirectory(at: marker.deletingLastPathComponent(),
                                       withIntermediateDirectories: true)
            try? Data().write(to: marker, options: .atomic)
        }
    }

    /// Starts a launchd agent: it is enabled, loaded if it is not loaded
    /// yet, and kickstarted.
    ///
    /// The kickstart does not terminate a running instance, so starting an
    /// agent that is already up leaves it alone.
    public func startAgent(label: String) throws {
        let plist = launchAgentPlist(label: label)
        guard files.fileExists(atPath: plist.path) else {
            throw StartupPolicyError.refused("The \(label) LaunchAgent is not installed on this Mac.")
        }
        let domain = "gui/\(uid)"
        let full = "\(domain)/\(label)"
        _ = try commands.run("/bin/launchctl", ["enable", full])
        if (try? commands.run("/bin/launchctl", ["print", full])) == nil {
            _ = try commands.run("/bin/launchctl", ["bootstrap", domain, plist.path])
        }
        _ = try commands.run("/bin/launchctl", ["kickstart", full])
    }

    /// Stops a launchd agent and leaves it stopped.
    ///
    /// The agent is booted out of the login domain, so launchd does not
    /// bring it back on its own afterwards.
    public func stopAgent(label: String) throws {
        let full = "gui/\(uid)/\(label)"
        do {
            _ = try commands.run("/bin/launchctl", ["bootout", full])
        } catch let error as CommandExitError {
            throw StartupPolicyError.refused(error.output.isEmpty
                ? "macOS could not stop the \(label) LaunchAgent."
                : error.output)
        }
    }

    /// Restarts a launchd agent.
    ///
    /// An agent that is not loaded is started instead, because there is
    /// nothing to replace.  A loaded one is kickstarted with the running
    /// instance replaced, so the agent comes back fresh.
    public func restartAgent(label: String) throws {
        let full = "gui/\(uid)/\(label)"
        if (try? commands.run("/bin/launchctl", ["print", full])) == nil {
            try startAgent(label: label)
            return
        }
        _ = try commands.run("/bin/launchctl", ["kickstart", "-k", full])
    }

    private func bootID() throws -> String {
        let value = (try? commands.run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"])) ?? ""
        guard UUID(uuidString: value) != nil else { throw StartupPolicyError.bootIdentityUnavailable }
        return value
    }
}
