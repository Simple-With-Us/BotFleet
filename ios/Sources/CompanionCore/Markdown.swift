// Markdown, split into blocks.
//
// The desktop renders bot replies with react-markdown + GFM. The phone was
// showing the source: `**bold**`, `- ` bullets and `[text](url)` arriving as
// literal characters, which is worse than no markdown at all — it is the
// author's intent visible but not applied.
//
// Foundation can already do the *inline* half. `AttributedString(markdown:)`
// handles emphasis, code spans, strikethrough and links, and SwiftUI renders
// the links tappable for free. What it will not do is lay out blocks: with
// `.full` it records a presentation intent and leaves you to draw the bullet,
// the indent and the spacing yourself. So this splits the text into blocks
// and the view draws each one, handing the inline run back to Foundation.
//
// Deliberately not a full CommonMark implementation. It covers what a model
// actually emits into a chat bubble — paragraphs, lists, headings, fences,
// quotes, rules, tables — and treats anything it does not recognise as text,
// which is the failure mode that loses nothing.
import Foundation

/// How a table column lines up, from the colons in its delimiter cell:
/// `:--` leading, `:-:` centre, `--:` trailing. No colon is leading, which
/// is what GFM renders for a plain `---`.
public enum TableAlignment: Equatable, Sendable {
    case leading
    case center
    case trailing
}

public enum MarkdownBlock: Equatable, Sendable {
    case paragraph(String)
    /// `indent` is nesting depth, 0 for a top-level item.
    case bullet(indent: Int, text: String)
    case ordered(indent: Int, number: Int, text: String)
    case heading(level: Int, text: String)
    /// A fenced block. `language` is whatever followed the opening fence.
    case code(language: String?, text: String)
    case quote(String)
    /// A GFM pipe table. Every row has exactly `header.count` cells —
    /// short rows are padded with "" and long ones trimmed — and
    /// `alignments` has one entry per column, so a view can index all
    /// three by column without re-checking counts. Cells are inline
    /// markdown, handed to Foundation like any other run.
    case table(header: [String], alignments: [TableAlignment], rows: [[String]])
    case rule
}

public enum Markdown {
    /// Split into blocks. Never throws and never drops input: an unparseable
    /// line ends up in a paragraph, which is what the reader wanted anyway.
    public static func blocks(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            // GFM: a single newline inside a paragraph is a soft break, which
            // renders as a space. The desktop does not enable `breaks`, so
            // neither does this — the two should wrap the same way.
            blocks.append(.paragraph(paragraph.joined(separator: " ")))
            paragraph.removeAll()
        }

        // Normalise the line endings before splitting, because
        // `CharacterSet.newlines` contains \r and \n *separately* and
        // `components(separatedBy:)` breaks on each of them: "a\r\nb" comes
        // back as ["a", "", "b"], one phantom empty line per CRLF. That empty
        // line is not cosmetic — it calls `flushParagraph`, so a paragraph
        // written across several lines arrives as one paragraph per line, and
        // a fenced block gains a blank line between every line of code. Tool
        // output and pasted text reach chat bubbles with CRLF intact, so this
        // is a path real messages take.
        let normalised = source.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        var lines = normalised.components(separatedBy: "\n")[...]
        while let line = lines.first {
            lines = lines.dropFirst()
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // A fence runs to its closing fence, or to the end — a reply still
            // streaming has an open one, and showing it as code beats showing
            // three backticks and waiting.
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushParagraph()
                let marker = String(trimmed.prefix(3))
                let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                while let next = lines.first {
                    lines = lines.dropFirst()
                    if next.trimmingCharacters(in: .whitespaces).hasPrefix(marker) { break }
                    body.append(next)
                }
                blocks.append(.code(language: language.isEmpty ? nil : language, text: body.joined(separator: "\n")))
                continue
            }

            if trimmed.isEmpty {
                flushParagraph()
                continue
            }

            // --- or *** or ___, three or more, nothing else on the line
            if trimmed.count >= 3, "-*_".contains(trimmed.first!),
               trimmed.allSatisfy({ $0 == trimmed.first! }) {
                flushParagraph()
                blocks.append(.rule)
                continue
            }

            if let heading = heading(trimmed) {
                flushParagraph()
                blocks.append(heading)
                continue
            }

            if trimmed.hasPrefix(">") {
                flushParagraph()
                blocks.append(.quote(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)))
                continue
            }

            if let item = listItem(line) {
                flushParagraph()
                blocks.append(item)
                continue
            }

            // A table is only a table once its delimiter row is there:
            // `tableHeader` demands one delimiter cell per header cell, so
            // a header still streaming — delimiter not sent yet, or half
            // sent — falls through to the paragraph below and reads as the
            // text it is. The delimiter line must contain `|` too, or a
            // lone `---` after a pipe line would read as a one-column table
            // and swallow a thematic break. Calling it a table early would
            // draw a grid with no columns settled, then redraw when the row lands.
            if trimmed.contains("|"), let delimiter = lines.first,
               delimiter.trimmingCharacters(in: .whitespaces).contains("|"),
               let table = tableHeader(trimmed, delimiter: delimiter) {
                flushParagraph()
                lines = lines.dropFirst()
                var rows: [[String]] = []
                while let next = lines.first {
                    let row = next.trimmingCharacters(in: .whitespaces)
                    guard !row.isEmpty, row.contains("|") else { break }
                    rows.append(tableRow(row, columns: table.header.count))
                    lines = lines.dropFirst()
                }
                blocks.append(.table(header: table.header, alignments: table.alignments, rows: rows))
                continue
            }

            paragraph.append(trimmed)
        }
        flushParagraph()
        return blocks
    }

    private static func heading(_ trimmed: String) -> MarkdownBlock? {
        let hashes = trimmed.prefix(while: { $0 == "#" }).count
        guard hashes >= 1, hashes <= 6 else { return nil }
        let rest = String(trimmed.dropFirst(hashes))
        // "#hashtag" is not a heading; ATX requires the space
        guard rest.hasPrefix(" ") else { return nil }
        return .heading(level: hashes, text: rest.trimmingCharacters(in: .whitespaces))
    }

    private static func listItem(_ line: String) -> MarkdownBlock? {
        let leading = line.prefix(while: { $0 == " " || $0 == "\t" }).count
        // two spaces per level, which is what a model emits and what GFM
        // treats as nesting for a tight list
        let indent = min(leading / 2, 4)
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        for marker in ["- ", "* ", "+ "] where trimmed.hasPrefix(marker) {
            return .bullet(indent: indent, text: String(trimmed.dropFirst(2)))
        }

        // "1. " / "12) "
        let digits = trimmed.prefix(while: \.isNumber)
        if !digits.isEmpty, digits.count <= 9 {
            let rest = trimmed.dropFirst(digits.count)
            if rest.hasPrefix(". ") || rest.hasPrefix(") ") {
                return .ordered(indent: indent, number: Int(digits) ?? 1, text: String(rest.dropFirst(2)))
            }
        }
        return nil
    }

    /// The header and alignments when `delimiter` is a delimiter row for
    /// `line`, nil otherwise. One delimiter cell per header cell, as GFM
    /// has it: a row of pipes in prose followed by a `---` rule is prose
    /// followed by a rule, not a one-column table that swallowed both.
    private static func tableHeader(
        _ line: String, delimiter: String
    ) -> (header: [String], alignments: [TableAlignment])? {
        let header = tableCells(line)
        let cells = tableCells(delimiter)
        guard !header.isEmpty, cells.count == header.count else { return nil }
        var alignments: [TableAlignment] = []
        for cell in cells {
            guard let alignment = tableAlignment(cell) else { return nil }
            alignments.append(alignment)
        }
        return (header, alignments)
    }

    private static func tableAlignment(_ cell: String) -> TableAlignment? {
        var text = cell
        let leadingColon = text.hasPrefix(":")
        if leadingColon { text.removeFirst() }
        let trailingColon = text.hasSuffix(":")
        if trailingColon { text.removeLast() }
        guard !text.isEmpty, text.allSatisfy({ $0 == "-" }) else { return nil }
        switch (leadingColon, trailingColon) {
        case (true, true): return .center
        case (false, true): return .trailing
        default: return .leading
        }
    }

    /// One body row, forced to the header's width. The desktop pads a
    /// short row with empty cells and drops a long row's extras, so a
    /// model that miscounts one row loses that row's tail, not the table.
    private static func tableRow(_ line: String, columns: Int) -> [String] {
        var cells = tableCells(line)
        if cells.count > columns { cells.removeLast(cells.count - columns) }
        while cells.count < columns { cells.append("") }
        return cells
    }

    /// Split one table line into its cells. The outer pipes are optional
    /// in GFM and are dropped when present; `\|` is a literal pipe in the
    /// cell, the only way one can appear there at all — an unescaped pipe
    /// is a separator even inside a code span, so this does not track
    /// backticks. A `\\` pair is kept as written (Foundation renders it
    /// as one backslash) and a pipe after it still separates.
    private static func tableCells(_ line: String) -> [String] {
        var text = line.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("|") { text.removeFirst() }
        if text.hasSuffix("|"), !hasEscapedFinalPipe(text) { text.removeLast() }

        let characters = Array(text)
        var cells: [String] = []
        var cell = ""
        var index = 0
        while index < characters.count {
            let character = characters[index]
            let next = index + 1 < characters.count ? characters[index + 1] : nil
            if character == "\\", next == "|" {
                cell.append("|")
                index += 2
            } else if character == "\\", next == "\\" {
                cell.append("\\")
                cell.append("\\")
                index += 2
            } else if character == "|" {
                cells.append(cell.trimmingCharacters(in: .whitespaces))
                cell = ""
                index += 1
            } else {
                cell.append(character)
                index += 1
            }
        }
        cells.append(cell.trimmingCharacters(in: .whitespaces))
        return cells
    }

    /// Is the line's final pipe escaped — an odd run of backslashes right
    /// before it? Then it is cell content, not the optional closing pipe.
    private static func hasEscapedFinalPipe(_ text: String) -> Bool {
        var backslashes = 0
        for character in text.dropLast().reversed() {
            guard character == "\\" else { break }
            backslashes += 1
        }
        return backslashes % 2 == 1
    }
}
