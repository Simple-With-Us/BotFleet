import XCTest
@testable import BotFleetControlCore

final class ProcessMonitorTests: XCTestCase {
    // MARK: - Reading the system

    func testTheProcessListingIsRead() {
        let listing = """
         501     1 /usr/libexec/logd
         76463  76450 node /Users/jay/apps/BotFleet/agents/qdrant-proxy.js --port 6333
        """
        let rows = FleetProcessMonitor.parseProcesses(listing)
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[1].pid, 76463)
        XCTAssertEqual(rows[1].parentPID, 76450)
        XCTAssertEqual(rows[1].command, "node /Users/jay/apps/BotFleet/agents/qdrant-proxy.js --port 6333")
    }

    func testTheProcessListingSkipsRowsItCannotRead() {
        XCTAssertTrue(FleetProcessMonitor.parseProcesses("").isEmpty)
        XCTAssertTrue(FleetProcessMonitor.parseProcesses("not a process").isEmpty)
    }

    func testThePortListingIsRead() {
        let listing = """
        p76463
        cnode
        n*:6333
        p76464
        cPython
        n127.0.0.1:8799
        """
        let listeners = FleetProcessMonitor.parseListeners(listing)
        XCTAssertEqual(listeners.count, 2)
        XCTAssertEqual(listeners[0].port, 6333)
        XCTAssertEqual(listeners[0].pid, 76463)
        XCTAssertEqual(listeners[0].processName, "node")
        XCTAssertEqual(listeners[1].port, 8799)
        XCTAssertEqual(listeners[1].processName, "Python")
    }

    func testAProcessWithNoNameDoesNotInheritThePreviousOne() {
        // The name belongs to the process it was read with, so a record
        // without one is not credited with the last record's name.
        let listing = """
        p76463
        cnode
        n*:6333
        p76464
        n*:8799
        """
        let listeners = FleetProcessMonitor.parseListeners(listing)
        XCTAssertEqual(listeners.count, 2)
        XCTAssertEqual(listeners[0].processName, "node")
        XCTAssertNil(listeners[1].processName)
    }

    func testThePortNumberIsTakenFromTheEnd() {
        XCTAssertEqual(FleetProcessMonitor.portNumber(from: "*:6333"), 6333)
        XCTAssertEqual(FleetProcessMonitor.portNumber(from: "127.0.0.1:8799"), 8799)
        XCTAssertNil(FleetProcessMonitor.portNumber(from: "*"))
    }

    func testTheExecutablePathIsReadSeparately() {
        let listing = """
               45222 /Users/jay/Applications/BotFleet Control.app/Contents/MacOS/BotFleetControl
               101   /usr/local/bin/node
        """
        let paths = FleetProcessMonitor.parseExecutablePaths(listing)
        XCTAssertEqual(paths[45222], "/Users/jay/Applications/BotFleet Control.app/Contents/MacOS/BotFleetControl")
        XCTAssertEqual(paths[101], "/usr/local/bin/node")
    }

    func testAnApplicationPathWithASpaceStillGetsItsOwnName() {
        // The command line is split on spaces, so the name has to come from
        // the executable's own path.
        let rows = [RawProcess(pid: 45222, parentPID: 1,
                               command: "/Users/jay/Applications/BotFleet Control.app/Contents/MacOS/BotFleetControl",
                               executablePath: "/Users/jay/Applications/BotFleet Control.app/Contents/MacOS/BotFleetControl")]
        let classified = FleetProcessClassifier.classify(processes: rows, portsByPID: [:], selfPID: 999)
        XCTAssertEqual(classified[0].name, "BotFleetControl")
        XCTAssertTrue(classified[0].isFleetProcess)
    }

    // MARK: - Telling the fleet's processes from everyone else's

    func testAFleetHelperIsNamedByItsHelperNotItsRuntime() {
        let rows = [RawProcess(pid: 10, parentPID: 1, command: "node /Users/jay/apps/BotFleet/agents/qdrant-proxy.js")]
        let classified = FleetProcessClassifier.classify(processes: rows, portsByPID: [:], selfPID: 999)
        XCTAssertEqual(classified.count, 1)
        XCTAssertEqual(classified[0].name, "qdrant-proxy")
        XCTAssertTrue(classified[0].isFleetProcess)
    }

    func testAProcessThatIsNotTheFleetIsNotTheFleet() {
        let rows = [RawProcess(pid: 10, parentPID: 1, command: "/usr/bin/say hello")]
        let classified = FleetProcessClassifier.classify(processes: rows, portsByPID: [:], selfPID: 999)
        XCTAssertFalse(classified[0].isFleetProcess)
        XCTAssertFalse(classified[0].isOrphan)
    }

    func testAHelperTheServerIsDrivingIsNotAnOrphan() {
        // The server started the helper, so the helper is doing its job.
        let rows = [
            RawProcess(pid: 100, parentPID: 1, command: "node /Users/jay/Code/BotFleet/server/index.js"),
            RawProcess(pid: 101, parentPID: 100, command: "node /Users/jay/apps/BotFleet/agents/qdrant-proxy.js"),
        ]
        let classified = FleetProcessClassifier.classify(processes: rows, portsByPID: [:], selfPID: 999)
        let helper = classified.first { $0.pid == 101 }
        XCTAssertEqual(helper?.isFleetProcess, true)
        XCTAssertEqual(helper?.isOrphan, false)
    }

    func testAServerStartedFromARelativePathStillDrivesItsHelpers() {
        // The launcher starts the server with `server/index.ts` and a working
        // directory, so the command line alone says nothing about which
        // repository it is from.  The working directory does.
        let rows = [
            RawProcess(pid: 100, parentPID: 1,
                       command: "node --experimental-strip-types server/index.ts",
                       workingDirectory: "/Users/jay/Code/BotFleet"),
            RawProcess(pid: 101, parentPID: 100,
                       command: "node /Users/jay/Code/BotFleet/agents/qdrant-proxy.js",
                       workingDirectory: "/Users/jay/Code/BotFleet"),
        ]
        let classified = FleetProcessClassifier.classify(processes: rows, portsByPID: [:], selfPID: 999)
        XCTAssertEqual(classified.first { $0.pid == 100 }?.isFleetProcess, true)
        XCTAssertEqual(classified.first { $0.pid == 100 }?.isOrphan, false)
        XCTAssertEqual(classified.first { $0.pid == 101 }?.isOrphan, false)
    }

    func testARelativeServerPathOutsideAFleetCheckoutIsNotTheFleet() {
        // The same relative path in somebody else's checkout is not the
        // fleet's server.
        let rows = [RawProcess(pid: 100, parentPID: 1,
                               command: "node --experimental-strip-types server/index.ts",
                               workingDirectory: "/Users/jay/Code/Congress.Trade")]
        let classified = FleetProcessClassifier.classify(processes: rows, portsByPID: [:], selfPID: 999)
        XCTAssertFalse(classified[0].isFleetProcess)
        XCTAssertFalse(classified[0].isOrphan)
    }

    func testAHelperTheServerLeftBehindIsAnOrphan() {
        // The server is gone, so the helper was reparented to launchd and is
        // only holding its port.
        let rows = [
            RawProcess(pid: 101, parentPID: 1, command: "node /Users/jay/apps/BotFleet/agents/connector-proxy.js"),
        ]
        let classified = FleetProcessClassifier.classify(processes: rows, portsByPID: [:], selfPID: 999)
        XCTAssertEqual(classified[0].isOrphan, true)
    }

    func testAHelperThatPm2IsDrivingIsNotAnOrphan() {
        let rows = [
            RawProcess(pid: 50, parentPID: 1, command: "PM2 v5.3.0: God Daemon"),
            RawProcess(pid: 51, parentPID: 50, command: "node /Users/jay/apps/BotFleet/agents/agents-proxy.js"),
        ]
        let classified = FleetProcessClassifier.classify(processes: rows, portsByPID: [:], selfPID: 999)
        XCTAssertEqual(classified.first { $0.pid == 51 }?.isOrphan, false)
    }

    func testADevelopmentServerOutOfACheckoutIsAnOrphan() {
        // A development server is never part of the running fleet, even while
        // a shell still holds it open.
        let rows = [
            RawProcess(pid: 17449, parentPID: 500, command: "node /Users/jay/apps/lanes/BotFleet/x/vite.js --port 5173"),
        ]
        let classified = FleetProcessClassifier.classify(processes: rows, portsByPID: [:], selfPID: 999)
        XCTAssertEqual(classified[0].isOrphan, true)
    }

    func testTheServerItselfIsNeverAnOrphan() {
        let rows = [RawProcess(pid: 100, parentPID: 1, command: "node /Users/jay/Code/BotFleet/server/index.js")]
        let classified = FleetProcessClassifier.classify(processes: rows, portsByPID: [:], selfPID: 999)
        XCTAssertTrue(classified[0].isFleetProcess)
        XCTAssertFalse(classified[0].isOrphan)
    }

    func testATestRunnerIsNeverMistakenForADevelopmentServer() {
        // A checkout running its own tests is not the fleet, and the app must
        // never offer to stop it.
        let rows = [RawProcess(pid: 69423, parentPID: 50728,
                               command: "node /Volumes/External/Lanes/BotFleet/lane/node_modules/vitest/vitest.mjs run")]
        let classified = FleetProcessClassifier.classify(processes: rows, portsByPID: [:], selfPID: 999)
        XCTAssertFalse(classified[0].isFleetProcess)
        XCTAssertFalse(classified[0].isOrphan)
    }

    func testLaunchdAndTheAppItselfAreNeverTargets() {
        let rows = [
            RawProcess(pid: 1, parentPID: 0, command: "/sbin/launchd"),
            RawProcess(pid: 42, parentPID: 1, command: "/Applications/BotFleet Control.app/Contents/MacOS/BotFleetControl"),
        ]
        let classified = FleetProcessClassifier.classify(processes: rows, portsByPID: [:], selfPID: 42)
        XCTAssertTrue(classified.isEmpty)
    }

    func testThePortsAProcessHoldsAreCarried() {
        let rows = [RawProcess(pid: 101, parentPID: 1, command: "node /Users/jay/apps/BotFleet/agents/qdrant-proxy.js")]
        let classified = FleetProcessClassifier.classify(processes: rows, portsByPID: [101: [6333]], selfPID: 999)
        XCTAssertEqual(classified[0].ports, [6333])
        XCTAssertEqual(classified[0].summary, "qdrant-proxy (PID 101, port 6333)")
    }

    // MARK: - Reading the fleet

    func testTheSnapshotHoldsTheFleetAndThePortsItUses() {
        let monitor = FleetProcessMonitor(commands: FakeFleetCommands(), selfPID: 999)
        let snapshot = monitor.snapshot()
        XCTAssertEqual(snapshot.processes.count, 1)
        XCTAssertEqual(snapshot.processes[0].name, "qdrant-proxy")
        XCTAssertEqual(snapshot.orphans.count, 1)
        XCTAssertEqual(snapshot.listeners.count, 1)
        XCTAssertEqual(snapshot.listeners[0].port, 6333)
    }

    func testAPortHeldBySomethingOutsideTheFleetIsNotListed() {
        // Port 8799 is one the fleet uses, but the app only offers to stop the
        // ports the fleet's own processes hold.
        let monitor = FleetProcessMonitor(commands: FakeFleetCommands(), selfPID: 999)
        let snapshot = monitor.snapshot()
        XCTAssertFalse(snapshot.listeners.contains { $0.port == 8799 })
    }

    func testAPortNobodyHoldsCannotBeFreed() {
        let monitor = FleetProcessMonitor(commands: FakeFleetCommands(), selfPID: 999)
        XCTAssertThrowsError(try monitor.freePort(9999)) { error in
            guard case FleetProcessError.notFound = error else {
                return XCTFail("Expected a not-found error, got \(error)")
            }
        }
    }

    func testAPortHeldBySomethingOutsideTheFleetCannotBeFreed() {
        let monitor = FleetProcessMonitor(commands: FakeFleetCommands(), selfPID: 999)
        XCTAssertThrowsError(try monitor.freePort(8799)) { error in
            guard case FleetProcessError.notFound = error else {
                return XCTFail("Expected a not-found error, got \(error)")
            }
        }
    }

    func testTheAppRefusesToStopItselfOrLaunchd() {
        let monitor = FleetProcessMonitor(commands: FakeFleetCommands(), selfPID: 42)
        XCTAssertThrowsError(try monitor.terminate(pid: 1))
        XCTAssertThrowsError(try monitor.terminate(pid: 42))
    }

    func testStoppingAProcessRunsTheSystemKill() throws {
        let commands = FakeFleetCommands()
        let monitor = FleetProcessMonitor(commands: commands, selfPID: 999)
        try monitor.terminate(pid: 101)
        XCTAssertTrue(commands.killed.contains(101))
    }
}

/// A stand-in for the system commands the monitor runs.
private final class FakeFleetCommands: CommandRunning {
    var killed: [Int32] = []

    func run(_ executable: String, _ arguments: [String]) throws -> String {
        try run(executable, arguments, timeout: 15)
    }

    func run(_ executable: String, _ arguments: [String], timeout: TimeInterval) throws -> String {
        try run(executable, arguments, environment: [:], timeout: timeout)
    }

    func run(_ executable: String, _ arguments: [String], environment: [String: String], timeout: TimeInterval) throws -> String {
        if executable == "/bin/ps", arguments.contains("pid=,comm=") {
            return """
            101 /usr/local/bin/node
            """
        }
        if executable == "/bin/ps" {
            return """
                   1     0 /sbin/launchd
                   101     1 node /Users/jay/apps/BotFleet/agents/qdrant-proxy.js --port 6333
            """
        }
        if executable == "/usr/sbin/lsof", arguments.contains("cwd") {
            return """
            p101
            fcwd
            n/Users/jay/Code/BotFleet
            """
        }
        if executable == "/usr/sbin/lsof" {
            return """
            p101
            cnode
            n*:6333
            p500
            cpostgres
            n*:8799
            """
        }
        if executable == "/bin/kill", let pid = Int32(arguments.last ?? "") {
            killed.append(pid)
            return ""
        }
        return ""
    }
}
