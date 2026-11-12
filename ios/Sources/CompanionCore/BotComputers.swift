import Foundation

/// Which of a bot's computers this phone may switch, and how a save is built.
///
/// The harness answers a paired phone's `computers` write with its own rule
/// (`PAIRED_LOCAL_COMPUTER_ERROR` in server/index.ts): the sandboxed
/// destinations, a cloud computer and the Local VM, are the phone's to switch,
/// and whether the bot holds This Mac is not.  Host control hands a bot the
/// person's real desktop, so it is turned on or off in BotFleet on the
/// computer, where the Auto Mode warning lives.  A bot sheet that offered a
/// This Mac switch would be a control whose write is always refused, so the
/// sheet shows that row read-only and this type keeps it out of every request.
public enum BotComputers {
    /// The destinations the phone can switch, in the order they are listed.
    public static let phoneEditable = ["cloud", "vm"]

    /// The destination only the computer can switch.
    public static let thisMac = "local"

    /// Every destination the harness stores, in the order it lists them.
    private static let storedOrder = ["cloud", "vm", "local"]

    /// The `computers` array to send, or nil when the person changed neither
    /// switch.
    ///
    /// The result starts from the bot as it is NOW (`current`), not from the
    /// form: the person's toggles are applied on top, and only those.  That
    /// has two consequences the harness depends on.  This Mac comes out the
    /// way it went in, even if the computer changed it while the sheet was
    /// open, so the request is never refused for a change the person did not
    /// make.  And a destination the computer changed in the meantime is not
    /// overwritten with the stale copy the form was opened with.
    ///
    /// - Parameters:
    ///   - current: the bot's `computers` as the phone last heard it.  Nil is
    ///     Auto (the computer picks), which a first switch turns into a list
    ///     exactly as the desktop does.
    ///   - baseline: the destinations the form opened with.
    ///   - picks: the destinations the form shows now.
    public static func updated(
        current: [String]?,
        baseline: Set<String>,
        picks: Set<String>
    ) -> [String]? {
        let changed = phoneEditable.filter { picks.contains($0) != baseline.contains($0) }
        guard !changed.isEmpty else { return nil }
        var next = Set(current ?? [])
        for destination in changed {
            if picks.contains(destination) {
                next.insert(destination)
            } else {
                next.remove(destination)
            }
        }
        let result = storedOrder.filter(next.contains)
        // The computer already holds exactly this (it made the same change
        // while the sheet was open): nothing to ask for.
        if let current, Set(current) == Set(result) { return nil }
        return result
    }

    /// Whether the bot holds This Mac, for the read-only row.
    public static func holdsThisMac(_ computers: [String]?) -> Bool {
        computers?.contains(thisMac) == true
    }
}
