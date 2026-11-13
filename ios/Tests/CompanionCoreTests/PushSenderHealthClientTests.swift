// `CompanionClient.pushSenderHealth()` against a stubbed `URLProtocol`.
// Pinned here because the wire shape matters: an authenticated GET to a
// route an older sidecar may answer with 404 — and the Settings row
// renders that as "not reported by this computer" rather than a
// connection error.
import Foundation
import XCTest
@testable import CompanionCore

private final class PushHealthRequestStub: URLProtocol {
    static let lock = NSLock()
    static var responseBody = Data()
    static var statusCode = 200
    static var capturedRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.capturedRequest = request
        let body = Self.responseBody
        let code = Self.statusCode
        Self.lock.unlock()
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: code,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func reset(body: Data, code: Int = 200) {
        lock.lock()
        responseBody = body
        statusCode = code
        capturedRequest = nil
        lock.unlock()
    }

    static func captured() -> URLRequest? {
        lock.lock()
        defer { lock.unlock() }
        return capturedRequest
    }
}

final class PushSenderHealthClientTests: XCTestCase {
    private var session: URLSession!

    override func setUp() {
        super.setUp()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PushHealthRequestStub.self]
        session = URLSession(configuration: configuration)
    }

    override func tearDown() {
        session.invalidateAndCancel()
        session = nil
        super.tearDown()
    }

    private let sample = #"""
    {"configured": true, "production": true, "tokensRegistered": 1, "sent": 3, "failed": 0, "lastSentAt": 1699990000000, "lastErrorAt": null, "lastError": null, "keyRejected": null, "dropped": 0}
    """#

    func testFetchesTheAuthenticatedPushHealthPayload() async throws {
        PushHealthRequestStub.reset(body: Data(sample.utf8))
        let client = CompanionClient(
            connection: Connection(name: "Mac", host: "192.0.2.10", port: 8810),
            token: "paired-token",
            session: session
        )

        let health = try await client.pushSenderHealth()

        XCTAssertTrue(health.configured)
        XCTAssertEqual(health.tokensRegistered, 1)
        XCTAssertEqual(health.sent, 3)
        XCTAssertEqual(health.lastSentAt, 1_699_990_000_000)
        let request = try XCTUnwrap(PushHealthRequestStub.captured())
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/companion/push-health")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer paired-token")
    }

    /// An older sidecar returns 404 for this route.  The client must
    /// surface that as `APIError.status(code: 404, ...)` — the Settings
    /// row uses `error.isNotFound` to switch into "not reported by this
    /// computer" copy, so a 404 must NOT be flattened to a transport
    /// error somewhere in here.
    func testAnOlderSidecarReturns404ThatSurfacesAsAnAPIErrorStatus() async {
        PushHealthRequestStub.reset(body: Data(#"{"error":"not found"}"#.utf8), code: 404)
        let client = CompanionClient(
            connection: Connection(name: "Old Mac", host: "192.0.2.11", port: 8810),
            token: "paired-token",
            session: session
        )

        do {
            _ = try await client.pushSenderHealth()
            XCTFail("expected an error")
        } catch let error as APIError {
            guard case let .status(code, _) = error else {
                return XCTFail("expected .status, got \(error)")
            }
            XCTAssertEqual(code, 404)
            XCTAssertTrue(error.isNotFound)
        } catch {
            XCTFail("expected APIError, got \(error)")
        }
    }
}
