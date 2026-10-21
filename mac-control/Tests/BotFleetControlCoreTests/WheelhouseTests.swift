import XCTest
@testable import BotFleetControlCore

final class WheelhouseTests: XCTestCase {
    // MARK: - Wanted state derivation

    func testMCPServerIsWantedExactlyWhileTheServerRuns() {
        let running = Wheelhouse(serverState: .running, mcpServerState: .stopped)
        XCTAssertEqual(running.mcpServerWanted, true)
        let stopped = Wheelhouse(serverState: .stopped, mcpServerState: .running)
        XCTAssertEqual(stopped.mcpServerWanted, false)
        let unknown = Wheelhouse(serverState: .unknown, mcpServerState: .running)
        XCTAssertNil(unknown.mcpServerWanted)
    }

    func testWantedStateIsNeverStoredOnTheEntry() {
        let entry = WheelhouseEntry(id: Wheelhouse.mcpServerID, title: Wheelhouse.mcpServerTitle,
                                    wanted: nil, state: .running)
        XCTAssertNil(entry.wanted)
        XCTAssertEqual(entry.state, .running)
    }

    func testServerStateComesFromWhatTheControlAppAlreadyKnows() {
        XCTAssertEqual(Wheelhouse.serverState(statusAvailable: true, apiUnavailable: false,
                                               installedServerState: .stopped), .running)
        XCTAssertEqual(Wheelhouse.serverState(statusAvailable: false, apiUnavailable: false,
                                               installedServerState: .running), .running)
        XCTAssertEqual(Wheelhouse.serverState(statusAvailable: false, apiUnavailable: true,
                                               installedServerState: .stopped), .stopped)
        XCTAssertEqual(Wheelhouse.serverState(statusAvailable: false, apiUnavailable: false,
                                               installedServerState: .stopped), .unknown)
        XCTAssertEqual(Wheelhouse.serverState(statusAvailable: false, apiUnavailable: true,
                                               installedServerState: .notInstalled), .unknown)
        XCTAssertEqual(Wheelhouse.serverState(statusAvailable: false, apiUnavailable: true,
                                               installedServerState: .unknown), .unknown)
    }

    func testWheelhouseListsTheBotFleetMCPServer() {
        let wheelhouse = Wheelhouse(serverState: .running, mcpServerState: .running)
        XCTAssertEqual(wheelhouse.entries.count, 1)
        XCTAssertEqual(wheelhouse.entries.first?.id, "botfleet-mcp")
        XCTAssertEqual(wheelhouse.entries.first?.title, "BotFleet MCP Server")
        XCTAssertEqual(wheelhouse.entries.first?.wanted, true)
    }

    // MARK: - Actions

    func testActionStartsAStoppedServiceAndStopsARunningOne() {
        XCTAssertEqual(Wheelhouse.action(for: entry(wanted: true, state: .stopped)), .start)
        XCTAssertEqual(Wheelhouse.action(for: entry(wanted: false, state: .running)), .stop)
    }

    func testActionNeverActsOnAnUnknownWantedOrObservedState() {
        XCTAssertEqual(Wheelhouse.action(for: entry(wanted: nil, state: .stopped)), .none)
        XCTAssertEqual(Wheelhouse.action(for: entry(wanted: nil, state: .running)), .none)
        XCTAssertEqual(Wheelhouse.action(for: entry(wanted: nil, state: .unknown)), .none)
        XCTAssertEqual(Wheelhouse.action(for: entry(wanted: true, state: .unknown)), .none)
        XCTAssertEqual(Wheelhouse.action(for: entry(wanted: false, state: .unknown)), .none)
    }

    func testActionDoesNothingWhenTheServiceAlreadyMatchesTheWantedState() {
        XCTAssertEqual(Wheelhouse.action(for: entry(wanted: true, state: .running)), .none)
        XCTAssertEqual(Wheelhouse.action(for: entry(wanted: false, state: .stopped)), .none)
    }

    func testSummarySaysWhatIsWantedAndWhatIsSeen() {
        XCTAssertEqual(entry(wanted: true, state: .running).summary, "running")
        XCTAssertEqual(entry(wanted: true, state: .stopped).summary, "stopped — wanted running")
        XCTAssertEqual(entry(wanted: false, state: .running).summary, "running — not wanted")
        XCTAssertEqual(entry(wanted: false, state: .stopped).summary, "stopped")
        XCTAssertEqual(entry(wanted: nil, state: .running).summary, "running — wanted state unknown")
    }

    // MARK: - The pm2 client the Control app has to use

    func testPM2EnvironmentCarriesHomeAndPM2Home() {
        let home = URL(fileURLWithPath: "/Users/tester", isDirectory: true)
        let environment = PM2Client.pm2Environment([:], home: home)
        XCTAssertEqual(environment["HOME"], "/Users/tester")
        XCTAssertEqual(environment["PM2_HOME"], "/Users/tester/.pm2")
        XCTAssertFalse(environment["PATH"]?.isEmpty ?? true)
    }

    func testPM2EnvironmentKeepsAnExplicitPM2HomeAndPath() {
        let home = URL(fileURLWithPath: "/Users/tester", isDirectory: true)
        let environment = PM2Client.pm2Environment(["PM2_HOME": "/tmp/pm2", "PATH": "/bin"], home: home)
        XCTAssertEqual(environment["PM2_HOME"], "/tmp/pm2")
        XCTAssertEqual(environment["PATH"], "/bin")
        XCTAssertEqual(environment["HOME"], "/Users/tester")
    }

    func testPM2ClientIsMissingWithoutNodeAndPM2() {
        XCTAssertFalse(PM2Client(commands: PM2Commands(), nodePath: "", pm2Path: "").isAvailable)
        XCTAssertFalse(PM2Client(commands: PM2Commands(), nodePath: "/usr/bin/node", pm2Path: "").isAvailable)
        XCTAssertTrue(PM2Client(commands: PM2Commands(), nodePath: "/usr/bin/node",
                                pm2Path: "/usr/bin/pm2").isAvailable)
    }

    // MARK: - Observing the MCP server

    func testMCPServerIsRunningOnlyWhenItAnswersAsTheBotFleetMCPServer() async {
        let control = makeControl()
        WheelhouseURLProtocol.handler = { _ in
            .response(200, Data(#"{"status":"ok","app":"botfleet-admin-mcp","tools":26}"#.utf8))
        }
        let state = await control.state()
        XCTAssertEqual(state, .running)
    }

    func testMCPServerIsStoppedWhenNothingAnswersIt() async {
        let control = makeControl()
        WheelhouseURLProtocol.handler = { _ in .failure(URLError(.cannotConnectToHost)) }
        let state = await control.state()
        XCTAssertEqual(state, .stopped)
    }

    func testMCPServerIsUnknownWhenSomethingElseAnswersIt() async {
        let control = makeControl()
        WheelhouseURLProtocol.handler = { _ in
            .response(200, Data(#"{"status":"ok","app":"some-other-service"}"#.utf8))
        }
        let state = await control.state()
        XCTAssertEqual(state, .unknown)
    }

    func testMCPServerIsUnknownWhenItAnswersWithSomethingBroken() async {
        let control = makeControl()
        WheelhouseURLProtocol.handler = { _ in .response(200, Data(#"{"status":"ok"}"#.utf8)) }
        let state = await control.state()
        XCTAssertEqual(state, .unknown)
    }

    // MARK: - Changing the MCP server

    func testUnknownStateIsNeverChanged() async throws {
        WheelhouseURLProtocol.handler = { _ in .failure(URLError(.timedOut)) }
        let commands = PM2Commands()
        let control = makeControl(commands: commands)
        let state = try await control.setRunning(true)
        XCTAssertEqual(state, .unknown)
        XCTAssertTrue(commands.calls.isEmpty)
    }

    func testStoppingTheMCPServerRunsPM2Stop() async throws {
        var probes = 0
        WheelhouseURLProtocol.handler = { _ in
            probes += 1
            return probes <= 1
                ? .response(200, Data(#"{"status":"ok","app":"botfleet-admin-mcp"}"#.utf8))
                : .failure(URLError(.cannotConnectToHost))
        }
        let commands = PM2Commands()
        let control = makeControl(commands: commands)
        let state = try await control.setRunning(false, attempts: 2)
        XCTAssertEqual(state, .stopped)
        XCTAssertEqual(commands.calls.count, 1)
        XCTAssertTrue(commands.calls[0].contains("stop"))
        XCTAssertTrue(commands.calls[0].contains("botfleet-mcp"))
    }

    func testStartingTheMCPServerRunsPM2Start() async throws {
        var probes = 0
        WheelhouseURLProtocol.handler = { _ in
            probes += 1
            return probes <= 1
                ? .failure(URLError(.cannotConnectToHost))
                : .response(200, Data(#"{"status":"ok","app":"botfleet-admin-mcp"}"#.utf8))
        }
        let commands = PM2Commands()
        let control = makeControl(commands: commands)
        let state = try await control.setRunning(true, attempts: 2)
        XCTAssertEqual(state, .running)
        XCTAssertEqual(commands.calls.count, 1)
        XCTAssertTrue(commands.calls[0].contains("start"))
        XCTAssertTrue(commands.calls[0].contains("botfleet-mcp"))
    }

    func testARefusedPM2IsReportedRatherThanClaimedAsSuccess() async {
        WheelhouseURLProtocol.handler = { _ in
            .response(200, Data(#"{"status":"ok","app":"botfleet-admin-mcp"}"#.utf8))
        }
        let commands = PM2Commands()
        commands.failure = CommandExitError(output: "pm2 said no")
        let control = makeControl(commands: commands)
        do {
            _ = try await control.setRunning(false, attempts: 1)
            XCTFail("Expected the refusal to be reported")
        } catch {
            XCTAssertEqual(error as? McpServerError, .refused("pm2 said no"))
        }
    }

    // MARK: - Helpers

    private func entry(wanted: Bool?, state: WheelhouseState) -> WheelhouseEntry {
        WheelhouseEntry(id: Wheelhouse.mcpServerID, title: Wheelhouse.mcpServerTitle,
                        wanted: wanted, state: state)
    }

    private func makeControl(commands: PM2Commands = PM2Commands()) -> McpServerControl {
        McpServerControl(session: mockSession(),
                         baseURL: URL(string: "http://127.0.0.1:8794")!,
                         pm2: PM2Client(commands: commands, nodePath: "/usr/bin/node",
                                        pm2Path: "/usr/bin/pm2"))
    }

    private func mockSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WheelhouseURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

private final class PM2Commands: CommandRunning {
    var calls: [[String]] = []
    var failure: Error?
    func run(_ executable: String, _ arguments: [String]) throws -> String {
        calls.append(arguments)
        if let failure { throw failure }
        return ""
    }
}

private final class WheelhouseURLProtocol: URLProtocol {
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
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
                                                                httpVersion: nil, headerFields: nil)!,
                                cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        case .failure(let error):
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}
