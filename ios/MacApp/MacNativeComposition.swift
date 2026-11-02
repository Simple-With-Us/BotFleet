import Foundation
import CompanionCore

/// Shared constants for the Mac app's native engine composition wiring.
///
/// The deadline mirrors the server's graceful stop (`server/graceful-shutdown.ts`,
/// 10 seconds with 250 ms polling): the bots get a bounded window to finish
/// on their own, and a wait with no end is a hang.
public enum MacNativeComposition {
    /// How long quit-time drain waits for in-flight native turns to settle.
    public static let drainDeadlineMs: Double = 10_000
    /// How often the drain re-reads the turn counts.
    public static let drainPollMs: Double = 250
}

/// Snapshot of native engine activity for the Mac app's server-bridge session
/// state.
///
/// The active engine turn count plus the supervised-process count is the
/// work-in-flight number the graceful-stop drain path waits on (AG busy-flag
/// note): a nonzero snapshot keeps the quit-time shutdown waiting, inside
/// its bounded window, instead of abandoning turns mid-flight.
public struct MacNativeBusySnapshot: Equatable, Sendable {
    /// Turns currently dispatched on the listener graph's engine coordinator.
    public var engineTurns: Int
    /// Child engine processes currently supervised on the listener graph.
    public var supervisedProcesses: Int

    public init(engineTurns: Int = 0, supervisedProcesses: Int = 0) {
        self.engineTurns = max(0, engineTurns)
        self.supervisedProcesses = max(0, supervisedProcesses)
    }

    /// The drain counter: every native turn or process the stop must wait for.
    public var total: Int { engineTurns + supervisedProcesses }

    /// Whether any native work is in flight.
    public var isBusy: Bool { total > 0 }

    /// One line for logs and the Settings surface, in the owner's words.
    public var summary: String {
        if !isBusy { return "No native engine work in flight." }
        if engineTurns > 0, supervisedProcesses > 0 {
            return "\(engineTurns) native turn\(engineTurns == 1 ? "" : "s") and \(supervisedProcesses) engine process\(supervisedProcesses == 1 ? "" : "es") in flight.\u{00A0} Quitting waits for them to settle."
        }
        if engineTurns > 0 {
            return "\(engineTurns) native turn\(engineTurns == 1 ? "" : "s") in flight.\u{00A0} Quitting waits for them to settle."
        }
        return "\(supervisedProcesses) engine process\(supervisedProcesses == 1 ? "" : "es") in flight.\u{00A0} Quitting waits for them to settle."
    }
}

/// What a bounded quit-time native drain did, in the words the owner reads.
public struct MacNativeDrainResult: Equatable, Sendable {
    /// True when the counts reached zero before the deadline.
    public var settledCleanly: Bool
    /// Engine turns still active when the window closed.
    public var remainingEngineTurns: Int
    /// Supervised processes still active when the window closed.
    public var remainingProcesses: Int
    /// True when the terminal runtime shutdown ran afterwards.
    public var didShutDownRuntime: Bool

    public init(
        settledCleanly: Bool,
        remainingEngineTurns: Int = 0,
        remainingProcesses: Int = 0,
        didShutDownRuntime: Bool = false
    ) {
        self.settledCleanly = settledCleanly
        self.remainingEngineTurns = max(0, remainingEngineTurns)
        self.remainingProcesses = max(0, remainingProcesses)
        self.didShutDownRuntime = didShutDownRuntime
    }

    /// One sentence for logs and the session's drain summary.
    public var summary: String {
        if settledCleanly { return "Native engine work settled before quitting." }
        var parts: [String] = []
        if remainingEngineTurns > 0 {
            parts.append("\(remainingEngineTurns) turn\(remainingEngineTurns == 1 ? "" : "s") stopped")
        }
        if remainingProcesses > 0 {
            parts.append("\(remainingProcesses) process\(remainingProcesses == 1 ? "" : "es") stopped")
        }
        let stopped = parts.joined(separator: " and ")
        return "Quit did not wait out the window: \(stopped) with it.\u{00A0} Their turns are recorded for the next start."
    }
}

/// Bounded graceful drain for the native engine composition.
///
/// Mirrors the server's graceful stop without interrupting anything itself:
/// the caller fences admission first (the runtime's terminal shutdown does),
/// this waits a bounded window for the in-flight counts to settle, and the
/// caller then runs the terminal shutdown which stops what remains.  Like
/// the server sequence it ends early when work settles and skips waiting
/// when idle.
public enum MacNativeGracefulDrain {
    public static func drain(
        deadlineMs: Double = MacNativeComposition.drainDeadlineMs,
        pollMs: Double = MacNativeComposition.drainPollMs,
        readSnapshot: @Sendable () async -> MacNativeBusySnapshot,
        sleepNanoseconds: @Sendable (UInt64) async -> Void = { nanoseconds in
            try? await Task.sleep(nanoseconds: nanoseconds)
        },
        nowMs: @Sendable () -> Double = { Date().timeIntervalSince1970 * 1_000 }
    ) async -> MacNativeDrainResult {
        let clampedPollMs = max(1, pollMs)
        let deadline = nowMs() + max(0, deadlineMs)
        var snapshot = await readSnapshot()
        // The first check is immediate, because settled work needs no wait.
        while snapshot.isBusy, nowMs() < deadline {
            let waitMs = min(clampedPollMs, max(0, deadline - nowMs()))
            guard waitMs > 0 else { break }
            await sleepNanoseconds(UInt64(waitMs * 1_000_000))
            snapshot = await readSnapshot()
        }
        return MacNativeDrainResult(
            settledCleanly: !snapshot.isBusy,
            remainingEngineTurns: snapshot.engineTurns,
            remainingProcesses: snapshot.supervisedProcesses
        )
    }
}

/// Carries the listener-built native runtime out of the backend's first-start
/// closure so the session can drain it at quit time.
///
/// The store and database are still created lazily on first start: the box
/// stays empty until then, and an empty box honestly reads as nothing to
/// drain.  Lock-guarded and unchecked-Sendable so the `@Sendable` backend
/// closure can store from whatever executor builds the server.
final class MacNativeRuntimeBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: NativeMacCompanionRuntime?

    func store(_ runtime: NativeMacCompanionRuntime) {
        lock.lock()
        defer { lock.unlock() }
        stored = runtime
    }

    var runtime: NativeMacCompanionRuntime? {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
}
