// The phone's calls for Approve All, channel tasks, and routine run controls.
// Each one is a route the companion sidecar allows (companion/src/routes.ts);
// these prove the app asks for exactly that route, with that method and body,
// and reads the harness's answer the way the harness gives it.
import Foundation
import XCTest
@testable import CompanionCore

private final class ParityRequestStub: URLProtocol {
    struct Capture {
        let method: String?
        let path: String
        let body: Data?
        let authorization: String?
    }

    static let lock = NSLock()
    static var captures: [Capture] = []
    static var statusCode = 200
    static var responseBody = Data(#"{"ok":true}"#.utf8)

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.captures.append(Capture(
            method: request.httpMethod,
            path: request.url?.path ?? "",
            body: Self.readBody(from: request),
            authorization: request.value(forHTTPHeaderField: "Authorization")
        ))
        let statusCode = Self.statusCode
        let responseBody = Self.responseBody
        Self.lock.unlock()

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

    static func reset(statusCode: Int = 200, responseBody: String = #"{"ok":true}"#) {
        lock.lock()
        captures = []
        self.statusCode = statusCode
        self.responseBody = Data(responseBody.utf8)
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

final class ParityClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        ParityRequestStub.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ParityRequestStub.self]
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

    private func onlyCapture(file: StaticString = #filePath, line: UInt = #line) throws -> ParityRequestStub.Capture {
        let captures = ParityRequestStub.captured()
        XCTAssertEqual(captures.count, 1, file: file, line: line)
        return try XCTUnwrap(captures.first, file: file, line: line)
    }

    private func jsonObject(_ data: Data?) throws -> [String: Any] {
        let body = try XCTUnwrap(data)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    // MARK: - Approve All

    func testApproveAllPostsToTheThreadRouteAndReturnsTheApprovedCount() async throws {
        ParityRequestStub.reset(responseBody: #"{"ok":true,"approvedCount":3}"#)

        let approved = try await client.approveAll(threadId: "th_1")

        XCTAssertEqual(approved, 3)
        let call = try onlyCapture()
        XCTAssertEqual(call.method, "POST")
        XCTAssertEqual(call.path, "/api/threads/th_1/approve-all")
        XCTAssertEqual(call.authorization, "Bearer paired-token")
    }

    func testApproveAllToleratesAnAnswerWithoutACount() async throws {
        ParityRequestStub.reset(responseBody: #"{"ok":true}"#)
        let approved = try await client.approveAll(threadId: "th_1")
        XCTAssertEqual(approved, 0)
    }

    func testApproveAllSurfacesTheHarnessSentenceOnFailure() async {
        ParityRequestStub.reset(statusCode: 404, responseBody: #"{"error":"no route: POST /api/threads/th_1/approve-all"}"#)
        do {
            _ = try await client.approveAll(threadId: "th_1")
            XCTFail("expected a failure")
        } catch let error as APIError {
            XCTAssertTrue(error.isNotFound)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    // MARK: - Channel tasks

    private let roomJSON = """
    {"group":{"id":"room-1","threadId":"th_new","name":"Launch","memberIds":["bot-1"],
      "defaultResponder":{"kind":"everyone"},"bulletin":"","unread":false,"createdAt":1,
      "tasks":[{"threadId":"th_old","title":"Main","createdAt":1},
               {"threadId":"th_new","title":"Fresh","createdAt":2}],
      "messages":[{"id":"m1","role":"user","kind":"text","at":5,"text":"hello"}]}}
    """

    func testCreatingAChannelTaskPostsTheTitleAndReturnsTheRoomWithItsTranscript() async throws {
        ParityRequestStub.reset(responseBody: roomJSON)

        let room = try await client.createRoomTask(roomId: "room-1", title: "Fresh")

        let call = try onlyCapture()
        XCTAssertEqual(call.method, "POST")
        XCTAssertEqual(call.path, "/api/groups/room-1/tasks")
        XCTAssertEqual(try jsonObject(call.body) as? [String: String], ["title": "Fresh"])
        XCTAssertEqual(room.threadId, "th_new")
        XCTAssertEqual(room.tasks?.map(\.title), ["Main", "Fresh"])
        XCTAssertEqual(room.messages?.first?.text, "hello")
    }

    func testCreatingAChannelTaskWithoutATitleSendsAnEmptyObject() async throws {
        ParityRequestStub.reset(responseBody: roomJSON)
        _ = try await client.createRoomTask(roomId: "room-1", title: nil)
        let call = try onlyCapture()
        XCTAssertEqual(try jsonObject(call.body).count, 0)
    }

    func testSwitchingRenamingAndDeletingAChannelTaskUseTheirOwnMethods() async throws {
        ParityRequestStub.reset(responseBody: roomJSON)
        _ = try await client.switchRoomTask(roomId: "room-1", threadId: "th_old")
        _ = try await client.deleteRoomTask(roomId: "room-1", threadId: "th_old")
        try await client.renameRoomTask(roomId: "room-1", threadId: "th_old", title: "Renamed")

        let calls = ParityRequestStub.captured()
        XCTAssertEqual(calls.map { $0.method }, ["POST", "DELETE", "PATCH"])
        XCTAssertEqual(calls.map { $0.path }, [
            "/api/groups/room-1/tasks/th_old",
            "/api/groups/room-1/tasks/th_old",
            "/api/groups/room-1/tasks/th_old",
        ])
        XCTAssertNil(calls[0].body)
        XCTAssertEqual(try jsonObject(calls[2].body) as? [String: String], ["title": "Renamed"])
    }

    func testAChannelThatRefusesBecauseItIsBusyReachesThePersonInTheHarnessWords() async {
        ParityRequestStub.reset(
            statusCode: 409,
            responseBody: #"{"error":"this channel is working or waiting on you — finish that turn first"}"#
        )
        do {
            _ = try await client.createRoomTask(roomId: "room-1", title: nil)
            XCTFail("expected a failure")
        } catch let error as APIError {
            XCTAssertTrue(error.isConflict)
            XCTAssertEqual(error.errorDescription, "this channel is working or waiting on you — finish that turn first")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    // MARK: - Routine run controls

    private let runJSON = """
    {"run":{"id":"run_1","routineId":"r1","routineName":"Nightly","botId":"b1","runOn":"bot",
      "scheduledFor":10,"status":"cancelled","manual":false,"createdAt":9,"seenAt":12}}
    """

    func testCancellingARunPostsToItsCancelRoute() async throws {
        ParityRequestStub.reset(responseBody: runJSON)

        let run = try await client.cancelRoutineRun(id: "run_1")

        let call = try onlyCapture()
        XCTAssertEqual(call.method, "POST")
        XCTAssertEqual(call.path, "/api/routine-runs/run_1/cancel")
        XCTAssertEqual(run.status, "cancelled")
    }

    func testMarkingARunSeenPostsToItsSeenRoute() async throws {
        ParityRequestStub.reset(responseBody: runJSON)

        let run = try await client.markRoutineRunSeen(id: "run_1")

        let call = try onlyCapture()
        XCTAssertEqual(call.method, "POST")
        XCTAssertEqual(call.path, "/api/routine-runs/run_1/seen")
        XCTAssertEqual(run.seenAt, 12)
    }

    func testMarkingEveryFailureSeenPostsTheBareSweepWithNoFilter() async throws {
        ParityRequestStub.reset(responseBody: """
        {"acknowledged":1,"runs":[{"id":"run_2","routineId":"r1","routineName":"Nightly","botId":"b1",
          "runOn":"bot","scheduledFor":10,"status":"failed","manual":false,"createdAt":9,"seenAt":12}]}
        """)

        let marked = try await client.markAllRoutineRunsSeen()

        let call = try onlyCapture()
        XCTAssertEqual(call.method, "POST")
        XCTAssertEqual(call.path, "/api/routine-runs/seen")
        // No trigger filter: the phone acknowledges the whole backlog or nothing.
        XCTAssertNil(call.body)
        XCTAssertEqual(marked.map(\.id), ["run_2"])
    }

    func testACancelOnARunThatAlreadySettledIsNotFound() async {
        ParityRequestStub.reset(statusCode: 404, responseBody: #"{"error":"no such active run"}"#)
        do {
            _ = try await client.cancelRoutineRun(id: "run_1")
            XCTFail("expected a failure")
        } catch let error as APIError {
            XCTAssertTrue(error.isNotFound)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }
}
