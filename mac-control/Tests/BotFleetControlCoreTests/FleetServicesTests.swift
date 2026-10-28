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
        XCTAssertEqual(FleetServices.availableActions(for: .running, wanted: true, policy: .alwaysOn), [.stop, .restart])
    }

    func testTheActionsForAStoppedServiceAreStartAndRestart() {
        XCTAssertEqual(FleetServices.availableActions(for: .stopped, wanted: false, policy: .alwaysOn), [.start, .restart])
    }

    func testTheActionsForAFailedServiceAreStartAndRestart() {
        XCTAssertEqual(FleetServices.availableActions(for: .failed, wanted: true, policy: .alwaysOn), [.start, .restart])
    }

    func testAServiceThatIsNotInstalledHasNoActions() {
        XCTAssertEqual(FleetServices.availableActions(for: .notInstalled, wanted: false, policy: .alwaysOn), [])
    }

    func testAServiceTheAppCannotSeeCanOnlyBeRestarted() {
        // The Control app does not stop a service it cannot see.
        XCTAssertEqual(FleetServices.availableActions(for: .unknown, wanted: nil, policy: .alwaysOn), [.restart])
    }

    func testAServiceThatFollowsTheServerCanBeStoppedWhileTheServerRuns() {
        // The BotFleet MCP Server follows the BotFleet Server, and a stop the
        // owner asked for is not one the Control app takes back.
        XCTAssertEqual(FleetServices.availableActions(for: .running, wanted: true, policy: .whileServerRuns), [.stop, .restart])
        XCTAssertEqual(FleetServices.availableActions(for: .stopped, wanted: true, policy: .whileServerRuns), [.start, .restart])
    }

    func testAServiceThatFollowsTheServerCannotBeStartedWhileTheServerIsDown() {
        // Starting it now would be undone at once, so no action is offered
        // that the reconciler would take straight back.
        XCTAssertEqual(FleetServices.availableActions(for: .stopped, wanted: false, policy: .whileServerRuns), [])
        XCTAssertEqual(FleetServices.availableActions(for: .running, wanted: false, policy: .whileServerRuns), [])
    }

    func testAServiceTheOwnerStoppedCanBeStartedAgain() {
        XCTAssertEqual(FleetServices.availableActions(for: .stopped, wanted: false, policy: .whileServerRuns, stoppedByOwner: true),
                       [.start, .restart])
    }

    func testTheServerIsOfferedNothingWhenTheInstalledWrapperDoesNotSupportThePolicy() {
        // The BotFleet Server's start and restart change its startup policy,
        // so an older wrapper is offered nothing rather than an action that
        // would always fail.
        let services = FleetServices(serverState: .running,
                                    states: ["app.botfleet.server": .running],
                                    startupPolicySupported: false)
        let row = services.menuItems.first { $0.id == "app.botfleet.server" }
        XCTAssertEqual(row?.actions, [])
    }

    func testTheServerIsOfferedItsActionsWhenTheInstalledWrapperSupportsThePolicy() {
        let services = FleetServices(serverState: .running,
                                    states: ["app.botfleet.server": .running],
                                    startupPolicySupported: true)
        let row = services.menuItems.first { $0.id == "app.botfleet.server" }
        XCTAssertEqual(row?.actions, [.stop, .restart])
    }

    func testTheMcpServerRowInTheMenuOffersStopWhileTheServerRuns() {
        let services = FleetServices(serverState: .running, states: ["botfleet-mcp": .running])
        let row = services.menuItems.first { $0.id == "botfleet-mcp" }
        XCTAssertEqual(row?.actions, [.stop, .restart])
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
        // The MCP server's state follows the BotFleet Server, and a stop the
        // owner asked for is kept.
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

    func testRestartingAPM2ApplicationFallsBackToTheEcosystemFile() throws {
        // pm2 no longer remembers the application, so the ecosystem file is
        // the way back, exactly as it is for a start.
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        try FileManager.default.createDirectory(at: home.appendingPathComponent("apps"), withIntermediateDirectories: true)
        try Data().write(to: home.appendingPathComponent("apps/pm2-ecosystem.config.cjs"))
        let commands = FleetServiceCommands()
        commands.restartFailure = CommandExitError(output: "pm2 said no")
        try pm2(commands, home: home).restart(appName: "shellular")
        XCTAssertEqual(commands.calls.count, 2)
        XCTAssertEqual(commands.calls[0], ["restart", "shellular"])
        XCTAssertEqual(commands.calls[1], ["start",
                                          home.appendingPathComponent("apps/pm2-ecosystem.config.cjs").path,
                                          "--only", "shellular"])
    }

    func testTheStateAfterTheActionIsTheOneThatIsReported() async throws {
        let commands = FleetServiceCommands()
        commands.pm2Listing = #"[{"name": "shellular", "pm2_env": {"status": "stopped"}}]"#
        commands.pm2ListingAfterChange = #"[{"name": "shellular", "pm2_env": {"status": "online"}}]"#
        let state = try await pm2(commands).setRunning(true, appName: "shellular", attempts: 2)
        XCTAssertEqual(state, .running)
        XCTAssertTrue(commands.calls.contains { $0.first == "start" })
    }

    func testAWaitForAPM2ChangeDoesNotSpawnAProcessForEveryHalfSecond() async throws {
        // Every look at a pm2 application spawns a node client, so a wait
        // that never settles has to be made of few wide looks rather than
        // many narrow ones.
        let commands = FleetServiceCommands()
        commands.pm2Listing = #"[{"name": "shellular", "pm2_env": {"status": "stopped"}}]"#
        _ = try await pm2(commands).setRunning(true, appName: "shellular", attempts: 3, interval: 0.01)
        let looks = commands.calls.filter { $0.first == "jlist" }.count
        // One look before the change, one for each attempt of the wait, and
        // one after it.
        XCTAssertLessThanOrEqual(looks, 5)
        // The wait still covers the twenty seconds it always did, and it
        // looks ten times at most, where the old one looked forty-two.
        let window = Double(PM2Client.settleAttempts) * PM2Client.settleInterval
        XCTAssertGreaterThanOrEqual(window, 20.0)
        XCTAssertLessThanOrEqual(PM2Client.settleAttempts + 2, 10)
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

    // MARK: - A stop the owner asked for

    func testAStopIsRemembered() {
        var stops = OwnerStops()
        stops.record(.stop, id: "botfleet-mcp")
        XCTAssertEqual(stops.ids, ["botfleet-mcp"])
    }

    func testAStartTakesTheRecordBack() {
        var stops = OwnerStops(ids: ["botfleet-mcp"])
        stops.record(.start, id: "botfleet-mcp")
        XCTAssertEqual(stops.ids, [])
    }

    func testARestartTakesTheRecordBack() {
        // A restart is a start as far as the record is concerned: the owner
        // asked for the service to be running.
        var stops = OwnerStops(ids: ["botfleet-mcp"])
        stops.record(.restart, id: "botfleet-mcp")
        XCTAssertEqual(stops.ids, [])
    }

    func testARefusedChangePutsTheRecordBackTheWayItWas() {
        // A refused change is not a stop the owner asked for, so the record
        // goes back to what it was rather than to what the action would have
        // made of it.
        var stops = OwnerStops()
        stops.record(.stop, id: "botfleet-mcp")
        let previous = stops.ids
        stops.record(.start, id: "botfleet-mcp")
        stops.restore(previous)
        XCTAssertEqual(stops.ids, ["botfleet-mcp"])
    }

    func testARefusedStartDoesNotRecordAStop() {
        // The owner asked for the service to run, so a start that was
        // refused must not leave the service recorded as stopped on purpose.
        var stops = OwnerStops()
        let previous = stops.ids
        stops.record(.start, id: "botfleet-mcp")
        stops.restore(previous)
        XCTAssertEqual(stops.ids, [])
    }

    func testAServiceTheOwnerStoppedIsNotWanted() {
        // The BotFleet MCP Server is wanted exactly while the BotFleet
        // Server runs, but a stop the owner asked for is not one the Control
        // app undoes.
        let services = FleetServices(serverState: .running,
                                    states: ["botfleet-mcp": .stopped],
                                    stoppedByOwner: ["botfleet-mcp"])
        let entry = services.entries.first { $0.id == "botfleet-mcp" }
        XCTAssertEqual(entry?.wanted, false)
        XCTAssertEqual(FleetServices.automaticAction(for: entry!), .none)
    }

    func testAServiceTheOwnerStoppedIsWantedAgainWhenTheOwnerStartsIt() {
        let services = FleetServices(serverState: .running, states: ["botfleet-mcp": .stopped])
        let entry = services.entries.first { $0.id == "botfleet-mcp" }
        XCTAssertEqual(entry?.wanted, true)
        XCTAssertEqual(FleetServices.automaticAction(for: entry!), .start)
    }

    // MARK: - Stopping the BotFleet Server

    func testStoppingTheBotFleetServerAsksTheServerToStopItself() async throws {
        // launchd does not always own the server process: the installed
        // wrapper exits when the harness is already healthy, and the desktop
        // app forks its own harness when nothing answers on the port.  A
        // bootout can leave a server that is still serving.
        let commands = LaunchAgentCommands()
        let asked = Counter()
        let control = FleetServiceControl(
            pm2: pm2(FleetServiceCommands()),
            startup: StartupPolicy(commands: commands, uid: 501, environment: [:]),
            mcpServer: nil,
            stopServer: { asked.increment() })
        _ = try await control.perform(.stop, serviceID: FleetServiceRegistry.server.id)
        XCTAssertEqual(asked.value, 1)
        XCTAssertFalse(commands.calls.contains { $0.contains("bootout") })
    }

    func testStoppingTheBotFleetServerIsRefusedWhenTheServerCannotBeAsked() async throws {
        let control = FleetServiceControl(pm2: pm2(FleetServiceCommands()),
                                          startup: StartupPolicy(commands: LaunchAgentCommands(), uid: 501, environment: [:]),
                                          mcpServer: nil)
        do {
            _ = try await control.perform(.stop, serviceID: FleetServiceRegistry.server.id)
            XCTFail("the stop should not have been reported as a success")
        } catch {
            XCTAssertTrue("\(error)".contains("stop itself"))
        }
    }

    // MARK: - Restarting the BotFleet Server
    func testARestartThatDoesNotReplaceTheServerIsNotReportedAsASuccess() async throws {
        // A kickstart replaces the process the launchd job owns.  When the
        // job owns no process, the server that is running was started by
        // something else and the restart changed nothing.
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        try FileManager.default.createDirectory(at: home.appendingPathComponent("apps"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home.appendingPathComponent("Library/LaunchAgents"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".botfleet"), withIntermediateDirectories: true)
        try Data("BF_CONTROL_STARTUP_POLICY_V1".utf8).write(to: home.appendingPathComponent("apps/botfleet-server-start.sh"))
        try Data().write(to: home.appendingPathComponent("Library/LaunchAgents/app.botfleet.server.plist"))
        let commands = LaunchAgentCommands()
        commands.loaded = false
        let control = FleetServiceControl(
            pm2: pm2(FleetServiceCommands()),
            startup: StartupPolicy(home: home, commands: commands, uid: 501, environment: [:]),
            mcpServer: nil)
        do {
            _ = try await control.perform(.restart, serviceID: FleetServiceRegistry.server.id, attempts: 2)
            XCTFail("a restart that replaced nothing should not be reported as a success")
        } catch {
            XCTAssertTrue("\(error)".contains("not replaced"))
        }
    }

    func testRestartingTheBotFleetServerClearsTheDeliberateStopMarker() async throws {
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

        let commands = LaunchAgentCommands()
        commands.loaded = true
        commands.listing = "PID\tStatus\tLabel\n123\t0\tapp.botfleet.server"
        let control = FleetServiceControl(
            pm2: pm2(FleetServiceCommands()),
            startup: StartupPolicy(home: home, commands: commands, uid: 501, environment: [:]),
            mcpServer: nil)
        _ = try await control.perform(.restart, serviceID: FleetServiceRegistry.server.id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
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

/// Counts how many times something was asked for.
private final class Counter {
    private(set) var value = 0
    func increment() { value += 1 }
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
    /// The failure only `pm2 restart` raises.
    var restartFailure: Error?

    func run(_ executable: String, _ arguments: [String]) throws -> String {
        let pm2Arguments = Array(arguments.dropFirst())
        calls.append(pm2Arguments)
        if pm2Arguments.first == "start", let startFailure {
            // pm2 refuses the first start, so the ecosystem file is the way
            // back.
            self.startFailure = nil
            throw startFailure
        }
        if pm2Arguments.first == "restart", let restartFailure {
            // pm2 refuses the first restart, so the ecosystem file is the way
            // back.
            self.restartFailure = nil
            throw restartFailure
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
    /// The boot id the startup policy records.
    var boot = "4F9389E9-AFE4-42C8-AE2C-7FEEDBA31B6C"

    func run(_ executable: String, _ arguments: [String]) throws -> String {
        calls.append(([executable] + arguments).joined(separator: " "))
        if executable == "/usr/sbin/sysctl" { return boot }
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
