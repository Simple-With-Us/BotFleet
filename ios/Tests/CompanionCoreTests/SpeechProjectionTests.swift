import Foundation
import XCTest
@testable import CompanionCore

final class SpeechProjectionTests: XCTestCase {
    // MARK: - speakable

    func testMarkdownSyntaxIsDroppedAndArtifactsAreNamed() {
        XCTAssertEqual(SpeechProjection.speakable("**Done.** See [the PR](https://github.com/x/y/pull/1)."), "Done. See the PR.")
        XCTAssertEqual(SpeechProjection.speakable("Open https://example.com/a?b=c now"), "Open a link now")
        XCTAssertEqual(SpeechProjection.speakable("Edit `server/drivers/acp/core.ts` first"), "Edit core.ts first")
        XCTAssertEqual(SpeechProjection.speakable("## Summary"), "Summary.")
        XCTAssertEqual(SpeechProjection.speakable("- one\n- two"), "one. two")
        XCTAssertEqual(SpeechProjection.speakable("Run this:\n```swift\nlet x = 1\n```\nThen stop."), "Run this:. (a Swift code block). Then stop.")
    }

    func testTablesReadAsCellsAndEmojiAreSilent() {
        XCTAssertEqual(SpeechProjection.speakable("| a | b |\n|---|---|\n| 1 | 2 |"), "a, b. 1, 2")
        XCTAssertEqual(SpeechProjection.speakable("Shipped 🚀"), "Shipped")
    }

    func testNothingSpeakableIsEmpty() {
        XCTAssertEqual(SpeechProjection.speakable("   \n\n  "), "")
        XCTAssertEqual(SpeechProjection.speakable("---"), "")
    }

    // MARK: - voice-summary protocol

    func testTheVoiceSectionIsSpokenWhenTheReplyCarriesOne() {
        let reply = "[voice_summary]Short version.[/voice_summary][written_answer]Long **written** version.[/written_answer]"
        XCTAssertEqual(SpeechProjection.spokenReply(reply), "Short version.")
    }

    func testStrayProtocolTagsAreNeverSpoken() {
        XCTAssertEqual(SpeechProjection.spokenReply("Plain [written_answer]reply"), "Plain reply")
        XCTAssertEqual(SpeechProjection.spokenReply("Nothing special."), "Nothing special.")
    }

    // MARK: - segments

    func testParagraphsSplitBeforeSentencesAndMarkTheirEnd() {
        let reply = "First paragraph.  Still first.\n\nSecond paragraph.\n\n```\nlet a = 1\n\nlet b = 2\n```"
        let segments = SpeechProjection.segments(fromReply: reply)
        XCTAssertEqual(segments, [
            SpeechSegment(text: "First paragraph. Still first.", endsParagraph: true),
            SpeechSegment(text: "Second paragraph.", endsParagraph: true),
            SpeechSegment(text: "(a code block)", endsParagraph: true),
        ])
    }

    func testAttachmentMarkersAreNotSpoken() {
        let segments = SpeechProjection.segments(fromReply: "Here it is.\n<attached-image path=\"/tmp/a.png\">")
        XCTAssertFalse(segments.map(\.text).joined().contains("attached"))
    }

    func testLongParagraphsStayUnderTheUtteranceCap() {
        let sentence = "This sentence is here to make a paragraph long enough to need several utterances."
        let reply = Array(repeating: sentence, count: 20).joined(separator: " ")
        let segments = SpeechProjection.segments(fromReply: reply)
        XCTAssertGreaterThan(segments.count, 3)
        for segment in segments {
            XCTAssertLessThanOrEqual(segment.text.count, SpeechProjection.maxSegmentCharacters)
        }
        XCTAssertEqual(segments.filter(\.endsParagraph).count, 1)
    }

    func testServerUtterancesArePackedWithoutCrossingTheCap() {
        // "One. Two." (9) + a 313-character sentence would be 323, over the
        // cap; the long one then has room for "Four." (319).
        let long = String(repeating: "x", count: 312) + "."
        let utterances = ["One.", "Two.", long, "Four."]
        let segments = SpeechProjection.segments(fromUtterances: utterances)
        XCTAssertEqual(segments.map(\.text), ["One. Two.", long + " Four."])
        XCTAssertTrue(segments.allSatisfy { !$0.endsParagraph })
    }

    // MARK: - resume after a spontaneous cancel

    func testNothingSpokenRetriesTheWholeUtterance() {
        XCTAssertEqual(PersonalVoiceResume.remainder(of: "Hello there world.", nextRangeLocation: 0), "Hello there world.")
    }

    func testResumeStartsAtTheWordThatWasAboutToBeSpoken() {
        XCTAssertEqual(PersonalVoiceResume.remainder(of: "Hello there world.", nextRangeLocation: 6), "there world.")
    }

    func testResumePastTheEndHasNothingLeft() {
        XCTAssertEqual(PersonalVoiceResume.remainder(of: "Hi.", nextRangeLocation: 3), "")
        XCTAssertEqual(PersonalVoiceResume.remainder(of: "Hi.", nextRangeLocation: 99), "")
    }

    func testResumeCountsInUTF16AndNeverSplitsAnEmoji() {
        let text = "🚀 launch now"
        // UTF-16: the rocket is two code units, so "launch" starts at 3.
        XCTAssertEqual(PersonalVoiceResume.remainder(of: text, nextRangeLocation: 3), "launch now")
        // A location inside the surrogate pair snaps back to the emoji.
        XCTAssertEqual(PersonalVoiceResume.remainder(of: text, nextRangeLocation: 1), text)
    }

    // MARK: - watchdog

    func testTheDeadlineAllowsAQuietLongUtterance() {
        let start = Date(timeIntervalSince1970: 0)
        // 280 characters with no word callbacks: 280 / 14 * 2 + 5 = 45 s.
        let deadline = SpeechWatchdog.deadline(startedAt: start, lastProgressAt: start, utf16Length: 280)
        XCTAssertEqual(deadline.timeIntervalSince(start), 45, accuracy: 0.001)
    }

    func testRecentProgressExtendsTheDeadline() {
        let start = Date(timeIntervalSince1970: 0)
        let progress = start.addingTimeInterval(40)
        let deadline = SpeechWatchdog.deadline(startedAt: start, lastProgressAt: progress, utf16Length: 280)
        XCTAssertEqual(deadline.timeIntervalSince(start), 50, accuracy: 0.001)
    }

    func testAShortUtteranceStillGetsTheStartupSlack() {
        let start = Date(timeIntervalSince1970: 0)
        let deadline = SpeechWatchdog.deadline(startedAt: start, lastProgressAt: start, utf16Length: 0)
        XCTAssertEqual(deadline.timeIntervalSince(start), SpeechWatchdog.stallSeconds, accuracy: 0.001)
    }

    // MARK: - turn guard

    func testOnlyTheActiveUtteranceReportsProgress() {
        var guardrail = SpeechTurnGuard()
        let first = NSObject()
        let second = NSObject()
        guardrail.begin(utterance: first)
        XCTAssertTrue(guardrail.isActive(utterance: first))
        guardrail.begin(utterance: second)
        XCTAssertFalse(guardrail.isActive(utterance: first))
        XCTAssertTrue(guardrail.isActive(utterance: second))
        guardrail.stop()
        XCTAssertFalse(guardrail.isActive(utterance: second))
    }
}
