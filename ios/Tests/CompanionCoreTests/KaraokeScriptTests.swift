import Foundation
import XCTest
@testable import CompanionCore

/// The spoken script and its spans as the harness hands them over
/// (shared/spoken-script.ts), and the written reply they index.
final class KaraokeScriptTests: XCTestCase {
    private static let source = [
        "## Status",
        "",
        "Build **749** passed on `main`.  The fix is in server/tts/message-audio.ts.",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "- First item here",
        "- Second item, with [a link](https://example.com)",
    ].joined(separator: "\n")

    private func utf16Slice(_ text: String, _ start: Int, _ end: Int) -> String {
        (text as NSString).substring(with: NSRange(location: start, length: end - start))
    }

    // MARK: - Wire

    func testSpansRoundTripOntoTheJoinedUtterances() throws {
        let spoken = SpeechSpans.utterancesWithSpans(Self.source)
        let utterances = spoken.map(\.text)
        let wire = SpokenSpansWire.encode(sourceText: Self.source, utterances: spoken)
        XCTAssertEqual(wire.format, 1)
        XCTAssertEqual(wire.source, "written")
        XCTAssertEqual(wire.sourceLength, Self.source.utf16.count)
        XCTAssertEqual(wire.utterances.count, utterances.count)

        // Through JSON, as it arrives.
        let decoded = try JSONDecoder().decode(SpokenSpansWire.self, from: JSONEncoder().encode(wire))
        let script = KaraokeScript.fromWire(utterances: utterances, wire: decoded)
        XCTAssertEqual(script.spokenText, utterances.joined(separator: " "))
        XCTAssertEqual(script.sourceLength, Self.source.utf16.count)
        XCTAssertEqual(script.utterances.map { utf16Slice(script.spokenText, $0.spokenStart, $0.spokenEnd) }, utterances)

        var copies = 0
        for segment in script.segments where segment.kind == .copy {
            copies += 1
            XCTAssertEqual(
                utf16Slice(script.spokenText, segment.spokenStart, segment.spokenEnd),
                utf16Slice(Self.source, segment.srcStart, segment.srcEnd)
            )
        }
        XCTAssertGreaterThan(copies, 3)
        for i in 1..<script.segments.count {
            XCTAssertGreaterThanOrEqual(script.segments[i].srcStart, script.segments[i - 1].srcStart)
            XCTAssertGreaterThanOrEqual(script.segments[i].spokenStart, script.segments[i - 1].spokenEnd)
        }
        XCTAssertTrue(script.guides(Self.source))
        XCTAssertFalse(script.guides(Self.source + " "), "another written text has another length")
    }

    func testSpansThatDoNotCheckOutAreDroppedAndTheUtterancesKept() {
        let spoken = SpeechSpans.utterancesWithSpans(Self.source)
        let utterances = spoken.map(\.text)
        let good = SpokenSpansWire.encode(sourceText: Self.source, utterances: spoken)
        func replacingFirst(_ flat: [Int]) -> SpokenSpansWire {
            var wire = good
            wire.utterances[0] = flat
            return wire
        }
        var otherFormat = good
        otherFormat.format = 2
        var otherSource = good
        otherSource.source = "summary"
        var missingUtterance = good
        missingUtterance.utterances.removeFirst()
        var shortSource = good
        shortSource.sourceLength = 3
        let broken = [
            otherFormat,
            otherSource,
            missingUtterance,
            shortSource,
            replacingFirst(good.utterances[0] + [1]),
            replacingFirst([0, 9_999, 0, 1, 0]),
            replacingFirst([0, 1, 0, 1, 7]),
            replacingFirst([0, 1, -1, 1, 0]),
            replacingFirst([2, 1, 0, 1, 0]),
        ]
        for wire in broken {
            let script = KaraokeScript.fromWire(utterances: utterances, wire: wire)
            XCTAssertEqual(script.spokenText, utterances.joined(separator: " "))
            XCTAssertEqual(script.utterances.count, utterances.count)
            XCTAssertTrue(script.segments.isEmpty, "\(wire)")
            XCTAssertNil(script.sourceLength)
            XCTAssertFalse(script.guides(Self.source))
        }
        XCTAssertTrue(KaraokeScript.fromWire(utterances: utterances, wire: nil).segments.isEmpty)
    }

    func testSourceStartsMustNotGoBackAcrossUtterances() {
        let utterances = ["First one here.", "Second one here."]
        let wire = SpokenSpansWire(sourceLength: 40, utterances: [[0, 15, 20, 35, 0], [0, 16, 0, 16, 0]])
        XCTAssertTrue(KaraokeScript.fromWire(utterances: utterances, wire: wire).segments.isEmpty)
    }

    // MARK: - The /audio answer

    func testAWrittenAnswerCarriesItsKaraokeScript() throws {
        let spoken = SpeechSpans.utterancesWithSpans(Self.source)
        let wire = SpokenSpansWire.encode(sourceText: Self.source, utterances: spoken)
        let body: [String: Any] = [
            "audio": [], "utterances": spoken.map(\.text), "total": spoken.count, "complete": false,
            "script": "written",
            "spans": ["format": 1, "source": "written", "sourceLength": wire.sourceLength, "utterances": wire.utterances],
        ]
        let answer = try JSONDecoder().decode(MessageVoice.self, from: JSONSerialization.data(withJSONObject: body))
        XCTAssertEqual(answer.script, "written")
        XCTAssertEqual(answer.spans, wire)
        let script = try XCTUnwrap(answer.karaokeScript)
        XCTAssertEqual(script.utterances.count, answer.clipCount)
        XCTAssertTrue(script.guides(SpeechProjection.writtenReply(Self.source)))
    }

    func testASummaryOrAnOlderHarnessHasNoKaraoke() throws {
        let summary = try JSONDecoder().decode(
            MessageVoice.self,
            from: Data(#"{"audio":[],"utterances":["A short summary."],"total":1,"script":"summary"}"#.utf8)
        )
        XCTAssertNil(summary.karaokeScript)
        let older = try JSONDecoder().decode(
            MessageVoice.self,
            from: Data(#"{"audio":[],"utterances":["Read as written."],"total":1}"#.utf8)
        )
        XCTAssertNil(older.script)
        XCTAssertNil(older.karaokeScript)
    }

    func testMalformedSpansAreDroppedWithoutFailingTheAnswer() throws {
        let answer = try JSONDecoder().decode(
            MessageVoice.self,
            from: Data(#"{"audio":[],"utterances":["Read as written."],"total":1,"script":"written","spans":{"format":"one","utterances":"no"}}"#.utf8)
        )
        XCTAssertEqual(answer.clipCount, 1)
        XCTAssertNil(answer.spans)
        let script = try XCTUnwrap(answer.karaokeScript, "still karaoke, unguided")
        XCTAssertTrue(script.segments.isEmpty)
        XCTAssertEqual(script.spokenText, "Read as written.")
    }

    // MARK: - Chunks and clips

    func testChunksAreFoundInOrderSoARepeatedSentenceMapsToItsOwnPlace() {
        let script = KaraokeScript.unguided(utterances: ["Yes.", "Done here.", "Yes.", "All good."])
        XCTAssertEqual(script.spokenText, "Yes. Done here. Yes. All good.")
        XCTAssertEqual(script.chunkStarts(["Yes. Done here.", "Yes. All good."]), [0, 16])
        XCTAssertEqual(script.chunkStarts(["Yes.", "Not spoken.", "Done here."]), [0, -1, 5])
        XCTAssertEqual(script.chunkStarts(["", "Yes."]), [-1, 0])
    }

    func testClipWindowsAreEstimatedBackToBack() {
        let script = KaraokeScript.unguided(utterances: ["One two.", "Three."])
        let clips = script.estimatedClips(msPerChar: 10)
        XCTAssertEqual(clips, [
            KaraokeClip(spokenStart: 0, spokenEnd: 8, startMs: 0, durationMs: 80),
            KaraokeClip(spokenStart: 9, spokenEnd: 15, startMs: 80, durationMs: 60),
        ])
    }

    func testOffsetsAreUTF16() {
        let script = KaraokeScript.unguided(utterances: ["Ship it 🚀 now.", "Next."])
        XCTAssertEqual(script.utterances[0].spokenEnd, "Ship it 🚀 now.".utf16.count)
        XCTAssertEqual(script.utterances[1].spokenStart, "Ship it 🚀 now.".utf16.count + 1)
        XCTAssertEqual(script.chunkStarts(["Next."]), [script.utterances[1].spokenStart])
    }

    // MARK: - writtenReply (shared/voice-summary.ts)

    func testWrittenReplyLeavesAnOrdinaryReplyExactlyAsWritten() {
        XCTAssertEqual(SpeechProjection.writtenReply(""), "")
        XCTAssertEqual(SpeechProjection.writtenReply("  Plain reply.\n"), "  Plain reply.\n")
        XCTAssertEqual(SpeechProjection.writtenReply(Self.source), Self.source)
        // A mention of the tags inside the reply is not the protocol.
        let mention = "Use [voice_summary] tags when the app asks."
        XCTAssertEqual(SpeechProjection.writtenReply(mention), mention)
    }

    func testWrittenReplyTakesTheWrittenHalfOfTheProtocol() {
        let reply = "[voice_summary]\nIt worked.\n[/voice_summary]\n[written_answer]\nThe build **passed**.\n\nDetails here.\n[/written_answer]\n"
        XCTAssertEqual(SpeechProjection.writtenReply(reply), "The build **passed**.\n\nDetails here.")
        // An unclosed written section still runs to the end.
        XCTAssertEqual(
            SpeechProjection.writtenReply("[voice_summary]Short.[/voice_summary][written_answer]  Long answer.  "),
            "Long answer."
        )
    }

    func testWrittenReplyStripsAHalfFinishedProtocol() {
        // Only the voice section so far: the rest is what was written.
        XCTAssertEqual(
            SpeechProjection.writtenReply("[voice_summary]\nSpoken part\n[/voice_summary]\nThen the answer."),
            "Then the answer."
        )
        // A written section without a complete pair.
        XCTAssertEqual(
            SpeechProjection.writtenReply("[voice_summary][/voice_summary][written_answer]Answer[/written_answer]"),
            "Answer"
        )
        // Nothing but the voice section: the reply is kept as it was.
        let onlyVoice = "[voice_summary]"
        XCTAssertEqual(SpeechProjection.writtenReply(onlyVoice), onlyVoice)
    }
}
