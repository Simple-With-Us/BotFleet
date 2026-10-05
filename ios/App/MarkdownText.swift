// Bot replies, rendered.
//
// `Markdown.blocks` does the splitting; this draws each block and hands the
// inline run to Foundation, which knows emphasis, code spans, strikethrough
// and links. SwiftUI makes the links tappable on its own, which is most of
// why this is worth doing at all — a reply full of sources was previously a
// wall of bracketed URLs.
//
// Only bot messages get this. The desktop makes the same split: what you
// typed is shown as you typed it, because markdown you did not intend is
// worse than markdown you did.
import SwiftUI
import CompanionCore

struct MarkdownText: View {
    let source: String
    /// Draws a caret after the last block. The streaming bubble sets this so
    /// the live reply and the settled one are the same view with the same
    /// layout — a caret bolted on outside would put it on its own line the
    /// moment the reply ends in a list item.
    var caret: Bool = false
    @State private var fileLink: URL?
    @State private var showingFileAlert = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        let blocks = Markdown.blocks(source)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { item in
                view(for: item.element, tail: caret && item.offset == blocks.count - 1)
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            if url.scheme == "file" {
                fileLink = url
                showingFileAlert = true
                return .handled
            }
            return .systemAction
        })
        .alert("Cannot open file on phone", isPresented: $showingFileAlert, presenting: fileLink) { _ in
            Button("OK", role: .cancel) { }
        } message: { url in
            Text("The file '\(url.lastPathComponent)' is on your computer. You can only view it from the desktop app.")
        }
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock, tail: Bool) -> some View {
        switch block {
        case let .paragraph(text):
            inline(text, tail: tail)
                .font(.system(size: 17))
                .fixedSize(horizontal: false, vertical: true)

        case let .heading(level, text):
            // Three sizes, not six. A chat bubble is not a document, and an
            // h4 that looks exactly like body text is a heading that failed.
            inline(text, tail: tail)
                .font(.system(size: level <= 1 ? 21 : level == 2 ? 19 : 17, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 2)

        case let .bullet(indent, text):
            marker("•", indent: indent, text: text, tail: tail)

        case let .ordered(indent, number, text):
            marker("\(number).", indent: indent, text: text, tail: tail)

        case let .quote(text):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.secondary.opacity(0.4))
                    .frame(width: 3)
                inline(text, tail: tail)
                    .font(.system(size: 17))
                    .foregroundStyle(Color.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)

        case let .code(language, text):
            CodeBlockView(language: language, text: text, tail: tail)

        case .rule:
            Divider().padding(.vertical, 2)
        }
    }

    private func marker(_ symbol: String, indent: Int, text: String, tail: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(symbol)
                .font(.system(size: 17))
                .foregroundStyle(Color.secondary)
                .frame(minWidth: 16, alignment: .trailing)
            inline(text, tail: tail).font(.system(size: 17))
        }
        .padding(.leading, CGFloat(indent) * 14)
        .fixedSize(horizontal: false, vertical: true)
    }

    /// Inline markdown via Foundation. `.inlineOnlyPreservingWhitespace`
    /// because the blocks are already split — asking for `.full` here would
    /// have it re-interpret list markers this has already consumed.
    ///
    /// Falling back to the raw string on a parse failure is the point: a
    /// half-typed link mid-stream should show as the characters the model has
    /// sent so far, not vanish until it closes the bracket.
    private func inline(_ text: String, tail: Bool = false) -> Text {
        let rendered: Text
        if let attributed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            rendered = Text(attributed)
        } else {
            rendered = Text(text)
        }
        return rendered + caretText(tail)
    }

    /// A figure space then a block, so the caret sits off the last glyph
    /// rather than touching it. Empty when not streaming — an empty `Text`
    /// concatenated in costs nothing and keeps the callers branch-free.
    private func caretText(_ tail: Bool) -> Text {
        streamingCaret(tail)
    }
}

/// One monospaced run inside a horizontal scroller, for a fence that fits
/// in a single page.  Larger fences show one page and open the rest in
/// `CodeBlockReader`.  The page is the bound: this view never puts the
/// whole fence into `Text`.
private struct CodeBlockView: View {
    let language: String?
    let text: String
    let tail: Bool
    @State private var showingFullCode = false

    var body: some View {
        let preview = CodeBlockWindow.preview(text, anchorToEnd: tail)
        VStack(alignment: .leading, spacing: 4) {
            if let language, !language.isEmpty {
                Text(language)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(Color.secondary)
            }
            // Horizontal scroll rather than wrapping: wrapped code is
            // harder to read than code you have to push sideways, and
            // indentation is most of what a snippet is saying.
            codeScroll(preview.text, showCaret: tail && !preview.hasLater)
            if preview.needsPaging {
                Text(preview.caption)
                    .font(.system(size: 11))
                    .foregroundStyle(Color.secondary)
                Button("Show Full Code") { showingFullCode = true }
                    .font(.system(size: 12, weight: .semibold))
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.secondary.opacity(0.14))
        )
        .sheet(isPresented: $showingFullCode) {
            CodeBlockReader(source: text, anchorToEnd: tail)
        }
    }

    private func codeScroll(_ source: String, showCaret: Bool) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            (Text(source) + streamingCaret(showCaret))
                .font(.system(size: 14, design: .monospaced))
                .textSelection(.enabled)
        }
    }
}

/// Pages the fence.  One `Text` is mounted at a time, so opening the
/// full block cannot reintroduce the unbounded measure.
private struct CodeBlockReader: View {
    let source: String
    let anchorToEnd: Bool
    @Environment(\.dismiss) private var dismiss
    @State private var pageIndex = 0
    @State private var userPaged = false

    var body: some View {
        let count = CodeBlockWindow.pageCount(in: source)
        let resolved = !userPaged && anchorToEnd
            ? max(count - 1, 0)
            : min(max(0, pageIndex), max(count - 1, 0))
        let page = CodeBlockWindow.page(source, index: resolved)
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                ScrollView {
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(page.text)
                            .font(.system(size: 14, design: .monospaced))
                            .textSelection(.enabled)
                    }
                }
                Text(page.caption)
                    .font(.system(size: 12))
                    .foregroundStyle(Color.secondary)
                HStack {
                    Button("Earlier Lines") {
                        userPaged = true
                        pageIndex = max(0, page.pageIndex - 1)
                    }
                    .disabled(!page.hasEarlier)
                    Spacer()
                    Button("Later Lines") {
                        userPaged = true
                        pageIndex = min(page.pageCount - 1, page.pageIndex + 1)
                    }
                    .disabled(!page.hasLater)
                }
                .font(.system(size: 15, weight: .semibold))
            }
            .padding(16)
            .navigationTitle("Full Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
}

private func streamingCaret(_ on: Bool) -> Text {
    on ? Text("\u{2007}▍").foregroundStyle(Color.secondary) : Text("")
}
