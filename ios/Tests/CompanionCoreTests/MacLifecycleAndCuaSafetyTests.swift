#if os(macOS)
import CoreGraphics
import Foundation
import Testing
@testable import CompanionCore

// MARK: - Mock URLProtocol for Lifecycle Client Tests

private final class MacLifecycleStubURLProtocol: URLProtocol {
    struct RecordedRequest: Sendable {
        let method: String
        let path: String
        let headers: [String: String]
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
        let recordedItem = RecordedRequest(
            method: request.httpMethod ?? "GET",
            path: request.url?.path ?? "",
            headers: request.allHTTPHeaderFields ?? [:],
            body: bodyData
        )

        Self.lock.lock()
        Self._recorded.append(recordedItem)
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

@Suite("BotFleetMac Lifecycle Controls & CUA Safety", .serialized)
struct MacLifecycleAndCuaSafetyTests {

    private func makeTemporaryDirectory() throws -> URL {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("botfleet-mac-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        return tempDir
    }

    private func makeStubbedSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MacLifecycleStubURLProtocol.self]
        return URLSession(configuration: config)
    }

    // MARK: - BF-2497: Persistence Policy & Stopped Marker Tests

    @Test("MacPersistencePolicyStore atomically writes 0600 policy file and manages stopped.marker")
    func testPersistencePolicyStoreAndStoppedMarker() throws {
        let tempDir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let store = MacPersistencePolicyStore(dataDir: tempDir)

        // Initially neither policy nor stopped.marker exists.
        #expect(store.readPersistOnExit() == nil)
        #expect(!store.hasStoppedMarker(dataDir: tempDir))
        #expect(try store.clearStoppedMarkerOnDeliberateLaunch(dataDir: tempDir) == false)

        // Write `true` and verify contents + 0600 permissions.
        try store.writePersistOnExit(true, dataDir: tempDir)
        #expect(store.readPersistOnExit(dataDir: tempDir) == true)

        let policyURL = tempDir.appendingPathComponent(MacPersistencePolicyStore.policyFileName)
        let attrs = try FileManager.default.attributesOfItem(atPath: policyURL.path)
        let posixPerms = (attrs[.posixPermissions] as? NSNumber)?.uint16Value ?? 0
        #expect(posixPerms == 0o600)

        // Flip to `false` and verify atomic overwrite.
        try store.writePersistOnExit(false, dataDir: tempDir)
        #expect(store.readPersistOnExit(dataDir: tempDir) == false)

        // Write `stopped.marker` and verify existence + 0600 permissions.
        try store.writeStoppedMarker(dataDir: tempDir)
        #expect(store.hasStoppedMarker(dataDir: tempDir))

        let markerURL = tempDir.appendingPathComponent(MacPersistencePolicyStore.stoppedMarkerFileName)
        let markerAttrs = try FileManager.default.attributesOfItem(atPath: markerURL.path)
        let markerPerms = (markerAttrs[.posixPermissions] as? NSNumber)?.uint16Value ?? 0
        #expect(markerPerms == 0o600)

        // Deliberate launch clears `stopped.marker` and returns true.
        let cleared = try store.clearStoppedMarkerOnDeliberateLaunch(dataDir: tempDir)
        #expect(cleared == true)
        #expect(!store.hasStoppedMarker(dataDir: tempDir))
    }

    @Test("MacLifecycleClient round-trips allowRemoteDesktopLaunch and persistOnExit and falls back when offline")
    func testLifecycleClientConfigRoundTripAndOfflineFallback() async throws {
        let tempDir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let store = MacPersistencePolicyStore(dataDir: tempDir)
        let session = makeStubbedSession()
        let client = MacLifecycleClient(
            baseURL: URL(string: "http://127.0.0.1:8799")!,
            session: session,
            policyStore: store
        )

        // Step 1: Default values on a fresh MacLifecycleSettings struct.
        // The remote-launch grant is unknown until the harness reports it, so a
        // value the app never read is never written back as `false`.
        let defaults = MacLifecycleSettings()
        #expect(defaults.allowRemoteDesktopLaunch == nil)
        #expect(defaults.persistOnExit == true)

        // Step 2: Save settings via PUT /api/config.
        MacLifecycleStubURLProtocol.configure { _, _ in
            (200, Data(#"{"ok":true,"server":{"allowRemoteDesktopLaunch":true,"persistOnExit":false}}"#.utf8), nil)
        }

        let updated = MacLifecycleSettings(allowRemoteDesktopLaunch: true, persistOnExit: false)
        try await client.saveLifecycleSettings(updated)

        let putRequests = MacLifecycleStubURLProtocol.recordedRequests()
        #expect(putRequests.count == 1)
        #expect(putRequests[0].method == "PUT")
        #expect(putRequests[0].path == "/api/config")
        #expect(store.readPersistOnExit() == false)

        if let body = putRequests[0].body,
           let parsed = try JSONSerialization.jsonObject(with: body) as? [String: Any],
           let serverObj = parsed["server"] as? [String: Any] {
            #expect(serverObj["allowRemoteDesktopLaunch"] as? Bool == true)
            #expect(serverObj["persistOnExit"] as? Bool == false)
        } else {
            Issue.record("Expected PUT /api/config JSON body with server section")
        }

        // Step 3: Fetch settings via GET /api/config.
        MacLifecycleStubURLProtocol.configure { _, _ in
            (200, Data(#"{"server":{"allowRemoteDesktopLaunch":true,"persistOnExit":false}}"#.utf8), nil)
        }
        let fetched = try await client.fetchLifecycleSettings()
        #expect(fetched == updated)

        // Step 4: Offline fallback reads `~/.botfleet/persist-on-exit.policy`.
        // The remote-launch grant stays unknown offline.
        MacLifecycleStubURLProtocol.configure { _, _ in
            (0, Data(), URLError(.cannotConnectToHost))
        }
        let offlineSettings = try await client.fetchLifecycleSettings()
        #expect(offlineSettings.allowRemoteDesktopLaunch == nil)
        #expect(offlineSettings.persistOnExit == false)
    }

    @Test("A GET /api/config without a server section leaves the remote-launch grant unknown")
    func testMissingServerSectionKeepsRemoteLaunchGrantUnknown() async throws {
        let tempDir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let store = MacPersistencePolicyStore(dataDir: tempDir)
        try store.writePersistOnExit(true, dataDir: tempDir)

        let session = makeStubbedSession()
        let client = MacLifecycleClient(
            baseURL: URL(string: "http://127.0.0.1:8799")!,
            session: session,
            policyStore: store
        )

        // `GET /api/config` returns `configStatus()`, which has no `server`
        // section at all.
        MacLifecycleStubURLProtocol.configure { _, _ in
            (200, Data(#"{"ok":true,"drain":{},"jobs":{}}"#.utf8), nil)
        }
        let fetched = try await client.fetchLifecycleSettings()
        #expect(fetched.allowRemoteDesktopLaunch == nil)
        #expect(fetched.persistOnExit == true)

        // The unknown grant must never be written back as `false`.
        MacLifecycleStubURLProtocol.configure { _, _ in
            (200, Data(#"{"ok":true}"#.utf8), nil)
        }
        try await client.saveLifecycleSettings(
            MacLifecycleSettings(allowRemoteDesktopLaunch: fetched.allowRemoteDesktopLaunch, persistOnExit: false)
        )

        let requests = MacLifecycleStubURLProtocol.recordedRequests()
        #expect(requests.count == 1)
        if let body = requests[0].body,
           let parsed = try JSONSerialization.jsonObject(with: body) as? [String: Any],
           let serverObj = parsed["server"] as? [String: Any] {
            #expect(serverObj["persistOnExit"] as? Bool == false)
            #expect(serverObj["allowRemoteDesktopLaunch"] == nil)
        } else {
            Issue.record("Expected PUT /api/config JSON body with server section")
        }
    }

    @Test("A rejected lifecycle save restores the previous settings and reports the error")
    func testRejectedLifecycleSaveRestoresPreviousSettings() async throws {
        let tempDir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let store = MacPersistencePolicyStore(dataDir: tempDir)
        let session = makeStubbedSession()
        let client = MacLifecycleClient(
            baseURL: URL(string: "http://127.0.0.1:8799")!,
            session: session,
            policyStore: store
        )

        let previous = MacLifecycleSettings(allowRemoteDesktopLaunch: true, persistOnExit: true)
        let attempted = MacLifecycleSettings(allowRemoteDesktopLaunch: false, persistOnExit: false)

        MacLifecycleStubURLProtocol.configure { _, _ in
            (500, Data(#"{"error":"config write failed"}"#.utf8), nil)
        }

        let result = await client.saveLifecycleSettings(attempted, restoring: previous)
        switch result {
        case .saved:
            Issue.record("Expected a rejected save, got a successful one")
        case .failed(let restored, let message):
            // The Settings toggles go back to the last value the harness
            // accepted instead of keeping the value it never took.
            #expect(restored == previous)
            #expect(message.contains("config write failed"))
        }

        // The local policy file is the offline source of truth, so it still
        // mirrors the operator's choice.
        #expect(store.readPersistOnExit() == false)
    }

    @Test("MacLifecycleClient shutDownServerAndLocalVM asks the fenced stop route first and ensures stopped.marker")
    func testShutdownEndpointAndMarker() async throws {
        // BotFleet Control stops the harness through POST /api/system/control/stop,
        // which refuses while work is in flight.  The native app's stop has to
        // be the same stop, or the same owner has one button that protects
        // active bots and one that kills them mid-turn (BF-2584).
        let tempDir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let store = MacPersistencePolicyStore(dataDir: tempDir)
        let session = makeStubbedSession()
        let client = MacLifecycleClient(
            baseURL: URL(string: "http://127.0.0.1:8799")!,
            session: session,
            policyStore: store
        )

        MacLifecycleStubURLProtocol.configure { _, _ in
            let payload = #"{"ok":true,"detail":{"markerWritten":true,"localVmStop":"stopped"}}"#
            return (200, Data(payload.utf8), nil)
        }

        let receipt = try await client.shutDownServerAndLocalVM()
        #expect(receipt.ok == true)
        #expect(receipt.markerWritten == true)
        #expect(receipt.localVmStop == "stopped")
        #expect(store.hasStoppedMarker(dataDir: tempDir) == true)

        let requests = MacLifecycleStubURLProtocol.recordedRequests()
        #expect(requests.count == 1)
        #expect(requests[0].method == "POST")
        #expect(requests[0].path == "/api/system/control/stop")
        #expect(requests[0].headers["Origin"] == "http://127.0.0.1:8799")
        #expect(requests[0].headers["Content-Type"] == "application/json")
    }

    @Test("A busy server's refusal is reported with the work in flight, and no marker is written")
    func testBusyServerRefusesTheShutdownAndNamesTheWork() async throws {
        let tempDir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let store = MacPersistencePolicyStore(dataDir: tempDir)
        let client = MacLifecycleClient(
            baseURL: URL(string: "http://127.0.0.1:8799")!,
            session: makeStubbedSession(),
            policyStore: store
        )

        MacLifecycleStubURLProtocol.configure { request, _ in
            switch (request.httpMethod ?? "GET", request.url?.path ?? "") {
            case ("POST", "/api/system/control/stop"):
                return (409, Data(#"{"error":"BotFleet is busy with active bots or leases."}"#.utf8), nil)
            case ("GET", "/api/system/control"):
                let payload = #"{"activeBotCount":2,"persistOnExit":true,"localVms":[],"blockingWork":[{"count":2,"label":"bot turn"},{"count":1,"label":"VM lease"},{"count":0,"label":"setup change"}]}"#
                return (200, Data(payload.utf8), nil)
            default:
                return (500, Data(#"{"error":"unexpected request"}"#.utf8), nil)
            }
        }

        let outcome = await client.performDeliberateShutdown()
        switch outcome {
        case .stopped:
            Issue.record("Expected a refusal, got a receipt")
        case .failed(let message):
            #expect(message.contains("refused to stop while work is in flight"))
            #expect(message.contains("2 bot turns, 1 VM lease"))
            #expect(message.contains("busy with active bots or leases"))
        }

        // The harness is still running, so the marker must not say it was
        // deliberately stopped, and the unfenced route must not be tried:
        // a refusal is an answer, not a missing route.
        #expect(store.hasStoppedMarker(dataDir: tempDir) == false)
        let requests = MacLifecycleStubURLProtocol.recordedRequests()
        #expect(requests.map(\.path) == ["/api/system/control/stop", "/api/system/control"])
        // The status read decorates a refusal that is already known: it
        // carries the Origin the harness sees on every other call from this
        // app, and it cannot hold the owner's answer for long.
        #expect(requests.last?.headers["Origin"] == "http://127.0.0.1:8799")
        #expect(MacLifecycleClient.blockingWorkTimeout <= 2)
    }

    @Test("A 404 that is not the harness's no-route answer is an error, never a fallback")
    func testAnUnexplained404DoesNotFallBackToTheUnfencedStop() async throws {
        let tempDir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let store = MacPersistencePolicyStore(dataDir: tempDir)
        let client = MacLifecycleClient(
            baseURL: URL(string: "http://127.0.0.1:8799")!,
            session: makeStubbedSession(),
            policyStore: store
        )

        MacLifecycleStubURLProtocol.configure { request, _ in
            switch request.url?.path ?? "" {
            case "/api/system/control/stop":
                return (404, Data(#"{"error":"no such bot"}"#.utf8), nil)
            default:
                return (200, Data(#"{"ok":true,"detail":{"markerWritten":true,"localVmStop":"not-running"}}"#.utf8), nil)
            }
        }

        do {
            _ = try await client.shutDownServerAndLocalVM()
            Issue.record("Expected the 404 to be reported")
        } catch let error as MacLifecycleError {
            #expect(error == .httpError(statusCode: 404, message: "no such bot"))
        }
        // The unfenced route was never tried: it has no fence, and a 404 from
        // a route that exists is not an older harness.
        #expect(store.hasStoppedMarker(dataDir: tempDir) == false)
        let paths = MacLifecycleStubURLProtocol.recordedRequests().map(\.path)
        #expect(paths == ["/api/system/control/stop"])
    }

    @Test("An older harness without the fenced route falls back to POST /api/system/shutdown")
    func testOlderHarnessFallsBackToTheUnfencedShutdown() async throws {
        let tempDir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let store = MacPersistencePolicyStore(dataDir: tempDir)
        let client = MacLifecycleClient(
            baseURL: URL(string: "http://127.0.0.1:8799")!,
            session: makeStubbedSession(),
            policyStore: store
        )

        MacLifecycleStubURLProtocol.configure { request, _ in
            switch request.url?.path ?? "" {
            case "/api/system/control/stop":
                return (404, Data(#"{"error":"no route: POST /api/system/control/stop"}"#.utf8), nil)
            case "/api/system/shutdown":
                return (200, Data(#"{"ok":true,"detail":{"markerWritten":true,"localVmStop":"not-running"}}"#.utf8), nil)
            default:
                return (500, Data(#"{"error":"unexpected request"}"#.utf8), nil)
            }
        }

        let receipt = try await client.shutDownServerAndLocalVM()
        #expect(receipt.ok == true)
        #expect(store.hasStoppedMarker(dataDir: tempDir) == true)
        let paths = MacLifecycleStubURLProtocol.recordedRequests().map(\.path)
        #expect(paths == ["/api/system/control/stop", "/api/system/shutdown"])
    }

    @Test("A busy refusal still reads as a refusal when the status route cannot be read")
    func testBusyRefusalWithoutAStatusKeepsTheServersWords() async throws {
        let tempDir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let store = MacPersistencePolicyStore(dataDir: tempDir)
        let client = MacLifecycleClient(
            baseURL: URL(string: "http://127.0.0.1:8799")!,
            session: makeStubbedSession(),
            policyStore: store
        )

        MacLifecycleStubURLProtocol.configure { request, _ in
            if request.url?.path == "/api/system/control/stop" {
                return (409, Data(#"{"error":"Active bot turn"}"#.utf8), nil)
            }
            return (500, Data(#"{"error":"status unavailable"}"#.utf8), nil)
        }

        do {
            _ = try await client.shutDownServerAndLocalVM()
            Issue.record("Expected a refusal")
        } catch let error as MacLifecycleError {
            #expect(error == .busy(message: "Active bot turn", blockingWork: nil))
            // The server's words end with a period the server did not send,
            // and no breakdown is invented when the status could not be read.
            #expect(error.errorDescription == "BotFleet Server refused to stop while work is in flight.\u{00A0} Active bot turn.\u{00A0} Try again when it finishes.")
        }
        #expect(store.hasStoppedMarker(dataDir: tempDir) == false)
        let paths = MacLifecycleStubURLProtocol.recordedRequests().map(\.path)
        #expect(paths == ["/api/system/control/stop", "/api/system/control"])
    }

    @Test("A refusal that already names the work is not told twice")
    func testBusyRefusalDoesNotRepeatTheServersBreakdown() async throws {
        // On the server's count path the 409 text already carries the
        // breakdown, byte for byte the same as the status route's, so the
        // parenthetical is left out rather than said twice.
        let tempDir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let client = MacLifecycleClient(
            baseURL: URL(string: "http://127.0.0.1:8799")!,
            session: makeStubbedSession(),
            policyStore: MacPersistencePolicyStore(dataDir: tempDir)
        )

        MacLifecycleStubURLProtocol.configure { request, _ in
            switch (request.httpMethod ?? "GET", request.url?.path ?? "") {
            case ("POST", "/api/system/control/stop"):
                return (409, Data(#"{"error":"2 active operation(s) must finish before the server can stop: 2 bot turns, 1 VM lease"}"#.utf8), nil)
            case ("GET", "/api/system/control"):
                return (200, Data(#"{"activeBotCount":2,"persistOnExit":true,"localVms":[],"blockingWork":[{"count":2,"label":"bot turn"},{"count":1,"label":"VM lease"}]}"#.utf8), nil)
            default:
                return (500, Data(#"{"error":"unexpected request"}"#.utf8), nil)
            }
        }

        do {
            _ = try await client.shutDownServerAndLocalVM()
            Issue.record("Expected a refusal")
        } catch let error as MacLifecycleError {
            let text = error.errorDescription ?? ""
            // The server's own words carry "(s)", so the check is that the
            // breakdown was not added in parentheses, not that there are none.
            #expect(text.contains("(2 bot turns, 1 VM lease)") == false)
            #expect(text.components(separatedBy: "2 bot turns, 1 VM lease").count == 2)
            #expect(text.hasSuffix("the server can stop: 2 bot turns, 1 VM lease.\u{00A0} Try again when it finishes."))
        }
    }

    @Test("A harness with neither stop route is reported as needing an update")
    func testNeitherStopRouteIsAnUpdateMessage() async throws {
        let tempDir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let store = MacPersistencePolicyStore(dataDir: tempDir)
        let client = MacLifecycleClient(
            baseURL: URL(string: "http://127.0.0.1:8799")!,
            session: makeStubbedSession(),
            policyStore: store
        )

        MacLifecycleStubURLProtocol.configure { request, _ in
            (404, Data(#"{"error":"no route: POST \#(request.url?.path ?? "")"}"#.utf8), nil)
        }

        do {
            _ = try await client.shutDownServerAndLocalVM()
            Issue.record("Expected a 404 outcome")
        } catch let error as MacLifecycleError {
            #expect(error == .httpError(statusCode: 404, message: "BotFleet Server has no shutdown route.\u{00A0} Update BotFleet, then try again."))
        }
        #expect(store.hasStoppedMarker(dataDir: tempDir) == false)
        let paths = MacLifecycleStubURLProtocol.recordedRequests().map(\.path)
        #expect(paths == ["/api/system/control/stop", "/api/system/shutdown"])
    }

    @Test("A failed shutdown leaves no deliberate-stop marker behind")
    func testFailedShutdownDoesNotWriteStoppedMarker() async throws {
        let tempDir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let store = MacPersistencePolicyStore(dataDir: tempDir)
        let session = makeStubbedSession()
        let client = MacLifecycleClient(
            baseURL: URL(string: "http://127.0.0.1:8799")!,
            session: session,
            policyStore: store
        )

        MacLifecycleStubURLProtocol.configure { _, _ in
            (500, Data(#"{"error":"shutdown failed"}"#.utf8), nil)
        }

        let outcome = await client.performDeliberateShutdown()
        switch outcome {
        case .stopped:
            Issue.record("Expected a failed shutdown, got a receipt")
        case .failed(let message):
            #expect(message.contains("shutdown failed"))
        }

        // The harness is still running, so the marker must not claim it was
        // deliberately stopped: launchd would then never revive it.
        #expect(store.hasStoppedMarker(dataDir: tempDir) == false)
        // A 500 is the server's own failure, not a missing route, so the
        // unfenced shutdown is never tried on the back of it.
        let paths = MacLifecycleStubURLProtocol.recordedRequests().map(\.path)
        #expect(paths == ["/api/system/control/stop"])
    }

    @Test("A reconnect never clears the deliberate-stop marker, a deliberate launch does")
    func testReconnectKeepsStoppedMarkerButLaunchClearsIt() throws {
        let tempDir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let store = MacPersistencePolicyStore(dataDir: tempDir)
        try store.writeStoppedMarker(dataDir: tempDir)
        #expect(store.hasStoppedMarker(dataDir: tempDir))

        // A reconnect is not a deliberate launch, so the sentinel survives.
        #expect(try store.clearStoppedMarker(for: .reconnect, dataDir: tempDir) == false)
        #expect(store.hasStoppedMarker(dataDir: tempDir) == true)

        // A deliberate launch clears it, so the launchd wrapper may start the
        // harness again.
        #expect(try store.clearStoppedMarker(for: .appLaunch, dataDir: tempDir) == true)
        #expect(store.hasStoppedMarker(dataDir: tempDir) == false)
    }

    @Test("MacQuitPolicyDecision honors persistOnExit == true vs false")
    func testQuitPolicyDecision() {
        #expect(MacLifecycleClient.evaluateQuitAction(persistOnExit: true) == .keepServerRunning)
        #expect(MacLifecycleClient.evaluateQuitAction(persistOnExit: false) == .shutDownServerAndVM)
    }

    @Test("Closing the desktop window applies the same policy as quitting")
    func testWindowCloseActionMatchesQuitPolicy() {
        // The Settings toggle reads "Keep Server Running When Window Closes",
        // so a window close must not leave the harness running when the
        // operator turned that setting off.
        #expect(MacQuitPolicyDecision.windowCloseAction(persistOnExit: false) == .shutDownServerAndVM)
        #expect(MacQuitPolicyDecision.windowCloseAction(persistOnExit: true) == .keepServerRunning)
        #expect(
            MacQuitPolicyDecision.windowCloseAction(persistOnExit: false)
                == MacLifecycleClient.evaluateQuitAction(persistOnExit: false)
        )
        #expect(
            MacQuitPolicyDecision.windowCloseAction(persistOnExit: true)
                == MacLifecycleClient.evaluateQuitAction(persistOnExit: true)
        )
    }

    @Test("One connection cycle refreshes the lifecycle settings exactly once")
    @MainActor
    func testConnectionCycleRefreshesLifecycleSettingsOnce() async throws {
        let fleet = Fleet(bots: [], groups: [])
        let fleetFetches = ThreadSafeBox(0)
        let lifecycleRefreshes = ThreadSafeBox(0)
        let hydrations = ThreadSafeBox(0)

        for _ in 0..<3 {
            try await MacHarnessConnectionCycle.connect(
                fetchFleet: {
                    fleetFetches.value += 1
                    return fleet
                },
                hydrate: { _ in
                    hydrations.value += 1
                },
                refreshLifecycleSettings: {
                    lifecycleRefreshes.value += 1
                }
            )
        }

        // The lifecycle settings ride on the roster cadence: one
        // `GET /api/config` per successful connection, never two.
        #expect(fleetFetches.value == 3)
        #expect(hydrations.value == 3)
        #expect(lifecycleRefreshes.value == 3)
    }

    // MARK: - BF-2499: CUA Emergency Safety Stop Tests

    private final class ThreadSafeBox<T>: @unchecked Sendable {
        private let lock = NSLock()
        private var _value: T
        init(_ value: T) { self._value = value }
        var value: T {
            get { lock.lock(); defer { lock.unlock() }; return _value }
            set { lock.lock(); defer { lock.unlock() }; _value = newValue }
        }
    }

    /// An append-only event log that several threads can write to safely.
    private final class ThreadSafeEventLog: @unchecked Sendable {
        private let lock = NSLock()
        private var _entries: [String] = []

        func append(_ entry: String) {
            lock.lock()
            defer { lock.unlock() }
            _entries.append(entry)
        }

        var entries: [String] {
            lock.lock()
            defer { lock.unlock() }
            return _entries
        }
    }

    @Test("MacCuaDriver emergencyStop aborts mid-drag within < 100 ms and releases all held mouse buttons")
    func testEmergencyStopMidDragAndButtonRelease() throws {
        let driver = RecordingCuaEventSink().makeDriver()
        driver.resetEmergencyStop()

        // Hold all three mouse buttons to verify emergencyStop releases every held button.
        _ = driver.mouseDown(at: CGPoint(x: 100, y: 100), button: .right)
        _ = driver.mouseDown(at: CGPoint(x: 100, y: 100), button: .center)

        let stepReached = DispatchSemaphore(value: 0)
        let dragFinished = DispatchSemaphore(value: 0)
        let dragResultBox = ThreadSafeBox(true)
        let completedStepsBox = ThreadSafeBox(0)

        DispatchQueue.global(qos: .userInteractive).async {
            dragResultBox.value = driver.drag(
                from: CGPoint(x: 100, y: 100),
                to: CGPoint(x: 500, y: 500),
                button: .left,
                steps: 50,
                stepDelayMs: 10,
                onStep: { step, _ in
                    completedStepsBox.value = step
                    if step == 2 {
                        stepReached.signal()
                    }
                }
            )
            dragFinished.signal()
        }

        let waitStep = stepReached.wait(timeout: .now() + 2.0)
        #expect(waitStep == .success)
        #expect(driver.heldMouseButtons.contains(.left))
        #expect(driver.heldMouseButtons.contains(.right))
        #expect(driver.heldMouseButtons.contains(.center))

        let stopStartNs = DispatchTime.now().uptimeNanoseconds
        let released = driver.emergencyStop()
        let waitDragAbort = dragFinished.wait(timeout: .now() + 0.1)
        let totalAbortMs = Double(DispatchTime.now().uptimeNanoseconds - stopStartNs) / 1_000_000.0

        #expect(waitDragAbort == .success)
        #expect(dragResultBox.value == false)
        #expect(completedStepsBox.value < 50)
        #expect(driver.isEmergencyStopped == true)
        #expect(driver.heldMouseButtons.isEmpty)
        #expect(Set(released) == Set([.left, .right, .center]))
        #expect(driver.lastEmergencyStopLatencyMs < 100.0)
        #expect(totalAbortMs < 100.0)

        // While emergency stop is latched, subsequent CUA actions are blocked.
        #expect(driver.click(at: CGPoint(x: 120, y: 120)) == false)
        #expect(driver.typeText("blocked") == false)

        // Re-arming allows subsequent actions again.
        driver.resetEmergencyStop()
        #expect(driver.isEmergencyStopped == false)
    }

    // MARK: - BF-2499: Retina & Multi-Display Coordinate Scaling Tests

    @Test("Retina 2.0x and secondary display negative-origin coordinate mapping")
    func testRetinaAndMultiDisplayCoordinateMapping() {
        let primaryRetina = DisplayGeometry(
            displayID: 1,
            framePoints: CGRect(x: 0, y: 0, width: 1512, height: 982),
            pixelWidth: 3024,
            pixelHeight: 1964,
            scaleFactor: 2.0,
            isMain: true
        )

        // Center of 3024x1964 backing pixels on a 2.0x Retina display maps to (756, 491) in points.
        let retinaCenter = mapNormalizedOrPixelPointToGlobalPoints(
            x: 1512,
            y: 982,
            in: primaryRetina,
            inputSpace: .backingPixels
        )
        #expect(abs(retinaCenter.x - 756.0) < 0.001)
        #expect(abs(retinaCenter.y - 491.0) < 0.001)

        // Secondary 1.0x display positioned to the left and above the primary display (negative origin).
        let secondaryDisplay = DisplayGeometry(
            displayID: 2,
            framePoints: CGRect(x: -1920, y: -200, width: 1920, height: 1080),
            pixelWidth: 1920,
            pixelHeight: 1080,
            scaleFactor: 1.0,
            isMain: false
        )

        let secondaryNormalized = mapNormalizedOrPixelPointToGlobalPoints(
            x: 0.5,
            y: 0.25,
            in: secondaryDisplay,
            inputSpace: .normalized0To1
        )
        #expect(abs(secondaryNormalized.x - (-960.0)) < 0.001)
        #expect(abs(secondaryNormalized.y - 70.0) < 0.001)

        let secondaryPixels = mapNormalizedOrPixelPointToGlobalPoints(
            x: 1920,
            y: 1080,
            in: secondaryDisplay,
            inputSpace: .backingPixels
        )
        #expect(abs(secondaryPixels.x - 0.0) < 0.001)
        #expect(abs(secondaryPixels.y - 880.0) < 0.001)
    }

    // MARK: - BF-2499: TCC Revocation Detection & Signing Identity Verifier Tests

    @Test("CuaPermissionMonitor detects revoked TCC permission within < 2 seconds and triggers emergencyStop")
    func testPermissionMonitorDetectsRevocationAndStopsDriver() throws {
        let driver = RecordingCuaEventSink().makeDriver()
        driver.resetEmergencyStop()
        _ = driver.mouseDown(at: CGPoint(x: 200, y: 200), button: .left)

        let permissionsBox = ThreadSafeBox(CuaPermissions(hasScreenRecording: true, hasAccessibility: true))
        let revocationBox = ThreadSafeBox<CuaPermissionState?>(nil)
        let revocationSignal = DispatchSemaphore(value: 0)

        let monitor = CuaPermissionMonitor(
            driver: driver,
            pollInterval: 0.05,
            permissionChecker: {
                permissionsBox.value
            }
        )

        monitor.startMonitoring { state in
            revocationBox.value = state
            revocationSignal.signal()
        }

        // Simulate macOS revoking Screen Recording mid-stream.
        let revokeStartNs = DispatchTime.now().uptimeNanoseconds
        permissionsBox.value = CuaPermissions(hasScreenRecording: false, hasAccessibility: true)

        let waitResult = revocationSignal.wait(timeout: .now() + 1.5)
        let detectionElapsedSeconds = Double(DispatchTime.now().uptimeNanoseconds - revokeStartNs) / 1_000_000_000.0

        #expect(waitResult == .success)
        #expect(detectionElapsedSeconds < 2.0)
        #expect(driver.isEmergencyStopped == true)
        #expect(driver.heldMouseButtons.isEmpty)

        let finalState = revocationBox.value
        if case .revoked(let missingScreen, let missingAX, _) = finalState {
            #expect(missingScreen == true)
            #expect(missingAX == false)
        } else {
            Issue.record("Expected CuaPermissionState.revoked, got \(String(describing: finalState))")
        }
        #expect(finalState?.bannerMessage?.contains("Screen Recording") == true)
    }

    @available(macOS 14.0, *)
    @Test("ScreenStreamActor forwards stream errors immediately to CuaPermissionMonitor")
    func testScreenStreamActorErrorForwarding() async {
        let driver = RecordingCuaEventSink().makeDriver()
        driver.resetEmergencyStop()

        let monitor = CuaPermissionMonitor(
            driver: driver,
            permissionChecker: {
                CuaPermissions(hasScreenRecording: false, hasAccessibility: true)
            }
        )

        let actor = ScreenStreamActor()
        let capturedBox = ThreadSafeBox<CuaPermissionState?>(nil)

        await actor.setOnStreamStoppedWithError { error in
            capturedBox.value = monitor.notifyStreamStoppedWithError(error)
        }

        await actor.handleStreamStoppedWithError(ScreenStreamError.notAuthorized)

        #expect(driver.isEmergencyStopped == true)
        #expect(capturedBox.value?.isRevoked == true)
    }

    @Test("SigningIdentityVerifier validates stable Team ID CC8UTF7ATG and app.botfleet.macos")
    func testSigningIdentityVerifier() {
        let valid = SigningIdentityVerifier.evaluate(
            bundleIdentifier: "app.botfleet.macos",
            teamIdentifier: "CC8UTF7ATG",
            signingFlags: 0
        )
        #expect(valid.hasStableTCCIdentity == true)
        #expect(valid.isAdHocSigned == false)

        let adHoc = SigningIdentityVerifier.evaluate(
            bundleIdentifier: "app.botfleet.macos",
            teamIdentifier: nil,
            signingFlags: 0x0002
        )
        #expect(adHoc.hasStableTCCIdentity == false)
        #expect(adHoc.isAdHocSigned == true)

        let wrongTeam = SigningIdentityVerifier.evaluate(
            bundleIdentifier: "app.botfleet.macos",
            teamIdentifier: "OTHERTEAM1",
            signingFlags: 0
        )
        #expect(wrongTeam.hasStableTCCIdentity == false)
    }

    // MARK: - BF-2499: Safety-Stop Regression Tests

    @Test("The emergency-stop confirmation survives the asynchronous stream-stopped update")
    func testCuaStatusStateKeepsEmergencyStopConfirmation() {
        let state = CuaStatusState()

        state.record(.starting)
        #expect(state.current == .starting)

        // The operator triggers the emergency stop.
        state.record(.emergencyStopActivated)
        #expect(state.current == .emergencyStopActivated)

        // The asynchronous "stream stopped" update lands right after it and
        // must not replace the safety confirmation.
        state.record(.streamStopped)
        #expect(state.current == .emergencyStopActivated)
        #expect(state.current?.message == MacCuaStatus.emergencyStopActivated.message)

        // A freshly started capture session clears the latch.
        state.reset()
        state.record(.liveDesktopShared)
        #expect(state.current == .liveDesktopShared)
    }

    @available(macOS 14.0, *)
    @Test("A benign capture failure is not reported as a permission revocation")
    func testBenignStreamFailureIsNotReportedAsRevocation() {
        let driver = RecordingCuaEventSink().makeDriver()
        driver.resetEmergencyStop()

        let monitor = CuaPermissionMonitor(
            driver: driver,
            permissionChecker: {
                CuaPermissions(hasScreenRecording: true, hasAccessibility: true)
            }
        )

        // The baseline: both permissions were granted.
        monitor.startMonitoring()
        #expect(monitor.state == .authorized)

        let state = monitor.notifyStreamStoppedWithError(
            ScreenStreamError.captureFailed("the display was reconfigured")
        )

        // A transient capture failure is not a lost permission, so the operator
        // must not see the "permission was revoked" banner.
        #expect(state.isRevoked == false)
        #expect(state.bannerMessage == nil)
        // The capture really did stop, so the driver is still latched.
        #expect(driver.isEmergencyStopped == true)
    }

    @Test("A permission that was never granted is missing, not revoked")
    func testNeverGrantedAccessibilityIsMissingNotRevoked() {
        let driver = RecordingCuaEventSink().makeDriver()
        driver.resetEmergencyStop()

        let monitor = CuaPermissionMonitor(
            driver: driver,
            pollInterval: 0.05,
            permissionChecker: {
                // Screen Recording was granted, Accessibility never was.
                CuaPermissions(hasScreenRecording: true, hasAccessibility: false)
            }
        )

        let revocationSignal = DispatchSemaphore(value: 0)
        monitor.startMonitoring { _ in
            revocationSignal.signal()
        }

        if case .missingPermissions(let missingScreen, let missingAX) = monitor.state {
            #expect(missingScreen == false)
            #expect(missingAX == true)
        } else {
            Issue.record("Expected .missingPermissions, got \(monitor.state)")
        }

        // A poll must not escalate a never-granted permission into a revocation:
        // nothing was taken away from the operator, so the live capture keeps
        // running and the driver is not latched.
        let state = monitor.pollOnce()
        #expect(state.isRevoked == false)
        #expect(revocationSignal.wait(timeout: .now() + 0.3) == .timedOut)
        #expect(driver.isEmergencyStopped == false)
    }

    @Test("An emergency stop cannot leave a mouse button held when it interleaves with a mouse-down")
    func testEmergencyStopCannotLeaveMouseButtonHeld() {
        let driver = RecordingCuaEventSink().makeDriver()
        driver.resetEmergencyStop()

        let postedOrder = ThreadSafeEventLog()
        driver.mouseEventPostedHook = { type, button in
            let label: String
            switch type {
            case .leftMouseDown, .rightMouseDown, .otherMouseDown:
                label = "down-\(button.rawValue)"
            default:
                label = "up-\(button.rawValue)"
            }
            postedOrder.append(label)
        }

        let hookReached = DispatchSemaphore(value: 0)
        let releaseHook = DispatchSemaphore(value: 0)
        driver.mouseDownPrePostHook = {
            hookReached.signal()
            _ = releaseHook.wait(timeout: .now() + 5.0)
        }

        let downFinished = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async {
            _ = driver.mouseDown(at: CGPoint(x: 42, y: 42), button: .left)
            downFinished.signal()
        }

        #expect(hookReached.wait(timeout: .now() + 5.0) == .success)

        // The emergency stop runs while the mouse-down is still in flight.
        let stopFinished = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async {
            _ = driver.emergencyStop()
            stopFinished.signal()
        }

        // Give the stop a moment to contend for the driver lock, then let the
        // mouse-down finish.
        Thread.sleep(forTimeInterval: 0.05)
        releaseHook.signal()

        #expect(downFinished.wait(timeout: .now() + 5.0) == .success)
        #expect(stopFinished.wait(timeout: .now() + 5.0) == .success)

        // The down event has to reach the recording sink before the release.
        // Otherwise the window server sees the release first, the physical
        // button stays held, and no later emergency stop can release it.
        #expect(postedOrder.entries.first == "down-left")
        #expect(postedOrder.entries.contains("up-left"))
        #expect(driver.heldMouseButtons.isEmpty)
        #expect(driver.lastEmergencyStopReleasedButtons == [.left])
    }
}
#endif
