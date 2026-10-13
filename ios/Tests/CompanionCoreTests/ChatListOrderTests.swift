import XCTest
@testable import CompanionCore

final class ChatListOrderTests: XCTestCase {
    func testNewestActivitySortsFirst() {
        let plumber = ChatListOrder.activity(createdAt: 1, taskActivities: [10_05], loadedMessageAt: 10_05)
        let monitor = ChatListOrder.activity(createdAt: 1, taskActivities: [8_01], loadedMessageAt: 8_01)
        let fixer = ChatListOrder.activity(createdAt: 1, taskActivities: [], loadedMessageAt: 1)

        XCTAssertTrue(ChatListOrder.orderedBefore(
            pinnedLeft: false, activityLeft: plumber,
            pinnedRight: false, activityRight: monitor
        ))
        XCTAssertTrue(ChatListOrder.orderedBefore(
            pinnedLeft: false, activityLeft: monitor,
            pinnedRight: false, activityRight: fixer
        ))
        XCTAssertFalse(ChatListOrder.orderedBefore(
            pinnedLeft: false, activityLeft: fixer,
            pinnedRight: false, activityRight: plumber
        ))
    }

    func testUnreadDoesNotOutrankANewerChat() {
        // The old comparator put unread above recency. A read Plumber at
        // 10:05 must still sit above an unread Monitor at 8:01.
        let plumber = ChatListOrder.activity(createdAt: 1, taskActivities: [1005], loadedMessageAt: 1005)
        let monitor = ChatListOrder.activity(createdAt: 1, taskActivities: [801], loadedMessageAt: 801)
        XCTAssertTrue(ChatListOrder.orderedBefore(
            pinnedLeft: false, activityLeft: plumber,
            pinnedRight: false, activityRight: monitor
        ))
    }

    func testPinnedWinsOverNewerUnpinnedActivity() {
        XCTAssertTrue(ChatListOrder.orderedBefore(
            pinnedLeft: true, activityLeft: 1,
            pinnedRight: false, activityRight: 99
        ))
        XCTAssertFalse(ChatListOrder.orderedBefore(
            pinnedLeft: false, activityLeft: 99,
            pinnedRight: true, activityRight: 1
        ))
    }

    func testTaskLastActivityBeatsTheOpenThreadWhenItIsNewer() {
        let stamp = ChatListOrder.activity(
            createdAt: 1,
            taskActivities: [10, 90],
            loadedMessageAt: 15
        )
        XCTAssertEqual(stamp, 90)
    }

    func testFallsBackToCreatedAtWhenNothingHasLanded() {
        XCTAssertEqual(
            ChatListOrder.activity(createdAt: 42, taskActivities: [], loadedMessageAt: nil),
            42
        )
    }

    // MARK: - stableOrder

    private struct Row: Equatable {
        let name: String
        let pinned: Bool
        let activity: Double
    }

    private func ordered(_ rows: [Row]) -> [String] {
        ChatListOrder.stableOrder(rows) { row in (pinned: row.pinned, activity: row.activity) }.map(\.name)
    }

    func testAPinnedBotSortsAboveNewerUnpinnedOnes() {
        let rows = [
            Row(name: "Newest", pinned: false, activity: 90),
            Row(name: "Pinned and old", pinned: true, activity: 1),
            Row(name: "Middle", pinned: false, activity: 50),
        ]
        XCTAssertEqual(ordered(rows), ["Pinned and old", "Newest", "Middle"])
    }

    func testPinnedBotsKeepNewestFirstAmongThemselves() {
        let rows = [
            Row(name: "A", pinned: true, activity: 10),
            Row(name: "B", pinned: false, activity: 99),
            Row(name: "C", pinned: true, activity: 30),
        ]
        XCTAssertEqual(ordered(rows), ["C", "A", "B"])
    }

    func testChatsThatTieOnPinAndActivityKeepTheOrderTheyArrivedIn() {
        // The harness order is the tiebreak, not the name: a sort by name
        // would put Alpha before Zulu here.
        let rows = [
            Row(name: "Zulu", pinned: false, activity: 5),
            Row(name: "Alpha", pinned: false, activity: 5),
            Row(name: "Mike", pinned: false, activity: 5),
            Row(name: "Pinned Zulu", pinned: true, activity: 5),
            Row(name: "Pinned Alpha", pinned: true, activity: 5),
        ]
        XCTAssertEqual(ordered(rows), ["Pinned Zulu", "Pinned Alpha", "Zulu", "Alpha", "Mike"])
    }

    func testTheTiebreakHoldsOnALongListWhereAnUnstableSortWouldShuffle() {
        let rows = (0..<200).map { index in
            Row(name: "Bot \(index)", pinned: index % 7 == 0, activity: Double(index % 3))
        }
        // Six groups by (pinned, activity), pinned first and newest first,
        // each group in the order its rows arrived.
        var expected: [String] = []
        for pinned in [true, false] {
            for activity in [2.0, 1.0, 0.0] {
                expected += rows.filter { $0.pinned == pinned && $0.activity == activity }.map(\.name)
            }
        }
        XCTAssertEqual(ordered(rows), expected)
    }

    func testAnEmptyAndASingleRosterComeBackAsTheyWere() {
        XCTAssertEqual(ordered([]), [])
        XCTAssertEqual(ordered([Row(name: "Only", pinned: false, activity: 0)]), ["Only"])
    }
}
