#if os(macOS)
import Foundation
import Darwin
import Testing
@testable import CompanionCore

@Suite("Native host private administrative control")
struct NativeHostControlTests {
    @Test("Launch arguments distinguish explicit Start from automatic startup and refuse extra operations")
    func launchArguments() throws {
        let explicit = try NativeHostLaunchArguments(arguments: ["--service-data", "/fixture/service"])
        #expect(explicit.intent == .explicit)
        let automatic = try NativeHostLaunchArguments(arguments: ["--service-data", "/fixture/service", "--automatic"])
        #expect(automatic.intent == .automatic)
        for arguments in [[], ["--service-data"], ["--service-data", "relative"],
                          ["--service-data", "/fixture/service", "--stop"],
                          ["--service-data", "/fixture/service", "--automatic", "--automatic"]] {
            #expect(throws: NativeHostLaunchArgumentsError.invalidArguments) {
                _ = try NativeHostLaunchArguments(arguments: arguments)
            }
        }
    }

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
        try await controlStatusEventually(fixture)
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
        let signalResult = kill(pid, 0)
        let signalError = errno
        #expect(signalResult == -1 && signalError == ESRCH)
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
        try writeFixtureFile("untouched", to: socket)
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
        let executable = nativeHostExecutable()
        #expect(FileManager.default.isExecutableFile(atPath: executable.path))
        let process = Process()
        process.executableURL = executable
        process.arguments = ["--service-data", fixture.root.path]
        process.environment = ["PATH": "/usr/bin:/bin", "HOME": fixture.parent.path, "TMPDIR": fixture.parent.path]
        let runningOutput = Pipe()
        process.standardOutput = runningOutput
        process.standardError = Pipe()
        try process.run()
        defer { if process.isRunning { kill(process.processIdentifier, SIGKILL); process.waitUntilExit() } }
        try await controlEventually { FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent(NativeHostControlServer.socketName).path) }
        let answer = try await controlRequest(fixture, "status\n")
        #expect(answer.contains(geteuid() == 0 ? "running" : "denied"))
        if geteuid() != 0 { #expect(try await controlRequest(fixture, "stop\n").contains("denied")) }
        process.terminate()
        try await controlEventually { !process.isRunning }
        // A start is announced only after the control channel verified the host.
        let runningStdout = String(decoding: runningOutput.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        #expect(process.terminationStatus == 0)
        #expect(runningStdout.contains("Native host running"))
        let paths = try NativeServicePaths(serviceData: fixture.root)
        try Data("{\"stopped\":true}\n".utf8).write(to: paths.stoppedMarker)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: paths.stoppedMarker.path)
        let databaseBefore = try Data(contentsOf: fixture.database)
        let automatic = Process()
        automatic.executableURL = executable
        automatic.arguments = ["--service-data", fixture.root.path, "--automatic"]
        automatic.environment = ["PATH": "/usr/bin:/bin", "HOME": fixture.parent.path, "TMPDIR": fixture.parent.path]
        let automaticOutput = Pipe()
        automatic.standardOutput = automaticOutput
        automatic.standardError = Pipe()
        try automatic.run()
        defer { if automatic.isRunning { kill(automatic.processIdentifier, SIGKILL); automatic.waitUntilExit() } }
        try await controlEventually { !automatic.isRunning }
        let automaticStdout = String(decoding: automaticOutput.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        #expect(automatic.terminationStatus == 0)
        // The host did not come up, so the start is never reported as successful.
        #expect(!automaticStdout.contains("Native host running"))
        #expect(automaticStdout.contains("was not started"))
        #expect(try Data(contentsOf: fixture.database) == databaseBefore)
        #expect(FileManager.default.fileExists(atPath: paths.stoppedMarker.path))
    }

    @Test("A checked start verifies the host through the control channel before it is reported as started")
    func checkedStartVerifiesTheHost() async throws {
        let fixture = try HostFixture(shortPath: true)
        defer { fixture.remove() }
        let host = try await fixture.start()
        let server = try NativeHostControlServer(host: host, peerUID: { _ in 0 })
        defer { server.close() }
        // The checked start and the status verb can never disagree about the state.
        #expect(try await server.verifyStart() == .running)
        #expect(try await controlRequest(fixture, "status\n").contains("\"state\":\"running\""))
        // A host that did not come up is never reported as started, and the reason is named.
        try await host.shutdown()
        var reason: String?
        do {
            _ = try await server.verifyStart()
        } catch let error as NativeHostControlError {
            reason = error.reasonCode
        }
        #expect(reason == "startNotVerified:stopped")
    }

    @Test("The checked start does not widen the peer fence")
    func checkedStartKeepsThePeerFence() async throws {
        let fixture = try HostFixture(shortPath: true)
        defer { fixture.remove() }
        let host = try await fixture.start()
        // Every peer is unprivileged here, so the channel refuses them all.
        let server = try NativeHostControlServer(host: host, peerUID: { _ in 501 })
        defer { server.close() }
        // The checked start never borrows a peer's privilege: it reads the host's own
        // state and proves the listener answers, and nothing more.
        #expect(try await server.verifyStart() == .running)
        #expect(try await controlRequest(fixture, "status\n").contains("denied"))
        #expect(try await controlRequest(fixture, "stop\n").contains("denied"))
        #expect(await host.state == .running)
        try await host.shutdown()
    }

    @Test("The start is announced only after the checked start succeeded")
    func announcementFollowsTheCheckedStart() async throws {
        var announcements: [String] = []
        var checks = 0
        // A check that fails announces nothing at all.
        var failure: String?
        do {
            try await NativeHostStartSequence.run(
                verify: { checks += 1; throw NativeHostControlError.controlChannelUnreachable },
                write: { announcements.append($0) })
        } catch let error as NativeHostControlError {
            failure = error.reasonCode
        }
        #expect(failure == "controlChannelUnreachable")
        #expect(checks == 1)
        #expect(announcements.isEmpty)
        // A check that succeeds announces exactly once, and only after it ran.
        try await NativeHostStartSequence.run(
            verify: { checks += 1 },
            write: { announcements.append($0) })
        #expect(checks == 2)
        #expect(announcements.count == 1)
        #expect(announcements.first == NativeHostStartSequence.runningMessage)
    }

    @Test("The executable never announces a start the control channel could not back")
    func executableNeverAnnouncesWithoutAChannel() async throws {
        let fixture = try HostFixture(shortPath: true)
        defer { fixture.remove() }
        let paths = try NativeServicePaths(serviceData: fixture.root)
        // A foreign entry at the socket path is refused, so no channel can back a start.
        let socket = paths.root.appendingPathComponent(NativeHostControlServer.socketName)
        try writeFixtureFile("foreign", to: socket)
        let executable = nativeHostExecutable()
        #expect(FileManager.default.isExecutableFile(atPath: executable.path))
        let run = try runNativeHost(executable, arguments: ["--service-data", fixture.root.path], fixture: fixture)
        #expect(run.status != 0)
        #expect(run.error.contains("reason=unsafeSocket"))
        #expect(!run.output.contains("Native host running"))
    }

    @Test("The executable has no announcement path of its own")
    func theExecutableHasNoAnnouncementOfItsOwn() throws {
        let source = try String(contentsOf: nativeHostMainScript(), encoding: .utf8)
        // The announcement belongs to the sequence, so the executable holds no
        // announcement of its own that could be moved ahead of the verification:
        // it neither carries the message nor reaches for it.
        #expect(!source.contains("Native host running"))
        #expect(!source.contains("runningMessage"))
        // The channel check is the sequence's verification, and it is the only one.
        #expect(source.components(separatedBy: "control.verifyStart()").count - 1 == 1)
        let sequence = try #require(source.range(of: "NativeHostStartSequence.run("))
        let verification = try #require(source.range(of: "control.verifyStart()"))
        #expect(sequence.lowerBound < verification.lowerBound)
    }

    @Test("The real executable announces a verified start exactly once")
    func theExecutableAnnouncesAVerifiedStartOnce() async throws {
        let fixture = try HostFixture(shortPath: true)
        defer { fixture.remove() }
        let executable = nativeHostExecutable()
        #expect(FileManager.default.isExecutableFile(atPath: executable.path))
        let process = Process()
        process.executableURL = executable
        process.arguments = ["--service-data", fixture.root.path]
        process.environment = ["PATH": "/usr/bin:/bin", "HOME": fixture.parent.path, "TMPDIR": fixture.parent.path]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = Pipe()
        try process.run()
        defer { if process.isRunning { kill(process.processIdentifier, SIGKILL); process.waitUntilExit() } }
        // The channel that backs the announcement is live and answers for the
        // host, so the wait is for the answer and not for the socket file.
        let status = try await controlEventuallyAnswering(fixture)
        #expect(status.contains(geteuid() == 0 ? "\"state\":\"running\"" : "denied"))
        process.terminate()
        try await controlEventually { !process.isRunning }
        let stdout = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        // The verified start is announced once and only once, so an announcement
        // that came before the verification or from a second path would show up
        // here as a missing or a repeated message.
        #expect(stdout.components(separatedBy: "Native host running").count - 1 == 1)
        #expect(stdout.contains(NativeHostStartSequence.runningMessage))
    }

    @Test("A failed start reports the reason and is never reported as successful")
    func failedStartReportsTheReason() async throws {
        let fixture = try HostFixture(shortPath: true)
        defer { fixture.remove() }
        // The running host owns the service root, so the next start cannot take it.
        let host = try await fixture.start()
        let executable = nativeHostExecutable()
        #expect(FileManager.default.isExecutableFile(atPath: executable.path))
        let run = try runNativeHost(executable, arguments: ["--service-data", fixture.root.path], fixture: fixture)
        #expect(run.status != 0)
        #expect(run.error.contains("reason=ownerAlreadyRunning"))
        #expect(!run.error.contains("type(of:"))
        #expect(!run.output.contains("Native host running"))
        try await host.shutdown()
    }

    @Test("A pending non-blocking connect is treated as reachable and then verified")
    func pendingConnectIsVerified() async throws {
        // The decision a connect result makes: a connected socket, a pending
        // connection and a full backlog all still mean the listener is live.
        #expect(NativeHostChannelProbe.isReachable(connectResult: 0, connectError: 0))
        #expect(NativeHostChannelProbe.isReachable(connectResult: -1, connectError: EINPROGRESS))
        #expect(NativeHostChannelProbe.isReachable(connectResult: -1, connectError: EAGAIN))
        // A refused or missing listener is not a live channel.
        #expect(!NativeHostChannelProbe.isReachable(connectResult: -1, connectError: ENOENT))
        #expect(!NativeHostChannelProbe.isReachable(connectResult: -1, connectError: ECONNREFUSED))
        // The live channel answers the probe and a missing one does not.
        let fixture = try HostFixture(shortPath: true)
        defer { fixture.remove() }
        let host = try await fixture.start()
        let server = try NativeHostControlServer(host: host, peerUID: { _ in 0 })
        defer { server.close() }
        let socket = fixture.root.appendingPathComponent(NativeHostControlServer.socketName).path
        #expect(NativeHostControlServer.channelAnswers(path: socket))
        #expect(!NativeHostControlServer.channelAnswers(path: fixture.root.appendingPathComponent("absent.sock").path))
        // A completed connection carries no socket error, and the client of the
        // live channel is a real connection, so the kernel kept no error for it.
        let connected = try controlConnect(fixture)
        #expect(NativeHostControlServer.connectionCompleted(connected))
        Darwin.close(connected)
        try await host.shutdown()
    }

    @Test("A pending connect is believed only after it completed without a socket error")
    func pendingConnectIsBelievedOnlyAfterCompletion() async throws {
        // The pending branch of the probe, reached without kernel backlog timing.
        let fixture = try HostFixture(shortPath: true)
        defer { fixture.remove() }
        let host = try await fixture.start()
        let server = try NativeHostControlServer(host: host, peerUID: { _ in 0 })
        defer { server.close() }
        let live = fixture.root.appendingPathComponent(NativeHostControlServer.socketName)
        let socket = live.path
        // A pending connect that completed cleanly is a live channel.
        let completed = NativeHostControlServer.channelAnswers(path: socket, connect: { fd in
            var address = controlAddress(live)
            _ = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            return (-1, EINPROGRESS)
        })
        #expect(completed)
        // A pending connect that carries a socket error is not a live channel.
        let missing = controlAddress(fixture.root.appendingPathComponent("absent.sock"))
        let failed = NativeHostControlServer.channelAnswers(path: socket, connect: { fd in
            var address = missing
            _ = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            return (-1, EINPROGRESS)
        })
        #expect(!failed)
        try await host.shutdown()
    }

    @Test("Every error type keeps its reason code on every platform")
    func crossPlatformReasonCodes() throws {
        // The classification is direct, not through a macOS-only path.
        #expect(NativeHostFailureReason.code(for: NativeHostControlError.unsafeSocket) == "unsafeSocket")
        #expect(NativeHostFailureReason.code(for: NativeHostControlError.socketUnavailable) == "socketUnavailable")
        #expect(NativeHostFailureReason.code(for: NativeHostControlError.startNotVerified(state: "stopped")) == "startNotVerified:stopped")
        #expect(NativeHostFailureReason.code(for: NativeHostControlError.controlChannelUnreachable) == "controlChannelUnreachable")
        #expect(NativeHostFailureReason.code(for: NativeHostLaunchArgumentsError.invalidArguments) == "invalidArguments")
        // Neither the error types nor the map hide a case behind a platform guard,
        // so a build that does not run the host classifies them the same way.
        let errors = try String(contentsOf: companionCoreSource("NativeHostErrors.swift"), encoding: .utf8)
        let reasons = try String(contentsOf: companionCoreSource("NativeHostFailureReason.swift"), encoding: .utf8)
        #expect(!errors.contains("#if os(macOS)"))
        #expect(!reasons.contains("#if os(macOS)"))
    }

    @Test("Failure reasons are stable codes that never carry a message, a path or a token")
    func stableFailureReasons() {
        #expect(NativeHostFailureReason.code(for: NativeHeadlessHostError.ownerAlreadyRunning) == "ownerAlreadyRunning")
        #expect(NativeHostFailureReason.code(for: NativeHeadlessHostError.stopMarkerFailed) == "stopMarkerFailed")
        #expect(NativeHostFailureReason.code(for: NativeHostControlError.unsafeSocket) == "unsafeSocket")
        #expect(NativeHostFailureReason.code(for: NativeHostControlError.startNotVerified(state: "stopped")) == "startNotVerified:stopped")
        #expect(NativeHostFailureReason.code(for: DatabaseError.openFailed("/private/service-root/host.sqlite")) == "databaseOpenFailed")
        #expect(NativeHostFailureReason.code(for: NativeHostLaunchArgumentsError.invalidArguments) == "invalidArguments")
        let unclassified = NativeHostFailureReason.code(for: NSError(domain: "fixture", code: 7))
        #expect(unclassified == "unclassified")
        #expect(!unclassified.contains("fixture"))
    }
}

private func iosRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func companionCoreSource(_ name: String) -> URL {
    iosRoot().appendingPathComponent("Sources/CompanionCore").appendingPathComponent(name)
}

private func nativeHostMainScript() -> URL {
    iosRoot().appendingPathComponent("Scripts/BotFleetNativeHost/main.swift")
}

/// Why a fixture write was refused, so a failure names the step that failed.
private enum FixtureWriteRefusal: Error, CustomStringConvertible {
    case ancestor(String, Int32)
    case trustedDirectory(Int32)
    case entry(Int32)
    case handle(Int32)
    case listed(Int32)

    var description: String {
        switch self {
        case .ancestor(let component, let code): return "ancestor \(component) errno=\(code)"
        case .trustedDirectory(let code): return "trusted directory errno=\(code)"
        case .entry(let code): return "entry errno=\(code)"
        case .handle(let code): return "handle errno=\(code)"
        case .listed(let code): return "listed errno=\(code)"
        }
    }
}

/// Writes a fixture payload through a verified handle.
///
/// The payload never goes through a resolved path.  Every ancestor of the
/// trusted directory must be a real directory, so a symlinked directory cannot
/// redirect the write, and the trusted directory itself is opened with
/// `O_NOFOLLOW`, so a symlinked service root is refused.  The entry is then
/// opened relative to that directory descriptor with `O_NOFOLLOW`, the opened
/// handle is checked with `fstat` (a regular, single-link file owned by this
/// user), and its device and inode are compared with the listed path before
/// anything is written.
private func writeFixtureFile(_ payload: String, to url: URL) throws {
    let path = url.path
    let directoryPath = url.deletingLastPathComponent().path
    let name = url.lastPathComponent
    var ancestor = URL(fileURLWithPath: "/")
    for component in directoryPath.split(separator: "/", omittingEmptySubsequences: true).map(String.init) {
        ancestor = ancestor.appendingPathComponent(component)
        var info = stat()
        guard lstat(ancestor.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else {
            throw FixtureWriteRefusal.ancestor(ancestor.path, errno)
        }
    }
    let directory = open(directoryPath, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW, 0)
    guard directory >= 0 else { throw FixtureWriteRefusal.trustedDirectory(errno) }
    defer { Darwin.close(directory) }
    var directoryInfo = stat()
    guard fstat(directory, &directoryInfo) == 0, directoryInfo.st_mode & S_IFMT == S_IFDIR,
          directoryInfo.st_uid == 0 || directoryInfo.st_uid == geteuid(),
          directoryInfo.st_mode & 0o022 == 0 else {
        throw FixtureWriteRefusal.trustedDirectory(0)
    }
    let fd = name.withCString {
        openat(directory, $0, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
    }
    guard fd >= 0 else { throw FixtureWriteRefusal.entry(errno) }
    defer { Darwin.close(fd) }
    var handle = stat()
    guard fstat(fd, &handle) == 0, handle.st_mode & S_IFMT == S_IFREG, handle.st_nlink == 1,
          handle.st_uid == geteuid() else {
        throw FixtureWriteRefusal.handle(0)
    }
    var listed = stat()
    guard lstat(path, &listed) == 0, listed.st_mode & S_IFMT == S_IFREG,
          listed.st_dev == handle.st_dev, listed.st_ino == handle.st_ino else {
        throw FixtureWriteRefusal.listed(errno)
    }
    let bytes = Array(payload.utf8)
    guard !bytes.isEmpty else { return }
    var written = 0
    while written < bytes.count {
        let offset = written
        let count = bytes.withUnsafeBytes { raw -> Int in
            guard let base = raw.baseAddress else { return 0 }
            return Darwin.write(fd, base.advanced(by: offset), raw.count - offset)
        }
        if count > 0 { written = offset + count }
        else if count < 0, errno == EINTR { continue }
        else { throw FixtureWriteRefusal.handle(errno) }
    }
}

private func nativeHostExecutable() -> URL {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return root.appendingPathComponent(".build/debug/BotFleetNativeHost")
}

private struct NativeHostRun {
    let status: Int32
    let output: String
    let error: String
}

/// Runs the real foreground executable to completion and keeps both streams.
private func runNativeHost(_ executable: URL, arguments: [String], fixture: HostFixture) throws -> NativeHostRun {
    let process = Process()
    process.executableURL = executable
    process.arguments = arguments
    process.environment = ["PATH": "/usr/bin:/bin", "HOME": fixture.parent.path, "TMPDIR": fixture.parent.path]
    let output = Pipe()
    let error = Pipe()
    process.standardOutput = output
    process.standardError = error
    try process.run()
    let outputData = output.fileHandleForReading.readDataToEndOfFile()
    let errorData = error.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return NativeHostRun(status: process.terminationStatus,
                         output: String(decoding: outputData, as: UTF8.self),
                         error: String(decoding: errorData, as: UTF8.self))
}

private func controlEventually(_ predicate: () -> Bool) async throws {
    for _ in 0..<250 {
        if predicate() { return }
        try await Task.sleep(nanoseconds: 20_000_000)
    }
    throw NativeHeadlessHostError.stopped
}

/// Waits until the control channel answers a request.  The server binds the
/// socket before it listens, so the socket file can exist while the listener is
/// not ready yet, and only an answer proves the channel is live.
private func controlEventuallyAnswering(_ fixture: HostFixture) async throws -> String {
    for _ in 0..<250 {
        if let answer = try? await controlRequest(fixture, "status\n"), !answer.isEmpty { return answer }
        try await Task.sleep(nanoseconds: 20_000_000)
    }
    throw NativeHostControlError.socketUnavailable
}

private func controlStatusEventually(_ fixture: HostFixture) async throws {
    let deadline = ProcessInfo.processInfo.systemUptime + 5
    while ProcessInfo.processInfo.systemUptime < deadline {
        if try await controlRequest(fixture, "status\n").contains("running") { return }
        try await Task.sleep(nanoseconds: 20_000_000)
    }
    throw NativeHostControlError.socketUnavailable
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
