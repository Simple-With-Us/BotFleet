#if os(macOS)
import Foundation
import Darwin

public enum NativeHostControlError: Error { case unsafeSocket, socketUnavailable }

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
            let state = await host.state.rawValue
            reply(fd, "{\"ok\":true,\"state\":\"\(state)\"}\n")
            return
        }
        do {
            try await host.shutdown(deliberateStop: true)
            // The acknowledgement follows checked database close, marker publication and lease release.
            reply(fd, "{\"ok\":true,\"state\":\"stopped\"}\n")
            close()
            notifyStopped()
        } catch {
            reply(fd, "{\"ok\":false,\"error\":\"shutdownFailed\"}\n")
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
