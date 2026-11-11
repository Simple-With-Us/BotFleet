import Foundation
import XCTest
@testable import CompanionCore

/// The bubble's rendered words, and the voice lined up with them.
final class KaraokeDisplayTests: XCTestCase {
    private static let reply = """
    ## Release Check

    The archive is **signed**, and build 749 passed.  I read the [privacy manifest](https://example.com/privacy) first.

    - TestFlight accepts the upload.
    1. Widget refresh drops to 15 minutes.

    ```swift
    let ready = checks.allSatisfy(\\.passed)
    ```

    > Say the word.
    """

    func testDisplayTextIsTheRenderedRunsWithoutCodeOrMarkers() {
        let display = KaraokeDisplay(markdown: Self.reply)
        XCTAssertEqual(display.text, [
            "Release Check",
            "The archive is signed, and build 749 passed.  I read the privacy manifest first.",
            "TestFlight accepts the upload.",
            "Widget refresh drops to 15 minutes.",
            "Say the word.",
        ].joined(separator: "\n"))
        // Block indexes are the bubble's ForEach offsets; the fence (5) is skipped.
        XCTAssertEqual(display.blocks.map(\.index), [0, 1, 2, 3, 5])
        XCTAssertEqual(display.blocks[1].markdown, "The archive is **signed**, and build 749 passed.  I read the [privacy manifest](https://example.com/privacy) first.")
        XCTAssertFalse(display.words.contains { $0.text == "ready" || $0.text == "swift" })
        XCTAssertEqual(display.words.map(\.text), KaraokeAlign.tokenize(display.text).map(\.text))
    }

    func testEveryWordIsPlacedInItsBlocksOwnRun() {
        let display = KaraokeDisplay(markdown: Self.reply)
        XCTAssertEqual(display.places.count, display.words.count)
        for (word, place) in zip(display.words, display.places) {
            let block = display.blocks[place.block]
            let run = String(block.rendered.characters) as NSString
            XCTAssertEqual(run.substring(with: NSRange(location: place.start, length: place.end - place.start)), word.text)
        }
        let signed = display.words.firstIndex { $0.text == "signed" }!
        XCTAssertEqual(display.places[signed].block, 1)
        XCTAssertEqual(display.places[signed].start, "The archive is ".utf16.count)
    }

    func testTheInlineParseFallsBackToTheRawText() {
        XCTAssertEqual(String(Markdown.inlineAttributed("a **b** [c](https://x.y)").characters), "a b c")
        XCTAssertEqual(String(Markdown.inlineAttributed("half a [link").characters), "half a [link")
    }

    func testBubbleMarkdownDropsAttachmentsAndTheIMessageTag() {
        XCTAssertEqual(KaraokeDisplay.bubbleMarkdown("[to iMessage] See you at **six**."), "See you at **six**.")
        XCTAssertEqual(KaraokeDisplay.bubbleMarkdown("Plain reply."), "Plain reply.")
    }

    func testAFrameIsPaintedIntoTheBlocksItTouches() {
        let display = KaraokeDisplay(markdown: Self.reply)
        let passed = display.words.firstIndex { $0.text == "passed" }!
        let upload = display.words.firstIndex { $0.text == "upload" }!
        let frame = KaraokeFrame(current: upload, lit: 2, trail: [KaraokeTrailWord(index: passed, level: 1)])
        let paints = display.paints(for: frame)
        XCTAssertEqual(Set(paints.keys), [1, 2])
        let uploadPlace = display.places[upload]
        XCTAssertEqual(paints[2], KaraokeBlockPaint(lit: uploadPlace.start..<(uploadPlace.start + 2)))
        let passedPlace = display.places[passed]
        XCTAssertEqual(paints[1]?.trail, [KaraokeBlockPaint.Trail(range: passedPlace.start..<passedPlace.end, level: 1)])
        XCTAssertTrue(display.paints(for: .none).isEmpty)
        // A cut past the word's end stays inside the word.
        XCTAssertEqual(display.paints(for: KaraokeFrame(current: upload, lit: 99))[2]?.lit, uploadPlace.start..<uploadPlace.end)
    }

    // MARK: - End to end

    /// The harness's written script for the reply, its spans, and the
    /// rendered bubble: every display word the voice says is paired, the
    /// code block it names instead of reading is not in the display text,
    /// and the timeline reaches every word in order.
    func testTheVoiceLinesUpWithTheRenderedReply() throws {
        let source = SpeechProjection.writtenReply(Self.reply)
        let spoken = SpeechSpans.utterancesWithSpans(source)
        let script = KaraokeScript.fromWire(
            utterances: spoken.map(\.text),
            wire: SpokenSpansWire.encode(sourceText: source, utterances: spoken)
        )
        XCTAssertTrue(script.guides(source))
        let display = KaraokeDisplay(markdown: KaraokeDisplay.bubbleMarkdown(Self.reply))
        let alignment = KaraokeAlign.alignSpokenToDisplay(
            spokenText: script.spokenText,
            displayText: display.text,
            segments: script.segments,
            sourceText: source
        )
        XCTAssertTrue(alignment.guided)
        XCTAssertEqual(alignment.displayWords, display.words)

        let mapping = alignment.mapping
        for (index, word) in display.words.enumerated() {
            XCTAssertGreaterThanOrEqual(mapping.displayFirstSpoken[index], 0, "\(word.text) should be spoken")
        }
        // "(a Swift code block)" is said in place of the fence: inserted words.
        let codeWord = try XCTUnwrap(alignment.spokenWords.firstIndex { $0.key == "code" })
        XCTAssertEqual(mapping.spokenKind[codeWord], KaraokeAlign.spokenInserted)

        let timeline = KaraokeAlign.buildTimeline(
            spokenTimes: KaraokeAlign.proportionalWordTimes(alignment.spokenWords, clips: script.estimatedClips()),
            mapping: mapping
        )
        XCTAssertEqual(timeline.count, display.words.count * 2)
        for i in 0..<display.words.count {
            XCTAssertLessThanOrEqual(timeline[2 * i], timeline[2 * i + 1])
            if i > 0 { XCTAssertGreaterThanOrEqual(timeline[2 * i], timeline[2 * i - 2]) }
        }
    }

    /// Spoken digit by digit, a number on screen is still one word.
    func testANumberReadOutStillLightsTheNumberOnScreen() {
        let display = KaraokeDisplay(markdown: "Build **749** passed.")
        let alignment = KaraokeAlign.alignSpokenToDisplay(spokenText: "Build seven four nine passed.", displayText: display.text)
        let number = display.words.firstIndex { $0.text == "749" }!
        XCTAssertEqual(alignment.mapping.displayFirstSpoken[number], 1)
        XCTAssertEqual(alignment.mapping.displayLastSpoken[number], 3)
    }
}
