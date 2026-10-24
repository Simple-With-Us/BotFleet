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
//
// Every text size here is `.scaled()` (ScaledFont.swift), never a bare
// `.system(size:)`.  A fixed point size does not move when the reader changes
// their text size, so the transcript stayed 17pt at every accessibility
// setting -- the reply was the one thing on screen that could not be made
// larger.  `.scaled()` returns exactly `size` at the default setting and
// grows from there, so nothing moves for a reader who never changes it.
// SF Symbol glyphs keep fixed sizes -- they sit inside fixed frames, and a
// symbol that grows past its frame is a clipped symbol.
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
                    // Karaoke paints by block (Karaoke.swift).
                    .environment(\.markdownBlockIndex, item.offset)
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
                .font(.scaled(17, relativeTo: .body))
                .fixedSize(horizontal: false, vertical: true)

        case let .heading(level, text):
            // Three sizes, not six. A chat bubble is not a document, and an
            // h4 that looks exactly like body text is a heading that failed.
            inline(text, tail: tail)
                .font(.scaled(
                    level <= 1 ? 21 : level == 2 ? 19 : 17,
                    weight: .semibold,
                    relativeTo: level <= 1 ? .title2 : level == 2 ? .title3 : .headline
                ))
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
                    .font(.scaled(17, relativeTo: .body))
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
                .font(.scaled(17, relativeTo: .body))
                .foregroundStyle(Color.secondary)
                .frame(minWidth: 16, alignment: .trailing)
            inline(text, tail: tail).font(.scaled(17, relativeTo: .body))
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
    /// sent so far, not vanish until it closes the bracket.  The parse is
    /// `Markdown.inlineAttributed`, shared with karaoke's display text, and
    /// `InlineMarkdown` adds the highlight while the reply is read aloud.
    private func inline(_ text: String, tail: Bool = false) -> InlineMarkdown {
        InlineMarkdown(text: text, caret: caretText(tail))
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
    @State private var copied = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let preview = CodeBlockWindow.preview(text, anchorToEnd: tail)
        VStack(alignment: .leading, spacing: 8) {
            // The header row sits outside the horizontal scroll view on
            // purpose.  Inside it, the language tag and the Copy button
            // travel with the code and slide off the right edge of a long
            // line -- the one block where you most want to copy would be the
            // one whose button you cannot reach.
            HStack(spacing: 8) {
                if let language, !language.isEmpty {
                    Text(language)
                        .font(.scaled(11, weight: .semibold, design: .monospaced, relativeTo: .caption2))
                        .textCase(.uppercase)
                        .tracking(0.5)
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                copyButton
            }

            // Horizontal scroll rather than wrapping: wrapped code is
            // harder to read than code you have to push sideways, and
            // indentation is most of what a snippet is saying.
            codeScroll(preview.text, showCaret: tail && !preview.hasLater)
            if preview.needsPaging {
                Text(preview.caption)
                    .font(.scaled(12, relativeTo: .caption))
                    .foregroundStyle(Color.secondary)
                Button("Show Full Code") { showingFullCode = true }
                    .font(.scaled(12, weight: .semibold, relativeTo: .caption))
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

    /// Copies `text`, the whole fence -- never `preview.text`.
    ///
    /// This is the one place the bounded renderer and the Copy button could
    /// disagree, and the disagreement would be silent: a paged block shows
    /// page one, so copying what is on screen would hand back a truncated
    /// file that looks complete and is not.  A snippet you cannot paste
    /// whole is worse than no Copy button at all.
    private var copyButton: some View {
        Button {
            PlatformBridge.copyToPasteboard(text)
            copied = true
            AccessibilityNotification.Announcement("Code copied").post()
            Task {
                try? await Task.sleep(for: .seconds(2))
                copied = false
            }
        } label: {
            Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                .font(.scaled(12, weight: .semibold, relativeTo: .caption))
                .foregroundStyle(copied ? Color.green : Color.secondary)
                .padding(.horizontal, 10)
                .frame(height: 28)
                .background(Capsule().fill(Color(uiColor: .systemBackground).opacity(0.7)))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        // The visible label is 28pt tall; the tap target is not, and this is
        // the control a person reaches for one-handed at the end of a reply.
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: copied)
        .accessibilityLabel(copied ? "Copied" : "Copy code")
        .accessibilityHint("Copies this whole code block to the clipboard")
    }

    private func codeScroll(_ source: String, showCaret: Bool) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            (Text(source) + streamingCaret(showCaret))
                .font(.scaled(14, design: .monospaced, relativeTo: .footnote))
                .textSelection(.enabled)
        }
    }
}

/// Pages the fence.  One `Text` is mounted at a time, so opening the
/// full block cannot reintroduce the unbounded measure.
private struct CodeBlockReader: View {
    let source: String
    @Environment(\.dismiss) private var dismiss
    @State private var pageIndex = 0
    @State private var followsEnd: Bool

    init(source: String, anchorToEnd: Bool) {
        self.source = source
        _followsEnd = State(initialValue: anchorToEnd)
    }

    var body: some View {
        let count = CodeBlockWindow.pageCount(in: source)
        let resolved = followsEnd
            ? max(count - 1, 0)
            : min(max(0, pageIndex), max(count - 1, 0))
        let page = CodeBlockWindow.page(source, index: resolved)
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                ScrollView {
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(page.text)
                            .font(.scaled(14, design: .monospaced, relativeTo: .footnote))
                            .textSelection(.enabled)
                    }
                }
                Text(page.caption)
                    .font(.scaled(12, relativeTo: .caption))
                    .foregroundStyle(Color.secondary)
                HStack {
                    Button("Earlier Lines") {
                        followsEnd = false
                        pageIndex = max(0, page.pageIndex - 1)
                    }
                    .disabled(!page.hasEarlier)
                    Spacer()
                    Button("Later Lines") {
                        followsEnd = false
                        pageIndex = min(page.pageCount - 1, page.pageIndex + 1)
                    }
                    .disabled(!page.hasLater)
                }
                .font(.scaled(15, weight: .semibold, relativeTo: .body))
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
