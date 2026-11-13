// `CompanionClient`'s three `/api/update/*` calls, against a stubbed
// `URLProtocol` rather than a live harness — the same pattern
// `ConnectedAppsClientTests.swift` uses.  What is worth pinning here that
// model-decoding tests cannot: the harness's authorization for the two
// POST routes is "the owner credential, or a plain JSON content type" (see
// `server/index.ts`'s `authorizedUpdateControl`), so a phone that omits the
// content type is a phone that gets 401'd — and `runUpdate()`'s 202/409
// bodies both carry a full status that the caller must not have to re-fetch.
import Foundation
import XCTest
@testable import CompanionCore

private final class MacUpdateRequestStub: URLProtocol {
    static var responseBody = Data()
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

final class MacUpdateClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    private let sampleStatusJSON = #"""
    {"installed": {"version": "1.0.30", "sourceCommit": "abc1234"}, "available": null, "checkedAt": "2026-09-13T09:00:00Z", "running": null, "lastRun": null, "capabilities": {"canCheck": true, "canRun": true, "reasons": []}}
    """#

    override func setUp() {
        super.setUp()
        MacUpdateRequestStub.responseBody = Data()
        MacUpdateRequestStub.statusCode = 200
        MacUpdateRequestStub.capturedRequest = nil
        MacUpdateRequestStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MacUpdateRequestStub.self]
        session = URLSession(configuration: configuration)
        client = CompanionClient(
            connection: Connection(name: "Test", host: "127.0.0.1", port: 8810),
            token: "paired-token",
            session: session
        )
    }

    override func tearDown() {
        session?.invalidateAndCancel()
        session = nil
        client = nil
        super.tearDown()
    }

    func testUpdateStatusIsAPlainGETWithNoBody() async throws {
        MacUpdateRequestStub.responseBody = Data(sampleStatusJSON.utf8)

        let status = try await client.updateStatus()

        XCTAssertEqual(status.installed.version, "1.0.30")
        XCTAssertEqual(MacUpdateRequestStub.capturedRequest?.httpMethod, "GET")
        XCTAssertEqual(MacUpdateRequestStub.capturedRequest?.url?.path, "/api/update/status")
    }

    /// The harness's CSRF guard on this loopback route is the JSON content
    /// type itself — a hostile page's form submission cannot set it without
    /// tripping a preflight this server never answers.  Omitting it is a
    /// silent 401, not a cosmetic miss, so this pins the header and the body
    /// together rather than trusting a decode test to notice either.
    func testCheckForUpdatesSendsAJSONBody() async throws {
        MacUpdateRequestStub.responseBody = Data(sampleStatusJSON.utf8)

        _ = try await client.checkForUpdates()

        XCTAssertEqual(MacUpdateRequestStub.capturedRequest?.httpMethod, "POST")
        XCTAssertEqual(MacUpdateRequestStub.capturedRequest?.url?.path, "/api/update/check")
        XCTAssertEqual(
            MacUpdateRequestStub.capturedRequest?.value(forHTTPHeaderField: "Content-Type"),
            "application/json"
        )
        let body = try XCTUnwrap(MacUpdateRequestStub.capturedBody)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? [String: String], [:])
    }

    func testRunUpdateSendsAJSONBodyToo() async throws {
        MacUpdateRequestStub.statusCode = 202
        MacUpdateRequestStub.responseBody = Data(#"{"runId": "run-1", "status": \#(sampleStatusJSON)}"#.utf8)

        _ = try await client.runUpdate()

        XCTAssertEqual(MacUpdateRequestStub.capturedRequest?.httpMethod, "POST")
        XCTAssertEqual(MacUpdateRequestStub.capturedRequest?.url?.path, "/api/update/run")
        XCTAssertEqual(
            MacUpdateRequestStub.capturedRequest?.value(forHTTPHeaderField: "Content-Type"),
            "application/json"
        )
    }

    func testRunUpdateAcceptedReturnsTheRunIdAndStatusTogether() async throws {
        MacUpdateRequestStub.statusCode = 202
        MacUpdateRequestStub.responseBody = Data(#"{"runId": "run-1", "status": \#(sampleStatusJSON)}"#.utf8)

        let started = try await client.runUpdate()

        XCTAssertEqual(started.runId, "run-1")
        XCTAssertEqual(started.status.installed.sourceCommit, "abc1234")
    }

    /// A 409 must not just fail — it must fail WITH the reason and the
    /// status, so the card can show why without a follow-up GET.
    func testRunUpdateRefusedThrowsTheReasonAndTheStatusTogether() async throws {
        MacUpdateRequestStub.statusCode = 409
        MacUpdateRequestStub.responseBody = Data(
            #"{"error": "An update is already running.", "status": \#(sampleStatusJSON)}"#.utf8
        )

        do {
            _ = try await client.runUpdate()
            XCTFail("expected MacUpdateRunRefusal")
        } catch let refusal as MacUpdateRunRefusal {
            XCTAssertEqual(refusal.message, "An update is already running.")
            XCTAssertEqual(refusal.status.installed.version, "1.0.30")
        }
    }

    /// A 401 (unpaired, or the sidecar's own allowlist) has no `status` to
    /// offer, so this must fall through to the ordinary `APIError` path
    /// rather than the 409-specific one.
    func testRunUpdateUnauthorizedFallsThroughToTheOrdinaryAPIError() async throws {
        MacUpdateRequestStub.statusCode = 401
        MacUpdateRequestStub.responseBody = Data(#"{"error": "unauthorized"}"#.utf8)

        do {
            _ = try await client.runUpdate()
            XCTFail("expected APIError")
        } catch let error as APIError {
            XCTAssertTrue(error.isUnauthorized)
        }
    }
}
