import Foundation

/// The engine roster the phone holds, and the one rule that keeps it in the
/// harness's order.
///
/// The harness stamps every roster it describes with `describedAt`, strictly
/// later than the one before, and delivers it two ways: a fetch (`/api/instances`)
/// and a push (the `instances` stream frame, sent when a slow background probe
/// settles).  The two race, and either can arrive late, so an arrival is
/// installed only if it is not older than the roster already held.  The web
/// client applies the same rule in `src/state/store.tsx`.  Equal stamps mean
/// the same commit arriving twice and install harmlessly.
///
/// An answer with no stamp comes from a harness that predates the field; it is
/// installed as before, since there is nothing to order it by.
public struct InstanceRoster: Equatable, Sendable {
    /// The roster most recently installed.
    public private(set) var instances: [Instance] = []
    /// `describedAt` of that roster; `-infinity` until a stamped one lands.
    public private(set) var describedAt: Double = -.infinity
    /// Counts the times the ordering was thrown away (`forgetOrder`, `reset`).
    /// A fetch notes it when it starts and hands it back to `apply`, so an answer
    /// that was already on the wire when the order was reset is not installed.
    public private(set) var orderEpoch = 0

    public init() {}

    /// Installs `instances` unless the harness already described a newer roster.
    /// Returns whether it was installed.
    ///
    /// `startedAt` is the `orderEpoch` read before the request went out.  If the
    /// order was reset since, the answer may come from the process whose clock
    /// the reset gave up on, and its stamp (higher than the new process's) would
    /// put the mark back where the reset took it from: it is refused.  Pushes
    /// arrive on the live stream, so they never pass one.
    @discardableResult
    public mutating func apply(
        _ instances: [Instance],
        describedAt stamp: Double?,
        startedAt epoch: Int? = nil
    ) -> Bool {
        if let epoch, epoch != orderEpoch { return false }
        if let stamp {
            guard stamp >= describedAt else { return false }
            describedAt = stamp
        }
        self.instances = instances
        return true
    }

    /// Forgets the roster, and the high-water mark with it: a new pairing is a
    /// different harness whose stamps share nothing with the last one's.
    public mutating func reset() {
        instances = []
        describedAt = -.infinity
        orderEpoch += 1
    }

    /// Forgets only the high-water mark, keeping the roster on screen.
    ///
    /// `describedAt` is the harness's clock, and each harness process starts its
    /// own: after a restart (the stream says so with `resumed == false`) its
    /// stamps can sit below the old process's last one, for instance when the
    /// Mac's clock was corrected backwards meanwhile.  Holding the old mark
    /// would then drop every fetch and push until the clock caught up.  The
    /// roster itself stays, so pickers do not go empty before the next one lands.
    public mutating func forgetOrder() {
        describedAt = -.infinity
        orderEpoch += 1
    }

    /// instanceId -> driverKind for the held roster, so a bot's saved selection
    /// resolves to a provider mark without a lookup per render.  Hidden
    /// engines are included: a selection that points at one still resolves.
    public var driverKinds: [String: String] {
        Dictionary(
            instances.map { ($0.instanceId, $0.driverKind) },
            uniquingKeysWith: { _, latest in latest }
        )
    }
}

public extension Instance {
    /// Whether an engine list offers this instance.
    ///
    /// A hidden engine (an optional integration nobody has set up, such as the
    /// ASCII.dev Box engine with no Box token) stays registered but is left out
    /// of every list, as on the Mac.  `selectedIds` are the instances something
    /// already points at, a bot's saved model or one of its fallbacks: those
    /// stay, so the selection still resolves instead of going blank.
    func isListed(keeping selectedIds: Set<String> = []) -> Bool {
        !snapshot.isHidden || selectedIds.contains(instanceId)
    }
}

public extension Sequence where Element == Instance {
    /// The instances an engine list offers; see `Instance.isListed(keeping:)`.
    func listed(keeping selectedIds: Set<String> = []) -> [Instance] {
        filter { $0.isListed(keeping: selectedIds) }
    }
}
