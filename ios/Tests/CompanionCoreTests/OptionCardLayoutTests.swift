// When a question card's choices stack full-width instead of sharing one
// capsule row.  The rule lives on `OptionCard` so every card surface can
// ask the same question; these tests pin it down.
import XCTest
@testable import CompanionCore

final class OptionCardLayoutTests: XCTestCase {
    private func card(options: [String], tool: String? = nil) -> OptionCard {
        OptionCard(
            title: "Which one?", subtitle: "", options: options,
            answered: nil, dismissed: nil, requestId: "req-1", tool: tool,
            held: nil, allowKey: nil
        )
    }

    func testAShortPairStaysInOneRow() {
        XCTAssertFalse(card(options: ["Yes", "No"]).prefersStackedChoices)
        XCTAssertFalse(card(options: ["Ship it", "Wait"]).prefersStackedChoices)
    }

    func testASingleShortChoiceStaysInOneRow() {
        XCTAssertFalse(card(options: ["Continue"]).prefersStackedChoices)
    }

    func testNoChoicesDoNotStack() {
        // Nothing to lay out; the free-text field is the whole answer UI.
        XCTAssertFalse(card(options: []).prefersStackedChoices)
    }

    func testMoreThanTwoChoicesStack() {
        XCTAssertTrue(card(options: ["Red", "Green", "Blue"]).prefersStackedChoices)
        XCTAssertTrue(card(options: ["A", "B", "C", "D", "E"]).prefersStackedChoices)
    }

    func testALongChoiceStacksEvenInAPair() {
        XCTAssertTrue(
            card(options: ["Use the staging server", "Use production"]).prefersStackedChoices,
            "a choice longer than the threshold cannot share a row"
        )
    }

    func testASingleLongChoiceStacks() {
        XCTAssertTrue(card(options: ["Delete the old backups first"]).prefersStackedChoices)
    }

    func testAChoiceAtTheThresholdStaysInOneRow() {
        // The rule is "longer than" the threshold, so exactly at it fits.
        let atThreshold = String(repeating: "x", count: OptionCard.stackedChoiceLength)
        XCTAssertFalse(card(options: [atThreshold, "No"]).prefersStackedChoices)

        let pastThreshold = String(repeating: "x", count: OptionCard.stackedChoiceLength + 1)
        XCTAssertTrue(card(options: [pastThreshold, "No"]).prefersStackedChoices)
    }

    func testPermissionCardsNeverStack() {
        // Allow/Deny keeps its row whatever the labels say; stacking is a
        // question-card layout, and `tool` is what makes it a permission.
        XCTAssertFalse(
            card(options: ["Allow", "Deny"], tool: "Bash").prefersStackedChoices
        )
        XCTAssertFalse(
            card(options: ["Always allow this command", "Deny", "Deny and stop"], tool: "Bash")
                .prefersStackedChoices
        )
    }

    func testTheStaticFormAgreesWithTheInstance() {
        XCTAssertTrue(
            OptionCard.prefersStackedChoices(options: ["One", "Two", "Three"], isPermission: false)
        )
        XCTAssertFalse(
            OptionCard.prefersStackedChoices(options: ["One", "Two", "Three"], isPermission: true)
        )
        XCTAssertFalse(
            OptionCard.prefersStackedChoices(options: ["Yes", "No"], isPermission: false)
        )
    }
}
