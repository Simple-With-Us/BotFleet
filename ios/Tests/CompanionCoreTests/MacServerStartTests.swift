#if os(macOS)
import Foundation
import Testing
@testable import CompanionCore

// MARK: - A launchctl that answers from a script

/// Answers each launchctl request from a script and remembers every request.
///
/// Nothing here reaches launchd.  A verb without a scripted answer succeeds
/// quietly, and `list` answers from its own queue so a test can show the job
/// appearing behind its label, or never appearing at all.
private final class ScriptedLaunchctl: MacCommandRunning, @unchecked Sendable {
    typealias Answer = (status: Int32, output: String, error: String)

    private let lock = NSLock()
    private var requests: [[String]] = []
    private var answers: [String: Answer] = [:]
    private var listings: [(status: Int32, output: String)] = []
    private var runnerMissing = false
    /// Verbs the runner cannot answer at all, as a launchctl that timed out
    /// would not:  nil, not a refusal.
    private var silentVerbs: Set<String> = []

    /// The answer to one launchctl verb.
    func answering(_ verb: String, status: Int32 = 0, output: String = "", error: String = "") -> ScriptedLaunchctl {
        lock.lock(); defer { lock.unlock() }
        answers[verb] = (status, output, error)
        return self
    }

    /// One more answer to `launchctl list`, in order.  The last one repeats.
    func listing(_ output: String, status: Int32 = 0) -> ScriptedLaunchctl {
        lock.lock(); defer { lock.unlock() }
        listings.append((status, output))
        return self
    }

    /// Leaves one verb unanswered, as a launchctl that timed out would.
    func notAnswering(_ verb: String) -> ScriptedLaunchctl {
        lock.lock(); defer { lock.unlock() }
        silentVerbs.insert(verb)
        return self
    }

    /// Makes the runner answer nil, as it does when it cannot run anything.
    func disappearing() -> ScriptedLaunchctl {
        lock.lock(); defer { lock.unlock() }
        runnerMissing = true
        return self
    }

    func run(executable: String, arguments: [String]) async -> MacCommandOutcome? {
        //  `withLock` rather than `lock()`/`unlock()`:  the raw pair is
        //  unavailable from an async context in Swift 6.
        lock.withLock {
            requests.append([executable] + arguments)
            if runnerMissing { return nil }
            let verb = arguments.first ?? ""
            if silentVerbs.contains(verb) { return nil }
            if verb == "list", !listings.isEmpty {
                let answer = listings.count > 1 ? listings.removeFirst() : listings[0]
                return MacCommandOutcome(output: answer.output, status: answer.status)
            }
            let answer = answers[verb] ?? (0, "", "")
            return MacCommandOutcome(output: answer.output, status: answer.status, errorOutput: answer.error)
        }
    }

    /// The verbs asked of launchctl, in order.
    var verbs: [String] {
        lock.lock(); defer { lock.unlock() }
        return requests.map { $0[1] }
    }

    /// Every request in full:  the executable, then its arguments.
    var recordedRequests: [[String]] {
        lock.lock(); defer { lock.unlock() }
        return requests
    }
}

/// Remembers how long the controller was asked to wait, without waiting.
private final class Pauses: @unchecked Sendable {
    private let lock = NSLock()
    private var seconds: [TimeInterval] = []

    func pause(_ interval: TimeInterval) async {
        lock.withLock { seconds.append(interval) }
    }

    var recorded: [TimeInterval] {
        lock.lock(); defer { lock.unlock() }
        return seconds
    }
}

// MARK: - A harness port that refuses the connection

private final class MacServerStartStubURLProtocol: URLProtocol {
    nonisolated(unsafe) private static var failure = URLError(.badServerResponse)

    static func fail(with error: URLError) { failure = error }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: Self.failure)
    }

    override func stopLoading() {}
}

// MARK: - The Fixture

private struct StartFixture {
    let root: URL
    let home: URL
    let store: MacStartupPolicyStore
    let plist: URL
    var marker: URL { store.stoppedMarker() }
    var session: URL { store.sessionFile() }
}

// MARK: - The Suite

@Suite("BotFleetMac Start Server", .serialized)
struct MacServerStartTests {
    private static let label = MacStartupPolicyStore.serverAgentLabel
    private static let service = "gui/501/\(MacStartupPolicyStore.serverAgentLabel)"
    private static let boot = "B4D5E6F7-1111-2222-3333-444455556666"
    private static let runningListing = """
    PID\tStatus\tLabel
    431\td0\tcom.apple.InputMethodKit_XPC
    5091\td0\tapp.botfleet.server
    -\td0\tcom.apple.mdworker
    """
    private static let stoppedListing = """
    PID\tStatus\tLabel
    431\td0\tcom.apple.InputMethodKit_XPC
    -\td0\tapp.botfleet.server
    -\td0\tcom.apple.mdworker
    """
    private static let stoppedBytes = Data("stopped by the owner on 2026-11-20 at 8:45 PM\n".utf8)

    private func makeFixture(
        wrapperSupportsPolicy: Bool = true,
        installsPlist: Bool = true
    ) throws -> StartFixture {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("botfleet-server-start-\(UUID().uuidString)", isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let agents = home.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
        let apps = home.appendingPathComponent("apps", isDirectory: true)
        let dataDir = root.appendingPathComponent("data", isDirectory: true)
        for directory in [home, agents, apps, dataDir] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        let wrapper = apps.appendingPathComponent("botfleet-server-start.sh", isDirectory: false)
        let source = wrapperSupportsPolicy ? "#!/bin/sh\n# BF_CONTROL_STARTUP_POLICY_V1\n" : "#!/bin/sh\n"
        try Data(source.utf8).write(to: wrapper)
        let plist = agents.appendingPathComponent("\(MacStartupPolicyStore.serverAgentLabel).plist", isDirectory: false)
        if installsPlist { try Data("<plist/>\n".utf8).write(to: plist) }
        let store = MacStartupPolicyStore(dataDir: dataDir, home: home, wrapper: wrapper)
        return StartFixture(root: root, home: home, store: store, plist: plist)
    }

    private func remove(_ fixture: StartFixture) {
        try? FileManager.default.removeItem(at: fixture.root)
    }

    private func makeController(
        _ fixture: StartFixture,
        launchctl: ScriptedLaunchctl,
        pauses: Pauses = Pauses(),
        bootSession: @escaping () throws -> String = { MacServerStartTests.boot }
    ) -> (MacServerLaunchController, Pauses) {
        let controller = MacServerLaunchController(
            store: fixture.store,
            commands: launchctl,
            uid: 501,
            bootSession: bootSession,
            pause: { seconds in await pauses.pause(seconds) }
        )
        return (controller, pauses)
    }

    private func makeStubbedSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MacServerStartStubURLProtocol.self]
        return URLSession(configuration: config)
    }

    private func markerExists(_ fixture: StartFixture) -> Bool {
        FileManager.default.fileExists(atPath: fixture.marker.path)
    }

    // MARK: - Reading The Job

    @Test("The listing's row for the label states running, stopped or not loaded")
    func testTheListingIsReadByItsLabel() {
        #expect(MacInstalledServerState.state(fromListing: Self.runningListing, label: Self.label) == .running)
        #expect(MacInstalledServerState.state(fromListing: Self.stoppedListing, label: Self.label) == .stopped)
        //  A label that is only a prefix of another row's is not this job.
        #expect(MacInstalledServerState.state(fromListing: "5091\td0\tapp.botfleet.server.helper\n", label: Self.label) == .stopped)
        #expect(MacInstalledServerState.state(fromListing: "PID\tStatus\tLabel\n", label: Self.label) == .stopped)
        #expect(MacInstalledServerState.state(fromListing: "", label: Self.label) == .stopped)
    }

    @Test("The state is not installed when the plist is missing, whatever launchd says")
    func testTheJobIsNotInstalledWithoutItsPlist() async throws {
        let fixture = try makeFixture(installsPlist: false)
        defer { remove(fixture) }
        let launchctl = ScriptedLaunchctl().listing(Self.runningListing)
        let (controller, _) = makeController(fixture, launchctl: launchctl)

        let state = await controller.installedServerState()

        #expect(state == .notInstalled)
        #expect(launchctl.verbs.isEmpty, "launchd is not asked about a job that is not installed")
    }

    @Test("The state is unknown when launchd cannot be asked, and not stopped")
    func testAnUnaskedLaunchdIsUnknown() async throws {
        let fixture = try makeFixture()
        defer { remove(fixture) }
        for launchctl in [ScriptedLaunchctl().listing("", status: 113), ScriptedLaunchctl().disappearing()] {
            let (controller, _) = makeController(fixture, launchctl: launchctl)

            let state = await controller.installedServerState()

            #expect(state == .unknown)
        }
    }

    @Test("A reply that did not finish is not read as success")
    func testAnUnfinishedCommandDidNotSucceed() {
        let finished = MacCommandOutcome(output: "5091\td0\tapp.botfleet.server", status: 0, complete: true)
        let cutOff = MacCommandOutcome(output: "5091\td0\tapp.botfleet.server", status: 0, complete: false)
        let refused = MacCommandOutcome(output: "", status: 113, errorOutput: "Could not find service")
        #expect(finished.succeeded)
        #expect(!cutOff.succeeded)
        #expect(!refused.succeeded)
    }

    // MARK: - Whether To Offer The Start

    @Test("The start is offered only when the port refused, the wrapper is current and no process is behind the label")
    func testTheOfferNeedsThreeFactsThatAgree() {
        let gap = "\u{00A0} "
        let refusal = MacServerLaunchController.startRefusal
        #expect(refusal(true, .refused, .stopped) == nil)

        #expect(refusal(false, .refused, .stopped) == MacStartupPolicyError.updateRequired.localizedDescription)
        #expect(refusal(true, .refused, .notInstalled) == MacServerStartError.launchAgentMissing.localizedDescription)
        //  The BF-2527 lesson:  a job with a live process that refuses the
        //  connection is unresponsive, not stopped, and is not offered a start.
        #expect(refusal(true, .refused, .running)
            == "The BotFleet Server is running but not answering.\(gap)Wait a moment, then refresh.")
        #expect(refusal(true, .answering, .stopped) == "The BotFleet Server is already running.")
        #expect(refusal(true, .answering, .running) == "The BotFleet Server is already running.")
        #expect(refusal(true, .unknown, .stopped)
            == "The BotFleet Server has not answered yet.\(gap)Wait a moment, then refresh.")
        #expect(refusal(true, .refused, .unknown)
            == "This Mac could not say whether the BotFleet Server is running.\(gap)Open this section again to re-check.")
        #expect(refusal(true, .refused, nil)
            == "This Mac has not said whether the BotFleet Server is installed yet.\(gap)Open this section again to re-check.")
    }

    @Test("Every refusal is one sentence or nil, never an empty or half-written line")
    func testEveryRefusalIsReadable() {
        let refusal = MacServerLaunchController.startRefusal
        let states: [MacInstalledServerState?] = [nil, .notInstalled, .stopped, .running, .unknown]
        for supported in [true, false] {
            for presence in [MacServerPresence.answering, .refused, .unknown] {
                for state in states {
                    guard let message = refusal(supported, presence, state) else {
                        //  The one combination that is offered.
                        #expect(supported && presence == .refused && state == .stopped)
                        continue
                    }
                    #expect(!message.trimmingCharacters(in: .whitespaces).isEmpty)
                    #expect(!message.hasSuffix(" ") && !message.hasSuffix(".\u{00A0}"))
                    //  A second sentence is separated the way the copy rules
                    //  ask, so no rendered surface collapses the gap.
                    #expect(message.range(of: #"[.!?] [A-Z]"#, options: .regularExpression) == nil)
                }
            }
        }
    }

    @Test("Only a refused connection counts as nothing listening")
    func testPresenceNeedsARefusedConnection() {
        #expect(MacServerPresence.after(status: MacControlStatus(activeBotCount: 0, localVms: []), error: nil) == .answering)
        #expect(MacServerPresence.after(status: nil, error: .notReachable) == .refused)
        #expect(MacServerPresence.after(status: nil, error: nil) == .unknown)
        for error in [MacControlStatusError.invalidResponse, .invalidURL, .outdatedServer, .foreignService,
                      .httpError(statusCode: 503, message: "starting")] {
            #expect(MacServerPresence.after(status: nil, error: error) == .unknown)
        }
        //  A failed read keeps the last known status beside the reason it
        //  failed, so a status is only evidence while no error contradicts
        //  it:  a server that answered and has since stopped still shows its
        //  status, and it is the refusal that says it is down.
        let stale = MacControlStatus(activeBotCount: 3, localVms: [])
        #expect(MacServerPresence.after(status: stale, error: .notReachable) == .refused)
        #expect(MacServerPresence.after(status: stale, error: .outdatedServer) == .unknown)
        #expect(MacServerPresence.after(status: stale, error: nil) == .answering)
    }

    @Test("A refused connection is told apart from a reply that could not be read")
    func testARefusedConnectionIsItsOwnAnswer() async {
        let client = MacControlStatusClient(
            baseURL: URL(string: "http://127.0.0.1:8799")!,
            session: makeStubbedSession()
        )
        MacServerStartStubURLProtocol.fail(with: URLError(.cannotConnectToHost))
        do {
            _ = try await client.fetchStatus()
            Issue.record("The read should have failed.")
        } catch let error as MacControlStatusError {
            #expect(error == .notReachable)
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
        //  A timeout and a broken reply both mean something is there that did
        //  not answer, which is not proof the server is down.
        for failure in [URLError(.timedOut), URLError(.badServerResponse), URLError(.networkConnectionLost)] {
            MacServerStartStubURLProtocol.fail(with: failure)
            do {
                _ = try await client.fetchStatus()
                Issue.record("The read should have failed.")
            } catch let error as MacControlStatusError {
                #expect(error == .invalidResponse)
            } catch {
                Issue.record("Unexpected error: \(error)")
            }
        }
    }

    // MARK: - Starting

    @Test("A start enables, loads and kickstarts the job, and records the choice")
    func testAStartRunsTheThreeRequestsInOrder() async throws {
        let fixture = try makeFixture()
        defer { remove(fixture) }
        try Self.stoppedBytes.write(to: fixture.marker)
        //  launchd does not know the job yet, so `print` is refused.
        let launchctl = ScriptedLaunchctl().answering("print", status: 113, error: "Could not find service")
        let (controller, _) = makeController(fixture, launchctl: launchctl)

        let deliberateStop = try await controller.startServer()

        #expect(deliberateStop.wasStoppedByOwner)
        #expect(launchctl.recordedRequests == [
            ["/bin/launchctl", "enable", Self.service],
            ["/bin/launchctl", "print", Self.service],
            ["/bin/launchctl", "bootstrap", "gui/501", fixture.plist.path],
            ["/bin/launchctl", "kickstart", Self.service],
        ])
        #expect(!markerExists(fixture), "a deliberate start lifts the deliberate stop")
        let recorded = try String(contentsOf: fixture.session, encoding: .utf8)
        #expect(recorded == Self.boot + "\n")
        let attributes = try FileManager.default.attributesOfItem(atPath: fixture.session.path)
        let permissions = attributes[.posixPermissions] as? Int
        #expect(permissions == 0o600)
    }

    @Test("A job launchd already loaded is kickstarted and not loaded twice")
    func testALoadedJobIsNotBootstrappedAgain() async throws {
        let fixture = try makeFixture()
        defer { remove(fixture) }
        let launchctl = ScriptedLaunchctl().answering("print", output: "program = /bin/sh\n")
        let (controller, _) = makeController(fixture, launchctl: launchctl)

        _ = try await controller.startServer()

        #expect(launchctl.verbs == ["enable", "print", "kickstart"])
    }

    @Test("A print that cannot be answered does not bootstrap, and says launchd was not asked")
    func testAPrintThatCannotBeAnsweredDoesNotBootstrap() async throws {
        let fixture = try makeFixture()
        defer { remove(fixture) }
        try Self.stoppedBytes.write(to: fixture.marker)
        let launchctl = ScriptedLaunchctl().notAnswering("print")
        let (controller, _) = makeController(fixture, launchctl: launchctl)

        do {
            _ = try await controller.startServer()
            Issue.record("The start should have been refused.")
        } catch let error as MacServerStartError {
            #expect(error == .launchdNotAsked(operation: "print"))
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
        //  No second request is stacked on a job that may already be loaded.
        #expect(launchctl.verbs == ["enable", "print"])
        let restored = try Data(contentsOf: fixture.marker)
        #expect(restored == Self.stoppedBytes)
    }

    @Test("A print refused for any other reason is not read as an empty slot")
    func testAPrintRefusedForAnotherReasonDoesNotBootstrap() async throws {
        let fixture = try makeFixture()
        defer { remove(fixture) }
        let launchctl = ScriptedLaunchctl().answering("print", status: 1, error: "Operation not permitted")
        let (controller, _) = makeController(fixture, launchctl: launchctl)

        do {
            _ = try await controller.startServer()
            Issue.record("The start should have been refused.")
        } catch let error as MacServerStartError {
            //  The refusal names the failed request, and the explanation is
            //  launchctl's own rather than an invented one.
            if case .launchdRefused(let operation, let detail) = error {
                #expect(operation == "print")
                #expect(detail == "Operation not permitted")
            } else {
                Issue.record("unexpected refusal: \(error)")
            }
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
        #expect(launchctl.verbs == ["enable", "print"], "no bootstrap after a refusal it cannot read as not-loaded")
    }

    @Test("Only launchd's own not-loaded answers count as an empty slot")
    func testOnlyNotLoadedAnswersReadAsEmpty() {
        #expect(MacServerLaunchController.saysNotLoaded(MacCommandOutcome(output: "", status: 113)))
        #expect(MacServerLaunchController.saysNotLoaded(MacCommandOutcome(output: "Could not find service \"app.botfleet.server\" in domain", status: 1)))
        #expect(MacServerLaunchController.saysNotLoaded(MacCommandOutcome(output: "", status: 3, errorOutput: "No such process")))
        //  Anything else is launchd refusing to answer, not an empty slot.
        #expect(!MacServerLaunchController.saysNotLoaded(MacCommandOutcome(output: "", status: 1, errorOutput: "Operation not permitted")))
        #expect(!MacServerLaunchController.saysNotLoaded(MacCommandOutcome(output: "program = /bin/sh", status: 0)))
    }

    @Test("A stop that could not be put back says so instead of claiming it was")
    func testAStopThatCouldNotBeRestoredSaysSo() {
        let gap = "\u{00A0} "
        #expect(MacServerStartOutcome.stopNotRestored.message
            == "The BotFleet Server did not stay running, and the earlier stop could not be put back.\(gap)Stop the server again to restore it.")
        //  And it is a different outcome from the one that claims a restore,
        //  so a caller cannot confuse the two.
        #expect(MacServerStartOutcome.stopNotRestored != MacServerStartOutcome.didNotStart(restoredStop: true))
        #expect(MacServerStartOutcome.stopNotRestored != MacServerStartOutcome.didNotStart(restoredStop: false))
    }

    @Test("A launchctl refusal puts the deliberate stop back byte for byte")
    func testARefusedRequestRestoresTheStop() async throws {
        for (verb, detail, expected) in [
            ("enable", "Boot-out in progress", MacServerStartError.launchdRefused(operation: "enable", detail: "Boot-out in progress")),
            ("kickstart", "", MacServerStartError.launchdRefused(operation: "start", detail: "")),
        ] {
            let fixture = try makeFixture()
            defer { remove(fixture) }
            try Self.stoppedBytes.write(to: fixture.marker)
            let launchctl = ScriptedLaunchctl().answering("print", status: 113).answering(verb, status: 1, error: detail)
            let (controller, _) = makeController(fixture, launchctl: launchctl)

            do {
                _ = try await controller.startServer()
                Issue.record("The start should have been refused by \(verb).")
            } catch let error as MacServerStartError {
                #expect(error == expected)
            } catch {
                Issue.record("Unexpected error: \(error)")
            }

            let restored = try Data(contentsOf: fixture.marker)
            #expect(restored == Self.stoppedBytes, "\(verb) was refused, so the stop goes back byte for byte")
            //  Nothing runs after the request that was refused.
            #expect(launchctl.verbs.last == verb)
            #expect(!launchctl.verbs.contains("kickstart") || verb == "kickstart")
        }
    }

    @Test("A runner that cannot ask launchd is reported, and the stop is put back")
    func testALaunchdThatCannotBeAskedIsReported() async throws {
        let fixture = try makeFixture()
        defer { remove(fixture) }
        try Self.stoppedBytes.write(to: fixture.marker)
        let launchctl = ScriptedLaunchctl().disappearing()
        let (controller, _) = makeController(fixture, launchctl: launchctl)

        do {
            _ = try await controller.startServer()
            Issue.record("The start should have been refused.")
        } catch let error as MacServerStartError {
            #expect(error == .launchdNotAsked(operation: "enable"))
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
        let restored = try Data(contentsOf: fixture.marker)
        #expect(restored == Self.stoppedBytes)
    }

    @Test("launchctl's own explanation is kept to one readable line")
    func testTheExplanationIsOneBoundedLine() {
        let long = String(repeating: "Could not bootstrap service \n", count: 60)
        let line = MacServerStartError.explanation(from: long)
        #expect(!line.contains("\n"))
        #expect(line.count == MacServerLaunchController.maximumExplanationLength + 1)
        #expect(line.hasSuffix("…"))
        #expect(MacServerStartError.explanation(from: " \n ") == "")
        let gap = "\u{00A0} "
        #expect(MacServerStartError.launchdRefused(operation: "start", detail: "Service is disabled").localizedDescription
            == "macOS could not start the BotFleet Server LaunchAgent.\(gap)Service is disabled")
        #expect(MacServerStartError.launchdNotAsked(operation: "load").localizedDescription
            == "macOS could not be asked to load the BotFleet Server LaunchAgent.\(gap)Try again.")
    }

    // MARK: - What Is Refused Before Anything Is Touched

    @Test("A wrapper from before the policy is refused, and nothing is written or asked")
    func testAnOlderWrapperIsRefusedFirst() async throws {
        let fixture = try makeFixture(wrapperSupportsPolicy: false)
        defer { remove(fixture) }
        try Self.stoppedBytes.write(to: fixture.marker)
        let launchctl = ScriptedLaunchctl()
        let (controller, _) = makeController(fixture, launchctl: launchctl)

        do {
            _ = try await controller.startServer()
            Issue.record("The start should have been refused.")
        } catch let error as MacServerStartError {
            #expect(error == .updateRequired)
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
        #expect(launchctl.verbs.isEmpty)
        let marker = try Data(contentsOf: fixture.marker)
        #expect(marker == Self.stoppedBytes)
        #expect(!FileManager.default.fileExists(atPath: fixture.session.path))
    }

    @Test("A missing LaunchAgent is refused, and the stop is left alone")
    func testAMissingLaunchAgentIsRefused() async throws {
        let fixture = try makeFixture(installsPlist: false)
        defer { remove(fixture) }
        try Self.stoppedBytes.write(to: fixture.marker)
        let launchctl = ScriptedLaunchctl()
        let (controller, _) = makeController(fixture, launchctl: launchctl)

        do {
            _ = try await controller.startServer()
            Issue.record("The start should have been refused.")
        } catch let error as MacServerStartError {
            #expect(error == .launchAgentMissing)
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
        #expect(launchctl.verbs.isEmpty)
        let marker = try Data(contentsOf: fixture.marker)
        #expect(marker == Self.stoppedBytes)
    }

    /// The refusal a bare start ends with, or nil when it did not refuse or
    /// refused with an error that is not this controller's own.
    private func bareStartRefusal(_ controller: MacServerLaunchController) async -> MacServerStartError? {
        do {
            _ = try await controller.startServer()
            return nil
        } catch let error as MacServerStartError {
            return error
        } catch {
            Issue.record("The start refused with an error that is not the controller's own: \(error)")
            return nil
        }
    }

    @Test("Without a usable boot session nothing is recorded, cleared or started")
    func testAnUnusableBootSessionStopsTheStart() async throws {
        let fixture = try makeFixture()
        defer { remove(fixture) }
        try Self.stoppedBytes.write(to: fixture.marker)
        let launchctl = ScriptedLaunchctl()
        //  Empty, whitespace, and something that is not a boot session are
        //  each refused.  The wrapper compares the recorded session byte for
        //  byte, so none of them could ever match the boot it is running in.
        for answer in ["", "   ", "not-a-boot-session", "\(Self.boot)-extra"] {
            let (controller, _) = makeController(fixture, launchctl: launchctl, bootSession: { answer })
            let refusal = await bareStartRefusal(controller)
            #expect(refusal == .bootSessionUnavailable)
        }
        //  A reader that fails with an error of its own is the controller's
        //  one refusal too, and not the reader's error passed through.
        let (failing, _) = makeController(
            fixture,
            launchctl: launchctl,
            bootSession: { throw MacStartupPolicyError.bootSessionUnavailable }
        )
        let passedThrough = await bareStartRefusal(failing)
        #expect(passedThrough == .bootSessionUnavailable)
        #expect(launchctl.verbs.isEmpty)
        let marker = try Data(contentsOf: fixture.marker)
        #expect(marker == Self.stoppedBytes)
        #expect(!FileManager.default.fileExists(atPath: fixture.session.path))
    }

    @Test("A boot session is recorded trimmed, in the case the reader gave it")
    func testTheBootSessionIsRecordedTrimmedAndVerbatim() async throws {
        let fixture = try makeFixture()
        defer { remove(fixture) }
        let uppercased = Self.boot.uppercased()
        let (controller, _) = makeController(
            fixture,
            launchctl: ScriptedLaunchctl(),
            bootSession: { "  \(uppercased)\n" }
        )

        _ = try await controller.startServer()

        let recorded = try String(contentsOf: fixture.session, encoding: .utf8)
        #expect(recorded == uppercased + "\n")
    }

    @Test("A deliberate stop that cannot be read safely is left in place")
    func testAnUnsafeStopMarkerIsRefused() async throws {
        let fixture = try makeFixture()
        defer { remove(fixture) }
        let elsewhere = fixture.root.appendingPathComponent("elsewhere.txt", isDirectory: false)
        try Self.stoppedBytes.write(to: elsewhere)
        let launchctl = ScriptedLaunchctl()

        //  A link, a folder, and a file far past the bound are each refused
        //  rather than cleared:  none of them is a stop this app understands.
        try FileManager.default.createSymbolicLink(at: fixture.marker, withDestinationURL: elsewhere)
        for unsafe in 0 ..< 3 {
            if unsafe == 1 {
                try FileManager.default.removeItem(at: fixture.marker)
                try FileManager.default.createDirectory(at: fixture.marker, withIntermediateDirectories: false)
            }
            if unsafe == 2 {
                try FileManager.default.removeItem(at: fixture.marker)
                try Data(repeating: 0x2E, count: MacServerLaunchController.maximumStopMarkerBytes + 1).write(to: fixture.marker)
            }
            let (controller, _) = makeController(fixture, launchctl: launchctl)
            do {
                _ = try await controller.startServer()
                Issue.record("The start should have been refused.")
            } catch let error as MacServerStartError {
                #expect(error == .stopMarkerUnreadable)
            } catch {
                Issue.record("Unexpected error: \(error)")
            }
        }
        #expect(launchctl.verbs.isEmpty)
        let untouched = try Data(contentsOf: elsewhere)
        #expect(untouched == Self.stoppedBytes)
        #expect(!FileManager.default.fileExists(atPath: fixture.session.path))
    }

    // MARK: - Whether It Came Up

    @Test("A process still behind the label when the wait ends is the start")
    func testAProcessStillThereWhenTheWaitEndsIsTheStart() async throws {
        let fixture = try makeFixture()
        defer { remove(fixture) }
        try Self.stoppedBytes.write(to: fixture.marker)
        let launchctl = ScriptedLaunchctl().answering("print", status: 113)
            .listing(Self.stoppedListing)
            .listing(Self.stoppedListing)
            .listing(Self.runningListing)
        let (controller, pauses) = makeController(fixture, launchctl: launchctl)

        let outcome = try await controller.startServerAndSettle()

        #expect(outcome == .started)
        //  The whole window is watched even once the process is there:  one
        //  look proves only that launchd spawned something.
        #expect(pauses.recorded == Array(repeating: 0.25, count: MacServerLaunchController.settleAttempts - 1))
        #expect(!markerExists(fixture))
    }

    @Test("A process that appears and is then gone is not a start, and the stop goes back")
    func testAProcessThatComesAndGoesIsNotAStart() async throws {
        let fixture = try makeFixture()
        defer { remove(fixture) }
        try Self.stoppedBytes.write(to: fixture.marker)
        //  The wrapper shows a process for a moment before it leaves when its
        //  policy or the stop marker says no.
        let launchctl = ScriptedLaunchctl().answering("print", status: 113)
            .listing(Self.stoppedListing)
            .listing(Self.runningListing)
            .listing(Self.runningListing)
            .listing(Self.stoppedListing)
        let (controller, _) = makeController(fixture, launchctl: launchctl)

        let outcome = try await controller.startServerAndSettle()

        #expect(outcome == .didNotStart(restoredStop: true))
        let restored = try Data(contentsOf: fixture.marker)
        #expect(restored == Self.stoppedBytes)
    }

    @Test("A start that brings no process puts the deliberate stop back exactly as it was")
    func testNoProcessMeansTheStopGoesBack() async throws {
        let fixture = try makeFixture()
        defer { remove(fixture) }
        try Self.stoppedBytes.write(to: fixture.marker)
        let launchctl = ScriptedLaunchctl().answering("print", status: 113).listing(Self.stoppedListing)
        let (controller, pauses) = makeController(fixture, launchctl: launchctl)

        let outcome = try await controller.startServerAndSettle()

        #expect(outcome == .didNotStart(restoredStop: true))
        #expect(pauses.recorded == Array(repeating: 0.25, count: MacServerLaunchController.settleAttempts - 1))
        let restored = try Data(contentsOf: fixture.marker)
        #expect(restored == Self.stoppedBytes)
    }

    @Test("A start with no deliberate stop restores nothing")
    func testNothingIsRestoredWhenThereWasNoStop() async throws {
        let fixture = try makeFixture()
        defer { remove(fixture) }
        let launchctl = ScriptedLaunchctl().answering("print", status: 113).listing(Self.stoppedListing)
        let (controller, _) = makeController(fixture, launchctl: launchctl)

        let outcome = try await controller.startServerAndSettle()

        #expect(outcome == .didNotStart(restoredStop: false))
        #expect(!markerExists(fixture), "a stop the owner never asked for is not invented")
    }

    @Test("When launchd goes quiet the stop stays lifted, because nothing was proven")
    func testAnUnaskedLaunchdLeavesTheStopLifted() async throws {
        let fixture = try makeFixture()
        defer { remove(fixture) }
        try Self.stoppedBytes.write(to: fixture.marker)
        let launchctl = ScriptedLaunchctl().answering("print", status: 113)
            .listing(Self.stoppedListing)
            .listing("", status: 113)
        let (controller, pauses) = makeController(fixture, launchctl: launchctl)

        let outcome = try await controller.startServerAndSettle()

        //  A launchd that stops answering is asked again for as long as the
        //  wait lasts:  one refusal to answer is not a state.  What is seen
        //  last is what is reported, and an unknown state proves nothing, so
        //  the deliberate stop this start lifted is not put back on it.
        #expect(outcome == .stateUnknown)
        #expect(pauses.recorded.count == MacServerLaunchController.settleAttempts - 1)
        #expect(!markerExists(fixture))
    }

    @Test("The wait is bounded whatever it is given")
    func testTheWaitIsBounded() async throws {
        let fixture = try makeFixture()
        defer { remove(fixture) }
        let launchctl = ScriptedLaunchctl().answering("print", status: 113).listing(Self.stoppedListing)
        for (attempts, interval, expectedPauses) in [(0, 0.25, 0), (-7, 0.25, 0), (1_000, 0.25, 63), (8, -1, 7), (8, 600, 7)] {
            let (controller, pauses) = makeController(fixture, launchctl: launchctl)
            let outcome = try await controller.startServerAndSettle(attempts: attempts, interval: interval)
            #expect(outcome == .didNotStart(restoredStop: false))
            #expect(pauses.recorded.count == expectedPauses)
            //  A negative or enormous pause would trap the conversion to
            //  nanoseconds, so it is clamped to zero rather than passed on.
            #expect(pauses.recorded.allSatisfy { $0 >= 0 && $0 <= 60 })
        }
    }

    @Test("Each outcome says what happened in one sentence")
    func testEachOutcomeSaysWhatHappened() {
        let gap = "\u{00A0} "
        #expect(MacServerStartOutcome.started.message == "Started the BotFleet Server.\(gap)It answers on the next status read.")
        #expect(MacServerStartOutcome.didNotStart(restoredStop: true).message
            == "The BotFleet Server did not stay running, so the earlier stop is back in place.\(gap)Check the server log, then try again.")
        #expect(MacServerStartOutcome.didNotStart(restoredStop: false).message
            == "The BotFleet Server did not stay running.\(gap)Check the server log, then try again.")
        #expect(MacServerStartOutcome.stateUnknown.message
            == "The BotFleet Server was asked to start, but this Mac could not say whether it is running.\(gap)Open this section again to re-check.")
    }

    // MARK: - The Real Runner

    @Test("The real runner speaks to launchctl and to nothing else")
    func testTheRealRunnerSpeaksOnlyToLaunchctl() async {
        let runner = MacLaunchctlRunner()
        //  None of these is run, so nothing is asked of this Mac's launchd:
        //  the runner answers nil before a process is started.
        let processList = await runner.run(executable: "/bin/ps", arguments: ["-ax"])
        let shell = await runner.run(executable: "/bin/sh", arguments: ["-c", "launchctl list"])
        let bare = await runner.run(executable: "/usr/bin/true", arguments: [])
        #expect(processList == nil)
        #expect(shell == nil)
        #expect(bare == nil)
    }
}
#endif
