import Foundation

/// App lifecycle states that affect local-only Live Activities.
public enum LiveActivityLifecyclePhase: Sendable, Equatable {
    case active
    case inactive
    case background
}

/// Work the ActivityKit coordinator must perform after a lifecycle change.
public enum LiveActivityLifecycleAction: Sendable, Equatable {
    case awaitFreshState
    case endAll
    /// End the ambient activities and keep the ones a person still has to
    /// answer.  `.endAll` is what sign-out and a cold reset use; backgrounding
    /// uses this, so an unanswered ask stays on the Lock Screen.
    case endAmbient
    case resetAndAwaitFreshState
}

/// Keeps stale foreground work from landing after a background teardown.
///
/// `.inactive` is a transition on the way to system UI or background.  It
/// retains the preceding update policy; only `.background` disables updates
/// and ends ambient activities — an activity still waiting on a person is
/// kept, because `LiveActivityRetention` decides that, not the clock.
/// Initial activation and the first `.active` after `.background` start a
/// fresh generation, but updates stay disabled until a post-resume snapshot
/// lands.
public struct LiveActivityLifecycle: Sendable {
    public private(set) var phase: LiveActivityLifecyclePhase = .inactive
    public private(set) var generation = 0
    public private(set) var updatesEnabled = false
    private var freshStateRequired = true

    public init() {}

    public mutating func transition(to next: LiveActivityLifecyclePhase) -> LiveActivityLifecycleAction? {
        guard next != phase else { return nil }
        phase = next
        switch next {
        case .active:
            guard freshStateRequired else { return nil }
            freshStateRequired = false
            let isInitialActivation = generation == 0
            generation += 1
            updatesEnabled = false
            return isInitialActivation ? .resetAndAwaitFreshState : .awaitFreshState
        case .inactive:
            return nil
        case .background:
            freshStateRequired = true
            generation += 1
            updatesEnabled = false
            return .endAmbient
        }
    }

    /// A pairing identity change invalidates both ActivityKit state and any
    /// hydration issued for the previous client.  A new foreground pairing
    /// can hydrate immediately; elsewhere the next activation performs it.
    public mutating func pairingChanged(isPaired: Bool) -> LiveActivityLifecycleAction {
        generation += 1
        updatesEnabled = false
        freshStateRequired = true
        guard isPaired, phase == .active else { return .endAll }
        freshStateRequired = false
        return .resetAndAwaitFreshState
    }

    public func permitsUpdates(from candidateGeneration: Int) -> Bool {
        updatesEnabled && candidateGeneration == generation
    }

    public mutating func acceptFreshState(for candidateGeneration: Int) -> Bool {
        guard phase != .background, candidateGeneration == generation else { return false }
        updatesEnabled = true
        return true
    }
}
