#if os(macOS)
import Foundation
import Darwin
import Testing
@testable import CompanionCore

@Suite("Native host private administrative control")
struct NativeHostControlTests {
    @Test("Automatic launch preserves a validated marker before any database or recovery writes")
    func automaticMarker() async throws {
        let fixture = try HostFixture(shortPath: true)
        defer { fixture.remove() }
        let paths = try NativeServicePaths(serviceData: fixture.root)
        try Data("{\"stopped\":true}\n".utf8).write(to: paths.stoppedMarker)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: paths.stoppedMarker.path)
        let before = try Data(contentsOf: paths.stoppedMarker)
        let lease = try NativeHostOwnerLease(paths: paths)
        await #expect(throws: NativeHeadlessHostError.ownerAlreadyRunning) {
            _ = try await NativeHeadlessHost.launch(serviceData: fixture.root, intent: .automatic)
        }
        lease.release()
        let result = try await NativeHeadlessHost.launch(serviceData: fixture.root, intent: .automatic)
        guard case .stoppedByOwner = result else { Issue.record("Automatic launch ignored Stop"); return }
        #expect(try Data(contentsOf: paths.stoppedMarker) == before)
        #expect(!FileManager.default.fileExists(atPath: fixture.database.path))
        #expect(!FileManager.default.fileExists(atPath: paths.home.path))
        let next = try await fixture.start()
        #expect(!FileManager.default.fileExists(atPath: paths.stoppedMarker.path))
        try await next.shutdown()
    }

    @Test("Malformed, public and linked markers fail closed before database creation")
    func unsafeMarkers() async throws {
        for kind in ["invalid", "public", "symlink", "fifo"] {
            let fixture = try HostFixture(shortPath: true)
            defer { fixture.remove() }
            let paths = try NativeServicePaths(serviceData: fixture.root)
            if kind == "symlink" {
                try FileManager.default.createSymbolicLink(at: paths.stoppedMarker, withDestinationURL: fixture.output)
            } else if kind == "fifo" {
                #expect(mkfifo(paths.stoppedMarker.path, 0o600) == 0)
            } else {
                try Data((kind == "invalid" ? "{\"stopped\":false}" : "{\"stopped\":true}\n").utf8).write(to: paths.stoppedMarker)
                try FileManager.default.setAttributes([.posixPermissions: kind == "public" ? 0o644 : 0o600], ofItemAtPath: paths.stoppedMarker.path)
            }
            await #expect(throws: NativeHeadlessHostError.unsafeServicePath) {
                _ = try await NativeHeadlessHost.launch(serviceData: fixture.root, intent: .automatic)
            }
            #expect(!FileManager.default.fileExists(atPath: fixture.database.path))
        }
    }

    @Test("Denied peers cannot inspect or stop the host")
    func deniedPeer() async throws {
        let fixture = try HostFixture(shortPath: true)
        defer { fixture.remove() }
        let host = try await fixture.start()
        let server = try NativeHostControlServer(host: host, peerUID: { _ in 501 })
        defer { server.close() }
        for verb in ["status\n", "stop\n"] {
            #expect(try await controlRequest(fixture, verb).contains("denied"))
        }
        #expect(await host.state == .running)
        try await host.shutdown()
    }

    @Test("Malformed and slow requests are bounded and status remains available")
    func boundedRequests() async throws {
        let fixture = try HostFixture(shortPath: true)
        defer { fixture.remove() }
        let host = try await fixture.start()
        let server = try NativeHostControlServer(host: host, peerUID: { _ in 0 }, requestTimeout: 0.4)
        defer { server.close() }
        for text in ["unknown\n", "stop /tmp/anything\n", "status\nstop\n", String(repeating: "x", count: 33), "sta"] {
            #expect(try await controlRequest(fixture, text).contains("invalidRequest"))
        }
        let idle = try (0..<4).map { _ in try controlConnect(fixture) }
        defer { idle.forEach { Darwin.close($0) } }
        #expect(try await controlRequest(fixture, "status\n").isEmpty)
        try await Task.sleep(nanoseconds: 450_000_000)
        #expect(try await controlRequest(fixture, "status\n").contains("running"))
        #expect(await host.state == .running)
        try await host.shutdown()
    }

    @Test("A checked stop drains an active production child and never replays its accepted wait")
    func checkedStopDrainsChild() async throws {
        let fixture = try HostFixture(shortPath: true)
        defer { fixture.remove() }
        let host = try await fixture.start(credentials: FixtureServiceCredentials(output: fixture.output, hang: true))
        try await host.registerBot(fixture.bot())
        let wait = try await host.registerWait(botId: "bot-a", prompt: "stop fixture", predicate: .botIdle)
        try await host.tick()
        try await controlEventually { FileManager.default.fileExists(atPath: fixture.pid.path) }
        let pid = try #require(Int32(String(contentsOf: fixture.pid, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)))
        let server = try NativeHostControlServer(host: host, peerUID: { _ in 0 })
        defer { server.close() }
        let response = try await controlRequest(fixture, "stop\n")
        #expect(response.contains("\"ok\":true"))
        #expect(await host.state == .stopped)
        #expect(kill(pid, 0) == -1 && errno == ESRCH)
        #expect(FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("stopped.marker").path))
        let next = try await fixture.start(credentials: FixtureServiceCredentials(output: fixture.output))
        try await next.tick()
        await next.waitForDispatches()
        #expect(try fixture.launchCount() == 1)
        #expect(await next.wait(id: wait.id)?.status == .held)
        try await next.shutdown()
    }

    @Test("A failed stop never acknowledges success and retains the owner and visible failure")
    func failedStopRetainsOwner() async throws {
        let fixture = try HostFixture(shortPath: true)
        defer { fixture.remove() }
        let host = try await fixture.start()
        let server = try NativeHostControlServer(host: host, peerUID: { _ in 0 })
        defer { server.close() }
        try FileManager.default.createDirectory(at: fixture.root.appendingPathComponent("stopped.marker"), withIntermediateDirectories: false)
        let response = try await controlRequest(fixture, "stop\n")
        #expect(response.contains("shutdownFailed"))
        #expect(!response.contains("\"ok\":true"))
        #expect(try await controlRequest(fixture, "status\n").contains("shutdownFailed"))
        await #expect(throws: NativeHeadlessHostError.ownerAlreadyRunning) { _ = try await fixture.start() }
    }

    @Test("Stale sockets recover, unsafe files are preserved and old cleanup cannot unlink a replacement")
    func socketIdentity() async throws {
        let fixture = try HostFixture(shortPath: true)
        defer { fixture.remove() }
        let host = try await fixture.start()
        let socket = fixture.root.appendingPathComponent(NativeHostControlServer.socketName)
        try Data("untouched".utf8).write(to: socket)
        #expect(throws: (any Error).self) { _ = try NativeHostControlServer(host: host) }
        #expect(try String(contentsOf: socket, encoding: .utf8) == "untouched")
        try FileManager.default.removeItem(at: socket)
        let stale = try fixtureSocket(socket)
        Darwin.close(stale)
        let server = try NativeHostControlServer(host: host, peerUID: { _ in 0 })
        #expect(throws: (any Error).self) { _ = try NativeHostControlServer(host: host) }
        #expect(unlink(socket.path) == 0)
        let replacement = try fixtureSocket(socket)
        defer { Darwin.close(replacement) }
        server.close()
        #expect(FileManager.default.fileExists(atPath: socket.path))
        try await host.shutdown()
    }

    @Test("The real foreground executable denies a non-admin peer and exits cleanly on automatic Stop")
    func foregroundExecutable() async throws {
        let fixture = try HostFixture(shortPath: true)
        defer { fixture.remove() }
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let executable = root.appendingPathComponent(".build/debug/BotFleetNativeHost")
        #expect(FileManager.default.isExecutableFile(atPath: executable.path))
        let process = Process()
        process.executableURL = executable
        process.arguments = ["--service-data", fixture.root.path]
        process.environment = ["PATH": "/usr/bin:/bin", "HOME": fixture.parent.path, "TMPDIR": fixture.parent.path]
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        try process.run()
        defer { if process.isRunning { kill(process.processIdentifier, SIGKILL); process.waitUntilExit() } }
        try await controlEventually { FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent(NativeHostControlServer.socketName).path) }
        let answer = try await controlRequest(fixture, "status\n")
        #expect(answer.contains(geteuid() == 0 ? "running" : "denied"))
        if geteuid() != 0 { #expect(try await controlRequest(fixture, "stop\n").contains("denied")) }
        process.terminate()
        try await controlEventually { !process.isRunning }
        #expect(process.terminationStatus == 0)
        let paths = try NativeServicePaths(serviceData: fixture.root)
        try Data("{\"stopped\":true}\n".utf8).write(to: paths.stoppedMarker)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: paths.stoppedMarker.path)
        let databaseBefore = try Data(contentsOf: fixture.database)
        let automatic = Process()
        automatic.executableURL = executable
        automatic.arguments = ["--service-data", fixture.root.path, "--automatic"]
        automatic.environment = ["PATH": "/usr/bin:/bin", "HOME": fixture.parent.path, "TMPDIR": fixture.parent.path]
        automatic.standardOutput = Pipe()
        automatic.standardError = Pipe()
        try automatic.run()
        defer { if automatic.isRunning { kill(automatic.processIdentifier, SIGKILL); automatic.waitUntilExit() } }
        try await controlEventually { !automatic.isRunning }
        #expect(automatic.terminationStatus == 0)
        #expect(try Data(contentsOf: fixture.database) == databaseBefore)
        #expect(FileManager.default.fileExists(atPath: paths.stoppedMarker.path))
    }
}

private func controlEventually(_ predicate: () -> Bool) async throws {
    for _ in 0..<250 {
        if predicate() { return }
        try await Task.sleep(nanoseconds: 20_000_000)
    }
    throw NativeHeadlessHostError.stopped
}

private func controlAddress(_ url: URL) -> sockaddr_un {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let bytes = Array(url.path.utf8CString)
    precondition(bytes.count <= MemoryLayout.size(ofValue: address.sun_path))
    withUnsafeMutableBytes(of: &address.sun_path) { buffer in
        for (index, byte) in bytes.enumerated() { buffer[index] = UInt8(bitPattern: byte) }
    }
    return address
}

private func fixtureSocket(_ url: URL) throws -> Int32 {
    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw NativeHostControlError.socketUnavailable }
    var address = controlAddress(url)
    let result = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard result == 0, chmod(url.path, 0o600) == 0 else { Darwin.close(fd); throw NativeHostControlError.socketUnavailable }
    return fd
}

private func controlConnect(_ fixture: HostFixture) throws -> Int32 {
    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw NativeHostControlError.socketUnavailable }
    var timeout = timeval(tv_sec: 5, tv_usec: 0)
    var noSignal: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
    var address = controlAddress(fixture.root.appendingPathComponent(NativeHostControlServer.socketName))
    let result = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard result == 0 else { Darwin.close(fd); throw NativeHostControlError.socketUnavailable }
    return fd
}

private func controlRequest(_ fixture: HostFixture, _ text: String) async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .utility).async {
            do { continuation.resume(returning: try controlExchange(fixture, text)) }
            catch { continuation.resume(throwing: error) }
        }
    }
}

private func controlExchange(_ fixture: HostFixture, _ text: String) throws -> String {
    let fd = try controlConnect(fixture)
    defer { Darwin.close(fd) }
    let bytes = Array(text.utf8)
    _ = bytes.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
    var answer = Data()
    var buffer = [UInt8](repeating: 0, count: 256)
    while true {
        let count = Darwin.read(fd, &buffer, buffer.count)
        if count <= 0 { break }
        answer.append(contentsOf: buffer.prefix(count))
    }
    return String(decoding: answer, as: UTF8.self)
}
#endif
