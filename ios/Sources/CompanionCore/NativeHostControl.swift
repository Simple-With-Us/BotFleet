#if os(macOS)
import Foundation
import Darwin

/// How a non-blocking connect result is read.  A pending connection and a full
/// backlog both mean the listener is still live, so they are completed and
/// verified before the channel is ever called unreachable.
public enum NativeHostChannelProbe {
    /// True when the connect result still allows a live listener.
    public static func isReachable(connectResult: Int32, connectError: Int32) -> Bool {
        if connectResult == 0 { return true }
        return connectError == EINPROGRESS || connectError == EAGAIN
    }
}

/// The foreground start sequence.  The announcement belongs to the sequence, so
/// the executable holds no announcement of its own that could be moved ahead of
/// the verification: the host is announced only after the control channel has
/// verified it, and a failed verification writes nothing at all.
public enum NativeHostStartSequence {
    /// The only announcement the native host makes, and only for a verified start.
    public static let runningMessage = "Native host running with service credential access unavailable.\n"

    /// Verifies the start and announces it only when the verification succeeded.
    public static func run(verify: () async throws -> Void, write: (String) -> Void) async throws {
        try await verify()
        write(runningMessage)
    }
}

/// A private administrative channel; the production peer check always uses kernel credentials.
public final class NativeHostControlServer: @unchecked Sendable {
    public static let socketName = "control.sock"
    private let host: NativeHeadlessHost
    private let path: String
    private let identity: stat
    private let source: DispatchSourceRead
    private let peerUID: @Sendable (Int32) -> uid_t?
    private let onStopped: @Sendable () -> Void
    private let lock = NSLock()
    private var connections = 0
    private var closed = false
    private var completed = false
    private let requestTimeout: TimeInterval
    private static let maximumConnections = 4
    private static let maximumRequestBytes = 32

    public convenience init(host: NativeHeadlessHost, onStopped: @escaping @Sendable () -> Void = {}) throws {
        try self.init(host: host, peerUID: { Self.kernelPeerUID($0) }, requestTimeout: 2, onStopped: onStopped)
    }

    // Tests may substitute observations, but no executable flag or environment value bypasses authentication.
    init(host: NativeHeadlessHost, peerUID: @escaping @Sendable (Int32) -> uid_t?,
         requestTimeout: TimeInterval = 2, onStopped: @escaping @Sendable () -> Void = {}) throws {
        self.host = host
        self.peerUID = peerUID
        self.onStopped = onStopped
        self.requestTimeout = requestTimeout
        path = host.paths.root.appendingPathComponent(Self.socketName).path
        var root = stat()
        guard lstat(host.paths.root.path, &root) == 0, root.st_mode & S_IFMT == S_IFDIR,
              root.st_uid == getuid(), root.st_mode & 0o077 == 0 else { throw NativeHostControlError.unsafeSocket }
        var address = try Self.address(path)
        try Self.removeStaleSocket(path, address: &address)
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw NativeHostControlError.socketUnavailable }
        var bound: stat?
        do {
            guard fcntl(fd, F_SETFD, FD_CLOEXEC) == 0, fcntl(fd, F_SETFL, O_NONBLOCK) == 0 else {
                throw NativeHostControlError.socketUnavailable
            }
            let result = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
            }
            guard result == 0 else { throw NativeHostControlError.socketUnavailable }
            var info = stat()
            guard lstat(path, &info) == 0, info.st_mode & S_IFMT == S_IFSOCK,
                  info.st_uid == getuid() else { throw NativeHostControlError.unsafeSocket }
            bound = info
            guard chmod(path, 0o600) == 0, Darwin.listen(fd, 4) == 0 else { throw NativeHostControlError.socketUnavailable }
            identity = info
            source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: DispatchQueue(label: "app.botfleet.native-control"))
            source.setCancelHandler { Darwin.close(fd) }
            source.setEventHandler { [weak self] in self?.acceptConnections(fd) }
            source.resume()
        } catch {
            Darwin.close(fd)
            if let bound { Self.unlinkIfMatching(path, identity: bound) }
            throw error
        }
    }

    public func close() {
        lock.lock()
        let shouldClose = !closed
        closed = true
        lock.unlock()
        if shouldClose {
            source.cancel()
            Self.unlinkIfMatching(path, identity: identity)
        }
    }

    deinit { close() }

    /// The start path is checked, never assumed.
    ///
    /// A caller may only report that the host came up after this channel has
    /// published a real, validated running state and has answered a connection.
    /// The published payload is the one the `status` verb serves, so the two can
    /// never disagree, and the peer fence is untouched: the probe connects and
    /// disconnects without ever sending a privileged request.
    public func verifyStart() async throws -> NativeHeadlessHostState {
        let state = await host.state
        let payload = Self.statusPayload(state)
        guard state == .running,
              payload.contains("\"state\":\"\(NativeHeadlessHostState.running.rawValue)\"") else {
            throw NativeHostControlError.startNotVerified(state: state.rawValue)
        }
        guard await channelAnswersOffExecutor(path: path) else {
            throw NativeHostControlError.controlChannelUnreachable
        }
        return state
    }

    /// The probe blocks on a poll while a pending connection completes, so it
    /// runs on a dispatch queue and never holds a cooperative executor thread.
    private func channelAnswersOffExecutor(path: String) async -> Bool {
        await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            DispatchQueue.global(qos: .utility).async {
                continuation.resume(returning: Self.channelAnswers(path: path))
            }
        }
    }

    /// A bare connection proves the listener is live.  No request is sent, so the
    /// root-only peer check stays exactly as strict as it is in production.
    ///
    /// A non-blocking connect can be pending or refused by a full backlog, and
    /// neither state means the listener is gone, so the result is read by errno
    /// and a pending connection is completed before it is believed.
    ///
    /// The connect outcome can be injected, so a fixture can reach the pending
    /// branch without depending on a kernel's backlog timing.
    ///
    /// The real connect always runs first, so the descriptor holds the kernel's
    /// own answer, and an injected outcome only selects which branch is taken.
    /// The completion is still read from the descriptor, so an injected errno
    /// can never report a connection the socket did not make.
    static func channelAnswers(path: String, connect: ((Int32) -> (result: Int32, connectError: Int32))? = nil) -> Bool {
        var address: sockaddr_un
        do { address = try Self.address(path) } catch { return false }
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { Darwin.close(fd) }
        // A non-blocking connect can never wait on a full backlog.
        _ = fcntl(fd, F_SETFL, O_NONBLOCK)
        var result: Int32 = 0
        var connectError: Int32 = 0
        result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                let status = Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                if status != 0 { connectError = errno }
                return status
            }
        }
        if let connect = connect {
            let outcome = connect(fd)
            if outcome.result == -1,
               NativeHostChannelProbe.isReachable(connectResult: outcome.result, connectError: outcome.connectError) {
                result = outcome.result
                connectError = outcome.connectError
            }
        }
        guard NativeHostChannelProbe.isReachable(connectResult: result, connectError: connectError) else { return false }
        if result == 0 { return true }
        // A pending connection is only a live channel once it completed cleanly.
        return Self.connectionCompleted(fd)
    }

    /// Waits for a pending connection and reads the socket error the kernel kept
    /// for it, so a pending connect is trusted only when it really connected.
    static func connectionCompleted(_ fd: Int32) -> Bool {
        let deadline = ProcessInfo.processInfo.systemUptime + 1
        guard Self.wait(fd, events: Int16(POLLOUT), deadline: deadline) else { return false }
        var socketError: Int32 = 0
        var length = socklen_t(MemoryLayout<Int32>.size)
        guard getsockopt(fd, SOL_SOCKET, SO_ERROR, &socketError, &length) == 0 else { return false }
        return socketError == 0
    }

    private func acceptConnections(_ listener: Int32) {
        // A bounded batch lets cancellation run even if clients keep connecting.
        for _ in 0..<16 {
            let fd = Darwin.accept(listener, nil, nil)
            guard fd >= 0 else { return }
            lock.lock()
            let admitted = !closed && connections < Self.maximumConnections
            if admitted { connections += 1 }
            lock.unlock()
            guard admitted else { Darwin.close(fd); continue }
            guard fcntl(fd, F_SETFD, FD_CLOEXEC) == 0, fcntl(fd, F_SETFL, O_NONBLOCK) == 0 else {
                finishConnection(fd); continue
            }
            var noSignal: Int32 = 1
            guard setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
                finishConnection(fd); continue
            }
            DispatchQueue.global(qos: .utility).async { [self] in
                guard peerUID(fd) == 0 else {
                    reply(fd, "{\"ok\":false,\"error\":\"denied\"}\n")
                    finishConnection(fd)
                    return
                }
                guard let verb = readVerb(fd) else {
                    reply(fd, "{\"ok\":false,\"error\":\"invalidRequest\"}\n")
                    finishConnection(fd)
                    return
                }
                Task { await self.perform(verb, fd: fd) }
            }
        }
    }

    private func perform(_ verb: String, fd: Int32) async {
        defer { finishConnection(fd) }
        if verb == "status" {
            let state = await host.state
            await replyOffExecutor(fd, Self.statusPayload(state) + "\n")
            return
        }
        do {
            try await host.shutdown(deliberateStop: true)
            // The acknowledgement follows checked database close, marker publication and lease release.
            await replyOffExecutor(fd, "{\"ok\":true,\"state\":\"stopped\"}\n")
            close()
            notifyStopped()
        } catch {
            // The refusal keeps the stable error code and names the reason that stopped it.
            let reason = NativeHostFailureReason.code(for: error)
            await replyOffExecutor(fd, "{\"ok\":false,\"error\":\"shutdownFailed\",\"reason\":\"\(reason)\"}\n")
        }
    }

    /// The exact payload the `status` verb serves, so a checked start and a status
    /// request can never disagree about the host's state.
    static func statusPayload(_ state: NativeHeadlessHostState) -> String {
        "{\"ok\":true,\"state\":\"\(state.rawValue)\"}"
    }

    private func replyOffExecutor(_ fd: Int32, _ text: String) async {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async { [self] in
                reply(fd, text)
                // perform() retains the descriptor until this bounded output attempt finishes.
                continuation.resume()
            }
        }
    }

    private func notifyStopped() {
        lock.lock()
        let notify = !completed
        completed = true
        lock.unlock()
        if notify { onStopped() }
    }

    private func finishConnection(_ fd: Int32) {
        Darwin.close(fd)
        lock.lock(); connections -= 1; lock.unlock()
    }

    private func readVerb(_ fd: Int32) -> String? {
        let deadline = ProcessInfo.processInfo.systemUptime + requestTimeout
        var bytes: [UInt8] = []
        while bytes.count < Self.maximumRequestBytes {
            guard Self.wait(fd, events: Int16(POLLIN), deadline: deadline) else { return nil }
            var buffer = [UInt8](repeating: 0, count: Self.maximumRequestBytes + 1 - bytes.count)
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 && (errno == EINTR || errno == EAGAIN) { continue }
            guard count > 0 else { return nil }
            bytes.append(contentsOf: buffer.prefix(count))
            if let newline = bytes.firstIndex(of: 10) {
                guard newline == bytes.count - 1 else { return nil }
                let verb = String(bytes: bytes.dropLast(), encoding: .utf8)
                return verb == "status" || verb == "stop" ? verb : nil
            }
        }
        return nil
    }

    private func reply(_ fd: Int32, _ text: String) {
        let deadline = ProcessInfo.processInfo.systemUptime + requestTimeout
        let bytes = Array(text.utf8)
        bytes.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                guard Self.wait(fd, events: Int16(POLLOUT), deadline: deadline) else { return }
                let count = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count < 0 && (errno == EINTR || errno == EAGAIN) { continue }
                guard count > 0 else { return }
                offset += count
            }
        }
    }

    private static func wait(_ fd: Int32, events: Int16, deadline: TimeInterval) -> Bool {
        while true {
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else { return false }
            var descriptor = pollfd(fd: fd, events: events, revents: 0)
            let result = Darwin.poll(&descriptor, 1, Int32(min(remaining * 1000 + 1, 2000)))
            if result < 0 && errno == EINTR { continue }
            return result > 0 && descriptor.revents & events != 0
        }
    }

    private static func kernelPeerUID(_ fd: Int32) -> uid_t? {
        var uid: uid_t = 0
        var gid: gid_t = 0
        return getpeereid(fd, &uid, &gid) == 0 ? uid : nil
    }

    private static func address(_ path: String) throws -> sockaddr_un {
        var address = sockaddr_un()
        let bytes = Array(path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw NativeHostControlError.unsafeSocket }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            for (index, byte) in bytes.enumerated() { buffer[index] = UInt8(bitPattern: byte) }
        }
        return address
    }

    private static func removeStaleSocket(_ path: String, address: inout sockaddr_un) throws {
        var info = stat()
        guard lstat(path, &info) == 0 else {
            if errno == ENOENT { return }
            throw NativeHostControlError.unsafeSocket
        }
        guard info.st_mode & S_IFMT == S_IFSOCK, info.st_uid == getuid(), info.st_nlink == 1,
              info.st_mode & 0o077 == 0 else { throw NativeHostControlError.unsafeSocket }
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw NativeHostControlError.socketUnavailable }
        defer { Darwin.close(fd) }
        guard fcntl(fd, F_SETFL, O_NONBLOCK) == 0 else { throw NativeHostControlError.socketUnavailable }
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard result < 0, errno == ECONNREFUSED else { throw NativeHostControlError.unsafeSocket }
        guard unlinkIfMatching(path, identity: info) else { throw NativeHostControlError.unsafeSocket }
    }

    @discardableResult
    private static func unlinkIfMatching(_ path: String, identity: stat) -> Bool {
        var listed = stat()
        guard lstat(path, &listed) == 0, listed.st_mode & S_IFMT == S_IFSOCK,
              listed.st_uid == getuid(), listed.st_dev == identity.st_dev, listed.st_ino == identity.st_ino else { return false }
        return unlink(path) == 0
    }
}
#endif
