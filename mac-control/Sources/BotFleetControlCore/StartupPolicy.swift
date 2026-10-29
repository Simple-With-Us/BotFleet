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
    /// What the command printed on its standard output.
    public let output: String
    /// What the command printed on its standard error, when the runner kept
    /// it.  launchctl explains a refusal there, so a probe can tell "no such
    /// service" from a request launchd could not answer.
    public var errorOutput: String = ""
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
        let (result, errorText, status) = try execute(executable, arguments, environment: environment, timeout: timeout)
        guard status == 0 else { throw CommandExitError(output: result, errorOutput: errorText) }
        return result
    }
    public func runKeepingOutput(_ executable: String, _ arguments: [String]) -> String {
        runKeepingOutput(executable, arguments, environment: ProcessInfo.processInfo.environment, timeout: 15)
    }
    public func runKeepingOutput(_ executable: String, _ arguments: [String], environment: [String: String], timeout: TimeInterval) -> String {
        (try? execute(executable, arguments, environment: environment, timeout: timeout)).map { $0.0 } ?? ""
    }
    /// Runs a command and reports what it printed, what it complained, and
    /// how it ended.
    private func execute(_ executable: String, _ arguments: [String], environment: [String: String], timeout: TimeInterval) throws -> (String, String, Int32) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = environment
        let output = Pipe()
        let errors = Pipe()
        process.standardOutput = output
        process.standardError = errors
        let readerDone = DispatchSemaphore(value: 0)
        let errorReaderDone = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0)
        var data = Data()
        var errorData = Data()
        process.terminationHandler = { _ in finished.signal() }
        try process.run()
        DispatchQueue.global(qos: .utility).async {
            data = output.fileHandleForReading.readDataToEndOfFile()
            readerDone.signal()
        }
        DispatchQueue.global(qos: .utility).async {
            errorData = errors.fileHandleForReading.readDataToEndOfFile()
            errorReaderDone.signal()
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
        // A command that exited after handing its stderr to a background
        // child keeps this pipe open.  The command still answered, so a late
        // stderr is read as empty rather than as a failure.
        let errorText = errorReaderDone.wait(timeout: .now() + 2) == .success
            ? String(decoding: errorData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            : ""
        return (result, errorText, process.terminationStatus)
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

    /// How long a stop waits for launchd to unload the agent before it
    /// decides the stop did not take.
    ///
    /// launchd gives a job twenty seconds after SIGTERM before it kills it,
    /// so the wait is longer than that: a teardown that is merely slow must
    /// not be reported as a stop that failed.
    public static let unloadAttempts = 50
    public static let unloadInterval: TimeInterval = 0.5

    /// Stops a launchd agent and leaves it stopped, across logins and
    /// restarts.
    ///
    /// The agent is disabled in launchd's own record first, so a plist with
    /// `RunAtLoad` does not bring it back at the next login, and then booted
    /// out of the login domain, so it stops now and its `StartInterval`
    /// cannot fire.  `startAgent` enables it again, so the owner's start
    /// undoes exactly this.
    ///
    /// Whether the stop took is read from launchd, never from the bootout's
    /// exit status: `launchctl bootout` exits nonzero while a teardown is
    /// still in progress and when the job was already gone, and a command
    /// that outlives the runner's timeout is not a bootout that failed.  So
    /// the bootout is run for its effect, and `launchctl print` is asked
    /// until the job is no longer loaded.  An agent that is still loaded
    /// after that is put back to enabled, because an agent that is still
    /// running must not be left disabled behind the owner's back, and the
    /// refusal says so.
    public func stopAgent(label: String,
                          unloadAttempts: Int = StartupPolicy.unloadAttempts,
                          unloadInterval: TimeInterval = StartupPolicy.unloadInterval) async throws {
        let full = "gui/\(uid)/\(label)"
        do {
            _ = try commands.run("/bin/launchctl", ["disable", full])
        } catch let error as CommandExitError {
            throw StartupPolicyError.refused(error.output.isEmpty
                ? "macOS could not disable the \(label) LaunchAgent."
                : error.output)
        } catch {
            throw StartupPolicyError.refused("launchctl did not answer while disabling the \(label) LaunchAgent, so nothing was stopped.")
        }
        _ = try? commands.run("/bin/launchctl", ["bootout", full])
        let step = StartupPolicy.unloadStep(unloadInterval)
        switch await waitUntilUnloaded(full, attempts: unloadAttempts, step: step) {
        case .unloaded:
            return
        case .loaded:
            // The agent is still running, so it must not stay disabled behind
            // the owner's back.  A teardown that finishes between the last
            // look and the enable is caught by one more look: a job that is
            // gone now is a stop that took, and the disable goes back on.
            let enabled = (try? commands.run("/bin/launchctl", ["enable", full])) != nil
            switch probeLoaded(full) {
            case .unloaded:
                do {
                    _ = try commands.run("/bin/launchctl", ["disable", full])
                } catch {
                    // Enabled and unloaded is the one state this look exists
                    // to prevent: launchd starts the agent again at the next
                    // login.  It is a refusal the owner reads, never a stop
                    // reported as held.
                    throw StartupPolicyError.refused("The \(label) LaunchAgent stopped, but launchctl could not disable it again, so launchd starts it at the next login.  Repeat Stop once launchd answers.")
                }
                return
            case .loaded:
                let waited = Int((Double(max(unloadAttempts, 1)) * step).rounded())
                throw StartupPolicyError.refused("The \(label) LaunchAgent is still loaded after \(waited) seconds.  \(StartupPolicy.enableOutcome(enabled, whileStopping: true))")
            case .couldNotAsk:
                throw StartupPolicyError.refused("The \(label) LaunchAgent was still loaded when the wait ran out, and launchctl did not answer the last look.  \(StartupPolicy.enableOutcome(enabled, whileStopping: false))  Try again once launchd answers.")
            }
        case .couldNotAsk:
            let enabled = (try? commands.run("/bin/launchctl", ["enable", full])) != nil
            throw StartupPolicyError.refused("launchctl did not answer while Control waited for the \(label) LaunchAgent to unload, so nothing can be said about it.  \(StartupPolicy.enableOutcome(enabled, whileStopping: false))  Try again once launchd answers.")
        }
    }

    /// What the refusal says about the agent's enable, after a stop that did
    /// not take: only what was checked, never the outcome the code hoped for.
    private static func enableOutcome(_ enabled: Bool, whileStopping: Bool) -> String {
        if enabled {
            return whileStopping
                ? "It is left enabled, and it may still be stopping; if it stops now, launchd starts it again at the next login until Stop is repeated."
                : "It is left enabled."
        }
        return whileStopping
            ? "It may still be stopping, and Control could not re-enable it, so it stays disabled and will not start at the next login until Start is used."
            : "Control could not re-enable it, so it stays disabled and will not start at the next login until Start is used."
    }

    /// The wait between looks, clamped so a caller cannot trap the app or
    /// wait for ever: a non-finite or negative interval waits nothing, and a
    /// long one waits a minute at most.
    static func unloadStep(_ interval: TimeInterval) -> TimeInterval {
        interval.isFinite ? min(max(interval, 0), 60) : 0
    }

    /// What one look at launchd said about a job.
    private enum LoadedAnswer {
        case loaded
        case unloaded
        case couldNotAsk
    }

    /// Asks launchd once whether the job is loaded.
    ///
    /// `launchctl print` fails for a job that is not loaded, saying so on
    /// its standard error, and that is the one answer that proves a bootout
    /// took.  A print that failed for any other reason, or that the command
    /// runner had to abandon, is not an answer, and it must not be read as
    /// "unloaded": that is the one way a running agent could be left
    /// disabled.
    private func probeLoaded(_ full: String) -> LoadedAnswer {
        do {
            _ = try commands.run("/bin/launchctl", ["print", full])
            return .loaded
        } catch let error as CommandExitError {
            return StartupPolicy.saysServiceMissing(error) ? .unloaded : .couldNotAsk
        } catch {
            return .couldNotAsk
        }
    }

    /// Whether a failed `launchctl print` said the job is not loaded.
    ///
    /// launchctl writes `Could not find service "<label>" in domain for uid:
    /// <uid>` for a job that is not loaded.  A domain it could not print, or
    /// a request it refused, is worded differently and says nothing about the
    /// job.
    static func saysServiceMissing(_ error: CommandExitError) -> Bool {
        error.errorOutput.contains("Could not find service")
    }

    /// Asks launchd until the job is unloaded, or the wait is up.
    ///
    /// A job that is still being torn down answers for a while, so the
    /// question is asked more than once, with the wait between looks spent
    /// suspended rather than holding a thread.  The window is a budget of
    /// wall-clock time, not a number of looks: a look that was slow to answer
    /// has spent the budget.  A look launchd did not answer ends the wait at
    /// once, because the runner's own timeout has already been spent and
    /// another look would not make launchd answer; the caller re-enables and
    /// says so.
    private func waitUntilUnloaded(_ full: String, attempts: Int, step: TimeInterval) async -> LoadedAnswer {
        let looks = max(attempts, 1)
        let deadline = Date().addingTimeInterval(Double(looks) * step)
        for attempt in 0..<looks {
            switch probeLoaded(full) {
            case .unloaded: return .unloaded
            case .couldNotAsk: return .couldNotAsk
            case .loaded: break
            }
            if step > 0, Date() >= deadline { return .loaded }
            if attempt + 1 < looks, step > 0 {
                try? await Task.sleep(nanoseconds: UInt64(step * 1_000_000_000))
            }
        }
        return .loaded
    }

    /// Stops a BotFleet Server that cannot be asked to stop itself.
    ///
    /// The server's own stop route is the right stop: it refuses while work
    /// is in flight and drains before it exits.  A server older than this
    /// app has no such route, so the only stop left is the one launchd
    /// offers.  The deliberate-stop marker is written first, so the installed
    /// wrapper does not start the server again on its next tick, and the
    /// LaunchAgent, when it is installed, is then booted out, which sends the
    /// server a termination signal.  The agent is not disabled: the marker is
    /// the durable stop for the server, and a disabled agent would defeat
    /// Start Server At Login.
    ///
    /// Nothing here is trusted as proof that the server is gone.  launchd
    /// does not always own the server process, the plist is not always
    /// installed, and `launchctl bootout` exits nonzero even when it worked,
    /// so the bootout's exit status is ignored and the caller asks the port
    /// afterwards.  The method reports whether launchd was asked at all, so
    /// the caller can say what happened.
    @discardableResult
    public func forceStopServer() throws -> Bool {
        try files.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        try Data().write(to: stopped, options: .atomic)
        guard files.fileExists(atPath: agent.path) else { return false }
        _ = try? commands.run("/bin/launchctl", ["bootout", "gui/\(uid)/\(StartupPolicy.serverAgentLabel)"])
        return true
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
