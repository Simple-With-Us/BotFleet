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
        let defaults = MacLifecycleSettings()
        #expect(defaults.allowRemoteDesktopLaunch == false)
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
        MacLifecycleStubURLProtocol.configure { _, _ in
            (0, Data(), URLError(.cannotConnectToHost))
        }
        let offlineSettings = try await client.fetchLifecycleSettings()
        #expect(offlineSettings.allowRemoteDesktopLaunch == false)
        #expect(offlineSettings.persistOnExit == false)
    }

    @Test("MacLifecycleClient shutDownServerAndLocalVM calls POST /api/system/shutdown and ensures stopped.marker")
    func testShutdownEndpointAndMarker() async throws {
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
        #expect(requests[0].path == "/api/system/shutdown")
        #expect(requests[0].headers["Origin"] == "http://127.0.0.1:8799")
    }

    @Test("MacQuitPolicyDecision honors persistOnExit == true vs false")
    func testQuitPolicyDecision() {
        #expect(MacLifecycleClient.evaluateQuitAction(persistOnExit: true) == .keepServerRunning)
        #expect(MacLifecycleClient.evaluateQuitAction(persistOnExit: false) == .shutDownServerAndVM)
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

    @Test("MacCuaDriver emergencyStop aborts mid-drag within < 100 ms and releases all held mouse buttons")
    func testEmergencyStopMidDragAndButtonRelease() throws {
        let driver = MacCuaDriver()
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
        let driver = MacCuaDriver()
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
        let driver = MacCuaDriver()
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
}
#endif
