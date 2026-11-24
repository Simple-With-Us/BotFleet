import Foundation

/// The harness's release identity, reported by `GET /api/system/control`.
///
/// An older harness omits the whole section, so every field is optional:  the
/// app shows "unknown" rather than inventing a version.
public struct MacControlBuildIdentity: Codable, Equatable, Sendable {
    public let version: String?
    public let build: String?
    public let sourceCommit: String?

    public init(version: String? = nil, build: String? = nil, sourceCommit: String? = nil) {
        self.version = version
        self.build = build
        self.sourceCommit = sourceCommit
    }
}

/// One Local VM the harness manages, as `GET /api/system/control` reports it.
public struct MacControlVm: Codable, Equatable, Sendable, Identifiable {
    public let key: String
    public let name: String
    public let running: Bool
    public let state: String

    public init(key: String, name: String, running: Bool, state: String) {
        self.key = key
        self.name = name
        self.running = running
        self.state = state
    }

    public var id: String { key }
}

/// One kind of work in flight that would block a graceful stop.
public struct MacControlBlockingWork: Codable, Equatable, Sendable {
    public let count: Int
    public let label: String

    public init(count: Int, label: String) {
        self.count = count
        self.label = label
    }
}

/// What `GET /api/system/control` answers, decoded for the native app.
///
/// The same status the BotFleet Control menu read.  `activeBotCount`,
/// `localVms` and `persistOnExit` are optional because a harness that is
/// mid-rollout may answer with fewer fields than today's; the app shows what
/// it was given and leaves the rest unknown rather than guessing.
public struct MacControlStatus: Codable, Equatable, Sendable {
    public var activeBotCount: Int?
    public var localVms: [MacControlVm]?
    public var persistOnExit: Bool?
    public var blockingWork: [MacControlBlockingWork]?
    public var serverBuild: MacControlBuildIdentity?

    public init(
        activeBotCount: Int? = nil,
        localVms: [MacControlVm]? = nil,
        persistOnExit: Bool? = nil,
        blockingWork: [MacControlBlockingWork]? = nil,
        serverBuild: MacControlBuildIdentity? = nil
    ) {
        self.activeBotCount = activeBotCount
        self.localVms = localVms
        self.persistOnExit = persistOnExit
        self.blockingWork = blockingWork
        self.serverBuild = serverBuild
    }

    public var runningVMCount: Int { (localVms ?? []).filter(\.running).count }

    public var sharedVM: MacControlVm? { (localVms ?? []).first { $0.key == "shared" } }

    public var isSharedVMRunning: Bool { sharedVM?.running == true }

    /// A shared VM the harness has not created yet, or one that is stopped,
    /// can be started.  Anything else is in a state the route would refuse.
    public var canStartSharedVM: Bool {
        ["missing", "created"].contains(sharedVM?.state ?? "")
    }

    public var canStopSharedVM: Bool { isSharedVMRunning }

    /// The blocking work as one sentence, or `nil` when nothing is in flight.
    ///
    /// The same breakdown the harness puts in a stop refusal, so what the
    /// Settings section shows and what a refused stop says are the same words.
    public var blockingWorkSummary: String? {
        let named = (blockingWork ?? []).filter { $0.count > 0 }
        guard !named.isEmpty else { return nil }
        return named.map { "\($0.count) \($0.label)\($0.count == 1 ? "" : "s")" }.joined(separator: ", ")
    }
}

/// Errors raised while reading the harness status or driving its Local VM.
public enum MacControlStatusError: LocalizedError, Equatable, Sendable {
    case invalidURL
    case invalidResponse
    case httpError(statusCode: Int, message: String)
    /// The harness answered but has no control route:  it predates the
    /// surface this app speaks.  It is running;  it is just older.
    case outdatedServer
    /// The route answered, but not from this Mac's loopback harness.
    case foreignService

    public var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "The local harness URL is invalid."
        case .invalidResponse:
            return "The local harness returned an invalid response."
        case .httpError(_, let message):
            return message
        case .outdatedServer:
            return "This BotFleet Server is older than the app and has no server controls."
        case .foreignService:
            return "That address is not a BotFleet Server on this Mac."
        }
    }
}

/// Reads the harness status and drives its Local VM.
///
/// The routes are the ones BotFleet Control called, and the harness serves
/// them only to this Mac's loopback, so the client never carries a token and
/// never reaches a remote address.  Every call sends `{}` as the body, which
/// is what the routes expect.
public final class MacControlStatusClient: @unchecked Sendable {
    public static let statusPath = "/api/system/control"
    public static let startSharedVMPath = "/api/system/control/vms/start"
    public static let stopLocalVMsPath = "/api/system/control/vms/stop"

    /// A status read can take a while:  the harness asks its container
    /// runtime about every VM before it answers, so a short timeout reads a
    /// running server as a gone one.
    public static let statusTimeout: TimeInterval = 30
    /// A VM start or stop runs container commands and can take minutes.
    public static let vmActionTimeout: TimeInterval = 300

    public let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    /// Reads the harness status.
    public func fetchStatus() async throws -> MacControlStatus {
        let data = try await send(
            Self.statusPath,
            method: "GET",
            body: nil,
            timeout: Self.statusTimeout
        )
        guard let status = try? JSONDecoder().decode(MacControlStatus.self, from: data) else {
            throw MacControlStatusError.invalidResponse
        }
        return status
    }

    /// Starts the shared Local VM.  The harness refuses when the Computer
    /// settings have Local VM in per-bot mode or its provider is off, and the
    /// refusal's own words come back as the error.
    @discardableResult
    public func startSharedVM() async throws -> String {
        try await postVMAction(Self.startSharedVMPath, started: true)
    }

    /// Stops every Local VM the harness manages.
    @discardableResult
    public func stopLocalVMs() async throws -> String {
        try await postVMAction(Self.stopLocalVMsPath, started: false)
    }

    // MARK: - Wire

    private func postVMAction(_ path: String, started: Bool) async throws -> String {
        let data = try await send(path, method: "POST", body: Data("{}".utf8), timeout: Self.vmActionTimeout)
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw MacControlStatusError.invalidResponse
        }
        if started, let vm = object["vm"] as? [String: Any] {
            let name = (vm["name"] as? String) ?? (vm["key"] as? String) ?? "shared"
            return "Started \(name)."
        }
        if !started, let detail = object["detail"] as? [String: Any] {
            if let note = detail["note"] as? String, !note.isEmpty { return note }
            if detail["stopped"] as? Bool == true { return "Stopped the local VMs." }
            return "Nothing was running."
        }
        if object["ok"] as? Bool == true {
            return started ? "Started the shared local VM." : "Stopped the local VMs."
        }
        throw MacControlStatusError.invalidResponse
    }

    private func send(_ path: String, method: String, body: Data?, timeout: TimeInterval) async throws -> Data {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw MacControlStatusError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as MacControlStatusError {
            throw error
        } catch {
            throw MacControlStatusError.invalidResponse
        }
        guard let http = response as? HTTPURLResponse else {
            throw MacControlStatusError.invalidResponse
        }
        guard (200 ..< 300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(MacControlErrorBody.self, from: data))?.error
                ?? String(data: data.prefix(200), encoding: .utf8)
                ?? "The request failed."
            if http.statusCode == 404 { throw MacControlStatusError.outdatedServer }
            if http.statusCode == 403 && message.contains("require this Mac") {
                throw MacControlStatusError.foreignService
            }
            throw MacControlStatusError.httpError(statusCode: http.statusCode, message: message)
        }
        return data
    }
}

private struct MacControlErrorBody: Decodable {
    let error: String?
}
