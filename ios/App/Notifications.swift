import Foundation
import UserNotifications
import CompanionCore

/// The on-device notification surface. Delivery comes from live or replayed
/// companion frames, and from APNs when the sidecar wakes a killed app.
final class NotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationCoordinator()
    /// Set once the added `.timeSensitive` option has been asked for on an
    /// install that was already authorized.
    private static let timeSensitiveRequestedKey = "botfleet.timeSensitiveAuthorizationRequested"
    private let center = UNUserNotificationCenter.current()
    /// Set by `Session`; kept as an id-only value so the notification layer
    /// does not know about SwiftUI navigation or mutable fleet state.
    var responseHandler: ((NotificationTarget) -> Void)?
    /// Thread currently on screen.  Banners for this id stay off; the
    /// bubble is already in the transcript.
    var viewingThreadId: String?
    /// Set by `Session`; answers Approve/Deny straight from a notification
    /// action, without opening the app.
    var approvalActionHandler: ((_ target: NotificationTarget, _ approve: Bool) async -> Void)?
    /// Set by `Session`; sends the typed body of a `UNTextInputNotificationAction`
    /// reply on a question notification straight to the harness without
    /// opening the app.  The body rides on the closure because
    /// `UNTextInputNotificationAction` does not put it on `userInfo`.
    var replyActionHandler: ((_ target: NotificationTarget, _ message: String) async -> Void)?
    /// Harness frames APNs has already shown.  The sidecar pushes only to a
    /// phone whose stream is down and wakes the app, which then reconnects
    /// and is replayed the same frame — without this, every closed-app
    /// notification lands twice, and after PR #383 both copies carry
    /// Approve and Deny for a request only one of them can settle.
    private var pushDelivered = PushDeliveryLedger()

    private override init() {
        super.init()
        center.delegate = self
        // Registered on every launch, before `RootView` appears and before
        // any notification (local or remote) can be delivered — see
        // `NotificationCategories` for why the set lives in CompanionCore.
        center.setNotificationCategories(NotificationCategories.all())
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    /// `.timeSensitive` is asked for alongside the rest because approval and
    /// question alerts are sent at that interruption level; without the
    /// option granted, iOS quietly demotes them to an ordinary banner that a
    /// Focus mode will hold back.
    func requestAuthorization() async -> Bool {
        (try? await center.requestAuthorization(options: [.alert, .badge, .sound, .timeSensitive])) == true
    }

    /// Installs that granted notifications before `.timeSensitive` joined the
    /// set above keep the old grant: iOS adds a new option to an
    /// already-authorized app without prompting again, but only when the app
    /// actually asks for it.  Ask once per install — the flag is what stops
    /// every launch from asking forever.
    func requestTimeSensitiveIfNeeded() async {
        let defaults = UserDefaults.standard
        if defaults.bool(forKey: Self.timeSensitiveRequestedKey) { return }
        // Only an existing grant: a phone that has never been asked, or that
        // said no, must not be prompted by a launch it did not initiate.
        guard await authorizationStatus() == .authorized else { return }
        _ = await requestAuthorization()
        defaults.set(true, forKey: Self.timeSensitiveRequestedKey)
    }

    /// Remember that APNs put this frame on screen.  Called for every push
    /// this process gets to see: the silent wake, a foreground delivery, and
    /// a tap.  A push the app was never running to observe cannot be
    /// correlated, and the replay is believed rather than dropped.
    func notePushDelivered(userInfo: [AnyHashable: Any]) {
        pushDelivered.record(pushUserInfo: userInfo)
    }

    func deliver(_ notification: NotificationFrame, sequence: Int?) {
        // Apple already delivered this exact frame.  A replay of it is the
        // same event, not a second one.
        if pushDelivered.isAlreadyDelivered(sequence) { return }
        guard NotificationFrame.shouldPresentBanner(
            threadId: notification.threadId,
            viewingThreadId: viewingThreadId
        ) else { return }
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
            .replacingOccurrences(of: "&nbsp;", with: " ", options: .caseInsensitive)
            .replacingOccurrences(of: "&#160;", with: " ")
            .replacingOccurrences(of: "&#xA0;", with: " ", options: .caseInsensitive)
        content.sound = .default
        // `kind`, never `isBlocking` — a question is blocking too, but has
        // no verdict for Approve/Deny to send.  `isBlocking` still governs
        // `interruptionLevel` below.
        content.categoryIdentifier = NotificationCategoryIdentifier.forKind(notification.kind)
        content.threadIdentifier = notification.threadId
        var userInfo: [AnyHashable: Any] = [
            "threadId": notification.threadId,
            "botId": notification.botId,
            "kind": notification.kind,
        ]
        // Only approval/question frames carry these — added conditionally
        // so an absent value never becomes an `NSNull` a reader has to
        // filter back out.
        if let requestId = notification.requestId { userInfo["requestId"] = requestId }
        if let tool = notification.tool { userInfo["tool"] = tool }
        content.userInfo = userInfo
        if notification.isBlocking { content.interruptionLevel = .timeSensitive }

        // A replay after a short disconnect must reconcile a missed alert,
        // but a repeated frame must not draw it twice.
        let identifier = "botfleet.\(notification.threadId).\(sequence.map(String.init) ?? notification.title)"
        center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }

    func setBadge(_ count: Int) {
        center.setBadgeCount(max(0, count))
    }

    /// A phone-local follow-up for when a notification action could not
    /// finish on its own — the original notification is already gone by
    /// the time the user would see this, so it needs its own banner.  Open
    /// only: this never carries Approve/Deny, so it cannot itself become
    /// the same "which request?" problem it exists to report.
    func deliverFollowUp(title: String, body: String, target: NotificationTarget) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.categoryIdentifier = NotificationCategoryIdentifier.update
        content.threadIdentifier = target.threadId
        content.userInfo = ["threadId": target.threadId, "botId": target.botId]
        center.add(UNNotificationRequest(
            identifier: "botfleet.followup.\(target.threadId).\(UUID().uuidString)",
            content: content,
            trigger: nil
        ))
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        if notification.request.trigger is UNPushNotificationTrigger {
            notePushDelivered(userInfo: notification.request.content.userInfo)
        }
        let threadId = notification.request.content.threadIdentifier
        if NotificationFrame.shouldPresentBanner(threadId: threadId, viewingThreadId: viewingThreadId) {
            completionHandler([.banner, .list, .sound, .badge])
        } else {
            completionHandler([])
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        if response.notification.request.trigger is UNPushNotificationTrigger {
            notePushDelivered(userInfo: userInfo)
        }
        // `UNTextInputNotificationAction` carries the typed reply here —
        // iOS does not put it on `userInfo`.  Pulling it for every action
        // is cheap (just a wrapper type-check), and `actionRoute` ignores
        // the body unless the action is `BOTFLEET_REPLY`.
        let textInputBody = (response as? UNTextInputNotificationResponse)?.userText
        switch NotificationTarget.actionRoute(
            actionIdentifier: response.actionIdentifier,
            userInfo: userInfo,
            textInputBody: textInputBody
        ) {
        case let .approve(target):
            sendApprovalAction(target, approve: true, completionHandler: completionHandler)
        case let .deny(target):
            sendApprovalAction(target, approve: false, completionHandler: completionHandler)
        case let .reply(target, message):
            sendReplyAction(target, message: message, completionHandler: completionHandler)
        case let .open(target):
            // Covers both the explicit Open action and a plain tap
            // (`UNNotificationDefaultActionIdentifier`) — the app's existing
            // tap behaviour, unchanged.
            responseHandler?(target)
            completionHandler()
        case .dismiss, .ignore:
            completionHandler()
        }
    }

    /// Approve/deny send a network request, so — unlike a tap, which only
    /// touches in-memory navigation state — completion must wait for it:
    /// calling `completionHandler` early risks iOS suspending the process
    /// before the answer goes out.
    private func sendApprovalAction(
        _ target: NotificationTarget,
        approve: Bool,
        completionHandler: @escaping () -> Void
    ) {
        guard let approvalActionHandler else {
            completionHandler()
            return
        }
        Task {
            await approvalActionHandler(target, approve)
            completionHandler()
        }
    }

    /// A reply action is a network call the same way Approve/Deny is.
    /// Same shape as `sendApprovalAction`, kept separate so a future
    /// reply-only outcome (e.g. a follow-up banner on failure) has a
    /// place to land without entangling the approval path.
    private func sendReplyAction(
        _ target: NotificationTarget,
        message: String,
        completionHandler: @escaping () -> Void
    ) {
        guard let replyActionHandler else {
            completionHandler()
            return
        }
        Task {
            await replyActionHandler(target, message)
            completionHandler()
        }
    }
}
