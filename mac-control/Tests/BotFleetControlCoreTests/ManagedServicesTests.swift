import XCTest
import Darwin
@testable import BotFleetControlCore

final class ManagedServicesTests: XCTestCase {
    // MARK: - Wanted state derivation

    func testMCPServerIsWantedExactlyWhileTheServerRuns() {
        let running = ManagedServices(serverState: .running, mcpServerState: .stopped)
        XCTAssertEqual(running.mcpServerWanted, true)
        let stopped = ManagedServices(serverState: .stopped, mcpServerState: .running)
        XCTAssertEqual(stopped.mcpServerWanted, false)
        let unknown = ManagedServices(serverState: .unknown, mcpServerState: .running)
        XCTAssertNil(unknown.mcpServerWanted)
    }

    func testWantedStateIsNeverStoredOnTheEntry() {
        let entry = ManagedServiceEntry(id: ManagedServices.mcpServerID, title: ManagedServices.mcpServerTitle,
                                    wanted: nil, state: .running)
        XCTAssertNil(entry.wanted)
        XCTAssertEqual(entry.state, .running)
    }

    func testAServerThatAnswersOrHasALiveProcessIsRunning() {
        XCTAssertEqual(ManagedServices.serverState(statusAvailable: true, installedServerState: .stopped,
                                               serverPresence: .absent), .running)
        XCTAssertEqual(ManagedServices.serverState(statusAvailable: false, installedServerState: .running,
                                               serverPresence: .absent), .running)
    }

    func testAnUnreachableServerThatStillHasAListenerIsUnknown() {
        // The API did not answer, but something is still listening on the
        // server's port: it is busy or booting, and it is not stopped.
        XCTAssertEqual(ManagedServices.serverState(statusAvailable: false, installedServerState: .stopped,
                                               serverPresence: .present), .unknown)
        XCTAssertEqual(ManagedServices.serverState(statusAvailable: false, installedServerState: .unknown,
                                               serverPresence: .present), .unknown)
    }

    func testTheServerIsStoppedOnlyWhenNothingIsListening() {
        XCTAssertEqual(ManagedServices.serverState(statusAvailable: false, installedServerState: .stopped,
                                               serverPresence: .absent), .stopped)
        XCTAssertEqual(ManagedServices.serverState(statusAvailable: false, installedServerState: .notInstalled,
                                               serverPresence: .absent), .stopped)
    }

    func testAnUnreachableServerIsNeverKnownToBeStopped() {
        XCTAssertEqual(ManagedServices.serverState(statusAvailable: false, installedServerState: .stopped,
                                               serverPresence: .unknown), .unknown)
    }

    func testAnUnreachableServerNeverAsksForTheMCPServerToBeStopped() {
        // The regression this guards: a transport error used to read as "the
        // server is stopped", which stopped the MCP server under a live one.
        let managedServices = ManagedServices(serverState: .unknown, mcpServerState: .running)
        XCTAssertNil(managedServices.mcpServerWanted)
        XCTAssertEqual(ManagedServices.action(for: managedServices.entries[0]), .none)
    }

    func testManagedServicesListsTheBotFleetMCPServer() {
        let managedServices = ManagedServices(serverState: .running, mcpServerState: .running)
        XCTAssertEqual(managedServices.entries.count, 1)
        XCTAssertEqual(managedServices.entries.first?.id, "botfleet-mcp")
        XCTAssertEqual(managedServices.entries.first?.title, "BotFleet MCP Server")
        XCTAssertEqual(managedServices.entries.first?.wanted, true)
    }

    // MARK: - Proving whether the server is really there

    func testThePresenceProbeSeesSomethingListening() throws {
        let (port, handle) = try openLoopbackPort()
        defer { close(handle) }
        XCTAssertEqual(ServerPresenceProbe(port: port).presence(), .present)
    }

    func testThePresenceProbeSeesAClosedPort() throws {
        let (port, handle) = try openLoopbackPort()
        close(handle)
        XCTAssertEqual(ServerPresenceProbe(port: port).presence(), .absent)
    }

    func testThePresenceProbeCanBeGivenItsOwnProbe() {
        let probe = ServerPresenceProbe(port: 1234, connect: { _ in .absent })
        XCTAssertEqual(probe.presence(), .absent)
    }

    // MARK: - Actions

    func testActionStartsAStoppedServiceAndStopsARunningOne() {
        XCTAssertEqual(ManagedServices.action(for: entry(wanted: true, state: .stopped)), .start)
        XCTAssertEqual(ManagedServices.action(for: entry(wanted: false, state: .running)), .stop)
    }

    func testActionNeverActsOnAnUnknownWantedOrObservedState() {
        XCTAssertEqual(ManagedServices.action(for: entry(wanted: nil, state: .stopped)), .none)
        XCTAssertEqual(ManagedServices.action(for: entry(wanted: nil, state: .running)), .none)
        XCTAssertEqual(ManagedServices.action(for: entry(wanted: nil, state: .unknown)), .none)
        XCTAssertEqual(ManagedServices.action(for: entry(wanted: true, state: .unknown)), .none)
        XCTAssertEqual(ManagedServices.action(for: entry(wanted: false, state: .unknown)), .none)
    }

    func testActionDoesNothingWhenTheServiceAlreadyMatchesTheWantedState() {
        XCTAssertEqual(ManagedServices.action(for: entry(wanted: true, state: .running)), .none)
        XCTAssertEqual(ManagedServices.action(for: entry(wanted: false, state: .stopped)), .none)
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

    func testMCPServerIsRunningOnlyWhenItAnswersAsTheBotFleetMCPServer() async throws {
        let control = try makeControl()
        ManagedServicesURLProtocol.handler = { _ in
            .response(200, Data(#"{"status":"ok","app":"botfleet-admin-mcp","tools":26}"#.utf8))
        }
        let state = await control.state()
        XCTAssertEqual(state, .running)
    }

    func testMCPServerIsStoppedWhenNothingAnswersIt() async throws {
        let control = try makeControl()
        ManagedServicesURLProtocol.handler = { _ in .failure(URLError(.cannotConnectToHost)) }
        let state = await control.state()
        XCTAssertEqual(state, .stopped)
    }

    func testMCPServerIsUnknownWhenSomethingElseAnswersIt() async throws {
        let control = try makeControl()
        ManagedServicesURLProtocol.handler = { _ in
            .response(200, Data(#"{"status":"ok","app":"some-other-service"}"#.utf8))
        }
        let state = await control.state()
        XCTAssertEqual(state, .unknown)
    }

    func testMCPServerIsUnknownWhenItAnswersWithSomethingBroken() async throws {
        let control = try makeControl()
        ManagedServicesURLProtocol.handler = { _ in .response(200, Data(#"{"status":"ok"}"#.utf8)) }
        let state = await control.state()
        XCTAssertEqual(state, .unknown)
    }

    func testTheMCPControlRefusesToStartWithoutAnEndpoint() {
        XCTAssertThrowsError(try McpServerControl(session: mockSession(), baseURL: nil,
                                                 pm2: PM2Client(commands: PM2Commands(),
                                                               nodePath: "/usr/bin/node",
                                                               pm2Path: "/usr/bin/pm2"))) { error in
            XCTAssertEqual(error as? McpServerError,
                           .refused("Could not determine the BotFleet MCP Server endpoint."))
        }
    }

    // MARK: - Changing the MCP server

    func testUnknownStateIsNeverChanged() async throws {
        ManagedServicesURLProtocol.handler = { _ in .failure(URLError(.timedOut)) }
        let commands = PM2Commands()
        let control = try makeControl(commands: commands)
        let state = try await control.setRunning(true)
        XCTAssertEqual(state, .unknown)
        XCTAssertTrue(commands.calls.isEmpty)
    }

    func testStoppingTheMCPServerRunsPM2Stop() async throws {
        var probes = 0
        ManagedServicesURLProtocol.handler = { _ in
            probes += 1
            return probes <= 1
                ? .response(200, Data(#"{"status":"ok","app":"botfleet-admin-mcp"}"#.utf8))
                : .failure(URLError(.cannotConnectToHost))
        }
        let commands = PM2Commands()
        let control = try makeControl(commands: commands)
        let state = try await control.setRunning(false, within: 2)
        XCTAssertEqual(state, .stopped)
        XCTAssertEqual(commands.calls.count, 1)
        XCTAssertTrue(commands.calls[0].contains("stop"))
        XCTAssertTrue(commands.calls[0].contains("botfleet-mcp"))
    }

    func testStartingTheMCPServerRunsPM2Start() async throws {
        var probes = 0
        ManagedServicesURLProtocol.handler = { _ in
            probes += 1
            return probes <= 1
                ? .failure(URLError(.cannotConnectToHost))
                : .response(200, Data(#"{"status":"ok","app":"botfleet-admin-mcp"}"#.utf8))
        }
        let commands = PM2Commands()
        let control = try makeControl(commands: commands)
        let state = try await control.setRunning(true, within: 2)
        XCTAssertEqual(state, .running)
        XCTAssertEqual(commands.calls.count, 1)
        XCTAssertTrue(commands.calls[0].contains("start"))
        XCTAssertTrue(commands.calls[0].contains("botfleet-mcp"))
    }

    func testARefusedPM2IsReportedRatherThanClaimedAsSuccess() async throws {
        ManagedServicesURLProtocol.handler = { _ in
            .response(200, Data(#"{"status":"ok","app":"botfleet-admin-mcp"}"#.utf8))
        }
        let commands = PM2Commands()
        commands.failure = CommandExitError(output: "pm2 said no")
        let control = try makeControl(commands: commands)
        do {
            _ = try await control.setRunning(false, within: 1)
            XCTFail("Expected the refusal to be reported")
        } catch {
            XCTAssertEqual(error as? McpServerError, .refused("pm2 said no"))
        }
    }

    func testAPM2TimeoutIsReportedAsAPM2Problem() async throws {
        ManagedServicesURLProtocol.handler = { _ in
            .response(200, Data(#"{"status":"ok","app":"botfleet-admin-mcp"}"#.utf8))
        }
        let commands = PM2Commands()
        commands.failure = StartupPolicyError.commandFailed
        let control = try makeControl(commands: commands)
        do {
            _ = try await control.setRunning(false, within: 1)
            XCTFail("Expected the timeout to be reported")
        } catch {
            XCTAssertEqual(error as? McpServerError,
                           .refused("pm2 timed out before it could change the BotFleet MCP Server."))
        }
    }

    // MARK: - Helpers

    private func entry(wanted: Bool?, state: ManagedServiceState) -> ManagedServiceEntry {
        ManagedServiceEntry(id: ManagedServices.mcpServerID, title: ManagedServices.mcpServerTitle,
                        wanted: wanted, state: state)
    }

    private func makeControl(commands: PM2Commands = PM2Commands()) throws -> McpServerControl {
        let url = try XCTUnwrap(URL(string: "http://127.0.0.1:8794"))
        return try McpServerControl(session: mockSession(),
                                    baseURL: url,
                                    pm2: PM2Client(commands: commands, nodePath: "/usr/bin/node",
                                                   pm2Path: "/usr/bin/pm2"))
    }

    private func mockSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ManagedServicesURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    /// Opens a loopback listener on an ephemeral port, so the presence probe
    /// can be tested against a real socket.
    private func openLoopbackPort() throws -> (port: Int, handle: Int32) {
        let handle = socket(AF_INET, SOCK_STREAM, 0)
        guard handle >= 0 else { throw SocketTestError.cannotCreate }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &address) { pointer -> Int32 in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                Darwin.bind(handle, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { close(handle); throw SocketTestError.cannotBind }
        guard Darwin.listen(handle, 1) == 0 else { close(handle); throw SocketTestError.cannotListen }
        var assigned = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &assigned) { pointer -> Int32 in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                getsockname(handle, sockaddrPointer, &length)
            }
        }
        guard named == 0 else { close(handle); throw SocketTestError.cannotName }
        return (Int(UInt16(bigEndian: assigned.sin_port)), handle)
    }
}

private enum SocketTestError: Error {
    case cannotCreate
    case cannotBind
    case cannotListen
    case cannotName
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

private final class ManagedServicesURLProtocol: URLProtocol {
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
