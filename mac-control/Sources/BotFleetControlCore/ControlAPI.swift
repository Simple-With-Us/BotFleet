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

    public var runningVMCount: Int { localVms.filter(\.running).count }
    public var sharedVM: LocalVM? { localVms.first { $0.key == "shared" } }
    public var canStartSharedVM: Bool { sharedVM?.state == "missing" }
}

public enum ControlAPIError: LocalizedError, Equatable {
    case unavailable
    case foreignService
    case invalidResponse
    case refused(String)

    public var errorDescription: String? {
        switch self {
        case .unavailable: return "BotFleet Server is unavailable."
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

    public func status() async throws -> ControlStatus {
        try await verifyIdentity()
        let data = try await send("/api/system/control", method: "GET", timeout: 15)
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
