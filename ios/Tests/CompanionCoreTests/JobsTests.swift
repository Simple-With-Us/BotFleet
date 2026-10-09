// Background jobs on the phone: the `jobs` frame, the list, the words, and the
// three requests (list, output, Stop).  The strings are pinned against the
// ones `shared/jobs.ts` and `JobsMenu.tsx` produce, because the phone and the
// Mac must say the same thing about the same job.
import Foundation
import XCTest
@testable import CompanionCore

private final class JobsRequestStub: URLProtocol {
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

final class JobsTests: XCTestCase {
    private let jobId = "job_01JABCDEFGHJKMNPQRSTVWXYZ0"

    private func jobJSON(
        id: String = "job_01JABCDEFGHJKMNPQRSTVWXYZ0",
        thread: String = "t1",
        status: String = "running",
        extra: String = ""
    ) -> String {
        """
        {"id":"\(id)","botId":"b1","threadId":"\(thread)","origin":"botfleet","kind":"shell","label":"pnpm test","cwd":"/work",
        "status":"\(status)","exitCode":null,"signal":null,"startedAt":1000,"endedAt":null,"timeoutMs":3600000,
        "onComplete":"wake","notice":"none"\(extra)}
        """
    }

    private func job(_ status: JobStatus, exit: Int? = nil, signal: String? = nil, killedBy: JobKilledBy? = nil, started: Double = 0, ended: Double? = nil, id: String = "job_a") -> JobSnapshot {
        JobSnapshot(id: id, botId: "b1", threadId: "t1", label: "x", status: status, exitCode: exit, signal: signal, startedAt: started, endedAt: ended, killedBy: killedBy)
    }

    // MARK: - Decoding

    func testAJobsFrameDecodesAndFoldsAsAFullSet() throws {
        let data = Data(#"{"kind":"jobs","seq":9,"threadId":"t1","jobs":[\#(jobJSON())]}"#.utf8)
        let frame = try JSONDecoder().decode(StreamFrame.self, from: data)
        guard case let .jobs(threadId, jobs) = frame.frame else { return XCTFail("expected .jobs") }
        XCTAssertEqual(threadId, "t1")
        XCTAssertEqual(jobs.map(\.id), [jobId])
        XCTAssertEqual(jobs.first?.status, .running)
        XCTAssertEqual(jobs.first?.label, "pnpm test")
        XCTAssertEqual(frame.seq, 9)

        var state = CompanionState()
        state.apply(frame)
        XCTAssertEqual(state.jobsByThread["t1"]?.count, 1)
        // The next frame is a replacement, not a diff.
        state.apply(.jobs(threadId: "t1", jobs: []))
        XCTAssertNil(state.jobsByThread["t1"], "an empty set leaves the conversation with no pill")
    }

    func testAJobsFrameDoesNotMoveTheHydrationFence() {
        // Jobs ride their own request.  A jobs frame landing while a fleet
        // snapshot loads must not make that snapshot look stale.
        var state = CompanionState()
        let token = state.hydrationToken
        state.apply(.jobs(threadId: "t1", jobs: [job(.running)]))
        XCTAssertTrue(state.hydrate(Fleet(bots: [], groups: []), ifUnchangedSince: token))
    }

    func testAStatusFromTheFutureDecodesAsUnknownInsteadOfDroppingTheFrame() throws {
        let data = Data(#"{"kind":"jobs","threadId":"t1","jobs":[\#(jobJSON(status: "paused"))]}"#.utf8)
        let frame = try JSONDecoder().decode(StreamFrame.self, from: data)
        guard case let .jobs(_, jobs) = frame.frame else { return XCTFail("expected .jobs") }
        XCTAssertEqual(jobs.first?.status, .unknown)
        XCTAssertEqual(jobs.first?.exitChip, "Unknown")
        XCTAssertFalse(jobs.first?.isActive ?? true)
    }

    func testAMalformedJobsFrameFoldsToUnknownRatherThanThrowing() throws {
        // A full set is a replacement, so a set with one unreadable job is not
        // folded at all: a partial one would drop a running job from the pill.
        for body in [
            #"{"kind":"jobs","threadId":"t1","jobs":[{"nope":true}]}"#,
            #"{"kind":"jobs","threadId":"t1","jobs":"none"}"#,
            #"{"kind":"jobs","jobs":[]}"#,
        ] {
            let frame = try JSONDecoder().decode(StreamFrame.self, from: Data(body.utf8))
            guard case let .unknown(kind) = frame.frame else { return XCTFail("expected .unknown for \(body)") }
            XCTAssertEqual(kind, "jobs")
        }
    }

    func testTheListLeavesOutAJobItCannotReadAndKeepsTheRest() throws {
        let body = #"{"jobs":[\#(jobJSON()),{"id":7},\#(jobJSON(id: "job_01JBBBBBBBBBBBBBBBBBBBBBBB", thread: "t2", status: "completed"))]}"#
        let list = try JSONDecoder().decode(JobListResponse.self, from: Data(body.utf8))
        XCTAssertEqual(list.jobs.map(\.threadId), ["t1", "t2"])
    }

    func testHydratingJobsGroupsThemByConversationAndReplacesWhatWasThere() {
        var state = CompanionState()
        state.setJobs([job(.running, id: "job_old")], forThread: "gone")
        state.hydrateJobs([
            JobSnapshot(id: "job_1", threadId: "t1", status: .running),
            JobSnapshot(id: "job_2", threadId: "t1", status: .completed),
            JobSnapshot(id: "job_3", threadId: "t2", status: .failed),
        ])
        XCTAssertEqual(state.jobsByThread["t1"]?.map(\.id), ["job_1", "job_2"])
        XCTAssertEqual(state.jobsByThread["t2"]?.map(\.id), ["job_3"])
        XCTAssertNil(state.jobsByThread["gone"])
    }

    func testDeletingABotDropsItsJobs() throws {
        let fleet = try JSONDecoder().decode(Fleet.self, from: Data(
            #"{"bots":[{"id":"b1","threadId":"t1","name":"Scout","title":"","description":"","notifications":false,"color":"green","unread":false,"modelSelection":{"instanceId":"dsh","model":"m"},"createdAt":1}],"groups":[]}"#.utf8
        ))
        var state = CompanionState()
        state.hydrate(fleet)
        state.setJobs([job(.running)], forThread: "t1")
        state.apply(.botDeleted(botId: "b1"))
        XCTAssertNil(state.jobsByThread["t1"])
    }

    func testTheOutputResponseReadsTheTextAndSaysWhenEarlierOutputExists() throws {
        let whole = try JSONDecoder().decode(
            JobOutputResponse.self,
            from: Data(#"{"job":\#(jobJSON()),"output":{"text":"ok\n","from":0,"to":3,"end":3,"dropped":0}}"#.utf8)
        )
        XCTAssertEqual(whole.output?.text, "ok\n")
        XCTAssertEqual(whole.output?.isTruncated, false)
        let cut = try JSONDecoder().decode(
            JobOutputResponse.self,
            from: Data(#"{"job":\#(jobJSON()),"output":{"text":"tail","from":65536,"to":65540,"end":65540,"dropped":0}}"#.utf8)
        )
        XCTAssertEqual(cut.output?.isTruncated, true)
        let rotated = try JSONDecoder().decode(
            JobOutputResponse.self,
            from: Data(#"{"output":{"text":"tail","from":0,"dropped":4096}}"#.utf8)
        )
        XCTAssertEqual(rotated.output?.isTruncated, true)
        let gone = try JSONDecoder().decode(JobOutputResponse.self, from: Data(#"{"job":\#(jobJSON()),"output":null}"#.utf8))
        XCTAssertNil(gone.output)
    }

    // MARK: - The words (shared/jobs.ts)

    func testDurationsReadTheWayTheMacReadsThem() {
        XCTAssertEqual(JobsDisplay.duration(ms: 12_000), "12s")
        XCTAssertEqual(JobsDisplay.duration(ms: 252_000), "4m 12s")
        XCTAssertEqual(JobsDisplay.duration(ms: 3_780_000), "1h 3m")
        XCTAssertEqual(JobsDisplay.duration(ms: 999), "0s")
        XCTAssertEqual(JobsDisplay.duration(ms: -5_000), "0s", "never negative")
        XCTAssertEqual(JobsDisplay.duration(ms: .nan), "0s")
    }

    func testTheExitChipSaysWhyAJobEnded() {
        XCTAssertEqual(job(.running).exitChip, "Running")
        XCTAssertEqual(job(.stopping).exitChip, "Stopping")
        XCTAssertEqual(job(.completed, exit: 0).exitChip, "Exited 0")
        XCTAssertEqual(job(.failed, exit: 2).exitChip, "Exited 2")
        XCTAssertEqual(job(.failed, signal: "SIGKILL").exitChip, "Ended by SIGKILL")
        XCTAssertEqual(job(.failed).exitChip, "Failed")
        // the limit is the news, not the 152
        XCTAssertEqual(job(.failed, exit: 152, signal: "SIGXCPU").exitChip, "CPU limit reached")
        XCTAssertEqual(job(.killed, killedBy: .owner).exitChip, "Killed by you")
        XCTAssertEqual(job(.killed, killedBy: .model).exitChip, "Stopped by the bot")
        XCTAssertEqual(job(.killed, killedBy: .timeout).exitChip, "Timed out")
        XCTAssertEqual(job(.killed, killedBy: .limit).exitChip, "Output limit")
        XCTAssertEqual(job(.killed, killedBy: .system).exitChip, "Stopped")
        XCTAssertEqual(job(.killed).exitChip, "Stopped")
        XCTAssertEqual(job(.lost).exitChip, "Lost after restart")
    }

    func testOnlyALimitOrACrashCountsAsAFailure() {
        XCTAssertTrue(job(.failed).endedBadly)
        XCTAssertTrue(job(.lost).endedBadly)
        XCTAssertTrue(job(.killed, killedBy: .timeout).endedBadly)
        XCTAssertTrue(job(.killed, killedBy: .limit).endedBadly)
        // a Stop, by anyone, is not one
        XCTAssertFalse(job(.killed, killedBy: .owner).endedBadly)
        XCTAssertFalse(job(.killed, killedBy: .model).endedBadly)
        XCTAssertFalse(job(.killed, killedBy: .system).endedBadly)
        XCTAssertFalse(job(.completed, exit: 0).endedBadly)
        XCTAssertFalse(job(.running).endedBadly)
    }

    func testAReasonShowsOnlyWhenTheChipDoesNotSayIt() {
        var limit = job(.killed, killedBy: .limit)
        limit.reason = "it printed faster than any log is read"
        XCTAssertEqual(limit.shownReason, "It printed faster than any log is read")
        var byYou = job(.killed, killedBy: .owner)
        byYou.reason = "stopped"
        XCTAssertNil(byYou.shownReason, "Killed by you needs no explanation")
        var running = job(.running)
        running.reason = "n/a"
        XCTAssertNil(running.shownReason)
        var done = job(.completed, exit: 0)
        done.reason = "n/a"
        XCTAssertNil(done.shownReason)
    }

    // MARK: - The pill

    func testRunningJobsFirstThenFinishedNewestFirst() {
        let sorted = JobsDisplay.sortedForDisplay([
            job(.completed, started: 10, ended: 100, id: "job_done_old"),
            job(.running, started: 50, id: "job_run_old"),
            job(.failed, started: 20, ended: 300, id: "job_done_new"),
            job(.stopping, started: 90, id: "job_run_new"),
        ])
        XCTAssertEqual(sorted.map(\.id), ["job_run_new", "job_run_old", "job_done_new", "job_done_old"])
    }

    func testAFinishedJobStaysForHalfAnHourAndThenLeavesTheHeader() {
        let ended = 1_000_000.0
        let finished = job(.completed, exit: 0, started: 0, ended: ended)
        XCTAssertEqual(JobsDisplay.visible([finished], now: ended + 30 * 60_000).count, 1, "the window is inclusive")
        XCTAssertEqual(JobsDisplay.visible([finished], now: ended + 30 * 60_000 + 1).count, 0)
        XCTAssertEqual(JobsDisplay.visible([job(.running)], now: 9e12).count, 1, "a running job never ages out")
    }

    func testThePillCountsRunningJobsElseTheRecentOnes() {
        let one = [job(.running), job(.completed, started: 0, ended: 5)]
        XCTAssertEqual(JobsDisplay.pillCount(one), 1)
        XCTAssertEqual(JobsDisplay.pillLabel(one), "1 Job")
        let none = [job(.completed, started: 0, ended: 5), job(.failed, started: 0, ended: 6)]
        XCTAssertEqual(JobsDisplay.pillCount(none), 2)
        XCTAssertEqual(JobsDisplay.pillLabel(none), "2 Jobs")
    }

    func testThePillDescriptionAndToneMatchTheMac() {
        let now = 1_000_000.0
        let jobs = [
            job(.running, id: "job_1"),
            job(.running, id: "job_2"),
            job(.failed, exit: 1, started: 0, ended: now - 60_000, id: "job_3"),
            job(.completed, exit: 0, started: 0, ended: now - 10 * 60_000, id: "job_4"),
        ]
        XCTAssertEqual(JobsDisplay.pillDescription(jobs, now: now), "2 running, 1 failed, 1 finished")
        XCTAssertEqual(JobsDisplay.pillTone(jobs, now: now), .failed)
        XCTAssertEqual(JobsDisplay.pillTone([job(.running)], now: now), .running)
        XCTAssertEqual(JobsDisplay.pillTone([job(.completed, exit: 0, started: 0, ended: now - 10 * 60_000)], now: now), .idle)
        // the dot fades after five minutes
        let old = job(.failed, exit: 1, started: 0, ended: now - 5 * 60_000 - 1)
        XCTAssertEqual(JobsDisplay.pillTone([old], now: now), .idle)
        XCTAssertEqual(JobsDisplay.pillDescription([old], now: now), "1 finished")
    }

    func testTheFooterUsesTheSentenceGap() {
        XCTAssertTrue(JobsDisplay.footer.contains(".\u{00A0} They end"))
        XCTAssertFalse(JobsDisplay.footer.contains("&nbsp;"))
    }

    // MARK: - Requests

    private func client() -> CompanionClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [JobsRequestStub.self]
        let connection = Connection(id: "c1", name: "Mac", host: "192.168.1.5", port: 4748)
        return CompanionClient(connection: connection, token: "tok", session: URLSession(configuration: configuration))
    }

    override func setUp() {
        JobsRequestStub.responseBody = Data()
        JobsRequestStub.statusCode = 200
        JobsRequestStub.capturedRequest = nil
        JobsRequestStub.capturedBody = nil
    }

    func testListingAsksForTheBareJobsRoute() async throws {
        JobsRequestStub.responseBody = Data(#"{"jobs":[\#(jobJSON())]}"#.utf8)
        let jobs = try await client().jobs()
        XCTAssertEqual(jobs.count, 1)
        XCTAssertEqual(JobsRequestStub.capturedRequest?.httpMethod, "GET")
        XCTAssertEqual(JobsRequestStub.capturedRequest?.url?.path, "/api/jobs")
        XCTAssertEqual(JobsRequestStub.capturedRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
    }

    func testOutputReadsTheOutputRouteOfThatJob() async throws {
        JobsRequestStub.responseBody = Data(#"{"output":{"text":"hi","from":0,"dropped":0}}"#.utf8)
        let response = try await client().jobOutput(id: jobId)
        XCTAssertEqual(response.output?.text, "hi")
        XCTAssertEqual(JobsRequestStub.capturedRequest?.httpMethod, "GET")
        XCTAssertEqual(JobsRequestStub.capturedRequest?.url?.path, "/api/jobs/\(jobId)/output")
    }

    func testStopPostsToThatJobWithAJSONBody() async throws {
        JobsRequestStub.statusCode = 202
        JobsRequestStub.responseBody = Data(#"{"job":\#(jobJSON(status: "stopping"))}"#.utf8)
        try await client().stopJob(id: jobId)
        XCTAssertEqual(JobsRequestStub.capturedRequest?.httpMethod, "POST")
        XCTAssertEqual(JobsRequestStub.capturedRequest?.url?.path, "/api/jobs/\(jobId)/stop")
        XCTAssertEqual(JobsRequestStub.capturedRequest?.value(forHTTPHeaderField: "Content-Type"), "application/json")
    }

    func testStoppingAJobThatAlreadyEndedIsTheOutcomeAskedFor() async throws {
        JobsRequestStub.statusCode = 409
        JobsRequestStub.responseBody = Data(#"{"error":"the job already ended","job":\#(jobJSON(status: "completed"))}"#.utf8)
        try await client().stopJob(id: jobId)
    }

    func testAnyOtherStopFailureStillThrows() async {
        JobsRequestStub.statusCode = 404
        JobsRequestStub.responseBody = Data(#"{"error":"no such job"}"#.utf8)
        do {
            try await client().stopJob(id: jobId)
            XCTFail("a 404 is a real failure")
        } catch let error as APIError {
            XCTAssertTrue(error.isNotFound)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testStopAllNamesTheConversation() async throws {
        JobsRequestStub.statusCode = 202
        JobsRequestStub.responseBody = Data(#"{"stopping":["job_a"]}"#.utf8)
        try await client().stopAllJobs(threadId: "t1")
        XCTAssertEqual(JobsRequestStub.capturedRequest?.httpMethod, "POST")
        XCTAssertEqual(JobsRequestStub.capturedRequest?.url?.path, "/api/jobs/stop")
        let sent = try XCTUnwrap(JobsRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: sent) as? [String: Any])
        XCTAssertEqual(body["threadId"] as? String, "t1")
    }
}
