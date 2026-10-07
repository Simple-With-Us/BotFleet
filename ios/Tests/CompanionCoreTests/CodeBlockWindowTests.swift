// The bound on what a code-block `Text` is allowed to measure.
//
// The hang is SwiftUI laying out the whole fence.  These tests lock the
// input to that layout: every page stays inside the line and character
// budgets, and paging the pages back together returns the fence.  They do
// not measure `Text`.  `ios/Scripts/CodeBlockLayoutProbe` does that on a Mac.
import XCTest
@testable import CompanionCore
#if os(macOS)
import AppKit
#endif

final class CodeBlockWindowTests: XCTestCase {
    func testEmptyFenceIsOneBlankPage() {
        let page = CodeBlockWindow.preview("", anchorToEnd: true)
        XCTAssertEqual(page.text, "")
        XCTAssertFalse(page.needsPaging)
        XCTAssertEqual(page.totalLines, 0)
        XCTAssertEqual(CodeBlockWindow.pageCount(in: ""), 1)
    }

    func testShortFenceIsUnchanged() {
        let source = "let x = 1\n    indented\n"
        let settled = CodeBlockWindow.preview(source, anchorToEnd: false)
        let live = CodeBlockWindow.preview(source, anchorToEnd: true)
        XCTAssertEqual(settled.text, source)
        XCTAssertEqual(live.text, source)
        XCTAssertFalse(settled.needsPaging)
        XCTAssertEqual(settled, live)
    }

    func testExactlyTheLineBudgetIsOnePage() {
        let source = lines(count: CodeBlockWindow.maxLines)
        let page = CodeBlockWindow.preview(source, anchorToEnd: false)
        XCTAssertEqual(page.text, source)
        XCTAssertFalse(page.needsPaging)
        XCTAssertEqual(page.startLine, 1)
        XCTAssertEqual(page.endLine, CodeBlockWindow.maxLines)
    }

    func testOneLinePastTheBudgetPagesAndRoundTrips() {
        let source = lines(count: CodeBlockWindow.maxLines + 1)
        let first = CodeBlockWindow.page(source, index: 0)
        let last = CodeBlockWindow.page(source, index: 1)
        XCTAssertEqual(CodeBlockWindow.pageCount(in: source), 2)
        XCTAssertTrue(first.needsPaging)
        XCTAssertEqual(first.startLine, 1)
        XCTAssertEqual(first.endLine, CodeBlockWindow.maxLines)
        XCTAssertEqual(last.startLine, CodeBlockWindow.maxLines + 1)
        XCTAssertEqual(last.endLine, CodeBlockWindow.maxLines + 1)
        XCTAssertEqual(first.text + last.text, source)
        XCTAssertFalse(first.continuesLine)
        XCTAssertFalse(last.resumesLine)
        XCTAssertEqual(
            first.caption,
            "Showing lines 1–\(CodeBlockWindow.maxLines) of \(CodeBlockWindow.maxLines + 1)."
        )
        XCTAssertEqual(CodeBlockWindow.preview(source, anchorToEnd: false).pageIndex, 0)
        XCTAssertEqual(CodeBlockWindow.preview(source, anchorToEnd: true).pageIndex, 1)
    }

    func testTrailingNewlineDoesNotInventAPage() {
        let source = lines(count: 3) + "\n"
        let page = CodeBlockWindow.preview(source, anchorToEnd: false)
        XCTAssertEqual(page.text, source)
        XCTAssertEqual(page.totalLines, 3)
        XCTAssertFalse(page.needsPaging)
    }

    func testCarriageReturnsStillPage() {
        let source = (1...250).map { "row \($0)" }.joined(separator: "\r\n")
        let normalised = source.replacingOccurrences(of: "\r\n", with: "\n")
        XCTAssertTrue(CodeBlockWindow.preview(source, anchorToEnd: false).needsPaging)
        XCTAssertEqual(reconstructed(source), normalised)
    }

    func testLongLineIsSplitOnTheCharacterBudget() {
        let extra = 25
        let source = String(repeating: "字", count: CodeBlockWindow.maxCharacters + extra)
        let first = CodeBlockWindow.page(source, index: 0)
        let second = CodeBlockWindow.page(source, index: 1)
        XCTAssertEqual(first.text.count, CodeBlockWindow.maxCharacters)
        XCTAssertEqual(second.text.count, extra)
        XCTAssertEqual(first.text + second.text, source)
        XCTAssertTrue(first.continuesLine)
        XCTAssertTrue(second.resumesLine)
        XCTAssertFalse(second.continuesLine)
        XCTAssertEqual(
            first.caption,
            "Showing line 1 of 1.  The rest of this line is on the next page."
        )
        XCTAssertEqual(
            second.caption,
            "Showing line 1 of 1.  This line continues from the previous page."
        )
    }

    func testMiddleSliceOfALongLineMentionsBothNeighbours() {
        let source = String(repeating: "a", count: CodeBlockWindow.maxCharacters * 2 + 3)
        let middle = CodeBlockWindow.page(source, index: 1)
        XCTAssertTrue(middle.resumesLine)
        XCTAssertTrue(middle.continuesLine)
        XCTAssertEqual(
            middle.caption,
            "Showing line 1 of 1.  This line continues from the previous page and onto the next."
        )
    }

    func testOutOfRangeIndexClamps() {
        let source = lines(count: CodeBlockWindow.maxLines + 1)
        XCTAssertEqual(CodeBlockWindow.page(source, index: -4).pageIndex, 0)
        XCTAssertEqual(CodeBlockWindow.page(source, index: 99).pageIndex, 1)
    }

    func testMixedScriptBlockStaysInsideTheRenderBudget() {
        let source = mixedScriptBlock(lines: 3_000)
        let started = ContinuousClock.now
        let count = CodeBlockWindow.pageCount(in: source)
        var built = ""
        for index in 0..<count {
            let page = CodeBlockWindow.page(source, index: index)
            XCTAssertLessThanOrEqual(page.text.count, CodeBlockWindow.maxCharacters)
            XCTAssertLessThanOrEqual(renderedLines(page.text), CodeBlockWindow.maxLines)
            XCTAssertLessThanOrEqual(page.endLine - page.startLine + 1, CodeBlockWindow.maxLines)
            built += page.text
        }
        let elapsed = ContinuousClock.now - started
        XCTAssertEqual(built, source)
        XCTAssertGreaterThan(count, 1)
        XCTAssertLessThan(elapsed, .milliseconds(500))
        let preview = CodeBlockWindow.preview(source, anchorToEnd: false)
        XCTAssertNotEqual(preview.text, source)
        XCTAssertEqual(preview.endLine - preview.startLine + 1, CodeBlockWindow.maxLines)
        XCTAssertEqual(preview.caption, "Showing lines 1–200 of 3,000.")
    }

    func testRandomFencesRoundTripInsideTheBudget() {
        var generator = SplitMix64(seed: 0xB07F_1EE7)
        for _ in 0..<30 {
            let source = randomSource(&generator)
            XCTAssertEqual(reconstructed(source), normalised(source))
        }
    }

    /// Times `boundingRect`, the call under `StyledTextLayoutEngine` in
    /// BOTFLEET-Y.  Linux CI cannot link AppKit; the Mac `swift test` job can.
    /// The SwiftUI hosting numbers come from `CodeBlockLayoutProbe`.
    #if os(macOS)
    func testCappedPageStaysUnderTheAppHangThreshold() {
        let full = mixedScriptBlock(lines: 3_000)
        let page = CodeBlockWindow.preview(full, anchorToEnd: false)
        XCTAssertLessThanOrEqual(renderedLines(page.text), CodeBlockWindow.maxLines)
        XCTAssertLessThanOrEqual(page.text.count, CodeBlockWindow.maxCharacters)
        let fullElapsed = boundingRectDuration(full)
        let pageElapsed = boundingRectDuration(page.text)
        print("code-block boundingRect page \(pageElapsed) full \(fullElapsed)")
        XCTAssertLessThan(
            pageElapsed,
            .milliseconds(1_500),
            "capped page \(pageElapsed); full fence \(fullElapsed).  App Hang fires at 2s."
        )
    }

    private func boundingRectDuration(_ string: String) -> Duration {
        let font = NSFont.monospacedSystemFont(ofSize: 14, weight: .regular)
        let attributed = NSAttributedString(string: string, attributes: [.font: font])
        let limit = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        _ = attributed.boundingRect(with: limit, options: [.usesLineFragmentOrigin])
        let started = ContinuousClock.now
        _ = attributed.boundingRect(with: limit, options: [.usesLineFragmentOrigin])
        return ContinuousClock.now - started
    }
    #endif

    func testParserOutputIsWhatTheViewWindows() {
        let body = lines(count: 240)
        let blocks = Markdown.blocks("```swift\n\(body)\n```")
        guard case let .code(language, text) = blocks.first else {
            return XCTFail("expected a code block")
        }
        XCTAssertEqual(language, "swift")
        let preview = CodeBlockWindow.preview(text, anchorToEnd: false)
        XCTAssertTrue(preview.needsPaging)
        XCTAssertLessThanOrEqual(renderedLines(preview.text), CodeBlockWindow.maxLines)
        XCTAssertNotEqual(preview.text, text)
    }

    private func reconstructed(_ source: String) -> String {
        let count = CodeBlockWindow.pageCount(in: source)
        return (0..<count).reduce(into: "") { built, index in
            let page = CodeBlockWindow.page(source, index: index)
            XCTAssertLessThanOrEqual(page.text.count, CodeBlockWindow.maxCharacters)
            XCTAssertLessThanOrEqual(renderedLines(page.text), CodeBlockWindow.maxLines)
            if !page.text.isEmpty {
                XCTAssertEqual(page.endLine, page.startLine + renderedLines(page.text) - 1)
            }
            built += page.text
        }
    }

    private func normalised(_ source: String) -> String {
        source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
    }

    private func lines(count: Int) -> String {
        (1...count).map { "line \($0)" }.joined(separator: "\n")
    }

    /// CJK, Arabic, emoji, and box drawing in one line.  That mix is what
    /// made the #626 harness slow, because shaping crosses script runs.
    private func mixedScriptBlock(lines: Int) -> String {
        (1...lines).map { index in
            "func 值\(index)() -> String { \"مرحبا \(index)\" } // 😀 ┃"
        }.joined(separator: "\n")
    }

    private func renderedLines(_ text: String) -> Int {
        if text.isEmpty { return 0 }
        var count = 1
        for character in text where character == "\n" { count += 1 }
        if text.hasSuffix("\n") { count -= 1 }
        return max(count, 1)
    }

    private func randomSource(_ generator: inout SplitMix64) -> String {
        let length = Int(generator.next() % 4_000)
        let alphabet: [Character] = Array("a\n _字م😀┃\r")
        var characters: [Character] = []
        characters.reserveCapacity(length)
        for _ in 0..<length {
            characters.append(alphabet[Int(generator.next() % UInt64(alphabet.count))])
        }
        if generator.next() % 5 == 0 {
            characters.append(contentsOf: Array(repeating: "x", count: CodeBlockWindow.maxCharacters + 10))
        }
        return String(characters)
    }
}

private struct SplitMix64 {
    var state: UInt64
    init(seed: UInt64) { state = seed }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
