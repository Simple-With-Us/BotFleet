import XCTest
@testable import CompanionCore

final class ActivityRunsTests: XCTestCase {
    private func makeToolMessage(id: String, name: String, ok: Bool? = true, role: Message.Role = .bot) -> Message {
        Message(
            id: id,
            role: role,
            kind: .activity,
            at: 1000,
            tool: ToolActivity(name: name, ok: ok)
        )
    }

    private func makeTextMessage(id: String, text: String, role: Message.Role = .bot) -> Message {
        Message(
            id: id,
            role: role,
            kind: .text,
            at: 1000,
            text: text
        )
    }

    func testSingleToolIsNotFolded() {
        let messages = [makeToolMessage(id: "1", name: "view_file")]
        let items = groupActivityRuns(messages)
        XCTAssertEqual(items.count, 1)
        if case let .message(msg) = items[0] {
            XCTAssertEqual(msg.id, "1")
        } else {
            XCTFail("Expected single message")
        }
    }

    func testConsecutiveToolsAreFoldedIntoRun() {
        let messages = [
            makeToolMessage(id: "1", name: "view_file"),
            makeToolMessage(id: "2", name: "run_command"),
            makeToolMessage(id: "3", name: "run_command"),
            makeTextMessage(id: "4", text: "Done!"),
        ]
        let items = groupActivityRuns(messages)
        XCTAssertEqual(items.count, 2)
        if case let .run(id, runMsgs) = items[0] {
            XCTAssertEqual(id, "1")
            XCTAssertEqual(runMsgs.count, 3)
            let desc = describeActivityRun(runMsgs)
            XCTAssertEqual(desc.headline, "3 tool calls")
            XCTAssertTrue(desc.summary.contains("run_command ×2"))
        } else {
            XCTFail("Expected run")
        }
        if case let .message(msg) = items[1] {
            XCTAssertEqual(msg.id, "4")
        } else {
            XCTFail("Expected text message")
        }
    }

    func testARunKeepsTheIdOfTheActivityItGrewFrom() {
        // One activity is a plain row; a second folds both into a run.  The
        // row id must not change at that moment, or the transcript row is
        // rebuilt and any scroll aimed at it lands nowhere.
        let one = groupActivityRuns([makeToolMessage(id: "a1", name: "view_file")])
        let two = groupActivityRuns([
            makeToolMessage(id: "a1", name: "view_file"),
            makeToolMessage(id: "a2", name: "run_command"),
        ])
        let five = groupActivityRuns((1...5).map { makeToolMessage(id: "a\($0)", name: "run_command") })
        XCTAssertEqual(one.map(\.id), ["a1"])
        XCTAssertEqual(two.map(\.id), ["a1"])
        XCTAssertEqual(five.map(\.id), ["a1"])
    }

    func testItemIdsStayUniqueWithRuns() {
        let items = groupActivityRuns([
            makeTextMessage(id: "t1", text: "Looking"),
            makeToolMessage(id: "a1", name: "view_file"),
            makeToolMessage(id: "a2", name: "run_command"),
            makeTextMessage(id: "t2", text: "Done"),
            makeToolMessage(id: "a3", name: "run_command"),
        ])
        XCTAssertEqual(items.map(\.id), ["t1", "a1", "t2", "a3"])
        XCTAssertEqual(Set(items.map(\.id)).count, items.count)
    }

    func testRowIdForAMessageFoldedIntoARunIsTheRunsId() {
        let items = groupActivityRuns([
            makeTextMessage(id: "t1", text: "Looking"),
            makeToolMessage(id: "a1", name: "view_file"),
            makeToolMessage(id: "a2", name: "run_command"),
            makeToolMessage(id: "a3", name: "run_command"),
            makeTextMessage(id: "t2", text: "Done"),
        ])
        XCTAssertEqual(transcriptRowId(containing: "t1", in: items), "t1")
        XCTAssertEqual(transcriptRowId(containing: "a1", in: items), "a1")
        XCTAssertEqual(transcriptRowId(containing: "a3", in: items), "a1")
        XCTAssertEqual(transcriptRowId(containing: "t2", in: items), "t2")
        XCTAssertNil(transcriptRowId(containing: "missing", in: items))
    }

    func testTextMessagesBreakRuns() {
        let messages = [
            makeToolMessage(id: "1", name: "view_file"),
            makeToolMessage(id: "2", name: "run_command"),
            makeTextMessage(id: "3", text: "Intermediate thought"),
            makeToolMessage(id: "4", name: "run_command"),
            makeToolMessage(id: "5", name: "run_command"),
        ]
        let items = groupActivityRuns(messages)
        XCTAssertEqual(items.count, 3)
        if case let .run(_, run1) = items[0] {
            XCTAssertEqual(run1.count, 2)
        } else {
            XCTFail("Expected first run")
        }
        if case let .message(msg) = items[1] {
            XCTAssertEqual(msg.id, "3")
        } else {
            XCTFail("Expected text message")
        }
        if case let .run(_, run2) = items[2] {
            XCTAssertEqual(run2.count, 2)
        } else {
            XCTFail("Expected second run")
        }
    }

    // MARK: - Stretches and runs

    private func message(_ id: String, _ role: Message.Role = .bot, kind: Message.Kind = .text, at seconds: Double = 1000, from name: String? = nil) -> Message {
        var msg = Message(id: id, role: role, kind: kind, at: seconds * 1000, text: "line \(id)")
        if let name { msg.from = Sender(botId: name.lowercased(), name: name, color: "blue") }
        return msg
    }

    func testAStretchStartsAtTheFirstRowAndAfterHalfAnHour() {
        let items = groupActivityRuns([
            message("a", at: 0), message("b", at: 60), message("c", at: 60 + 30 * 60), message("d", at: 60 + 30 * 60 + 30 * 60 + 1),
        ])
        XCTAssertTrue(transcriptRowStartsAStretch(at: 0, in: items))
        XCTAssertFalse(transcriptRowStartsAStretch(at: 1, in: items))
        // Exactly half an hour is not more than half an hour.
        XCTAssertFalse(transcriptRowStartsAStretch(at: 2, in: items))
        XCTAssertTrue(transcriptRowStartsAStretch(at: 3, in: items))
    }

    func testTheLiveReplyUsesTheSameStretchGapAsTheRowItSettlesInto() {
        let items = groupActivityRuns([message("a", at: 0)])
        let settledLate = groupActivityRuns([message("a", at: 0), message("r", at: transcriptStretchGap + 1)])
        let settledSoon = groupActivityRuns([message("a", at: 0), message("r", at: transcriptStretchGap)])
        XCTAssertEqual(
            liveReplyStartsAStretch(after: items, now: Date(timeIntervalSince1970: transcriptStretchGap + 1)),
            transcriptRowStartsAStretch(at: 1, in: settledLate)
        )
        XCTAssertEqual(
            liveReplyStartsAStretch(after: items, now: Date(timeIntervalSince1970: transcriptStretchGap)),
            transcriptRowStartsAStretch(at: 1, in: settledSoon)
        )
        XCTAssertTrue(liveReplyStartsAStretch(after: [], now: Date()))
    }

    func testARunEndsWhereTheSenderOrKindChanges() {
        let items = groupActivityRuns([
            message("u1", .user), message("b1"), message("b2"), message("c1", kind: .options), message("b3"),
        ])
        XCTAssertTrue(transcriptRowEndsRun(at: 0, in: items, liveReply: false, liveSpeaker: nil))
        XCTAssertFalse(transcriptRowEndsRun(at: 1, in: items, liveReply: false, liveSpeaker: nil))
        XCTAssertTrue(transcriptRowEndsRun(at: 2, in: items, liveReply: false, liveSpeaker: nil))
        XCTAssertTrue(transcriptRowEndsRun(at: 4, in: items, liveReply: false, liveSpeaker: nil))
    }

    func testALiveReplyTakesTheTailFromTheBubbleAboveIt() {
        // A bot chat: the last bot bubble hands its tail to the reply being
        // typed, so it does not shrink when the reply lands.
        let chat = groupActivityRuns([message("u1", .user), message("b1")])
        XCTAssertFalse(transcriptRowEndsRun(at: 1, in: chat, liveReply: true, liveSpeaker: nil))
        XCTAssertTrue(transcriptRowEndsRun(at: 1, in: chat, liveReply: false, liveSpeaker: nil))
        // A user line keeps its tail.
        let afterUser = groupActivityRuns([message("u1", .user)])
        XCTAssertTrue(transcriptRowEndsRun(at: 0, in: afterUser, liveReply: true, liveSpeaker: nil))
    }

    func testInARoomOnlyTheSameSpeakerTakesTheTail() {
        let room = groupActivityRuns([message("u1", .user), message("b1", from: "Ada")])
        XCTAssertFalse(transcriptRowEndsRun(at: 1, in: room, liveReply: true, liveSpeaker: "Ada"))
        XCTAssertTrue(transcriptRowEndsRun(at: 1, in: room, liveReply: true, liveSpeaker: "Grace"))
        // A settled row matches the live one: the reply would carry Ada's
        // name, so Ada's bubble above ends its run exactly when it would.
        let settled = groupActivityRuns([message("u1", .user), message("b1", from: "Ada"), message("r", from: "Grace")])
        XCTAssertEqual(
            transcriptRowEndsRun(at: 1, in: room, liveReply: true, liveSpeaker: "Grace"),
            transcriptRowEndsRun(at: 1, in: settled, liveReply: false, liveSpeaker: nil)
        )
    }
}
