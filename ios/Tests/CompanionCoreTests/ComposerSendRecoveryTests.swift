import XCTest
@testable import CompanionCore

final class ComposerSendRecoveryTests: XCTestCase {
    private func userMessage(_ id: String, text: String, queueId: String? = nil) -> Message {
        var message = Message(id: id, role: .user, kind: .text, at: 1)
        message.text = text
        message.queueId = queueId
        return message
    }

    func testDoesNotRestoreWhenSendSucceeded() {
        XCTAssertFalse(
            ComposerSendRecovery.shouldRestoreClearedDraft(
                sendSucceeded: true,
                clientNonce: "local-1",
                sentText: "hello",
                priorUserMessageIDs: [],
                transcript: []
            )
        )
    }

    func testRestoresWhenSendFailedAndNothingLanded() {
        XCTAssertTrue(
            ComposerSendRecovery.shouldRestoreClearedDraft(
                sendSucceeded: false,
                clientNonce: "local-1",
                sentText: "hello",
                priorUserMessageIDs: [],
                transcript: []
            )
        )
    }

    func testDoesNotRestoreWhenTranscriptHasClientNonceOnQueueId() {
        let transcript = [userMessage("server-id", text: "hello", queueId: "local-1")]
        XCTAssertFalse(
            ComposerSendRecovery.shouldRestoreClearedDraft(
                sendSucceeded: false,
                clientNonce: "local-1",
                sentText: "hello",
                priorUserMessageIDs: [],
                transcript: transcript
            )
        )
    }

    func testDoesNotRestoreWhenNewUserRowMatchesSentText() {
        let prior = Set(["old-user"])
        let transcript = [
            userMessage("old-user", text: "hello"),
            userMessage("new-user", text: "run this"),
        ]
        XCTAssertFalse(
            ComposerSendRecovery.shouldRestoreClearedDraft(
                sendSucceeded: false,
                clientNonce: "local-9",
                sentText: "run this",
                priorUserMessageIDs: prior,
                transcript: transcript
            )
        )
    }

    func testStillRestoresWhenOlderRowHasSameText() {
        let prior = Set(["old-user"])
        let transcript = [userMessage("old-user", text: "hello")]
        XCTAssertTrue(
            ComposerSendRecovery.shouldRestoreClearedDraft(
                sendSucceeded: false,
                clientNonce: "local-2",
                sentText: "hello",
                priorUserMessageIDs: prior,
                transcript: transcript
            )
        )
    }

    func testSlashCommandDraftPreservesNonEmptyText() {
        XCTAssertEqual(ComposerSendRecovery.slashCommandDraft(from: "ship it"), "/ship it")
        XCTAssertEqual(ComposerSendRecovery.slashCommandDraft(from: "/tasks"), "/tasks")
        XCTAssertEqual(ComposerSendRecovery.slashCommandDraft(from: ""), "/")
        XCTAssertEqual(ComposerSendRecovery.slashCommandDraft(from: "   "), "/")
    }

    func testReassertComposerFocusAfterPlusDismissesWhenRequested() {
        XCTAssertTrue(
            ComposerSendRecovery.shouldReassertComposerFocusAfterPlusDismisses(
                wasShowingPlus: true,
                isShowingPlus: false,
                focusAfterDismiss: true
            )
        )
        XCTAssertFalse(
            ComposerSendRecovery.shouldReassertComposerFocusAfterPlusDismisses(
                wasShowingPlus: true,
                isShowingPlus: false,
                focusAfterDismiss: false
            )
        )
        XCTAssertFalse(
            ComposerSendRecovery.shouldReassertComposerFocusAfterPlusDismisses(
                wasShowingPlus: false,
                isShowingPlus: true,
                focusAfterDismiss: true
            )
        )
    }
}
