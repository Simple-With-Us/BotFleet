import Foundation

/// Keeps the newest fleet snapshot and drops the ones that arrive late.
///
/// Two reads of the fleet's processes can overlap, and the slower one can
/// finish last.  Without this, that older read would overwrite the newer
/// snapshot and leave the menu showing what was true before the action the
/// owner just took.
///
/// Every read is given a number when it starts, and only the newest number is
/// current.  A read that finds itself stale drops its result instead of
/// writing it.
public final class FleetSnapshotSequencer: @unchecked Sendable {
    private let lock = NSLock()
    private var generation = 0

    public init() {}

    /// Starts a new read and returns its number.
    ///
    /// Every read that was started before this one is stale from now on.
    public func begin() -> Int {
        lock.lock()
        defer { lock.unlock() }
        generation &+= 1
        return generation
    }

    /// True when the read with this number is still the newest one.
    public func isCurrent(_ number: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return number == generation
    }
}
