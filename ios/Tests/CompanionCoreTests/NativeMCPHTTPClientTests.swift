import Foundation
import Testing
@testable import CompanionCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private final class NativeMCPHTTPFixtureState: @unchecked Sendable {
    enum Reply {
        case chunks(status: Int, headers: [String: String], data: [Data])
        case redirect(URL)
        case error(URLError.Code)
        case hold
    }
    let reply: Reply
    private let lock = NSLock()
    private var requests: [URLRequest] = []
    private var stops = 0
    init(_ reply: Reply) { self.reply = reply }
    func record(_ request: URLRequest) { lock.lock(); defer { lock.unlock() }; requests.append(request) }
    func stopped() { lock.lock(); defer { lock.unlock() }; stops += 1 }
    func snapshot() -> (requests: [URLRequest], stops: Int) { lock.lock(); defer { lock.unlock() }; return (requests, stops) }
}

/// Every URL is intercepted, including an unexpected redirect, so a fixture can never reach a live host.
private final class NativeMCPFixtureURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var states: [String: NativeMCPHTTPFixtureState] = [:]
    private var state: NativeMCPHTTPFixtureState?

    static func register(_ state: NativeMCPHTTPFixtureState) -> URL {
        let host = "fixture-\(UUID().uuidString.lowercased()).invalid"
        lock.lock(); states[host] = state; lock.unlock()
        return URL(string: "https://\(host)/mcp?team=acme")!
    }
    static func remove(_ url: URL) { lock.lock(); defer { lock.unlock() }; states.removeValue(forKey: url.host ?? "") }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        state = Self.states[request.url?.host ?? ""]
        Self.lock.unlock()
        guard let state, let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        state.record(request)
        switch state.reply {
        case .chunks(let status, let headers, let chunks):
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            for chunk in chunks { client?.urlProtocol(self, didLoad: chunk) }
            client?.urlProtocolDidFinishLoading(self)
        case .redirect(let target):
            let response = HTTPURLResponse(url: url, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: ["Location": target.absoluteString])!
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: target), redirectResponse: response)
            client?.urlProtocolDidFinishLoading(self)
        case .error(let code): client?.urlProtocol(self, didFailWithError: URLError(code))
        case .hold: break
        }
    }

    override func stopLoading() { state?.stopped() }
}

private func privateMCPTestConfiguration() -> URLSessionConfiguration {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [NativeMCPFixtureURLProtocol.self]
    configuration.httpAdditionalHeaders = ["Cookie": "ambient-fixture-cookie", "Authorization": "Bearer ambient-fixture-token"]
    return configuration
}

@Suite("Native MCP URLSession HTTP Client", .serialized)
struct NativeMCPHTTPClientTests {
    @Test("Exact addresses and explicit Cloudflare Access headers reach only the private transport")
    func exactAddressAndNoAmbientIdentity() async throws {
        let state = NativeMCPHTTPFixtureState(.chunks(status: 200, headers: ["Content-Type": "application/json", "Mcp-Session-Id": "fixture-session"],
                                                    data: [Data("first".utf8), Data("second".utf8)]))
        let url = NativeMCPFixtureURLProtocol.register(state)
        defer { NativeMCPFixtureURLProtocol.remove(url) }
        let transport = NativeMCPURLSessionHTTPClient(configuration: privateMCPTestConfiguration())
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = Data("{}".utf8)
        request.setValue("Bearer explicit-fixture", forHTTPHeaderField: "Authorization")
        request.setValue("private-fixture-id", forHTTPHeaderField: "CF-Access-Client-Id")
        request.setValue("private-fixture-secret", forHTTPHeaderField: "CF-Access-Client-Secret")
        let response = try await transport.execute(request)
        #expect(response.status == 200)
        #expect(response.body == Data("firstsecond".utf8))
        #expect(response.headers.contains { $0.key.lowercased() == "mcp-session-id" && $0.value == "fixture-session" })
        let seen = try #require(state.snapshot().requests.first)
        #expect(seen.url?.absoluteString == url.absoluteString)
        #expect(seen.value(forHTTPHeaderField: "Authorization") == "Bearer explicit-fixture")
        #expect(seen.value(forHTTPHeaderField: "CF-Access-Client-Id") == "private-fixture-id")
        #expect(seen.value(forHTTPHeaderField: "CF-Access-Client-Secret") == "private-fixture-secret")
        #expect(seen.value(forHTTPHeaderField: "Cookie") == nil)
        #expect(!seen.httpShouldHandleCookies)
    }

    @Test("A redirect never contacts its target or forwards private Access headers")
    func refusesRedirect() async throws {
        let targetState = NativeMCPHTTPFixtureState(.chunks(status: 200, headers: [:], data: []))
        let target = NativeMCPFixtureURLProtocol.register(targetState)
        let originalState = NativeMCPHTTPFixtureState(.redirect(target))
        let original = NativeMCPFixtureURLProtocol.register(originalState)
        defer { NativeMCPFixtureURLProtocol.remove(original); NativeMCPFixtureURLProtocol.remove(target) }
        let transport = NativeMCPURLSessionHTTPClient(configuration: privateMCPTestConfiguration(), timeout: 0.2)
        var request = URLRequest(url: original)
        request.setValue("private-fixture-secret", forHTTPHeaderField: "CF-Access-Client-Secret")
        let response = try await transport.execute(request)
        #expect(response.status == 302)
        #expect(originalState.snapshot().requests.count == 1)
        #expect(targetState.snapshot().requests.isEmpty)
    }

    @Test("Oversized streamed data is cancelled once before a response can escape")
    func boundedBody() async throws {
        let state = NativeMCPHTTPFixtureState(.chunks(status: 200, headers: [:], data: [Data(repeating: 65, count: 512), Data(repeating: 66, count: 513), Data(repeating: 67, count: 100)]))
        let url = NativeMCPFixtureURLProtocol.register(state)
        defer { NativeMCPFixtureURLProtocol.remove(url) }
        let transport = NativeMCPURLSessionHTTPClient(configuration: privateMCPTestConfiguration(), maximumResponseBytes: 1024)
        do { _ = try await transport.execute(URLRequest(url: url)); Issue.record("An oversized MCP response was returned") }
        catch { #expect(error as? NativeMCPHTTPClientError == .responseTooLarge) }
        for _ in 0..<100 {
            if state.snapshot().stops > 0 { break }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        #expect(state.snapshot().requests.count == 1)
        #expect(state.snapshot().stops <= 1)
    }

    @Test("Network errors, explicit cancellation, and a finite deadline each settle once")
    func errorsCancellationAndTimeout() async throws {
        let failed = NativeMCPHTTPFixtureState(.error(.networkConnectionLost))
        let failedURL = NativeMCPFixtureURLProtocol.register(failed)
        defer { NativeMCPFixtureURLProtocol.remove(failedURL) }
        let transport = NativeMCPURLSessionHTTPClient(configuration: privateMCPTestConfiguration(), timeout: 0.03)
        do { _ = try await transport.execute(URLRequest(url: failedURL)); Issue.record("A network error became a response") }
        catch { #expect((error as? URLError)?.code == .networkConnectionLost) }

        let held = NativeMCPHTTPFixtureState(.hold)
        let heldURL = NativeMCPFixtureURLProtocol.register(held)
        defer { NativeMCPFixtureURLProtocol.remove(heldURL) }
        do { _ = try await transport.execute(URLRequest(url: heldURL)); Issue.record("An unfinished request escaped its deadline") }
        catch { #expect((error as? URLError)?.code == .timedOut) }
        let cancelled = Task { try await transport.execute(URLRequest(url: heldURL)) }
        cancelled.cancel()
        do { _ = try await cancelled.value; Issue.record("A cancelled MCP request returned a response") }
        catch { #expect((error as? URLError)?.code == .cancelled) }
        #expect(held.snapshot().requests.count <= 2)
    }

    @Test("URL credentials are rejected without consulting ambient URL credential stores")
    func rejectsCredentialsInURL() async {
        let transport = NativeMCPURLSessionHTTPClient(configuration: privateMCPTestConfiguration())
        do {
            _ = try await transport.execute(URLRequest(url: URL(string: "https://user:private-fixture@unused.invalid/mcp")!))
            Issue.record("URL credentials reached the network transport")
        } catch { #expect(error as? NativeMCPHTTPClientError == .invalidURL) }
    }
}
