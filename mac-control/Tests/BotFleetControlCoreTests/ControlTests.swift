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
    }

    func testBusyRefusalIsSurfaced() async {
        MockURLProtocol.handler = { request in
            if request.url!.path == "/api/health" { return (200, Data(#"{"app":"botfleet","pid":42,"ready":true}"#.utf8)) }
            return (409, Data(#"{"error":"Active bot turn"}"#.utf8))
        }
        do { try await ControlAPI(session: mockSession()).stopServer(); XCTFail("Expected refusal") }
        catch { XCTAssertEqual(error as? ControlAPIError, .refused("Active bot turn")) }
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
        let policy = StartupPolicy(home: home, commands: runner, uid: 501)
        XCTAssertFalse(policy.supportsPolicy)
        XCTAssertThrowsError(try policy.setStartsAtLogin(false))
        try Data("# BF_CONTROL_STARTUP_POLICY_V1\n".utf8).write(to: home.appendingPathComponent("apps/botfleet-server-start.sh"))
        try policy.setStartsAtLogin(false)
        XCTAssertFalse(policy.startsAtLogin)
        XCTAssertTrue(FileManager.default.fileExists(atPath: home.appendingPathComponent(".botfleet/startup-disabled.marker").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent(".botfleet/startup-enabled.marker").path))
        XCTAssertEqual(try String(contentsOf: home.appendingPathComponent(".botfleet/startup-session")).trimmingCharacters(in: .whitespacesAndNewlines), runner.boot)
        try policy.setStartsAtLogin(true)
        XCTAssertTrue(policy.startsAtLogin)
        XCTAssertTrue(FileManager.default.fileExists(atPath: home.appendingPathComponent(".botfleet/startup-enabled.marker").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent(".botfleet/startup-disabled.marker").path))
        XCTAssertEqual(runner.calls, ["/usr/sbin/sysctl -n kern.bootsessionuuid", "/usr/sbin/sysctl -n kern.bootsessionuuid"])
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
        try StartupPolicy(home: home, commands: runner, uid: 501).startServer()
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
        XCTAssertThrowsError(try StartupPolicy(home: home, commands: runner, uid: 501).startServer())
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
    func run(_ executable: String, _ arguments: [String]) throws -> String {
        calls.append(([executable] + arguments).joined(separator: " "))
        if executable == "/usr/sbin/sysctl" { return boot }
        if arguments.first == "print" { throw StartupPolicyError.commandFailed }
        if failKickstart && arguments.first == "kickstart" { throw StartupPolicyError.commandFailed }
        return ""
    }
}

private final class MockURLProtocol: URLProtocol {
    static var requests: [URLRequest] = []
    static var handler: ((URLRequest) -> (Int, Data)) = { _ in (500, Data()) }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        let (status, body) = Self.handler(request)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
