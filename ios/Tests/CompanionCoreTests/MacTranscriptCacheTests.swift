// The settled caches of `MacTranscriptEngine` (BF-2697): they follow the
// settled roster, and a stream that finishes is served from the cache.
import XCTest
@testable import CompanionCore

final class MacTranscriptCacheTests: XCTestCase {
    func testTheCachesFollowTheRosterAndAFinishedStreamIsACacheHit() {
        let engine = MacTranscriptEngine()
        var first = Message(id: "settled-a", role: .user, kind: .text, at: 1)
        first.text = "First with **bold**."
        var second = Message(id: "settled-b", role: .bot, kind: .text, at: 2)
        second.text = "Second with `code`."

        engine.setSettledMessages([first, second])
        _ = engine.renderedBlocks(for: first)
        _ = engine.renderedBlocks(for: second)
        XCTAssertEqual(engine.settledMessagesParsed, 2)
        XCTAssertEqual(engine.cachedSettledMessageCount, 2)
        _ = engine.renderedBlocks(for: first)
        XCTAssertEqual(engine.settledMessagesParsed, 2, "a settled message is parsed once")

        // the roster drops the second message, and its cache leaves with it
        engine.setSettledMessages([first])
        XCTAssertEqual(engine.cachedSettledMessageCount, 1)
        _ = engine.renderedBlocks(for: first)
        XCTAssertEqual(engine.settledMessagesParsed, 2, "a message still on the roster keeps its cache")
        _ = engine.renderedBlocks(for: second)
        XCTAssertEqual(engine.settledMessagesParsed, 3, "a message off the roster is parsed again when asked for")
        engine.setSettledMessages([first])
        XCTAssertEqual(engine.cachedSettledMessageCount, 1, "asking for it did not put it back for good")

        // a stream that finishes is served from the cache, not parsed a second time
        engine.beginStreaming(messageId: "settled-c", initialText: "Third para")
        _ = engine.appendStreamingDelta("graph.\n\n```swift\nlet x = 1\n```", messageId: "settled-c")
        let streamedText = engine.activeStreamingText
        let settledBlocks = engine.activeStreamingBlocks.map { streamed in
            MacRenderedMarkdownBlock(id: streamed.id, block: streamed.block, isStreamingTail: false)
        }
        engine.finishStreaming(messageId: "settled-c")
        var third = Message(id: "settled-c", role: .bot, kind: .text, at: 3)
        third.text = streamedText

        let served = engine.renderedBlocks(for: third)
        XCTAssertEqual(engine.settledMessagesParsed, 3, "the finished stream is already in the cache")
        XCTAssertEqual(served, settledBlocks)

        // and text that differs from what streamed is still noticed
        third.text = "Patched after the stream."
        _ = engine.renderedBlocks(for: third)
        XCTAssertEqual(engine.settledMessagesParsed, 4, "patched text is parsed, not served stale")
    }

    func testAFinishedStreamThatTheRosterNeverTookLeavesTheCache() {
        let engine = MacTranscriptEngine()
        engine.beginStreaming(messageId: "settled-d", initialText: "Paragraph.")
        engine.finishStreaming(messageId: "settled-d")
        XCTAssertEqual(engine.cachedSettledMessageCount, 1)

        // the next roster does not carry the message, so nothing is held for it
        engine.setSettledMessages([])
        XCTAssertEqual(engine.cachedSettledMessageCount, 0)
        XCTAssertEqual(engine.settledMessageCount, 0)
    }
}
