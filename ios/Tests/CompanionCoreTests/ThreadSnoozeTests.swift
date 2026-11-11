// The phone's half of per-thread snooze.
//
// Two things to hold: the wire contract, where `0` is a real value and only
// JSON null wakes a thread, and the reading of "asleep" — which has to match
// `shared/thread-snooze.ts` exactly, because the sidebar and the phone both
// claim to be showing the same conversation.
import Foundation
import XCTest
@testable import CompanionCore

private final class SnoozeRequestStub: URLProtocol {
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
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
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

final class ThreadSnoozeClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        SnoozeRequestStub.capturedRequest = nil
        SnoozeRequestStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SnoozeRequestStub.self]
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

    func testSnoozeTravelsAsANumberOnTheThreadPatch() async throws {
        try await client.snoozeTask(botId: "scout", threadId: "thread-1", snoozedUntil: 0)
        XCTAssertEqual(
            try Self.body()["snoozedUntil"] as? Double, 0,
            "0 is the until-activity sentinel, a real value rather than an empty one"
        )

        try await client.snoozeTask(botId: "scout", threadId: "thread-1", snoozedUntil: 1_790_000_000_000)
        XCTAssertEqual(try Self.body()["snoozedUntil"] as? Double, 1_790_000_000_000)

        let request = try XCTUnwrap(SnoozeRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/api/bots/scout/tasks/thread-1")
        // The route is already on the companion allowlist as the task patch;
        // snoozing adds a field to it rather than a new door.
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer paired-token")
    }

    func testWakingTravelsAsNullRatherThanAnOmittedField() async throws {
        try await client.snoozeTask(botId: "scout", threadId: "thread-1", snoozedUntil: nil)

        // The harness reads an absent field as "leave the snooze alone", so
        // the key has to be present for a wake to mean anything.
        let body = try XCTUnwrap(Self.body())
        XCTAssertEqual(body.keys.sorted(), ["snoozedUntil"])
        XCTAssertTrue(body["snoozedUntil"] is NSNull)
    }

    private static func body() throws -> [String: Any] {
        let data = try XCTUnwrap(SnoozeRequestStub.capturedBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

final class ThreadSnoozeStateTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)
    private var nowMs: Double { now.timeIntervalSince1970 * 1_000 }

    private func task(
        _ threadId: String,
        lastActivity: Double? = nil,
        createdAt: Double = 0,
        snoozedUntil: Double? = nil
    ) -> BotTask {
        BotTask(
            threadId: threadId,
            title: threadId,
            createdAt: createdAt,
            lastActivity: lastActivity,
            snoozedUntil: snoozedUntil
        )
    }

    func testAbsentIsAwakeAndZeroIsTheSentinel() {
        XCTAssertFalse(task("t").isSnoozed(now: now))
        XCTAssertTrue(task("t", snoozedUntil: threadSnoozeUntilActivity).isSnoozed(now: now))
        // A year on it is still asleep: the sentinel is not a time.
        let muchLater = now.addingTimeInterval(365 * 86_400)
        XCTAssertTrue(task("t", snoozedUntil: threadSnoozeUntilActivity).isSnoozed(now: muchLater))
    }

    func testADeadlineSleepsOnlyUntilItPasses() {
        XCTAssertTrue(task("t", snoozedUntil: nowMs + 1).isSnoozed(now: now))
        XCTAssertFalse(task("t", snoozedUntil: nowMs).isSnoozed(now: now))
        XCTAssertFalse(task("t", snoozedUntil: nowMs - 1).isSnoozed(now: now))
    }

    func testTheBadgeNamesTheSentinelAndResolvesADeadline() {
        XCTAssertNil(task("t").snoozeLabel(now: now))
        XCTAssertNil(task("t", snoozedUntil: nowMs - 1).snoozeLabel(now: now))
        XCTAssertEqual(task("t", snoozedUntil: 0).snoozeLabel(now: now), "Until activity")

        let inAnHour = task("t", snoozedUntil: nowMs + 3_600_000).snoozeLabel(now: now)
        XCTAssertNotNil(inAnHour)
        XCTAssertTrue(inAnHour!.hasPrefix("Until "))
        // A resolved time, never the raw number it came from.
        XCTAssertFalse(inAnHour!.contains("1790"))
    }

    func testABadgePastMidnightCarriesItsWeekday() throws {
        let calendar = Calendar(identifier: .gregorian)
        let nextWeek = now.addingTimeInterval(3 * 86_400)
        let label = try XCTUnwrap(ThreadSnooze.label(
            nextWeek.timeIntervalSince1970 * 1_000,
            now: now,
            calendar: calendar,
            locale: Locale(identifier: "en_US")
        ))
        // "Until 8:00 AM" on a row that wakes three days out would be a lie.
        let weekday = DateFormatter()
        weekday.locale = Locale(identifier: "en_US")
        weekday.calendar = calendar
        weekday.setLocalizedDateFormatFromTemplate("EEE")
        XCTAssertTrue(label.contains(weekday.string(from: nextWeek)), label)
    }

    func testPresetsResolveInLocalTimeFromTheTapAndMatchTheDesktop() {
        XCTAssertEqual(ThreadSnoozePreset.hour(now: now), nowMs + 3_600_000)

        let calendar = Calendar(identifier: .gregorian)
        let morning = Date(timeIntervalSince1970: ThreadSnoozePreset.tomorrowMorning(
            now: now, calendar: calendar
        ) / 1_000)
        XCTAssertEqual(calendar.component(.hour, from: morning), ThreadSnoozePreset.morningHour)
        XCTAssertEqual(calendar.component(.minute, from: morning), 0)
        // Tomorrow morning, not this one and not next week.
        XCTAssertGreaterThan(morning, now)
        XCTAssertLessThan(morning.timeIntervalSince(now), 48 * 3_600)
    }

    func testSnoozedThreadsSinkAndWokenOnesComeBackToUpdateOrder() {
        let rows = [
            task("asleep", lastActivity: nowMs, snoozedUntil: nowMs + 1_000),
            task("awake", lastActivity: nowMs - 600_000),
        ]
        XCTAssertEqual(ThreadSnooze.ordered(rows, now: now).map(\.threadId), ["awake", "asleep"])

        // Nothing had to remember where it sat: the position is derived.
        let later = now.addingTimeInterval(2)
        XCTAssertEqual(ThreadSnooze.ordered(rows, now: later).map(\.threadId), ["asleep", "awake"])
    }

    func testTheOpenThreadStaysPutWhenItIsTheOneSnoozed() {
        let rows = [
            task("open", lastActivity: nowMs, snoozedUntil: threadSnoozeUntilActivity),
            task("other", lastActivity: nowMs - 600_000),
        ]
        XCTAssertEqual(
            ThreadSnooze.ordered(rows, now: now, keepInPlace: ["open"]).map(\.threadId),
            ["open", "other"]
        )
        XCTAssertEqual(ThreadSnooze.ordered(rows, now: now).map(\.threadId), ["other", "open"])
    }

    func testOrderIsStableAndFallsBackToCreatedAt() {
        let rows = [task("a", lastActivity: nowMs), task("b", lastActivity: nowMs), task("c", lastActivity: nowMs)]
        XCTAssertEqual(ThreadSnooze.ordered(rows, now: now).map(\.threadId), ["a", "b", "c"])
        XCTAssertEqual(ThreadSnooze.recency(task("d", createdAt: 5)), 5)
        XCTAssertEqual(ThreadSnooze.recency(task("d", lastActivity: 9, createdAt: 5)), 9)
    }

    func testAnOlderHarnessThatNeverHeardOfSnoozeStillDecodes() throws {
        let json = Data("""
        {"threadId":"t1","title":"Nightly","createdAt":1}
        """.utf8)
        let decoded = try JSONDecoder().decode(BotTask.self, from: json)
        XCTAssertNil(decoded.snoozedUntil)
        XCTAssertFalse(decoded.isSnoozed(now: now))
    }
}
