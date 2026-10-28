import XCTest
@testable import BotFleetControlCore

final class FleetServicesTests: XCTestCase {
    // MARK: - The registry of fleet services

    func testTheBotFleetMCPServerIsTheFirstFleetService() {
        let entries = FleetServices(serverState: .running, states: [:]).entries
        XCTAssertEqual(entries.first?.id, "botfleet-mcp")
        XCTAssertEqual(entries.first?.title, "BotFleet MCP Server")
    }

    func testEveryProcessBotFleetStartsIsInTheRegistry() {
        let ids = FleetServiceRegistry.all.map(\.id)
        // The pm2 applications the ecosystem file defines.
        for appName in ["shellular", "code-main-keeper", "vision-worker", "xcode-health",
                        "agy-acp", "grok-leader", "grok-acp", "clutch-web", "seat-mcp",
                        "botfleet-mcp"] {
            XCTAssertTrue(ids.contains(appName), "\(appName) is missing from the registry")
        }
        // The launchd agents.
        XCTAssertTrue(ids.contains("app.botfleet.server"))
        XCTAssertTrue(ids.contains("app.botfleet.companion"))
        XCTAssertEqual(ids.count, 12)
    }

    func testTheMCPServerIsSupervisedByPM2AndFollowsTheBotFleetServer() {
        XCTAssertEqual(FleetServiceRegistry.mcpServer.kind, .pm2(appName: "botfleet-mcp"))
        XCTAssertEqual(FleetServiceRegistry.mcpServer.policy, .whileServerRuns)
        XCTAssertEqual(FleetServiceRegistry.server.kind, .launchAgent(label: "app.botfleet.server"))
        XCTAssertEqual(FleetServiceRegistry.companion.kind, .launchAgent(label: "app.botfleet.companion"))
    }

    func testEveryOtherServiceIsWantedOnItsOwn() {
        for descriptor in FleetServiceRegistry.all where descriptor.id != "botfleet-mcp" {
            XCTAssertEqual(descriptor.policy, .alwaysOn, "\(descriptor.id) follows the wrong rule")
        }
    }

    // MARK: - Wanted state

    func testTheMCPServerIsWantedExactlyWhileTheBotFleetServerRuns() {
        XCTAssertEqual(wanted(.whileServerRuns, serverState: .running), true)
        XCTAssertEqual(wanted(.whileServerRuns, serverState: .stopped), false)
        XCTAssertNil(wanted(.whileServerRuns, serverState: .unknown))
    }

    func testAFleetServiceIsWantedUnlessSomethingSaysOtherwise() {
        // A running service is wanted, and so is one that failed: it is not
        // running and nothing asked it to stop.
        XCTAssertEqual(wanted(.alwaysOn, state: .running), true)
        XCTAssertEqual(wanted(.alwaysOn, state: .failed), true)
        // A service that was stopped on purpose is the something that says
        // otherwise, and so is one that is not installed.
        XCTAssertEqual(wanted(.alwaysOn, state: .stopped), false)
        XCTAssertEqual(wanted(.alwaysOn, state: .notInstalled), false)
        // A service the Control app cannot see has no wanted state at all.
        XCTAssertNil(wanted(.alwaysOn, state: .unknown))
    }

    func testTheBotFleetServerRuleIsNeverUsedForAFleetService() {
        // The BotFleet Server is down, so the MCP server is not wanted.  The
        // other fleet services are wanted on their own and are untouched.
        let services = FleetServices(serverState: .stopped,
                                     states: ["shellular": .running, "botfleet-mcp": .running])
        let shellular = services.entries.first { $0.id == "shellular" }
        let mcpServer = services.entries.first { $0.id == "botfleet-mcp" }
        XCTAssertEqual(shellular?.wanted, true)
        XCTAssertEqual(mcpServer?.wanted, false)
    }

    // MARK: - The action the Control app takes on its own

    func testAFailedServiceIsBroughtBackUpWhenItIsWanted() {
        XCTAssertEqual(ManagedServices.action(wanted: true, state: .failed), .start)
    }

    func testAServiceThatWasStoppedIsLeftAlone() {
        XCTAssertEqual(ManagedServices.action(wanted: false, state: .stopped), .none)
    }

    func testARunningServiceThatIsNotWantedIsStopped() {
        XCTAssertEqual(ManagedServices.action(wanted: false, state: .running), .stop)
    }

    func testAnUnknownServiceIsNeverActedOn() {
        XCTAssertEqual(ManagedServices.action(wanted: true, state: .unknown), .none)
        XCTAssertEqual(ManagedServices.action(wanted: nil, state: .stopped), .none)
    }

    func testAFailedFleetServiceIsBroughtBackByTheAutomaticAction() {
        let services = FleetServices(serverState: .running, states: ["shellular": .failed])
        let entry = services.entries.first { $0.id == "shellular" }
        XCTAssertEqual(FleetServices.automaticAction(for: entry!), .start)
    }

    func testAStoppedFleetServiceIsLeftAloneByTheAutomaticAction() {
        let services = FleetServices(serverState: .running, states: ["shellular": .stopped])
        let entry = services.entries.first { $0.id == "shellular" }
        XCTAssertEqual(FleetServices.automaticAction(for: entry!), .none)
    }

    // MARK: - The actions the owner may pick

    func testTheActionsForARunningServiceAreStopAndRestart() {
        XCTAssertEqual(FleetServices.availableActions(for: .running), [.stop, .restart])
    }

    func testTheActionsForAStoppedServiceAreStartAndRestart() {
        XCTAssertEqual(FleetServices.availableActions(for: .stopped), [.start, .restart])
    }

    func testTheActionsForAFailedServiceAreStartAndRestart() {
        XCTAssertEqual(FleetServices.availableActions(for: .failed), [.start, .restart])
    }

    func testAServiceThatIsNotInstalledHasNoActions() {
        XCTAssertEqual(FleetServices.availableActions(for: .notInstalled), [])
    }

    func testAServiceTheAppCannotSeeCanOnlyBeRestarted() {
        // The Control app does not stop a service it cannot see.
        XCTAssertEqual(FleetServices.availableActions(for: .unknown), [.restart])
    }

    // MARK: - The menu

    func testTheFleetServicesMenuHasOneRowPerService() {
        let services = FleetServices(serverState: .running, states: [:])
        XCTAssertEqual(services.menuItems.count, 12)
        XCTAssertEqual(services.menuItems.first?.id, "botfleet-mcp")
        XCTAssertEqual(services.menuTitle, "Fleet Services (12)")
    }

    func testEachMenuRowShowsTheStateAndTheActions() {
        let services = FleetServices(serverState: .running,
                                    states: ["botfleet-mcp": .running, "shellular": .stopped])
        let mcpServer = services.menuItems.first { $0.id == "botfleet-mcp" }
        let shellular = services.menuItems.first { $0.id == "shellular" }
        XCTAssertEqual(mcpServer?.summary, "running")
        XCTAssertEqual(mcpServer?.actions, [.stop, .restart])
        XCTAssertEqual(shellular?.summary, "stopped")
        XCTAssertEqual(shellular?.actions, [.start, .restart])
    }

    // MARK: - Reading the pm2 applications

    func testThePM2StatesAreReadFromTheJSON() {
        let listing = """
        [
          {"name": "shellular", "pm2_env": {"status": "online"}},
          {"name": "botfleet-mcp", "pm2_env": {"status": "stopped"}},
          {"name": "grok-acp", "pm2_env": {"status": "errored"}}
        ]
        """
        let states = PM2Client.parseAppStates(listing)
        XCTAssertEqual(states["shellular"], .running)
        XCTAssertEqual(states["botfleet-mcp"], .stopped)
        XCTAssertEqual(states["grok-acp"], .failed)
    }

    func testAnApplicationPM2HasNoRecordOfIsNotRunning() {
        let commands = FleetServiceCommands()
        commands.pm2Listing = #"[{"name": "shellular", "pm2_env": {"status": "online"}}]"#
        let pm2 = PM2Client(commands: commands, nodePath: "/usr/bin/node", pm2Path: "/usr/bin/pm2")
        XCTAssertEqual(pm2.state(ofApp: "grok-acp"), .stopped)
    }

    func testAPM2ThatCannotBeReachedKnowsNothing() {
        let commands = FleetServiceCommands()
        commands.failure = StartupPolicyError.commandFailed
        let pm2 = PM2Client(commands: commands, nodePath: "/usr/bin/node", pm2Path: "/usr/bin/pm2")
        XCTAssertNil(pm2.appStates())
        XCTAssertEqual(pm2.state(ofApp: "shellular"), .unknown)
    }

    func testAnApplicationWithNoStateIsUnknown() {
        XCTAssertEqual(PM2Client.state(forStatus: nil), .unknown)
        XCTAssertEqual(PM2Client.state(forStatus: "launching"), .unknown)
    }

    // MARK: - Changing the pm2 applications

    func testStartingAPM2ApplicationRunsPM2Start() throws {
        let commands = FleetServiceCommands()
        try pm2(commands).start(appName: "shellular")
        XCTAssertEqual(commands.calls, [["start", "shellular"]])
    }

    func testStartingAPM2ApplicationFallsBackToTheEcosystemFile() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        try FileManager.default.createDirectory(at: home.appendingPathComponent("apps"), withIntermediateDirectories: true)
        try Data().write(to: home.appendingPathComponent("apps/pm2-ecosystem.config.cjs"))
        let commands = FleetServiceCommands()
        commands.startFailure = CommandExitError(output: "pm2 said no")
        try pm2(commands, home: home).start(appName: "shellular")
        XCTAssertEqual(commands.calls.count, 2)
        XCTAssertEqual(commands.calls[0], ["start", "shellular"])
        XCTAssertEqual(commands.calls[1], ["start",
                                          home.appendingPathComponent("apps/pm2-ecosystem.config.cjs").path,
                                          "--only", "shellular"])
    }

    func testStoppingAPM2ApplicationRunsPM2Stop() throws {
        let commands = FleetServiceCommands()
        try pm2(commands).stop(appName: "shellular")
        XCTAssertEqual(commands.calls, [["stop", "shellular"]])
    }

    func testRestartingAPM2ApplicationRunsPM2Restart() throws {
        let commands = FleetServiceCommands()
        try pm2(commands).restart(appName: "shellular")
        XCTAssertEqual(commands.calls, [["restart", "shellular"]])
    }

    func testTheStateAfterTheActionIsTheOneThatIsReported() async throws {
        let commands = FleetServiceCommands()
        commands.pm2Listing = #"[{"name": "shellular", "pm2_env": {"status": "stopped"}}]"#
        commands.pm2ListingAfterChange = #"[{"name": "shellular", "pm2_env": {"status": "online"}}]"#
        let state = try await pm2(commands).setRunning(true, appName: "shellular", attempts: 2)
        XCTAssertEqual(state, .running)
        XCTAssertTrue(commands.calls.contains { $0.first == "start" })
    }

    func testAnApplicationThatIsAlreadyRunningIsNotStartedAgain() async throws {
        let commands = FleetServiceCommands()
        commands.pm2Listing = #"[{"name": "shellular", "pm2_env": {"status": "online"}}]"#
        let state = try await pm2(commands).setRunning(true, appName: "shellular", attempts: 1)
        XCTAssertEqual(state, .running)
        XCTAssertFalse(commands.calls.contains { $0.first == "start" })
    }

    // MARK: - The launchd agents

    func testALaunchAgentStateIsReadFromLaunchctl() throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        try Data().write(to: home.appendingPathComponent("Library/LaunchAgents/app.botfleet.server.plist"))
        let commands = LaunchAgentCommands()
        commands.listing = "PID\tStatus\tLabel\n4210\t0\tapp.botfleet.companion\n-\t0\tapp.botfleet.server"
        let policy = StartupPolicy(home: home, commands: commands, uid: 501, environment: [:])
        // An agent with a live process behind it is running.
        XCTAssertEqual(policy.state(ofAgent: "app.botfleet.companion"), .running)
        // An agent that is loaded without one is stopped.
        XCTAssertEqual(policy.state(ofAgent: "app.botfleet.server"), .stopped)
    }

    func testALaunchAgentWithoutItsPlistIsNotInstalled() throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let policy = StartupPolicy(home: home, commands: LaunchAgentCommands(), uid: 501, environment: [:])
        XCTAssertEqual(policy.state(ofAgent: "app.botfleet.server"), .notInstalled)
    }

    func testStartingALaunchAgentEnablesLoadsAndKickstartsIt() throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let commands = LaunchAgentCommands()
        try StartupPolicy(home: home, commands: commands, uid: 501, environment: [:])
            .startAgent(label: "app.botfleet.companion")
        XCTAssertEqual(commands.calls, [
            "/bin/launchctl enable gui/501/app.botfleet.companion",
            "/bin/launchctl print gui/501/app.botfleet.companion",
            "/bin/launchctl bootstrap gui/501 \(home.path)/Library/LaunchAgents/app.botfleet.companion.plist",
            "/bin/launchctl kickstart gui/501/app.botfleet.companion"
        ])
    }

    func testStoppingALaunchAgentBootsItOut() throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let commands = LaunchAgentCommands()
        try StartupPolicy(home: home, commands: commands, uid: 501, environment: [:])
            .stopAgent(label: "app.botfleet.companion")
        XCTAssertEqual(commands.calls, ["/bin/launchctl bootout gui/501/app.botfleet.companion"])
    }

    func testRestartingALaunchAgentReplacesTheRunningInstance() throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let commands = LaunchAgentCommands()
        commands.loaded = true
        try StartupPolicy(home: home, commands: commands, uid: 501, environment: [:])
            .restartAgent(label: "app.botfleet.companion")
        XCTAssertEqual(commands.calls, [
            "/bin/launchctl print gui/501/app.botfleet.companion",
            "/bin/launchctl kickstart -k gui/501/app.botfleet.companion"
        ])
    }

    func testRestartingALaunchAgentThatIsNotLoadedStartsIt() throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let commands = LaunchAgentCommands()
        try StartupPolicy(home: home, commands: commands, uid: 501, environment: [:])
            .restartAgent(label: "app.botfleet.companion")
        XCTAssertTrue(commands.calls.contains("/bin/launchctl kickstart gui/501/app.botfleet.companion"))
    }

    // MARK: - The BotFleet MCP Server keeps its own health endpoint

    func testTheMCPServerIsObservedThroughItsOwnHealthEndpoint() async throws {
        FleetServiceURLProtocol.handler = { _ in
            .response(200, Data(#"{"status":"ok","app":"botfleet-admin-mcp"}"#.utf8))
        }
        let control = makeControl(commands: FleetServiceCommands())
        let states = await control.states(serverState: .running)
        XCTAssertEqual(states["botfleet-mcp"], .running)
    }

    func testTheMCPServerIsUnknownWhenItsHealthEndpointDoesNotAnswer() async throws {
        FleetServiceURLProtocol.handler = { _ in .failure(URLError(.timedOut)) }
        let control = makeControl(commands: FleetServiceCommands())
        let states = await control.states(serverState: .running)
        XCTAssertEqual(states["botfleet-mcp"], .unknown)
    }

    func testTheOtherPM2ApplicationsAreReadFromPM2() async throws {
        FleetServiceURLProtocol.handler = { _ in .failure(URLError(.timedOut)) }
        let commands = FleetServiceCommands()
        commands.pm2Listing = """
        [{"name": "shellular", "pm2_env": {"status": "online"}},
         {"name": "grok-acp", "pm2_env": {"status": "errored"}}]
        """
        let control = makeControl(commands: commands)
        let states = await control.states(serverState: .running)
        XCTAssertEqual(states["shellular"], .running)
        XCTAssertEqual(states["grok-acp"], .failed)
        // An application pm2 has no record of is not running.
        XCTAssertEqual(states["seat-mcp"], .stopped)
    }

    // MARK: - Helpers

    private func wanted(_ policy: FleetServiceWantedPolicy,
                         serverState: ManagedServices.ServerState = .running,
                         state: ManagedServiceState = .running) -> Bool? {
        let descriptor = FleetServiceDescriptor(id: "shellular", title: "Shellular",
                                                kind: .pm2(appName: "shellular"), policy: policy)
        let states = policy == .alwaysOn ? ["shellular": state] : [:]
        return FleetServices(serverState: serverState, states: states).wanted(for: descriptor)
    }

    private func pm2(_ commands: FleetServiceCommands,
                     home: URL = URL(fileURLWithPath: "/Users/tester", isDirectory: true)) -> PM2Client {
        PM2Client(commands: commands, nodePath: "/usr/bin/node", pm2Path: "/usr/bin/pm2", home: home)
    }

    private func makeHome() throws -> URL {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: home.appendingPathComponent("Library/LaunchAgents"),
                                                withIntermediateDirectories: true)
        try Data().write(to: home.appendingPathComponent("Library/LaunchAgents/app.botfleet.companion.plist"))
        return home
    }

    private func makeControl(commands: FleetServiceCommands) -> FleetServiceControl {
        FleetServiceControl(pm2: PM2Client(commands: commands, nodePath: "/usr/bin/node",
                                           pm2Path: "/usr/bin/pm2"),
                            startup: StartupPolicy(commands: LaunchAgentCommands(), uid: 501, environment: [:]),
                            mcpServer: try? McpServerControl(session: mockSession(),
                                                            baseURL: URL(string: "http://127.0.0.1:8794"),
                                                            pm2: PM2Client(commands: commands,
                                                                           nodePath: "/usr/bin/node",
                                                                           pm2Path: "/usr/bin/pm2")))
    }

    private func mockSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FleetServiceURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

/// A stand-in for the pm2 client.
///
/// pm2 is run through node, so the arguments the mock sees begin with the
/// path of the pm2 client itself.  The mock records the arguments pm2 was
/// given, without that path.
private final class FleetServiceCommands: CommandRunning {
    var calls: [[String]] = []
    /// What `pm2 jlist` answers with.
    var pm2Listing = ""
    /// What `pm2 jlist` answers with once a change has been made.
    var pm2ListingAfterChange: String?
    /// The failure every command raises.
    var failure: Error?
    /// The failure only `pm2 start` raises.
    var startFailure: Error?

    func run(_ executable: String, _ arguments: [String]) throws -> String {
        let pm2Arguments = Array(arguments.dropFirst())
        calls.append(pm2Arguments)
        if pm2Arguments.first == "start", let startFailure {
            // pm2 refuses the first start, so the ecosystem file is the way
            // back.
            self.startFailure = nil
            throw startFailure
        }
        if let failure { throw failure }
        if pm2Arguments.first == "jlist" { return pm2Listing }
        if pm2Arguments.first == "start" || pm2Arguments.first == "stop" || pm2Arguments.first == "restart" {
            if let pm2ListingAfterChange { pm2Listing = pm2ListingAfterChange }
            return ""
        }
        return ""
    }
}

/// A stand-in for the commands launchctl is asked with.
private final class LaunchAgentCommands: CommandRunning {
    var calls: [String] = []
    /// What `launchctl list` answers with.
    var listing = "PID\tStatus\tLabel\n-\t0\tother.service"
    /// True when launchctl already knows the agent.
    var loaded = false

    func run(_ executable: String, _ arguments: [String]) throws -> String {
        calls.append(([executable] + arguments).joined(separator: " "))
        if arguments == ["list"] { return listing }
        if arguments.first == "print" {
            if loaded { return "state = running" }
            throw StartupPolicyError.commandFailed
        }
        return ""
    }
}

/// A stand-in for the health endpoint of the BotFleet MCP server.
private final class FleetServiceURLProtocol: URLProtocol {
    enum Reply {
        case response(Int, Data)
        case failure(Error)
    }
    static var handler: ((URLRequest) -> Reply) = { _ in .response(500, Data()) }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        switch Self.handler(request) {
        case .response(let status, let body):
            guard let url = request.url,
                  let response = HTTPURLResponse(url: url, statusCode: status,
                                                 httpVersion: nil, headerFields: nil) else {
                client?.urlProtocol(self, didFailWithError: URLError(.badURL))
                return
            }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        case .failure(let error):
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
