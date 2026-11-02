// Slice 0 iOS: viewing a retained thread while the bot works.
//
// Viewing is passive — it moves only the read pin, never the bot's active
// thread — so a turn streaming into A must leave A untouched while B fills
// its own page, and becoming the execution target must stay gated on the
// turn finishing. Mirrors the web Slice 0 coverage (`src/state/store.test.ts`
// "browsing a retained thread") against the same per-thread fold.
import XCTest
@testable import CompanionCore

final class ThreadViewTests: XCTestCase {
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

    func task(_ threadId: String, title: String) throws -> BotTask {
        let json = #"{"threadId":"\#(threadId)","title":"\#(title)","createdAt":1}"#.data(using: .utf8)!
        return try JSONDecoder().decode(BotTask.self, from: json)
    }

    /// The fixture's bot, busy on its active thread with one retained thread.
    func busyBot() throws -> (CompanionState, String, String) {
        var state = CompanionState()
        var owned = try fleet()
        owned.bots[0].tasks?.append(try task("thread-b", title: "Retained"))
        state.hydrate(owned)
        let active = try XCTUnwrap(state.bots.first?.threadId)
        state.bots[0].busy = true
        return (state, try XCTUnwrap(state.bots.first?.id), active)
    }

    /// A fleet that still lists the retained thread, for re-hydrates.
    func fleetOwningRetainedThread() throws -> Fleet {
        var owned = try fleet()
        owned.bots[0].tasks?.append(try task("thread-b", title: "Retained"))
        return owned
    }

    // MARK: - The pin is passive

    func testViewThreadSetsPinWithoutMovingTheExecutionTarget() throws {
        var (state, botId, active) = try busyBot()
        let before = state.transcript(forThread: active)

        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-b"))
        XCTAssertEqual(state.viewingThreadId(forBotId: botId), "thread-b")
        XCTAssertEqual(state.bots.first { $0.id == botId }?.threadId, active)
        XCTAssertEqual(state.bots.first { $0.id == botId }?.busy, true)
        XCTAssertEqual(state.transcript(forThread: active).map(\.id), before.map(\.id))
        // A first open needs its own page from the messages route.
        XCTAssertEqual(state.loadingThread["thread-b"], true)
    }

    func testViewThreadRefusesUnknownThreadsAndClearsForTheActiveOne() throws {
        var (state, botId, active) = try busyBot()

        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-b"))
        // A thread the bot does not own leaves the pin where it was.
        XCTAssertFalse(state.viewThread(botId: botId, threadId: "elsewhere"))
        XCTAssertEqual(state.viewingThreadId(forBotId: botId), "thread-b")
        // The active thread — and an explicit nil — need no pin.
        XCTAssertFalse(state.viewThread(botId: botId, threadId: active))
        XCTAssertNil(state.viewingThreadId(forBotId: botId))
        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-b"))
        XCTAssertFalse(state.viewThread(botId: botId, threadId: nil))
        XCTAssertNil(state.viewingThreadId(forBotId: botId))
        // Unknown bots never pin.
        XCTAssertFalse(state.viewThread(botId: "nope", threadId: "thread-b"))
    }

    func testViewThreadNeedsNoFetchWhenThePageIsAlreadyHeld() throws {
        var (state, botId, _) = try busyBot()

        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-b"))
        state.threadTranscriptLoaded(threadId: "thread-b", messages: [message("b1")], hasMore: false)
        XCTAssertNil(state.loadingThread["thread-b"])
        // A fetched page means the reopen fetches nothing.
        XCTAssertFalse(state.viewThread(botId: botId, threadId: "thread-b"))
        XCTAssertEqual(state.viewingThreadId(forBotId: botId), "thread-b")
    }

    func testFramesOnAnUnviewedRetainedThreadStillFetchFullHistory() throws {
        var (state, botId, _) = try busyBot()

        // A frame lands on the retained thread before anyone opens it: it
        // buffers into the transcript without marking the page loaded.
        state.apply(Frame.message(threadId: "thread-b", message: message("b-live", at: 9)))
        XCTAssertEqual(state.transcript(forThread: "thread-b").map(\.id), ["b-live"])
        XCTAssertNil(state.loadedThread["thread-b"])

        // Opening later still fetches the first page — the buffered frame
        // alone must never read as a held page.
        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-b"))
        XCTAssertEqual(state.viewingThreadId(forBotId: botId), "thread-b")
        XCTAssertEqual(state.loadingThread["thread-b"], true)

        // The page arrives and the buffered frame merges after it, with
        // pagination configured so older messages stay loadable.
        state.threadTranscriptLoaded(
            threadId: "thread-b", messages: [message("b1", at: 1)], hasMore: true)
        XCTAssertEqual(state.transcript(forThread: "thread-b").map(\.id), ["b1", "b-live"])
        XCTAssertEqual(state.hasMore["thread-b"], true)
        // Now held: reopening fetches nothing.
        XCTAssertFalse(state.viewThread(botId: botId, threadId: "thread-b"))
    }

    func testDroppedViewedPageFetchesAgainOnReopen() throws {
        var (state, botId, active) = try busyBot()
        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-b"))
        state.threadTranscriptLoaded(threadId: "thread-b", messages: [message("b1")], hasMore: false)

        // Back to the active thread, then a hydrate that drops the unviewed
        // retained page: the loaded flag goes with it, so the next open
        // refetches. The bot still lists the thread, so it stays openable.
        XCTAssertFalse(state.viewThread(botId: botId, threadId: active))
        XCTAssertNil(state.viewingThreadId(forBotId: botId))
        state.hydrate(try fleetOwningRetainedThread())

        XCTAssertNil(state.messages["thread-b"])
        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-b"))
    }

    // MARK: - Picking a thread stays gated on the turn

    func testThreadPickIntentViewsWhileBusyAndSwitchesWhenIdle() {
        XCTAssertEqual(
            threadPickIntent(busy: true, active: false, viewing: false, canView: true), .view)
        // Without a view affordance the busy gate is exactly what it was.
        XCTAssertEqual(
            threadPickIntent(busy: true, active: false, viewing: false, canView: false), .none)
        // Activating still needs the turn to finish.
        XCTAssertEqual(
            threadPickIntent(busy: false, active: false, viewing: false, canView: true), .switchTo)
        XCTAssertEqual(
            threadPickIntent(busy: false, active: false, viewing: true, canView: true), .switchTo)
        XCTAssertEqual(
            threadPickIntent(busy: false, active: false, viewing: false, canView: false), .switchTo)
        // Picking the active thread while a view is open returns to it.
        XCTAssertEqual(
            threadPickIntent(busy: true, active: true, viewing: true, canView: true), .viewActive)
        XCTAssertEqual(
            threadPickIntent(busy: false, active: true, viewing: true, canView: true), .viewActive)
        XCTAssertEqual(
            threadPickIntent(busy: true, active: true, viewing: false, canView: true), .none)
    }

    func testActivePickWithNoViewNeedsNoneSoTheCallerOpensTheChat() {
        // `ChatListView.openTask` always passes `canView: true`, so tapping
        // the active thread's row with no view pinned is `.none` — busy or
        // idle. That means "already on the active thread", and the caller
        // opens the active chat for it instead of breaking.
        XCTAssertEqual(
            threadPickIntent(busy: true, active: true, viewing: false, canView: true), .none)
        XCTAssertEqual(
            threadPickIntent(busy: false, active: true, viewing: false, canView: true), .none)
    }

    // MARK: - A streams while B fills

    func testStreamingIntoAWhileViewingBLeavesAUntouched() throws {
        var (state, botId, active) = try busyBot()
        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-b"))

        let before = state.transcript(forThread: active).map(\.id)
        state.apply(Frame.message(threadId: active, message: message("a2", at: 2)))
        // B keeps receiving frames by threadId without touching A's transcript.
        state.apply(Frame.message(threadId: "thread-b", message: message("b1", at: 1)))
        var patched = message("b1", at: 1)
        patched.text = "edited"
        state.apply(Frame.messagePatch(threadId: "thread-b", message: patched))

        XCTAssertEqual(state.bots.first { $0.id == botId }?.threadId, active)
        XCTAssertEqual(
            state.transcript(forThread: active).map(\.id), before + ["a2"])
        XCTAssertEqual(state.transcript(forThread: "thread-b").map(\.id), ["b1"])
        XCTAssertEqual(state.transcript(forThread: "thread-b").first?.text, "edited")
    }

    func testLoadedPageMergesWithFramesThatLandedMidFlight() throws {
        var (state, botId, _) = try busyBot()
        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-b"))

        // A frame that lands while the page is in flight is newer than
        // anything the page holds; it is kept after the page.
        state.apply(Frame.message(threadId: "thread-b", message: message("b-live", at: 9)))
        state.threadTranscriptLoaded(
            threadId: "thread-b", messages: [message("b1", at: 1)], hasMore: false)

        XCTAssertNil(state.loadingThread["thread-b"])
        XCTAssertEqual(state.transcript(forThread: "thread-b").map(\.id), ["b1", "b-live"])
        XCTAssertEqual(state.hasMore["thread-b"], false)
    }

    func testFailedPageClearsLoadingButKeepsThePin() throws {
        var (state, botId, _) = try busyBot()
        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-b"))

        state.threadTranscriptFailed(threadId: "thread-b")

        XCTAssertNil(state.loadingThread["thread-b"])
        XCTAssertEqual(state.viewingThreadId(forBotId: botId), "thread-b")
    }

    // MARK: - Hydrates and switches respect the pin

    func testHydratePreservesTheViewedPage() throws {
        var (state, botId, active) = try busyBot()
        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-b"))
        state.threadTranscriptLoaded(
            threadId: "thread-b", messages: [message("b1", at: 1)], hasMore: false)

        state.hydrate(try fleetOwningRetainedThread())

        // The active transcript still merges from the server; the viewed
        // retained page survives instead of refetching.
        XCTAssertEqual(state.transcript(forThread: "thread-b").map(\.id), ["b1"])
        XCTAssertFalse(state.transcript(forThread: active).isEmpty)
        XCTAssertEqual(state.viewingThreadId(forBotId: botId), "thread-b")
    }

    func testHydrateDropsTheViewedPageWhenItsTaskIsGone() throws {
        var (state, botId, _) = try busyBot()
        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-b"))
        state.threadTranscriptLoaded(
            threadId: "thread-b", messages: [message("b1", at: 1)], hasMore: false)

        // The next roster no longer lists the viewed thread: the pin reads
        // as no pin everywhere else, so the hydrate drops it with its cached
        // page instead of letting a deleted thread outlive the conversation.
        state.hydrate(try fleet())

        XCTAssertNil(state.viewingThreadId(forBotId: botId))
        XCTAssertNil(state.viewedBotId)
        XCTAssertNil(state.viewedThreadId)
        XCTAssertNil(state.messages["thread-b"])
        XCTAssertNil(state.hasMore["thread-b"])
        XCTAssertNil(state.loadingThread["thread-b"])
        XCTAssertNil(state.loadedThread["thread-b"])
    }

    func testHydrateDropsThePinWhenItsOwnerBotIsGone() throws {
        var (state, botId, _) = try busyBot()
        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-b"))
        state.threadTranscriptLoaded(
            threadId: "thread-b", messages: [message("b1", at: 1)], hasMore: false)

        // The owner bot itself left the roster: the pin and its page go with
        // it, like the bot-deleted frame.
        var emptied = try fleet()
        emptied.bots = []
        state.hydrate(emptied)

        XCTAssertNil(state.viewingThreadId(forBotId: botId))
        XCTAssertNil(state.viewedThreadId)
        XCTAssertNil(state.messages["thread-b"])
        XCTAssertTrue(state.bots.isEmpty)
    }

    func testHydrateClearsThePinWhenTheViewedThreadBecomesActive() throws {
        var (state, botId, _) = try busyBot()
        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-b"))
        state.threadTranscriptLoaded(
            threadId: "thread-b", messages: [message("b1", at: 1)], hasMore: false)

        // The viewed thread is the active thread again: no pin is needed,
        // and its transcript merges instead of being dropped.
        var switched = try fleetOwningRetainedThread()
        switched.bots[0].threadId = "thread-b"
        switched.bots[0].messages = [message("b1", at: 1), message("b2", at: 2)]
        state.hydrate(switched)

        XCTAssertNil(state.viewingThreadId(forBotId: botId))
        XCTAssertNil(state.viewedThreadId)
        XCTAssertEqual(state.transcript(forThread: "thread-b").map(\.id), ["b1", "b2"])
    }

    func testHydrateClearsAStaleLoadingFlagSoTheReopenFetches() throws {
        var (state, botId, _) = try busyBot()
        state.bots[0].tasks?.append(try task("thread-c", title: "Second retained"))
        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-b"))
        // Frames buffer while the first page is still in flight, then the
        // pin moves on: thread-b keeps a stale in-flight flag with no pin.
        state.apply(Frame.message(threadId: "thread-b", message: message("b-live", at: 9)))
        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-c"))

        var owned = try fleetOwningRetainedThread()
        owned.bots[0].tasks?.append(try task("thread-c", title: "Second retained"))
        state.hydrate(owned)

        // The unviewed buffered page drops — but so does its fetch flag, or
        // the reopen would read the flag as a page still coming and return
        // without fetching, pinning a thread that loads never.
        XCTAssertNil(state.messages["thread-b"])
        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-b"))
        XCTAssertEqual(state.loadingThread["thread-b"], true)
    }

    func testALoadedEmptyPageFetchesOnlyOnce() throws {
        var (state, botId, _) = try busyBot()
        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-b"))

        // A thread with no messages still loads a page — an empty one — and
        // that counts as held: every reopen after it fetches nothing. Only
        // the fetched flag distinguishes it from a miss; the transcript
        // alone cannot, which is why a nil-check there would refetch forever.
        state.threadTranscriptLoaded(threadId: "thread-b", messages: [], hasMore: false)

        XCTAssertEqual(state.loadedThread["thread-b"], true)
        XCTAssertFalse(state.viewThread(botId: botId, threadId: "thread-b"))
        XCTAssertFalse(state.viewThread(botId: botId, threadId: "thread-b"))
    }

    // MARK: - The live row follows the displayed thread

    func testBottomLiveRowShowsTypingOnlyForTheDisplayedThread() throws {
        // Browsing an idle retained thread while the active one works shows
        // no indicator: the busy fallback is the active bot's flag, not the
        // displayed thread's.
        XCTAssertEqual(bottomLiveRow(streaming: nil, reasoning: nil, viewingOther: true, busy: true), .none)
        // On the active thread the same flag still drives the indicator.
        XCTAssertEqual(bottomLiveRow(streaming: nil, reasoning: nil, viewingOther: false, busy: true), .typing)
        XCTAssertEqual(bottomLiveRow(streaming: nil, reasoning: nil, viewingOther: false, busy: false), .none)
        // Live text for the displayed thread wins over either flag.
        XCTAssertEqual(bottomLiveRow(streaming: "hi", reasoning: nil, viewingOther: true, busy: false), .text)
        XCTAssertEqual(bottomLiveRow(streaming: nil, reasoning: "hmm", viewingOther: true, busy: false), .reasoning)
        XCTAssertEqual(bottomLiveRow(streaming: "", reasoning: nil, viewingOther: false, busy: true), .typing)
    }

    func testTaskSwitchClearsTheStalePin() throws {
        var (state, botId, active) = try busyBot()
        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-b"))

        var switched = try XCTUnwrap(state.bots.first { $0.id == botId })
        switched.threadId = "thread-c"
        switched.messages = [message("c1", at: 1)]
        switched.tasks = [try task(active, title: "Was active"), try task("thread-b", title: "Retained")]
        state.apply(Frame.bot(switched))

        XCTAssertEqual(state.bots.first { $0.id == botId }?.threadId, "thread-c")
        XCTAssertNil(state.viewingThreadId(forBotId: botId))
    }

    func testDeletedViewedThreadDropsItsPage() throws {
        var (state, botId, active) = try busyBot()
        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-b"))
        state.threadTranscriptLoaded(
            threadId: "thread-b", messages: [message("b1", at: 1)], hasMore: false)

        // The same answer shape a delete lands as: the bot no longer lists
        // the viewed thread.
        var pruned = try XCTUnwrap(state.bots.first { $0.id == botId })
        pruned.threadId = active
        pruned.messages = state.transcript(forThread: active)
        pruned.tasks = [try task(active, title: "Still here")]
        state.apply(Frame.bot(pruned))

        XCTAssertNil(state.viewingThreadId(forBotId: botId))
        XCTAssertNil(state.messages["thread-b"])
    }

    func testBotDeletedClearsThePin() throws {
        var (state, botId, _) = try busyBot()
        XCTAssertTrue(state.viewThread(botId: botId, threadId: "thread-b"))
        state.threadTranscriptLoaded(
            threadId: "thread-b", messages: [message("b1", at: 1)], hasMore: false)

        state.apply(Frame.botDeleted(botId: botId))

        XCTAssertNil(state.viewingThreadId(forBotId: botId))
        XCTAssertNil(state.messages["thread-b"])
        XCTAssertTrue(state.bots.isEmpty)
    }
}
