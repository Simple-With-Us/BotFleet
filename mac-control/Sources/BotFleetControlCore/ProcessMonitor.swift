import Foundation

/// One running process on this Mac, as the system reports it.
public struct RawProcess: Equatable, Sendable {
    public let pid: Int32
    public let parentPID: Int32
    public let command: String
    /// The executable's own path, when the system could name it.
    ///
    /// The command line is split on spaces, and an application path can hold
    /// one, so the path is read separately instead of being guessed at from
    /// the command.
    public let executablePath: String?
    /// The directory the process is working in, when the system could name it.
    ///
    /// The server is started from a relative path, so its command line says
    /// nothing about which repository it is from.  The working directory does,
    /// and it is what tells the fleet's own processes from everyone else's.
    public let workingDirectory: String?

    public init(pid: Int32, parentPID: Int32, command: String,
                executablePath: String? = nil, workingDirectory: String? = nil) {
        self.pid = pid
        self.parentPID = parentPID
        self.command = command
        self.executablePath = executablePath
        self.workingDirectory = workingDirectory
    }
}

/// One running process that belongs to the BotFleet fleet.
public struct FleetProcess: Equatable, Identifiable, Sendable {
    public let pid: Int32
    public let parentPID: Int32
    /// The helper's own name, when the fleet has one, so the menu can say
    /// `qdrant-proxy` instead of `node`.
    public let name: String
    public let command: String
    /// The directory the process is working in, when the system could name it.
    public let workingDirectory: String?
    /// The TCP ports this process is listening on.
    public let ports: [Int]
    /// True when the process belongs to the fleet, whether or not it is wanted.
    public let isFleetProcess: Bool
    /// True when the process belongs to the fleet but nothing is driving it
    /// any more, so it is only holding a port.
    public let isOrphan: Bool

    public var id: Int32 { pid }

    public init(pid: Int32, parentPID: Int32, name: String, command: String,
                workingDirectory: String? = nil, ports: [Int],
                isFleetProcess: Bool, isOrphan: Bool) {
        self.pid = pid
        self.parentPID = parentPID
        self.name = name
        self.command = command
        self.workingDirectory = workingDirectory
        self.ports = ports
        self.isFleetProcess = isFleetProcess
        self.isOrphan = isOrphan
    }

    /// A short description for the menu, with the PID and the port when there
    /// is one: `qdrant-proxy (PID 76463, port 6333)`.
    public var summary: String {
        let portText = ports.first.map { ", port \($0)" } ?? ""
        return "\(name) (PID \(pid)\(portText))"
    }
}

/// One TCP port that a fleet process is listening on.
public struct PortListener: Equatable, Identifiable, Sendable {
    public let port: Int
    /// The process holding the port, when the system could name it.
    public let pid: Int32?
    public let processName: String?

    public var id: Int { port }

    public init(port: Int, pid: Int32?, processName: String?) {
        self.port = port
        self.pid = pid
        self.processName = processName
    }

    /// A short description for the menu: `6333 — qdrant-proxy (PID 76463)`.
    public var summary: String {
        guard let pid, let processName else { return "\(port) — not held" }
        return "\(port) — \(processName) (PID \(pid))"
    }
}

/// Everything the Control app knows about the fleet's processes and ports.
public struct FleetProcessSnapshot: Equatable, Sendable {
    public let processes: [FleetProcess]
    public let listeners: [PortListener]

    public init(processes: [FleetProcess], listeners: [PortListener]) {
        self.processes = processes
        self.listeners = listeners
    }

    /// The fleet processes that nothing is driving any more.
    public var orphans: [FleetProcess] { processes.filter(\.isOrphan) }

    public static let empty = FleetProcessSnapshot(processes: [], listeners: [])
}

/// Why a process or port could not be changed.
public enum FleetProcessError: LocalizedError, Equatable {
    case refused(String)
    case notFound(String)

    public var errorDescription: String? {
        switch self {
        case .refused(let message): return message
        case .notFound(let message): return message
        }
    }
}

/// Works out which processes belong to the BotFleet fleet.
///
/// The rules are deliberately conservative.  A process counts as an orphan only
/// when the fleet is not driving it: a helper whose parent chain leads to
/// neither a BotFleet server nor pm2 was left behind by a fleet that has
/// stopped, and it is only holding a port.  A development server is never part
/// of the running fleet, so one running out of a BotFleet checkout is always
/// an orphan.
public enum FleetProcessClassifier {
    /// The helper processes the fleet runs, by name.
    public static let fleetHelperNames: Set<String> = [
        "qdrant-proxy",
        "connector-proxy",
        "agents-proxy",
        "cua-driver",
        "imessage-relay",
        "speech-helper",
        "recorder-helper",
        "botfleet-mcp",
    ]

    /// Markers that identify the BotFleet server itself.
    public static let fleetServerMarkers = [
        "botfleet-server",
        "BotFleet.app",
        "app.botfleet.server",
        "botfleet-companion",
    ]

    /// The path inside a checkout that the server is started from.
    ///
    /// The launcher runs it as a relative path, so the command line is
    /// `server/index.ts` with no repository in it.  The working directory is
    /// what says which checkout it is.
    public static let serverEntryMarker = "server/index"

    /// Markers that identify this app.
    public static let controlAppMarkers = [
        "BotFleet Control.app",
        "BotFleetControl",
    ]

    /// Markers that identify a process manager that owns a helper.
    public static let managerMarkers = [
        "PM2 v",
        "/pm2/",
        "pm2: ",
    ]

    /// Classifies the processes the system reported.
    ///
    /// - Parameters:
    ///   - processes: every running process, as `ps` reported it.
    ///   - portsByPID: the TCP ports each process is listening on.
    ///   - selfPID: this app's own PID, which is never a target.
    public static func classify(processes: [RawProcess],
                                portsByPID: [Int32: [Int]],
                                selfPID: Int32 = getpid()) -> [FleetProcess] {
        let byPID = Dictionary(processes.map { ($0.pid, $0) }, uniquingKeysWith: { first, _ in first })
        var fleet: [FleetProcess] = []
        for process in processes {
            // PID 1 is launchd and this app is not a target of itself.
            guard process.pid > 1, process.pid != selfPID else { continue }
            let name = helperName(in: process.command)
                ?? executableName(in: process.command, executablePath: process.executablePath)
            let ports = (portsByPID[process.pid] ?? []).sorted()
            let isFleet = isFleetProcess(command: process.command,
                                         name: name,
                                         workingDirectory: process.workingDirectory)
            var isOrphan = false
            if fleetHelperNames.contains(name) {
                // A helper the server or a process manager is driving is doing
                // its job.  One that is not was left behind and is only
                // holding a port.
                isOrphan = !hasFleetAncestor(pid: process.pid, byPID: byPID)
            } else if isDevelopmentServer(command: process.command,
                                          workingDirectory: process.workingDirectory) {
                // A development server is never part of the running fleet.
                isOrphan = true
            }
            fleet.append(FleetProcess(pid: process.pid,
                                      parentPID: process.parentPID,
                                      name: name,
                                      command: process.command,
                                      workingDirectory: process.workingDirectory,
                                      ports: ports,
                                      isFleetProcess: isFleet,
                                      isOrphan: isOrphan))
        }
        return fleet.sorted { ($0.name, $0.pid) < ($1.name, $1.pid) }
    }

    /// True when the command belongs to the fleet.
    public static func isFleetProcess(command: String, name: String, workingDirectory: String? = nil) -> Bool {
        if fleetHelperNames.contains(name) { return true }
        if isFleetServer(command: command, workingDirectory: workingDirectory) { return true }
        if isControlApp(command: command) { return true }
        if isDevelopmentServer(command: command, workingDirectory: workingDirectory) { return true }
        return false
    }

    /// True when the command is the BotFleet server.
    ///
    /// The launcher runs it from a relative path, so the command line alone
    /// cannot say which repository it is from.  The working directory can, and
    /// an absolute path in the command line can as well.
    public static func isFleetServer(command: String, workingDirectory: String? = nil) -> Bool {
        if fleetServerMarkers.contains(where: { command.contains($0) }) { return true }
        guard command.contains(serverEntryMarker) else { return false }
        if isFleetPath(workingDirectory) { return true }
        return isFleetPath(command)
    }

    /// True when the command is this app.
    public static func isControlApp(command: String) -> Bool {
        controlAppMarkers.contains(where: { command.contains($0) })
    }

    /// True when the path is inside a BotFleet checkout.
    ///
    /// The comparison is case-insensitive, because a checkout is a directory
    /// name and the case of it is the owner's choice.
    public static func isFleetPath(_ path: String?) -> Bool {
        guard let path, !path.isEmpty else { return false }
        let lower = path.lowercased()
        return lower.contains("/botfleet/") || lower.hasSuffix("/botfleet")
    }

    /// True when the command is a Vite development server.
    ///
    /// The name has to be the development server and not something else that
    /// starts with the same letters, so a test runner is never mistaken for
    /// one.
    public static func isViteProcess(command: String) -> Bool {
        let tokens = command.split(whereSeparator: { $0 == " " || $0 == "/" })
        return tokens.contains { token in
            let name = String(token)
            return name == "vite" || name.hasPrefix("vite.") || name.hasPrefix("vite-")
        }
    }

    /// True when the command is a development server out of a BotFleet checkout.
    ///
    /// A development server is never part of the running fleet, so it is an
    /// orphan even when a shell still holds it open.
    public static func isDevelopmentServer(command: String, workingDirectory: String? = nil) -> Bool {
        guard isViteProcess(command: command) else { return false }
        // The checkout's name is the owner's choice, so the bare token is
        // compared without regard to its case as well, and it has to stand on
        // its own the way the path check requires it, so a directory whose
        // name merely starts with the same letters is not a checkout.
        return isFleetPath(workingDirectory)
            || isFleetPath(command)
            || namesFleetCheckout(command)
    }

    /// True when the command names a BotFleet checkout as a whole token.
    ///
    /// A token is separated from the rest by whitespace or by one of the
    /// characters a path or an argument is built with, so a path or an
    /// argument that merely contains the same letters is not a checkout and
    /// must never be stopped as one.  A dash, a dot and an underscore stay
    /// inside a token, so a name that starts with the same letters is still
    /// one name and not a checkout.
    public static func namesFleetCheckout(_ command: String) -> Bool {
        command.lowercased()
            .components(separatedBy: CharacterSet.whitespacesAndNewlines
                .union(CharacterSet(charactersIn: " /:=\"'()[]{}")))
            .contains("botfleet")
    }

    /// The fleet helper name in the command, when there is one.
    ///
    /// The helper is usually a Node script, so the process name is `node` and
    /// only the script path says which helper it is.
    public static func helperName(in command: String) -> String? {
        let lower = command.lowercased()
        return fleetHelperNames.first { lower.contains($0) }
    }

    /// The executable's own name.
    ///
    /// The executable's path is used when the system named it, because an
    /// application path can hold a space and the command line is split on
    /// spaces.
    public static func executableName(in command: String, executablePath: String? = nil) -> String {
        if let executablePath, !executablePath.isEmpty {
            return URL(fileURLWithPath: executablePath).lastPathComponent
        }
        let first = command.split(separator: " ", maxSplits: 1).first.map(String.init) ?? command
        return URL(fileURLWithPath: first).lastPathComponent
    }

    /// True when the process is driven by the fleet or by a process manager.
    ///
    /// The chain is followed through the parent PIDs, so a helper that the
    /// server started, or that pm2 started, is managed even when the
    /// intermediate process is gone.
    private static func hasFleetAncestor(pid: Int32, byPID: [Int32: RawProcess]) -> Bool {
        var current = byPID[pid]?.parentPID
        var guard_ = 0
        while let parent = current, parent > 1, guard_ < 32 {
            guard_ += 1
            guard let row = byPID[parent] else { return false }
            if isFleetServer(command: row.command, workingDirectory: row.workingDirectory) { return true }
            if managerMarkers.contains(where: { row.command.contains($0) }) { return true }
            current = row.parentPID
        }
        return false
    }
}

/// Reads the fleet's processes and ports, and changes them when asked.
public struct FleetProcessMonitor {
    private let commands: CommandRunning
    private let selfPID: Int32

    public init(commands: CommandRunning = ProcessCommandRunner(), selfPID: Int32 = getpid()) {
        self.commands = commands
        self.selfPID = selfPID
    }

    /// Reads the fleet's processes and the ports they hold.
    ///
    /// Nothing is assumed: a process the system cannot name is left out rather
    /// than guessed at, and a port with no listener is left out too.
    public func snapshot() -> FleetProcessSnapshot {
        let raw = FleetProcessMonitor.parseProcesses((try? commands.run("/bin/ps", ["-axo", "pid=,ppid=,command="])) ?? "")
        let paths = FleetProcessMonitor.parseExecutablePaths((try? commands.run("/bin/ps", ["-axo", "pid=,comm="])) ?? "")
        let candidates = FleetProcessMonitor.candidatePIDs(in: raw)
        // With no candidates there is nobody to ask about, and `lsof` without
        // a process list would dump the working directory of every process on
        // the machine.  The common case is a machine with no fleet in it.
        //
        // The output is kept whatever `lsof` exits with.  It exits with 1
        // when it could not examine one of the processes it was asked about,
        // which happens whenever a process has gone away or belongs to
        // another user, and the answer for the ones it could examine is in
        // its output all the same.  Throwing that away left the menu with no
        // working directory at all, and a server that is started from a
        // relative path cannot be found without one.
        let directories: [Int32: String] = candidates.isEmpty ? [:] : FleetProcessMonitor.parseWorkingDirectories(
            commands.runKeepingOutput("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fn"] + candidates.map { "-p" + String($0) })
        )
        let withPaths = raw.map { process in
            RawProcess(pid: process.pid,
                       parentPID: process.parentPID,
                       command: process.command,
                       executablePath: paths[process.pid],
                       workingDirectory: directories[process.pid])
        }
        let lsofOutput = commands.runKeepingOutput("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])
        let listeners = FleetProcessMonitor.parseListeners(lsofOutput)
        var portsByPID: [Int32: [Int]] = [:]
        for listener in listeners {
            guard let pid = listener.pid else { continue }
            portsByPID[pid, default: []].append(listener.port)
        }
        let classified = FleetProcessClassifier.classify(processes: withPaths, portsByPID: portsByPID, selfPID: selfPID)
        // The menu is about the fleet and not about every process on the Mac.
        let fleet = classified.filter { $0.isFleetProcess }
        var fleetByPID: [Int32: FleetProcess] = [:]
        for process in fleet { fleetByPID[process.pid] = process }
        // Only the ports the fleet's own processes hold are listed.  A port
        // that something else on the Mac happens to use is not the fleet's,
        // and the app never offers to stop it.
        let known = listeners
            .filter { listener in
                guard let pid = listener.pid else { return false }
                return fleetByPID[pid] != nil
            }
            .sorted { $0.port < $1.port }
        return FleetProcessSnapshot(processes: fleet, listeners: known)
    }

    /// Stops one process.
    ///
    /// PID 1 and this app's own PID are refused: killing either would take
    /// down something the owner did not ask to stop.
    public func terminate(pid: Int32) throws {
        guard pid > 1 else { throw FleetProcessError.refused("That process cannot be stopped.") }
        guard pid != selfPID else { throw FleetProcessError.refused("BotFleet Control cannot stop itself.") }
        do {
            _ = try commands.run("/bin/kill", ["-9", String(pid)])
        } catch let error as CommandExitError {
            throw FleetProcessError.refused(error.output.isEmpty
                ? "The system refused to stop PID \(pid)."
                : error.output)
        }
    }

    /// Stops whatever is holding a port.
    ///
    /// The holder has to be one of the fleet's own processes, and it is
    /// checked again here, because the port may have been taken over by
    /// something else since the menu was drawn.
    ///
    /// - Returns: the PID that was stopped.
    @discardableResult
    public func freePort(_ port: Int) throws -> Int32 {
        let snapshot = snapshot()
        guard let listener = snapshot.listeners.first(where: { $0.port == port }),
              let pid = listener.pid else {
            throw FleetProcessError.notFound("Nothing is holding port \(port).")
        }
        guard snapshot.processes.contains(where: { $0.pid == pid }) else {
            throw FleetProcessError.refused("Port \(port) is not held by a BotFleet process.")
        }
        try terminate(pid: pid)
        return pid
    }

    /// The processes whose working directory is worth reading.
    ///
    /// The fleet's helpers, the server and the development servers are the
    /// ones whose working directory says what they are, and their parents are
    /// included because the server is what drives a helper.
    public static func candidatePIDs(in processes: [RawProcess]) -> [Int32] {
        let byPID = Dictionary(processes.map { ($0.pid, $0) }, uniquingKeysWith: { first, _ in first })
        var candidates = Set<Int32>()
        for process in processes {
            let name = FleetProcessClassifier.helperName(in: process.command)
                ?? FleetProcessClassifier.executableName(in: process.command)
            let looksLikeFleet = FleetProcessClassifier.fleetHelperNames.contains(name)
                || process.command.contains(FleetProcessClassifier.serverEntryMarker)
                || FleetProcessClassifier.isViteProcess(command: process.command)
                || FleetProcessClassifier.isControlApp(command: process.command)
                || FleetProcessClassifier.isFleetPath(process.command)
            guard looksLikeFleet else { continue }
            candidates.insert(process.pid)
            // Walk up to the parent that could be driving it.
            var current: Int32? = process.parentPID
            var depth = 0
            while let parent = current, parent > 1, depth < 4, let row = byPID[parent] {
                candidates.insert(parent)
                current = row.parentPID
                depth += 1
            }
        }
        return candidates.sorted()
    }

    /// Parses the `ps` listing into raw processes.
    public static func parseProcesses(_ output: String) -> [RawProcess] {
        var rows: [RawProcess] = []
        for line in output.split(separator: "\n") {
            // The listing is padded, so the leading space has to go before the
            // fields are read.
            let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
            let fields = trimmed.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true).map(String.init)
            guard fields.count >= 3, let pid = Int32(fields[0]), let parent = Int32(fields[1]) else { continue }
            let command = fields[2]
            guard !command.isEmpty else { continue }
            rows.append(RawProcess(pid: pid, parentPID: parent, command: command))
        }
        return rows
    }

    /// Parses the `ps` listing of executable paths into a PID lookup.
    public static func parseExecutablePaths(_ output: String) -> [Int32: String] {
        var paths: [Int32: String] = [:]
        for line in output.split(separator: "\n") {
            let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
            let fields = trimmed.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true).map(String.init)
            guard fields.count >= 2, let pid = Int32(fields[0]) else { continue }
            // The path is the rest of the line, and the listing pads it.
            paths[pid] = fields[1].trimmingCharacters(in: .whitespaces)
        }
        return paths
    }

    /// Parses the `lsof` working directory listing into a PID lookup.
    public static func parseWorkingDirectories(_ output: String) -> [Int32: String] {
        var directories: [Int32: String] = [:]
        var pid: Int32?
        for line in output.split(separator: "\n") {
            guard let field = line.first else { continue }
            let value = String(line.dropFirst())
            switch field {
            case "p": pid = Int32(value)
            case "n":
                if let pid {
                    directories[pid] = value
                }
            default: break
            }
        }
        return directories
    }

    /// Parses the `lsof` field output into port listeners.
    public static func parseListeners(_ output: String) -> [PortListener] {
        var pid: Int32?
        var name: String?
        var listeners: [PortListener] = []
        for line in output.split(separator: "\n") {
            guard let field = line.first else { continue }
            let value = String(line.dropFirst())
            switch field {
            case "p":
                pid = Int32(value)
                // A new process starts without a name, so the previous one's
                // name is never carried over to it.
                name = nil
            case "c": name = value
            case "n":
                if let port = portNumber(from: value), let pid {
                    listeners.append(PortListener(port: port, pid: pid, processName: name))
                }
            default: break
            }
        }
        return listeners.sorted { $0.port < $1.port }
    }

    /// The port in a `lsof` name such as `*:6333` or `127.0.0.1:8799`.
    public static func portNumber(from name: String) -> Int? {
        guard let colon = name.lastIndex(of: ":") else { return nil }
        return Int(name[name.index(after: colon)...])
    }
}
