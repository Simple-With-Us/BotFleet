import XCTest
@testable import CompanionCore

final class ProfileSaveGateTests: XCTestCase {
    @MainActor
    func testFailedSaveKeepsDraftForSuccessfulRetry() async {
        var draft = "edited name"
        var attempts = 0

        let failedSaveShouldDismiss = await ProfileSaveGate.run(
            save: {
                attempts += 1
                return Optional<String>.none
            },
            accept: { draft = $0 }
        )

        XCTAssertFalse(failedSaveShouldDismiss)
        XCTAssertEqual(draft, "edited name")

        let retryShouldDismiss = await ProfileSaveGate.run(
            save: {
                attempts += 1
                return "normalized name"
            },
            accept: { draft = $0 }
        )

        XCTAssertTrue(retryShouldDismiss)
        XCTAssertEqual(draft, "normalized name")
        XCTAssertEqual(attempts, 2)
    }

    @MainActor
    func testRefusedSaveHandsTheDraftBackToTheCaller() async {
        // A refused save puts the refusable fields back to what the computer
        // holds, and an accepted one does not touch them.
        var computers: Set<String> = ["vm"]
        let held: Set<String> = ["cloud"]
        var rejectedCalls = 0

        let refusedShouldDismiss = await ProfileSaveGate.run(
            save: { Optional<String>.none },
            accept: { _ in },
            rejected: {
                rejectedCalls += 1
                computers = held
            }
        )
        XCTAssertFalse(refusedShouldDismiss)
        XCTAssertEqual(rejectedCalls, 1)
        XCTAssertEqual(computers, held)

        let savedShouldDismiss = await ProfileSaveGate.run(
            save: { Optional("saved") },
            accept: { _ in },
            rejected: { rejectedCalls += 1 }
        )
        XCTAssertTrue(savedShouldDismiss)
        XCTAssertEqual(rejectedCalls, 1)
    }
}
