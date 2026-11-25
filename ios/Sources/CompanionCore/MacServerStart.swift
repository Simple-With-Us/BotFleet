import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// What one system command printed and how it ended.
public struct MacCommandOutcome: Equatable, Sendable {
    public let output: String
    public let status: Int32
    /// What the command printed on its error stream.  launchctl explains a
    /// refusal there, so a caller can tell "no such service" from a request
    /// launchd could not answer.
    public let errorOutput: String
    /// False when the reply was cut off at the byte bound.  A command that did
    /// not finish inside its time bound is reported as nil instead, because
    /// nothing it printed by then is a whole answer.
    public let complete: Bool

    public init(output: String, status: Int32 = 0, errorOutput: String = "", complete: Bool = true) {
        self.output = output
        self.status = status
        self.errorOutput = errorOutput
        self.complete = complete
    }

    /// True when the command finished and exited zero.
    public var succeeded: Bool { complete && status == 0 }
}

/// Runs one fixed system command.
///
/// The app's runner speaks to `/bin/launchctl` and to nothing else, so no
/// caller can talk it into running anything else.  A test records what it was
/// asked and scripts the answers.
public protocol MacCommandRunning: Sendable {
    /// Nil when the runner cannot run the command at all, which reads as
    /// launchd not having been asked.
    func run(executable: String, arguments: [String]) async -> MacCommandOutcome?
}

/// Runs `/bin/launchctl`, bounded in time and in how much it will read.
public struct MacLaunchctlRunner: MacCommandRunning {
    public static let executable = "/bin/launchctl"
    /// launchctl answers in well under a second.  Fifteen is the bound the
    /// BotFleet Control runner used, and long enough that a busy Mac is not
    /// read as a refusal.
    public static let timeout: TimeInterval = 15
    /// `launchctl list` on a loaded Mac is a few kilobytes.  A reply past this
    /// is cut off and reported as incomplete rather than read as whole.
    public static let maximumOutputBytes = 1_048_576

    public init() {}

    public func run(executable: String, arguments: [String]) async -> MacCommandOutcome? {
        #if os(macOS)
        guard executable == Self.executable else { return nil }
        return await withCheckedContinuation { (continuation: CheckedContinuation<MacCommandOutcome?, Never>) in
            let process = Process(), output = Pipe(), errorOutput = Pipe()
            let capture = MacLaunchctlCapture(continuation: continuation)
            process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments
            process.standardInput = FileHandle.nullDevice; process.standardOutput = output; process.standardError = errorOutput
            output.fileHandleForReading.readabilityHandler = { handle in capture.append(handle.availableData) }
            errorOutput.fileHandleForReading.readabilityHandler = { handle in capture.appendError(handle.availableData) }
            let deadline = DispatchWorkItem {
                capture.markIncomplete()
                if process.isRunning { process.terminate() }
                capture.finish(status: nil)
            }
            //  A launchctl that ignores the termination is killed two seconds
            //  later, the bound the BotFleet Control runner allowed.
            let lastResort = DispatchWorkItem { if process.isRunning { _ = kill(process.processIdentifier, SIGKILL) } }
            process.terminationHandler = { stopped in
                deadline.cancel()
                lastResort.cancel()
                output.fileHandleForReading.readabilityHandler = nil; errorOutput.fileHandleForReading.readabilityHandler = nil
                capture.append(output.fileHandleForReading.readDataToEndOfFile())
                capture.appendError(errorOutput.fileHandleForReading.readDataToEndOfFile())
                capture.finish(status: stopped.terminationStatus)
            }
            do {
                try process.run()
                DispatchQueue.global().asyncAfter(deadline: .now() + Self.timeout, execute: deadline)
                DispatchQueue.global().asyncAfter(deadline: .now() + Self.timeout + 2, execute: lastResort)
            } catch {
                output.fileHandleForReading.readabilityHandler = nil; errorOutput.fileHandleForReading.readabilityHandler = nil
                capture.finish(status: nil)
            }
        }
        #else
        return nil
        #endif
    }
}

#if os(macOS)
/// Collects one command's output from the pipes launchd's tool writes to.
///
/// The pipes are read from the queue, so a reply that fills its pipe cannot
/// block the command this is waiting on.  Everything is behind one lock,
/// because the readers, the deadline and the exit all arrive on their own.
private final class MacLaunchctlCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var output = Data()
    private var errors = Data()
    private var complete = true
    private var continuation: CheckedContinuation<MacCommandOutcome?, Never>?

    init(continuation: CheckedContinuation<MacCommandOutcome?, Never>) { self.continuation = continuation }

    func append(_ bytes: Data) {
        lock.lock(); defer { lock.unlock() }
        guard output.count + bytes.count <= MacLaunchctlRunner.maximumOutputBytes else { complete = false; return }
        output.append(bytes)
    }

    func appendError(_ bytes: Data) {
        lock.lock(); defer { lock.unlock() }
        guard errors.count + bytes.count <= MacLaunchctlRunner.maximumOutputBytes else { complete = false; return }
        errors.append(bytes)
    }

    func markIncomplete() { lock.lock(); defer { lock.unlock() }; complete = false }

    func finish(status: Int32?) {
        lock.lock()
        let callback = continuation
        continuation = nil
        var result: MacCommandOutcome?
        if let status = status {
            result = MacCommandOutcome(
                output: String(decoding: output, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines),
                status: status,
                errorOutput: String(decoding: errors, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines),
                complete: complete
            )
        }
        lock.unlock()
        callback?.resume(returning: result)
    }
}
#endif

/// The state of the installed `app.botfleet.server` LaunchAgent.
public enum MacInstalledServerState: Equatable, Sendable {
    /// Its plist is not in `~/Library/LaunchAgents`.
    case notInstalled
    /// Loaded with no live process behind the label, or not loaded at all.
    /// The wrapper's tick is what starts it, so either way it is stopped.
    case stopped
    /// A live process is behind the label.
    case running
    /// launchd could not be asked, which says nothing either way.
    case unknown

    /// The state one `launchctl list` output states for a label.
    ///
    /// The listing has `PID`, `Status` and `Label` columns.  The row whose
    /// last column is the label carries a process id when the job is running
    /// and a dash when it is loaded without one.  No row means the job is not
    /// loaded, which is stopped as well:  a start loads it.
    public static func state(fromListing listing: String, label: String) -> MacInstalledServerState {
        for line in listing.split(separator: "\n").prefix(4_096) {
            let columns = line.split(whereSeparator: \.isWhitespace)
            guard let last = columns.last, String(last) == label, let first = columns.first else { continue }
            return UInt32(first) == nil ? .stopped : .running
        }
        return .stopped
    }
}

/// What the control route's last read proved about whether the server is up.
public enum MacServerPresence: Equatable, Sendable {
    /// The route answered.
    case answering
    /// The connection was refused.  Of every way a read can fail, this is the
    /// one that proves nothing is listening.
    case refused
    /// The route has not been read, timed out, or answered something that
    /// could not be read.  None of that says whether the server is up.
    case unknown

    /// The presence a status read leaves behind:  the error it ended with, or
    /// the status when the read had none, or neither before the first read.
    ///
    /// The error is read first, and on purpose.  A failed read keeps the last
    /// known status in place so the section can show it beside the reason, so
    /// a stale status beside a refused connection is a server that answered
    /// earlier and has stopped since —  which is exactly the case the start
    /// control exists for.  An error that is not a refusal, an older server or
    /// a foreign service, says only that something answered.
    public static func after(status: MacControlStatus?, error: MacControlStatusError?) -> MacServerPresence {
        if let error = error { return error == .notReachable ? .refused : .unknown }
        return status == nil ? .unknown : .answering
    }
}

/// How a finished start attempt ended.
public enum MacServerStartOutcome: Equatable, Sendable {
    /// A process was still behind the label when the wait ended.
    case started
    /// launchd took the request and no process stayed behind the label.
    /// `restoredStop` is true when a deliberate stop was put back for it.
    case didNotStart(restoredStop: Bool)
    /// launchd could not be asked afterwards, so nothing can be said, and the
    /// deliberate stop stays lifted.
    case stateUnknown

    /// The one sentence the surface shows for it.
    public var message: String {
        let gap = "\u{00A0} "
        switch self {
        case .started:
            return "Started the BotFleet Server.\(gap)It answers on the next status read."
        case .didNotStart(restoredStop: true):
            return "The BotFleet Server did not stay running, so the earlier stop is back in place.\(gap)Check the server log, then try again."
        case .didNotStart(restoredStop: false):
            return "The BotFleet Server did not stay running.\(gap)Check the server log, then try again."
        case .stateUnknown:
            return "The BotFleet Server was asked to start, but this Mac could not say whether it is running.\(gap)Open this section again to re-check."
        }
    }
}

/// What a deliberate start did to the deliberate-stop marker.
///
/// The marker is how a stop survives logins and the wrapper's tick, so a
/// start clears it and remembers the bytes it had.  A start that then does
/// not bring the server up puts them back:  it must not lift a stop the
/// owner asked for and leave the server down.
public final class MacDeliberateStop {
    private let marker: URL
    private let contents: Data?
    private let files: FileManager

    /// True when the server had been stopped on purpose before this start.
    public var wasStoppedByOwner: Bool { contents != nil }

    fileprivate init(marker: URL, contents: Data?, files: FileManager) {
        self.marker = marker
        self.contents = contents
        self.files = files
    }

    /// Puts the marker back with the bytes it had, when it was there.
    public func restore() {
        guard let contents = contents else { return }
        try? files.createDirectory(at: marker.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? contents.write(to: marker, options: .atomic)
    }
}

/// Starts the installed harness LaunchAgent the way BotFleet Control did.
///
/// The app cannot start the harness itself:  the installed wrapper owns that,
/// under launchd.  So a start asks launchd for the `app.botfleet.server` job
/// and for nothing else, in the order Control used.  Each step is there for a
/// reason the wrapper's own contract states.
///
/// 1. The wrapper must honour the startup policy.  One from before the policy
///    existed ignores the session a start records, so it is refused.
/// 2. The LaunchAgent must be installed.
/// 3. The deliberate-stop marker is read safely, and its bytes are kept.
/// 4. The boot session is recorded, the marker is cleared, and the job is
///    enabled, loaded when it is not loaded, and kickstarted.
///
/// A kickstart that exits zero proves only that launchd took the request.  So
/// `startServerAndSettle` then watches the job, and a start that leaves no
/// process behind the label puts the deliberate stop back as it was.
///
/// The session file is the other half of a start, and it is what makes the
/// start work at all under a "do not start at login" policy.  launchd runs the
/// wrapper for a kickstart like any other tick, and the wrapper leaves a
/// disabled policy alone unless the recorded session is this boot.  The start
/// records it first, so the wrapper sees a choice made in this boot.
///
/// Nothing here changes live configuration beyond that one job, installs
/// anything, or asks for a privilege:  the job is the user's own, and a Mac
/// where launchd refuses says so through `MacServerStartError`.
public final class MacServerLaunchController: @unchecked Sendable {
    /// Control settled for eight looks a quarter of a second apart.  That is
    /// long enough to tell a job that stays from one the wrapper leaves
    /// within milliseconds, and too short to sit through a hang.  The process
    /// appears behind the label as soon as launchd spawns the job, so the
    /// status read that follows is what waits for the harness itself.
    public static let settleAttempts = 8
    public static let settleInterval: TimeInterval = 0.25
    /// The largest deliberate-stop marker that is read rather than refused.
    public static let maximumStopMarkerBytes = 64 * 1024
    /// How much of launchctl's own explanation is shown.  The rest of a long
    /// one is not a sentence anyone can act on.
    public static let maximumExplanationLength = 280

    public let store: MacStartupPolicyStore
    private let commands: any MacCommandRunning
    private let uid: UInt32
    private let bootSession: () throws -> String
    private let pause: (TimeInterval) async -> Void
    private let launchctl: String
    private let files: FileManager

    /// `bootSession` is read when a start begins, never at creation:  the
    /// wrapper compares it with the session a choice was made in.
    public init(
        store: MacStartupPolicyStore,
        commands: any MacCommandRunning = MacLaunchctlRunner(),
        uid: UInt32 = getuid(),
        launchctl: String = MacLaunchctlRunner.executable,
        files: FileManager = .default,
        bootSession: @escaping () throws -> String,
        pause: @escaping (TimeInterval) async -> Void = { seconds in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        }
    ) {
        self.store = store
        self.commands = commands
        self.uid = uid
        self.launchctl = launchctl
        self.files = files
        self.bootSession = bootSession
        self.pause = pause
    }

    // MARK: - Reading The Job

    /// The state of the server's LaunchAgent, asked of launchd.
    public func installedServerState() async -> MacInstalledServerState {
        let label = MacStartupPolicyStore.serverAgentLabel
        guard files.fileExists(atPath: store.launchAgentPlist(label: label).path) else { return .notInstalled }
        guard let listing = await commands.run(executable: launchctl, arguments: ["list"]), listing.succeeded else {
            return .unknown
        }
        return MacInstalledServerState.state(fromListing: listing.output, label: label)
    }

    // MARK: - Whether To Offer The Start

    /// Whether the Start Server control may be used, and when it may not, the
    /// one sentence that says why.
    ///
    /// The offer needs three facts that agree:  the wrapper can be started
    /// through the policy, nothing answered on the harness port, and the job
    /// is installed without a live process behind it.  The third is what
    /// keeps a hung server from being offered a start:  it refuses the
    /// connection too, but launchd still shows its process (BF-2527).  A
    /// server older than the control routes answered, so it is running, and
    /// an unread route says nothing.
    public static func startRefusal(
        policySupported: Bool,
        presence: MacServerPresence,
        installedState: MacInstalledServerState?
    ) -> String? {
        let gap = "\u{00A0} "
        guard policySupported else { return MacStartupPolicyError.updateRequired.localizedDescription }
        guard let installedState = installedState else {
            return "This Mac has not said whether the BotFleet Server is installed yet.\(gap)Open this section again to re-check."
        }
        if installedState == .notInstalled { return MacServerStartError.launchAgentMissing.localizedDescription }
        if presence == .answering { return "The BotFleet Server is already running." }
        if installedState == .running {
            return "The BotFleet Server is running but not answering.\(gap)Wait a moment, then refresh."
        }
        if presence == .unknown {
            return "The BotFleet Server has not answered yet.\(gap)Wait a moment, then refresh."
        }
        if installedState == .unknown {
            return "This Mac could not say whether the BotFleet Server is running.\(gap)Open this section again to re-check."
        }
        return nil
    }

    // MARK: - Starting

    /// Starts the BotFleet Server and waits to see whether it came up.
    @discardableResult
    public func startServerAndSettle(
        attempts: Int = MacServerLaunchController.settleAttempts,
        interval: TimeInterval = MacServerLaunchController.settleInterval
    ) async throws -> MacServerStartOutcome {
        let deliberateStop = try await startServer()
        let observed = await settle(attempts: attempts, interval: interval)
        if observed == .running { return .started }
        if observed == .unknown { return .stateUnknown }
        deliberateStop.restore()
        return .didNotStart(restoredStop: deliberateStop.wasStoppedByOwner)
    }

    /// Starts the BotFleet Server and does not wait to see whether it came up.
    ///
    /// The returned handle puts back a deliberate stop this start cleared.
    /// A caller that does not watch the result should use
    /// `startServerAndSettle`, or the stop is lifted for a server that may
    /// still be down.
    @discardableResult
    public func startServer() async throws -> MacDeliberateStop {
        guard store.supportsPolicy() else { throw MacServerStartError.updateRequired }
        let marker = store.stoppedMarker()
        let plist = store.launchAgentPlist(label: MacStartupPolicyStore.serverAgentLabel)
        guard files.fileExists(atPath: plist.path) else { throw MacServerStartError.launchAgentMissing }
        let markerContents = try readStopMarker(at: marker)
        let boot = try recordedBootSession()
        try store.recordBootSession(boot)
        if markerContents != nil { try files.removeItem(at: marker) }
        let deliberateStop = MacDeliberateStop(marker: marker, contents: markerContents, files: files)
        do {
            try await startAgent(plist: plist)
        } catch {
            deliberateStop.restore()
            throw error
        }
        return deliberateStop
    }

    /// Enables the job, loads it when launchd has not loaded it, and starts it.
    ///
    /// A kickstart does not replace a running instance, so this leaves a job
    /// that is already up alone.  `print` is the question "is it loaded":
    /// launchd refuses it for a job it does not know, and that refusal is the
    /// signal to bootstrap.
    private func startAgent(plist: URL) async throws {
        let label = MacStartupPolicyStore.serverAgentLabel
        let domain = "gui/\(uid)"
        let service = "\(domain)/\(label)"
        try await launchctl(["enable", service], operation: "enable")
        let loaded = await commands.run(executable: launchctl, arguments: ["print", service])
        if loaded?.succeeded != true {
            try await launchctl(["bootstrap", domain, plist.path], operation: "load")
        }
        try await launchctl(["kickstart", service], operation: "start")
    }

    /// Runs one launchctl request, and turns a refusal into the reason for it.
    private func launchctl(_ arguments: [String], operation: String) async throws {
        guard let outcome = await commands.run(executable: launchctl, arguments: arguments) else {
            throw MacServerStartError.launchdNotAsked(operation: operation)
        }
        guard outcome.succeeded else {
            throw MacServerStartError.launchdRefused(operation: operation, detail: outcome.errorOutput)
        }
    }

    /// Watches the job for the whole window, and reports what was seen last.
    ///
    /// The window is always watched to its end, and nothing ends it early.  A
    /// job launchd spawned and then left on purpose shows a process for a
    /// moment first:  the wrapper leaves quietly, within milliseconds, when
    /// its policy or the stop marker says no.  A process seen once proves
    /// that launchd spawned something, and a process still there when the
    /// window ends is what a start means.
    private func settle(attempts: Int, interval: TimeInterval) async -> MacInstalledServerState {
        // A negative or an enormous pause would trap the conversion to
        // nanoseconds, and a count of zero would look no further.
        let looks = min(max(attempts, 1), 64)
        let step = interval.isFinite ? min(max(interval, 0), 60) : 0
        var observed = MacInstalledServerState.unknown
        for look in 0 ..< looks {
            if look > 0 { await pause(step) }
            observed = await installedServerState()
        }
        return observed
    }

    // MARK: - The Boot Session

    /// The boot session a start is recorded in, or the one refusal for every
    /// way it can be unusable.
    ///
    /// The wrapper compares the recorded session with the boot it is running
    /// in byte for byte, so the value has to be the boot session exactly:
    /// trimmed, and a UUID.  A reader that fails, answers whitespace, or
    /// answers anything else is one refusal, and it is this controller's own
    /// error rather than the reader's.  The case of the value is kept, because
    /// the wrapper does not fold case and a changed one never matches.
    private func recordedBootSession() throws -> String {
        let boot: String
        do {
            boot = try bootSession().trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            throw MacServerStartError.bootSessionUnavailable
        }
        guard UUID(uuidString: boot) != nil else { throw MacServerStartError.bootSessionUnavailable }
        return boot
    }

    // MARK: - The Deliberate-Stop Marker

    /// The marker's exact bytes, or nil when the server was not stopped on purpose.
    ///
    /// The bytes are kept because they go back unchanged.  The file is small,
    /// so anything larger, anything that is not a plain file, and anything
    /// reached through a link is refused rather than read:  a marker this app
    /// cannot understand is one it must not clear.
    private func readStopMarker(at url: URL) throws -> Data? {
        var listed = stat()
        if lstat(url.path, &listed) != 0 {
            if errno == ENOENT { return nil }
            throw MacServerStartError.stopMarkerUnreadable
        }
        let largest = Int64(MacServerLaunchController.maximumStopMarkerBytes)
        guard listed.st_mode & S_IFMT == S_IFREG, listed.st_size >= 0, listed.st_size <= largest else {
            throw MacServerStartError.stopMarkerUnreadable
        }
        let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard descriptor >= 0 else { throw MacServerStartError.stopMarkerUnreadable }
        defer { close(descriptor) }
        var opened = stat()
        guard fstat(descriptor, &opened) == 0, opened.st_mode & S_IFMT == S_IFREG,
              opened.st_size >= 0, opened.st_size <= largest else {
            throw MacServerStartError.stopMarkerUnreadable
        }
        var contents = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while true {
            let count = buffer.withUnsafeMutableBytes { raw in read(descriptor, raw.baseAddress, raw.count) }
            guard count >= 0, contents.count + count <= MacServerLaunchController.maximumStopMarkerBytes else {
                throw MacServerStartError.stopMarkerUnreadable
            }
            if count == 0 { return contents }
            contents.append(contentsOf: buffer.prefix(count))
        }
    }
}

/// Why a start was refused, or why launchd did not do it.
public enum MacServerStartError: LocalizedError, Equatable, Sendable {
    /// The installed wrapper predates the startup policy and would ignore the
    /// session a start records.
    case updateRequired
    /// The `app.botfleet.server` LaunchAgent is not installed.
    case launchAgentMissing
    /// The boot session could not be read, so the start cannot be recorded as
    /// a deliberate one.
    case bootSessionUnavailable
    /// The server was stopped on purpose and that marker could not be read
    /// safely, so it was left in place and nothing was started.
    case stopMarkerUnreadable
    /// launchctl was run and refused.  Its own explanation is the detail.
    case launchdRefused(operation: String, detail: String)
    /// launchctl could not be run or did not finish, so launchd was not asked.
    case launchdNotAsked(operation: String)

    /// launchctl's explanation, made one line and kept short enough to read.
    static func explanation(from detail: String) -> String {
        let words = detail.split(whereSeparator: \.isWhitespaceAndNewlines)
        var text = words.joined(separator: " ")
        if text.count > MacServerLaunchController.maximumExplanationLength {
            text = String(text.prefix(MacServerLaunchController.maximumExplanationLength)) + "…"
        }
        return text
    }

    public var errorDescription: String? {
        let gap = "\u{00A0} "
        switch self {
        case .updateRequired:
            return MacStartupPolicyError.updateRequired.localizedDescription
        case .launchAgentMissing:
            return "The BotFleet Server LaunchAgent is not installed.\(gap)Reinstall BotFleet."
        case .bootSessionUnavailable:
            return "The boot session could not be read, so the start cannot be recorded as a deliberate one."
        case .stopMarkerUnreadable:
            return "The server was stopped on purpose, and that stop could not be read safely, so it was left in place."
        case .launchdRefused(let operation, let detail):
            let reason = MacServerStartError.explanation(from: detail)
            guard !reason.isEmpty else {
                return "macOS could not \(operation) the BotFleet Server LaunchAgent.\(gap)Check its installation."
            }
            return "macOS could not \(operation) the BotFleet Server LaunchAgent.\(gap)\(reason)"
        case .launchdNotAsked(let operation):
            return "macOS could not be asked to \(operation) the BotFleet Server LaunchAgent.\(gap)Try again."
        }
    }
}
