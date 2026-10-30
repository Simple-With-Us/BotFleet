import Foundation
import Testing
@testable import CompanionCore

/// Records what the controller asked of it and opens nothing.
private actor StubListenerBackend: CompanionListenerBackend {
    enum Call: Equatable {
        case start(advertising: String?)
        case stop
    }

    private(set) var calls: [Call] = []
    private var failure: String?
    private var port: UInt16? = 8812

    func failStarts(with reason: String?) {
        failure = reason
    }

    func reportPort(_ value: UInt16?) {
        port = value
    }

    func start(advertising: CompanionListenerAdvertisement?) async throws -> UInt16? {
        calls.append(.start(advertising: advertising?.name))
        if let failure {
            throw NSError(domain: "StubListenerBackend", code: 1, userInfo: [NSLocalizedDescriptionKey: failure])
        }
        return port
    }

    func stop() async {
        calls.append(.stop)
    }
}

/// Reads the setting at the moment each call lands, so "write, then act" is
/// observed rather than inferred.
private actor StoreReadingBackend: CompanionListenerBackend {
    private let store: MacPersistencePolicyStore
    private(set) var settingAtStart: [Bool?] = []
    private(set) var settingAtStop: [Bool?] = []

    init(store: MacPersistencePolicyStore) {
        self.store = store
    }

    func start(advertising: CompanionListenerAdvertisement?) async throws -> UInt16? {
        settingAtStart.append(store.readCompanionListenerEnabled())
        return 8812
    }

    func stop() async {
        settingAtStop.append(store.readCompanionListenerEnabled())
    }
}

/// A backend whose start, or whose stop, waits at a gate the test opens, so a
/// second call can land while the first is still in flight without sleeping.
private actor GatedListenerBackend: CompanionListenerBackend {
    enum Gated {
        case start
        case stop
    }

    private let gated: Gated
    private(set) var calls: [StubListenerBackend.Call] = []
    private var gate: CheckedContinuation<Void, Never>?
    private var waitingForGate: [CheckedContinuation<Void, Never>] = []

    init(gating gated: Gated) {
        self.gated = gated
    }

    func start(advertising: CompanionListenerAdvertisement?) async throws -> UInt16? {
        calls.append(.start(advertising: advertising?.name))
        if gated == .start { await waitAtGate() }
        return 8812
    }

    func stop() async {
        calls.append(.stop)
        if gated == .stop { await waitAtGate() }
    }

    private func waitAtGate() async {
        for waiter in waitingForGate { waiter.resume() }
        waitingForGate.removeAll()
        await withCheckedContinuation { gate = $0 }
    }

    /// Returns once the gated call has been made and is waiting.
    func gateReached() async {
        if gate != nil { return }
        await withCheckedContinuation { waitingForGate.append($0) }
    }

    func openGate() {
        gate?.resume()
        gate = nil
    }
}

@Suite("Companion listener lifecycle (BF-2590)")
struct CompanionListenerControllerTests {
    private func makeStore() throws -> (MacPersistencePolicyStore, URL) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("bf-2590-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return (MacPersistencePolicyStore(dataDir: dir), dir)
    }

    private let ada = CompanionListenerAdvertisement(name: "Ada's Mac")

    @Test("The setting is off by default, and a launch then starts nothing")
    @MainActor
    func offByDefault() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        let backend = StubListenerBackend()
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        #expect(controller.isEnabled == false)
        await controller.applyLaunch()
        #expect(controller.state == .off)
        #expect(await backend.calls.isEmpty)
        #expect(controller.state.summary.contains("Node harness"))
    }

    @Test("With the setting on, a launch starts the listener and advertises this Mac")
    @MainActor
    func enabledStartsAtLaunch() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try store.writeCompanionListenerEnabled(true)
        let backend = StubListenerBackend()
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        #expect(controller.isEnabled == true)
        await controller.applyLaunch()
        #expect(controller.state == .listening(port: 8812, advertisedAs: "Ada's Mac"))
        #expect(await backend.calls == [.start(advertising: "Ada's Mac")])
        #expect(controller.state.summary == "Listening on port 8812, advertised on this network as Ada's Mac.")
    }

    @Test("Closing the main window keeps the listener up when the server is kept running")
    @MainActor
    func windowCloseKeepsListenerWhenPersisting() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try store.writeCompanionListenerEnabled(true)
        let backend = StubListenerBackend()
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        await controller.applyLaunch()
        await controller.applyExitPolicy(.mainWindowClosed, persistOnExit: true)
        #expect(controller.state == .listening(port: 8812, advertisedAs: "Ada's Mac"))
        #expect(await backend.calls == [.start(advertising: "Ada's Mac")])
    }

    @Test("Closing the main window stops the listener when the server is shut down too")
    @MainActor
    func windowCloseStopsListenerWhenNotPersisting() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try store.writeCompanionListenerEnabled(true)
        let backend = StubListenerBackend()
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        await controller.applyLaunch()
        await controller.applyExitPolicy(.mainWindowClosed, persistOnExit: false)
        #expect(controller.state == .stopped)
        #expect(await backend.calls == [.start(advertising: "Ada's Mac"), .stop])
    }

    @Test("Quitting the app stops the listener even when the server is kept running")
    @MainActor
    func appTerminationAlwaysStops() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try store.writeCompanionListenerEnabled(true)
        let backend = StubListenerBackend()
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        await controller.applyLaunch()
        await controller.applyExitPolicy(.appTerminating, persistOnExit: true)
        #expect(controller.state == .stopped)
        #expect(await backend.calls.last == .stop)
    }

    @Test("A start that fails is reported in the backend's words and never as listening")
    @MainActor
    func startFailureIsReported() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try store.writeCompanionListenerEnabled(true)
        let backend = StubListenerBackend()
        await backend.failStarts(with: "port 8812 is in use")
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        await controller.applyLaunch()
        #expect(controller.state == .failed(reason: "port 8812 is in use"))
        #expect(controller.state.summary == "Could not start: port 8812 is in use")
        // A stop after a failed start does not pretend something was stopped.
        await controller.stop()
        #expect(controller.state == .failed(reason: "port 8812 is in use"))
    }

    @Test("Turning the setting on writes it down and starts; turning it off stops and reads off")
    @MainActor
    func toggleWritesAndActs() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        let backend = StubListenerBackend()
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: nil)
        try await controller.setEnabled(true)
        #expect(store.readCompanionListenerEnabled() == true)
        #expect(controller.isEnabled == true)
        #expect(controller.state == .listening(port: 8812, advertisedAs: nil))
        #expect(controller.state.summary == "Listening on port 8812.")
        try await controller.setEnabled(false)
        #expect(store.readCompanionListenerEnabled() == false)
        #expect(controller.isEnabled == false)
        #expect(controller.state == .off)
        #expect(await backend.calls == [.start(advertising: nil), .stop])
    }

    @Test("The setting is on disk before the backend is asked to start, and off before it is asked to stop")
    @MainActor
    func settingIsWrittenBeforeTheBackendMoves() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        let backend = StoreReadingBackend(store: store)
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: nil)
        try await controller.setEnabled(true)
        try await controller.setEnabled(false)
        #expect(await backend.settingAtStart == [true])
        #expect(await backend.settingAtStop == [false])
    }

    @Test("A setting that cannot be written leaves the flag and the listener untouched")
    @MainActor
    func refusedWriteStartsNothing() async throws {
        let (_, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        // A regular file where the data directory should be refuses the write
        // for every user, root included.
        let notADirectory = dir.appendingPathComponent("not-a-directory")
        try Data().write(to: notADirectory)
        let store = MacPersistencePolicyStore(dataDir: notADirectory)
        let backend = StubListenerBackend()
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        await #expect(throws: (any Error).self) {
            try await controller.setEnabled(true)
        }
        #expect(controller.isEnabled == false)
        #expect(controller.state == .off)
        #expect(await backend.calls.isEmpty)
    }

    @Test("Turning the setting on while already listening does not start a second listener")
    @MainActor
    func enablingTwiceStartsOnce() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        let backend = StubListenerBackend()
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        try await controller.setEnabled(true)
        try await controller.setEnabled(true)
        #expect(controller.state == .listening(port: 8812, advertisedAs: "Ada's Mac"))
        #expect(await backend.calls == [.start(advertising: "Ada's Mac")])
    }

    @Test("A start that failed is retried by the next enable")
    @MainActor
    func failedStartIsRetriedByTheNextEnable() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try store.writeCompanionListenerEnabled(true)
        let backend = StubListenerBackend()
        await backend.failStarts(with: "port 8812 is in use")
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        await controller.applyLaunch()
        #expect(controller.state == .failed(reason: "port 8812 is in use"))
        await backend.failStarts(with: nil)
        try await controller.setEnabled(true)
        #expect(controller.state == .listening(port: 8812, advertisedAs: "Ada's Mac"))
        #expect(await backend.calls == [.start(advertising: "Ada's Mac"), .start(advertising: "Ada's Mac")])
    }

    @Test("A start that answers after a later stop does not overwrite the stop")
    @MainActor
    func lateStartDoesNotOverwriteStop() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try store.writeCompanionListenerEnabled(true)
        let backend = GatedListenerBackend(gating: .start)
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        var seen: [CompanionListenerState] = []
        controller.onStateChange = { seen.append($0) }
        let launch = Task { @MainActor in await controller.applyLaunch() }
        await backend.gateReached()
        await controller.stop()
        await backend.openGate()
        await launch.value
        #expect(controller.state == .stopped)
        #expect(seen == [.starting, .stopped])
        #expect(await backend.calls == [.start(advertising: "Ada's Mac"), .stop])
    }

    @Test("A stop that answers after a later start does not overwrite the start: off then on ends listening")
    @MainActor
    func lateStopDoesNotOverwriteNewerStart() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try store.writeCompanionListenerEnabled(true)
        let backend = GatedListenerBackend(gating: .stop)
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        await controller.applyLaunch()
        var seen: [CompanionListenerState] = []
        controller.onStateChange = { seen.append($0) }
        let turningOff = Task { @MainActor in try await controller.setEnabled(false) }
        await backend.gateReached()
        try await controller.setEnabled(true)
        await backend.openGate()
        try await turningOff.value
        #expect(controller.isEnabled == true)
        #expect(store.readCompanionListenerEnabled() == true)
        #expect(controller.state == .listening(port: 8812, advertisedAs: "Ada's Mac"))
        #expect(seen == [.starting, .listening(port: 8812, advertisedAs: "Ada's Mac")])
        #expect(await backend.calls == [.start(advertising: "Ada's Mac"), .stop, .start(advertising: "Ada's Mac")])
    }

    @Test("A backend that cannot read its port back is shown as listening without one")
    @MainActor
    func unknownPortIsReportedWithoutOne() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try store.writeCompanionListenerEnabled(true)
        let backend = StubListenerBackend()
        await backend.reportPort(nil)
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        await controller.applyLaunch()
        #expect(controller.state == .listening(port: nil, advertisedAs: "Ada's Mac"))
        #expect(controller.state.summary == "Listening, advertised on this network as Ada's Mac.")
    }

    @Test("The setting file is written atomically with mode 0600 and round-trips")
    func policyFileRoundTrips() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        #expect(store.readCompanionListenerEnabled() == nil)
        try store.writeCompanionListenerEnabled(true)
        // Only the policy file remains: the staging file was renamed into
        // place, not left beside it.
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path) == [MacPersistencePolicyStore.companionListenerPolicyFileName])
        let file = dir.appendingPathComponent(MacPersistencePolicyStore.companionListenerPolicyFileName)
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        #expect(try String(contentsOf: file, encoding: .utf8) == "true\n")
        #expect(store.readCompanionListenerEnabled() == true)
        try store.writeCompanionListenerEnabled(false)
        #expect(store.readCompanionListenerEnabled() == false)
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path) == [MacPersistencePolicyStore.companionListenerPolicyFileName])
        try Data("maybe\n".utf8).write(to: file)
        #expect(store.readCompanionListenerEnabled() == nil)
    }

    @Test("Every state change reaches the session's mirror in order")
    @MainActor
    func stateChangesAreReported() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try store.writeCompanionListenerEnabled(true)
        let backend = StubListenerBackend()
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        var seen: [CompanionListenerState] = []
        controller.onStateChange = { seen.append($0) }
        await controller.applyLaunch()
        await controller.stop()
        #expect(seen == [.starting, .listening(port: 8812, advertisedAs: "Ada's Mac"), .stopped])
    }

    @Test("The default advertisement is this Mac's name, or nothing when the name is unknown")
    func defaultAdvertisement() {
        #expect(CompanionListenerController.defaultAdvertisement(computerName: "Ada's Mac")?.name == "Ada's Mac")
        #expect(CompanionListenerController.defaultAdvertisement(computerName: "  Ada's Mac\n")?.name == "Ada's Mac")
        #expect(CompanionListenerController.defaultAdvertisement(computerName: "   ") == nil)
        #expect(CompanionListenerController.defaultAdvertisement(computerName: nil) == nil)
        #expect(CompanionListenerAdvertisement.serviceType == "_botfleet._tcp")
    }

    @Test("The listener options keep their old shape: no advertisement unless asked")
    func listenerOptionsDefaultToNoAdvertisement() {
        let defaults = NativeCompanionServer.ListenerOptions()
        #expect(defaults.advertisedName == nil)
        #expect(defaults == NativeCompanionServer.ListenerOptions(bindAddress: "127.0.0.1", allowCleartextLAN: false))
        #expect(defaults.resolvedBindAddress == "127.0.0.1")
        var advertised = defaults
        advertised.advertisedName = "Ada's Mac"
        #expect(advertised != defaults)
        #expect(advertised.resolvedBindAddress == "127.0.0.1")
    }

    #if canImport(Network)
    @Test(
        "A real listener answers the port it bound, a second start replaces the first, and a port in use is a failed start",
        .timeLimit(.minutes(1))
    )
    func realListenerAnswersItsPort() async throws {
        // Loopback only, on ports the system picks: no desktop input, and
        // nothing a phone could reach.
        let database = try DatabaseService(path: ":memory:")
        let server = NativeCompanionServer(database: database)
        let first = try await server.startListening(port: 0)
        #expect(first != nil)
        #expect(await server.listeningPort == first)
        let second = try await server.startListening(port: 0)
        #expect(second != nil)
        #expect(await server.listeningPort == second)
        // The port the server holds is in use: a second server asking for it
        // gets a thrown error, not a listener that never becomes ready.
        let contenderDatabase = try DatabaseService(path: ":memory:")
        let contender = NativeCompanionServer(database: contenderDatabase)
        await #expect(throws: (any Error).self) {
            try await contender.startListening(port: second ?? 0)
        }
        #expect(await contender.listeningPort == nil)
        await server.stopListening()
        #expect(await server.listeningPort == nil)
    }
    #endif
}
