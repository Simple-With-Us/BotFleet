import XCTest
@testable import BotFleetControlCore

final class ControlTests: XCTestCase {
    func testNoImplicitNetworkCalls() {
        MockURLProtocol.requests = []
        _ = ControlAPI(session: mockSession())
        XCTAssertTrue(MockURLProtocol.requests.isEmpty)
    }

    func testRejectsForeignHealthBeforeMutation() async {
        MockURLProtocol.handler = { request in
            (200, Data(#"{"app":"other","pid":1}"#.utf8))
        }
        let api = ControlAPI(session: mockSession())
        do { try await api.stopVMs(); XCTFail("Expected identity refusal") }
        catch { XCTAssertEqual(error as? ControlAPIError, .foreignService) }
        XCTAssertEqual(MockURLProtocol.requests.map(\.url!.path), ["/api/health"])
    }

    func testMalformedStatusIsNotReportedAsRunning() async {
        MockURLProtocol.handler = { request in
            if request.url!.path == "/api/health" { return (200, Data(#"{"app":"botfleet","pid":42,"ready":true}"#.utf8)) }
            return (200, Data(#"{"activeBotCount":"bad"}"#.utf8))
        }
        do { _ = try await ControlAPI(session: mockSession()).status(); XCTFail("Expected invalid response") }
        catch { XCTAssertEqual(error as? ControlAPIError, .invalidResponse) }
    }

    func testOnlyMissingSharedVMCanStart() async throws {
        MockURLProtocol.handler = { request in
            if request.url!.path == "/api/health" { return (200, Data(#"{"app":"botfleet","pid":42,"ready":true}"#.utf8)) }
            return (200, Data(#"{"activeBotCount":0,"persistOnExit":true,"localVms":[{"key":"shared","name":"Shared Local VM","running":false,"state":"stopped"}]}"#.utf8))
        }
        let stopped = try await ControlAPI(session: mockSession()).status()
        XCTAssertFalse(stopped.canStartSharedVM)
        XCTAssertEqual(stopped.sharedVM?.state, "stopped")
        MockURLProtocol.handler = { request in
            if request.url!.path == "/api/health" { return (200, Data(#"{"app":"botfleet","pid":42,"ready":true}"#.utf8)) }
            return (200, Data(#"{"activeBotCount":0,"persistOnExit":true,"localVms":[{"key":"shared","name":"Shared Local VM","running":false,"state":"missing"}]}"#.utf8))
        }
        let missing = try await ControlAPI(session: mockSession()).status()
        XCTAssertTrue(missing.canStartSharedVM)
        MockURLProtocol.handler = { request in
            if request.url!.path == "/api/health" { return (200, Data(#"{"app":"botfleet","pid":42,"ready":true}"#.utf8)) }
            return (200, Data(#"{"activeBotCount":0,"persistOnExit":true,"localVms":[{"key":"shared","name":"Shared Local VM","running":false,"state":"created"}]}"#.utf8))
        }
        let created = try await ControlAPI(session: mockSession()).status()
        XCTAssertTrue(created.canStartSharedVM)
    }

    func testBusyRefusalIsSurfaced() async {
        MockURLProtocol.handler = { request in
            if request.url!.path == "/api/health" { return (200, Data(#"{"app":"botfleet","pid":42,"ready":true}"#.utf8)) }
            return (409, Data(#"{"error":"Active bot turn"}"#.utf8))
        }
        do { try await ControlAPI(session: mockSession()).stopServer(); XCTFail("Expected refusal") }
        catch { XCTAssertEqual(error as? ControlAPIError, .refused("Active bot turn")) }
    }

    /// A server that answers the health check but is too slow for the status
    /// route is running, not stopped.  Reporting it as unavailable would offer
    /// to start a server that is already up, and would grey out Start Local
    /// VM on a healthy machine.
    func testSlowServerIsUnresponsiveRatherThanUnavailable() async {
        MockURLProtocol.failure = { request in
            request.url!.path == "/api/system/control" ? URLError(.timedOut) : nil
        }
        defer { MockURLProtocol.failure = nil }
        MockURLProtocol.handler = { request in
            (200, Data(#"{"app":"botfleet","pid":42,"ready":true}"#.utf8))
        }
        do { _ = try await ControlAPI(session: mockSession()).status(); XCTFail("Expected unresponsive") }
        catch { XCTAssertEqual(error as? ControlAPIError, .unresponsive) }
    }

    /// A server that answers the health check as BotFleet but has no control
    /// route is running and older than this app.  Reporting that as a refusal
    /// left the menu calling an up server unresponsive, with every action
    /// greyed out (BF-2527).
    func testAServerWithoutTheControlRouteIsOutdatedRatherThanRefused() async {
        MockURLProtocol.handler = { request in
            if request.url!.path == "/api/health" { return (200, Data(#"{"app":"botfleet","pid":42,"ready":true}"#.utf8)) }
            return (404, Data(#"{"error":"no route: GET /api/system/control"}"#.utf8))
        }
        do { _ = try await ControlAPI(session: mockSession()).status(); XCTFail("Expected outdated server") }
        catch { XCTAssertEqual(error as? ControlAPIError, .outdatedServer) }
        XCTAssertEqual(MockURLProtocol.requests.map(\.url!.path), ["/api/health", "/api/system/control"])
    }

    /// A server older than Control cannot be asked to stop, so the marker is
    /// written and the LaunchAgent is booted out.  The agent is not disabled:
    /// the marker is the server's durable stop, and a disabled agent would
    /// defeat Start Server At Login.
    func testForceStopWritesTheMarkerAndBootsTheAgentOutWithoutDisablingIt() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        try FileManager.default.createDirectory(at: home.appendingPathComponent("Library/LaunchAgents"), withIntermediateDirectories: true)
        try Data().write(to: home.appendingPathComponent("Library/LaunchAgents/app.botfleet.server.plist"))
        let runner = MockCommands()
        let launchdAsked = try StartupPolicy(home: home, commands: runner, uid: 501, environment: [:]).forceStopServer()
        XCTAssertTrue(launchdAsked)
        XCTAssertTrue(FileManager.default.fileExists(atPath: home.appendingPathComponent(".botfleet/stopped.marker").path))
        XCTAssertEqual(runner.calls, ["/bin/launchctl bootout gui/501/app.botfleet.server"])
    }

    func testForceStopWithoutTheAgentWritesTheMarkerAndAsksLaunchdNothing() throws {
        // A server the desktop app forked has no plist.  The marker still
        // records the owner's stop, launchd is not asked, and the caller's
        // port check is what finds out whether the server is gone.
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let runner = MockCommands()
        let launchdAsked = try StartupPolicy(home: home, commands: runner, uid: 501, environment: [:]).forceStopServer()
        XCTAssertFalse(launchdAsked)
        XCTAssertTrue(FileManager.default.fileExists(atPath: home.appendingPathComponent(".botfleet/stopped.marker").path))
        XCTAssertTrue(runner.calls.isEmpty)
    }

    func testANonzeroBootoutDoesNotFailTheForceStop() throws {
        // launchctl bootout exits nonzero when the job was already gone and
        // while a teardown is still in progress, so its exit status proves
        // nothing.  The marker stays, nothing is thrown, and the caller's
        // port check decides.
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        try FileManager.default.createDirectory(at: home.appendingPathComponent("Library/LaunchAgents"), withIntermediateDirectories: true)
        try Data().write(to: home.appendingPathComponent("Library/LaunchAgents/app.botfleet.server.plist"))
        let runner = MockCommands()
        runner.failBootout = true
        let launchdAsked = try StartupPolicy(home: home, commands: runner, uid: 501, environment: [:]).forceStopServer()
        XCTAssertTrue(launchdAsked)
        XCTAssertTrue(FileManager.default.fileExists(atPath: home.appendingPathComponent(".botfleet/stopped.marker").path))
    }

    /// The outdated mapping covers every control route, not only the status
    /// read, so the Fleet Services stop path reads the same server the same
    /// way; a 404 on the health check itself is still a foreign service.
    func testEveryLocalControlRouteReadsA404AsAnOutdatedServer() async {
        MockURLProtocol.handler = { request in
            if request.url!.path == "/api/health" { return (200, Data(#"{"app":"botfleet","pid":42,"ready":true}"#.utf8)) }
            return (404, Data(#"{"error":"no route: POST /api/system/control/stop"}"#.utf8))
        }
        do { try await ControlAPI(session: mockSession()).stopServer(); XCTFail("Expected outdated server") }
        catch { XCTAssertEqual(error as? ControlAPIError, .outdatedServer) }
        MockURLProtocol.handler = { _ in (404, Data(#"{"error":"no route: GET /api/health"}"#.utf8)) }
        do { _ = try await ControlAPI(session: mockSession()).status(); XCTFail("Expected foreign service") }
        catch { XCTAssertEqual(error as? ControlAPIError, .foreignService) }
    }

    /// A remote host sits behind a gateway that can answer 404 for reasons of
    /// its own, so its 404 stays a refusal that carries the server's text.
    func testARemoteHostsMissingRouteStaysARefusal() async {
        MockURLProtocol.handler = { request in
            if request.url!.path == "/api/health" { return (200, Data(#"{"app":"botfleet","ready":true}"#.utf8)) }
            return (404, Data(#"{"error":"no route: GET /api/system/control"}"#.utf8))
        }
        let remote = ServerHost(name: "Remote", baseURL: URL(string: "https://remote.example")!, isLocal: false)
        do { _ = try await ControlAPI(session: mockSession(), host: remote).status(); XCTFail("Expected refusal") }
        catch { XCTAssertEqual(error as? ControlAPIError, .refused("no route: GET /api/system/control")) }
    }

    /// The menu's server line and its Stop offer, as pure functions of what
    /// the probe found.
    func testTheServerLineSaysOlderThanControlBeforeAnythingElse() {
        XCTAssertEqual(ManagedServices.serverStatusLine(apiUnavailable: false, serverOutdated: true, installedServerState: .running),
                       "Server: running, but older than Control")
        XCTAssertEqual(ManagedServices.serverStatusLine(apiUnavailable: false, serverOutdated: true, installedServerState: .notInstalled),
                       "Server: running, but older than Control")
        XCTAssertEqual(ManagedServices.serverStatusLine(apiUnavailable: true, serverOutdated: false, installedServerState: .stopped),
                       "Server: stopped")
        XCTAssertEqual(ManagedServices.serverStatusLine(apiUnavailable: false, serverOutdated: false, installedServerState: .notInstalled),
                       "Server: not installed")
        XCTAssertEqual(ManagedServices.serverStatusLine(apiUnavailable: false, serverOutdated: false, installedServerState: .running),
                       "Server: unresponsive")
        XCTAssertEqual(ManagedServices.serverStatusLine(apiUnavailable: false, serverOutdated: false, installedServerState: .unknown),
                       "Server: unknown")
    }

    func testStopIsOfferedForAnAnsweringServerAndForAnOutdatedOne() {
        XCTAssertTrue(ManagedServices.canStopServer(statusAvailable: true, serverOutdated: false))
        XCTAssertTrue(ManagedServices.canStopServer(statusAvailable: false, serverOutdated: true))
        XCTAssertFalse(ManagedServices.canStopServer(statusAvailable: false, serverOutdated: false))
    }

    /// A server that does not answer the health check at all really is gone.
    func testUnreachableServerIsStillUnavailable() async {
        MockURLProtocol.failure = { _ in URLError(.cannotConnectToHost) }
        defer { MockURLProtocol.failure = nil }
        do { _ = try await ControlAPI(session: mockSession()).status(); XCTFail("Expected unavailable") }
        catch { XCTAssertEqual(error as? ControlAPIError, .unavailable) }
    }

    /// The status route waits longer than the identity check, because the
    /// identity check is cheap and the status route is not.
    func testStatusProbeWaitsLongerThanTheIdentityCheck() async {
        MockURLProtocol.failure = nil
        MockURLProtocol.handler = { request in
            if request.url!.path == "/api/health" { return (200, Data(#"{"app":"botfleet","pid":42,"ready":true}"#.utf8)) }
            return (200, Data(#"{"activeBotCount":0,"persistOnExit":true,"localVms":[]}"#.utf8))
        }
        _ = try? await ControlAPI(session: mockSession()).status()
        let health = MockURLProtocol.requests.first { $0.url!.path == "/api/health" }
        let control = MockURLProtocol.requests.first { $0.url!.path == "/api/system/control" }
        XCTAssertEqual(health?.timeoutInterval, 3)
        XCTAssertEqual(control?.timeoutInterval, ControlAPI.statusTimeout)
        XCTAssertEqual(ControlAPI.statusTimeout, 30)
    }

    func testSuccessfulHTTPWithFailedActionIsRejected() async {
        MockURLProtocol.handler = { request in
            if request.url!.path == "/api/health" { return (200, Data(#"{"app":"botfleet","pid":42,"ready":true}"#.utf8)) }
            return (200, Data(#"{"ok":false}"#.utf8))
        }
        do { try await ControlAPI(session: mockSession()).stopVMs(); XCTFail("Expected failure") }
        catch { XCTAssertEqual(error as? ControlAPIError, .invalidResponse) }
    }

    func testStartupPolicyRequiresSupportedWrapperAndDoesNotStartWhenToggling() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        try FileManager.default.createDirectory(at: home.appendingPathComponent("apps"), withIntermediateDirectories: true)
        let runner = MockCommands()
        let policy = StartupPolicy(home: home, commands: runner, uid: 501, environment: [:])
        XCTAssertEqual(policy.loginPolicy, .legacy)
        XCTAssertFalse(policy.startsAtLogin)
        XCTAssertFalse(policy.supportsPolicy)
        XCTAssertThrowsError(try policy.setStartsAtLogin(false))
        try Data("# BF_CONTROL_STARTUP_POLICY_V1\n".utf8).write(to: home.appendingPathComponent("apps/botfleet-server-start.sh"))
        try policy.setStartsAtLogin(false)
        XCTAssertEqual(policy.loginPolicy, .disabled)
        XCTAssertFalse(policy.startsAtLogin)
        XCTAssertTrue(FileManager.default.fileExists(atPath: home.appendingPathComponent(".botfleet/startup-disabled.marker").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent(".botfleet/startup-enabled.marker").path))
        XCTAssertEqual(try String(contentsOf: home.appendingPathComponent(".botfleet/startup-session")).trimmingCharacters(in: .whitespacesAndNewlines), runner.boot)
        try policy.setStartsAtLogin(true)
        XCTAssertEqual(policy.loginPolicy, .enabled)
        XCTAssertTrue(policy.startsAtLogin)
        XCTAssertTrue(FileManager.default.fileExists(atPath: home.appendingPathComponent(".botfleet/startup-enabled.marker").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent(".botfleet/startup-disabled.marker").path))
        XCTAssertEqual(runner.calls, ["/usr/sbin/sysctl -n kern.bootsessionuuid", "/usr/sbin/sysctl -n kern.bootsessionuuid"])
    }

    func testStartupPolicyHonorsConfiguredDataDirectory() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let dataDirectory = home.appendingPathComponent("separate-data")
        try FileManager.default.createDirectory(at: home.appendingPathComponent("apps"), withIntermediateDirectories: true)
        try Data("BF_CONTROL_STARTUP_POLICY_V1".utf8).write(to: home.appendingPathComponent("apps/botfleet-server-start.sh"))
        let policy = StartupPolicy(home: home, commands: MockCommands(), uid: 501,
                                   environment: ["OMB_DATA_DIR": dataDirectory.path])
        try policy.setStartsAtLogin(false)
        XCTAssertEqual(policy.loginPolicy, .disabled)
        XCTAssertTrue(FileManager.default.fileExists(atPath: dataDirectory.appendingPathComponent("startup-disabled.marker").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent(".botfleet/startup-disabled.marker").path))
    }

    func testInstalledServerDistinguishesStoppedAndRunningWithoutStarting() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let runner = MockCommands()
        let policy = StartupPolicy(home: home, commands: runner, uid: 501, environment: [:])
        XCTAssertEqual(policy.installedServerState, .notInstalled)
        try FileManager.default.createDirectory(at: home.appendingPathComponent("Library/LaunchAgents"), withIntermediateDirectories: true)
        try Data().write(to: home.appendingPathComponent("Library/LaunchAgents/app.botfleet.server.plist"))
        XCTAssertEqual(policy.installedServerState, .stopped)
        runner.launchctlListing = "PID\tStatus\tLabel\n742\t0\tapp.botfleet.server"
        XCTAssertEqual(policy.installedServerState, .running)
        XCTAssertEqual(runner.calls, ["/bin/launchctl list", "/bin/launchctl list"])
    }

    func testOfflinePersistencePolicyUsesStrictAtomicPrivateBoolean() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let policy = PersistencePolicy(home: home, environment: [:])
        XCTAssertNil(policy.value)
        try policy.set(false)
        XCTAssertEqual(policy.value, false)
        let path = home.appendingPathComponent(".botfleet/persist-on-exit.policy")
        XCTAssertEqual(try String(contentsOf: path), "false\n")
        let mode = try FileManager.default.attributesOfItem(atPath: path.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(mode?.intValue, 0o600)
        try policy.set(true)
        XCTAssertEqual(policy.value, true)
        XCTAssertEqual(try String(contentsOf: path), "true\n")
        try Data("not-a-boolean\n".utf8).write(to: path)
        XCTAssertNil(policy.value)
    }

    func testOfflineDockerInspectionOnlyCountsOwnLabeledContainersOnLocalSocket() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let binary = directory.appendingPathComponent("docker")
        try Data().write(to: binary)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: binary.path)
        let runner = DockerCommands()
        runner.listing = "botfleet-computer-jay\nother-service\n"
        runner.inspection = "1\t1\tshared\tfalse"
        let inspector = OfflineDockerVM(commands: runner, environment: [:], executable: binary.path, username: "jay")
        XCTAssertEqual(inspector.inspect(), .local([OfflineVM(name: "botfleet-computer-jay", running: false)]))
        XCTAssertEqual(runner.calls.count, 3)
        XCTAssertFalse(runner.calls.contains { $0.last == "other-service" })
        runner.host = "tcp://remote.example:2375"
        XCTAssertEqual(inspector.inspect(), .unavailable)
        XCTAssertEqual(runner.calls.count, 4)
        runner.calls = []
        let overridden = OfflineDockerVM(commands: runner, environment: ["DOCKER_HOST": "tcp://remote.example:2375"], executable: binary.path, username: "jay")
        XCTAssertEqual(overridden.inspect(), .unavailable)
        XCTAssertTrue(runner.calls.isEmpty)
    }

    func testOfflineHelperRequiresInstalledBundleAndConfirmsCreatedState() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let node = directory.appendingPathComponent("node")
        let script = directory.appendingPathComponent("botfleet-vm-control.mjs")
        try Data().write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: node.path)
        let runner = HelperCommands()
        let helper = OfflineVMHelper(script: script, node: node.path, commands: runner)
        XCTAssertFalse(helper.available)
        XCTAssertThrowsError(try helper.status())
        try Data().write(to: script)
        XCTAssertTrue(helper.available)
        runner.response = #"{"ok":true,"localVms":[{"key":"shared","name":"shared","running":false,"state":"missing"}]}"#
        XCTAssertEqual(try helper.status().first?.state, "missing")
        XCTAssertEqual(runner.lastTimeout, 20)
        XCTAssertThrowsError(try helper.createStopped())
        runner.response = #"{"ok":true,"localVms":[{"key":"shared","name":"shared","running":false,"state":"created"}]}"#
        XCTAssertEqual(try helper.createStopped().first?.state, "created")
        XCTAssertEqual(runner.lastTimeout, 300)
        runner.response = #"{"ok":false,"error":"server still running"}"#
        XCTAssertThrowsError(try helper.stop()) { error in
            XCTAssertEqual(error.localizedDescription, "server still running")
        }
    }

    func testStartServerUsesNonKillingKickstartOnlyAfterMarkerAndAgentCheck() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        try FileManager.default.createDirectory(at: home.appendingPathComponent("apps"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home.appendingPathComponent("Library/LaunchAgents"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".botfleet"), withIntermediateDirectories: true)
        try Data("BF_CONTROL_STARTUP_POLICY_V1".utf8).write(to: home.appendingPathComponent("apps/botfleet-server-start.sh"))
        try Data().write(to: home.appendingPathComponent("Library/LaunchAgents/app.botfleet.server.plist"))
        try Data().write(to: home.appendingPathComponent(".botfleet/stopped.marker"))
        let runner = MockCommands()
        try StartupPolicy(home: home, commands: runner, uid: 501, environment: [:]).startServer()
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent(".botfleet/stopped.marker").path))
        XCTAssertEqual(runner.calls, [
            "/usr/sbin/sysctl -n kern.bootsessionuuid",
            "/bin/launchctl enable gui/501/app.botfleet.server",
            "/bin/launchctl print gui/501/app.botfleet.server",
            "/bin/launchctl bootstrap gui/501 \(home.path)/Library/LaunchAgents/app.botfleet.server.plist",
            "/bin/launchctl kickstart gui/501/app.botfleet.server"
        ])
    }

    func testFailedKickstartRestoresDeliberateStop() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        try FileManager.default.createDirectory(at: home.appendingPathComponent("apps"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home.appendingPathComponent("Library/LaunchAgents"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".botfleet"), withIntermediateDirectories: true)
        try Data("BF_CONTROL_STARTUP_POLICY_V1".utf8).write(to: home.appendingPathComponent("apps/botfleet-server-start.sh"))
        try Data().write(to: home.appendingPathComponent("Library/LaunchAgents/app.botfleet.server.plist"))
        let marker = home.appendingPathComponent(".botfleet/stopped.marker")
        try Data().write(to: marker)
        let runner = MockCommands()
        runner.failKickstart = true
        XCTAssertThrowsError(try StartupPolicy(home: home, commands: runner, uid: 501, environment: [:]).startServer())
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path))
    }

    func testRestartServerClearsTheDeliberateStopAndReplacesTheRunningInstance() throws {
        // The installed wrapper stays down while the deliberate-stop marker
        // exists, so a restart that left the marker in place would report a
        // server that never came back.
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        try FileManager.default.createDirectory(at: home.appendingPathComponent("apps"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home.appendingPathComponent("Library/LaunchAgents"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".botfleet"), withIntermediateDirectories: true)
        try Data("BF_CONTROL_STARTUP_POLICY_V1".utf8).write(to: home.appendingPathComponent("apps/botfleet-server-start.sh"))
        try Data().write(to: home.appendingPathComponent("Library/LaunchAgents/app.botfleet.server.plist"))
        let marker = home.appendingPathComponent(".botfleet/stopped.marker")
        try Data().write(to: marker)
        let runner = MockCommands()
        runner.agentIsLoaded = true
        try StartupPolicy(home: home, commands: runner, uid: 501, environment: [:]).restartServer()
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
        XCTAssertTrue(runner.calls.contains("/bin/launchctl kickstart -k gui/501/app.botfleet.server"))
    }

    func testAFailedRestartRestoresTheDeliberateStop() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        try FileManager.default.createDirectory(at: home.appendingPathComponent("apps"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home.appendingPathComponent("Library/LaunchAgents"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".botfleet"), withIntermediateDirectories: true)
        try Data("BF_CONTROL_STARTUP_POLICY_V1".utf8).write(to: home.appendingPathComponent("apps/botfleet-server-start.sh"))
        try Data().write(to: home.appendingPathComponent("Library/LaunchAgents/app.botfleet.server.plist"))
        let marker = home.appendingPathComponent(".botfleet/stopped.marker")
        try Data().write(to: marker)
        let runner = MockCommands()
        runner.failKickstart = true
        XCTAssertThrowsError(try StartupPolicy(home: home, commands: runner, uid: 501, environment: [:]).restartServer())
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path))
    }

    private func mockSession() -> URLSession {
        MockURLProtocol.requests = []
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

private final class MockCommands: CommandRunning {
    let boot = "4F9389E9-AFE4-42C8-AE2C-7FEEDBA31B6C"
    var calls: [String] = []
    var failKickstart = false
    /// True when `launchctl bootout` fails the way launchctl fails.
    var failBootout = false
    var launchctlListing = "PID\tStatus\tLabel\n-\t0\tother.service"
    /// True when launchctl already knows the agent.
    var agentIsLoaded = false
    func run(_ executable: String, _ arguments: [String]) throws -> String {
        calls.append(([executable] + arguments).joined(separator: " "))
        if executable == "/usr/sbin/sysctl" { return boot }
        if failBootout && arguments.first == "bootout" { throw CommandExitError(output: "Boot-out failed: 5: Input/output error") }
        if arguments == ["list"] { return launchctlListing }
        if arguments.first == "print" {
            if agentIsLoaded { return "state = running" }
            throw StartupPolicyError.commandFailed
        }
        if failKickstart && arguments.first == "kickstart" { throw StartupPolicyError.commandFailed }
        return ""
    }
}

private final class DockerCommands: CommandRunning {
    var host = "unix:///tmp/docker.sock"
    var listing = ""
    var inspection = ""
    var calls: [[String]] = []
    func run(_ executable: String, _ arguments: [String]) throws -> String {
        calls.append(arguments)
        switch arguments.first {
        case "context": return host
        case "ps": return listing
        case "inspect": return inspection
        default: throw StartupPolicyError.commandFailed
        }
    }
}

private final class HelperCommands: CommandRunning {
    var response = ""
    var lastTimeout: TimeInterval = 0
    func run(_ executable: String, _ arguments: [String]) throws -> String { response }
    func run(_ executable: String, _ arguments: [String], timeout: TimeInterval) throws -> String {
        lastTimeout = timeout
        return response
    }
}

final class MockURLProtocol: URLProtocol {
    static var requests: [URLRequest] = []
    static var handler: ((URLRequest) -> (Int, Data)) = { _ in (500, Data()) }
    /// When this returns an error for a request, that request fails instead
    /// of answering.  A server that is alive but too slow to answer looks
    /// exactly like this to the client.
    static var failure: ((URLRequest) -> Error?)? = nil
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        if let error = Self.failure?(request) {
            client?.urlProtocol(self, didFailWithError: error)
            return
        }
        let (status, body) = Self.handler(request)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
