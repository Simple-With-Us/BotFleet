import XCTest
@testable import BotFleetControlCore

final class VMProviderTests: XCTestCase {
    // MARK: - Remembering the configuration

    func testTheConfigurationIsSavedAndReadBack() throws {
        let url = temporaryFile()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = VMProviderStore(fileURL: url)
        let config = VMProviderConfiguration(id: "host-1", providerID: "hetzner-cloud",
                                             displayName: "Hetzner Cloud VM",
                                             remoteVMID: "42", apiToken: "secret")
        try store.upsert(config)
        let loaded = store.loadConfigurations()
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded[0].id, "host-1")
        XCTAssertEqual(loaded[0].remoteVMID, "42")
        XCTAssertEqual(store.configuration(for: "host-1")?.apiToken, "secret")
    }

    func testTheConfigurationFileIsOnlyReadableByItsOwner() throws {
        let url = temporaryFile()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = VMProviderStore(fileURL: url)
        try store.upsert(VMProviderConfiguration(id: "host-1", providerID: "hetzner-cloud",
                                                displayName: "Hetzner Cloud VM",
                                                remoteVMID: "42", apiToken: "secret"))
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let permissions = try XCTUnwrap(attributes[.posixPermissions] as? NSNumber)
        // The file holds an API token, so nobody else may read it.
        XCTAssertEqual(permissions.int16Value, 0o600)
    }

    func testSavingTwiceForOneServerReplacesTheFirst() throws {
        let url = temporaryFile()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = VMProviderStore(fileURL: url)
        try store.upsert(VMProviderConfiguration(id: "host-1", providerID: "hetzner-cloud",
                                                displayName: "Hetzner Cloud VM", remoteVMID: "42"))
        try store.upsert(VMProviderConfiguration(id: "host-1", providerID: "custom-script",
                                                displayName: "Custom Script VM", command: "/tmp/vm.sh"))
        let loaded = store.loadConfigurations()
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded[0].providerID, "custom-script")
    }

    func testAProviderIsForgotten() throws {
        let url = temporaryFile()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = VMProviderStore(fileURL: url)
        try store.upsert(VMProviderConfiguration(id: "host-1", providerID: "hetzner-cloud",
                                                displayName: "Hetzner Cloud VM", remoteVMID: "42"))
        XCTAssertTrue(try store.remove(id: "host-1"))
        XCTAssertFalse(try store.remove(id: "host-1"))
        XCTAssertTrue(store.loadConfigurations().isEmpty)
    }

    func testThereIsNoConfigurationUntilOneIsSaved() {
        let url = temporaryFile()
        defer { try? FileManager.default.removeItem(at: url) }
        XCTAssertTrue(VMProviderStore(fileURL: url).loadConfigurations().isEmpty)
    }

    // MARK: - Building the plugin

    func testEachProviderKindIsBuilt() {
        let hosts = [ServerHost.defaultLocal]
        let server = VMProviderConfiguration(id: "local", providerID: "botfleet-server",
                                             displayName: "BotFleet Server VM")
        XCTAssertTrue(VMProviderFactory.makeProvider(for: server, hosts: hosts) is BotFleetServerVMProvider)

        let hetzner = VMProviderConfiguration(id: "local", providerID: "hetzner-cloud",
                                              displayName: "Hetzner Cloud VM",
                                              remoteVMID: "42", apiToken: "secret")
        XCTAssertTrue(VMProviderFactory.makeProvider(for: hetzner, hosts: hosts) is HetznerCloudVMProvider)

        let script = VMProviderConfiguration(id: "local", providerID: "custom-script",
                                             displayName: "Custom Script VM", command: "/tmp/vm.sh")
        XCTAssertTrue(VMProviderFactory.makeProvider(for: script, hosts: hosts) is CustomScriptVMProvider)
    }

    func testAProviderThatIsNotConfiguredCannotBeBuilt() {
        let hosts = [ServerHost.defaultLocal]
        let noToken = VMProviderConfiguration(id: "local", providerID: "hetzner-cloud",
                                             displayName: "Hetzner Cloud VM", remoteVMID: "42")
        XCTAssertNil(VMProviderFactory.makeProvider(for: noToken, hosts: hosts))

        let noCommand = VMProviderConfiguration(id: "local", providerID: "custom-script",
                                                displayName: "Custom Script VM")
        XCTAssertNil(VMProviderFactory.makeProvider(for: noCommand, hosts: hosts))

        let unknown = VMProviderConfiguration(id: "local", providerID: "something-else",
                                              displayName: "Something Else")
        XCTAssertNil(VMProviderFactory.makeProvider(for: unknown, hosts: hosts))
    }

    // MARK: - Reading the machine

    func testTheScriptProviderReadsTheStateFromItsOutput() async throws {
        let provider = CustomScriptVMProvider(command: "/tmp/vm.sh", commands: ScriptCommands())
        let state = try await provider.remoteVMState()
        XCTAssertEqual(state, .running)
    }

    func testTheScriptProviderCallsTheScriptWithTheAction() async throws {
        let commands = ScriptCommands()
        let provider = CustomScriptVMProvider(command: "/tmp/vm.sh", arguments: ["--profile", "prod"],
                                              commands: commands)
        try await provider.startRemoteVM()
        try await provider.stopRemoteVM()
        try await provider.shutdownRemoteVM()
        XCTAssertEqual(commands.calls, [["/tmp/vm.sh", "--profile", "prod", "start"],
                                        ["/tmp/vm.sh", "--profile", "prod", "stop"],
                                        ["/tmp/vm.sh", "--profile", "prod", "shutdown"]])
    }

    func testTheHetznerProviderReadsTheServerState() async throws {
        let session = makeSession { request in
            let body = try JSONSerialization.data(withJSONObject: ["server": ["id": 42, "status": "running"]])
            return (200, body)
        }
        let provider = HetznerCloudVMProvider(serverID: "42", token: "secret", session: session)
        let state = try await provider.remoteVMState()
        XCTAssertEqual(state, .running)
    }

    func testTheHetznerProviderReportsAnOffMachine() async throws {
        let session = makeSession { request in
            let body = try JSONSerialization.data(withJSONObject: ["server": ["id": 42, "status": "off"]])
            return (200, body)
        }
        let provider = HetznerCloudVMProvider(serverID: "42", token: "secret", session: session)
        let state = try await provider.remoteVMState()
        XCTAssertEqual(state, .off)
    }

    func testTheHetznerProviderSendsItsTokenAndItsAction() async throws {
        let session = makeSession { request in
            (200, try JSONSerialization.data(withJSONObject: ["action": ["command": "poweron"]]))
        }
        let provider = HetznerCloudVMProvider(serverID: "42", token: "secret", session: session)
        try await provider.startRemoteVM()
        let request = StubbedRequests.last
        XCTAssertEqual(request?.httpMethod, "POST")
        XCTAssertEqual(request?.url?.path, "/v1/servers/42/actions/poweron")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
    }

    func testTheHetznerProviderRefusesAnAnswerItCannotRead() async throws {
        let session = makeSession { _ in (500, Data("nope".utf8)) }
        let provider = HetznerCloudVMProvider(serverID: "42", token: "secret", session: session)
        do {
            _ = try await provider.remoteVMState()
            XCTFail("Expected the provider to refuse the answer")
        } catch let error as VMProviderError {
            guard case .refused = error else { return XCTFail("Expected a refusal, got \(error)") }
        }
    }

    func testTheStateLabelsAreReadable() {
        XCTAssertEqual(RemoteVMState.running.label, "Running 🟢")
        XCTAssertEqual(RemoteVMState.off.label, "Off ⚪")
        XCTAssertEqual(RemoteVMState.unknown.label, "Unknown")
    }

    // MARK: - Helpers

    private func temporaryFile() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("vm-providers-\(UUID().uuidString).json")
    }

    private func makeSession(_ handler: @escaping (URLRequest) throws -> (Int, Data)) -> URLSession {
        StubbedRequests.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [VMProviderURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

/// A stand-in for the owner's script.
private final class ScriptCommands: CommandRunning {
    var calls: [[String]] = []

    func run(_ executable: String, _ arguments: [String]) throws -> String {
        try run(executable, arguments, timeout: 15)
    }

    func run(_ executable: String, _ arguments: [String], timeout: TimeInterval) throws -> String {
        try run(executable, arguments, environment: [:], timeout: timeout)
    }

    func run(_ executable: String, _ arguments: [String], environment: [String: String], timeout: TimeInterval) throws -> String {
        calls.append([executable] + arguments)
        if arguments.last == "status" { return "running\n" }
        return ""
    }
}

/// The last request the stubbed provider made.
private enum StubbedRequests {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    static var last: URLRequest?
}

/// A stand-in for the provider's HTTP answers.
private final class VMProviderURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        StubbedRequests.last = request
        guard let handler = StubbedRequests.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        do {
            let (status, body) = try handler(request)
            guard let url = request.url,
                  let response = HTTPURLResponse(url: url, statusCode: status,
                                                 httpVersion: nil, headerFields: nil) else {
                client?.urlProtocol(self, didFailWithError: URLError(.badURL))
                return
            }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}
