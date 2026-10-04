import XCTest
@testable import CompanionCore

final class PersonalVoiceChunkerTests: XCTestCase {
    func testEmptyAndWhitespaceInput() {
        XCTAssertEqual(PersonalVoiceChunker.chunk(text: ""), [])
        XCTAssertEqual(PersonalVoiceChunker.chunk(text: "   \n\t  "), [])
    }

    func testShortMessageRemainsSingleChunk() {
        let text = "Hello from BotFleet!  This is a short reply."
        let chunks = PersonalVoiceChunker.chunk(text: text)
        XCTAssertEqual(chunks, [text])
    }

    func testMultipleSentencesGroupedGreedilyUnderLimit() {
        let s1 = "This is the first sentence."
        let s2 = "This is the second sentence."
        let s3 = "This is the third sentence."
        let combined = "\(s1)  \(s2)  \(s3)"

        // Using a limit that fits two sentences but not three
        let limit = s1.count + s2.count + 5
        let chunks = PersonalVoiceChunker.chunk(text: combined, maxCharacters: limit)

        XCTAssertEqual(chunks.count, 2)
        XCTAssertTrue(chunks[0].contains(s1))
        XCTAssertTrue(chunks[0].contains(s2))
        XCTAssertEqual(chunks[1], s3)
    }

    func testPreservesAbbreviationsWithoutErroneousSplits() {
        let text = "We have many options, e.g., option A and option B.  Please select Dr.  Smith's schedule."
        let chunks = PersonalVoiceChunker.chunk(text: text, maxCharacters: 500)
        XCTAssertEqual(chunks.count, 1)
        XCTAssertEqual(chunks[0], text)
    }

    func testOversizedSentenceSplitsOnClauseDelimiters() {
        let clause1 = String(repeating: "A", count: 80)
        let clause2 = String(repeating: "B", count: 80)
        let clause3 = String(repeating: "C", count: 80)
        let sentence = "\(clause1), \(clause2); \(clause3)."

        let chunks = PersonalVoiceChunker.chunk(text: sentence, maxCharacters: 120)
        XCTAssertGreaterThan(chunks.count, 1)
        for chunk in chunks {
            XCTAssertLessThanOrEqual(chunk.count, 120)
        }
    }

    func testOversizedSentenceSplitsOnWordBoundaries() {
        let sentence = "word " + String(repeating: "testword ", count: 30)
        let chunks = PersonalVoiceChunker.chunk(text: sentence, maxCharacters: 80)

        XCTAssertGreaterThan(chunks.count, 1)
        for chunk in chunks {
            XCTAssertLessThanOrEqual(chunk.count, 80)
            XCTAssertFalse(chunk.isEmpty)
        }
    }

    func testOverlongUnbrokenWordSlicesAtMaxCharacters() {
        let giantWord = String(repeating: "X", count: 250)
        let chunks = PersonalVoiceChunker.chunk(text: giantWord, maxCharacters: 100)

        XCTAssertEqual(chunks.count, 3)
        XCTAssertEqual(chunks[0].count, 100)
        XCTAssertEqual(chunks[1].count, 100)
        XCTAssertEqual(chunks[2].count, 50)
    }

    func testTypicalLongBotReplyChunksStayUnderDefaultCeiling() {
        let paragraph = """
        BotFleet is an open fleet management platform for autonomous coding agents.  It coordinates multiple agent seats across Slack, local worktrees, and cloud environments.  Each agent runs with isolated workspace leases, explicit git branches, and dedicated verification gates.

        When synthesizing voice messages, Apple Personal Voice requires on-device processing.  AVFoundation synthesizers impose strict buffer and duration ceilings.  By segmenting long replies into natural sentence chunks of roughly 600 to 800 characters, audio output remains smooth, natural, and free of synthesis dropouts.

        Furthermore, each chunk can be retried independently if the system audio daemon experiences a temporary interruption.  One bad chunk never discards the rest of the message.
        """

        let chunks = PersonalVoiceChunker.chunk(text: paragraph, maxCharacters: 600)
        XCTAssertGreaterThanOrEqual(chunks.count, 2)
        for chunk in chunks {
            XCTAssertLessThanOrEqual(chunk.count, 600)
            XCTAssertFalse(chunk.isEmpty)
        }

        // Verify all words from the original text are preserved across chunks
        let originalWords = Set(paragraph.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty })
        let chunkedWords = Set(chunks.joined(separator: " ").components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty })
        XCTAssertEqual(originalWords, chunkedWords)
    }
}
