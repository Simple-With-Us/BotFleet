import Foundation

/// Whether the harness's LaunchAgent starts the server at login.
///
/// The three states are the wrapper's own:  a `startup-enabled.marker` means
/// start, a `startup-disabled.marker` means do not, and neither file means
/// the policy has never been touched, so the wrapper keeps the launchd
/// behaviour the install originally had.  The disabled file wins when both
/// are present, because the wrapper checks it first.
public enum MacServerLoginPolicy: String, Codable, Equatable, Sendable {
    /// No marker either way:  the policy was never set, and the wrapper's
    /// default (start, and restart on a crashed port) stands.
    case legacy
    case enabled
    case disabled

    /// Whether the server starts at login, as the Settings toggle shows it.
    ///
    /// The legacy state starts the server too — that is what the install
    /// always did — so the toggle reads on, with the "set explicitly" part
    /// carried by `isExplicit`.
    public var startsAtLogin: Bool { self != .disabled }

    /// Whether the choice is written down, or inherited from the install.
    public var isExplicit: Bool { self != .legacy }
}

/// Reads and writes the harness startup policy markers in the data directory.
///
/// These are the same files `scripts/botfleet-server-start.sh` honours
/// (`BF_CONTROL_STARTUP_POLICY_V1`) and the same ones the BotFleet Control
/// menu bar wrote, so the two surfaces agree by construction:  a toggle here
/// is a toggle there.  The wrapper honours the policy only when the installed
/// wrapper carries the V1 marker string, which `supportsPolicy` checks, and
/// an app whose wrapper predates it must say so instead of writing files the
/// wrapper would ignore.
///
/// Marker files are empty, exactly as Control wrote them; the session file
/// records the boot session the choice was made in, which is what lets the
/// wrapper tell "the operator chose this" from "the machine rebooted into the
/// default".
public final class MacStartupPolicyStore: @unchecked Sendable {
    public static let enabledMarkerFileName = "startup-enabled.marker"
    public static let disabledMarkerFileName = "startup-disabled.marker"
    public static let sessionFileName = "startup-session"
    /// The string the wrapper must contain before it will honour the markers.
    public static let wrapperPolicyMarker = "BF_CONTROL_STARTUP_POLICY_V1"
    /// The LaunchAgent label the wrapper supervises.
    public static let serverAgentLabel = "app.botfleet.server"

    public let dataDir: URL
    public let wrapper: URL
    private let files: FileManager

    /// The current user's home directory.
    ///
    /// `FileManager.homeDirectoryForCurrentUser` is unavailable on iOS and
    /// `CompanionCore` is built for both platforms, so the lookup is guarded.
    public static var defaultHomeDirectory: URL {
        #if os(macOS)
        return FileManager.default.homeDirectoryForCurrentUser
        #else
        return URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
        #endif
    }

    public init(
        dataDir: URL? = nil,
        home: URL = MacStartupPolicyStore.defaultHomeDirectory,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        wrapper: URL? = nil,
        files: FileManager = .default
    ) {
        if let explicit = dataDir {
            self.dataDir = explicit
        } else if let value = environment["OMB_DATA_DIR"], !value.isEmpty, value.hasPrefix("/") {
            self.dataDir = URL(fileURLWithPath: value, isDirectory: true)
        } else {
            self.dataDir = home.appendingPathComponent(".botfleet", isDirectory: true)
        }
        // The launchd plist runs the wrapper from an absolute path, and the
        // install that ships it puts it beside the other fleet helpers in the
        // home's apps folder.  A relocated wrapper is given explicitly.
        self.wrapper = wrapper ?? home.appendingPathComponent("apps/botfleet-server-start.sh", isDirectory: false)
        self.files = files
    }

    // MARK: - Locations

    public func enabledMarker(dataDir: URL? = nil) -> URL {
        (dataDir ?? self.dataDir).appendingPathComponent(Self.enabledMarkerFileName)
    }

    public func disabledMarker(dataDir: URL? = nil) -> URL {
        (dataDir ?? self.dataDir).appendingPathComponent(Self.disabledMarkerFileName)
    }

    public func sessionFile(dataDir: URL? = nil) -> URL {
        (dataDir ?? self.dataDir).appendingPathComponent(Self.sessionFileName)
    }

    public func stoppedMarker(dataDir: URL? = nil) -> URL {
        (dataDir ?? self.dataDir).appendingPathComponent("stopped.marker")
    }

    // MARK: - Reading

    /// The policy as the markers state it, with the disabled file winning.
    public func loginPolicy(dataDir: URL? = nil) -> MacServerLoginPolicy {
        let targetDir = dataDir ?? self.dataDir
        if files.fileExists(atPath: disabledMarker(dataDir: targetDir).path) { return .disabled }
        if files.fileExists(atPath: enabledMarker(dataDir: targetDir).path) { return .enabled }
        return .legacy
    }

    public static func loginPolicy(dataDir: URL) -> MacServerLoginPolicy {
        MacStartupPolicyStore(dataDir: dataDir).loginPolicy(dataDir: dataDir)
    }

    /// Whether the installed wrapper honours the policy markers at all.
    ///
    /// An app facing a wrapper from before the policy existed must refuse the
    /// toggle:  writing the markers there would change nothing, and the
    /// Settings row would lie about a server that starts regardless.
    public func supportsPolicy() -> Bool {
        guard let data = try? Data(contentsOf: wrapper),
              let source = String(data: data, encoding: .utf8) else { return false }
        return source.contains(Self.wrapperPolicyMarker)
    }

    /// Whether the wrapper honours the policy markers for this data directory.
    public static func supportsPolicy(wrapper: URL) -> Bool {
        MacStartupPolicyStore(wrapper: wrapper).supportsPolicy()
    }

    // MARK: - Writing

    /// Sets the startup policy to start or not start at login.
    ///
    /// Writes the boot session first, then the chosen marker, and removes the
    /// opposite marker — the same order Control used, so a reader can never
    /// see a session file from one choice beside a marker from another.
    ///
    /// The launchd state itself is not touched here:  the wrapper's five
    /// minute tick applies the policy, and a running server keeps running
    /// until something stops it, which is what the status section shows.
    public func setStartsAtLogin(_ enabled: Bool, bootSession: String, dataDir: URL? = nil) throws {
        let targetDir = dataDir ?? self.dataDir
        guard !bootSession.isEmpty else {
            throw MacStartupPolicyError.bootSessionUnavailable
        }
        try files.createDirectory(at: targetDir, withIntermediateDirectories: true)
        try writeSessionFile(bootSession, dataDir: targetDir)
        let enabledURL = enabledMarker(dataDir: targetDir)
        let disabledURL = disabledMarker(dataDir: targetDir)
        let chosen = enabled ? enabledURL : disabledURL
        let other = enabled ? disabledURL : enabledURL
        try writeEmptyMarker(chosen)
        if files.fileExists(atPath: other.path) {
            try files.removeItem(at: other)
        }
        guard loginPolicy(dataDir: targetDir) == (enabled ? .enabled : .disabled) else {
            throw MacStartupPolicyError.policyWriteFailed
        }
    }

    public static func setStartsAtLogin(
        _ enabled: Bool,
        bootSession: String,
        dataDir: URL
    ) throws {
        try MacStartupPolicyStore(dataDir: dataDir)
            .setStartsAtLogin(enabled, bootSession: bootSession, dataDir: dataDir)
    }

    /// Returns the policy to its install default by removing both markers.
    ///
    /// The session file stays:  it records a choice that was made, and the
    /// wrapper only compares it when a marker is present.
    public func clearPolicy(dataDir: URL? = nil) throws {
        let targetDir = dataDir ?? self.dataDir
        for url in [enabledMarker(dataDir: targetDir), disabledMarker(dataDir: targetDir)] {
            if files.fileExists(atPath: url.path) {
                try files.removeItem(at: url)
            }
        }
        guard loginPolicy(dataDir: targetDir) == .legacy else {
            throw MacStartupPolicyError.policyWriteFailed
        }
    }

    // MARK: - Boot Session

    /// The boot session the wrapper compares the recorded choice against.
    ///
    /// Read the same way the wrapper reads it — `/usr/sbin/sysctl -n` — and
    /// kept verbatim, because the wrapper compares the strings byte for byte
    /// and a case change would make every recorded choice look stale.  The
    /// value must parse as a UUID or nothing is recorded.
    #if os(macOS)
    public func readBootSession() throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/sysctl")
        process.arguments = ["-n", "kern.bootsessionuuid"]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = Pipe()
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0,
              let value = String(data: data, encoding: .utf8)?
                  .trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty,
              UUID(uuidString: value) != nil else {
            throw MacStartupPolicyError.bootSessionUnavailable
        }
        return value
    }
    #endif

    // MARK: - File Helpers

    private func writeSessionFile(_ bootSession: String, dataDir: URL) throws {
        let url = sessionFile(dataDir: dataDir)
        let data = Data((bootSession + "\n").utf8)
        try data.write(to: url, options: .atomic)
        try setOwnerOnlyPermissions(url)
    }

    private func writeEmptyMarker(_ url: URL) throws {
        try Data().write(to: url, options: .atomic)
        try setOwnerOnlyPermissions(url)
    }

    /// Marks the file owner-only, the permission every other file in this
    /// data directory carries.  Control wrote its markers world-readable
    /// because a marker is not a secret;  these are still not secrets, but a
    /// policy file reads better beside files that are.
    private func setOwnerOnlyPermissions(_ url: URL) throws {
        try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

/// Errors raised while reading or writing the harness startup policy.
public enum MacStartupPolicyError: LocalizedError, Equatable, Sendable {
    /// The boot session could not be read, so the choice cannot be recorded.
    case bootSessionUnavailable
    /// The installed wrapper predates the policy and would ignore the markers.
    case updateRequired
    case policyWriteFailed

    public var errorDescription: String? {
        switch self {
        case .bootSessionUnavailable:
            return "The boot session could not be read, so the startup choice cannot be recorded."
        case .updateRequired:
            return "The installed server wrapper is older than this setting and does not support it."
        case .policyWriteFailed:
            return "Could not save the startup policy."
        }
    }
}
