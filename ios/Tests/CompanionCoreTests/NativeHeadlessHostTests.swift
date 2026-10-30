#if os(macOS)
import Foundation
import Testing
import Darwin
import SQLite3
@testable import CompanionCore

@Suite("Native Headless Host", .serialized)
struct NativeHeadlessHostTests {
    @Test("The production runner executes an isolated child and persists messages across restart")
    func realChildAndRestart() async throws {
        let fixture = try HostFixture()
        defer { fixture.remove() }
        let host = try await fixture.start(credentials: FixtureServiceCredentials(output: fixture.output))
        try await host.registerBot(fixture.bot())
        let wait = try await host.registerWait(botId: "bot-a", prompt: "fixture prompt", predicate: .botIdle)
        try await host.tick()
        await host.waitForDispatches()
        #expect(await host.wait(id: wait.id)?.status == .completed)
        let messages = try await host.messages(botId: "bot-a")
        #expect(messages.contains { $0.role == "user" && $0.content == "fixture prompt" })
        #expect(messages.contains { $0.role == "assistant" && $0.content == "fixture reply" })
        #expect(try fixture.launchCount() == 1)
        try await host.shutdown(deliberateStop: true)
        #expect(FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("stopped.marker").path))
        let restarted = try await fixture.start(credentials: FixtureServiceCredentials(output: fixture.output))
        #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("stopped.marker").path))
        try await restarted.tick()
        await restarted.waitForDispatches()
        #expect(try await restarted.messages(botId: "bot-a") == messages)
        #expect(try fixture.launchCount() == 1)
        try await restarted.shutdown()
    }

    @Test("Missing service credentials hold before acceptance and can resume after restart")
    func credentialHoldResumesOnlyUnclaimedWork() async throws {
        let fixture = try HostFixture()
        defer { fixture.remove() }
        let host = try await fixture.start()
        try await host.registerBot(fixture.bot())
        let wait = try await host.registerWait(botId: "bot-a", prompt: "after credentials", predicate: .botIdle)
        try await host.tick()
        await host.waitForDispatches()
        #expect(await host.wait(id: wait.id)?.admissionHold == .credentialsUnavailable)
        #expect(!FileManager.default.fileExists(atPath: fixture.output.path))
        try await host.shutdown()
        let stored = try DatabaseService(path: fixture.database.path)
        #expect(try await !stored.hasNativeEventWaitDispatchClaim(id: wait.id))
        try await stored.checkpointAndClose()
        let restarted = try await fixture.start(credentials: FixtureServiceCredentials(output: fixture.output))
        try await restarted.tick()
        await restarted.waitForDispatches()
        #expect(await restarted.wait(id: wait.id)?.status == .completed)
        #expect(try fixture.launchCount() == 1)
        try await restarted.shutdown()
    }

    @Test("A registered app-owned workspace supplies real file predicates before dispatch")
    func ownedWorkspacePredicate() async throws {
        let fixture = try HostFixture()
        defer { fixture.remove() }
        let host = try await fixture.start(credentials: FixtureServiceCredentials(output: fixture.output))
        try await host.registerBot(fixture.bot())
        let wait = try await host.registerWait(botId: "bot-a", prompt: "file arrived", predicate: .fileExists(relativePath: "done"))
        try await host.tick()
        #expect(await host.wait(id: wait.id)?.status == .pending)
        #expect(!FileManager.default.fileExists(atPath: fixture.output.path))
        try Data("fixture".utf8).write(to: fixture.root.appendingPathComponent("workspaces/bot-a/done"))
        try await host.tick()
        await host.waitForDispatches()
        #expect(await host.wait(id: wait.id)?.status == .completed)
        #expect(try fixture.launchCount() == 1)
        try await host.shutdown()
    }

    @Test("Capability refresh resumes an unclaimed hold without creating another wait")
    func explicitCapabilityRefresh() async throws {
        let fixture = try HostFixture()
        defer { fixture.remove() }
        let credentials = SwitchableFixtureCredentials(output: fixture.output)
        let host = try await fixture.start(credentials: credentials)
        try await host.registerBot(fixture.bot())
        let wait = try await host.registerWait(botId: "bot-a", prompt: "resume", predicate: .botIdle)
        try await host.tick()
        await host.waitForDispatches()
        #expect(await host.wait(id: wait.id)?.admissionHold == .credentialsUnavailable)
        await credentials.enable()
        try await host.refreshCapabilities()
        try await host.tick()
        await host.waitForDispatches()
        #expect(await host.wait(id: wait.id)?.status == .completed)
        #expect(try fixture.launchCount() == 1)
        try await host.shutdown()
    }

    @Test("Desktop requirements remain waitingForLogin with no attachment grant API")
    func desktopHold() async throws {
        let fixture = try HostFixture()
        defer { fixture.remove() }
        let host = try await fixture.start(credentials: FixtureServiceCredentials(output: fixture.output))
        try await host.registerBot(fixture.bot(desktop: true))
        let wait = try await host.registerWait(botId: "bot-a", prompt: "desktop", predicate: .botIdle)
        try await host.tick()
        await host.waitForDispatches()
        #expect(await host.wait(id: wait.id)?.admissionHold == .waitingForLogin)
        #expect(!FileManager.default.fileExists(atPath: fixture.output.path))
        try await host.shutdown()
    }

    @Test("Credential resolver errors become typed unclaimed holds without persisting error material")
    func resolverFailureIsRedacted() async throws {
        let fixture = try HostFixture()
        defer { fixture.remove() }
        let host = try await fixture.start(credentials: ThrowingFixtureCredentials())
        try await host.registerBot(fixture.bot())
        let wait = try await host.registerWait(botId: "bot-a", prompt: "fixture", predicate: .botIdle)
        try await host.tick()
        await host.waitForDispatches()
        let held = try #require(await host.wait(id: wait.id))
        #expect(held.admissionHold == .credentialsUnavailable)
        #expect(held.holdReason == "credentialsUnavailable")
        #expect(!String(decoding: try JSONEncoder().encode(held), as: UTF8.self).contains("synthetic-private-error"))
        #expect(!FileManager.default.fileExists(atPath: fixture.output.path))
        try await host.shutdown()
    }

    @Test("A credential callback cannot await the shutdown that must drain its own dispatch")
    func reentrantCredentialShutdownIsRefused() async throws {
        let fixture = try HostFixture()
        defer { fixture.remove() }
        let credentials = ReentrantFixtureCredentials()
        let host = try await fixture.start(credentials: credentials)
        await credentials.attach(host)
        try await host.registerBot(fixture.bot())
        let wait = try await host.registerWait(botId: "bot-a", prompt: "fixture", predicate: .botIdle)
        try await host.tick()
        await host.waitForDispatches()
        #expect(await credentials.refused)
        #expect(await host.state == .running)
        #expect(await host.wait(id: wait.id)?.admissionHold == .credentialsUnavailable)
        #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("stopped.marker").path))
        await credentials.attach(nil)
        try await host.shutdown()
    }

    @Test("Accepted outcomes remain held across restart and capability refresh")
    func acceptedWorkNeverReplays() async throws {
        let fixture = try HostFixture()
        defer { fixture.remove() }
        let initial = try await fixture.start()
        try await initial.registerBot(fixture.bot())
        try await initial.shutdown()
        let database = try DatabaseService(path: fixture.database.path)
        let now = Date().timeIntervalSince1970
        let accepted = NativeEventWait(id: "accepted", botId: "bot-a", threadId: "thread-a", prompt: "already accepted",
            predicate: .botIdle, createdAt: now, deadlineAt: now + 600, status: .dispatching)
        try await database.saveNativeEventWait(accepted)
        #expect(try await database.claimNativeEventWaitDispatch(accepted))
        try await database.checkpointAndClose()
        let host = try await fixture.start(credentials: FixtureServiceCredentials(output: fixture.output))
        try await host.refreshCapabilities()
        try await host.tick()
        await host.waitForDispatches()
        #expect(await host.wait(id: "accepted")?.status == .held)
        #expect(await host.wait(id: "accepted")?.admissionHold == nil)
        #expect(!FileManager.default.fileExists(atPath: fixture.output.path))
        try await host.shutdown()
    }

    @Test("A competing owner is rejected before database creation and the lock inode stays stable")
    func lifetimeOwnerLock() async throws {
        let fixture = try HostFixture()
        defer { fixture.remove() }
        let paths = try NativeServicePaths(serviceData: fixture.root)
        let lease = try NativeHostOwnerLease(paths: paths)
        let lockURL = fixture.root.appendingPathComponent("owner.lock")
        let before = try FileManager.default.attributesOfItem(atPath: lockURL.path)[.systemFileNumber] as? NSNumber
        await #expect(throws: NativeHeadlessHostError.ownerAlreadyRunning) { _ = try await fixture.start() }
        #expect(!FileManager.default.fileExists(atPath: fixture.database.path))
        lease.release()
        let host = try await fixture.start()
        await #expect(throws: NativeHeadlessHostError.ownerAlreadyRunning) { _ = try await fixture.start() }
        try await host.shutdown()
        let after = try FileManager.default.attributesOfItem(atPath: lockURL.path)[.systemFileNumber] as? NSNumber
        #expect(before == after)
    }

    @Test("Replacing the owner.lock entry during acquisition refuses the orphaned inode")
    func replacedOwnerLockIsRefused() throws {
        let fixture = try HostFixture()
        defer { fixture.remove() }
        let paths = try NativeServicePaths(serviceData: fixture.root)
        let lockURL = fixture.root.appendingPathComponent("owner.lock")
        #expect(throws: NativeHeadlessHostError.ownerLockFailed) {
            _ = try NativeHostOwnerLease(paths: paths, beforeAcquire: {
                try FileManager.default.removeItem(at: lockURL)
                try Data("replacement".utf8).write(to: lockURL)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: lockURL.path)
            })
        }
        #expect(!FileManager.default.fileExists(atPath: fixture.database.path))
        let next = try NativeHostOwnerLease(paths: paths)
        next.release()
    }

    @Test("Symlink owner locks and interactive roots are refused")
    func unsafeRoots() async throws {
        let fixture = try HostFixture()
        defer { fixture.remove() }
        try FileManager.default.createDirectory(at: fixture.root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let target = fixture.parent.appendingPathComponent("untouched")
        try Data("fixture".utf8).write(to: target)
        try FileManager.default.createSymbolicLink(at: fixture.root.appendingPathComponent("owner.lock"), withDestinationURL: target)
        await #expect(throws: NativeHeadlessHostError.ownerLockFailed) { _ = try await fixture.start() }
        #expect(try String(contentsOf: target, encoding: .utf8) == "fixture")
        try Data("{}".utf8).write(to: fixture.root.appendingPathComponent("config.json"))
        await #expect(throws: NativeHeadlessHostError.invalidServiceRoot) { _ = try await fixture.start() }
        #expect(!FileManager.default.fileExists(atPath: fixture.database.path))
    }

    @Test("Shutdown fences suspended admission and retains ownership until dispatches settle")
    func suspendedAdmissionShutdown() async throws {
        let fixture = try HostFixture()
        defer { fixture.remove() }
        let credentials = GatedFixtureCredentials(output: fixture.output)
        let host = try await fixture.start(credentials: credentials)
        try await host.registerBot(fixture.bot())
        _ = try await host.registerWait(botId: "bot-a", prompt: "racing stop", predicate: .botIdle)
        try await host.tick()
        try await waitUntil { await credentials.entered }
        let stop = Task { try await host.shutdown(deliberateStop: true) }
        try await waitUntil { await host.state == .stopping }
        #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("stopped.marker").path))
        await #expect(throws: NativeHeadlessHostError.ownerAlreadyRunning) { _ = try await fixture.start() }
        stop.cancel()
        await credentials.release()
        try await stop.value
        #expect(!FileManager.default.fileExists(atPath: fixture.output.path))
        #expect(await host.state == .stopped)
        #expect(FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("stopped.marker").path))
        let next = try await fixture.start(credentials: FixtureServiceCredentials(output: fixture.output))
        try await next.tick()
        await next.waitForDispatches()
        #expect(!FileManager.default.fileExists(atPath: fixture.output.path))
        try await next.shutdown()
    }

    @Test("An explicit stop upgrades a suspended ordinary shutdown without writing an early marker")
    func concurrentExplicitStopUpgradesShutdown() async throws {
        let fixture = try HostFixture()
        defer { fixture.remove() }
        let credentials = GatedFixtureCredentials(output: fixture.output)
        let host = try await fixture.start(credentials: credentials)
        try await host.registerBot(fixture.bot())
        _ = try await host.registerWait(botId: "bot-a", prompt: "fixture", predicate: .botIdle)
        try await host.tick()
        try await waitUntil { await credentials.entered }
        let ordinary = Task { try await host.shutdown() }
        try await waitUntil { await host.state == .stopping }
        let explicit = Task { try await host.shutdown(deliberateStop: true) }
        try await waitUntil { await host.deliberateStopRequested }
        #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("stopped.marker").path))
        await credentials.release()
        try await ordinary.value
        try await explicit.value
        #expect(FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("stopped.marker").path))
    }

    @Test("An explicit stop after successful shutdown reacquires the lease and cannot mark a newer active owner")
    func lateExplicitStopIsFenced() async throws {
        let fixture = try HostFixture()
        defer { fixture.remove() }
        let host = try await fixture.start()
        try await host.shutdown()
        #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("stopped.marker").path))
        try await host.shutdown(deliberateStop: true)
        try await host.shutdown(deliberateStop: true)
        #expect(FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("stopped.marker").path))
        let next = try await fixture.start()
        await #expect(throws: NativeHeadlessHostError.ownerAlreadyRunning) { try await host.shutdown(deliberateStop: true) }
        #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("stopped.marker").path))
        try await next.shutdown()
    }

    @Test("Stopping an active owned CLI drains the real process before marking stopped")
    func activeChildShutdown() async throws {
        let fixture = try HostFixture()
        defer { fixture.remove() }
        let host = try await fixture.start(credentials: FixtureServiceCredentials(output: fixture.output, hang: true))
        try await host.registerBot(fixture.bot())
        let wait = try await host.registerWait(botId: "bot-a", prompt: "hold child", predicate: .botIdle)
        try await host.tick()
        try await waitUntil { FileManager.default.fileExists(atPath: fixture.output.path) }
        let pid = try #require(Int32(String(contentsOf: fixture.pid, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)))
        async let first: Void = host.shutdown(deliberateStop: true)
        async let second: Void = host.shutdown(deliberateStop: true)
        try await first
        try await second
        #expect(kill(pid, 0) == -1 && errno == ESRCH)
        #expect(await host.wait(id: wait.id)?.status == .held)
        #expect(FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("stopped.marker").path))
    }

    @Test("A busy checkpoint refuses the deliberate-stop marker and keeps the owner lease")
    func busyCheckpointFailsClosed() async throws {
        let fixture = try HostFixture()
        defer { fixture.remove() }
        let host = try await fixture.start(credentials: FixtureServiceCredentials(output: fixture.output))
        try await host.registerBot(fixture.bot())
        var reader: OpaquePointer?
        #expect(sqlite3_open_v2(fixture.database.path, &reader, SQLITE_OPEN_READONLY, nil) == SQLITE_OK)
        defer { sqlite3_close(reader) }
        #expect(sqlite3_exec(reader, "BEGIN; SELECT count(*) FROM messages;", nil, nil, nil) == SQLITE_OK)
        _ = try await host.registerWait(botId: "bot-a", prompt: "checkpoint fixture", predicate: .botIdle)
        try await host.tick()
        await host.waitForDispatches()
        await #expect(throws: DatabaseError.self) { try await host.shutdown(deliberateStop: true) }
        #expect(await host.state == .shutdownFailed)
        #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("stopped.marker").path))
        await #expect(throws: NativeHeadlessHostError.ownerAlreadyRunning) { _ = try await fixture.start() }
        #expect(sqlite3_exec(reader, "ROLLBACK;", nil, nil, nil) == SQLITE_OK)
    }

    @Test("A marker write failure is shared with later stop waiters and retains ownership")
    func markerFailureRetainsLease() async throws {
        let fixture = try HostFixture()
        defer { fixture.remove() }
        let host = try await fixture.start()
        let marker = fixture.root.appendingPathComponent("stopped.marker", isDirectory: true)
        try FileManager.default.createDirectory(at: marker, withIntermediateDirectories: false)
        await #expect(throws: (any Error).self) { try await host.shutdown(deliberateStop: true) }
        #expect(await host.state == .shutdownFailed)
        await #expect(throws: (any Error).self) { try await host.shutdown(deliberateStop: true) }
        await #expect(throws: NativeHeadlessHostError.ownerAlreadyRunning) { _ = try await fixture.start() }
        var isDirectory: ObjCBool = false
        #expect(FileManager.default.fileExists(atPath: marker.path, isDirectory: &isDirectory) && isDirectory.boolValue)
    }

    @Test("An explicit close is idempotent and refuses later database reads")
    func explicitClose() async throws {
        let database = try DatabaseService(path: ":memory:")
        try await database.checkpointAndClose()
        try await database.checkpointAndClose()
        await #expect(throws: DatabaseError.self) { _ = try await database.loadBots() }
    }

    @Test("Required input persistence fails before launching a provider and prevents successful drain")
    func requiredPersistenceFailsClosed() async throws {
        let fixture = try HostFixture()
        defer { fixture.remove() }
        let database = try DatabaseService(path: ":memory:")
        try await database.checkpointAndClose()
        let runner = ClaudeStreamRunner(executable: fixture.executable.path, launcher: ProcessSupervisorActor(baseEnvironment: [:]))
        let coordinator = EngineCoordinatorActor(drivers: [runner], dispatcher: TurnDispatcherActor(database: database,
            maxRetriesPerEngine: 0, requiresDurablePersistence: true))
        let stream = try await coordinator.sendTurn(input: TurnInput(threadId: "thread-a", botId: "bot-a", prompt: "fixture"))
        var failed = false
        for await event in stream {
            if case .error(let code, _) = event, code == "persistence_failed" { failed = true }
        }
        #expect(failed)
        #expect(!FileManager.default.fileExists(atPath: fixture.output.path))
        await #expect(throws: EngineDriverError.self) { try await coordinator.shutdownAndDrain() }
    }
}

private struct HostFixture {
    let parent: URL
    var root: URL { parent.appendingPathComponent("service", isDirectory: true) }
    var database: URL { root.appendingPathComponent("host.sqlite") }
    var output: URL { parent.appendingPathComponent("launches") }
    var pid: URL { URL(fileURLWithPath: output.path + ".pid") }
    var executable: URL { parent.appendingPathComponent("fixture-cli") }

    init() throws {
        parent = FileManager.default.temporaryDirectory.appendingPathComponent("native-host-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let script = #"""
        #!/bin/sh
        [ "$BF_FIXTURE_ALLOWED" = fixture-only ] || exit 91
        [ -n "$HOME" ] && [ -n "$TMPDIR" ] || exit 92
        for key in OPENAI_API_KEY ANTHROPIC_API_KEY XAI_API_KEY SIMPLE_TOOLS_BEARER; do
          /usr/bin/printenv "$key" >/dev/null 2>&1 && exit 93
        done
        IFS= read -r request || exit 94
        printf '%s\n' "$$" > "$BF_FIXTURE_OUTPUT.pid"
        printf '%s\n' "$request" >> "$BF_FIXTURE_OUTPUT"
        if [ "$BF_FIXTURE_HANG" = yes ]; then
          trap 'exit 0' TERM
          while :; do /bin/sleep 1; done
        fi
        printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"fixture reply"}]}}'
        printf '%s\n' '{"type":"result","is_error":false,"subtype":"success","usage":{"input_tokens":1,"output_tokens":1}}'
        """#
        try Data(script.utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
    }

    func bot(desktop: Bool = false) -> NativeHostBotConfiguration {
        NativeHostBotConfiguration(id: "bot-a", name: "Fixture Bot", threadId: "thread-a",
                                  claudeExecutable: executable.path, requiresDesktop: desktop)
    }
    func start(credentials: any NativeServiceCredentialSource = UnavailableNativeServiceCredentials()) async throws -> NativeHeadlessHost {
        try await NativeHeadlessHost.start(serviceData: root, credentials: credentials, pollIntervalSeconds: nil)
    }
    func launchCount() throws -> Int { try String(contentsOf: output, encoding: .utf8).split(separator: "\n").count }
    func remove() { try? FileManager.default.removeItem(at: parent) }
}

private struct FixtureServiceCredentials: NativeServiceCredentialSource {
    let output: URL
    var hang = false
    func credentials(forBotId botId: String) async throws -> NativeServiceCredentialResult {
        .available(environment: ["BF_FIXTURE_OUTPUT": output.path, "BF_FIXTURE_ALLOWED": "fixture-only", "BF_FIXTURE_HANG": hang ? "yes" : "no"])
    }
}

private struct ThrowingFixtureCredentials: NativeServiceCredentialSource {
    private struct Failure: LocalizedError {
        var errorDescription: String? { "synthetic-private-error" }
    }
    func credentials(forBotId botId: String) async throws -> NativeServiceCredentialResult { throw Failure() }
}

private actor ReentrantFixtureCredentials: NativeServiceCredentialSource {
    private var host: NativeHeadlessHost?
    var refused = false
    func attach(_ host: NativeHeadlessHost?) { self.host = host }
    func credentials(forBotId botId: String) async throws -> NativeServiceCredentialResult {
        do {
            try await host?.shutdown(deliberateStop: true)
        } catch NativeHeadlessHostError.reentrantShutdown {
            refused = true
        }
        return .unavailable
    }
}

private actor SwitchableFixtureCredentials: NativeServiceCredentialSource {
    let output: URL
    private var enabled = false
    init(output: URL) { self.output = output }
    func enable() { enabled = true }
    func credentials(forBotId botId: String) async throws -> NativeServiceCredentialResult {
        enabled ? try await FixtureServiceCredentials(output: output).credentials(forBotId: botId) : .unavailable
    }
}

private actor GatedFixtureCredentials: NativeServiceCredentialSource {
    let output: URL
    var entered = false
    private var continuation: CheckedContinuation<Void, Never>?
    init(output: URL) { self.output = output }
    func credentials(forBotId botId: String) async throws -> NativeServiceCredentialResult {
        entered = true
        await withCheckedContinuation { continuation = $0 }
        return try await FixtureServiceCredentials(output: output).credentials(forBotId: botId)
    }
    func release() { continuation?.resume(); continuation = nil }
}

private func waitUntil(_ condition: @escaping @Sendable () async -> Bool) async throws {
    for _ in 0..<250 {
        if await condition() { return }
        try await Task.sleep(nanoseconds: 20_000_000)
    }
    throw NativeHeadlessHostError.stopped
}
#endif
