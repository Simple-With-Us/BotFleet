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
}
