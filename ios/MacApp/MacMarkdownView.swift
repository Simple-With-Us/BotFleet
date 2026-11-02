import SwiftUI
import CompanionCore
#if os(macOS)
import AppKit
#endif

/// Renders structured Markdown blocks (headings, fenced code blocks with
/// language headers and `CodeBlockWindow` paging, blockquotes, lists, and
/// inline formatting) for settled and streaming macOS transcript bubbles.
public struct MarkdownText: View {
    public let blocks: [MacRenderedMarkdownBlock]
    public var onCopyCodeBlock: ((String) -> Void)?

    public init(_ text: String, isStreaming: Bool = false, onCopyCodeBlock: ((String) -> Void)? = nil) {
        self.blocks = Markdown.blocks(text).enumerated().map { idx, blk in
            MacRenderedMarkdownBlock(id: idx, block: blk, isStreamingTail: isStreaming)
        }
        self.onCopyCodeBlock = onCopyCodeBlock
    }

    public init(renderedBlocks: [MacRenderedMarkdownBlock], onCopyCodeBlock: ((String) -> Void)? = nil) {
        self.blocks = renderedBlocks
        self.onCopyCodeBlock = onCopyCodeBlock
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(blocks) { item in
                blockView(for: item)
            }
        }
    }

    @ViewBuilder
    private func blockView(for item: MacRenderedMarkdownBlock) -> some View {
        switch item.block {
        case .heading(let level, let text):
            inlineText(text)
                .font(headingFont(for: level))
                .fontWeight(.semibold)
                .padding(.top, level <= 2 ? 4 : 2)

        case .paragraph(let text):
            inlineText(text)
                .font(.body)

        case .bullet(let indent, let text):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("•")
                    .foregroundColor(.secondary)
                inlineText(text)
                    .font(.body)
            }
            .padding(.leading, CGFloat(indent) * 14)

        case .ordered(let indent, let number, let text):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(number).")
                    .foregroundColor(.secondary)
                    .monospacedDigit()
                inlineText(text)
                    .font(.body)
            }
            .padding(.leading, CGFloat(indent) * 14)

        case .quote(let text):
            HStack(spacing: 8) {
                Rectangle()
                    .fill(Color.accentColor.opacity(0.6))
                    .frame(width: 3)
                inlineText(text)
                    .font(.body)
                    .foregroundColor(.secondary)
            }
            .padding(.vertical, 2)

        case .code(let language, let fullCode):
            let page = item.codePage ?? CodeBlockWindow.preview(fullCode, anchorToEnd: false)
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text(language ?? "code")
                        .font(.caption.monospaced())
                        .foregroundColor(.secondary)
                    Spacer()
                    Button("Copy Code Block") {
                        copyToPasteboard(fullCode)
                        onCopyCodeBlock?(fullCode)
                    }
                    .buttonStyle(.plain)
                    .font(.caption)
                    .foregroundColor(.accentColor)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color.secondary.opacity(0.12))

                ScrollView(.horizontal, showsIndicators: true) {
                    Text(page.text)
                        .font(.system(.callout, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(10)
                }

                if page.needsPaging {
                    Text(page.caption)
                        .font(.caption2)
                        .foregroundColor(.secondary)
                        .padding(.horizontal, 10)
                        .padding(.bottom, 6)
                }
            }
            .background(Color.black.opacity(0.06))
            .clipShape(RoundedRectangle(cornerRadius: 8))

        case .table(let header, let alignments, let rows):
            // The same shape as the phone's grid: columns keep their width
            // and the block scrolls sideways, capped so one huge table
            // cannot hand layout thousands of cells at once.
            let visibleRows = Array(rows.prefix(200))
            VStack(alignment: .leading, spacing: 6) {
                ScrollView(.horizontal, showsIndicators: false) {
                    Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                        GridRow {
                            ForEach(header.indices, id: \.self) { column in
                                inlineText(header[column])
                                    .font(.body.bold())
                                    .gridColumnAlignment(horizontalAlignment(of: alignments, column: column))
                            }
                        }
                        Divider()
                        ForEach(visibleRows.indices, id: \.self) { row in
                            GridRow {
                                ForEach(header.indices, id: \.self) { column in
                                    inlineText(visibleRows[row][column])
                                        .font(.body)
                                        .gridColumnAlignment(horizontalAlignment(of: alignments, column: column))
                                }
                            }
                        }
                    }
                }
                if rows.count > visibleRows.count {
                    Text("Showing \(visibleRows.count) of \(rows.count) rows")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .padding(10)
            .background(Color.secondary.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 8))

        case .rule:
            Divider()
                .padding(.vertical, 4)
        }
    }

    private func horizontalAlignment(of alignments: [TableAlignment], column: Int) -> HorizontalAlignment {
        guard column < alignments.count else { return .leading }
        switch alignments[column] {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }

    @ViewBuilder
    private func inlineText(_ text: String) -> some View {
        if let attributed = try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            Text(attributed)
        } else {
            Text(text)
        }
    }

    private func headingFont(for level: Int) -> Font {
        switch level {
        case 1: return .title2
        case 2: return .title3
        case 3: return .headline
        default: return .subheadline
        }
    }

    private func copyToPasteboard(_ string: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
        #endif
    }
}
