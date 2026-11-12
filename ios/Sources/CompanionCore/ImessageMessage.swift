// Parse a harness iMessage inbound prompt into the smaller view shown in chat.
//
// The stored message stays role=user so the model still sees it as the turn
// prompt.  The phone must not paint that as something the owner typed.
import Foundation

public struct ImessageMessageView: Equatable, Sendable {
    public var headline: String
    public var subtitle: String
    public var payload: String?
    public var body: String

    public static func parse(_ text: String?) -> ImessageMessageView? {
        guard let text, !text.isEmpty else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let inner = block("IMESSAGE INBOUND", in: trimmed)
        let raw = inner ?? trimmed
        let hasPrefix = raw.range(
            of: #"^\[from iMessage\]\s*"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil
        if inner == nil && !hasPrefix { return nil }

        var body = raw
        if let range = body.range(
            of: #"^\[from iMessage\]\s*"#,
            options: [.regularExpression, .caseInsensitive]
        ) {
            body = String(body[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard !body.isEmpty else { return nil }

        let lines = body.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let first = lines.first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let headline = first.isEmpty ? "iMessage" : first
        let rest = lines.dropFirst().joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return ImessageMessageView(
            headline: headline,
            subtitle: "iMessage",
            payload: rest.isEmpty ? nil : rest,
            body: body
        )
    }

    /// Body of a bot reply meant for iMessage, or nil when the tag is absent.
    public static func stripToImessagePrefix(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let range = trimmed.range(
            of: #"^\[to iMessage\]\s*"#,
            options: [.regularExpression, .caseInsensitive]
        ) else { return nil }
        return String(trimmed[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func block(_ marker: String, in text: String) -> String? {
        let start = "[\(marker)]\n"
        let end = "\n[/\(marker)]"
        guard let startRange = text.range(of: start) else { return nil }
        guard let endRange = text.range(of: end, range: startRange.upperBound..<text.endIndex) else { return nil }
        let inner = text[startRange.upperBound..<endRange.lowerBound]
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return inner.isEmpty ? nil : String(inner)
    }
}
