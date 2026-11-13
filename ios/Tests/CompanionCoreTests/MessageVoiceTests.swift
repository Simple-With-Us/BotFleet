import Foundation
import XCTest
@testable import CompanionCore

private final class VoiceRequestStub: URLProtocol {
    static var status = 200
    static var responseBody = Data()
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        Self.capturedBody = request.httpBody ?? request.httpBodyStream.map(Self.read)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: Self.status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

final class MessageVoiceTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        VoiceRequestStub.status = 200
        VoiceRequestStub.responseBody = Data()
        VoiceRequestStub.capturedRequest = nil
        VoiceRequestStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [VoiceRequestStub.self]
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

    // MARK: - Response shapes

    private func decode(_ json: String) throws -> MessageVoice {
        try JSONDecoder().decode(MessageVoice.self, from: Data(json.utf8))
    }

    func testAnOlderHarnessAnswerIsCompleteWithEveryClip() throws {
        let legacy = try decode(#"{"audio":[{"path":"a.mp3","mime":"audio/mpeg"},{"path":"b.mp3","mime":"audio/mpeg"}]}"#)
        XCTAssertEqual(legacy.clipCount, 2)
        XCTAssertFalse(legacy.speaksOnDevice)
    }

    func testAProgressiveAnswerWithNoClipsIsNotOnDeviceSpeech() throws {
        let pending = try decode(#"{"audio":[],"voiceText":"Hi.","utterances":["Hi."],"total":3,"complete":false,"voice":"vx"}"#)
        XCTAssertFalse(pending.speaksOnDevice, "audio: [] means not ready yet; only onDevice means speak locally")
        XCTAssertEqual(pending.clipCount, 3)
        XCTAssertEqual(pending.voice, "vx")
    }

    func testAPersonalVoiceAnswerCarriesTheProjectedUtterances() throws {
        let personal = try decode(
            #"{"audio":[],"voiceText":"One. Two.","utterances":["One.","Two."],"total":2,"complete":true,"onDevice":true,"personalVoice":true,"voice":"personal:abc"}"#
        )
        XCTAssertTrue(personal.speaksOnDevice)
        XCTAssertEqual(personal.utterances, ["One.", "Two."])
        XCTAssertEqual(personal.voice, "personal:abc")
    }

    // MARK: - Requests

    func testTheAudioRequestNamesTheDeviceAndAsksForProgressiveClips() async throws {
        VoiceRequestStub.responseBody = Data(#"{"audio":[],"total":4,"complete":false}"#.utf8)
        let answer = try await client.messageVoice(threadId: "t-1", messageId: "m_2", device: .iphone, progressive: true)
        XCTAssertEqual(answer.clipCount, 4)

        let request = try XCTUnwrap(VoiceRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/threads/t-1/messages/m_2/audio")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertGreaterThanOrEqual(request.timeoutInterval, 150)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(VoiceRequestStub.capturedBody)) as? [String: Any])
        XCTAssertEqual(body["device"] as? String, "iphone")
        XCTAssertEqual(body["progressive"] as? Bool, true)
        // Karaoke: the script kind and, for a reply read as written, its spans.
        XCTAssertEqual(body["spans"] as? Bool, true)
    }

    func testAClipRequestNamesTheSameDeviceAndOutlastsTheServerWait() async throws {
        VoiceRequestStub.responseBody = Data([0x49, 0x44, 0x33])
        let data = try await client.voiceClip(threadId: "t-1", messageId: "m_2", index: 3, device: .iphone)
        XCTAssertEqual(data, Data([0x49, 0x44, 0x33]))
        let request = try XCTUnwrap(VoiceRequestStub.capturedRequest)
        XCTAssertEqual(request.url?.path, "/api/threads/t-1/messages/m_2/audio/3")
        XCTAssertEqual(request.url?.query, "device=iphone")
        XCTAssertGreaterThanOrEqual(request.timeoutInterval, 25, "the harness holds a clip GET for up to 15 seconds")
    }

    func testAClipStillBeingMadeSurfacesAsRetryableStatus() async throws {
        VoiceRequestStub.status = 425
        VoiceRequestStub.responseBody = Data(#"{"error":"This voice clip is still being prepared.","retryable":true,"ready":1,"total":4}"#.utf8)
        do {
            _ = try await client.voiceClip(threadId: "t", messageId: "m", index: 1, device: .iphone)
            XCTFail("a 425 must not decode as audio")
        } catch let error as APIError {
            XCTAssertEqual(error.statusCode, 425)
        }
    }

    // MARK: - Clip retries

    func testNotReadyRetriesAreBounded() {
        var policy = VoiceClipFetchPolicy()
        for _ in 0..<VoiceClipFetchPolicy.maxNotReadyRetries {
            XCTAssertEqual(policy.decide(statusCode: 425), .retry(after: 1))
        }
        XCTAssertEqual(policy.decide(statusCode: 425), .fail)
    }

    func testAForgottenJobIsResumedOnceThenAbandoned() {
        var policy = VoiceClipFetchPolicy()
        XCTAssertEqual(policy.decide(statusCode: 404), .resume)
        XCTAssertEqual(policy.decide(statusCode: 404), .fail)
    }

    func testAFailedJobIsNotRetried() {
        var policy = VoiceClipFetchPolicy()
        XCTAssertEqual(policy.decide(statusCode: 502), .fail)
        XCTAssertEqual(policy.decide(statusCode: 409), .fail)
        XCTAssertEqual(policy.decide(statusCode: 400), .fail)
    }

    func testATransportErrorIsRetriedOnce() {
        var policy = VoiceClipFetchPolicy()
        XCTAssertEqual(policy.decide(statusCode: nil), .retry(after: 1))
        XCTAssertEqual(policy.decide(statusCode: nil), .fail)
    }
}
