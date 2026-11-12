// The block splitter.
//
// The view half — fonts, bullets, the caret — needs a simulator to judge and
// is not tested here. The split is the part with decisions in it, and every
// decision below is one the desktop's react-markdown + remark-gfm already
// made, so the two clients wrap the same reply the same way.
//
// The streaming cases matter most. Every one of these strings is a state the
// phone renders for real, several times a second, on the way to a finished
// reply: half a fence, half a bold run, a bullet with nothing after it. A
// parser that throws away input in those states makes text flicker.
import XCTest
@testable import CompanionCore

final class MarkdownTests: XCTestCase {
    func testPlainTextIsOneParagraph() {
        XCTAssertEqual(Markdown.blocks("just a reply"), [.paragraph("just a reply")])
    }

    func testEmptyInputProducesNothing() {
        XCTAssertEqual(Markdown.blocks(""), [])
        XCTAssertEqual(Markdown.blocks("\n\n  \n"), [])
    }

    /// GFM without `breaks`, which is how the desktop is configured: a lone
    /// newline is a soft break and renders as a space. Joining with "\n"
    /// instead would wrap differently on the two clients for the same text.
    func testSoftBreaksBecomeSpaces() {
        XCTAssertEqual(
            Markdown.blocks("one line\nand its continuation"),
            [.paragraph("one line and its continuation")]
        )
    }

    func testBlankLineSeparatesParagraphs() {
        XCTAssertEqual(
            Markdown.blocks("first\n\nsecond"),
            [.paragraph("first"), .paragraph("second")]
        )
    }

    // MARK: - Headings

    func testHeadingLevels() {
        XCTAssertEqual(Markdown.blocks("# Title"), [.heading(level: 1, text: "Title")])
        XCTAssertEqual(Markdown.blocks("### Deeper"), [.heading(level: 3, text: "Deeper")])
    }

    /// ATX requires the space. Without this check every "#1 pick" and every
    /// "#hashtag" in a reply becomes a 21pt heading.
    func testHashWithoutSpaceIsNotAHeading() {
        XCTAssertEqual(Markdown.blocks("#hashtag"), [.paragraph("#hashtag")])
        XCTAssertEqual(Markdown.blocks("####### seven"), [.paragraph("####### seven")])
    }

    // MARK: - Lists

    func testBulletMarkers() {
        XCTAssertEqual(
            Markdown.blocks("- one\n* two\n+ three"),
            [
                .bullet(indent: 0, text: "one"),
                .bullet(indent: 0, text: "two"),
                .bullet(indent: 0, text: "three"),
            ]
        )
    }

    func testNestedBulletsCountIndent() {
        XCTAssertEqual(
            Markdown.blocks("- top\n  - nested\n    - deeper"),
            [
                .bullet(indent: 0, text: "top"),
                .bullet(indent: 1, text: "nested"),
                .bullet(indent: 2, text: "deeper"),
            ]
        )
    }

    func testOrderedListsKeepTheirNumbers() {
        XCTAssertEqual(
            Markdown.blocks("1. first\n2. second\n10) tenth"),
            [
                .ordered(indent: 0, number: 1, text: "first"),
                .ordered(indent: 0, number: 2, text: "second"),
                .ordered(indent: 0, number: 10, text: "tenth"),
            ]
        )
    }

    /// A year or a price at the start of a sentence is not a list. The
    /// delimiter is what makes it one.
    func testNumberWithoutDelimiterIsProse() {
        XCTAssertEqual(Markdown.blocks("2026 was the year"), [.paragraph("2026 was the year")])
        XCTAssertEqual(Markdown.blocks("3.14 is pi"), [.paragraph("3.14 is pi")])
    }

    func testTaskLists() {
        XCTAssertEqual(
            Markdown.blocks("- [ ] todo\n- [x] done\n- [X] also"),
            [
                .task(indent: 0, checked: false, number: nil, text: "todo"),
                .task(indent: 0, checked: true, number: nil, text: "done"),
                .task(indent: 0, checked: true, number: nil, text: "also"),
            ]
        )
    }

    func testTaskListMarkersAndNesting() {
        XCTAssertEqual(
            Markdown.blocks("* [ ] star\n+ [x] plus\n- [ ] parent\n  - [x] child"),
            [
                .task(indent: 0, checked: false, number: nil, text: "star"),
                .task(indent: 0, checked: true, number: nil, text: "plus"),
                .task(indent: 0, checked: false, number: nil, text: "parent"),
                .task(indent: 1, checked: true, number: nil, text: "child"),
            ]
        )
    }

    func testOrderedTaskListsKeepTheirNumbers() {
        XCTAssertEqual(
            Markdown.blocks("1. [ ] first\n2. [x] second"),
            [
                .task(indent: 0, checked: false, number: 1, text: "first"),
                .task(indent: 0, checked: true, number: 2, text: "second"),
            ]
        )
    }

    /// The label is inline markdown. The checkbox marker is structure, the
    /// same way a bullet's dash is, so emphasis has to survive the split.
    func testTaskLabelKeepsInlineMarkdown() {
        XCTAssertEqual(
            Markdown.blocks("- [ ] **bold** and `code` and [link](https://x.test)"),
            [.task(
                indent: 0, checked: false, number: nil,
                text: "**bold** and `code` and [link](https://x.test)"
            )]
        )
    }

    func testEmptyTaskItem() {
        XCTAssertEqual(
            Markdown.blocks("- [ ]\n- [x]"),
            [
                .task(indent: 0, checked: false, number: nil, text: ""),
                .task(indent: 0, checked: true, number: nil, text: ""),
            ]
        )
    }

    /// A box is only a box once the marker is complete and set off from the
    /// label. A half-typed marker mid-stream, a missing space, or a bracket
    /// note stays the characters the model has sent.
    func testIncompleteOrOrdinaryBracketsAreNotTasks() {
        XCTAssertEqual(Markdown.blocks("- ["), [.bullet(indent: 0, text: "[")])
        XCTAssertEqual(Markdown.blocks("- [x"), [.bullet(indent: 0, text: "[x")])
        XCTAssertEqual(Markdown.blocks("- [x]ship"), [.bullet(indent: 0, text: "[x]ship")])
        XCTAssertEqual(Markdown.blocks("- [x]\tship"), [.task(indent: 0, checked: true, number: nil, text: "ship")])
        XCTAssertEqual(Markdown.blocks("- [note] read this"), [.bullet(indent: 0, text: "[note] read this")])
        XCTAssertEqual(Markdown.blocks("see [x] later"), [.paragraph("see [x] later")])
    }

    func testTaskListInsideFenceIsUntouched() {
        XCTAssertEqual(
            Markdown.blocks("```\n- [x] not a box\n```"),
            [.code(language: nil, text: "- [x] not a box")]
        )
    }

    /// A task list and a table in one reply stay two blocks. The table path
    /// is unchanged: columns, alignment, and cells.
    func testTaskListBesideATable() {
        XCTAssertEqual(
            Markdown.blocks("- [x] done\n- [ ] left\n\n| Name | Score |\n| --- | ---: |\n| Ada | 3 |"),
            [
                .task(indent: 0, checked: true, number: nil, text: "done"),
                .task(indent: 0, checked: false, number: nil, text: "left"),
                .table(
                    header: ["Name", "Score"],
                    alignments: [.leading, .trailing],
                    rows: [["Ada", "3"]]
                ),
            ]
        )
    }

    /// Once the label starts arriving, none of it may disappear into the
    /// checkbox marker. The marker itself is structure, like the dash.
    func testTaskLabelIsNotDroppedWhileStreaming() {
        let label = "ship the fix"
        let reply = "- [x] \(label)"
        let labelStart = reply.distance(from: reply.startIndex, to: reply.range(of: label)!.lowerBound)
        for length in 1...reply.count {
            let partial = String(reply.prefix(length))
            let shown = Markdown.blocks(partial).map(text).joined()
            let sentLabel = length <= labelStart ? "" : String(label.prefix(length - labelStart))
            XCTAssertTrue(
                shown.contains(sentLabel),
                "lost \(sentLabel.debugDescription) at \(length) from \(shown.debugDescription)"
            )
        }
    }

    func testTaskCheckboxVoiceOverLabels() {
        XCTAssertEqual(Markdown.taskAccessibilityLabel(checked: true), "checked")
        XCTAssertEqual(Markdown.taskAccessibilityLabel(checked: false), "not checked")
    }

    /// Inline emphasis is Foundation's job, not this one — the splitter must
    /// hand the markers through untouched or the view has nothing to render.
    func testInlineSyntaxSurvivesTheSplit() {
        XCTAssertEqual(
            Markdown.blocks("- **bold** and `code` and [link](https://x.test)"),
            [.bullet(indent: 0, text: "**bold** and `code` and [link](https://x.test)")]
        )
    }

    // MARK: - Tables

    func testBasicTable() {
        XCTAssertEqual(
            Markdown.blocks("| Name | Score |\n| --- | --- |\n| Ada | 3 |\n| Bob | 5 |"),
            [.table(
                header: ["Name", "Score"],
                alignments: [.leading, .leading],
                rows: [["Ada", "3"], ["Bob", "5"]]
            )]
        )
    }

    func testTableAlignments() {
        XCTAssertEqual(
            Markdown.blocks("| L | C | R | D |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |"),
            [.table(
                header: ["L", "C", "R", "D"],
                alignments: [.leading, .center, .trailing, .leading],
                rows: [["1", "2", "3", "4"]]
            )]
        )
    }

    func testTableWithoutOuterPipes() {
        XCTAssertEqual(
            Markdown.blocks("Name | Score\n--- | ---\nAda | 3"),
            [.table(
                header: ["Name", "Score"],
                alignments: [.leading, .leading],
                rows: [["Ada", "3"]]
            )]
        )
    }

    /// `\|` is a cell's content, not a separator -- it is the only way
    /// GFM lets a pipe appear in a cell at all.
    func testTableEscapedPipeStaysInCell() {
        XCTAssertEqual(
            Markdown.blocks("| Expr | Note |\n| --- | --- |\n| a \\| b | x |"),
            [.table(
                header: ["Expr", "Note"],
                alignments: [.leading, .leading],
                rows: [["a | b", "x"]]
            )]
        )
    }

    /// A model that miscounts a row should not lose the table: short rows
    /// gain empty cells, long rows drop their extras, as on the desktop.
    func testRaggedTableRowsArePaddedAndTrimmed() {
        XCTAssertEqual(
            Markdown.blocks("| A | B |\n| --- | --- |\n| only |\n| 1 | 2 | 3 |"),
            [.table(
                header: ["A", "B"],
                alignments: [.leading, .leading],
                rows: [["only", ""], ["1", "2"]]
            )]
        )
    }

    /// Pipes in prose are prose. Without the delimiter row there is no
    /// table, so both lines stay the paragraph the author wrote.
    func testHeaderWithoutDelimiterRowStaysParagraph() {
        XCTAssertEqual(
            Markdown.blocks("| a | b |\n| not a delimiter |"),
            [.paragraph("| a | b | | not a delimiter |")]
        )
        XCTAssertEqual(
            Markdown.blocks("| a | b |\n| --- |"),
            [.paragraph("| a | b | | --- |")]
        )
    }

    /// Mid-stream the header arrives before its delimiter. It must read as
    /// the paragraph it would be without one until the delimiter lands --
    /// flashing a header-only table and falling back would flicker.
    func testStreamedHeaderBeforeDelimiterStaysParagraph() {
        XCTAssertEqual(
            Markdown.blocks("| Name | Score |"),
            [.paragraph("| Name | Score |")]
        )
        XCTAssertEqual(
            Markdown.blocks("| Name | Score |\n| --"),
            [.paragraph("| Name | Score | | --")]
        )
    }

    func testTableEndsAtLineWithoutPipe() {
        XCTAssertEqual(
            Markdown.blocks("| A | B |\n| --- | --- |\n| 1 | 2 |\nafter"),
            [
                .table(header: ["A", "B"], alignments: [.leading, .leading], rows: [["1", "2"]]),
                .paragraph("after"),
            ]
        )
    }

    /// A fence is code, not structure: a table inside one stays the
    /// characters the fence holds.
    func testTableInsideCodeFenceIsUntouched() {
        XCTAssertEqual(
            Markdown.blocks("```\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```"),
            [.code(language: nil, text: "| a | b |\n| --- | --- |\n| 1 | 2 |")]
        )
    }

    // MARK: - Fences

    func testFencedCodeKeepsItsLanguageAndItsWhitespace() {
        XCTAssertEqual(
            Markdown.blocks("```swift\nlet x = 1\n    indented\n```"),
            [.code(language: "swift", text: "let x = 1\n    indented")]
        )
    }

    func testFenceWithoutLanguage() {
        XCTAssertEqual(Markdown.blocks("```\nplain\n```"), [.code(language: nil, text: "plain")])
    }

    /// Mid-stream, a fence is open for as long as the snippet takes to
    /// arrive. Rendering it as code from the first line means the block grows
    /// downward; waiting for the closing fence means three backticks sit on
    /// screen and then the whole thing reflows at once.
    func testUnclosedFenceRunsToTheEnd() {
        XCTAssertEqual(
            Markdown.blocks("here:\n```py\nprint(1)"),
            [.paragraph("here:"), .code(language: "py", text: "print(1)")]
        )
    }

    /// Markers inside a fence are code, not structure.
    func testFenceContentIsNotReparsed() {
        XCTAssertEqual(
            Markdown.blocks("```\n# not a heading\n- not a bullet\n```"),
            [.code(language: nil, text: "# not a heading\n- not a bullet")]
        )
    }

    // MARK: - Quotes and rules

    func testQuote() {
        XCTAssertEqual(Markdown.blocks("> quoted"), [.quote("quoted")])
    }

    func testHorizontalRules() {
        XCTAssertEqual(Markdown.blocks("---"), [.rule])
        XCTAssertEqual(Markdown.blocks("***"), [.rule])
        XCTAssertEqual(Markdown.blocks("___"), [.rule])
    }

    /// Two hyphens are not a rule, and "- " is a bullet regardless.
    func testRuleNeedsThreeAndNothingElse() {
        XCTAssertEqual(Markdown.blocks("--"), [.paragraph("--")])
        XCTAssertEqual(Markdown.blocks("-- dashes --"), [.paragraph("-- dashes --")])
    }

    // MARK: - Streaming

    /// The invariant that keeps the bubble from flickering: whatever arrives,
    /// something renders, and the characters the model has sent are in it.
    func testPartialInputAlwaysRendersSomething() {
        for prefix in ["#", "# ", "# Head", "- ", "- it", "**bo", "```", "```sw\nlet", "[link](htt"] {
            XCTAssertFalse(
                Markdown.blocks(prefix).isEmpty,
                "dropped everything for \(prefix.debugDescription)"
            )
        }
    }

    /// Growing the source one character at a time must never lose text. This
    /// is the whole stream, replayed at the granularity the deltas arrive at.
    func testNoPrefixOfAReplyLosesCharacters() {
        let reply = "# Result\n\nRan **two** checks:\n\n- `pnpm test` passed\n- `pnpm lint` passed\n\n```sh\npnpm test\n```\n\n> nothing else to report"
        for length in 1...reply.count {
            let partial = String(reply.prefix(length))
            let rendered = Markdown.blocks(partial).map(text).joined()
            // Compare on non-whitespace: the splitter deliberately drops
            // markers, indentation and blank lines, and it joins soft breaks
            // with a space. What it must not drop is content.
            let sent = partial.filter { !$0.isWhitespace && !"#->`*_".contains($0) }
            let shown = rendered.filter { !$0.isWhitespace && !"#->`*_".contains($0) }
            XCTAssertEqual(shown, sent, "lost content at \(length) characters")
        }
    }

    private func text(_ block: MarkdownBlock) -> String {
        switch block {
        case let .paragraph(text): return text
        case let .bullet(_, text): return text
        case let .ordered(_, number, text): return "\(number)" + text
        case let .task(_, _, number, text):
            let prefix = number.map { String($0) } ?? ""
            return prefix + text
        case let .heading(_, text): return text
        case let .code(language, text): return (language ?? "") + text
        case let .quote(text): return text
        case let .table(header, _, rows): return (header + rows.flatMap { $0 }).joined()
        case .rule: return ""
        }
    }
}
