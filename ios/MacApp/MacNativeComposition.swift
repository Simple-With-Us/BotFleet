import Darwin
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
    /// How long quit waits for the terminal runtime shutdown to acknowledge
    /// after the settle window.  Quit replies and proceeds regardless: a hung
    /// quit is worse than a shutdown that finishes behind it.
    public static let shutdownAckTimeoutMs: Double = 5_000
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

    /// One sentence for logs and the session's drain summary.  Stopped work
    /// is only claimed after the terminal shutdown acknowledged: a shutdown
    /// that never answered leaves the work's fate to the next start, and the
    /// summary says that instead of claiming a stop that may not have run.
    public var summary: String {
        if settledCleanly { return "Native engine work settled before quitting." }
        if !didShutDownRuntime {
            return "Native shutdown did not answer before quitting.\u{00A0} Unfinished turns resume at the next start."
        }
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
        nowMs: @Sendable () -> Double = { Self.uptimeMilliseconds() }
    ) async -> MacNativeDrainResult {
        let clampedPollMs = max(1, pollMs)
        let totalMs = Self.clampedPositiveInterval(deadlineMs)
        let deadline = nowMs() + totalMs
        var snapshot = await readSnapshot()
        // The first check is immediate, because settled work needs no wait.
        while snapshot.isBusy, nowMs() < deadline {
            let remainingMs = deadline - nowMs()
            // A non-finite or non-positive remainder ends the wait instead of
            // sleeping: converting it to nanoseconds below would trap.
            guard remainingMs.isFinite, remainingMs > 0 else { break }
            let waitMs = min(clampedPollMs, remainingMs)
            guard waitMs.isFinite, waitMs > 0 else { break }
            await sleepNanoseconds(Self.nanoseconds(clampingMilliseconds: waitMs))
            snapshot = await readSnapshot()
        }
        return MacNativeDrainResult(
            settledCleanly: !snapshot.isBusy,
            remainingEngineTurns: snapshot.engineTurns,
            remainingProcesses: snapshot.supervisedProcesses
        )
    }

    /// Bounded wait for a flag the caller flips elsewhere (for example a
    /// detached terminal shutdown acknowledging).  Returns whether the flag
    /// was set before the deadline.  Never sleeps past the deadline and
    /// never converts a non-finite interval.
    public static func waitUntil(
        deadlineMs: Double,
        pollMs: Double = MacNativeComposition.drainPollMs,
        condition: @Sendable () async -> Bool,
        sleepNanoseconds: @Sendable (UInt64) async -> Void = { nanoseconds in
            try? await Task.sleep(nanoseconds: nanoseconds)
        },
        nowMs: @Sendable () -> Double = { Self.uptimeMilliseconds() }
    ) async -> Bool {
        let clampedPollMs = max(1, pollMs)
        let deadline = nowMs() + Self.clampedPositiveInterval(deadlineMs)
        if await condition() { return true }
        while nowMs() < deadline {
            let remainingMs = deadline - nowMs()
            guard remainingMs.isFinite, remainingMs > 0 else { break }
            let waitMs = min(clampedPollMs, remainingMs)
            guard waitMs.isFinite, waitMs > 0 else { break }
            await sleepNanoseconds(Self.nanoseconds(clampingMilliseconds: waitMs))
            if await condition() { return true }
        }
        return await condition()
    }

    /// Milliseconds on the monotonic uptime clock, so an NTP step or manual
    /// clock change mid-quit can neither stretch nor collapse the bounded
    /// window the way wall-clock time could.
    public static func uptimeMilliseconds() -> Double {
        Double(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1_000_000
    }

    /// A finite, non-negative nanosecond count for a millisecond interval.
    /// Non-finite or negative input sleeps nothing instead of trapping the
    /// `UInt64` conversion, and huge input saturates instead of wrapping.
    public static func nanoseconds(clampingMilliseconds ms: Double) -> UInt64 {
        guard ms.isFinite, ms > 0 else { return 0 }
        let nanos = ms * 1_000_000
        guard nanos.isFinite else { return UInt64.max }
        return UInt64(min(nanos, Double(UInt64.max)))
    }

    private static func clampedPositiveInterval(_ ms: Double) -> Double {
        guard ms.isFinite, ms > 0 else { return 0 }
        return ms
    }
}

/// Acknowledgement flag for the detached terminal shutdown.
///
/// The quit path must not await the shutdown directly: a cancelled engine
/// task that never exits would hang termination past its bounded window.
/// The shutdown runs detached, flips this flag when it answers, and quit
/// proceeds after a bounded acknowledgement wait regardless.
actor MacNativeShutdownAck {
    private(set) var isAcknowledged = false
    private(set) var didSucceed = false

    func acknowledge(success: Bool) {
        isAcknowledged = true
        didSucceed = success
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
