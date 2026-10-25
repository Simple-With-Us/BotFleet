import Darwin
import Foundation

/// Lifecycle and remote-wake preferences for the native macOS BotFleet desktop app.
///
/// Maps directly to the harness configuration section `server.allowRemoteDesktopLaunch`
/// (default `false`) and `server.persistOnExit` (default `true` per PR #1248).
public struct MacLifecycleSettings: Codable, Equatable, Sendable {
    /// The operator's remote-desktop-launch grant.
    ///
    /// `nil` means "unknown": the harness did not report the value, so the app
    /// must never write one back.  `GET /api/config` returns `configStatus()`,
    /// which has no `server` section, so a missing section leaves the grant
    /// unknown instead of defaulting it to `false` and silently revoking it on
    /// the next save.
    public var allowRemoteDesktopLaunch: Bool?
    public var persistOnExit: Bool

    public init(allowRemoteDesktopLaunch: Bool? = nil, persistOnExit: Bool = true) {
        self.allowRemoteDesktopLaunch = allowRemoteDesktopLaunch
        self.persistOnExit = persistOnExit
    }
}

/// Decision evaluated when the macOS desktop app is quitting.
public enum MacQuitPolicyDecision: String, Codable, Equatable, Sendable {
    case keepServerRunning
    case shutDownServerAndVM

    /// The action taken when the desktop window closes.
    ///
    /// The Settings toggle reads "Keep Server Running When Window Closes", so a
    /// window close has to run through the same policy as a quit.  Closing the
    /// SwiftUI window does not terminate the app, so evaluating the policy only
    /// on termination would leave the harness running on the most common path.
    public static func windowCloseAction(persistOnExit: Bool) -> MacQuitPolicyDecision {
        MacLifecycleClient.evaluateQuitAction(persistOnExit: persistOnExit)
    }
}

/// Whether a connection attempt is the operator deliberately launching the
/// desktop app or an ordinary reconnect of an app that is already running.
public enum MacConnectionIntent: String, Codable, Equatable, Sendable {
    case appLaunch
    case reconnect
}

/// The outcome of a lifecycle-settings save.
///
/// A rejected write restores the previous settings, so the Settings toggles
/// never keep showing a value the harness never accepted.
public enum MacLifecycleSaveResult: Equatable, Sendable {
    case saved(MacLifecycleSettings)
    case failed(previous: MacLifecycleSettings, message: String)
}

/// The outcome of a deliberate shutdown of the harness and the local VM.
public enum MacShutdownOutcome: Equatable, Sendable {
    case stopped(MacShutdownReceipt)
    case failed(message: String)
}

/// Structured receipt returned by `POST /api/system/shutdown`.
public struct MacShutdownReceipt: Codable, Equatable, Sendable {
    public let ok: Bool
    public let markerWritten: Bool
    public let localVmStop: String
    public let localVmNote: String?

    public init(
        ok: Bool,
        markerWritten: Bool,
        localVmStop: String = "not-running",
        localVmNote: String? = nil
    ) {
        self.ok = ok
        self.markerWritten = markerWritten
        self.localVmStop = localVmStop
        self.localVmNote = localVmNote
    }
}

/// Errors raised while reading, persisting, or applying macOS lifecycle controls.
public enum MacLifecycleError: LocalizedError, Equatable, Sendable {
    case invalidURL
    case invalidResponse
    case invalidPolicyValue
    case policyWriteFailed
    case httpError(statusCode: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "The local harness URL is invalid."
        case .invalidResponse:
            return "The local harness returned an invalid response."
        case .invalidPolicyValue:
            return "The local server persistence policy file holds an invalid value."
        case .policyWriteFailed:
            return "Could not save the local server persistence policy."
        case .httpError(_, let message):
            return message
        }
    }
}

/// Manages `~/.botfleet/persist-on-exit.policy` and the deliberate-stop sentinel `~/.botfleet/stopped.marker`.
///
/// Matches the wire and file-permission contract in `mac-control/Sources/BotFleetControlCore/PersistencePolicy.swift`
/// and `server/harness-lifecycle.ts`.  All writes use `0600` permissions and atomic rename so concurrent readers
/// never observe a torn file.
public final class MacPersistencePolicyStore: @unchecked Sendable {
    public static let policyFileName = "persist-on-exit.policy"
    public static let stoppedMarkerFileName = "stopped.marker"

    public let dataDir: URL
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
        home: URL = MacPersistencePolicyStore.defaultHomeDirectory,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        files: FileManager = .default
    ) {
        if let explicit = dataDir {
            self.dataDir = explicit
        } else if let value = environment["OMB_DATA_DIR"], !value.isEmpty, value.hasPrefix("/") {
            self.dataDir = URL(fileURLWithPath: value, isDirectory: true)
        } else {
            self.dataDir = home.appendingPathComponent(".botfleet", isDirectory: true)
        }
        self.files = files
    }

    // MARK: - Persistence Policy (`persist-on-exit.policy`)

    /// Reads the offline `persist-on-exit.policy` boolean, returning `nil` when absent or unrecognized.
    public func readPersistOnExit(dataDir: URL? = nil) -> Bool? {
        let targetDir = dataDir ?? self.dataDir
        let fileURL = targetDir.appendingPathComponent(Self.policyFileName)
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        switch data {
        case Data("true\n".utf8):
            return true
        case Data("false\n".utf8):
            return false
        default:
            return nil
        }
    }

    public static func readPersistOnExit(dataDir: URL) -> Bool? {
        MacPersistencePolicyStore(dataDir: dataDir).readPersistOnExit(dataDir: dataDir)
    }

    /// Atomically writes `"true\n"` or `"false\n"` to `persist-on-exit.policy` with mode `0600`.
    public func writePersistOnExit(_ enabled: Bool, dataDir: URL? = nil) throws {
        let targetDir = dataDir ?? self.dataDir
        try files.createDirectory(at: targetDir, withIntermediateDirectories: true)
        let destination = targetDir.appendingPathComponent(Self.policyFileName)
        let bytes = Array((enabled ? "true\n" : "false\n").utf8)
        try writeAtomicallyMode0600(bytes: bytes, to: destination, in: targetDir, prefix: ".persist-on-exit")
        guard readPersistOnExit(dataDir: targetDir) == enabled else {
            throw MacLifecycleError.invalidPolicyValue
        }
    }

    public static func writePersistOnExit(_ enabled: Bool, dataDir: URL) throws {
        try MacPersistencePolicyStore(dataDir: dataDir).writePersistOnExit(enabled, dataDir: dataDir)
    }

    // MARK: - Deliberate-Stop Sentinel (`stopped.marker`)

    /// Returns `true` when `stopped.marker` exists in `dataDir`.
    public func hasStoppedMarker(dataDir: URL? = nil) -> Bool {
        let targetDir = dataDir ?? self.dataDir
        let markerURL = targetDir.appendingPathComponent(Self.stoppedMarkerFileName)
        return files.fileExists(atPath: markerURL.path)
    }

    public static func hasStoppedMarker(dataDir: URL) -> Bool {
        MacPersistencePolicyStore(dataDir: dataDir).hasStoppedMarker(dataDir: dataDir)
    }

    /// Removes `stopped.marker` when the user deliberately launches `BotFleetMac` so the launchd
    /// wrapper is allowed to start or supervise the server again.  Returns `true` if a marker
    /// was present and removed, or `false` if none existed.
    @discardableResult
    public func clearStoppedMarkerOnDeliberateLaunch(dataDir: URL? = nil) throws -> Bool {
        let targetDir = dataDir ?? self.dataDir
        let markerURL = targetDir.appendingPathComponent(Self.stoppedMarkerFileName)
        guard files.fileExists(atPath: markerURL.path) else {
            return false
        }
        try files.removeItem(at: markerURL)
        return true
    }

    @discardableResult
    public static func clearStoppedMarkerOnDeliberateLaunch(dataDir: URL) throws -> Bool {
        try MacPersistencePolicyStore(dataDir: dataDir).clearStoppedMarkerOnDeliberateLaunch(dataDir: dataDir)
    }

    /// Clears the deliberate-stop sentinel, but only for a deliberate app launch.
    ///
    /// A reconnect must leave the sentinel in place.
    /// `scripts/botfleet-server-start.sh` starts nothing while the marker
    /// exists, and it is the only thing keeping the launchd `StartInterval` tick
    /// from resurrecting a harness the operator stopped on purpose.
    @discardableResult
    public func clearStoppedMarker(for intent: MacConnectionIntent, dataDir: URL? = nil) throws -> Bool {
        guard intent == .appLaunch else { return false }
        return try clearStoppedMarkerOnDeliberateLaunch(dataDir: dataDir)
    }

    /// Writes `stopped.marker` with mode `0600` so the 5-minute launchd `StartInterval` health check
    /// treats the shutdown as deliberate and does not resurrect the harness.
    public func writeStoppedMarker(dataDir: URL? = nil, now: Date = Date()) throws {
        let targetDir = dataDir ?? self.dataDir
        try files.createDirectory(at: targetDir, withIntermediateDirectories: true)
        let destination = targetDir.appendingPathComponent(Self.stoppedMarkerFileName)
        let iso = ISO8601DateFormatter().string(from: now)
        let body = [
            "BotFleet was shut down on purpose.",
            "",
            "Written: \(iso)",
            "",
            "The launchd wrapper (StartInterval=300) starts nothing while this file",
            "exists, so the harness stays down instead of being treated as a crash.",
            "Delete this file, or launch the BotFleet app, to let it come back.",
            "",
        ].joined(separator: "\n")
        try writeAtomicallyMode0600(
            bytes: Array(body.utf8),
            to: destination,
            in: targetDir,
            prefix: ".stopped-marker"
        )
    }

    public static func writeStoppedMarker(dataDir: URL, now: Date = Date()) throws {
        try MacPersistencePolicyStore(dataDir: dataDir).writeStoppedMarker(dataDir: dataDir, now: now)
    }

    // MARK: - Atomic 0600 File Helper

    private func writeAtomicallyMode0600(
        bytes: [UInt8],
        to destination: URL,
        in directory: URL,
        prefix: String
    ) throws {
        let temporary = directory.appendingPathComponent("\(prefix).\(UUID().uuidString).tmp")
        let descriptor = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard descriptor >= 0 else {
            throw MacLifecycleError.policyWriteFailed
        }
        defer {
            _ = Darwin.close(descriptor)
            try? files.removeItem(at: temporary)
        }
        try bytes.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                guard let baseAddress = buffer.baseAddress else {
                    throw MacLifecycleError.policyWriteFailed
                }
                let written = Darwin.write(
                    descriptor,
                    baseAddress.advanced(by: offset),
                    buffer.count - offset
                )
                if written < 0 && errno == EINTR { continue }
                guard written > 0 else {
                    throw MacLifecycleError.policyWriteFailed
                }
                offset += written
            }
        }
        guard Darwin.fsync(descriptor) == 0,
              Darwin.rename(temporary.path, destination.path) == 0 else {
            throw MacLifecycleError.policyWriteFailed
        }
    }
}

/// Client for reading and updating macOS desktop lifecycle settings and triggering clean shutdowns.
public final class MacLifecycleClient: @unchecked Sendable {
    public let baseURL: URL
    public let policyStore: MacPersistencePolicyStore
    private let session: URLSession

    public init(
        baseURL: URL = URL(string: "http://127.0.0.1:8799")!,
        session: URLSession = .shared,
        policyStore: MacPersistencePolicyStore = MacPersistencePolicyStore()
    ) {
        self.baseURL = baseURL
        self.session = session
        self.policyStore = policyStore
    }

    public convenience init(
        host: String,
        port: Int = 8799,
        session: URLSession = .shared,
        policyStore: MacPersistencePolicyStore = MacPersistencePolicyStore()
    ) {
        let normalizedHost = Connection.urlHost(host)
        let url = URL(string: "http://\(normalizedHost):\(port)") ?? URL(string: "http://127.0.0.1:8799")!
        self.init(baseURL: url, session: session, policyStore: policyStore)
    }

    /// Fetches `server.allowRemoteDesktopLaunch` and `server.persistOnExit` from `GET /api/config`.
    /// When the local harness is offline, falls back to the local `persist-on-exit.policy` file.
    public func fetchLifecycleSettings() async throws -> MacLifecycleSettings {
        guard let url = URL(string: "/api/config", relativeTo: baseURL)?.absoluteURL else {
            throw MacLifecycleError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(originHeaderValue(), forHTTPHeaderField: "Origin")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            // Fall back to the local policy file when the server is unreachable.
            // The remote-launch grant stays unknown, because the harness never
            // reported it and a local fallback must not invent a value.
            let localPersist = policyStore.readPersistOnExit() ?? true
            return MacLifecycleSettings(allowRemoteDesktopLaunch: nil, persistOnExit: localPersist)
        }

        guard let http = response as? HTTPURLResponse else {
            throw MacLifecycleError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw MacLifecycleError.httpError(
                statusCode: http.statusCode,
                message: parseServerErrorMessage(from: data, statusCode: http.statusCode)
            )
        }

        let parsed = try parseLifecycleSettings(from: data)
        if let rawObj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let serverDict = rawObj["server"] as? [String: Any],
           serverDict["persistOnExit"] is Bool {
            try? policyStore.writePersistOnExit(parsed.persistOnExit)
        }
        return parsed
    }

    /// Saves `allowRemoteDesktopLaunch` and `persistOnExit` via `PUT /api/config` and mirrors
    /// `persistOnExit` to `~/.botfleet/persist-on-exit.policy`.
    ///
    /// The remote-launch grant is only sent when it is known.
    /// `GET /api/config` returns `configStatus()`, which has no `server` section,
    /// so a grant the app never read must not be written back as `false`: that
    /// would silently revoke the operator's grant.
    public func saveLifecycleSettings(_ settings: MacLifecycleSettings) async throws {
        guard let url = URL(string: "/api/config", relativeTo: baseURL)?.absoluteURL else {
            throw MacLifecycleError.invalidURL
        }
        var server: [String: Any] = [
            "persistOnExit": settings.persistOnExit
        ]
        if let allowRemote = settings.allowRemoteDesktopLaunch {
            server["allowRemoteDesktopLaunch"] = allowRemote
        }
        let payload: [String: Any] = [
            "server": server
        ]
        let body = try JSONSerialization.data(withJSONObject: payload)

        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(originHeaderValue(), forHTTPHeaderField: "Origin")

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw MacLifecycleError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw MacLifecycleError.httpError(
                statusCode: http.statusCode,
                message: parseServerErrorMessage(from: data, statusCode: http.statusCode)
            )
        }

        try policyStore.writePersistOnExit(settings.persistOnExit)
    }

    /// Saves `settings` and reports the settings the UI should show afterwards.
    ///
    /// A rejected write restores `previous`, so the Settings toggles never keep
    /// showing a value the harness never accepted.  The local policy file still
    /// mirrors the operator's choice, because it is the offline source of truth
    /// for the quit policy.
    public func saveLifecycleSettings(
        _ settings: MacLifecycleSettings,
        restoring previous: MacLifecycleSettings
    ) async -> MacLifecycleSaveResult {
        do {
            try await saveLifecycleSettings(settings)
            return .saved(settings)
        } catch {
            try? policyStore.writePersistOnExit(settings.persistOnExit)
            return .failed(previous: previous, message: error.localizedDescription)
        }
    }

    /// Calls `POST /api/system/shutdown` to stop the local VM and harness cleanly, ensuring
    /// `~/.botfleet/stopped.marker` is written so launchd does not resurrect the server.
    public func shutDownServerAndLocalVM() async throws -> MacShutdownReceipt {
        guard let url = URL(string: "/api/system/shutdown", relativeTo: baseURL)?.absoluteURL else {
            throw MacLifecycleError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(originHeaderValue(), forHTTPHeaderField: "Origin")

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw MacLifecycleError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw MacLifecycleError.httpError(
                statusCode: http.statusCode,
                message: parseServerErrorMessage(from: data, statusCode: http.statusCode)
            )
        }

        let receipt = try parseShutdownReceipt(from: data)
        if !policyStore.hasStoppedMarker() {
            try policyStore.writeStoppedMarker()
        }
        return MacShutdownReceipt(
            ok: receipt.ok,
            markerWritten: policyStore.hasStoppedMarker() || receipt.markerWritten,
            localVmStop: receipt.localVmStop,
            localVmNote: receipt.localVmNote
        )
    }

    /// Evaluates whether quitting `BotFleetMac` should keep the server running or shut down
    /// both the harness and the local VM.
    public func evaluateQuitAction(persistOnExit: Bool) -> MacQuitPolicyDecision {
        Self.evaluateQuitAction(persistOnExit: persistOnExit)
    }

    public static func evaluateQuitAction(persistOnExit: Bool) -> MacQuitPolicyDecision {
        persistOnExit ? .keepServerRunning : .shutDownServerAndVM
    }

    /// Performs a deliberate shutdown and reports the outcome.
    ///
    /// A failed shutdown must not leave the deliberate-stop sentinel behind: the
    /// harness is still running, and the marker would make
    /// `scripts/botfleet-server-start.sh` treat a live server as deliberately
    /// stopped, so launchd would never revive it after a later crash.
    public func performDeliberateShutdown() async -> MacShutdownOutcome {
        do {
            let receipt = try await shutDownServerAndLocalVM()
            return .stopped(receipt)
        } catch {
            return .failed(message: error.localizedDescription)
        }
    }

    // MARK: - Internal Helpers

    private func originHeaderValue() -> String {
        var components = URLComponents()
        components.scheme = baseURL.scheme ?? "http"
        components.host = baseURL.host ?? "127.0.0.1"
        components.port = baseURL.port
        return components.string ?? "http://127.0.0.1:8799"
    }

    private func parseLifecycleSettings(from data: Data) throws -> MacLifecycleSettings {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw MacLifecycleError.invalidResponse
        }
        let serverSection = root["server"] as? [String: Any]
        // `GET /api/config` returns `configStatus()`, which has no `server`
        // section at all.  A grant the harness did not report stays unknown
        // (`nil`), so a later save never writes back a `false` the app never
        // read and silently revokes the operator's grant.
        let allowRemote = serverSection?["allowRemoteDesktopLaunch"] as? Bool
        let persist: Bool
        if let serverPersist = serverSection?["persistOnExit"] as? Bool {
            persist = serverPersist
        } else if let topLevelPersist = root["persistOnExit"] as? Bool {
            persist = topLevelPersist
        } else {
            persist = policyStore.readPersistOnExit() ?? true
        }
        return MacLifecycleSettings(
            allowRemoteDesktopLaunch: allowRemote,
            persistOnExit: persist
        )
    }

    private func parseShutdownReceipt(from data: Data) throws -> MacShutdownReceipt {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw MacLifecycleError.invalidResponse
        }
        let ok = (root["ok"] as? Bool) ?? false
        guard ok else {
            let errorMessage = (root["error"] as? String)
                ?? (root["message"] as? String)
                ?? "BotFleet Server could not shut down cleanly."
            throw MacLifecycleError.httpError(statusCode: 500, message: errorMessage)
        }
        let detail = root["detail"] as? [String: Any]
        let markerWritten = (detail?["markerWritten"] as? Bool)
            ?? (root["markerWritten"] as? Bool)
            ?? false
        let localVmStop = (detail?["localVmStop"] as? String)
            ?? (root["localVmStop"] as? String)
            ?? "not-running"
        let localVmNote = (detail?["localVmNote"] as? String)
            ?? (root["localVmNote"] as? String)
        return MacShutdownReceipt(
            ok: ok,
            markerWritten: markerWritten,
            localVmStop: localVmStop,
            localVmNote: localVmNote
        )
    }

    private func parseServerErrorMessage(from data: Data, statusCode: Int) -> String {
        if let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            if let error = obj["error"] as? String, !error.isEmpty { return error }
            if let message = obj["message"] as? String, !message.isEmpty { return message }
        }
        return "BotFleet Server refused the request (HTTP \(statusCode))."
    }
}

/// One connection cycle against the local harness.
///
/// The lifecycle settings ride on the fleet-snapshot cadence: exactly one
/// `GET /api/config` per successful connection.  Fetching them on the connect
/// path as well would double the request count on every reconnect, which is
/// exactly when the harness is least able to serve it.
public enum MacHarnessConnectionCycle {
    /// Runs one connection cycle: the roster snapshot, the state hydration, and
    /// exactly one lifecycle-settings refresh.
    ///
    /// The closures keep the harness calls injectable, so the refresh cadence is
    /// covered by a test that counts the requests instead of assuming them.
    public static func connect(
        fetchFleet: @Sendable () async throws -> Fleet,
        hydrate: @MainActor (Fleet) -> Void,
        refreshLifecycleSettings: @MainActor () async -> Void
    ) async throws {
        let fleet = try await fetchFleet()
        await hydrate(fleet)
        await refreshLifecycleSettings()
    }
}
