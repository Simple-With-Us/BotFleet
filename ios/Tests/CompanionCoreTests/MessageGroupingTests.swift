import Foundation
import Testing

@testable import CompanionCore

/// Message grouping, per docs/specs/chat-message-grouping.md.
///
/// This generalises the existing tool-run folding: a *run* becomes any
/// consecutive stretch from one speaker inside GROUP_TIME_GAP_MS, not only a
/// stretch of tool chips.  Tool runs keep their extra behaviour (failures stay
/// individually visible, and `error:` tools and comm rows never fold).
@Suite("Chat message grouping")
struct MessageGroupingTests {

    // MARK: - Fixtures

    private func text(_ id: String, role: Message.Role = .bot, at: Double = 0, parentId: String? = nil) -> Message {
        var m = Message(id: id, role: role, kind: .text, at: at)
        m.text = "hi"
        m.parentId = parentId
        return m
    }

    private func tool(_ id: String, at: Double, ok: Bool = true, role: Message.Role = .bot) -> Message {
        var m = Message(id: id, role: role, kind: .activity, at: at)
        m.tool = ToolActivity(name: "read", ok: ok)
        return m
    }

    // MARK: - Speaker key

    @Test("a human and a peer-bot user message never share a group")
    func userAndPeerDoNotMerge() {
        var mirrored = text("b", role: .user, at: 1_000)
        mirrored.from = Sender(botId: "bot-2", name: "Other", color: "#888")
        let items = groupMessageRuns([text("a", role: .user, at: 1_000), mirrored])
        #expect(items.count == 2, "role user is not a speaker key")
    }

    @Test("system rows never group, not even with each other")
    func systemNeverGroups() {
        let items = groupMessageRuns([
            text("a", role: .system, at: 1_000),
            text("b", role: .system, at: 1_010),
        ])
        #expect(items.count == 2)
    }

    // MARK: - Membership

    @Test("consecutive same-speaker text inside the gap forms one run")
    func sameSpeakerInsideGapGroups() {
        let items = groupMessageRuns([
            text("a", at: 1_000),
            text("b", at: 1_030),
            text("c", at: 1_059),
        ])
        #expect(items.count == 1)
        #expect(items[0].messages.map(\.id) == ["a", "b", "c"])
    }

    @Test("a gap past the run gap starts a new run")
    func gapBreaksRun() {
        // `at` is epoch MILLISECONDS (Message.date divides by 1000), so the gap
        // has to be expressed in ms to match `groupMessageTimeGap` seconds.
        let beyondMs = 1_000 + Int(groupMessageTimeGap) * 1_000 + 500
        let items = groupMessageRuns([
            text("a", at: 1_000),
            text("b", at: Double(beyondMs)),
        ])
        #expect(items.count == 2)
    }

    @Test("a different branch never merges even inside the gap")
    func branchBreaksRun() {
        let items = groupMessageRuns([
            text("a", at: 1_000, parentId: "root"),
            text("b", at: 1_010, parentId: "other"),
        ])
        #expect(items.count == 2)
    }

    @Test("the human breaks the bot's run and starts their own")
    func speakerChangeBreaksRun() {
        let items = groupMessageRuns([
            text("a", at: 1_000),
            text("b", role: .user, at: 1_010),
            text("c", at: 1_020),
        ])
        #expect(items.count == 3)
    }

    // MARK: - Tool runs keep their extra rules

    @Test("a tool run stays bounded by intervening non-tool messages")
    func toolRunBoundedByText() {
        let items = groupMessageRuns([
            tool("t1", at: 1_000),
            tool("t2", at: 1_005),
            text("x", at: 1_010),
            tool("t3", at: 1_015),
        ])
        #expect(items.count == 3, "two tool runs plus the text between them")
        #expect(items[0].messages.map(\.id) == ["t1", "t2"])
        #expect(items[2].messages.map(\.id) == ["t3"])
    }

    @Test("a failing tool is never merged away")
    func failingToolsStayVisible() {
        let items = groupMessageRuns([
            tool("t1", at: 1_000, ok: true),
            tool("t2", at: 1_005, ok: false),
        ])
        // Folded, but the failure is still enumerated rather than dropped.
        let run = items.first
        #expect(run?.messages.count == 2)
        let (_, summary, failed) = describeActivityRun(run?.messages ?? [])
        #expect(failed == 1, "the failure count survives folding")
        #expect(summary.contains("read ×2"))
    }

    @Test("a step still running, and a child step, stay on their own rows")
    func runningAndChildStepsStayVisible() {
        var running = Message(id: "run", role: .bot, kind: .activity, at: 1_002)
        running.tool = ToolActivity(name: "Read", ok: nil)
        var child = Message(id: "child", role: .bot, kind: .activity, at: 1_008)
        child.tool = ToolActivity(name: "Read", ok: true, itemId: "read-1", parentItemId: "task-1")
        let items = groupMessageRuns([
            tool("t1", at: 1_000),
            running,
            tool("t2", at: 1_004),
            child,
        ])
        #expect(items.map(\.id) == ["t1", "run", "t2", "child"])
        #expect(items.flatMap { $0.messages.map(\.id) } == ["t1", "run", "t2", "child"])
    }

    @Test("error: tools never fold")
    func errorToolsNeverFold() {
        var m = tool("e1", at: 1_000)
        m.tool = ToolActivity(name: "error:boom", ok: false)
        var m2 = tool("e2", at: 1_003)
        m2.tool = ToolActivity(name: "error:crash", ok: false)
        let items = groupMessageRuns([m, m2, tool("t1", at: 1_005)])
        #expect(items.count == 3, "error: tools never fold with each other or with foldable tools")
    }

    @Test("option cards and comm rows never merge into prose runs")
    func cardsAndCommNeverMergeIntoProse() {
        let card = Message(
            id: "c1",
            role: .bot,
            kind: .options,
            at: 1_005,
            card: OptionCard(title: "Proceed?", subtitle: "", options: ["Yes"])
        )
        var commMsg = text("m2", at: 1_015)
        commMsg.comm = CommChip(groupId: "g1", withBotId: "b2", withName: "Peer", withColor: "blue")
        let items = groupMessageRuns([
            text("m1", at: 1_000),
            card,
            text("m1b", at: 1_010),
            commMsg,
            text("m3", at: 1_020),
        ])
        #expect(items.count == 5)
    }

    @Test("transcriptRowEndsRun handles multi-message prose runs and gap boundaries")
    func transcriptRowEndsRunOnGroupedProseRuns() {
        let beyondMs = Double(1_000 + Int(groupMessageTimeGap) * 1_000 + 500)
        let items = groupMessageRuns([
            text("b1", at: 1_000),
            text("b2", at: 1_010),
            text("b3", at: beyondMs),
            text("b4", at: beyondMs + 10),
        ])
        #expect(items.count == 2)
        // First prose run is separated from second prose run by > 60s, so it ends its visual bubble run.
        #expect(transcriptRowEndsRun(at: 0, in: items, liveReply: false, liveSpeaker: nil) == true)
        // Second prose run is at the end: ends when idle, hands tail to live reply when streaming within gap.
        #expect(transcriptRowEndsRun(at: 1, in: items, liveReply: false, liveSpeaker: nil) == true)
        #expect(transcriptRowEndsRun(at: 1, in: items, liveReply: true, liveSpeaker: nil) == false)
        // If live reply arrives after > 60s from the last message, the closing bubble keeps its tail.
        let lateLiveDate = Date(timeIntervalSince1970: (beyondMs + 10) / 1_000 + groupMessageTimeGap + 5)
        #expect(transcriptRowEndsRun(at: 1, in: items, liveReply: true, liveSpeaker: nil, liveAt: lateLiveDate) == true)
    }

    @Test("chained messages within pairwise gap stay in one run and comm/card rows break tails")
    func chainedAdjacencyAndCommTailBreak() {
        // 0s, 50s, 100s: each adjacent pair is 50s apart (<= 60s), so they form 1 run.
        let chained = groupMessageRuns([
            text("c1", at: 0),
            text("c2", at: 50_000),
            text("c3", at: 100_000),
        ])
        #expect(chained.count == 1)
        #expect(chained[0].messages.map(\.id) == ["c1", "c2", "c3"])

        // A comm delegation row between two text messages keeps them separate and ends the first bubble's run.
        var commMsg = text("comm", at: 1_005)
        commMsg.comm = CommChip(groupId: "g1", withBotId: "b2", withName: "Peer", withColor: "blue")
        let withComm = groupMessageRuns([
            text("m1", at: 1_000),
            commMsg,
            text("m2", at: 1_010),
        ])
        #expect(withComm.count == 3)
        #expect(transcriptRowEndsRun(at: 0, in: withComm, liveReply: false, liveSpeaker: nil) == true)
        #expect(transcriptRowEndsRun(at: 1, in: withComm, liveReply: false, liveSpeaker: nil) == true)
    }

    // MARK: - Identity and accessibility contract

    @Test("a run keeps its first message's id so scroll targets survive folding")
    func runIdIsFirstMessageId() {
        let items = groupMessageRuns([tool("t1", at: 1_000), tool("t2", at: 1_005)])
        #expect(items[0].id == "t1")
        #expect(transcriptRowId(containing: "t2", in: items) == "t1")
    }

    @Test("a run's accessibility label counts its messages and names the failures")
    func runAccessibilityLabel() {
        let items = groupMessageRuns([
            tool("t1", at: 1_000, ok: true),
            tool("t2", at: 1_005, ok: false),
            tool("t3", at: 1_010, ok: true),
        ])
        let label = messageRunAccessibilityLabel(items[0])
        #expect(label.contains("3"))
        #expect(label.contains("failed"), "a failure must survive into the label")

        let proseItems = groupMessageRuns([
            text("p1", at: 1_000),
            text("p2", at: 1_010),
        ])
        let proseLabel = messageRunAccessibilityLabel(proseItems[0], sender: "Ada", relativeTime: "2 minutes ago")
        #expect(proseLabel == "Ada, 2 messages, 2 minutes ago")
    }

    @Test("a single message is not a run, and labels as itself")
    func singleMessageIsNotARun() {
        let items = groupMessageRuns([text("a", at: 1_000)])
        #expect(items.count == 1)
        #expect(items[0].messages.count == 1)
        #expect(messageRunAccessibilityLabel(items[0]).contains("1"))
    }

    // MARK: - Nothing is dropped or reordered

    @Test("grouping preserves every message in order")
    func groupingIsLossless() {
        let input = [
            text("a", at: 1_000), tool("t1", at: 1_010), tool("t2", at: 1_015),
            text("b", role: .user, at: 1_020), text("c", at: 1_030),
            text("d", role: .system, at: 2_000),
        ]
        let items = groupMessageRuns(input)
        #expect(items.flatMap { $0.messages.map(\.id) } == input.map(\.id))
    }
}
