import Foundation

/// Spoken names for chat controls. Plain language a person hears.
///
/// The headline of an automated instruction already says what fired.
/// The instruction's own first line follows, so the card is not only a badge.
public enum ChatAccessibility {
    private static let sentenceGap = ".\u{00A0} "

    public static func instructionCardLabel(
        name: String = "",
        headline: String,
        subtitle: String? = nil,
        when: String? = nil
    ) -> String {
        let spokenName = collapse(name)
        let spokenHeadline = collapse(headline)
        let spokenSubtitle = collapse(subtitle ?? "")
        let spokenWhen = collapse(when ?? "")
        var parts: [String] = []
        if !spokenName.isEmpty, spokenName != spokenHeadline {
            parts.append(spokenName)
        }
        if !spokenHeadline.isEmpty {
            parts.append(spokenHeadline)
        }
        if !spokenSubtitle.isEmpty, spokenSubtitle != spokenHeadline, spokenSubtitle != spokenName {
            parts.append(spokenSubtitle)
        }
        if !spokenWhen.isEmpty {
            parts.append(spokenWhen)
        }
        if parts.isEmpty {
            return "Automated instruction"
        }
        return parts.joined(separator: sentenceGap)
    }

    private static func collapse(_ value: String) -> String {
        value.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}
