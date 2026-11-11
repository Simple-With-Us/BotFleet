import Foundation

/// Empty-composer chips that only paste a sentence.
///
/// A chip that inserts a canned prompt is not a command.  A prompt that
/// starts with `/` is left alone, so a command the engine actually runs is
/// not removed by the same check.
public enum ComposerPromptChips {
    public static let snippetOnlyTitles: Set<String> = [
        "Show diff",
        "Run tests",
        "Explain steps",
        "What's next?",
    ]

    public static let snippetOnlyPrompts: Set<String> = [
        "Show latest git diff",
        "Run all automated tests",
        "Explain the changes in detail",
        "What should we do next?",
    ]

    /// True when choosing the chip would only paste a canned sentence.
    public static func isCannedSnippet(title: String, prompt: String) -> Bool {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let prompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if prompt.hasPrefix("/") { return false }
        if snippetOnlyPrompts.contains(prompt) { return true }
        return snippetOnlyTitles.contains(title)
    }
}
