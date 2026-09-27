// The fold. Everything here is a claim about what the user sees after a
// frame lands, so it is written against frames rather than internals.
import XCTest
@testable import CompanionCore

final class StoreTests: XCTestCase {
    func fleet() throws -> Fleet {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "bots-paged", withExtension: "json", subdirectory: "Fixtures")
                ?? Bundle.module.url(forResource: "bots-paged", withExtension: "json")
        )
        return try JSONDecoder().decode(Fleet.self, from: try Data(contentsOf: url))
    }

    func message(_ id: String, at: Double = 1, text: String = "hello") -> Message {
        var message = Message(id: id, role: .user, kind: .text, at: at)
        message.text = text
        return message
    }

    func hydrated() throws -> CompanionState {
        var state = CompanionState()
        state.hydrate(try fleet())
        return state
    }

    // MARK: - Hydration

    func testHydrateIndexesEveryThread() throws {
        let state = try hydrated()
        XCTAssertFalse(state.bots.isEmpty)
        for bot in state.bots {
            XCTAssertNotNil(state.messages[bot.threadId])
        }
        for room in state.rooms {
            XCTAssertEqual(state.transcript(forThread: room.threadId).count, room.messages?.count)
            XCTAssertEqual(state.hasMore[room.threadId], room.hasMore)
        }
    }

    // MARK: - Hydration merges scrollback instead of wiping it (IO12)

    func testRehydratingMergesTheFreshPageInsteadOfDiscardingPagedInScrollback() throws {
        var state = try hydrated()
        let threadId = try XCTUnwrap(state.bots.first?.threadId)
        let beforeCount = state.transcript(forThread: threadId).count

        // Simulate "Load earlier": an older page the fresh 50-message
        // hydrate below will not repeat.
        state.prepend(
            ThreadPage(messages: [message("older-page-1", at: 0)], hasMore: true),
            toThread: threadId
        )
        XCTAssertEqual(state.transcript(forThread: threadId).count, beforeCount + 1)

        state.hydrate(try fleet())

        XCTAssertTrue(
            state.transcript(forThread: threadId).contains { $0.id == "older-page-1" },
            "a foreground re-hydrate must not discard scrollback paged in earlier"
        )
        XCTAssertEqual(state.transcript(forThread: threadId).count, beforeCount + 1)
    }

    func testRehydratingReplacesOverlappingMessageIdsWithTheFreshCopy() throws {
        var state = try hydrated()
        let threadId = try XCTUnwrap(state.bots.first?.threadId)
        let existingId = try XCTUnwrap(state.transcript(forThread: threadId).first?.id)

        var edited = try fleet()
        if let index = edited.bots.firstIndex(where: { $0.threadId == threadId }) {
            edited.bots[index].messages = edited.bots[index].messages?.map { original in
                guard original.id == existingId else { return original }
                var patched = original
                patched.text = "edited server-side"
                return patched
            }
        }

        state.hydrate(edited)

        let merged = state.transcript(forThread: threadId).first { $0.id == existingId }
        XCTAssertEqual(merged?.text, "edited server-side")
    }

    func testRehydratingDoesNotUnlearnHasMoreOnceScrollbackAlreadyExtendsPastTheFreshPage() throws {
        var state = try hydrated()
        let threadId = try XCTUnwrap(state.bots.first?.threadId)
        // The fixture's bot already reports `hasMore: false` — establish
        // "there is more above" the way paging earlier actually would.
        state.prepend(
            ThreadPage(messages: [message("older-page-1", at: 0)], hasMore: true),
            toThread: threadId
        )
        XCTAssertEqual(state.hasMore[threadId], true)

        // A plain foreground re-hydrate re-fetches only the newest 50 and
        // reports `hasMore: false` for that narrow window — it must not
        // un-learn the boundary already resolved by paging further back.
        state.hydrate(try fleet())

        XCTAssertEqual(
            state.hasMore[threadId], true,
            "a 50-message re-hydrate must not overwrite a boundary already resolved by paging earlier"
        )
    }

    func testRehydrateWithNoMessagesFieldLeavesExistingScrollbackUntouched() throws {
        var state = try hydrated()
        let threadId = try XCTUnwrap(state.bots.first?.threadId)
        let before = state.transcript(forThread: threadId)
        XCTAssertFalse(before.isEmpty)

        // A response shape that omits `messages` entirely for a bot that
        // still exists — decodes to `nil`, not `[]` — must never be read as
        // "this thread now has zero messages".
        let json = #"""
        {
          "bots": [
            {
              "id": "4f254cf4-98c5-45ca-907e-967e2bbcb8ac",
              "threadId": "\#(threadId)",
              "name": "Pesto",
              "title": "",
              "description": "",
              "notifications": true,
              "color": "green",
              "unread": true,
              "modelSelection": { "instanceId": "", "model": "" },
              "createdAt": 1786742441013
            }
          ],
          "groups": []
        }
        """#
        let noMessagesField = try JSONDecoder().decode(Fleet.self, from: Data(json.utf8))

        state.hydrate(noMessagesField)

        XCTAssertEqual(state.transcript(forThread: threadId), before)
    }

    func testRehydrateDropsScrollbackOnlyForAThreadNoLongerInTheFleet() throws {
        var state = try hydrated()
        let deletedThreadId = "thread-deleted-elsewhere"
        state.apply(.message(threadId: deletedThreadId, message: message("orphan-1")))
        XCTAssertFalse(state.transcript(forThread: deletedThreadId).isEmpty)

        state.hydrate(try fleet())

        XCTAssertTrue(
            state.transcript(forThread: deletedThreadId).isEmpty,
            "a thread absent from the fresh roster is the one real reset signal a hydrate carries today"
        )
        XCTAssertNil(state.hasMore[deletedThreadId])
    }

    func testConflictRefreshSnapshotCannotOverwriteAConcurrentStreamFrame() throws {
        var state = try hydrated()
        let staleSnapshot = try fleet()
        let token = state.hydrationToken
        let threadId = try XCTUnwrap(state.bots.first?.threadId)
        state.apply(.message(threadId: threadId, message: message("newer-frame", text: "arrived live")))

        XCTAssertFalse(state.hydrate(staleSnapshot, ifUnchangedSince: token))
        XCTAssertEqual(state.transcript(forThread: threadId).last?.id, "newer-frame")
    }

    func testPairingResetInvalidatesAnOldSnapshotTokenEvenAtTheSameRevision() throws {
        var state = CompanionState()
        let oldToken = state.hydrationToken
        state = CompanionState()

        XCTAssertFalse(state.hydrate(try fleet(), ifUnchangedSince: oldToken))
        XCTAssertTrue(state.bots.isEmpty)
    }

    func testHelloDoesNotInvalidateAnOtherwiseCurrentSnapshot() throws {
        var state = try hydrated()
        let token = state.hydrationToken
        state.apply(.hello(cursor: "stream:4", resumed: false))

        XCTAssertTrue(state.hydrate(try fleet(), ifUnchangedSince: token))
    }

    // MARK: - Messages

    func testAppendsAndPatchesInPlace() throws {
        var state = try hydrated()
        let threadId = try XCTUnwrap(state.bots.first).threadId
        let before = state.transcript(forThread: threadId).count

        state.apply(.message(threadId: threadId, message: message("new-1")))
        XCTAssertEqual(state.transcript(forThread: threadId).count, before + 1)

        var patched = message("new-1")
        patched.text = "edited"
        state.apply(.messagePatch(threadId: threadId, message: patched))
        XCTAssertEqual(state.transcript(forThread: threadId).count, before + 1, "a patch must not append")
        XCTAssertEqual(state.transcript(forThread: threadId).last?.text, "edited")
    }

    func testAReplayedMessageDoesNotAppearTwice() throws {
        // resuming redelivers whatever was in flight when the socket died
        var state = try hydrated()
        let threadId = try XCTUnwrap(state.bots.first).threadId
        let before = state.transcript(forThread: threadId).count

        state.apply(.message(threadId: threadId, message: message("dupe")))
        state.apply(.message(threadId: threadId, message: message("dupe")))
        XCTAssertEqual(state.transcript(forThread: threadId).count, before + 1)
    }

    func testScrollbackPrependsWithoutDuplicating() throws {
        var state = CompanionState()
        state.messages["t1"] = [message("c"), message("d")]
        state.prepend(ThreadPage(messages: [message("a"), message("b"), message("c")], hasMore: true), toThread: "t1")

        XCTAssertEqual(state.transcript(forThread: "t1").map(\.id), ["a", "b", "c", "d"])
        XCTAssertEqual(state.hasMore["t1"], true)
    }

    func testSearchWindowMergesAndOrdersWithoutDuplicating() {
        var state = CompanionState()
        state.messages["t1"] = [message("d", at: 4), message("e", at: 5)]
        state.merge(
            ThreadPage(messages: [message("b", at: 2), message("c", at: 3), message("d", at: 4)], hasMore: true),
            intoThread: "t1"
        )
        XCTAssertEqual(state.transcript(forThread: "t1").map(\.id), ["b", "c", "d", "e"])
        XCTAssertEqual(state.hasMore["t1"], true)
    }

    func testBusySendChipShowsUntilDrainAndDoesNotStayAfterQueueIdLands() throws {
        var state = try hydrated()
        let threadId = try XCTUnwrap(state.bots.first).threadId
        let before = state.visibleTranscript(forThread: threadId).count

        state.rememberPendingQueued(threadId: threadId, queueId: "q-busy", text: "later")
        let visible = state.visibleTranscript(forThread: threadId)
        XCTAssertEqual(visible.count, before + 1)
        XCTAssertEqual(visible.last?.text, "later")
        XCTAssertEqual(visible.last?.queued, true)
        XCTAssertEqual(visible.last?.queueId, "q-busy")
        XCTAssertEqual(state.transcript(forThread: threadId).count, before, "steer-queue is not in messages[] yet")

        var drained = message("real-1", text: "later")
        drained.queueId = "q-busy"
        state.apply(.message(threadId: threadId, message: drained))
        XCTAssertNil(state.pendingQueued[threadId])
        XCTAssertEqual(state.visibleTranscript(forThread: threadId).last?.id, "real-1")
        XCTAssertNotEqual(state.visibleTranscript(forThread: threadId).last?.queued, true)
    }

    func testDrainFrameBeforePOSTContinuationDoesNotResurrectTheChip() throws {
        var state = try hydrated()
        let threadId = try XCTUnwrap(state.bots.first).threadId
        var drained = message("real-1", text: "later")
        drained.queueId = "q-race"
        state.apply(.message(threadId: threadId, message: drained))
        state.rememberPendingQueued(threadId: threadId, queueId: "q-race", text: "later")
        XCTAssertNil(state.pendingQueued[threadId])
    }

    func testCancelRemovesThePendingChip() throws {
        var state = try hydrated()
        let threadId = try XCTUnwrap(state.bots.first).threadId
        state.rememberPendingQueued(threadId: threadId, queueId: "q-1", text: "nope")
        state.cancelPendingQueued(threadId: threadId, queueId: "q-1")
        XCTAssertFalse(state.visibleTranscript(forThread: threadId).contains { $0.queueId == "q-1" })
    }

    func testIdleSendShowsABubbleUntilTheRealRowLands() throws {
        var state = try hydrated()
        let threadId = try XCTUnwrap(state.bots.first).threadId
        let before = state.visibleTranscript(forThread: threadId).count

        state.rememberPendingSend(threadId: threadId, id: "local-1", text: "hello from me", queued: false)
        let visible = state.visibleTranscript(forThread: threadId)
        XCTAssertEqual(visible.count, before + 1)
        XCTAssertEqual(visible.last?.text, "hello from me")
        XCTAssertNotEqual(visible.last?.queued, true)

        state.apply(.message(threadId: threadId, message: message("real-idle", text: "hello from me")))
        XCTAssertNil(state.pendingQueued[threadId])
        XCTAssertEqual(state.visibleTranscript(forThread: threadId).last?.id, "real-idle")
    }

    func testIdlePendingPromotesToQueuedChipOn202() throws {
        var state = try hydrated()
        let threadId = try XCTUnwrap(state.bots.first).threadId
        state.rememberPendingSend(threadId: threadId, id: "local-2", text: "later", queued: false)
        state.promotePendingSend(threadId: threadId, from: "local-2", to: "q-from-202")
        let last = try XCTUnwrap(state.visibleTranscript(forThread: threadId).last)
        XCTAssertEqual(last.queueId, "q-from-202")
        XCTAssertEqual(last.queued, true)
        XCTAssertEqual(last.text, "later")
    }

    func testReplayedUserMessageDoesNotEatALaterPendingSend() throws {
        var state = try hydrated()
        let threadId = try XCTUnwrap(state.bots.first).threadId
        state.apply(.message(threadId: threadId, message: message("u1", text: "hello")))
        state.rememberPendingSend(threadId: threadId, id: "local-3", text: "hello", queued: false)
        state.apply(.message(threadId: threadId, message: message("u1", text: "hello")))
        XCTAssertEqual(state.visibleTranscript(forThread: threadId).filter { $0.text == "hello" }.count, 2)
    }

    func testHydrateRetiresIdlePendingWhenTheRealRowIsAlreadyThere() throws {
        var state = try hydrated()
        let bot = try XCTUnwrap(state.bots.first)
        state.rememberPendingSend(threadId: bot.threadId, id: "local-h", text: "already in", queued: false)
        var snapshot = try fleet()
        var hydratedBot = try XCTUnwrap(snapshot.bots.first { $0.id == bot.id })
        hydratedBot.messages = (hydratedBot.messages ?? []) + [message("from-server", text: "already in")]
        snapshot = Fleet(
            bots: snapshot.bots.map { $0.id == bot.id ? hydratedBot : $0 },
            groups: snapshot.groups
        )
        state.hydrate(snapshot)
        XCTAssertFalse((state.pendingQueued[bot.threadId] ?? []).contains { $0.queueId == "local-h" })
        XCTAssertTrue(state.transcript(forThread: bot.threadId).contains { $0.id == "from-server" })
    }

    func testHydrateKeepsBusyPendingWhenOnlySameTextLanded() throws {
        var state = try hydrated()
        let bot = try XCTUnwrap(state.bots.first)
        state.rememberPendingSend(threadId: bot.threadId, id: "q-busy-h", text: "same text", queued: true)
        var snapshot = try fleet()
        var hydratedBot = try XCTUnwrap(snapshot.bots.first { $0.id == bot.id })
        // A different same-text user row (no queueId) landed while offline.
        hydratedBot.messages = (hydratedBot.messages ?? []) + [message("other-send", text: "same text")]
        snapshot = Fleet(
            bots: snapshot.bots.map { $0.id == bot.id ? hydratedBot : $0 },
            groups: snapshot.groups
        )
        state.hydrate(snapshot)
        XCTAssertTrue((state.pendingQueued[bot.threadId] ?? []).contains { $0.queueId == "q-busy-h" })

        // Its own drained row (stamped with the queueId) retires it.
        var drained = message("drained", text: "same text")
        drained.queueId = "q-busy-h"
        hydratedBot.messages = (hydratedBot.messages ?? []) + [drained]
        snapshot = Fleet(
            bots: snapshot.bots.map { $0.id == bot.id ? hydratedBot : $0 },
            groups: snapshot.groups
        )
        state.hydrate(snapshot)
        XCTAssertFalse((state.pendingQueued[bot.threadId] ?? []).contains { $0.queueId == "q-busy-h" })
    }

    func testPendingOptimisticAtStaysStableAcrossVisibleTranscript() {
        var state = CompanionState()
        let threadId = "t-pending-at"
        state.rememberPendingSend(threadId: threadId, id: "local-1", text: "old ask", queued: false)
        let first = state.pendingQueued[threadId]!.first!.at
        let visibleA = state.visibleTranscript(forThread: threadId)
        // Simulate time passing without reminting the stamp.
        Thread.sleep(forTimeInterval: 0.05)
        let visibleB = state.visibleTranscript(forThread: threadId)
        XCTAssertEqual(visibleA.last?.at, first)
        XCTAssertEqual(visibleB.last?.at, first)
        XCTAssertEqual(visibleA.last?.text, "old ask")
    }

    func testConsumePendingMatchingTextLeavesBusyChipForQueueId() {
        var state = CompanionState()
        let threadId = "t-pending-busy"
        state.rememberPendingSend(threadId: threadId, id: "q-busy", text: "same text", queued: true)
        state.consumePendingMatchingText(threadId: threadId, text: "same text")
        XCTAssertEqual(state.pendingQueued[threadId]?.map(\.queueId), ["q-busy"])
        state.consumePendingQueued(threadId: threadId, queueId: "q-busy")
        XCTAssertNil(state.pendingQueued[threadId])
    }


    // MARK: - Bots

    func testABotFrameMergesRatherThanWipingTheTranscript() throws {
        // bot frames carry no messages; assigning one would empty the chat
        var state = try hydrated()
        var bot = try XCTUnwrap(state.bots.first)
        let threadId = bot.threadId
        state.apply(.message(threadId: threadId, message: message("keep-me")))
        let count = state.transcript(forThread: threadId).count

        bot.messages = nil
        bot.busy = true
        bot.unread = true
        state.apply(.bot(bot))

        XCTAssertEqual(state.bot(bot.id)?.busy, true)
        XCTAssertEqual(state.transcript(forThread: threadId).count, count)
        XCTAssertNotNil(state.bot(bot.id)?.messages, "the merged bot keeps the transcript it had")
    }

    func testATaskSwitchReplacesTheActiveTranscript() throws {
        var state = try hydrated()
        var bot = try XCTUnwrap(state.bots.first)
        let previousThread = bot.threadId
        state.apply(.message(threadId: previousThread, message: message("old-tail")))

        bot.threadId = "another-task"
        bot.messages = [message("new-root", text: "new task")]
        bot.activeLeafId = "new-root"
        state.apply(.bot(bot))

        XCTAssertEqual(state.bot(bot.id)?.threadId, "another-task")
        XCTAssertEqual(state.transcript(forThread: "another-task").map(\.id), ["new-root"])
        XCTAssertFalse(state.transcript(forThread: "another-task").contains { $0.id == "old-tail" })
    }

    func testVisibleTranscriptFollowsTheActiveBranch() throws {
        var state = try hydrated()
        let bot = try XCTUnwrap(state.bots.first)
        let root = message("root")
        var first = message("first", at: 2)
        first.parentId = root.id
        var fork = message("fork", at: 3)
        fork.parentId = root.id
        var tail = message("tail", at: 4)
        tail.parentId = fork.id
        state.messages[bot.threadId] = [root, first, fork, tail]

        state.apply(.thread(threadId: bot.threadId, activeLeafId: tail.id))
        XCTAssertEqual(state.visibleTranscript(forThread: bot.threadId).map(\.id), ["root", "fork", "tail"])
    }

    func testVersionsAreUserMessagesWithTheSameParent() {
        var state = CompanionState()
        let root = message("root")
        var first = message("first", at: 2)
        first.parentId = root.id
        var second = message("second", at: 3)
        second.parentId = root.id
        var reply = message("reply", at: 4)
        reply.role = .bot
        reply.parentId = root.id
        state.messages["t1"] = [root, second, reply, first]

        XCTAssertEqual(state.versions(of: first, inThread: "t1").map(\.id), ["first", "second"])
    }

    func testMessageAppendMovesTheLeafAndBranchSwitchClearsLiveText() throws {
        var state = try hydrated()
        let bot = try XCTUnwrap(state.bots.first)
        state.apply(.runtime(RuntimeEvent(
            type: "content.delta", threadId: bot.threadId, delta: "old branch", streamKind: "assistant_text"
        )))
        state.apply(.thread(threadId: bot.threadId, activeLeafId: "other"))
        XCTAssertNil(state.streaming[bot.threadId])

        state.apply(.message(threadId: bot.threadId, message: message("latest")))
        XCTAssertEqual(state.bot(bot.id)?.activeLeafId, "latest")
    }

    func testDeletingABotTakesItsTranscriptWithIt() throws {
        var state = try hydrated()
        let bot = try XCTUnwrap(state.bots.first)
        state.apply(.botDeleted(botId: bot.id))

        XCTAssertNil(state.bot(bot.id))
        XCTAssertTrue(state.transcript(forThread: bot.threadId).isEmpty)
        XCTAssertNil(state.hasMore[bot.threadId])
    }

    func testAnUnknownBotFrameAddsIt() throws {
        var state = CompanionState()
        var bot = try XCTUnwrap(try hydrated().bots.first)
        bot.id = "brand-new"
        bot.threadId = "brand-new-thread"
        state.apply(.bot(bot))
        XCTAssertEqual(state.bots.count, 1)
        XCTAssertNotNil(state.messages["brand-new-thread"])
    }

    // MARK: - Approvals

    func testPendingApprovalsAreTheUnansweredOnesNewestFirst() throws {
        var state = try hydrated()
        let firstThread = try XCTUnwrap(state.bots.first?.threadId)
        let secondThread = try XCTUnwrap(state.rooms.first?.threadId)
        func card(_ id: String, at: Double, requestId: String?, answered: String? = nil) -> Message {
            var message = Message(id: id, role: .bot, kind: .options, at: at)
            message.card = OptionCard(
                title: "Approval needed", subtitle: "rm -rf ./build", options: ["Allow", "Deny"],
                answered: answered, dismissed: nil, requestId: requestId, tool: "Bash",
                held: nil, allowKey: "Bash:rm"
            )
            return message
        }
        state.messages[firstThread] = [
            card("old", at: 1, requestId: "r1"),
            card("answered", at: 2, requestId: "r2", answered: "Allow"),
            card("history", at: 3, requestId: nil),
        ]
        state.messages[secondThread] = [card("new", at: 9, requestId: "r3")]

        let pending = state.pendingApprovals
        XCTAssertEqual(pending.map(\.message.id), ["new", "old"])
        XCTAssertEqual(pending.first?.threadId, secondThread)
    }

    // MARK: - Cursor

    func testTheCursorFollowsTheStreamAndKeepsItsStreamId() {
        var state = CompanionState()
        state.apply(.hello(cursor: "abc12345:7", resumed: true))
        XCTAssertNil(state.cursor, "hello is not committed before its replay or hydration")

        state.resetCursor("abc12345:7")
        XCTAssertEqual(state.cursor, "abc12345:7")

        state.advance(to: 8)
        XCTAssertEqual(state.cursor, "abc12345:8", "the stream id is what stops a stale replay")

        // hello frames carry no seq, and nothing should move without one
        state.advance(to: nil)
        XCTAssertEqual(state.cursor, "abc12345:8")
    }

    func testAdvancingBeforeAnyHelloDoesNothing() {
        var state = CompanionState()
        state.advance(to: 4)
        XCTAssertNil(state.cursor, "without a stream id there is no cursor worth keeping")
    }

    // MARK: - Notifications

    func testNotificationsCollectInOrder() {
        var state = CompanionState()
        let approval = NotificationFrame(
            kind: "approval", botId: "b1", botName: "Scout", threadId: "t1",
            title: "Scout needs approval", body: "rm -rf"
        )
        let done = NotificationFrame(
            kind: "done", botId: "b1", botName: "Scout", threadId: "t1",
            title: "Scout finished", body: "pushed"
        )
        state.apply(.notify(approval))
        state.apply(.notify(done))

        XCTAssertEqual(state.notifications.count, 2)
        XCTAssertTrue(state.notifications[0].isBlocking)
        XCTAssertFalse(state.notifications[1].isBlocking)
    }

    func testNotificationsKeepOnlyARecentWindow() {
        var state = CompanionState()
        for index in 0..<120 {
            state.apply(.notify(NotificationFrame(
                kind: "done", botId: "b1", botName: "Scout", threadId: "t1",
                title: "Done \(index)", body: "body"
            )))
        }
        XCTAssertEqual(state.notifications.count, 100)
        XCTAssertEqual(state.notifications.first?.title, "Done 20")
    }

    func testForegroundBannerSkipsTheThreadAlreadyOnScreen() {
        XCTAssertFalse(NotificationFrame.shouldPresentBanner(threadId: "t1", viewingThreadId: "t1"))
        XCTAssertTrue(NotificationFrame.shouldPresentBanner(threadId: "t1", viewingThreadId: "t2"))
        XCTAssertTrue(NotificationFrame.shouldPresentBanner(threadId: "t1", viewingThreadId: nil))
    }

    // MARK: - Frames with nothing to fold

    func testFramesThisClientIgnoresAreHarmless() throws {
        var state = try hydrated()
        let before = state.bots.count
        state.apply(.screen(botId: "b1", png: "AAAA", mime: "image/png"))
        state.apply(.computer(botId: "b1", state: "provisioning"))
        state.apply(.config)
        state.apply(.runtime(RuntimeEvent(type: "content.delta", threadId: "t1", delta: "hi", streamKind: "assistant_text")))
        state.apply(.unknown(kind: "routine.run"))
        XCTAssertEqual(state.bots.count, before)
    }
}

// MARK: - Live text

/// The harness relays raw provider deltas alongside the settled messages it
/// folds. These pin the handover between the two, which is where every
/// streaming bug in this project's desktop client has lived.
final class StreamingTests: XCTestCase {
    private func delta(_ text: String, thread: String = "t1", kind: String = "assistant_text") -> Frame {
        .runtime(RuntimeEvent(type: "content.delta", threadId: thread, delta: text, streamKind: kind))
    }

    func testDeltasAccumulateIntoLiveText() {
        var state = CompanionState()
        state.apply(delta("Hel"))
        state.apply(delta("lo, "))
        state.apply(delta("world"))
        XCTAssertEqual(state.streaming["t1"], "Hello, world")
    }

    func testReasoningIsKeptApartFromTheAnswer() {
        var state = CompanionState()
        state.apply(delta("thinking…", kind: "reasoning_text"))
        state.apply(delta("the answer"))
        XCTAssertEqual(state.reasoning["t1"], "thinking…")
        XCTAssertEqual(state.streaming["t1"], "the answer")
    }

    func testAnUnknownStreamKindIsDroppedRatherThanGuessedAt() {
        var state = CompanionState()
        state.apply(delta("???", kind: "some_future_kind"))
        XCTAssertNil(state.streaming["t1"])
        XCTAssertNil(state.reasoning["t1"])
    }

    func testASettledReplyReplacesTheLiveText() {
        // The bug this prevents: the live bubble surviving next to the real
        // one, so the tail renders below whatever settled after it and the
        // next turn's deltas append onto a duplicated fragment.
        var state = CompanionState()
        state.apply(delta("partial answer"))
        XCTAssertNotNil(state.streaming["t1"])

        state.apply(.message(threadId: "t1", message: Message(
            id: "m1", role: .bot, kind: .text, at: 1, text: "partial answer, completed"
        )))
        XCTAssertNil(state.streaming["t1"], "the settled message already contains those tokens")
        XCTAssertEqual(state.transcript(forThread: "t1").count, 1)
    }

    func testOnlyASettledBotReplyClearsIt() {
        var state = CompanionState()
        state.apply(delta("mid-answer"))
        // the user's own message, and a tool chip, both land mid-turn
        state.apply(.message(threadId: "t1", message: Message(
            id: "u1", role: .user, kind: .text, at: 1, text: "another question"
        )))
        state.apply(.message(threadId: "t1", message: Message(
            id: "a1", role: .bot, kind: .activity, at: 2
        )))
        XCTAssertEqual(state.streaming["t1"], "mid-answer", "neither of those is the reply")
    }

    func testTheTurnEndingClearsEvenWithoutASettledMessage() {
        // A failed or interrupted turn may never produce one. Leaving the
        // caret blinking forever is the failure mode worth avoiding.
        for ending in ["turn.completed", "turn.failed", "turn.aborted"] {
            var state = CompanionState()
            state.apply(delta("half a sentence"))
            state.apply(.runtime(RuntimeEvent(type: ending, threadId: "t1", delta: nil, streamKind: nil)))
            XCTAssertNil(state.streaming["t1"], "\(ending) should end the live bubble")
        }
    }

    func testThreadsStreamIndependently() {
        var state = CompanionState()
        state.apply(delta("for one", thread: "t1"))
        state.apply(delta("for two", thread: "t2"))
        state.apply(.runtime(RuntimeEvent(type: "turn.completed", threadId: "t1", delta: nil, streamKind: nil)))
        XCTAssertNil(state.streaming["t1"])
        XCTAssertEqual(state.streaming["t2"], "for two", "one bot finishing must not silence another")
    }
}

// MARK: - The computer panel

/// Screen frames are the one thing this client asks the server *not* to send
/// by default — they are hundreds of kilobytes each and arrive every few
/// seconds. These pin the fold; the turning-on is the session's job.
final class ScreenTests: XCTestCase {
    private func frame(_ png: String, bot: String = "b1") -> Frame {
        .screen(botId: bot, png: png, mime: "image/png")
    }

    func testOnlyTheNewestFrameIsKept() {
        // A history of desktop captures is worth nothing and costs megabytes.
        var state = CompanionState()
        state.apply(frame("AAAA"))
        state.apply(frame("BBBB"))
        state.apply(frame("CCCC"))
        XCTAssertEqual(state.screens["b1"]?.png, "CCCC")
        XCTAssertEqual(state.screens.count, 1)
    }

    func testBotsAreTrackedSeparately() {
        var state = CompanionState()
        state.apply(frame("one", bot: "b1"))
        state.apply(frame("two", bot: "b2"))
        XCTAssertEqual(state.screens["b1"]?.png, "one")
        XCTAssertEqual(state.screens["b2"]?.png, "two")
    }

    func testClosingThePanelForgetsTheFrame() {
        // Otherwise the panel reopens on however the desktop looked last
        // time, which reads as a live view of a stale moment.
        var state = CompanionState()
        state.apply(frame("stale"))
        state.clearScreen("b1")
        XCTAssertNil(state.screens["b1"])
    }

    func testBadBase64DecodesToNilRatherThanCrashing() {
        let good = ScreenFrame(png: "aGVsbG8=", mime: "image/png")
        // The failable initialiser rather than `String(decoding:as:)`: the
        // latter substitutes replacement characters for anything invalid, so
        // a decode that produced garbage would still assert equal to garbage.
        // Here a wrong answer should be nil, and nil fails the test.
        XCTAssertEqual(good.data.flatMap { String(bytes: $0, encoding: .utf8) }, "hello")
        // the view treats nil as "no frame yet", which is the right fallback
        XCTAssertNil(ScreenFrame(png: "not base64 at all!!", mime: "image/png").data)
    }
}
