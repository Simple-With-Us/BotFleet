// `CompanionClient.openDesktopApp()` tests against a stubbed `URLProtocol`.
// Verifies that the client issues a POST to `/api/desktop/open` with bearer auth
// and JSON content-type, succeeds on 200, and surfaces API errors on failure.
import Foundation
import XCTest
@testable import CompanionCore

private final class DesktopOpenRequestStub: URLProtocol {
    static var responseBody = Data(#"{"ok":true}"#.utf8)
    static var statusCode = 200
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        Self.capturedBody = Self.readBody(from: request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: Self.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readBody(from request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { return nil }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

final class DesktopOpenClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DesktopOpenRequestStub.self]
        session = URLSession(configuration: config)
        let connection = Connection(name: "Mac", host: "127.0.0.1", port: 8810)
        client = CompanionClient(connection: connection, token: "test-token", session: session)
        DesktopOpenRequestStub.statusCode = 200
        DesktopOpenRequestStub.responseBody = Data(#"{"ok":true}"#.utf8)
        DesktopOpenRequestStub.capturedRequest = nil
        DesktopOpenRequestStub.capturedBody = nil
    }

    func testOpenDesktopAppSendsExpectedRequest() async throws {
        try await client.openDesktopApp()

        let req = try XCTUnwrap(DesktopOpenRequestStub.capturedRequest)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.path, "/api/desktop/open")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(DesktopOpenRequestStub.capturedBody)
        let parsed = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        XCTAssertNotNil(parsed)
    }

    func testOpenDesktopAppThrowsOnFailureStatus() async {
        DesktopOpenRequestStub.statusCode = 503
        DesktopOpenRequestStub.responseBody = Data(#"{"error":"could not open BotFleet"}"#.utf8)

        do {
            try await client.openDesktopApp()
            XCTFail("expected openDesktopApp to throw on 503")
        } catch let error as APIError {
            switch error {
            case let .status(code, message):
                XCTAssertEqual(code, 503)
                XCTAssertEqual(message, "could not open BotFleet")
            default:
                XCTFail("unexpected APIError variant: \(error)")
            }
        } catch {
            XCTFail("unexpected error type: \(error)")
        }
    }
}
