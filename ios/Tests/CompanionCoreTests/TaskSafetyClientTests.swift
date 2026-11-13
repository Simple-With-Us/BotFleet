import Foundation
import XCTest
@testable import CompanionCore

private final class TaskSafetyRequestStub: URLProtocol {
    struct Capture {
        let method: String?
        let path: String
        let body: Data?
    }

    static let lock = NSLock()
    static var captures: [Capture] = []
    static var failFirstTransport = false
    static var statusCode = 200
    static var responseBody = Data(#"{"ok":true}"#.utf8)

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        let body = Self.readBody(from: request)
        Self.captures.append(Capture(
            method: request.httpMethod,
            path: request.url?.path ?? "",
            body: body
        ))
        let attempt = Self.captures.count
        let shouldFail = Self.failFirstTransport && attempt == 1
        let statusCode = Self.statusCode
        let responseBody = Self.responseBody
        Self.lock.unlock()

        if shouldFail {
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
            return
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func reset(
        failFirstTransport: Bool = false,
        statusCode: Int = 200,
        responseBody: Data = Data(#"{"ok":true}"#.utf8)
    ) {
        lock.lock()
        captures = []
        self.failFirstTransport = failFirstTransport
        self.statusCode = statusCode
        self.responseBody = responseBody
        lock.unlock()
    }

    static func captured() -> [Capture] {
        lock.lock()
        defer { lock.unlock() }
        return captures
    }

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

final class TaskSafetyClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        TaskSafetyRequestStub.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TaskSafetyRequestStub.self]
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

    func testBotSendBindsDisplayedTaskAndPendingIdempotencyKey() async throws {
        _ = try await client.send(
            text: "Review this",
            toBot: "bot-1",
            threadId: "task-visible",
            idempotencyKey: "pending-uuid"
        )

        let request = try XCTUnwrap(TaskSafetyRequestStub.captured().only)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/api/bots/bot-1/messages")
        XCTAssertEqual(try json(request.body), [
            "idempotencyKey": "pending-uuid",
            "text": "Review this",
            "threadId": "task-visible",
        ])
    }

    func testRoomSendBindsDisplayedTaskAndPendingIdempotencyKey() async throws {
        try await client.send(
            text: "Compare options",
            toRoom: "room-1",
            threadId: "room-task-visible",
            idempotencyKey: "pending-room-uuid"
        )

        let request = try XCTUnwrap(TaskSafetyRequestStub.captured().only)
        XCTAssertEqual(request.path, "/api/groups/room-1/messages")
        XCTAssertEqual(try json(request.body), [
            "idempotencyKey": "pending-room-uuid",
            "text": "Compare options",
            "threadId": "room-task-visible",
        ])
    }

    func testRecordedSendLinksWAVAndOriginalTranscriptToTheTask() async throws {
        let recording = IncomingRecording(path: "/api/attachments/one.wav", transcript: "original")
        _ = try await client.send(
            text: "original", toBot: "bot-1", threadId: "task-visible",
            idempotencyKey: "pending-recorded", recording: recording
        )
        let request = try XCTUnwrap(TaskSafetyRequestStub.captured().only)
        XCTAssertEqual(request.path, "/api/bots/bot-1/messages")
        let raw = try XCTUnwrap(request.body)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: raw) as? [String: Any])
        XCTAssertEqual(body["text"] as? String, "original")
        XCTAssertEqual(body["threadId"] as? String, "task-visible")
        let linked = try XCTUnwrap(body["recording"] as? [String: String])
        XCTAssertEqual(linked["path"], "/api/attachments/one.wav")
        XCTAssertEqual(linked["transcript"], "original")
        XCTAssertEqual(linked["engine"], "apple-on-device")
    }

    func testInterruptBindsTheDisplayedTask() async throws {
        try await client.interrupt(botId: "bot-1", threadId: "task-visible")

        let request = try XCTUnwrap(TaskSafetyRequestStub.captured().only)
        XCTAssertEqual(request.path, "/api/bots/bot-1/interrupt")
        XCTAssertEqual(try json(request.body), ["threadId": "task-visible"])
    }

    func testRoomInterruptBindsTheDisplayedTask() async throws {
        try await client.interrupt(groupId: "room-1", threadId: "room-task-visible")

        let request = try XCTUnwrap(TaskSafetyRequestStub.captured().only)
        XCTAssertEqual(request.path, "/api/groups/room-1/interrupt")
        XCTAssertEqual(try json(request.body), ["threadId": "room-task-visible"])
    }

    func testRoomInterruptConflictIsReturnedWithoutRetrying() async throws {
        TaskSafetyRequestStub.reset(
            statusCode: 409,
            responseBody: Data(#"{"error":"the channel switched tasks before it could be interrupted"}"#.utf8)
        )

        do {
            try await client.interrupt(groupId: "room-1", threadId: "stale-room-task")
            XCTFail("expected task conflict")
        } catch let error as APIError {
            XCTAssertTrue(error.isConflict)
        }
        XCTAssertEqual(TaskSafetyRequestStub.captured().count, 1)
    }

    func testLostSendResponseRetriesOnceWithTheSameIdempotencyKey() async throws {
        TaskSafetyRequestStub.reset(failFirstTransport: true)

        _ = try await client.send(
            text: "Run once",
            toBot: "bot-1",
            threadId: "task-visible",
            idempotencyKey: "stable-key"
        )

        let requests = TaskSafetyRequestStub.captured()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].body, requests[1].body)
        XCTAssertEqual(try json(requests[1].body)["idempotencyKey"], "stable-key")
    }

    func testTaskConflictIsReturnedWithoutRetryingTheAction() async throws {
        TaskSafetyRequestStub.reset(
            statusCode: 409,
            responseBody: Data(#"{"error":"the bot switched tasks before it could receive the message"}"#.utf8)
        )

        do {
            _ = try await client.send(
                text: "Wrong task must stay untouched",
                toBot: "bot-1",
                threadId: "stale-task",
                idempotencyKey: "conflict-key"
            )
            XCTFail("expected task conflict")
        } catch let error as APIError {
            XCTAssertTrue(error.isConflict)
        }
        XCTAssertEqual(TaskSafetyRequestStub.captured().count, 1)
    }

    private func json(_ body: Data?) throws -> [String: String] {
        let data = try XCTUnwrap(body)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
    }
}

private extension Array {
    var only: Element? { count == 1 ? first : nil }
}
