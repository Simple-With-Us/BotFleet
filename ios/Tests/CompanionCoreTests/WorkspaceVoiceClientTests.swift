import Foundation
import XCTest
@testable import CompanionCore

/// The phone's half of the workspace voice routes in server/index.ts
/// (PATCH /api/tts/default-voice and /api/tts/pronunciations, both allowed
/// through companion/src/routes.ts).  The harness tests send their own
/// bodies, so these pin what this client actually sends and reads.
private final class WorkspaceVoiceRequestStub: URLProtocol {
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

final class WorkspaceVoiceClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    private static let savedConfig = #"""
    {"tts":{"configured":true,"voice":"jay-wedgeworth-001","provider":"minimax",
      "pronunciations":[{"term":"SQL","say":"sequel"},{"term":"cron","say":"kron"}]}}
    """#

    override func setUp() {
        super.setUp()
        WorkspaceVoiceRequestStub.statusCode = 200
        WorkspaceVoiceRequestStub.responseBody = Data(Self.savedConfig.utf8)
        WorkspaceVoiceRequestStub.capturedRequest = nil
        WorkspaceVoiceRequestStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WorkspaceVoiceRequestStub.self]
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

    private func sentJSON() throws -> [String: Any] {
        let body = try XCTUnwrap(WorkspaceVoiceRequestStub.capturedBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    func testDefaultVoiceIsPatchedOnItsOwnRouteWithTheIdExactly() async throws {
        let status = try await client.updateDefaultVoice("jay-wedgeworth-001")

        let request = try XCTUnwrap(WorkspaceVoiceRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/api/tts/default-voice")
        let body = try sentJSON()
        XCTAssertEqual(body.keys.sorted(), ["voice"])
        // MiniMax ids are case-sensitive: sent exactly as picked.
        XCTAssertEqual(body["voice"] as? String, "jay-wedgeworth-001")
        XCTAssertEqual(status.workspaceDefaultVoice, "jay-wedgeworth-001")
    }

    func testPronunciationsArePatchedAsTermAndSayPairs() async throws {
        let list = [Pronunciation(term: "SQL", say: "sequel"), Pronunciation(term: "cron", say: "kron")]
        let status = try await client.updatePronunciations(list)

        let request = try XCTUnwrap(WorkspaceVoiceRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/api/tts/pronunciations")
        let body = try sentJSON()
        XCTAssertEqual(body.keys.sorted(), ["pronunciations"])
        let sent = try XCTUnwrap(body["pronunciations"] as? [[String: String]])
        XCTAssertEqual(sent, [["term": "SQL", "say": "sequel"], ["term": "cron", "say": "kron"]])
        XCTAssertEqual(status.pronunciations, list)
    }

    func testARefusalSurfacesTheHarnessSentence() async throws {
        WorkspaceVoiceRequestStub.statusCode = 400
        WorkspaceVoiceRequestStub.responseBody = Data(#"{"error":"sql is on the list twice."}"#.utf8)
        do {
            _ = try await client.updatePronunciations([Pronunciation(term: "SQL", say: "a"), Pronunciation(term: "sql", say: "b")])
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error.localizedDescription, "sql is on the list twice.")
        }

        WorkspaceVoiceRequestStub.responseBody = Data(#"{"error":"Personal Voices stay on the device that made them, so they cannot be the default."}"#.utf8)
        do {
            _ = try await client.updateDefaultVoice("personal:Jay")
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error.localizedDescription, BotVoice.personalVoiceNotDefault)
        }
    }

    func testConfigReadsTheDefaultVoiceAndListOrTheirAbsence() throws {
        let current = try JSONDecoder().decode(ConfigStatus.self, from: Data(Self.savedConfig.utf8))
        XCTAssertEqual(current.workspaceDefaultVoice, "jay-wedgeworth-001")
        XCTAssertEqual(current.pronunciations?.map(\.term), ["SQL", "cron"])

        // A computer older than the list sends neither a list nor, often, a
        // voice: the phone shows the default read-only and cannot edit.
        let older = try JSONDecoder().decode(ConfigStatus.self, from: Data(#"{"tts":{"configured":true}}"#.utf8))
        XCTAssertEqual(older.workspaceDefaultVoice, "")
        XCTAssertNil(older.pronunciations)
        let blank = try JSONDecoder().decode(ConfigStatus.self, from: Data(#"{"tts":{"configured":true,"voice":"  ","pronunciations":[]}}"#.utf8))
        XCTAssertEqual(blank.workspaceDefaultVoice, "")
        XCTAssertEqual(blank.pronunciations, [])
    }
}
