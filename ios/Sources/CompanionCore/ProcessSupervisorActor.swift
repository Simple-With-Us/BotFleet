import Foundation
#if os(macOS)
import Darwin
#endif

/// Configuration for `ProcessSupervisorActor` governing line buffer ceilings and termination grace periods.
public struct ProcessSupervisorConfig: Equatable, Sendable {
    /// Maximum UTF-8 byte length for a single newline-delimited stdout frame before overflow protection triggers.
    public let maxLineBytes: Int
    /// Grace window between `SIGTERM` and `SIGKILL` during process-group cancellation.
    public let sigtermGraceSeconds: Double
    /// Poll interval in milliseconds while waiting for process group and descendants to exit.
    public let pollIntervalMilliseconds: UInt64

    public init(
        maxLineBytes: Int = 16 * 1024 * 1024,
        sigtermGraceSeconds: Double = 0.5,
        pollIntervalMilliseconds: UInt64 = 10
    ) {
        self.maxLineBytes = max(64 * 1024, maxLineBytes)
        self.sigtermGraceSeconds = max(0.02, sigtermGraceSeconds)
        self.pollIntervalMilliseconds = max(2, pollIntervalMilliseconds)
    }

    public static let production = ProcessSupervisorConfig(
        maxLineBytes: 16 * 1024 * 1024,
        sigtermGraceSeconds: 2.0,
        pollIntervalMilliseconds: 15
    )

    public static let testing = ProcessSupervisorConfig(
        maxLineBytes: 16 * 1024 * 1024,
        sigtermGraceSeconds: 0.15,
        pollIntervalMilliseconds: 5
    )
}

/// Thread-safe state box for an individual supervised child process.
private final class SupervisedProcessState: @unchecked Sendable {
    let pid: Int32
    let pgid: Int32
    private let lock = NSLock()

    private var stdinWriteFd: Int32
    private var stdoutReadFd: Int32
    private var stderrReadFd: Int32
    private var knownDescendants: Set<Int32> = []
    private var exitReason: ProcessExitReason?
    private var isCancelled: Bool = false
    private var stdoutFinished: Bool = false
    private var stderrFinished: Bool = false
    private var exitWaiters: [CheckedContinuation<ProcessExitReason, Never>] = []
    private var stdoutDrainWaiters: [CheckedContinuation<Void, Never>] = []

    init(pid: Int32, pgid: Int32, stdinWriteFd: Int32, stdoutReadFd: Int32, stderrReadFd: Int32) {
        self.pid = pid
        self.pgid = pgid
        self.stdinWriteFd = stdinWriteFd
        self.stdoutReadFd = stdoutReadFd
        self.stderrReadFd = stderrReadFd
    }

    func recordDescendants(_ pids: Set<Int32>) -> Set<Int32> {
        lock.lock()
        defer { lock.unlock() }
        knownDescendants.formUnion(pids)
        return knownDescendants
    }

    func currentKnownDescendants() -> Set<Int32> {
        lock.lock()
        defer { lock.unlock() }
        return knownDescendants
    }

    func markCancelled() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let wasCancelled = isCancelled
        isCancelled = true
        return !wasCancelled
    }

    var cancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return isCancelled
    }

    func currentExitReason() -> ProcessExitReason? {
        lock.lock()
        defer { lock.unlock() }
        return exitReason
    }

    func setExitReason(_ reason: ProcessExitReason) {
        var waiters: [CheckedContinuation<ProcessExitReason, Never>] = []
        lock.lock()
        if exitReason == nil {
            exitReason = reason
            waiters = exitWaiters
            exitWaiters.removeAll()
        }
        lock.unlock()
        for waiter in waiters {
            waiter.resume(returning: reason)
        }
    }

    func waitForExit() async -> ProcessExitReason {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let reason = exitReason {
                lock.unlock()
                continuation.resume(returning: reason)
            } else {
                exitWaiters.append(continuation)
                lock.unlock()
            }
        }
    }

    func markStdoutFinished() {
        var waiters: [CheckedContinuation<Void, Never>] = []
        lock.lock()
        stdoutFinished = true
        if stderrFinished {
            waiters = stdoutDrainWaiters
            stdoutDrainWaiters.removeAll()
        }
        lock.unlock()
        for waiter in waiters {
            waiter.resume()
        }
    }

    func markStderrFinished() {
        var waiters: [CheckedContinuation<Void, Never>] = []
        lock.lock()
        stderrFinished = true
        if stdoutFinished {
            waiters = stdoutDrainWaiters
            stdoutDrainWaiters.removeAll()
        }
        lock.unlock()
        for waiter in waiters {
            waiter.resume()
        }
    }

    func waitForPipesToDrain(timeoutSeconds: Double = 0.25) async {
        lock.lock()
        let done = stdoutFinished && stderrFinished
        lock.unlock()
        if done { return }

        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                await withCheckedContinuation { continuation in
                    self.lock.lock()
                    if self.stdoutFinished && self.stderrFinished {
                        self.lock.unlock()
                        continuation.resume()
                    } else {
                        self.stdoutDrainWaiters.append(continuation)
                        self.lock.unlock()
                    }
                }
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                self.closeStdoutRead()
                self.closeStderrRead()
            }
            _ = await group.next()
            group.cancelAll()
        }
    }

    func writeStdin(_ data: Data) throws {
        lock.lock()
        let fd = stdinWriteFd
        lock.unlock()
        guard fd >= 0 else {
            throw EngineDriverError.stdinWriteFailed("stdin is already closed")
        }
        try data.withUnsafeBytes { rawBuffer in
            guard let base = rawBuffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            var totalWritten = 0
            while totalWritten < rawBuffer.count {
                let n = Darwin.write(fd, base.advanced(by: totalWritten), rawBuffer.count - totalWritten)
                if n > 0 {
                    totalWritten += n
                } else if n < 0 && errno == EINTR {
                    continue
                } else {
                    throw EngineDriverError.stdinWriteFailed("write() failed with errno \(errno)")
                }
            }
        }
    }

    func closeStdin() {
        lock.lock()
        let fd = stdinWriteFd
        stdinWriteFd = -1
        lock.unlock()
        if fd >= 0 {
            Darwin.close(fd)
        }
    }

    func closeStdoutRead() {
        lock.lock()
        let fd = stdoutReadFd
        stdoutReadFd = -1
        lock.unlock()
        if fd >= 0 {
            Darwin.close(fd)
        }
    }

    func closeStderrRead() {
        lock.lock()
        let fd = stderrReadFd
        stderrReadFd = -1
        lock.unlock()
        if fd >= 0 {
            Darwin.close(fd)
        }
    }
}

/// Actor supervising child CLI processes with isolated process groups (`POSIX_SPAWN_SETPGROUP`),
/// concurrent non-blocking stdout/stderr pipe draining, descendant tree walking via `sysctl`
/// (`KERN_PROC_ALL`), and bounded `SIGTERM` -> `SIGKILL` teardown.
public actor ProcessSupervisorActor: EngineProcessLauncher {
    public typealias ProtocolTeeHandler = @Sendable (NativeProtocolRecord) -> Void

    public let config: ProcessSupervisorConfig
    private let protocolTee: ProtocolTeeHandler?
    private var activeProcesses: [Int32: SupervisedProcessState] = [:]
    private var pidsByThread: [String: Int32] = [:]

    public init(
        config: ProcessSupervisorConfig = .production,
        protocolTee: ProtocolTeeHandler? = nil
    ) {
        self.config = config
        self.protocolTee = protocolTee
    }

    public func activeProcessCount() -> Int {
        activeProcesses.count
    }

    public func activePID(forThread threadId: String) -> Int32? {
        pidsByThread[threadId]
    }

    // MARK: - EngineProcessLauncher Conformance

    public func launch(
        spec: EngineSpawnSpec,
        threadId: String,
        engineId: String
    ) async throws -> EngineProcessSession {
        #if os(macOS)
        let executablePath = Self.resolveExecutablePath(spec.executable, environment: spec.environment)
        guard let resolvedPath = executablePath else {
            throw EngineDriverError.spawnFailed("Executable '\(spec.executable)' not found")
        }

        var stdinPipe: [Int32] = [-1, -1]
        var stdoutPipe: [Int32] = [-1, -1]
        var stderrPipe: [Int32] = [-1, -1]

        guard pipe(&stdinPipe) == 0 else {
            throw EngineDriverError.spawnFailed("Failed to create stdin pipe (errno \(errno))")
        }
        guard pipe(&stdoutPipe) == 0 else {
            Darwin.close(stdinPipe[0]); Darwin.close(stdinPipe[1])
            throw EngineDriverError.spawnFailed("Failed to create stdout pipe (errno \(errno))")
        }
        guard pipe(&stderrPipe) == 0 else {
            Darwin.close(stdinPipe[0]); Darwin.close(stdinPipe[1])
            Darwin.close(stdoutPipe[0]); Darwin.close(stdoutPipe[1])
            throw EngineDriverError.spawnFailed("Failed to create stderr pipe (errno \(errno))")
        }

        // Prevent SIGPIPE on parent writes and mark all 6 pipe fds FD_CLOEXEC so concurrent
        // spawns never leak pipe write-ends into sibling children.
        for fd in [stdinPipe[0], stdinPipe[1], stdoutPipe[0], stdoutPipe[1], stderrPipe[0], stderrPipe[1]] {
            _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        }
        _ = fcntl(stdinPipe[1], F_SETNOSIGPIPE, 1)

        var fileActions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&fileActions)
        defer { posix_spawn_file_actions_destroy(&fileActions) }

        posix_spawn_file_actions_adddup2(&fileActions, stdinPipe[0], STDIN_FILENO)
        posix_spawn_file_actions_adddup2(&fileActions, stdoutPipe[1], STDOUT_FILENO)
        posix_spawn_file_actions_adddup2(&fileActions, stderrPipe[1], STDERR_FILENO)

        for fd in [stdinPipe[0], stdinPipe[1], stdoutPipe[0], stdoutPipe[1], stderrPipe[0], stderrPipe[1]] {
            posix_spawn_file_actions_addclose(&fileActions, fd)
        }

        if let cwd = spec.workingDirectory, !cwd.isEmpty {
            posix_spawn_file_actions_addchdir_np(&fileActions, cwd)
        }

        var spawnAttr: posix_spawnattr_t?
        posix_spawnattr_init(&spawnAttr)
        defer { posix_spawnattr_destroy(&spawnAttr) }

        // Place child in its own isolated process group (pgid = child pid).
        posix_spawnattr_setflags(&spawnAttr, Int16(POSIX_SPAWN_SETPGROUP))
        posix_spawnattr_setpgroup(&spawnAttr, 0)

        let argvStrings = [resolvedPath] + spec.arguments
        var mergedEnv = ProcessInfo.processInfo.environment
        for (k, v) in spec.environment {
            mergedEnv[k] = v
        }
        // `spec.environment` is an overlay, so a key the runner dropped from it is still present in the
        // parent environment and would reach the child.  The keys the runner marked as unset are removed
        // from the merged result so the child really does not inherit them.
        for key in spec.unsetEnvironmentKeys {
            mergedEnv.removeValue(forKey: key)
        }
        let envStrings = mergedEnv.map { "\($0.key)=\($0.value)" }

        let cArgs = argvStrings.map { strdup($0) } + [nil]
        defer {
            for ptr in cArgs where ptr != nil { free(ptr) }
        }
        let cEnv = envStrings.map { strdup($0) } + [nil]
        defer {
            for ptr in cEnv where ptr != nil { free(ptr) }
        }

        var childPid: pid_t = 0
        let spawnStatus = cArgs.withUnsafeBufferPointer { argsBuf in
            cEnv.withUnsafeBufferPointer { envBuf in
                posix_spawn(
                    &childPid,
                    resolvedPath,
                    &fileActions,
                    &spawnAttr,
                    argsBuf.baseAddress,
                    envBuf.baseAddress
                )
            }
        }

        // Always close child-side pipe ends in the parent immediately.
        Darwin.close(stdinPipe[0])
        Darwin.close(stdoutPipe[1])
        Darwin.close(stderrPipe[1])

        guard spawnStatus == 0, childPid > 0 else {
            Darwin.close(stdinPipe[1])
            Darwin.close(stdoutPipe[0])
            Darwin.close(stderrPipe[0])
            throw EngineDriverError.spawnFailed("posix_spawn failed with status \(spawnStatus)")
        }

        let state = SupervisedProcessState(
            pid: childPid,
            pgid: childPid,
            stdinWriteFd: stdinPipe[1],
            stdoutReadFd: stdoutPipe[0],
            stderrReadFd: stderrPipe[0]
        )
        activeProcesses[childPid] = state
        pidsByThread[threadId] = childPid

        let (stdoutLines, stdoutContinuation) = AsyncStream<String>.makeStream()
        let (stderrChunks, stderrContinuation) = AsyncStream<String>.makeStream()

        let maxLineBytes = config.maxLineBytes
        let tee = protocolTee
        let stdoutFd = stdoutPipe[0]
        let stderrFd = stderrPipe[0]

        // Concurrent non-blocking / dedicated-queue stdout line reader.
        // Uses incremental newline scanning from the previous scan offset so a 5 MB single line
        // is processed in O(N) time without truncation or quadratic rescanning.
        DispatchQueue.global(qos: .userInitiated).async {
            let chunkSize = 65_536
            let chunkBuf = UnsafeMutablePointer<UInt8>.allocate(capacity: chunkSize)
            defer { chunkBuf.deallocate() }

            var accumulator = Data()
            accumulator.reserveCapacity(65_536)
            var scanOffset = 0

            while true {
                let bytesRead = Darwin.read(stdoutFd, chunkBuf, chunkSize)
                if bytesRead > 0 {
                    accumulator.append(chunkBuf, count: bytesRead)

                    // Extract all complete newline-delimited lines from the newly appended region.
                    while scanOffset < accumulator.count {
                        let searchRange = scanOffset..<accumulator.count
                        if let nlIndex = accumulator[searchRange].firstIndex(of: 0x0A) {
                            var lineEnd = nlIndex
                            if lineEnd > accumulator.startIndex && accumulator[lineEnd - 1] == 0x0D {
                                lineEnd -= 1
                            }
                            let lineData = accumulator.subdata(in: accumulator.startIndex..<lineEnd)
                            let line = String(decoding: lineData, as: UTF8.self)
                            if let tee {
                                tee(NativeProtocolRecord(engineId: engineId, threadId: threadId, direction: .inbound, line: line))
                            }
                            stdoutContinuation.yield(line)
                            accumulator.removeSubrange(accumulator.startIndex...nlIndex)
                            scanOffset = 0
                        } else {
                            scanOffset = accumulator.count
                            break
                        }
                    }

                    if accumulator.count > maxLineBytes {
                        // Guard against unbounded single-line allocation past ceiling.
                        let overflowLine = String(decoding: accumulator, as: UTF8.self)
                        stdoutContinuation.yield(overflowLine)
                        accumulator.removeAll(keepingCapacity: false)
                        scanOffset = 0
                    }
                } else if bytesRead == 0 {
                    break
                } else {
                    if errno == EINTR { continue }
                    break
                }
            }

            if !accumulator.isEmpty {
                if accumulator.last == 0x0D {
                    accumulator.removeLast()
                }
                let trailing = String(decoding: accumulator, as: UTF8.self)
                if !trailing.isEmpty {
                    if let tee {
                        tee(NativeProtocolRecord(engineId: engineId, threadId: threadId, direction: .inbound, line: trailing))
                    }
                    stdoutContinuation.yield(trailing)
                }
            }

            state.closeStdoutRead()
            stdoutContinuation.finish()
            state.markStdoutFinished()
        }

        // Concurrent dedicated-queue stderr reader draining in parallel with stdout so a 1 MB
        // stderr burst concurrent with a 5 MB stdout line never blocks or deadlocks the child.
        DispatchQueue.global(qos: .userInitiated).async {
            let chunkSize = 65_536
            let chunkBuf = UnsafeMutablePointer<UInt8>.allocate(capacity: chunkSize)
            defer { chunkBuf.deallocate() }

            while true {
                let bytesRead = Darwin.read(stderrFd, chunkBuf, chunkSize)
                if bytesRead > 0 {
                    let chunk = String(decoding: UnsafeBufferPointer(start: chunkBuf, count: bytesRead), as: UTF8.self)
                    stderrContinuation.yield(chunk)
                } else if bytesRead == 0 {
                    break
                } else {
                    if errno == EINTR { continue }
                    break
                }
            }

            state.closeStderrRead()
            stderrContinuation.finish()
            state.markStderrFinished()
        }

        // Monitor process lifecycle and reap on exit.
        let pollMs = config.pollIntervalMilliseconds
        Task.detached(priority: .userInitiated) { [weak self] in
            while true {
                let currentTree = Self.discoverDescendantAndGroupPIDs(rootPid: childPid, pgid: childPid)
                _ = state.recordDescendants(currentTree)

                var status: Int32 = 0
                let w = waitpid(childPid, &status, WNOHANG)
                if w == childPid {
                    state.closeStdin()
                    let reason = Self.decodeWaitStatus(status, wasCancelled: state.cancelled)
                    // If the process died via signal or cancellation, ensure any lingering
                    // descendants holding pipes open are terminated so stdout/stderr hit EOF immediately.
                    switch reason {
                    case .signaled, .cancelled:
                        Self.terminateGroupAndDescendantsImmediately(
                            pgid: childPid,
                            knownDescendants: state.recordDescendants(
                                Self.discoverDescendantAndGroupPIDs(rootPid: childPid, pgid: childPid)
                            )
                        )
                    case .exited, .spawnFailed:
                        break
                    }
                    await state.waitForPipesToDrain()
                    state.setExitReason(reason)
                    await self?.removeProcess(pid: childPid, threadId: threadId)
                    return
                } else if w == -1 && errno == ECHILD {
                    state.closeStdin()
                    await state.waitForPipesToDrain()
                    let reason: ProcessExitReason = state.cancelled ? .cancelled : .exited(code: 0)
                    state.setExitReason(reason)
                    await self?.removeProcess(pid: childPid, threadId: threadId)
                    return
                }

                try? await Task.sleep(nanoseconds: pollMs * 1_000_000)
            }
        }

        return EngineProcessSession(
            pid: childPid,
            stdoutLines: stdoutLines,
            stderrChunks: stderrChunks,
            writeStdinLine: { line in
                if let tee {
                    tee(NativeProtocolRecord(engineId: engineId, threadId: threadId, direction: .outbound, line: line))
                }
                let payload = line.hasSuffix("\n") ? line : (line + "\n")
                try state.writeStdin(Data(payload.utf8))
            },
            closeStdin: {
                state.closeStdin()
            },
            cancel: { [weak self] in
                await self?.cancel(pid: childPid)
            },
            waitForExit: {
                await state.waitForExit()
            }
        )
        #else
        throw EngineDriverError.spawnFailed("ProcessSupervisorActor requires macOS")
        #endif
    }

    // MARK: - Process-Group Cancellation & Descendant Reaping

    /// Cancels a running child process by `threadId`.
    public func cancel(threadId: String) async {
        guard let pid = pidsByThread[threadId] else { return }
        await cancel(pid: pid)
    }

    /// Cancels a running child process by `pid`:
    /// 1. Snapshots all process-group members and transitive `KERN_PROC_ALL` descendants.
    /// 2. Sends `SIGTERM` to `-pgid` and every discovered descendant PID.
    /// 3. Waits up to `sigtermGraceSeconds` for the leader and all descendants to exit.
    /// 4. Escalates to `SIGKILL` on `-pgid` and all surviving descendants, closing stdio and reaping `pid`.
    public func cancel(pid: Int32) async {
        #if os(macOS)
        guard let state = activeProcesses[pid] else {
            // Even if the leader already exited, sweep any surviving group or descendant processes.
            let survivors = Self.discoverDescendantAndGroupPIDs(rootPid: pid, pgid: pid)
            if !survivors.isEmpty {
                Self.terminateGroupAndDescendantsImmediately(pgid: pid, knownDescendants: survivors)
            }
            return
        }

        _ = state.markCancelled()
        state.closeStdin()

        let initialDescendants = state.recordDescendants(
            Self.discoverDescendantAndGroupPIDs(rootPid: pid, pgid: state.pgid)
        )

        // Step 1: Send SIGTERM to process group (-pgid) and all discovered descendants.
        _ = Darwin.kill(-state.pgid, SIGTERM)
        _ = Darwin.kill(pid, SIGTERM)
        for descPid in initialDescendants where descPid > 1 {
            _ = Darwin.kill(descPid, SIGTERM)
        }

        let graceNanos = UInt64(config.sigtermGraceSeconds * 1_000_000_000)
        let pollNanos = config.pollIntervalMilliseconds * 1_000_000
        let deadline = DispatchTime.now().uptimeNanoseconds + graceNanos

        while DispatchTime.now().uptimeNanoseconds < deadline {
            let current = state.recordDescendants(
                Self.discoverDescendantAndGroupPIDs(rootPid: pid, pgid: state.pgid)
            )
            // Signal any newly forked child that appeared during teardown.
            for descPid in current where descPid > 1 && !initialDescendants.contains(descPid) {
                _ = Darwin.kill(descPid, SIGTERM)
            }

            let leaderExited = state.currentExitReason() != nil || !Self.isProcessAlive(pid)
            let aliveDescendants = current.filter { Self.isProcessAlive($0) }
            if leaderExited && aliveDescendants.isEmpty {
                break
            }
            try? await Task.sleep(nanoseconds: pollNanos)
        }

        // Step 2: Escalate to SIGKILL for the process group and any surviving descendants.
        let allTracked = state.recordDescendants(
            Self.discoverDescendantAndGroupPIDs(rootPid: pid, pgid: state.pgid)
        )
        Self.terminateGroupAndDescendantsImmediately(pgid: state.pgid, knownDescendants: allTracked)

        // Close read pipes so blocked readers unblock immediately if an external process held a descriptor.
        state.closeStdoutRead()
        state.closeStderrRead()

        _ = await state.waitForExit()
        #endif
    }

    /// Runs a single turn command under supervision and maps lines or unexpected process signals into `TurnEvent`s.
    /// If the child dies from an uncaught signal (such as `SIGKILL` mid-stream), immediately emits
    /// `.error(code: "process_signal", message: ...)` within `< 2 seconds`.
    public func runSupervisedTurnStream(
        spec: EngineSpawnSpec,
        threadId: String,
        engineId: String = "supervised",
        lineParser: @escaping @Sendable (String) -> [TurnEvent]
    ) async throws -> AsyncStream<TurnEvent> {
        let session = try await launch(spec: spec, threadId: threadId, engineId: engineId)
        let (stream, continuation) = AsyncStream<TurnEvent>.makeStream()

        Task {
            var sawCompleted = false
            for await line in session.stdoutLines {
                let events = lineParser(line)
                for event in events {
                    if case .completed = event {
                        sawCompleted = true
                    }
                    continuation.yield(event)
                }
            }

            let exitReason = await session.waitForExit()
            if !sawCompleted {
                switch exitReason {
                case .signaled(let sig):
                    continuation.yield(.error(code: "process_signal", message: "Process \(session.pid) terminated by signal \(sig)"))
                case .exited(let code) where code != 0:
                    continuation.yield(.error(code: "process_exit", message: "Process \(session.pid) exited with code \(code)"))
                case .cancelled:
                    continuation.yield(.error(code: "cancelled", message: "Process \(session.pid) was cancelled"))
                case .spawnFailed(let msg):
                    continuation.yield(.error(code: "spawn_error", message: msg))
                case .exited:
                    break
                }
            }
            continuation.finish()
        }

        return stream
    }

    private func removeProcess(pid: Int32, threadId: String) {
        activeProcesses.removeValue(forKey: pid)
        if pidsByThread[threadId] == pid {
            pidsByThread.removeValue(forKey: threadId)
        }
    }

    // MARK: - Darwin Process Tree Inspection & Signal Helpers

    #if os(macOS)
    /// Walks the kernel process table via `sysctl` (`CTL_KERN`, `KERN_PROC`, `KERN_PROC_ALL`)
    /// to find all processes belonging to `pgid` AND all transitive child/descendant PIDs of `rootPid`
    /// (including processes that called `setsid()` to escape the process group).
    public static func discoverDescendantAndGroupPIDs(rootPid: Int32, pgid: Int32) -> Set<Int32> {
        guard rootPid > 1 else { return [] }
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
        var size: Int = 0
        guard sysctl(&mib, 4, nil, &size, nil, 0) == 0, size > 0 else {
            return []
        }

        let count = (size + MemoryLayout<kinfo_proc>.stride - 1) / MemoryLayout<kinfo_proc>.stride + 32
        var procs = Array(repeating: kinfo_proc(), count: count)
        var actualSize = count * MemoryLayout<kinfo_proc>.stride
        guard sysctl(&mib, 4, &procs, &actualSize, nil, 0) == 0 else {
            return []
        }

        let actualCount = actualSize / MemoryLayout<kinfo_proc>.stride
        var childrenByParent: [Int32: [Int32]] = [:]
        var groupMembers: Set<Int32> = []

        for i in 0..<actualCount {
            let proc = procs[i]
            // Ignore zombies that have already terminated.
            if Int32(proc.kp_proc.p_stat) == Int32(SZOMB) {
                continue
            }
            let pid = proc.kp_proc.p_pid
            let ppid = proc.kp_eproc.e_ppid
            let procPgid = proc.kp_eproc.e_pgid
            guard pid > 1 else { continue }

            childrenByParent[ppid, default: []].append(pid)
            if pgid > 1 && procPgid == pgid && pid != rootPid {
                groupMembers.insert(pid)
            }
        }

        var result = groupMembers
        var queue: [Int32] = [rootPid] + Array(groupMembers)
        var visited: Set<Int32> = [rootPid]

        while let current = queue.first {
            queue.removeFirst()
            if let children = childrenByParent[current] {
                for child in children where !visited.contains(child) {
                    visited.insert(child)
                    result.insert(child)
                    queue.append(child)
                }
            }
        }

        return result
    }

    /// Checks whether a process `pid` is currently alive and not a zombie.
    public static func isProcessAlive(_ pid: Int32) -> Bool {
        guard pid > 1 else { return false }
        if Darwin.kill(pid, 0) != 0 {
            return errno == EPERM
        }
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        if sysctl(&mib, 4, &info, &size, nil, 0) == 0 && size > 0 {
            return Int32(info.kp_proc.p_stat) != Int32(SZOMB)
        }
        return false
    }

    private static func terminateGroupAndDescendantsImmediately(pgid: Int32, knownDescendants: Set<Int32>) {
        if pgid > 1 {
            _ = Darwin.kill(-pgid, SIGKILL)
            _ = Darwin.kill(pgid, SIGKILL)
        }
        let fresh = discoverDescendantAndGroupPIDs(rootPid: pgid, pgid: pgid)
        for pid in knownDescendants.union(fresh) where pid > 1 {
            _ = Darwin.kill(pid, SIGKILL)
        }
    }

    private static func decodeWaitStatus(_ status: Int32, wasCancelled: Bool) -> ProcessExitReason {
        if wasCancelled {
            return .cancelled
        }
        let low7 = status & 0x7F
        if low7 == 0 {
            let exitCode = (status >> 8) & 0xFF
            return .exited(code: exitCode)
        } else if low7 != 0x7F {
            return .signaled(signal: low7)
        }
        return .exited(code: -1)
    }

    private static func resolveExecutablePath(_ executable: String, environment: [String: String]) -> String? {
        if executable.contains("/") {
            return FileManager.default.isExecutableFile(atPath: executable) ? executable : nil
        }
        let pathValue = environment["PATH"]
            ?? ProcessInfo.processInfo.environment["PATH"]
            ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        for dir in pathValue.split(separator: ":") {
            let candidate = String(dir) + "/" + executable
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }
    #endif
}
