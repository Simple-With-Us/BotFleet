import Foundation

/// "Approve All" on a conversation with several permission requests waiting.
///
/// The harness answers `POST /api/threads/:id/approve-all` by allowing every
/// card in the thread that is unanswered, undismissed, and carries a tool.  A
/// question has no tool, so a thread holding only questions has nothing for
/// the button to approve.  The count and the button below are derived from the
/// same rule, so the label never promises more than the route will do.
public enum ApproveAll {
    /// Permission cards still waiting, oldest first.
    public static func pendingPermissions(in messages: [Message]) -> [Message] {
        messages.filter {
            $0.kind == .options && $0.card?.isPending == true && $0.card?.isPermission == true
        }
    }

    /// The card that carries the button, and how many it will approve.  Nil
    /// until there are two or more, because one request already has its own
    /// Approve button.  The newest card carries it: that is the one at the
    /// bottom of the transcript, next to the composer.
    public static func offer(in messages: [Message]) -> (messageId: String, count: Int)? {
        let pending = pendingPermissions(in: messages)
        guard pending.count > 1, let newest = pending.last else { return nil }
        return (messageId: newest.id, count: pending.count)
    }

    /// The desktop's own label.
    public static func label(count: Int) -> String {
        "Approve All (\(count))"
    }

    /// The desktop's tooltip, as the accessibility hint.
    public static let hint = "Approve all waiting requests in this conversation"
}

/// `POST /api/threads/:id/approve-all` answers `{ ok, approvedCount }`.
struct ApproveAllResponse: Decodable, Sendable {
    var ok: Bool?
    var approvedCount: Int?
}
