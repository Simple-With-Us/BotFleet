// Category registration and action routing, tested as pure data — no
// `UNUserNotificationCenter` and no simulator, per NotificationActions.swift.
import UserNotifications
import XCTest
@testable import CompanionCore

final class NotificationActionsTests: XCTestCase {
    // MARK: - Category registration

    func testRegisteredCategoriesMatchApprovalQuestionAndUpdateIdentifiers() {
        let categories = NotificationCategories.all()
        XCTAssertEqual(
            Set(categories.map(\.identifier)),
            [
                NotificationCategoryIdentifier.approval,
                NotificationCategoryIdentifier.question,
                NotificationCategoryIdentifier.update,
            ]
        )
    }

    func testApprovalCategoryHasApproveDenyAndOpenWithTitleCaseTitles() throws {
        let approval = try XCTUnwrap(
            NotificationCategories.all().first { $0.identifier == NotificationCategoryIdentifier.approval }
        )
        XCTAssertEqual(
            approval.actions.map(\.identifier),
            [NotificationActionIdentifier.approve, NotificationActionIdentifier.deny, NotificationActionIdentifier.open]
        )
        XCTAssertEqual(approval.actions.map(\.title), ["Approve", "Deny", "Open"])

        let approve = try XCTUnwrap(approval.actions.first { $0.identifier == NotificationActionIdentifier.approve })
        XCTAssertTrue(approve.options.contains(.authenticationRequired))
        XCTAssertFalse(approve.options.contains(.destructive))

        let deny = try XCTUnwrap(approval.actions.first { $0.identifier == NotificationActionIdentifier.deny })
        XCTAssertTrue(deny.options.contains(.destructive))

        let open = try XCTUnwrap(approval.actions.first { $0.identifier == NotificationActionIdentifier.open })
        XCTAssertTrue(open.options.contains(.foreground))
    }

    func testUpdateCategoryHasOnlyOpen() throws {
        let update = try XCTUnwrap(
            NotificationCategories.all().first { $0.identifier == NotificationCategoryIdentifier.update }
        )
        XCTAssertEqual(update.actions.map(\.identifier), [NotificationActionIdentifier.open])
        XCTAssertEqual(update.actions.map(\.title), ["Open"])
    }

    /// A question is answerable only with free text — no notification
    /// action can supply that, so unlike the approval category this one
    /// must never offer Approve or Deny.  PR #389 added a text-input
    /// Reply action so a typed answer can be sent straight from the lock
    /// screen; Open stays alongside it as the "read context first" path.
    func testQuestionCategoryHasReplyAndOpen() throws {
        let question = try XCTUnwrap(
            NotificationCategories.all().first { $0.identifier == NotificationCategoryIdentifier.question }
        )
        XCTAssertEqual(
            question.actions.map(\.identifier),
            [NotificationActionIdentifier.reply, NotificationActionIdentifier.open]
        )
        XCTAssertEqual(question.actions.map(\.title), ["Reply", "Open"])

        let reply = try XCTUnwrap(
            question.actions.first { $0.identifier == NotificationActionIdentifier.reply }
        )
        // Free-text answers still go straight to the harness from the
        // lock screen, so the device has to be unlocked first — same
        // `.authenticationRequired` gate as Approve.  This is a
        // `UNTextInputNotificationAction`, asserted below so a future
        // refactor cannot quietly drop the typed-reply path.
        XCTAssertTrue(reply.options.contains(.authenticationRequired))
        XCTAssertTrue(reply is UNTextInputNotificationAction)
        // `UNTextInputNotificationAction` exposes its placeholder and
        // button title; both must be set so the system prompt is
        // informative rather than an empty box.
        let textInput = try XCTUnwrap(reply as? UNTextInputNotificationAction)
        XCTAssertEqual(textInput.textInputButtonTitle, "Send")
        XCTAssertFalse((textInput.textInputPlaceholder ?? "").isEmpty)

        let open = try XCTUnwrap(
            question.actions.first { $0.identifier == NotificationActionIdentifier.open }
        )
        XCTAssertTrue(open.options.contains(.foreground))
    }

    // MARK: - Kind decides the category, not isBlocking

    /// The regression this guards: `isBlocking` is true for both `approval`
    /// and `question` (see `Frames.swift`), so picking a category from
    /// `isBlocking` sends a question the same Approve/Deny buttons a
    /// permission card gets — buttons that answer nothing for free text.
    /// `kind` alone must decide.
    func testKindDecidesTheCategoryAndAQuestionNeverGetsApproval() {
        XCTAssertEqual(NotificationCategoryIdentifier.forKind("approval"), NotificationCategoryIdentifier.approval)
        XCTAssertEqual(NotificationCategoryIdentifier.forKind("question"), NotificationCategoryIdentifier.question)
        XCTAssertNotEqual(NotificationCategoryIdentifier.forKind("question"), NotificationCategoryIdentifier.approval)
        XCTAssertEqual(NotificationCategoryIdentifier.forKind("done"), NotificationCategoryIdentifier.update)
        XCTAssertEqual(NotificationCategoryIdentifier.forKind("routine-failed"), NotificationCategoryIdentifier.update)
        // An unrecognised future kind must fail safe to Open-only, not to
        // an approval category it never asked for.
        XCTAssertEqual(NotificationCategoryIdentifier.forKind("something-new"), NotificationCategoryIdentifier.update)
    }

    // MARK: - Action routing

    /// A harness new enough to send `requestId` — see `NotificationFrame`.
    private let payload: [AnyHashable: Any] = [
        "threadId": "task-2", "botId": "bot-1", "kind": "approval", "requestId": "req-9",
    ]
    /// An older harness: the same notification, minus `requestId`.  Both
    /// shapes must route the same way — only the carried identity differs.
    private let payloadWithoutRequestId: [AnyHashable: Any] = [
        "threadId": "task-2", "botId": "bot-1", "kind": "approval",
    ]

    func testApproveActionRoutesToApproveCarryingTheRequestId() {
        XCTAssertEqual(
            NotificationTarget.actionRoute(actionIdentifier: NotificationActionIdentifier.approve, userInfo: payload),
            .approve(NotificationTarget(botId: "bot-1", threadId: "task-2", requestId: "req-9", kind: "approval")!)
        )
    }

    func testDenyActionRoutesToDenyCarryingTheRequestId() {
        XCTAssertEqual(
            NotificationTarget.actionRoute(actionIdentifier: NotificationActionIdentifier.deny, userInfo: payload),
            .deny(NotificationTarget(botId: "bot-1", threadId: "task-2", requestId: "req-9", kind: "approval")!)
        )
    }

    /// An older harness never sent `requestId` at all.  Routing must still
    /// reach `.approve` — with the id absent, not a crash — so
    /// `Session.answerPendingRequest` can fall back to resolving the
    /// thread's pending card.
    func testApproveActionWithoutRequestIdStillRoutesWithTheIdAbsent() {
        let route = NotificationTarget.actionRoute(
            actionIdentifier: NotificationActionIdentifier.approve,
            userInfo: payloadWithoutRequestId
        )
        guard case let .approve(target) = route else {
            return XCTFail("expected .approve, got \(route)")
        }
        XCTAssertNil(target.requestId)
        XCTAssertEqual(target.threadId, "task-2")
        XCTAssertEqual(target.botId, "bot-1")
    }

    func testOpenActionAndDefaultTapBothRouteToOpen() {
        let expected = NotificationActionRoute.open(
            NotificationTarget(botId: "bot-1", threadId: "task-2", requestId: "req-9", kind: "approval")!
        )
        XCTAssertEqual(
            NotificationTarget.actionRoute(actionIdentifier: NotificationActionIdentifier.open, userInfo: payload),
            expected
        )
        XCTAssertEqual(
            NotificationTarget.actionRoute(
                actionIdentifier: UNNotificationDefaultActionIdentifier,
                userInfo: payload
            ),
            expected
        )
    }

    func testDismissActionIsANoOp() {
        XCTAssertEqual(
            NotificationTarget.actionRoute(actionIdentifier: UNNotificationDismissActionIdentifier, userInfo: payload),
            .dismiss
        )
    }

    func testUnknownActionIsIgnored() {
        XCTAssertEqual(
            NotificationTarget.actionRoute(actionIdentifier: "SOME_OTHER_ACTION", userInfo: payload),
            .ignore
        )
    }

    func testApproveOrDenyWithoutUsableIdsIsIgnored() {
        let malformed: [AnyHashable: Any] = ["botId": "bot-1"] // no threadId
        XCTAssertEqual(
            NotificationTarget.actionRoute(actionIdentifier: NotificationActionIdentifier.approve, userInfo: malformed),
            .ignore
        )
        XCTAssertEqual(
            NotificationTarget.actionRoute(actionIdentifier: NotificationActionIdentifier.deny, userInfo: malformed),
            .ignore
        )
    }

    // MARK: - Text-input reply routing (PR #389)

    /// Reply action on a question: the typed body rides on the route.
    /// `userInfo` carries the same ids as Approve/Deny/Open — only the
    /// typed text is extra, because iOS keeps it off `userInfo`.
    private let questionPayload: [AnyHashable: Any] = [
        "threadId": "task-3", "botId": "bot-2", "kind": "question", "requestId": "req-7",
    ]

    func testReplyActionRoutesToReplyCarryingTheTypedBody() {
        XCTAssertEqual(
            NotificationTarget.actionRoute(
                actionIdentifier: NotificationActionIdentifier.reply,
                userInfo: questionPayload,
                textInputBody: "tomorrow at 3"
            ),
            .reply(
                NotificationTarget(botId: "bot-2", threadId: "task-3", requestId: "req-7", kind: "question")!,
                message: "tomorrow at 3"
            )
        )
    }

    /// An empty / whitespace reply must not produce a `.reply` route with
    /// an empty message — the user opened the text field and backed out,
    /// which is a dismiss, not an empty answer to send to the harness.
    func testReplyWithEmptyOrWhitespaceBodyIsTreatedAsADismiss() {
        XCTAssertEqual(
            NotificationTarget.actionRoute(
                actionIdentifier: NotificationActionIdentifier.reply,
                userInfo: questionPayload,
                textInputBody: ""
            ),
            .dismiss
        )
        XCTAssertEqual(
            NotificationTarget.actionRoute(
                actionIdentifier: NotificationActionIdentifier.reply,
                userInfo: questionPayload,
                textInputBody: "   \n  "
            ),
            .dismiss
        )
        // A nil body (the caller did not pass the optional) is the same
        // dismissal case.
        XCTAssertEqual(
            NotificationTarget.actionRoute(
                actionIdentifier: NotificationActionIdentifier.reply,
                userInfo: questionPayload,
                textInputBody: nil
            ),
            .dismiss
        )
    }

    /// Surrounding whitespace is trimmed so a stray newline from the
    /// keyboard does not become part of the message.
    func testReplyTrimsSurroundingWhitespaceBeforeSending() {
        XCTAssertEqual(
            NotificationTarget.actionRoute(
                actionIdentifier: NotificationActionIdentifier.reply,
                userInfo: questionPayload,
                textInputBody: "  pick option B  \n"
            ),
            .reply(
                NotificationTarget(botId: "bot-2", threadId: "task-3", requestId: "req-7", kind: "question")!,
                message: "pick option B"
            )
        )
    }

    /// The reply action is registered; no other action should ever
    /// silently consume a text-input body.
    func testNonReplyActionsIgnoreTheTextInputBody() {
        let expected = NotificationActionRoute.approve(
            NotificationTarget(botId: "bot-1", threadId: "task-2", requestId: "req-9", kind: "approval")!
        )
        XCTAssertEqual(
            NotificationTarget.actionRoute(
                actionIdentifier: NotificationActionIdentifier.approve,
                userInfo: payload,
                textInputBody: "should be ignored"
            ),
            expected
        )
    }

    /// A reply with no target ids is the same dead-letter as Approve/Deny
    /// with no ids — never invent one.
    func testReplyWithoutUsableIdsIsIgnored() {
        let malformed: [AnyHashable: Any] = ["botId": "bot-2"] // no threadId
        XCTAssertEqual(
            NotificationTarget.actionRoute(
                actionIdentifier: NotificationActionIdentifier.reply,
                userInfo: malformed,
                textInputBody: "hi"
            ),
            .ignore
        )
    }

    // MARK: - The literal choices sent through the shared answer path

    /// `Session.answerPendingRequest` sends "Approve"/"Deny" through
    /// `OptionCard.responseBehavior`, the same card logic every other
    /// surface uses.  Pin those two literals to the behavior they must
    /// produce so a rename anywhere silently breaking approval is a test
    /// failure, not a support ticket.
    func testApproveAndDenyLiteralsMapToTheirCardBehavior() {
        XCTAssertEqual(OptionCard.responseBehavior(for: "Approve", isPermission: true), "allow")
        XCTAssertEqual(OptionCard.responseBehavior(for: "Deny", isPermission: true), "deny")
    }

    // MARK: - Approval resolution (PR #383 review)

    /// P1 regression.  `state.pendingApprovals` is newest-first across every
    /// thread; the code this replaced picked `pending.first { $0.threadId
    /// == threadId }`, which ignores `requestId` entirely and returns
    /// whichever card is newest — the WRONG one the moment two are open on
    /// one thread.  Reproduce that exact selection here first, prove it
    /// picks the wrong card, then prove `ApprovalResolver` does not.
    func testRequestIdNamingTheOlderCardAnswersThatCardNotTheNewestOnTheThread() {
        // Newest first, matching `state.pendingApprovals`'s own ordering.
        let pending = [
            PendingApproval(threadId: "t1", requestId: "newer-question", isPermission: false),
            PendingApproval(threadId: "t1", requestId: "older-permission", isPermission: true),
        ]

        let buggyPick = pending.first { $0.threadId == "t1" }
        XCTAssertEqual(buggyPick?.requestId, "newer-question", "sanity: reproducing the bug this test guards against")
        XCTAssertNotEqual(buggyPick?.isPermission, true, "the buggy pick does not belong to \"older-permission\"")

        XCTAssertEqual(
            ApprovalResolver.resolve(threadId: "t1", requestId: "older-permission", kind: "approval", pending: pending),
            .answer(requestId: "older-permission", isPermission: true)
        )
    }

    /// The id happens to exist, but only on a different thread — its
    /// `isPermission` must never leak into this answer.
    func testRequestIdOnlyOnAnotherThreadFallsBackToKindNotThatCard() {
        let pending = [PendingApproval(threadId: "other-thread", requestId: "req-1", isPermission: true)]
        XCTAssertEqual(
            ApprovalResolver.resolve(threadId: "t1", requestId: "req-1", kind: "question", pending: pending),
            .answer(requestId: "req-1", isPermission: false)
        )
    }

    func testRequestIdWithNothingInMemoryDerivesIsPermissionFromKind() {
        XCTAssertEqual(
            ApprovalResolver.resolve(threadId: "t1", requestId: "req-1", kind: "approval", pending: []),
            .answer(requestId: "req-1", isPermission: true)
        )
        XCTAssertEqual(
            ApprovalResolver.resolve(threadId: "t1", requestId: "req-1", kind: "question", pending: []),
            .answer(requestId: "req-1", isPermission: false)
        )
    }

    func testNoRequestIdWithExactlyOnePendingOnThreadAnswersIt() {
        let pending = [PendingApproval(threadId: "t1", requestId: "req-1", isPermission: true)]
        XCTAssertEqual(
            ApprovalResolver.resolve(threadId: "t1", requestId: nil, kind: nil, pending: pending),
            .answer(requestId: "req-1", isPermission: true)
        )
    }

    /// No id to be right with, and more than one candidate — guessing
    /// "the newest" is the same bug as the regression test above, just
    /// without an id to expose it.  Never guess; open the app instead.
    func testNoRequestIdWithTwoPendingOnThreadOpensAppInsteadOfGuessing() {
        let pending = [
            PendingApproval(threadId: "t1", requestId: "req-1", isPermission: true),
            PendingApproval(threadId: "t1", requestId: "req-2", isPermission: false),
        ]
        XCTAssertEqual(
            ApprovalResolver.resolve(threadId: "t1", requestId: nil, kind: "approval", pending: pending),
            .openApp
        )
    }

    func testNoRequestIdWithNothingPendingOnThreadOpensApp() {
        XCTAssertEqual(ApprovalResolver.resolve(threadId: "t1", requestId: nil, kind: "approval", pending: []), .openApp)
    }
}
