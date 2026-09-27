import Foundation
import XCTest
@testable import CompanionCore

private final class ProfileRequestStub: URLProtocol {
    static var responseBody = Data()
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        Self.capturedBody = Self.readBody(from: request)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
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

final class ProfileClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        ProfileRequestStub.capturedRequest = nil
        ProfileRequestStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProfileRequestStub.self]
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

    func testProfilePatchEncodesMaxToolRoundsSetAndClear() throws {
        let setData = try JSONEncoder().encode(BotProfilePatch(maxToolRounds: .set(40)))
        let setBody = try XCTUnwrap(JSONSerialization.jsonObject(with: setData) as? [String: Any])
        XCTAssertEqual(setBody.keys.sorted(), ["maxToolRounds"])
        XCTAssertEqual((setBody["maxToolRounds"] as? NSNumber)?.intValue, 40)

        let clearData = try JSONEncoder().encode(BotProfilePatch(maxToolRounds: .clear))
        let clearBody = try XCTUnwrap(JSONSerialization.jsonObject(with: clearData) as? [String: Any])
        XCTAssertEqual(clearBody.keys.sorted(), ["maxToolRounds"])
        XCTAssertTrue(clearBody["maxToolRounds"] is NSNull)

        let omitted = try JSONEncoder().encode(BotProfilePatch())
        let omittedBody = try XCTUnwrap(JSONSerialization.jsonObject(with: omitted) as? [String: Any])
        XCTAssertNil(omittedBody["maxToolRounds"])
    }

    func testProfilePatchPreservesServerLimitsWithoutClientTruncation() throws {
        let name = String(repeating: "n", count: 100)
        let title = String(repeating: "t", count: 200)
        let description = String(repeating: "d", count: 4_000)
        let data = try JSONEncoder().encode(BotProfilePatch(
            name: name, title: title, description: description, voice: ""
        ))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(body["name"] as? String, name)
        XCTAssertEqual(body["title"] as? String, title)
        XCTAssertEqual(body["description"] as? String, description)
        XCTAssertEqual(body["voice"] as? String, "", "empty explicitly selects the workspace default")
    }

    func testProfileClientSendsOnlyFieldsOwnedByTheAction() async throws {
        ProfileRequestStub.responseBody = Self.botResponse

        _ = try await client.updateProfile(
            botId: "avatar-bot",
            patch: BotProfilePatch(avatarCrop: .rounded)
        )

        _ = try XCTUnwrap(ProfileRequestStub.capturedRequest)
        let data = try XCTUnwrap(ProfileRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body.keys.sorted(), ["avatarCrop"])
        XCTAssertEqual(body["avatarCrop"] as? String, "rounded")
    }

    func testProfileClientEncodesAnExplicitAvatarClearAsNull() async throws {
        ProfileRequestStub.responseBody = Self.botResponse

        _ = try await client.updateProfile(
            botId: "avatar-bot",
            patch: BotProfilePatch(avatarUrl: .clear, avatarCrop: .mascot)
        )

        _ = try XCTUnwrap(ProfileRequestStub.capturedRequest)
        let data = try XCTUnwrap(ProfileRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body.keys.sorted(), ["avatarCrop", "avatarUrl"])
        XCTAssertTrue(body["avatarUrl"] is NSNull)
        XCTAssertEqual(body["avatarCrop"] as? String, "mascot")
    }

    func testProfileClientPreservesPrimaryAndFallbackReasoningEffort() async throws {
        ProfileRequestStub.responseBody = Self.botResponse
        let selection = ModelSelection(
            instanceId: "codex",
            model: "gpt-6",
            effort: "future-ultra",
            fallbacks: [ModelSelection(instanceId: "claude", model: "opus", effort: "high")]
        )

        _ = try await client.updateProfile(
            botId: "avatar-bot",
            patch: BotProfilePatch(modelSelection: selection)
        )

        let data = try XCTUnwrap(ProfileRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body.keys.sorted(), ["modelSelection"])
        let primary = try XCTUnwrap(body["modelSelection"] as? [String: Any])
        XCTAssertEqual(primary["effort"] as? String, "future-ultra")
        let fallbacks = try XCTUnwrap(primary["fallbacks"] as? [[String: Any]])
        XCTAssertEqual(fallbacks.first?["effort"] as? String, "high")

        let roundTrip = try JSONDecoder().decode(ModelSelection.self, from: JSONEncoder().encode(selection))
        XCTAssertEqual(roundTrip, selection)
    }

    func testUserProfilePatchOmitsUnchangedSiblingFields() async throws {
        ProfileRequestStub.responseBody = Self.configResponse

        _ = try await client.updateProfile(name: "Ada")

        let nameOnly = try XCTUnwrap(ProfileRequestStub.capturedBody)
        let nameBody = try XCTUnwrap(JSONSerialization.jsonObject(with: nameOnly) as? [String: Any])
        XCTAssertEqual(nameBody.keys.sorted(), ["name"])
        XCTAssertEqual(nameBody["name"] as? String, "Ada")

        ProfileRequestStub.capturedBody = nil
        _ = try await client.updateProfile(email: "ada@example.com")

        let emailOnly = try XCTUnwrap(ProfileRequestStub.capturedBody)
        let emailBody = try XCTUnwrap(JSONSerialization.jsonObject(with: emailOnly) as? [String: Any])
        XCTAssertEqual(emailBody.keys.sorted(), ["email"])
        XCTAssertEqual(emailBody["email"] as? String, "ada@example.com")

        ProfileRequestStub.capturedBody = nil
        _ = try await client.updateProfile(name: "Ada", email: "ada@example.com")

        let both = try XCTUnwrap(ProfileRequestStub.capturedBody)
        let bothBody = try XCTUnwrap(JSONSerialization.jsonObject(with: both) as? [String: Any])
        XCTAssertEqual(bothBody.keys.sorted(), ["email", "name"])
    }

    func testAvatarGenerationRequestOutlivesTheServersImageTimeout() async throws {
        ProfileRequestStub.responseBody = Self.generatedAvatarResponse

        _ = try await client.generateAvatar(botId: "avatar-bot", prompt: "Friendly researcher")

        let request = try XCTUnwrap(ProfileRequestStub.capturedRequest)
        XCTAssertGreaterThan(request.timeoutInterval, 120)
    }

    private static let botJSON = """
    {
      "id":"avatar-bot","threadId":"avatar-thread","name":"Scout","title":"Researcher",
      "description":"Finds evidence.","notifications":true,"color":"blue",
      "avatarUrl":"/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp",
      "avatarCrop":"rounded","unread":false,
      "modelSelection":{"instanceId":"local","model":"default"},"createdAt":1786742441013
    }
    """

    private static let botResponse = Data("{\"bot\":\(botJSON)}".utf8)
    private static let generatedAvatarResponse = Data(
        "{\"avatarUrl\":\"/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp\",\"bot\":\(botJSON)}".utf8
    )
    private static let configResponse = Data("""
    {"profile":{"name":"Ada","email":"ada@example.com"},"conversationMode":"simple"}
    """.utf8)
}
