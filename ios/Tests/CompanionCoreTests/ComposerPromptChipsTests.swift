import XCTest
@testable import CompanionCore

final class ComposerPromptChipsTests: XCTestCase {
    func testCannedSnippetChipsAreRejected() {
        let canned = [
            ("Show diff", "Show latest git diff"),
            ("Run tests", "Run all automated tests"),
            ("Explain steps", "Explain the changes in detail"),
            ("What's next?", "What should we do next?"),
        ]
        for (title, prompt) in canned {
            XCTAssertTrue(
                ComposerPromptChips.isCannedSnippet(title: title, prompt: prompt),
                title
            )
        }
    }

    func testASlashCommandIsNotACannedSnippet() {
        XCTAssertFalse(ComposerPromptChips.isCannedSnippet(title: "Run tests", prompt: "/test"))
        XCTAssertFalse(ComposerPromptChips.isCannedSnippet(title: "Tasks", prompt: "/tasks"))
        XCTAssertFalse(ComposerPromptChips.isCannedSnippet(title: "Computer", prompt: "/computer"))
    }

    func testARealPromptIsNotRejectedByTitleAloneWhenItIsNotCanned() {
        XCTAssertFalse(ComposerPromptChips.isCannedSnippet(title: "Review the patch", prompt: "Look at the open change"))
    }
}
