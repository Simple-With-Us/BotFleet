// How much of a fenced block SwiftUI is allowed to measure at once.
//
// BOTFLEET-Y / BOTFLEET-Z hang in `StyledTextLayoutEngine.sizeThatFits`
// while it shapes one code-block string (`boundingRect` → Core Text →
// `ScriptTagForScriptCode`).  PR #626 replaced that `Text` with a
// non-scrolling `UITextView`.  The view still has to report its full
// intrinsic size, so TextKit 2 never gets a viewport and the hang got
// worse.  A `LazyVStack` of lines inside the horizontal scroller fails
// the same way: the chat transcript is an eager `VStack`, so the block
// is asked for its full height and every row is built.
//
// A page is one string.  The bubble and the full-code reader each mount
// one page.  Nothing in this type depends on a lazy stack actually being
// lazy.
import Foundation

public struct CodeBlockPage: Equatable, Sendable {
    /// The only string a code-block `Text` may measure for this page.
    public var text: String
    /// 1-based.  Zero when `text` is empty.
    public var startLine: Int
    public var endLine: Int
    public var totalLines: Int
    public var pageIndex: Int
    public var pageCount: Int
    /// The previous page ended in the middle of this line.
    public var resumesLine: Bool
    /// This page ends in the middle of a line.  The rest is on the next page.
    public var continuesLine: Bool

    public var needsPaging: Bool { pageCount > 1 }
    public var hasEarlier: Bool { pageIndex > 0 }
    public var hasLater: Bool { pageIndex + 1 < pageCount }

    /// Secondary caption under a truncated block.  Two spaces before the
    /// second sentence so the gap survives in the product UI.
    public var caption: String {
        let lead: String
        if startLine == endLine {
            lead = "Showing line \(Self.grouped(startLine)) of \(Self.grouped(totalLines))."
        } else {
            lead = "Showing lines \(Self.grouped(startLine))–\(Self.grouped(endLine)) of \(Self.grouped(totalLines))."
        }
        switch (resumesLine, continuesLine) {
        case (true, true):
            return lead + "  This line continues from the previous page and onto the next."
        case (false, true):
            return lead + "  The rest of this line is on the next page."
        case (true, false):
            return lead + "  This line continues from the previous page."
        case (false, false):
            return lead
        }
    }

    private static func grouped(_ value: Int) -> String {
        let digits = String(abs(value))
        var out = ""
        for (offset, character) in digits.reversed().enumerated() {
            if offset > 0, offset.isMultiple(of: 3) { out.append(",") }
            out.append(character)
        }
        return String(out.reversed())
    }
}

public enum CodeBlockWindow {
    /// Review budget from the #626 close.  A few hundred monospaced lines
    /// measure in a frame.  Thousands are the hang.
    public static let maxLines = 200
    /// Grapheme budget for one page.  The line cap does not bound a single
    /// minified run, and mixed-script shaping is paid per character.
    public static let maxCharacters = 40_000

    /// Settled blocks open on the first page.  A streaming block follows
    /// the last page so the caret stays on the live end.
    public static func preview(_ source: String, anchorToEnd: Bool) -> CodeBlockPage {
        let built = layout(source)
        let index = anchorToEnd ? max(built.pageCount - 1, 0) : 0
        return built.page(at: index)
    }

    public static func pageCount(in source: String) -> Int {
        layout(source).pageCount
    }

    public static func page(_ source: String, index: Int) -> CodeBlockPage {
        layout(source).page(at: index)
    }

    private struct Mark {
        var start: String.Index
        var end: String.Index
        var startLine: Int
        var endLine: Int
    }

    private struct Layout {
        var source: String
        var marks: [Mark]
        var totalLines: Int

        var pageCount: Int { max(marks.count, 1) }

        func page(at index: Int) -> CodeBlockPage {
            guard let mark = marks.isEmpty ? nil : marks[min(max(0, index), marks.count - 1)] else {
                return CodeBlockPage(
                    text: "",
                    startLine: 0,
                    endLine: 0,
                    totalLines: 0,
                    pageIndex: 0,
                    pageCount: 1,
                    resumesLine: false,
                    continuesLine: false
                )
            }
            let resolved = min(max(0, index), marks.count - 1)
            let resumes = mark.start > source.startIndex
                && source[source.index(before: mark.start)] != "\n"
            let continues = mark.end < source.endIndex
                && source[source.index(before: mark.end)] != "\n"
            let text = String(source[mark.start..<mark.end])
            assert(text.count <= maxCharacters)
            assert(renderedLineCount(text) <= maxLines)
            return CodeBlockPage(
                text: text,
                startLine: mark.startLine,
                endLine: mark.endLine,
                totalLines: totalLines,
                pageIndex: resolved,
                pageCount: marks.count,
                resumesLine: resumes,
                continuesLine: continues
            )
        }
    }

    private static func layout(_ source: String) -> Layout {
        let source = normalisedNewlines(source)
        guard !source.isEmpty else {
            return Layout(source: source, marks: [], totalLines: 0)
        }

        var marks: [Mark] = []
        var pageStart = source.startIndex
        var pageStartLine = 1
        var line = 1
        var linesInPage = 0
        var charsInPage = 0
        var index = source.startIndex

        func close(at end: String.Index, endLine: Int, nextStartLine: Int) {
            guard end > pageStart else { return }
            marks.append(Mark(start: pageStart, end: end, startLine: pageStartLine, endLine: endLine))
            pageStart = end
            pageStartLine = nextStartLine
            linesInPage = 0
            charsInPage = 0
        }

        while index < source.endIndex {
            let character = source[index]
            let next = source.index(after: index)
            if character == "\n" {
                // A full page must close before this newline.  `linesInPage > 0`
                // keeps an empty page from spinning if the budget is ever zero.
                if linesInPage >= maxLines, linesInPage > 0 {
                    close(at: index, endLine: line, nextStartLine: line)
                    continue
                }
                charsInPage += 1
                linesInPage += 1
                let finished = line
                line += 1
                index = next
                if linesInPage >= maxLines || charsInPage >= maxCharacters {
                    close(at: index, endLine: finished, nextStartLine: line)
                }
                continue
            }
            if charsInPage >= maxCharacters, charsInPage > 0 {
                close(at: index, endLine: line, nextStartLine: line)
                continue
            }
            charsInPage += 1
            index = next
            if charsInPage >= maxCharacters {
                close(at: index, endLine: line, nextStartLine: line)
            }
        }

        if pageStart < source.endIndex {
            let endedOnNewline = source[source.index(before: source.endIndex)] == "\n"
            let endLine = endedOnNewline ? line - 1 : line
            close(at: source.endIndex, endLine: endLine, nextStartLine: line)
        }

        let totalLines = source.hasSuffix("\n") ? max(line - 1, 1) : line
        return Layout(source: source, marks: marks, totalLines: totalLines)
    }

    private static func renderedLineCount(_ text: String) -> Int {
        if text.isEmpty { return 0 }
        var count = 1
        for character in text where character == "\n" { count += 1 }
        if text.hasSuffix("\n") { count -= 1 }
        return max(count, 1)
    }

    /// Fence bodies are already `\n` after `Markdown.blocks`.  A raw CR
    /// still has to count as a line break, or one long `\r\n` run becomes
    /// a single line and walks around the line cap.
    private static func normalisedNewlines(_ source: String) -> String {
        guard source.contains("\r") else { return source }
        return source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
    }
}
