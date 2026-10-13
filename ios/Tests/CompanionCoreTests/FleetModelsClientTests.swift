import Foundation
import XCTest
@testable import CompanionCore

private final class FleetSettingsRequestStub: URLProtocol {
    static var statusCode = 200
    static var responseBody = Data()
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        Self.capturedBody = Self.readBody(from: request)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: Self.statusCode, httpVersion: "HTTP/1.1",
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

/// The two narrow writes the Models screen and the Mac Update card make, and
/// the `autoUpdate` field the card reads.
final class FleetModelsClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        FleetSettingsRequestStub.statusCode = 200
        FleetSettingsRequestStub.responseBody = Data()
        FleetSettingsRequestStub.capturedRequest = nil
        FleetSettingsRequestStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FleetSettingsRequestStub.self]
        session = URLSession(configuration: configuration)
        client = CompanionClient(
            connection: Connection(name: "Mac", host: "127.0.0.1", port: 8810),
            token: "paired-token",
            session: session
        )
    }

    override func tearDown() {
        session.invalidateAndCancel()
        session = nil
        client = nil
        super.tearDown()
    }

    private static let configWithAutoUpdate = Data(#"""
    {"profile":{"name":"Ada","email":"ada@example.com"},
     "autoUpdate":{"enabled":true,"lastCheckMs":1760000000000,"due":false,"lastAppFingerprint":null}}
    """#.utf8)

    private func capturedJSON() throws -> [String: Any] {
        let data = try XCTUnwrap(FleetSettingsRequestStub.capturedBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - ConfigStatus.autoUpdate

    func testConfigDecodesAutoUpdate() throws {
        let config = try JSONDecoder().decode(ConfigStatus.self, from: Self.configWithAutoUpdate)
        XCTAssertEqual(config.autoUpdate?.enabled, true)
        XCTAssertEqual(config.autoUpdate?.lastCheckMs, 1_760_000_000_000)
    }

    func testConfigToleratesAMissingOrPartialAutoUpdate() throws {
        let older = try JSONDecoder().decode(ConfigStatus.self, from: Data(#"{"profile":{"name":"Ada","email":"a@b.c"}}"#.utf8))
        XCTAssertNil(older.autoUpdate, "absent is unknown, not off")

        let partial = try JSONDecoder().decode(
            ConfigStatus.self,
            from: Data(#"{"autoUpdate":{"enabled":false,"lastCheckMs":null}}"#.utf8)
        )
        XCTAssertEqual(partial.autoUpdate, ConfigAutoUpdate(enabled: false, lastCheckMs: nil))
    }

    // MARK: - PATCH /api/auto-update

    func testSetAutoUpdateSendsOnlyEnabledToItsOwnRoute() async throws {
        FleetSettingsRequestStub.responseBody = Self.configWithAutoUpdate

        let status = try await client.setAutoUpdate(enabled: true)

        let request = try XCTUnwrap(FleetSettingsRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/api/auto-update")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try capturedJSON()
        XCTAssertEqual(body.keys.sorted(), ["enabled"])
        XCTAssertEqual(body["enabled"] as? Bool, true)
        XCTAssertEqual(status.autoUpdate?.enabled, true)
    }

    func testSetAutoUpdateOnAnOlderMacIsTheUpdateYourMacOutcome() async throws {
        FleetSettingsRequestStub.statusCode = 404
        FleetSettingsRequestStub.responseBody = Data(#"{"error":"no route: PATCH /api/auto-update"}"#.utf8)

        do {
            _ = try await client.setAutoUpdate(enabled: false)
            XCTFail("a 404 must throw")
        } catch {
            XCTAssertEqual((error as? APIError)?.statusCode, 404)
            XCTAssertEqual(PhoneWriteOutcome<ConfigAutoUpdate>.failure(error), .needsMacUpdate)
        }
    }

    func testOtherRefusalsKeepTheHarnessSentence() {
        let busy = APIError.status(code: 409, message: "Ada is working right now")
        XCTAssertEqual(PhoneWriteOutcome<Int>.failure(busy), .failed("Ada is working right now"))
        XCTAssertEqual(PhoneWriteOutcome<Int>.failure(APIError.transport("offline")), .failed("offline"))
    }

    // MARK: - POST /api/bots/apply-model-defaults

    func testApplyModelDefaultsPostsTheFixedPlaceBody() async throws {
        FleetSettingsRequestStub.responseBody = Data(#"""
        {"ok":true,"applied":3,"skipped":[{"id":"b2","name":"Grace","reason":"busy"}]}
        """#.utf8)
        let fallbacks = DefaultModelSlots.withSlot(
            DefaultModelSlots.emptyFallbacks(),
            at: 1,
            DefaultModelSlot(instanceId: "codex", model: "gpt-5.5")
        )

        let result = try await client.applyModelDefaults(
            primary: DefaultModelSlot(instanceId: "claude", model: "claude-sonnet-4-6"),
            fallbacks: fallbacks
        )

        let request = try XCTUnwrap(FleetSettingsRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/bots/apply-model-defaults")
        let body = try capturedJSON()
        XCTAssertEqual(body.keys.sorted(), ["slots"])
        let slots = try XCTUnwrap(body["slots"] as? [String: Any])
        let primary = try XCTUnwrap(slots["primary"] as? [String: Any])
        XCTAssertEqual(primary["instanceId"] as? String, "claude")
        XCTAssertEqual(primary["model"] as? String, "claude-sonnet-4-6")
        let places = try XCTUnwrap(slots["fallbacks"] as? [Any])
        XCTAssertEqual(places.count, 3)
        XCTAssertTrue(places[0] is NSNull)
        XCTAssertEqual((places[1] as? [String: Any])?["instanceId"] as? String, "codex")
        XCTAssertTrue(places[2] is NSNull)

        XCTAssertEqual(result.applied, 3)
        XCTAssertEqual(result.skipped, [ApplyModelDefaultsResult.Skipped(id: "b2", name: "Grace", reason: "busy")])
    }
}
