import Foundation
import Testing
@testable import CompanionCore

/// Records what the controller asked of it and opens nothing.
actor StubListenerBackend: CompanionListenerBackend {
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

    @Test("The setting file is written atomically with mode 0600 and round-trips")
    func policyFileRoundTrips() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        #expect(store.readCompanionListenerEnabled() == nil)
        try store.writeCompanionListenerEnabled(true)
        let file = dir.appendingPathComponent(MacPersistencePolicyStore.companionListenerPolicyFileName)
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        #expect((attributes[.posixPermissions] as? Int) == 0o600)
        #expect(try String(contentsOf: file, encoding: .utf8) == "true\n")
        #expect(store.readCompanionListenerEnabled() == true)
        try store.writeCompanionListenerEnabled(false)
        #expect(store.readCompanionListenerEnabled() == false)
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
}
