import XCTest
@testable import BotFleetControlCore

/// Runs an operation that must throw, and hands the error to `check`.
///
/// XCTAssertThrowsError takes no async expression, and the launchd stop
/// suspends between its looks at launchd.
func assertThrowsAsync(_ operation: () async throws -> Void,
                       file: StaticString = #filePath, line: UInt = #line,
                       _ check: (Error) -> Void = { _ in }) async {
    do {
        try await operation()
        XCTFail("Expected an error, got none", file: file, line: line)
    } catch {
        check(error)
    }
}

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

    func testAServiceTheOwnerStoppedIsLeftAloneByTheAutomaticAction() {
        // A service the owner stopped on purpose can read as failed, and a
        // failed service is wanted, so the automatic action would bring it
        // back up and take the owner's stop away.
        let services = FleetServices(serverState: .running,
                                     states: ["shellular": .failed],
                                     stoppedByOwner: ["shellular"])
        let entry = services.entries.first { $0.id == "shellular" }
        XCTAssertEqual(entry?.stoppedByOwner, true)
        XCTAssertEqual(FleetServices.automaticAction(for: entry!), .none)
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

    func testTheServerIsOfferedStopWhenTheInstalledWrapperDoesNotSupportThePolicy() {
        // The BotFleet Server's start and restart change its startup policy,
        // so an older wrapper is offered neither of those rather than an
        // action that would always fail.  A stop asks the server itself, so
        // it works with any wrapper and stays on the row.
        let services = FleetServices(serverState: .running,
                                    states: ["app.botfleet.server": .running],
                                    startupPolicySupported: false)
        let row = services.menuItems.first { $0.id == "app.botfleet.server" }
        XCTAssertEqual(row?.actions, [.stop])
    }

    func testAStoppedServerOnAnOldWrapperIsOfferedNothing() {
        // There is nothing to offer a stopped server whose wrapper cannot
        // carry the startup policy: a start and a restart both need it.
        let services = FleetServices(serverState: .stopped,
                                    states: ["app.botfleet.server": .stopped],
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

    func testStoppingALaunchAgentDisablesItBootsItOutAndChecksItIsGone() async throws {
        // A bootout alone holds only until the next login: the plist carries
        // RunAtLoad, so launchd loads the agent again.  The disable is what
        // makes the owner's stop hold across logins and restarts, and the
        // start's enable is what undoes it.  Whether the stop took is read
        // from launchd, not from the bootout's exit status.
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let commands = LaunchAgentCommands()
        try await StartupPolicy(home: home, commands: commands, uid: 501, environment: [:])
            .stopAgent(label: "app.botfleet.companion", unloadAttempts: 1, unloadInterval: 0)
        XCTAssertEqual(commands.calls, [
            "/bin/launchctl disable gui/501/app.botfleet.companion",
            "/bin/launchctl bootout gui/501/app.botfleet.companion",
            "/bin/launchctl print gui/501/app.botfleet.companion"
        ])
    }

    func testANonzeroBootoutWhoseJobIsGoneIsAStopThatHeld() async throws {
        // launchctl bootout exits nonzero while a teardown is in progress and
        // when the job was already gone, so its exit status says nothing.
        // The job being unloaded is what proves the stop, and the agent stays
        // disabled.
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let commands = LaunchAgentCommands()
        commands.bootoutFailure = CommandExitError(output: "Boot-out failed: 3: No such process")
        try await StartupPolicy(home: home, commands: commands, uid: 501, environment: [:])
            .stopAgent(label: "app.botfleet.companion", unloadAttempts: 1, unloadInterval: 0)
        XCTAssertFalse(commands.calls.contains("/bin/launchctl enable gui/501/app.botfleet.companion"))
        XCTAssertEqual(commands.calls.last, "/bin/launchctl print gui/501/app.botfleet.companion")
    }

    func testABootoutThatTimesOutStillCountsWhenTheJobIsGone() async throws {
        // The command runner reports a timeout as a generic failure, which is
        // not a CommandExitError.  It must not be read as a failed stop
        // either: launchd is asked, and the answer decides.
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let commands = LaunchAgentCommands()
        commands.bootoutFailure = StartupPolicyError.commandFailed
        try await StartupPolicy(home: home, commands: commands, uid: 501, environment: [:])
            .stopAgent(label: "app.botfleet.companion", unloadAttempts: 1, unloadInterval: 0)
        XCTAssertFalse(commands.calls.contains { $0.contains("enable") })
    }

    func testAStopWhoseJobStaysLoadedPutsTheEnableBack() async throws {
        // An agent that is still running must not be left disabled behind
        // the owner's back, so when launchd still has the job after the
        // bootout, the enable goes back, one more look confirms the job is
        // still there, and the refusal says it may still be stopping.
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let commands = LaunchAgentCommands()
        commands.loaded = true
        await assertThrowsAsync({
            try await StartupPolicy(home: home, commands: commands, uid: 501, environment: [:])
                .stopAgent(label: "app.botfleet.companion", unloadAttempts: 2, unloadInterval: 0)
        }) { error in
            XCTAssertTrue("\(error)".contains("still loaded"), "\(error)")
            XCTAssertTrue("\(error)".contains("may still be stopping"), "\(error)")
        }
        XCTAssertEqual(commands.calls, [
            "/bin/launchctl disable gui/501/app.botfleet.companion",
            "/bin/launchctl bootout gui/501/app.botfleet.companion",
            "/bin/launchctl print gui/501/app.botfleet.companion",
            "/bin/launchctl print gui/501/app.botfleet.companion",
            "/bin/launchctl enable gui/501/app.botfleet.companion",
            "/bin/launchctl print gui/501/app.botfleet.companion"
        ])
    }

    func testAJobThatUnloadsJustAfterTheReEnableIsDisabledAgain() async throws {
        // A teardown that finishes between the last look and the enable
        // would otherwise leave the agent enabled and unloaded, which is a
        // stop that comes back at the next login.  The look after the enable
        // catches it and the disable goes back on.
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let commands = LaunchAgentCommands()
        commands.loadedAnswers = [true, true, false]
        try await StartupPolicy(home: home, commands: commands, uid: 501, environment: [:])
            .stopAgent(label: "app.botfleet.companion", unloadAttempts: 2, unloadInterval: 0)
        XCTAssertEqual(commands.calls, [
            "/bin/launchctl disable gui/501/app.botfleet.companion",
            "/bin/launchctl bootout gui/501/app.botfleet.companion",
            "/bin/launchctl print gui/501/app.botfleet.companion",
            "/bin/launchctl print gui/501/app.botfleet.companion",
            "/bin/launchctl enable gui/501/app.botfleet.companion",
            "/bin/launchctl print gui/501/app.botfleet.companion",
            "/bin/launchctl disable gui/501/app.botfleet.companion"
        ])
    }

    func testAPrintThatCouldNotBeAskedIsNotReadAsUnloaded() async throws {
        // The runner's timeout is a generic failure, not launchctl's "no such
        // service".  Reading it as unloaded would leave a running agent
        // disabled, so it is "could not ask": the enable goes back and the
        // refusal says launchd did not answer.
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let commands = LaunchAgentCommands()
        commands.printFailure = StartupPolicyError.commandFailed
        await assertThrowsAsync({
            try await StartupPolicy(home: home, commands: commands, uid: 501, environment: [:])
                .stopAgent(label: "app.botfleet.companion", unloadAttempts: 2, unloadInterval: 0)
        }) { error in
            XCTAssertTrue("\(error)".contains("did not answer"), "\(error)")
            XCTAssertTrue("\(error)".contains("left enabled"), "\(error)")
        }
        // One look that launchd did not answer ends the wait: the runner's
        // timeout was already spent, and another look would not change that.
        XCTAssertEqual(commands.calls, [
            "/bin/launchctl disable gui/501/app.botfleet.companion",
            "/bin/launchctl bootout gui/501/app.botfleet.companion",
            "/bin/launchctl print gui/501/app.botfleet.companion",
            "/bin/launchctl enable gui/501/app.botfleet.companion"
        ])
    }

    func testALateDisableThatFailsIsAReportedRefusalNotAHeldStop() async throws {
        // The job went away just after the re-enable, so the disable goes
        // back on.  When that disable fails, the agent is enabled and
        // unloaded: launchd starts it again at the next login, which is the
        // one state the extra look exists to prevent, so the owner reads a
        // refusal rather than a stop reported as held.
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let commands = LaunchAgentCommands()
        commands.loadedAnswers = [true, false]
        commands.disableAnswers = [nil, CommandExitError(output: "", errorOutput: "Could not disable service")]
        await assertThrowsAsync({
            try await StartupPolicy(home: home, commands: commands, uid: 501, environment: [:])
                .stopAgent(label: "app.botfleet.companion", unloadAttempts: 1, unloadInterval: 0)
        }) { error in
            XCTAssertTrue("\(error)".contains("next login"), "\(error)")
            XCTAssertTrue("\(error)".contains("Repeat Stop"), "\(error)")
        }
        XCTAssertEqual(commands.calls, [
            "/bin/launchctl disable gui/501/app.botfleet.companion",
            "/bin/launchctl bootout gui/501/app.botfleet.companion",
            "/bin/launchctl print gui/501/app.botfleet.companion",
            "/bin/launchctl enable gui/501/app.botfleet.companion",
            "/bin/launchctl print gui/501/app.botfleet.companion",
            "/bin/launchctl disable gui/501/app.botfleet.companion"
        ])
    }

    func testARefusalSaysWhenTheReEnableItselfFailed() async throws {
        // The refusal says only what was checked: when the enable that puts
        // the agent back failed, it must not claim the agent is left enabled.
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let commands = LaunchAgentCommands()
        commands.loaded = true
        commands.enableFailure = StartupPolicyError.commandFailed
        await assertThrowsAsync({
            try await StartupPolicy(home: home, commands: commands, uid: 501, environment: [:])
                .stopAgent(label: "app.botfleet.companion", unloadAttempts: 1, unloadInterval: 0)
        }) { error in
            XCTAssertTrue("\(error)".contains("could not re-enable"), "\(error)")
            XCTAssertTrue("\(error)".contains("until Start is used"), "\(error)")
            XCTAssertFalse("\(error)".contains("left enabled"), "\(error)")
        }
    }

    func testANonFiniteWaitCannotTrapTheStop() async throws {
        // stopAgent is public API: a caller's interval is clamped before it
        // is used, so an infinite or NaN interval waits nothing and the
        // refusal still reads as a refusal instead of trapping the app.
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let commands = LaunchAgentCommands()
        commands.loaded = true
        await assertThrowsAsync({
            try await StartupPolicy(home: home, commands: commands, uid: 501, environment: [:])
                .stopAgent(label: "app.botfleet.companion", unloadAttempts: 2, unloadInterval: .infinity)
        }) { error in
            XCTAssertTrue("\(error)".contains("still loaded"), "\(error)")
        }
        XCTAssertEqual(StartupPolicy.unloadStep(.nan), 0)
        XCTAssertEqual(StartupPolicy.unloadStep(-3), 0)
        XCTAssertEqual(StartupPolicy.unloadStep(600), 60)
        XCTAssertEqual(StartupPolicy.unloadStep(0.5), 0.5)
    }

    func testStoppingTheCompanionThroughTheFleetServicesGoesThroughLaunchd() async throws {
        // The fleet-service path is the one the menu uses, so the launchd
        // stop is driven through it: disable, bootout, and a look that finds
        // the job gone.
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let commands = LaunchAgentCommands()
        let control = FleetServiceControl(
            pm2: pm2(FleetServiceCommands()),
            startup: StartupPolicy(home: home, commands: commands, uid: 501, environment: [:]),
            mcpServer: nil)
        let state = try await control.perform(.stop, serviceID: FleetServiceRegistry.companion.id)
        XCTAssertNotEqual(state, .running)
        XCTAssertTrue(commands.calls.contains("/bin/launchctl disable gui/501/app.botfleet.companion"))
        XCTAssertTrue(commands.calls.contains("/bin/launchctl bootout gui/501/app.botfleet.companion"))
        XCTAssertTrue(commands.calls.contains("/bin/launchctl print gui/501/app.botfleet.companion"))
        XCTAssertFalse(commands.calls.contains("/bin/launchctl enable gui/501/app.botfleet.companion"))
    }

    func testAPrintThatFailedForAnotherReasonIsNotReadAsUnloaded() async throws {
        // Only "Could not find service" proves the job is gone.  A print that
        // failed with any other complaint, here a domain launchd would not
        // print, says nothing about the job: the enable goes back and the
        // refusal says launchd did not answer.
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let commands = LaunchAgentCommands()
        commands.printFailure = CommandExitError(output: "", errorOutput: "Could not print domain: 1: Operation not permitted")
        await assertThrowsAsync({
            try await StartupPolicy(home: home, commands: commands, uid: 501, environment: [:])
                .stopAgent(label: "app.botfleet.companion", unloadAttempts: 1, unloadInterval: 0)
        }) { error in
            XCTAssertTrue("\(error)".contains("did not answer"), "\(error)")
        }
        XCTAssertEqual(commands.calls.last, "/bin/launchctl enable gui/501/app.botfleet.companion")
    }

    func testTheUnloadWindowOutlastsLaunchdsKillDeadline() {
        // launchd gives a job twenty seconds after SIGTERM before it kills
        // it, so a wait shorter than that would call a slow teardown a
        // failed stop.
        XCTAssertGreaterThanOrEqual(Double(StartupPolicy.unloadAttempts) * StartupPolicy.unloadInterval, 25)
    }

    func testTheUnloadWaitReallySleepsBetweenLooks() async throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let commands = LaunchAgentCommands()
        commands.loaded = true
        let start = Date()
        _ = try? await StartupPolicy(home: home, commands: commands, uid: 501, environment: [:])
            .stopAgent(label: "app.botfleet.companion", unloadAttempts: 3, unloadInterval: 0.1)
        // Three looks, two sleeps of a tenth of a second between them.
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(start), 0.15)
    }

    func testADisableThatTimesOutStopsNothingAndNamesTheAgent() async throws {
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let commands = LaunchAgentCommands()
        commands.disableFailure = StartupPolicyError.commandFailed
        await assertThrowsAsync({
            try await StartupPolicy(home: home, commands: commands, uid: 501, environment: [:])
                .stopAgent(label: "app.botfleet.companion", unloadAttempts: 1, unloadInterval: 0)
        }) { error in
            XCTAssertTrue("\(error)".contains("app.botfleet.companion"), "\(error)")
            XCTAssertTrue("\(error)".contains("nothing was stopped"), "\(error)")
        }
        XCTAssertEqual(commands.calls, ["/bin/launchctl disable gui/501/app.botfleet.companion"])
    }

    func testADisableThatFailsStopsNothing() async throws {
        // The disable is what makes the stop durable, so a disable that
        // fails is a stop that must not proceed to the bootout.
        let home = try makeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let commands = LaunchAgentCommands()
        commands.disableFailure = CommandExitError(output: "Could not find service")
        await assertThrowsAsync {
            try await StartupPolicy(home: home, commands: commands, uid: 501, environment: [:])
                .stopAgent(label: "app.botfleet.companion", unloadAttempts: 1, unloadInterval: 0)
        }
        XCTAssertEqual(commands.calls, ["/bin/launchctl disable gui/501/app.botfleet.companion"])
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

    // MARK: - Waiting for a change

    func testAWaitWithAnImpossibleIntervalDoesNotTrap() async throws {
        // A negative or an enormous interval would trap the conversion to
        // nanoseconds, and this is public API.
        var observations = 0
        _ = await ManagedServices.settle(to: .running, attempts: 2, interval: -1) {
            observations += 1
            return .stopped
        }
        XCTAssertEqual(observations, 3)
        var endless = 0
        _ = await ManagedServices.settle(to: .running, attempts: 1, interval: .infinity) {
            endless += 1
            return .stopped
        }
        XCTAssertEqual(endless, 2)
    }

    func testAMCPChangeKeepsItsTwentySecondWindow() {
        // The MCP server is observed through an HTTP health endpoint, so a
        // look at it costs no process and its window stays the twenty
        // seconds it always was.
        XCTAssertEqual(PM2Client.mcpSettleWindow, 20)
    }

    func testAWaitWithAWallClockBudgetStopsAtItsDeadline() async {
        // A look at the MCP server is an HTTP probe, and a probe that hangs
        // costs its whole request timeout.  A count of looks would let the
        // app sit busy for far longer than the window it promises, so the
        // wait is bounded by the time it is given.
        var looks = 0
        let start = Date()
        let observed = await ManagedServices.settle(to: .running, within: 1.0, interval: 0.1) {
            looks += 1
            try? await Task.sleep(nanoseconds: 400_000_000)
            return .stopped
        }
        let elapsed = Date().timeIntervalSince(start)
        XCTAssertEqual(observed, .stopped)
        XCTAssertGreaterThan(looks, 1)
        XCTAssertLessThan(elapsed, 3.0)
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

    // MARK: - The owner's stops outlive the app

    func testTheOwnersStopsAreKeptOnDiskWithPrivatePermissions() throws {
        // A stop the owner asked for has to hold past a relaunch of Control,
        // a login and a restart, so it is written down, and the file is the
        // owner's alone.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent(".botfleet/control-owner-stops.json")
        let store = OwnerStopsStore(fileURL: file)
        try store.save(["botfleet-mcp", "app.botfleet.companion"])
        XCTAssertEqual(OwnerStopsStore(fileURL: file).load(), ["botfleet-mcp", "app.botfleet.companion"])
        let mode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(mode?.intValue, 0o600)
    }

    func testAMissingRecordIsAnEmptyOne() {
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("control-owner-stops.json")
        XCTAssertEqual(OwnerStopsStore(fileURL: file).load(), [])
    }

    func testSavingAgainReplacesTheRecord() throws {
        // A start takes a service out of the record, and the file has to say
        // so, or the next launch would stop a service the owner started.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("control-owner-stops.json")
        let store = OwnerStopsStore(fileURL: file)
        try store.save(["botfleet-mcp", "shellular"])
        try store.save(["shellular"])
        XCTAssertEqual(store.load(), ["shellular"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 1)
    }

    func testAnUnreadableRecordIsAnEmptyOneAndIsMovedAsideOnce() throws {
        // A record that cannot be read is not the owner's stops, so the
        // fleet's own rules apply, and the file is moved aside under another
        // name rather than erased.  Moved, not copied: a second launch must
        // not make a second backup.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("control-owner-stops.json")
        try Data("not json".utf8).write(to: file)
        let store = OwnerStopsStore(fileURL: file)
        XCTAssertEqual(store.load(), [])
        XCTAssertEqual(store.load(), [])
        let kept = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertEqual(kept.count, 1, "\(kept)")
        XCTAssertTrue(kept[0].contains("corrupt"), "\(kept)")
        XCTAssertEqual(try String(contentsOf: directory.appendingPathComponent(kept[0])), "not json")
    }

    func testARecordThatCannotBeReadIsLeftWhereItIs() throws {
        // A read error is not a corrupt record: the file stays, so a passing
        // permission or I/O problem never costs the owner their stops, and
        // this launch runs on the fleet's own rules.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("control-owner-stops.json")
        try Data(#"{"stoppedByOwner":["botfleet-mcp"]}"#.utf8).write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: file.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path) }
        let store = OwnerStopsStore(fileURL: file)
        XCTAssertEqual(store.load(), [])
        XCTAssertTrue(store.recordUnread)
        let kept = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertEqual(kept, ["control-owner-stops.json"])
        // A save would replace the stops still in the unread file with this
        // launch's view of them, so it is refused and the file is untouched.
        XCTAssertThrowsError(try store.save(["botfleet-companion"])) { error in
            XCTAssertEqual(error as? OwnerStopsStoreError, .recordUnread)
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        XCTAssertEqual(store.load(), ["botfleet-mcp"])
        XCTAssertFalse(store.recordUnread)
        try store.save(["botfleet-companion"])
        XCTAssertEqual(OwnerStopsStore(fileURL: file).load(), ["botfleet-companion"])
    }

    func testAStopIsRecordedEvenWhenItCannotBeWrittenDown() throws {
        // The app keeps the stop for this launch and only reports that it
        // will not outlive it, so the record has to change before the write
        // and stay changed when the write fails.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // A regular file where the record's parent directory should be, so
        // the store cannot create the directory and the save throws.
        let blocker = directory.appendingPathComponent("not-a-directory")
        try Data("x".utf8).write(to: blocker)
        let store = OwnerStopsStore(fileURL: blocker.appendingPathComponent("control-owner-stops.json"))
        var stops = OwnerStops()
        XCTAssertThrowsError(try stops.record(.stop, id: "botfleet-mcp", saving: store))
        XCTAssertEqual(stops.ids, ["botfleet-mcp"])
    }

    func testARecordedStopIsWrittenDownAndReadBackByTheNextLaunch() throws {
        // What the app does at launch and after every action, in one place:
        // record and save, then a fresh record from the same store carries
        // the stop; a refused change restored and saved takes it back out.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = OwnerStopsStore(fileURL: directory.appendingPathComponent("control-owner-stops.json"))
        var stops = OwnerStops(loadedFrom: store)
        XCTAssertEqual(stops.ids, [])
        try stops.record(.stop, id: "botfleet-mcp", saving: store)
        XCTAssertEqual(OwnerStops(loadedFrom: store).ids, ["botfleet-mcp"])
        let previous = stops.ids
        try stops.record(.start, id: "botfleet-mcp", saving: store)
        XCTAssertEqual(OwnerStops(loadedFrom: store).ids, [])
        try stops.restore(previous, saving: store)
        XCTAssertEqual(OwnerStops(loadedFrom: store).ids, ["botfleet-mcp"])
    }

    // MARK: - Waiting for the server's port to close

    func testTheWaitForAnAbsentPortEndsAtTheFirstRefusedConnection() async {
        var answers: [ServerPresence] = [.present, .present, .absent, .present]
        let probe = ServerPresenceProbe(port: 8799, connect: { _ in answers.removeFirst() })
        let answer = await probe.waitUntilAbsent(within: 5, interval: 0.01)
        XCTAssertEqual(answer, .absent)
        XCTAssertEqual(answers, [.present])
    }

    func testTheWaitReportsWhatItLastSawAtTheDeadline() async {
        // A port that still answers and a probe that could not tell are
        // different answers, and the caller must be able to tell them apart:
        // one is a listener to point the owner at, the other is nothing.
        let listening = ServerPresenceProbe(port: 8799, connect: { _ in .present })
        let stillThere = await listening.waitUntilAbsent(within: 0.05, interval: 0.01)
        XCTAssertEqual(stillThere, .present)
        let blind = ServerPresenceProbe(port: 8799, connect: { _ in .unknown })
        let couldNotTell = await blind.waitUntilAbsent(within: 0.05, interval: 0.01)
        XCTAssertEqual(couldNotTell, .unknown)
    }

    // MARK: - Stopping the BotFleet Server

    func testStoppingTheBotFleetServerAsksTheServerToStopItself() async throws {
        // launchd does not always own the server process: the installed
        // wrapper exits when the harness is already healthy, and the desktop
        // app forks its own harness when nothing answers on the port.  A
        // bootout can leave a server that is still serving.
        let home = try makeHome(serverInstalled: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let commands = LaunchAgentCommands()
        let asked = Counter()
        let control = FleetServiceControl(
            pm2: pm2(FleetServiceCommands()),
            startup: StartupPolicy(home: home, commands: commands, uid: 501, environment: [:]),
            mcpServer: nil,
            stopServer: { asked.increment() })
        _ = try await control.perform(.stop, serviceID: FleetServiceRegistry.server.id)
        XCTAssertEqual(asked.value, 1)
        XCTAssertFalse(commands.calls.contains { $0.contains("bootout") })
    }

    func testTheMCPWaitIsBoundedByItsWindowAndNotByTheCostOfALook() async throws {
        // A look at the MCP server is an HTTP probe, and a probe that hangs
        // costs its whole request timeout.  A count of looks would let the
        // menu bar app sit busy for far longer than the window it
        // promises, so the wait is bounded by the time it is given.
        FleetServiceURLProtocol.handler = { _ in
            Thread.sleep(forTimeInterval: 0.5)
            return .response(200, Data(#"{"status":"ok","app":"botfleet-admin-mcp"}"#.utf8))
        }
        let mcp = try McpServerControl(session: mockSession(),
                                       baseURL: URL(string: "http://127.0.0.1:8794"),
                                       pm2: PM2Client(commands: FleetServiceCommands(),
                                                      nodePath: "/usr/bin/node",
                                                      pm2Path: "/usr/bin/pm2"))
        // The server never goes away, so the wait runs for the whole window
        // instead of ending as soon as the wanted state is seen.
        let start = Date()
        let observed = try await mcp.setRunning(false, within: 2)
        let elapsed = Date().timeIntervalSince(start)
        XCTAssertEqual(observed, .running)
        XCTAssertLessThan(elapsed, 8.0)
    }

    func testTheServersStopIsWaitedForWithTheSameWindowAsThePM2Wait() {
        // The window the stop promises has to be the window it gets, and it
        // is the same twenty seconds the pm2 wait gives.
        XCTAssertEqual(FleetServiceControl.settleInterval, 2.5)
        XCTAssertEqual(Double(PM2Client.settleAttempts) * PM2Client.settleInterval, 20.0)
        XCTAssertEqual(Double(PM2Client.settleAttempts) * FleetServiceControl.settleInterval, 20.0)
    }

    func testTheServersStopReportsTheStateThatWasObserved() async throws {
        // The server answers the stop request before it has exited, so the
        // state that is reported is the one that was observed after it and
        // not a constant that happens to be the expected one.
        //
        // The home is a directory of its own, because the state of the
        // server is read from the LaunchAgent plist that is installed: a
        // machine that has the BotFleet Server installed and a build
        // machine that has none would otherwise answer differently.
        let home = try makeHome(serverInstalled: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let commands = LaunchAgentCommands()
        commands.listing = "PID\tStatus\tLabel\n123\t0\tapp.botfleet.server"
        let control = FleetServiceControl(
            pm2: pm2(FleetServiceCommands()),
            startup: StartupPolicy(home: home, commands: commands, uid: 501, environment: [:]),
            mcpServer: nil,
            stopServer: { })
        let state = try await control.perform(.stop, serviceID: FleetServiceRegistry.server.id, attempts: 2)
        XCTAssertEqual(state, .running)
    }

    func testStoppingTheBotFleetServerIsRefusedWhenTheServerCannotBeAsked() async throws {
        let home = try makeHome(serverInstalled: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let control = FleetServiceControl(pm2: pm2(FleetServiceCommands()),
                                          startup: StartupPolicy(home: home, commands: LaunchAgentCommands(), uid: 501, environment: [:]),
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
        let marker = home.appendingPathComponent(".botfleet/stopped.marker")
        try Data().write(to: marker)
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
        // The restart did not replace the server, so the owner's deliberate
        // stop stands: the marker has to be back where it was, or the
        // wrapper would bring the server back at the next launchd run.
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path))
    }

    func testARefusedRestartDoesNotPutTheMarkerBackWhenTheStateIsUnknown() async throws {
        // launchctl could not be asked, so nothing is known about the
        // server.  The marker must not be re-created on that, and the
        // refusal must not claim the server was not replaced.
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
        commands.loaded = false
        commands.listingFails = true
        let control = FleetServiceControl(
            pm2: pm2(FleetServiceCommands()),
            startup: StartupPolicy(home: home, commands: commands, uid: 501, environment: [:]),
            mcpServer: nil)
        do {
            _ = try await control.perform(.restart, serviceID: FleetServiceRegistry.server.id, attempts: 2)
            XCTFail("a restart that could not be checked should not be reported as a success")
        } catch {
            XCTAssertTrue("\(error)".contains("could not be checked"))
            XCTAssertFalse("\(error)".contains("not replaced"))
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
    }

    func testTheStopCopyPromisesOnlyWhatTheMenuOffers() {
        // On a wrapper that cannot carry the startup policy the row has no
        // Restart, so the copy must not point the owner at one.
        let services = FleetServices(serverState: .running,
                                    states: ["app.botfleet.server": .running],
                                    startupPolicySupported: false)
        let row = services.menuItems.first { $0.id == "app.botfleet.server" }
        let body = FleetServices.stopBody(for: row!, startupPolicySupported: false)
        XCTAssertFalse(body.contains("Restart clears the marker"))
        XCTAssertTrue(body.contains("stopped.marker"))
    }

    func testTheStopCopyOnAWrapperThatCanRestartPromisesTheRestart() {
        let services = FleetServices(serverState: .running,
                                    states: ["app.botfleet.server": .running],
                                    startupPolicySupported: true)
        let row = services.menuItems.first { $0.id == "app.botfleet.server" }
        let body = FleetServices.stopBody(for: row!, startupPolicySupported: true)
        XCTAssertTrue(body.contains("Restart clears the marker"))
        XCTAssertFalse(body.contains("older than Control"))
    }

    func testTheStopCopyForAnOutdatedServerSaysTheWorkCheckIsUnavailable() {
        // The in-flight-work check belongs to the stop route the old server
        // does not have, so the copy must say that the check is gone rather
        // than promise a refusal the server cannot make.
        let services = FleetServices(serverState: .running,
                                    states: ["app.botfleet.server": .running],
                                    startupPolicySupported: true)
        let row = services.menuItems.first { $0.id == "app.botfleet.server" }
        let body = FleetServices.stopBody(for: row!, startupPolicySupported: true, serverOutdated: true)
        XCTAssertTrue(body.contains("older than Control"))
        XCTAssertTrue(body.contains("not protected"))
        XCTAssertFalse(body.contains("The server refuses while work is in flight"))
    }

    func testTheStopCopyForALaunchAgentPromisesItStaysStopped() {
        let services = FleetServices(serverState: .running,
                                    states: ["app.botfleet.companion": .running])
        let row = services.menuItems.first { $0.id == "app.botfleet.companion" }
        let body = FleetServices.stopBody(for: row!, startupPolicySupported: true)
        XCTAssertTrue(body.contains("across logins and restarts"))
    }

    func testAServerRestartWaitsNoLongerThanTheCallerAskedFor() async throws {
        // The launchd path has to honour the caller's wait, the way the pm2
        // path does, or a caller cannot bound the time it spends here.
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
        _ = try? await control.perform(.restart, serviceID: FleetServiceRegistry.server.id, attempts: 2)
        // Two attempts and the look that follows them are three looks, and
        // every one of them asks launchctl what the state is.
        let looks = commands.calls.filter { $0.contains("launchctl list") }.count
        XCTAssertEqual(looks, 3)
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
        let home = try makeHome(serverInstalled: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let control = makeControl(commands: FleetServiceCommands(), home: home)
        let states = await control.states(serverState: .running)
        XCTAssertEqual(states["botfleet-mcp"], .running)
    }

    func testTheMCPServerIsUnknownWhenItsHealthEndpointDoesNotAnswer() async throws {
        FleetServiceURLProtocol.handler = { _ in .failure(URLError(.timedOut)) }
        let home = try makeHome(serverInstalled: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let control = makeControl(commands: FleetServiceCommands(), home: home)
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
        let home = try makeHome(serverInstalled: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let control = makeControl(commands: commands, home: home)
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

    /// A home directory of its own, with the LaunchAgents the fleet
    /// services read.
    ///
    /// A test must not read the LaunchAgents of the machine it runs on: a
    /// workstation that has the BotFleet Server installed answers a
    /// different state from a build machine that has none.
    private func makeHome(serverInstalled: Bool = false) throws -> URL {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: home.appendingPathComponent("Library/LaunchAgents"),
                                                withIntermediateDirectories: true)
        try Data().write(to: home.appendingPathComponent("Library/LaunchAgents/app.botfleet.companion.plist"))
        if serverInstalled {
            try Data().write(to: home.appendingPathComponent("Library/LaunchAgents/app.botfleet.server.plist"))
        }
        return home
    }

    /// A control that reads the fleet services out of a home of its own.
    ///
    /// The home is the caller's, so it can be removed when the test is
    /// done with it.
    private func makeControl(commands: FleetServiceCommands,
                             home: URL) -> FleetServiceControl {
        FleetServiceControl(pm2: PM2Client(commands: commands, nodePath: "/usr/bin/node",
                                           pm2Path: "/usr/bin/pm2", home: home),
                            startup: StartupPolicy(home: home, commands: LaunchAgentCommands(), uid: 501, environment: [:]),
                            mcpServer: try? McpServerControl(session: mockSession(),
                                                            baseURL: URL(string: "http://127.0.0.1:8794"),
                                                            pm2: PM2Client(commands: commands,
                                                                           nodePath: "/usr/bin/node",
                                                                           pm2Path: "/usr/bin/pm2", home: home)))
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
    /// True when launchctl cannot be asked at all.
    var listingFails = false
    /// The failure `launchctl bootout` raises, when it raises one.
    var bootoutFailure: Error?
    /// The failure `launchctl disable` raises, when it raises one.
    var disableFailure: Error?
    /// What successive `launchctl disable` calls answer, nil for success,
    /// when a test needs one disable to fail and not another; `disableFailure`
    /// is used once this runs out.
    var disableAnswers: [Error?] = []
    /// The failure `launchctl enable` raises, when it raises one.
    var enableFailure: Error?
    /// The failure every `launchctl print` raises, when the runner could not
    /// ask launchd at all (a timeout, not a "no such service").
    var printFailure: Error?
    /// What successive `launchctl print` calls answer, when a test needs the
    /// job to go away part way through; `loaded` is used once this runs out.
    var loadedAnswers: [Bool] = []
    /// The boot id the startup policy records.
    var boot = "4F9389E9-AFE4-42C8-AE2C-7FEEDBA31B6C"

    func run(_ executable: String, _ arguments: [String]) throws -> String {
        calls.append(([executable] + arguments).joined(separator: " "))
        if executable == "/usr/sbin/sysctl" { return boot }
        if arguments.first == "bootout", let bootoutFailure { throw bootoutFailure }
        if arguments.first == "enable", let enableFailure { throw enableFailure }
        if arguments.first == "disable" {
            if disableAnswers.isEmpty {
                if let disableFailure { throw disableFailure }
            } else if let failure = disableAnswers.removeFirst() {
                throw failure
            }
        }
        if arguments == ["list"] {
            if listingFails { throw StartupPolicyError.commandFailed }
            return listing
        }
        if arguments.first == "print" {
            if let printFailure { throw printFailure }
            let isLoaded = loadedAnswers.isEmpty ? loaded : loadedAnswers.removeFirst()
            if isLoaded { return "state = running" }
            // launchctl exits nonzero for a job that is not loaded and says
            // so on stderr; the runner reports both with the exit error.
            throw CommandExitError(output: "", errorOutput: "Could not find service \"\(arguments.last ?? "")\" in domain for uid: 501")
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
