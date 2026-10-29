import Foundation

public struct LocalVM: Decodable, Equatable, Sendable {
    public let key: String
    public let name: String
    public let running: Bool
    public let state: String?

    public init(key: String, name: String, running: Bool, state: String? = nil) {
        self.key = key
        self.name = name
        self.running = running
        self.state = state
    }
}

public struct ControlStatus: Decodable, Equatable, Sendable {
    public let activeBotCount: Int
    public let localVms: [LocalVM]
    public let persistOnExit: Bool
    /// The work in flight that would block a stop, per kind.
    ///
    /// The server counts ~18 kinds of work before it will stop, but this app
    /// only knew the bot-turn count, so its confirmation could say "0 bot
    /// turn(s) are active" and then the server would refuse the stop for
    /// something else entirely.  The server sends the same breakdown it uses
    /// for that refusal, so the dialog and the refusal agree.
    public let blockingWork: [BlockingWork]?

    public init(
        activeBotCount: Int,
        localVms: [LocalVM],
        persistOnExit: Bool = true,
        blockingWork: [BlockingWork]? = nil
    ) {
        self.activeBotCount = activeBotCount
        self.localVms = localVms
        self.persistOnExit = persistOnExit
        self.blockingWork = blockingWork
    }

    public var runningVMCount: Int { localVms.filter(\.running).count }
    public var sharedVM: LocalVM? { localVms.first { $0.key == "shared" } }
    public var isSharedVMRunning: Bool { sharedVM?.running == true }
    public var canStartSharedVM: Bool { ["missing", "created"].contains(sharedVM?.state ?? "") }
    public var canStopSharedVM: Bool { sharedVM?.running == true }

    /// The blocking work as a sentence, or nil when nothing is in flight.
    public var blockingWorkSummary: String? {
        let named = (blockingWork ?? []).filter { $0.count > 0 }
        guard !named.isEmpty else { return nil }
        return named.map { "\($0.count) \($0.label)\($0.count == 1 ? "" : "s")" }.joined(separator: ", ")
    }
}

/// One kind of work that is in flight and would block a stop.
public struct BlockingWork: Decodable, Equatable, Sendable {
    public let count: Int
    public let label: String

    public init(count: Int, label: String) {
        self.count = count
        self.label = label
    }
}

public enum ControlAPIError: LocalizedError, Equatable {
    case unavailable
    /// The server answered the health check but did not answer the status
    /// route in time.  It is running; it was just too slow.
    case unresponsive
    case foreignService
    case invalidResponse
    case refused(String)

    public var errorDescription: String? {
        switch self {
        case .unavailable: return "BotFleet Server is unavailable."
        case .unresponsive: return "BotFleet Server is running but did not answer in time."
        case .foreignService: return "Port is not answering as BotFleet Server."
        case .invalidResponse: return "BotFleet Server returned an invalid response.  Update BotFleet and try again."
        case .refused(let message): return message
        }
    }
}

public final class ControlAPI {
    private let session: URLSession
    public let host: ServerHost
    private let baseURL: URL
    private let decoder = JSONDecoder()

    public init(session: URLSession = .shared, host: ServerHost = .defaultLocal) {
        self.session = session
        self.host = host
        self.baseURL = host.baseURL
    }

    public convenience init(session: URLSession, baseURL: URL) {
        let isLocal = (baseURL.host == "127.0.0.1" || baseURL.host == "localhost")
        let host = ServerHost(name: isLocal ? "Local Mac" : "Custom Server", baseURL: baseURL, isLocal: isLocal)
        self.init(session: session, host: host)
    }

    public convenience init(baseURL: URL) {
        let isLocal = (baseURL.host == "127.0.0.1" || baseURL.host == "localhost")
        let host = ServerHost(name: isLocal ? "Local Mac" : "Custom Server", baseURL: baseURL, isLocal: isLocal)
        self.init(session: .shared, host: host)
    }

    /// How long the status probe waits for the server's own answer.
    ///
    /// The route reads the state of every Local VM target, so on a busy Mac
    /// it takes a while.  Fifteen seconds was close enough to what the route
    /// actually cost under load that a slow server read as a stopped one,
    /// which greyed out Start Local VM on a server that was running fine.
    public static let statusTimeout: TimeInterval = 30

    public func status(timeout: TimeInterval = ControlAPI.statusTimeout) async throws -> ControlStatus {
        try await verifyIdentity()
        let data: Data
        do {
            data = try await send("/api/system/control", method: "GET", timeout: timeout)
        } catch ControlAPIError.unavailable {
            // The identity check already proved the server is alive and ready,
            // so a failure here means it was too slow to answer, not that it
            // is gone.  Reporting that as unavailable would offer to start a
            // server that is already running.
            throw ControlAPIError.unresponsive
        }
        guard let status = try? decoder.decode(ControlStatus.self, from: data), status.activeBotCount >= 0 else {
            throw ControlAPIError.invalidResponse
        }
        return status
    }

    public func setPersistOnExit(_ value: Bool) async throws {
        try await verifyIdentity()
        let body = try JSONSerialization.data(withJSONObject: ["server": ["persistOnExit": value]])
        _ = try await send("/api/config", method: "PATCH", body: body, timeout: 10)
        guard try await status().persistOnExit == value else { throw ControlAPIError.invalidResponse }
    }

    public func stopServer() async throws { try await post("/api/system/control/stop") }
    public func startVM() async throws { try await post("/api/system/control/vms/start") }
    public func stopVMs() async throws { try await post("/api/system/control/vms/stop") }

    public func startSharedVM() async throws { try await startVM() }
    public func stopSharedVM() async throws { try await stopVMs() }

    private func post(_ path: String) async throws {
        try await verifyIdentity()
        let data = try await send(path, method: "POST", body: Data("{}".utf8), timeout: 300)
        guard let result = try? decoder.decode(ActionResult.self, from: data), result.ok else {
            throw ControlAPIError.invalidResponse
        }
    }

    private func verifyIdentity() async throws {
        let data = try await send("/api/health", method: "GET")
        guard let value = try? decoder.decode(Health.self, from: data),
              value.app == "botfleet",
              (!host.isLocal || (value.pid ?? 0) > 0),
              value.ready == true else {
            throw ControlAPIError.foreignService
        }
    }

    private func send(_ path: String, method: String, body: Data? = nil, timeout: TimeInterval = 3) async throws -> Data {
        let isLocalLoopback = (baseURL.host == "127.0.0.1" || baseURL.host == "localhost")
        let validScheme = host.isLocal ? (baseURL.scheme == "http") : (baseURL.scheme == "http" || baseURL.scheme == "https")
        let validHost = host.isLocal ? isLocalLoopback : (baseURL.host != nil && !baseURL.host!.isEmpty)
        guard validScheme, validHost,
              let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw ControlAPIError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = host.authToken, !token.isEmpty {
            if !host.isLocal && !isLocalLoopback && baseURL.scheme != "https" {
                throw ControlAPIError.refused("Remote servers configured with authentication tokens must use HTTPS.")
            }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue(token, forHTTPHeaderField: "x-botfleet-gate-token")
        }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request, delegate: NoRedirects()) }
        catch { throw ControlAPIError.unavailable }
        guard let http = response as? HTTPURLResponse else { throw ControlAPIError.invalidResponse }
        if host.isLocal {
            guard http.url?.scheme == "http",
                  (http.url?.host == "127.0.0.1" || http.url?.host == "localhost"),
                  http.url?.port == baseURL.port else { throw ControlAPIError.foreignService }
        }
        if !(200..<300).contains(http.statusCode) {
            if path == "/api/health" { throw ControlAPIError.foreignService }
            let message = (try? decoder.decode(ErrorResponse.self, from: data))?.message
            if http.statusCode == 409 {
                throw ControlAPIError.refused(message ?? "BotFleet is busy with active bots or leases.  Try again after they finish.")
            }
            throw ControlAPIError.refused(message ?? "BotFleet Server refused the request (HTTP \(http.statusCode)).")
        }
        return data
    }
}

private struct Health: Decodable {
    let app: String
    let pid: Int?
    let ready: Bool?
}

private struct ActionResult: Decodable { let ok: Bool }

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

private struct ErrorResponse: Decodable {
    let message: String?
    let error: String?
    private enum CodingKeys: String, CodingKey { case message, error }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        message = try container.decodeIfPresent(String.self, forKey: .message)
            ?? container.decodeIfPresent(String.self, forKey: .error)
        error = nil
    }
}
