import Foundation

public struct LocalVM: Decodable, Equatable {
    public let key: String
    public let name: String
    public let running: Bool
    public let state: String?
}

public struct ControlStatus: Decodable, Equatable {
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

    public var runningVMCount: Int { localVms.filter(\.running).count }
    public var sharedVM: LocalVM? { localVms.first { $0.key == "shared" } }
    public var canStartSharedVM: Bool { ["missing", "created"].contains(sharedVM?.state ?? "") }

    /// The blocking work as a sentence, or nil when nothing is in flight.
    public var blockingWorkSummary: String? {
        let named = (blockingWork ?? []).filter { $0.count > 0 }
        guard !named.isEmpty else { return nil }
        return named.map { "\($0.count) \($0.label)\($0.count == 1 ? "" : "s")" }.joined(separator: ", ")
    }
}

/// One kind of work that is in flight and would block a stop.
public struct BlockingWork: Decodable, Equatable {
    public let count: Int
    public let label: String
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
        case .foreignService: return "Port 8799 is not answering as BotFleet Server."
        case .invalidResponse: return "BotFleet Server returned an invalid response.  Update BotFleet and try again."
        case .refused(let message): return message
        }
    }
}

public final class ControlAPI {
    private let session: URLSession
    private let baseURL: URL
    private let decoder = JSONDecoder()

    public init(session: URLSession = .shared, baseURL: URL = URL(string: "http://127.0.0.1:8799")!) {
        self.session = session
        self.baseURL = baseURL
    }

    /// How long the status probe waits for the server's own answer.
    ///
    /// The route reads the state of every Local VM target, so on a busy Mac
    /// it takes a while.  Fifteen seconds was close enough to what the route
    /// actually cost under load that a slow server read as a stopped one,
    /// which greyed out Start Local VM on a server that was running fine.
    public static let statusTimeout: TimeInterval = 30

    public func status() async throws -> ControlStatus {
        try await verifyIdentity()
        let data: Data
        do {
            data = try await send("/api/system/control", method: "GET", timeout: Self.statusTimeout)
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
              value.app == "botfleet", value.pid > 0, value.ready == true else {
            throw ControlAPIError.foreignService
        }
    }

    private func send(_ path: String, method: String, body: Data? = nil, timeout: TimeInterval = 3) async throws -> Data {
        guard baseURL.scheme == "http", baseURL.host == "127.0.0.1",
              let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw ControlAPIError.invalidResponse
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
        do { (data, response) = try await session.data(for: request, delegate: NoRedirects()) }
        catch { throw ControlAPIError.unavailable }
        guard let http = response as? HTTPURLResponse else { throw ControlAPIError.invalidResponse }
        guard http.url?.scheme == "http", http.url?.host == "127.0.0.1",
              http.url?.port == baseURL.port else { throw ControlAPIError.foreignService }
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
    let pid: Int
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
