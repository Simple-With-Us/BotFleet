#if os(macOS)
import Foundation
import Testing
@testable import CompanionCore

// MARK: - Mock URLProtocol for Control Status Tests

private final class MacControlStatusStubURLProtocol: URLProtocol {
    struct RecordedRequest: Sendable {
        let method: String
        let path: String
        let body: Data?
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var _handler: ((URLRequest, Data?) -> (Int, Data, Error?))?
    nonisolated(unsafe) private static var _recorded: [RecordedRequest] = []

    static func configure(_ handler: @escaping (URLRequest, Data?) -> (Int, Data, Error?)) {
        lock.lock()
        defer { lock.unlock() }
        _recorded.removeAll()
        _handler = handler
    }

    static func recordedRequests() -> [RecordedRequest] {
        lock.lock()
        defer { lock.unlock() }
        return _recorded
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let bodyData = Self.extractBody(from: request)
        Self.lock.lock()
        Self._recorded.append(
            RecordedRequest(
                method: request.httpMethod ?? "GET",
                path: request.url?.path ?? "",
                body: bodyData
            )
        )
        let currentHandler = Self._handler
        Self.lock.unlock()

        guard let handler = currentHandler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }

        let (statusCode, responseData, error) = handler(request, bodyData)
        if let error {
            client?.urlProtocol(self, didFailWithError: error)
            return
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: responseData)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func extractBody(from request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let readCount = stream.read(&buffer, maxLength: buffer.count)
            if readCount <= 0 { break }
            data.append(buffer, count: readCount)
        }
        return data
    }
}

// MARK: - Test Suite

@Suite("BotFleetMac Control Status & Startup Policy", .serialized)
struct MacControlStatusTests {

    private func makeTemporaryDirectory() throws -> URL {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("botfleet-mac-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        return tempDir
    }

    private func makeStubbedSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MacControlStatusStubURLProtocol.self]
        return URLSession(configuration: config)
    }

    private func makeClient() -> MacControlStatusClient {
        MacControlStatusClient(
            baseURL: URL(string: "http://127.0.0.1:8799")!,
            session: makeStubbedSession()
        )
    }

    // MARK: - The Status Read

    @Test("The status read decodes the full shape the harness answers with")
    func testStatusDecodes() async throws {
        let body = """
        {
          "serverBuild": {"version": "0.1.0", "build": "202611240430", "sourceCommit": "abc123"},
          "activeBotCount": 2,
          "localVms": [{"key": "shared", "name": "Shared VM", "running": true, "state": "running"}],
          "persistOnExit": true,
          "blockingWork": [{"count": 1, "label": "bot turn"}, {"count": 2, "label": "credential continuation"}]
        }
        """
        MacControlStatusStubURLProtocol.configure { request, _ in
            (200, Data(body.utf8), nil)
        }
        let status = try await makeClient().fetchStatus()
        #expect(status.activeBotCount == 2)
        #expect(status.persistOnExit == true)
        #expect(status.runningVMCount == 1)
        #expect(status.isSharedVMRunning)
        #expect(status.canStopSharedVM)
        #expect(!status.canStartSharedVM)
        #expect(status.serverBuild?.build == "202611240430")
        #expect(status.blockingWorkSummary == "1 bot turn, 2 credential continuations")
    }

    @Test("An older harness's partial answer decodes with the rest unknown")
    func testStatusDecodesPartialAnswer() async throws {
        MacControlStatusStubURLProtocol.configure { _, _ in
            (200, Data(#"{"activeBotCount": 0}"#.utf8), nil)
        }
        let status = try await makeClient().fetchStatus()
        #expect(status.activeBotCount == 0)
        #expect(status.localVms == nil)
        #expect(status.serverBuild == nil)
        #expect(status.blockingWorkSummary == nil)
        #expect(!status.isSharedVMRunning)
        #expect(!status.canStartSharedVM)
    }

    @Test("A harness without the route reports as older, not broken")
    func testMissingRouteReportsOutdatedServer() async {
        MacControlStatusStubURLProtocol.configure { _, _ in
            (404, Data(#"{"error": "not found"}"#.utf8), nil)
        }
        do {
            _ = try await makeClient().fetchStatus()
            Issue.record("The read should have thrown.")
        } catch let error as MacControlStatusError {
            #expect(error == .outdatedServer)
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }

    @Test("A foreign service is named, not mistaken for the local harness")
    func testForeignServiceIsNamed() async {
        MacControlStatusStubURLProtocol.configure { _, _ in
            (403, Data(#"{"error": "server controls require this Mac"}"#.utf8), nil)
        }
        do {
            _ = try await makeClient().fetchStatus()
            Issue.record("The read should have thrown.")
        } catch let error as MacControlStatusError {
            #expect(error == .foreignService)
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }

    // MARK: - The Local VM Controls

    @Test("Starting a shared VM reports what came up, and a refusal keeps the harness's own words")
    func testStartSharedVM() async {
        MacControlStatusStubURLProtocol.configure { request, body in
            #expect(request.httpMethod == "POST")
            #expect(request.url?.path == "/api/system/control/vms/start")
            #expect(body == Data("{}".utf8))
            if request.url?.path.hasSuffix("/vms/start") == true {
                return (200, Data(#"{"ok": true, "vm": {"key": "shared", "name": "Shared VM", "running": true, "state": "running"}}"#.utf8), nil)
            }
            return (404, Data(), nil)
        }
        let note = try? await makeClient().startSharedVM()
        #expect(note == "Started Shared VM.")

        MacControlStatusStubURLProtocol.configure { _, _ in
            (409, Data(#"{"error": "Enable shared Local VM in Computer settings first"}"#.utf8), nil)
        }
        do {
            _ = try await makeClient().startSharedVM()
            Issue.record("The start should have been refused.")
        } catch let error as MacControlStatusError {
            #expect(error == .httpError(statusCode: 409, message: "Enable shared Local VM in Computer settings first"))
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }

    @Test("Stopping the local VMs passes the harness's note through when it gives one")
    func testStopLocalVMs() async {
        MacControlStatusStubURLProtocol.configure { request, _ in
            #expect(request.httpMethod == "POST")
            #expect(request.url?.path == "/api/system/control/vms/stop")
            return (200, Data(#"{"ok": true, "detail": {"stopped": true, "note": "two VMs stopped"}}"#.utf8), nil)
        }
        let note = try? await makeClient().stopLocalVMs()
        #expect(note == "two VMs stopped")

        MacControlStatusStubURLProtocol.configure { _, _ in
            (200, Data(#"{"ok": true, "detail": {"stopped": true}}"#.utf8), nil)
        }
        let plain = try? await makeClient().stopLocalVMs()
        #expect(plain == "Stopped the local VMs.")
    }

    // MARK: - The Startup Policy Markers

    @Test("An untouched data directory reads as the install default")
    func testLegacyPolicyIsTheDefault() throws {
        let tempDir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let store = MacStartupPolicyStore(dataDir: tempDir)
        #expect(store.loginPolicy() == .legacy)
        #expect(store.loginPolicy().startsAtLogin)
        #expect(!store.loginPolicy().isExplicit)
    }

    @Test("Setting the policy writes the session and the one marker, and removes the other")
    func testSetStartsAtLoginWritesExactlyOneMarker() throws {
        let tempDir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let store = MacStartupPolicyStore(dataDir: tempDir)

        try store.setStartsAtLogin(true, bootSession: "B4D5E6F7-1111-2222-3333-444455556666", dataDir: tempDir)
        #expect(store.loginPolicy() == .enabled)
        #expect(FileManager.default.fileExists(atPath: store.enabledMarker(dataDir: tempDir).path))
        #expect(!FileManager.default.fileExists(atPath: store.disabledMarker(dataDir: tempDir).path))
        let session = try String(contentsOf: store.sessionFile(dataDir: tempDir), encoding: .utf8)
        #expect(session == "B4D5E6F7-1111-2222-3333-444455556666\n")

        try store.setStartsAtLogin(false, bootSession: "B4D5E6F7-1111-2222-3333-444455556666", dataDir: tempDir)
        #expect(store.loginPolicy() == .disabled)
        #expect(!store.loginPolicy().startsAtLogin)
        #expect(store.loginPolicy().isExplicit)
        #expect(!FileManager.default.fileExists(atPath: store.enabledMarker(dataDir: tempDir).path))
        #expect(FileManager.default.fileExists(atPath: store.disabledMarker(dataDir: tempDir).path))

        try store.clearPolicy(dataDir: tempDir)
        #expect(store.loginPolicy() == .legacy)
    }

    @Test("An empty boot session is refused rather than recorded as nothing")
    func testEmptyBootSessionIsRefused() throws {
        let tempDir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let store = MacStartupPolicyStore(dataDir: tempDir)
        #expect(throws: MacStartupPolicyError.bootSessionUnavailable) {
            try store.setStartsAtLogin(true, bootSession: "", dataDir: tempDir)
        }
        #expect(store.loginPolicy() == .legacy)
    }

    @Test("A disabled marker wins when both exist, like the wrapper reads it")
    func testDisabledMarkerWins() throws {
        let tempDir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let store = MacStartupPolicyStore(dataDir: tempDir)
        try store.setStartsAtLogin(true, bootSession: "B4D5E6F7-1111-2222-3333-444455556666", dataDir: tempDir)
        // Simulate the state the wrapper could read if a writer raced:  both
        // markers present.  The wrapper checks disabled first, so the store
        // must read the same thing the wrapper acts on.
        try Data().write(to: store.disabledMarker(dataDir: tempDir))
        #expect(store.loginPolicy() == .disabled)
    }

    @Test("A wrapper without the policy string does not claim to support it")
    func testSupportsPolicyReadsTheWrapper() throws {
        let tempDir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let supporting = tempDir.appendingPathComponent("wrapper-supports.sh")
        try Data("BF_CONTROL_STARTUP_POLICY_V1 honoured here\n".utf8).write(to: supporting)
        let older = tempDir.appendingPathComponent("wrapper-older.sh")
        try Data("#!/bin/sh\nstart the server\n".utf8).write(to: older)
        #expect(MacStartupPolicyStore(wrapper: supporting).supportsPolicy())
        #expect(!MacStartupPolicyStore(wrapper: older).supportsPolicy())
        #expect(!MacStartupPolicyStore(wrapper: tempDir.appendingPathComponent("missing.sh")).supportsPolicy())
    }
}
#endif
