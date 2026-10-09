// The decisions behind Approve All, Duplicate Bot, channel tasks, routine run
// controls and the cloud desktop button — the parts that choose whether a
// control appears or what a request carries, without any network.
import Foundation
import XCTest
@testable import CompanionCore

final class ParityLogicTests: XCTestCase {
    // MARK: - Fixtures

    private func decodeBot(_ extra: String = "", name: String = "Scout") throws -> Bot {
        try JSONDecoder().decode(Bot.self, from: Data("""
        {"id":"b1","threadId":"t1","name":"\(name)","title":"Researcher","description":"Reads things",
         "notifications":false,"color":"cyan","unread":false,"createdAt":1,
         "modelSelection":{"instanceId":"claude","model":"sonnet","effort":"high",
           "fallbacks":[{"instanceId":"codex","model":"gpt"}]}\(extra)}
        """.utf8))
    }

    private func decodeRoom(threadId: String, working: Bool = false, messages: String = "[]") throws -> Room {
        try JSONDecoder().decode(Room.self, from: Data("""
        {"id":"room-1","threadId":"\(threadId)","name":"Launch","memberIds":["b1"],
         "defaultResponder":{"kind":"everyone"},"bulletin":"","unread":false,"createdAt":1,
         "working":\(working),"messages":\(messages)}
        """.utf8))
    }

    private func card(
        _ id: String,
        at: Double = 1,
        tool: String? = "Bash",
        requestId: String? = nil,
        answered: String? = nil,
        dismissed: Bool = false
    ) -> Message {
        var message = Message(id: id, role: .bot, kind: .options, at: at)
        message.card = OptionCard(
            title: "Run it?",
            subtitle: "ls",
            options: ["Approve", "Deny"],
            answered: answered,
            dismissed: dismissed ? true : nil,
            requestId: requestId ?? "req-\(id)",
            tool: tool
        )
        return message
    }

    // MARK: - Approve All

    func testApproveAllIsNotOfferedForASinglePermissionRequest() {
        XCTAssertNil(ApproveAll.offer(in: [card("a")]))
        XCTAssertNil(ApproveAll.offer(in: []))
    }

    func testApproveAllIsOfferedOnTheNewestOfSeveralWaitingPermissions() throws {
        let offer = try XCTUnwrap(ApproveAll.offer(in: [card("a", at: 1), card("b", at: 2), card("c", at: 3)]))
        XCTAssertEqual(offer.messageId, "c")
        XCTAssertEqual(offer.count, 3)
        XCTAssertEqual(ApproveAll.label(count: offer.count), "Approve All (3)")
    }

    func testApproveAllCountsPermissionsOnlyBecauseTheRouteApprovesOnlyThose() throws {
        // A question has no tool; the harness's approve-all skips it, so it must
        // not inflate the count or be the only thing that makes the button appear.
        XCTAssertNil(ApproveAll.offer(in: [card("q1", tool: nil), card("q2", tool: nil), card("p1")]))
        let offer = try XCTUnwrap(ApproveAll.offer(in: [card("p1"), card("q1", tool: nil), card("p2")]))
        XCTAssertEqual(offer.count, 2)
        XCTAssertEqual(offer.messageId, "p2")
    }

    func testApproveAllIgnoresAnsweredAndDismissedCards() {
        let messages = [
            card("done", answered: "Approve"),
            card("gone", dismissed: true),
            card("live"),
        ]
        XCTAssertNil(ApproveAll.offer(in: messages))
        XCTAssertEqual(ApproveAll.pendingPermissions(in: messages).map(\.id), ["live"])
    }

    // MARK: - Duplicate Bot

    /// Mirrors `COMPANION_PROFILE_PATCH_FIELDS` in companion/src/routes.ts, the
    /// whole-request boundary the sidecar enforces.  The sidecar rejects a body
    /// with any other key, so Duplicate must stay inside it.  A matching
    /// companion test proves the TypeScript list still accepts these keys.
    private let allowedProfileFields: Set<String> = [
        "name", "title", "description", "notifications", "avatarUrl", "avatarCrop",
        "voice", "voices", "speakReplies", "speechDevices", "modelSelection",
    ]

    private func encodedKeys(_ patch: BotProfilePatch) throws -> [String: Any] {
        let data = try JSONEncoder().encode(patch)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testDuplicateCopiesOnlyWhatThePairedPhoneIsAllowedToSet() throws {
        let source = try decodeBot(#","avatarUrl":"/api/attachments/face.png","avatarCrop":"circle","voice":"English_Graceful_Lady""#)
        let body = try encodedKeys(BotDuplicate.profilePatch(from: source))

        XCTAssertTrue(Set(body.keys).isSubset(of: allowedProfileFields), "\(body.keys.sorted())")
        XCTAssertEqual(body["name"] as? String, "Scout copy")
        XCTAssertEqual(body["title"] as? String, "Researcher")
        XCTAssertEqual(body["description"] as? String, "Reads things")
        XCTAssertEqual(body["notifications"] as? Bool, false)
        XCTAssertEqual(body["avatarUrl"] as? String, "/api/attachments/face.png")
        XCTAssertEqual(body["avatarCrop"] as? String, "circle")
        XCTAssertEqual(body["voice"] as? String, "English_Graceful_Lady")

        let model = try XCTUnwrap(body["modelSelection"] as? [String: Any])
        XCTAssertEqual(model["instanceId"] as? String, "claude")
        XCTAssertEqual(model["effort"] as? String, "high")
        let fallbacks = try XCTUnwrap(model["fallbacks"] as? [[String: Any]])
        XCTAssertEqual(fallbacks.first?["model"] as? String, "gpt")
    }

    func testDuplicateNeverSendsAnUnsetFieldAsNull() throws {
        // A bot with no custom avatar or voice: sending avatarUrl as null would
        // clear a field on a bot that never had one, and the harness reads an
        // absent key as "leave it alone".
        let source = try decodeBot()
        let body = try encodedKeys(BotDuplicate.profilePatch(from: source))

        XCTAssertNil(body["avatarUrl"])
        XCTAssertNil(body["voice"])
        XCTAssertNil(body["voices"])
        XCTAssertFalse(body.values.contains { $0 is NSNull })
        XCTAssertTrue(Set(body.keys).isSubset(of: allowedProfileFields))
    }

    func testDuplicateLeavesOutEverythingThePhoneCannotSet() throws {
        let source = try decodeBot(#","computers":["cloud"],"cloudBackend":"vps","autoStartVps":true,"cwd":"/Users/me/work","autoApprove":true,"composio":true"#)
        let body = try encodedKeys(BotDuplicate.profilePatch(from: source))

        for field in ["computers", "cloudBackend", "autoStartVps", "cwd", "extraCwds", "autoApprove",
                      "autoReview", "approvePeerComms", "composio", "section", "maxToolRounds"] {
            XCTAssertNil(body[field], field)
        }
    }

    func testDuplicateNamesTheCopyTheWayTheDesktopDoes() throws {
        XCTAssertEqual(BotDuplicate.name(for: try decodeBot()), "Scout copy")
        XCTAssertEqual(BotDuplicate.name(for: try decodeBot(name: "  Scout  ")), "Scout copy")
    }

    func testDuplicateShortensALongNameSoTheHarnessDoesNotRefuseIt() throws {
        let long = String(repeating: "a", count: 100)
        let name = BotDuplicate.name(for: try decodeBot(name: long))
        XCTAssertLessThanOrEqual(name.utf16.count, BotDuplicate.nameLimit)
        XCTAssertTrue(name.hasSuffix(" copy"))
        XCTAssertTrue(name.hasPrefix("aaaa"))
    }

    func testDuplicateSaysWhatItDidNotCopy() {
        XCTAssertTrue(BotDuplicate.notCopiedNote.contains("Computers"))
        XCTAssertTrue(BotDuplicate.notCopiedNote.contains("folders"))
        XCTAssertTrue(BotDuplicate.notCopiedNote.contains("Mac"))
        // Rendered copy: a no-break space and a space between sentences.
        XCTAssertTrue(BotDuplicate.notCopiedNote.contains(".\u{00A0} "))
        XCTAssertFalse(BotDuplicate.summary.contains("agent"))
    }

    // MARK: - Cloud desktop

    func testNoCloudComputerMeansNothingToShowOrExplain() throws {
        XCTAssertEqual(try decodeBot().cloudDesktopAvailability, .notCloud)
        XCTAssertEqual(try decodeBot(#","computers":["local"]"#).cloudDesktopAvailability, .notCloud)
    }

    func testABotOnTheHostedBoxCanOpenItsDesktop() throws {
        // No backend anywhere: an unconfigured install uses the hosted Box.
        XCTAssertEqual(try decodeBot(#","computers":["cloud"]"#).cloudDesktopAvailability, .available)
        XCTAssertEqual(
            try decodeBot(#","computers":["cloud"],"cloudBackend":"box","effectiveCloudBackend":"box""#).cloudDesktopAvailability,
            .available
        )
    }

    func testABotThatInheritsAVpsDefaultIsExplainedNotOffered() throws {
        // The bug: no backend of its own, workspace default "vps".  The raw
        // value is absent, so the old check showed a button that answered 409.
        let inheriting = try decodeBot(#","computers":["cloud"],"effectiveCloudBackend":"vps""#)
        XCTAssertNil(inheriting.cloudBackend)
        XCTAssertEqual(inheriting.cloudDesktopAvailability, .unavailable(.ownServer))
    }

    func testTheResolvedBackendWinsOverTheStoredOne() throws {
        let bot = try decodeBot(#","computers":["cloud"],"cloudBackend":"box","effectiveCloudBackend":"vps""#)
        XCTAssertEqual(bot.resolvedCloudBackend, "vps")
        XCTAssertEqual(bot.cloudDesktopAvailability, .unavailable(.ownServer))
    }

    func testAnOlderHarnessWithoutTheResolvedFieldFallsBackToTheStoredBackend() throws {
        let pinned = try decodeBot(#","computers":["cloud"],"cloudBackend":"vps""#)
        XCTAssertNil(pinned.effectiveCloudBackend)
        XCTAssertEqual(pinned.cloudDesktopAvailability, .unavailable(.ownServer))
    }

    func testABackendThisBuildDoesNotKnowIsNeverOffered() throws {
        let bot = try decodeBot(#","computers":["cloud"],"effectiveCloudBackend":"daytona""#)
        XCTAssertEqual(bot.cloudDesktopAvailability, .unavailable(.otherBackend))
    }

    func testTheReasonIsRenderedCopyWithTheSentenceGap() {
        for reason in [CloudDesktopAvailability.Reason.ownServer, .otherBackend] {
            XCTAssertTrue(reason.message.contains(".\u{00A0} "), "\(reason)")
            XCTAssertTrue(reason.message.contains("bot"))
            XCTAssertFalse(reason.message.contains("agent"))
        }
    }

    // MARK: - Channel tasks in the fold

    func testSwitchingAChannelTaskReplacesTheTranscriptWithTheNewThreads() throws {
        var state = CompanionState()
        state.hydrate(Fleet(bots: [], groups: [
            try decodeRoom(threadId: "th_old", messages: #"[{"id":"old1","role":"user","kind":"text","at":1,"text":"old"}]"#),
        ]))
        XCTAssertEqual(state.transcript(forThread: "th_old").map(\.id), ["old1"])

        state.apply(.room(try decodeRoom(
            threadId: "th_new",
            messages: #"[{"id":"new1","role":"user","kind":"text","at":2,"text":"fresh"}]"#
        )))

        XCTAssertEqual(state.rooms.first?.threadId, "th_new")
        XCTAssertEqual(state.transcript(forThread: "th_new").map(\.id), ["new1"])
    }

    func testAnOrdinaryRoomFrameKeepsTheTranscriptItAlreadyHas() throws {
        var state = CompanionState()
        state.hydrate(Fleet(bots: [], groups: [
            try decodeRoom(threadId: "th_old", messages: #"[{"id":"old1","role":"user","kind":"text","at":1,"text":"old"}]"#),
        ]))

        // Same thread, and a frame that carries different messages: unchanged.
        state.apply(.room(try decodeRoom(
            threadId: "th_old",
            messages: #"[{"id":"other","role":"user","kind":"text","at":9,"text":"x"}]"#
        )))

        XCTAssertEqual(state.transcript(forThread: "th_old").map(\.id), ["old1"])
    }

    func testChannelTaskChangesWaitForAWorkingChannelOrAWaitingRequest() throws {
        var state = CompanionState()
        state.hydrate(Fleet(bots: [], groups: [try decodeRoom(threadId: "th_1")]))
        let idle = try XCTUnwrap(state.rooms.first)
        XCTAssertFalse(state.roomTaskChangesBlocked(idle))

        let working = try decodeRoom(threadId: "th_1", working: true)
        XCTAssertTrue(state.roomTaskChangesBlocked(working))

        state.apply(.message(threadId: "th_1", message: card("ask")))
        XCTAssertTrue(state.roomTaskChangesBlocked(idle))
    }

    // MARK: - Routine runs

    private func run(status: String, seenAt: Double? = nil) throws -> RoutineRun {
        let seen = seenAt.map { #","seenAt":\#($0)"# } ?? ""
        return try JSONDecoder().decode(RoutineRun.self, from: Data("""
        {"id":"run_1","routineId":"r1","routineName":"Nightly","botId":"b1","runOn":"bot",
         "scheduledFor":10,"status":"\(status)","manual":false,"createdAt":9\(seen)}
        """.utf8))
    }

    func testOnlyARunThatIsStillGoingCanBeCancelled() throws {
        for status in ["queued", "running", "waiting"] {
            XCTAssertTrue(try run(status: status).canCancel, status)
        }
        for status in ["completed", "failed", "missed", "cancelled"] {
            XCTAssertFalse(try run(status: status).canCancel, status)
        }
    }

    func testOnlyAnUnseenFailureNeedsAcknowledging() throws {
        XCTAssertTrue(try run(status: "failed").needsAcknowledgement)
        XCTAssertTrue(try run(status: "missed").needsAcknowledgement)
        XCTAssertFalse(try run(status: "failed", seenAt: 5).needsAcknowledgement)
        XCTAssertFalse(try run(status: "completed").needsAcknowledgement)
        XCTAssertFalse(try run(status: "running").needsAcknowledgement)
    }
}
