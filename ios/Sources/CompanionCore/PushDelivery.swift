// What APNs has already put on the lock screen, so the replay that follows
// does not put it there a second time.
//
// The sidecar pushes only to a phone whose event stream is down, and that
// push carries `content-available` so iOS wakes the app.  The app then
// reconnects with its stored cursor and the harness replays the very notify
// frame the push was built from — which the app would otherwise post as a
// second, local banner for the same event.  Both copies carry Approve and
// Deny, so answering one leaves a stale actionable card behind on a request
// that is already settled.
//
// The correlation is the harness frame's own sequence number: `broadcast`
// stamps it (`server/index.ts`), the sidecar copies it into the push payload
// (`companion/src/apns.ts`), and the replayed frame carries the same value.
// A frame whose sequence is in this ledger has already been shown.
import Foundation

/// The sequences this phone has been shown by push.  Bounded, and ordered
/// oldest-first so the bound evicts the entries least likely to still be
/// replayed.
public struct PushDeliveryLedger: Equatable, Sendable {
    /// How many pushed sequences to remember.  The harness's replay buffer
    /// is what decides how far back a reconnect can reach, and a phone that
    /// has been away long enough to need more than this got `resumed: false`
    /// and a full hydrate instead of a replay — there is nothing left to
    /// correlate by then.
    public static let capacity = 128

    private var order: [Int] = []
    private var seen: Set<Int> = []

    public init() {}

    /// Note that APNs delivered the frame at this sequence.
    public mutating func record(_ sequence: Int) {
        guard !seen.contains(sequence) else { return }
        seen.insert(sequence)
        order.append(sequence)
        if order.count > Self.capacity { seen.remove(order.removeFirst()) }
    }

    /// Note the frame a push payload names, when it names one.  An older
    /// sidecar sends no sequence at all, and that is not an error — it just
    /// means this push cannot be correlated and the replay will be believed.
    @discardableResult
    public mutating func record(pushUserInfo userInfo: [AnyHashable: Any]) -> Int? {
        guard let sequence = Self.sequence(inPushUserInfo: userInfo) else { return nil }
        record(sequence)
        return sequence
    }

    /// Whether a local banner for this frame would be the second copy of a
    /// notification the user has already seen.  A frame with no sequence —
    /// an older harness — is never suppressed: silence is the worse failure
    /// of the two.
    public func isAlreadyDelivered(_ sequence: Int?) -> Bool {
        guard let sequence else { return false }
        return seen.contains(sequence)
    }

    /// Read the harness sequence out of a notification's `userInfo`.  APNs
    /// hands JSON numbers back as `NSNumber`, a local frame puts an `Int`
    /// there, and a payload that carries neither answers nil.
    public static func sequence(inPushUserInfo userInfo: [AnyHashable: Any]) -> Int? {
        guard let raw = userInfo["seq"] else { return nil }
        if let number = raw as? NSNumber { return number.intValue }
        if let value = raw as? Int { return value }
        if let text = raw as? String { return Int(text) }
        return nil
    }
}
