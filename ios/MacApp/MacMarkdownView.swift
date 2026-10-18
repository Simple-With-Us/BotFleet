import SwiftUI

public struct MarkdownText: View {
    public let text: String

    public init(_ text: String) {
        self.text = text
    }

    public var body: some View {
        if let attributed = try? AttributedString(markdown: text, options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            Text(attributed)
                .font(.body)
        } else {
            Text(text)
                .font(.body)
        }
    }
}
