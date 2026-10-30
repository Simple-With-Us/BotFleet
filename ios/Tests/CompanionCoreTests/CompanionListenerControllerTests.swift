import Foundation
import Testing
@testable import CompanionCore
#if canImport(Network)
import Network
#endif

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

    func start(
        advertising: CompanionListenerAdvertisement?,
        onUpdate: @escaping @Sendable (CompanionListenerUpdate) async -> Void
    ) async throws -> UInt16? {
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

    func start(
        advertising: CompanionListenerAdvertisement?,
        onUpdate: @escaping @Sendable (CompanionListenerUpdate) async -> Void
    ) async throws -> UInt16? {
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

    func start(
        advertising: CompanionListenerAdvertisement?,
        onUpdate: @escaping @Sendable (CompanionListenerUpdate) async -> Void
    ) async throws -> UInt16? {
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

/// Keeps every start's callback so tests can deliver current or stale events
/// directly, including an event while the first start has not answered.
private actor FailingListenerBackend: CompanionListenerBackend {
    private var updates: [@Sendable (CompanionListenerUpdate) async -> Void] = []
    private var sequences: [UInt64] = []
    private let gateFirstStart: Bool
    private let reportFailureOnStop: Bool
    private var gate: CheckedContinuation<Void, Never>?
    private var gateWaiters: [CheckedContinuation<Void, Never>] = []
    private var firstStartError: String?

    init(gateFirstStart: Bool = false, reportFailureOnStop: Bool = false) {
        self.gateFirstStart = gateFirstStart
        self.reportFailureOnStop = reportFailureOnStop
    }

    func start(
        advertising: CompanionListenerAdvertisement?,
        onUpdate: @escaping @Sendable (CompanionListenerUpdate) async -> Void
    ) async throws -> UInt16? {
        let index = updates.count
        updates.append(onUpdate)
        sequences.append(0)
        if index == 0, gateFirstStart {
            await withCheckedContinuation { continuation in
                gate = continuation
                for waiter in gateWaiters { waiter.resume() }
                gateWaiters.removeAll()
            }
            if let firstStartError {
                throw NSError(domain: "FailingListenerBackend", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: firstStartError])
            }
        }
        return 8812 + UInt16(index)
    }

    func stop() async {
        if reportFailureOnStop, !updates.isEmpty {
            await fail(start: updates.count - 1, reason: "cancelled during stop")
        }
    }

    func fail(start index: Int, reason: String) async {
        await emit(start: index, event: .failed(reason: reason))
    }

    var startCount: Int { updates.count }

    func emit(start index: Int, event: CompanionListenerUpdate.Event, sequence: UInt64? = nil) async {
        sequences[index] += 1
        await updates[index](CompanionListenerUpdate(sequence: sequence ?? sequences[index], event: event))
    }

    func firstStartIsWaiting() async {
        if gate != nil { return }
        await withCheckedContinuation { gateWaiters.append($0) }
    }

    func finishFirstStart(error: String? = nil) {
        firstStartError = error
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
        #expect(controller.state.summary == "Listener failed: port 8812 is in use")
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

    @Test("A running listener failure replaces listening and reaches the session mirror (BF-2595)")
    @MainActor
    func runningFailureIsReported() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        let backend = FailingListenerBackend()
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        var seen: [CompanionListenerState] = []
        controller.onStateChange = { seen.append($0) }
        try await controller.setEnabled(true)
        await backend.fail(start: 0, reason: "network listener failed")
        #expect(controller.state == .failed(reason: "network listener failed"))
        #expect(controller.state.summary == "Listener failed: network listener failed")
        #expect(controller.isEnabled)
        #expect(store.readCompanionListenerEnabled() == true)
        #expect(seen == [.starting, .listening(port: 8812, advertisedAs: "Ada's Mac"),
                         .failed(reason: "network listener failed")])
        // Enabling again retries a failed listener without changing policy.
        try await controller.setEnabled(true)
        #expect(controller.state == .listening(port: 8813, advertisedAs: "Ada's Mac"))
    }

    @Test("A failure after readiness but before start returns cannot be overwritten (BF-2595)")
    @MainActor
    func failureBeforeStartReturnsIsPreserved() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        let backend = FailingListenerBackend(gateFirstStart: true)
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        let starting = Task { @MainActor in await controller.start() }
        await backend.firstStartIsWaiting()
        await backend.fail(start: 0, reason: "failed just after readiness")
        #expect(controller.state == .failed(reason: "failed just after readiness"))
        await backend.finishFirstStart()
        await starting.value
        #expect(controller.state == .failed(reason: "failed just after readiness"))
    }

    @Test("An old listener failure cannot overwrite a newer listener (BF-2595)")
    @MainActor
    func staleListenerFailureIsIgnored() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        let backend = FailingListenerBackend()
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        await controller.start()
        await controller.stop()
        await controller.start()
        await backend.fail(start: 0, reason: "old listener failed")
        #expect(controller.state == .listening(port: 8813, advertisedAs: "Ada's Mac"))
        await backend.fail(start: 1, reason: "current listener failed")
        #expect(controller.state == .failed(reason: "current listener failed"))
    }

    @Test("A late error from a superseded start cannot overwrite its retry (BF-2595)")
    @MainActor
    func staleStartErrorIsIgnored() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        let backend = FailingListenerBackend(gateFirstStart: true)
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        let first = Task { @MainActor in await controller.start() }
        await backend.firstStartIsWaiting()
        await backend.fail(start: 0, reason: "first listener failed")
        await controller.start()
        await backend.finishFirstStart(error: "old start finally threw")
        await first.value
        await backend.fail(start: 0, reason: "old queued failure")
        #expect(controller.state == .listening(port: 8813, advertisedAs: "Ada's Mac"))
    }

    @Test("Intentional stop and disable ignore queued listener failures (BF-2595)")
    @MainActor
    func intentionalStopDoesNotReportFailure() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        let backend = FailingListenerBackend(reportFailureOnStop: true)
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        try await controller.setEnabled(true)
        var seen: [CompanionListenerState] = []
        controller.onStateChange = { seen.append($0) }
        await controller.stop()
        await backend.fail(start: 0, reason: "failure queued before stop")
        #expect(controller.state == .stopped)
        #expect(seen == [.stopped])
        try await controller.setEnabled(true)
        try await controller.setEnabled(false)
        await backend.fail(start: 1, reason: "failure queued before disable")
        #expect(controller.state == .off)
        #expect(!controller.isEnabled)
        #expect(!seen.contains {
            if case .failed = $0 { return true }
            return false
        })
    }

    @Test("A waiting listener recovers on ready without a new start")
    @MainActor
    func waitingRecoversAutomatically() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        let backend = FailingListenerBackend()
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        await controller.start()
        await backend.emit(start: 0, event: .waiting(reason: "network unavailable"))
        #expect(controller.state == .waiting(reason: "network unavailable"))
        #expect(controller.state.summary == "Waiting for network: network unavailable")
        await controller.start()
        #expect(await backend.startCount == 1)
        await backend.emit(start: 0, event: .ready(port: 8812))
        #expect(controller.state == .listening(port: 8812, advertisedAs: "Ada's Mac"))
    }

    @Test("Waiting after ready is not overwritten by a delayed start result")
    @MainActor
    func waitingSurvivesStartReturn() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        let backend = FailingListenerBackend(gateFirstStart: true)
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        let starting = Task { @MainActor in await controller.start() }
        await backend.firstStartIsWaiting()
        await backend.emit(start: 0, event: .ready(port: 8812))
        await backend.emit(start: 0, event: .waiting(reason: "network unavailable"))
        await backend.finishFirstStart()
        await starting.value
        #expect(controller.state == .waiting(reason: "network unavailable"))
        await backend.emit(start: 0, event: .ready(port: 8812))
        #expect(controller.state == .listening(port: 8812, advertisedAs: "Ada's Mac"))
    }

    @Test("A fatal start error after its ready callback cannot leave the controller listening")
    @MainActor
    func readyThenThrowIsFailed() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        let backend = FailingListenerBackend(gateFirstStart: true)
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        let starting = Task { @MainActor in await controller.start() }
        await backend.firstStartIsWaiting()
        await backend.emit(start: 0, event: .ready(port: 8812))
        #expect(controller.state == .listening(port: 8812, advertisedAs: "Ada's Mac"))
        await backend.finishFirstStart(error: "fatal after readiness")
        await starting.value
        #expect(controller.state == .failed(reason: "fatal after readiness"))
    }

    @Test("Queued waiting or ready events cannot revive a stopped or newer listener")
    @MainActor
    func staleNetworkStatesAreIgnored() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        let backend = FailingListenerBackend()
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        await controller.start()
        await backend.emit(start: 0, event: .waiting(reason: "network unavailable"))
        await controller.stop()
        await backend.emit(start: 0, event: .ready(port: 8812))
        #expect(controller.state == .stopped)
        await controller.start()
        await backend.emit(start: 0, event: .waiting(reason: "stale wait"))
        await backend.emit(start: 0, event: .ready(port: 8812))
        #expect(controller.state == .listening(port: 8813, advertisedAs: "Ada's Mac"))
    }

    @Test("A later state wins when network callbacks cross actors out of order")
    @MainActor
    func reorderedNetworkStatesAreIgnored() async throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        let backend = FailingListenerBackend()
        let controller = CompanionListenerController(backend: backend, policyStore: store, advertisement: ada)
        await controller.start()
        await backend.emit(start: 0, event: .ready(port: 8812), sequence: 3)
        await backend.emit(start: 0, event: .waiting(reason: "older wait"), sequence: 2)
        await backend.emit(start: 0, event: .failed(reason: "older failure"), sequence: 1)
        #expect(controller.state == .listening(port: 8812, advertisedAs: "Ada's Mac"))
        await backend.emit(start: 0, event: .failed(reason: "fatal failure"), sequence: 4)
        await backend.emit(start: 0, event: .ready(port: 8812), sequence: 5)
        #expect(controller.state == .failed(reason: "fatal failure"))
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
    @Test("A reserved fatal error wins over delayed ready and cleanup cancellation")
    func reservedFatalCompletionWins() {
        let settlement = ListenerStartSettlement()
        let failure = NWError.posix(.ENETDOWN)
        settlement.reserveFailure(failure)
        var outcomes: [String] = []
        settlement.once { outcomes.append("delayed ready") }
        settlement.once { outcomes.append("cleanup cancellation") }
        #expect(outcomes.isEmpty)
        settlement.finishFailure { outcomes.append("fatal error") }
        settlement.finishFailure { outcomes.append("duplicate failure") }
        #expect(outcomes == ["fatal error"])
        #expect(settlement.failure == failure)
    }

    @Test(
        "A replacement prepares before releasing the old port, and an occupied port is not reported ready",
        .timeLimit(.minutes(1))
    )
    func realListenerAnswersItsPort() async throws {
        // Loopback only, on ports the system picks: no desktop input, and
        // nothing a phone could reach.
        let database = try DatabaseService(path: ":memory:")
        let runtime = NativeRuntimeServices(
            database: database,
            engineCoordinator: EngineCoordinatorActor(),
            engineSwitch: BotNativeEngineSwitchActor(database: database),
            workspaceSource: ListenerFixtureWorkspaces(),
            processOwnershipSource: ListenerFixtureProcesses()
        )
        let server = NativeCompanionServer(database: database, nativeRuntime: runtime)
        let first = try await server.startListening(port: 0)
        #expect(first != nil)
        #expect(await server.listeningPort == first)
        let second = try await server.startListening(port: 0)
        #expect(second != nil)
        #expect(await server.listeningPort == second)
        // A rejected preparation leaves the healthy listener in place.
        await runtime.shutdown()
        await #expect(throws: NativeRuntimeServicesError.self) {
            try await server.startListening(port: 0)
        }
        #expect(await server.listeningPort == second)

        // A conflicting bind may wait or fail, depending on the platform.
        // A waiting start remains cancellable instead of being called ready.
        let contenderDatabase = try DatabaseService(path: ":memory:")
        let contender = NativeCompanionServer(database: contenderDatabase)
        let updates = ListenerFixtureUpdates()
        let attempt = Task {
            do {
                return try await contender.startListening(port: second ?? 0) { update in
                    await updates.record(update.event)
                }
            } catch {
                await updates.record(.failed(reason: error.localizedDescription))
                throw error
            }
        }
        switch await updates.first() {
        case .waiting, .failed: break
        case .ready: Issue.record("An occupied listener port unexpectedly became ready")
        }
        #expect(await contender.listeningPort == nil)
        await contender.stopListening()
        await #expect(throws: (any Error).self) {
            try await attempt.value
        }
        #expect(await contender.listeningPort == nil)
        await server.stopListening()
        #expect(await server.listeningPort == nil)
    }
    #endif
}

#if canImport(Network)
private struct ListenerFixtureWorkspaces: NativeEventWaitWorkspaceSource {
    func workspaceRoot(forRegisteredBotId botId: String) async throws -> URL? { nil }
}

private struct ListenerFixtureProcesses: NativeEventWaitProcessOwnershipSource {
    func hasFinishedProcess(pid: Int32, startTime: Double, ownedByBotId botId: String) async -> Bool { false }
}

private actor ListenerFixtureUpdates {
    private var firstUpdate: CompanionListenerUpdate.Event?
    private var waiter: CheckedContinuation<CompanionListenerUpdate.Event, Never>?

    func record(_ event: CompanionListenerUpdate.Event) {
        guard firstUpdate == nil else { return }
        firstUpdate = event
        waiter?.resume(returning: event)
        waiter = nil
    }

    func first() async -> CompanionListenerUpdate.Event {
        if let firstUpdate { return firstUpdate }
        return await withCheckedContinuation { waiter = $0 }
    }
}
#endif
