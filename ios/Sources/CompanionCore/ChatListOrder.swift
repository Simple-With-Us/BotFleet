// Roster order for the chat list.
//
// Messages.app (and the Mac sidebar) pin first, then newest activity.
// Unread is a badge, not a sort key — putting unread rows above a chat
// that just moved is what made Plumber at 10:05 sit below Monitor at 8:01.
import Foundation

public enum ChatListOrder {
    /// Max of loaded transcript, each task's lastActivity (or createdAt),
    /// and the chat's own createdAt.
    public static func activity(
        createdAt: Double,
        taskActivities: [Double],
        loadedMessageAt: Double?
    ) -> Double {
        var stamp = createdAt
        if let loadedMessageAt, loadedMessageAt > stamp { stamp = loadedMessageAt }
        for taskAt in taskActivities where taskAt > stamp { stamp = taskAt }
        return stamp
    }

    /// `true` when `left` belongs above `right` in the roster.
    public static func orderedBefore(
        pinnedLeft: Bool,
        activityLeft: Double,
        pinnedRight: Bool,
        activityRight: Double
    ) -> Bool {
        if pinnedLeft != pinnedRight { return pinnedLeft }
        return activityLeft > activityRight
    }

    /// The roster in order: pinned first, then newest activity, and chats that
    /// tie on both keep the order they arrived in.  The desktop sidebar's
    /// `compareBotsByRecentActivity` gets that last part from JavaScript's
    /// stable sort; Swift's `sorted(by:)` does not promise it, so the arrival
    /// position is the final tiebreak here and a pin never reshuffles the
    /// chats it ties with.
    public static func stableOrder<Item>(
        _ items: [Item],
        by key: (Item) -> (pinned: Bool, activity: Double)
    ) -> [Item] {
        let keyed = items.enumerated().map { entry in
            (position: entry.offset, item: entry.element, key: key(entry.element))
        }
        return keyed
            .sorted { left, right in
                if orderedBefore(
                    pinnedLeft: left.key.pinned,
                    activityLeft: left.key.activity,
                    pinnedRight: right.key.pinned,
                    activityRight: right.key.activity
                ) { return true }
                if orderedBefore(
                    pinnedLeft: right.key.pinned,
                    activityLeft: right.key.activity,
                    pinnedRight: left.key.pinned,
                    activityRight: left.key.activity
                ) { return false }
                return left.position < right.position
            }
            .map(\.item)
    }
}
