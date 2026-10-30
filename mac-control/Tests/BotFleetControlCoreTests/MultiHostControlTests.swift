import XCTest
@testable import BotFleetControlCore

final class MultiHostControlTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        tempDir = FileManager.default.temporaryDirectory.appendingPathComponent("ControlMultiHostTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        MockURLProtocol.requests = []
        MockURLProtocol.handler = { _ in (500, Data()) }
        MockURLProtocol.failure = nil
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tempDir)
        try super.tearDownWithError()
    }

    func testServerHostStoreSeedsOnlyLocalDefaultAndEnforcesPermissions() throws {
        let storeFile = tempDir.appendingPathComponent("hosts.json")
        let store = ServerHostStore(fileURL: storeFile)

        // Initial load seeds only the app-owned loopback anchor.
        let hosts = store.loadHosts()
        XCTAssertEqual(hosts.count, 1)
        XCTAssertEqual(hosts[0].id, "local")
        XCTAssertTrue(hosts[0].isLocal)
        XCTAssertEqual(hosts[0].baseURL.absoluteString, "http://127.0.0.1:8799")

        // File permissions are 0600
        let attrs = try FileManager.default.attributesOfItem(atPath: storeFile.path)
        let perms = attrs[.posixPermissions] as? NSNumber
        XCTAssertEqual(perms?.intValue, 0o600)
    }

    func testServerHostStoreUpsertAndRemove() throws {
        let storeFile = tempDir.appendingPathComponent("hosts.json")
        let store = ServerHostStore(fileURL: storeFile)

        let customHost = ServerHost(
            id: "team-server",
            name: "Team Server",
            baseURL: URL(string: "https://control.example.test:8799")!,
            authToken: "secret-token-123",
            isLocal: false
        )

        store.upsertHost(customHost)
        var hosts = store.loadHosts()
        XCTAssertEqual(hosts.count, 2)
        XCTAssertTrue(hosts.contains(where: { $0.id == "team-server" && $0.authToken == "secret-token-123" }))

        // Refuses to remove the local Mac anchor host
        XCTAssertFalse(store.removeHost(id: "local"))
        XCTAssertEqual(store.loadHosts().count, 2)

        // Removes remote host
        XCTAssertTrue(store.removeHost(id: "team-server"))
        hosts = store.loadHosts()
        XCTAssertEqual(hosts.count, 1)
        XCTAssertFalse(hosts.contains(where: { $0.id == "team-server" }))
    }

    func testStoreMigratesOnlyTheExactSyntheticRemotePreset() throws {
        let legacyURL = URL(string: "https://hetzner.botfleet.app")!
        let exactPreset = ServerHost(
            id: "hetzner",
            name: "Hetzner Server",
            baseURL: legacyURL,
            isLocal: false
        )
        let nearMatches = [
            ServerHost(id: "custom-id", name: "Hetzner Server", baseURL: legacyURL),
            ServerHost(id: "hetzner", name: "Renamed Server", baseURL: legacyURL),
            ServerHost(id: "hetzner", name: "Hetzner Server", baseURL: URL(string: "https://custom.example.test")!),
            ServerHost(id: "hetzner", name: "Hetzner Server", baseURL: legacyURL, authToken: "configured-token"),
            ServerHost(id: "hetzner", name: "Hetzner Server", baseURL: legacyURL, authToken: ""),
            ServerHost(id: "hetzner", name: "Hetzner Server", baseURL: legacyURL, isLocal: true),
        ]

        for (index, nearMatch) in nearMatches.enumerated() {
            let storeFile = tempDir.appendingPathComponent("hosts-\(index).json")
            let store = ServerHostStore(fileURL: storeFile)
            try store.saveHosts([.defaultLocal, exactPreset, nearMatch])

            let hosts = store.loadHosts()

            XCTAssertEqual(hosts.count, 2)
            XCTAssertTrue(hosts.contains(nearMatch), "Near-match \(index) should be preserved")
            XCTAssertFalse(hosts.contains(exactPreset), "Exact synthetic preset should be removed")
            XCTAssertEqual(try JSONDecoder().decode([ServerHost].self, from: Data(contentsOf: storeFile)), hosts)
        }
    }

    func testProviderLinkedLegacyHostAndProviderBytesArePreserved() throws {
        let providerFile = tempDir.appendingPathComponent("linked-providers.json")
        let providerStore = VMProviderStore(fileURL: providerFile)
        try providerStore.saveConfigurations([providerConfiguration(id: "hetzner")])
        let providerBytes = try Data(contentsOf: providerFile)
        let hostStore = ServerHostStore(
            fileURL: tempDir.appendingPathComponent("linked-hosts.json"),
            preservedHostIDs: { providerStore.configuredServerIDs() }
        )
        try hostStore.saveHosts([.defaultLocal, legacySyntheticHost()])

        let hosts = hostStore.loadHosts()

        XCTAssertTrue(hosts.contains(legacySyntheticHost()))
        XCTAssertEqual(try Data(contentsOf: providerFile), providerBytes)
    }

    func testUnrelatedProviderIDAllowsLegacyHostMigration() throws {
        let providerFile = tempDir.appendingPathComponent("unrelated-providers.json")
        let providerStore = VMProviderStore(fileURL: providerFile)
        try providerStore.saveConfigurations([providerConfiguration(id: "another-server")])
        let providerBytes = try Data(contentsOf: providerFile)
        let hostStore = ServerHostStore(
            fileURL: tempDir.appendingPathComponent("unrelated-hosts.json"),
            preservedHostIDs: { providerStore.configuredServerIDs() }
        )
        try hostStore.saveHosts([.defaultLocal, legacySyntheticHost()])

        let hosts = hostStore.loadHosts()

        XCTAssertFalse(hosts.contains(legacySyntheticHost()))
        XCTAssertEqual(hosts, [.defaultLocal])
        XCTAssertEqual(try Data(contentsOf: providerFile), providerBytes)
    }

    func testUnreadableProviderStoreConservativelyPreservesLegacyHost() throws {
        let providerFile = tempDir.appendingPathComponent("unreadable-providers.json")
        try Data("not valid provider JSON".utf8).write(to: providerFile)
        let providerBytes = try Data(contentsOf: providerFile)
        let providerStore = VMProviderStore(fileURL: providerFile)
        let hostStore = ServerHostStore(
            fileURL: tempDir.appendingPathComponent("unreadable-hosts.json"),
            preservedHostIDs: { providerStore.configuredServerIDs() }
        )
        try hostStore.saveHosts([.defaultLocal, legacySyntheticHost()])

        let hosts = hostStore.loadHosts()

        XCTAssertTrue(hosts.contains(legacySyntheticHost()))
        XCTAssertEqual(try Data(contentsOf: providerFile), providerBytes)
    }

    func testAbsentProviderStoreAllowsLegacyHostMigration() throws {
        let providerFile = tempDir.appendingPathComponent("absent-providers.json")
        let providerStore = VMProviderStore(fileURL: providerFile)
        let hostStore = ServerHostStore(
            fileURL: tempDir.appendingPathComponent("absent-hosts.json"),
            preservedHostIDs: { providerStore.configuredServerIDs() }
        )
        try hostStore.saveHosts([.defaultLocal, legacySyntheticHost()])

        let hosts = hostStore.loadHosts()

        XCTAssertFalse(hosts.contains(legacySyntheticHost()))
        XCTAssertEqual(hosts, [.defaultLocal])
        XCTAssertFalse(FileManager.default.fileExists(atPath: providerFile.path))
    }

    func testRemoteHostControlAPIInjectsBearerAuth() async throws {
        let host = ServerHost(
            id: "remote-server",
            name: "Remote Server",
            baseURL: URL(string: "https://control.example.test")!,
            authToken: "fleet-remote-bearer-key",
            isLocal: false
        )

        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fleet-remote-bearer-key")
            if request.url!.path == "/api/health" {
                return (200, Data(#"{"app":"botfleet","pid":999,"ready":true}"#.utf8))
            }
            if request.url!.path == "/api/system/control" {
                return (200, Data(#"""
                {
                    "activeBotCount": 2,
                    "persistOnExit": true,
                    "localVms": [
                        { "key": "shared", "name": "Shared Cloud VM", "running": true, "state": "running" }
                    ]
                }
                """#.utf8))
            }
            return (404, Data("{}".utf8))
        }

        let api = ControlAPI(session: mockSession(), host: host)
        let status = try await api.status()
        XCTAssertEqual(status.activeBotCount, 2)
        XCTAssertTrue(status.isSharedVMRunning)
        XCTAssertFalse(status.canStartSharedVM)
        XCTAssertTrue(status.canStopSharedVM)
    }

    func testSharedVMLifecycleStateTransitions() async throws {
        let host = ServerHost(
            id: "remote-server",
            name: "Remote Server",
            baseURL: URL(string: "https://control.example.test")!,
            isLocal: false
        )

        // 1. Shared VM is stopped / missing
        MockURLProtocol.handler = { request in
            if request.url!.path == "/api/health" {
                return (200, Data(#"{"app":"botfleet","pid":123,"ready":true}"#.utf8))
            }
            if request.url!.path == "/api/system/control" {
                return (200, Data(#"""
                {
                    "activeBotCount": 0,
                    "persistOnExit": true,
                    "localVms": [
                        { "key": "shared", "name": "Shared Cloud VM", "running": false, "state": "missing" }
                    ]
                }
                """#.utf8))
            }
            if request.url!.path == "/api/system/control/vms/start" {
                return (200, Data(#"{"ok":true}"#.utf8))
            }
            if request.url!.path == "/api/system/control/vms/stop" {
                return (200, Data(#"{"ok":true}"#.utf8))
            }
            return (404, Data("{}".utf8))
        }

        let api = ControlAPI(session: mockSession(), host: host)
        let offStatus = try await api.status()
        XCTAssertFalse(offStatus.isSharedVMRunning)
        XCTAssertTrue(offStatus.canStartSharedVM)
        XCTAssertFalse(offStatus.canStopSharedVM)

        // Start shared VM
        try await api.startSharedVM()
        XCTAssertTrue(MockURLProtocol.requests.contains { $0.url!.path == "/api/system/control/vms/start" })

        // Stop shared VM
        try await api.stopSharedVM()
        XCTAssertTrue(MockURLProtocol.requests.contains { $0.url!.path == "/api/system/control/vms/stop" })
    }

    func testServerHostStorePreservesCorruptFileAndRefusesOverwrite() throws {
        let storeFile = tempDir.appendingPathComponent("hosts.json")
        try "{ not valid json ...".write(to: storeFile, atomically: true, encoding: .utf8)

        let store = ServerHostStore(fileURL: storeFile)
        let loaded = store.loadHosts()
        XCTAssertEqual(loaded.count, 1)

        // Verify a .corrupt backup file was created
        let files = try FileManager.default.contentsOfDirectory(atPath: tempDir.path)
        XCTAssertTrue(files.contains { $0.contains("corrupt") })

        // Re-corrupt the file
        try "corrupt content".write(to: storeFile, atomically: true, encoding: .utf8)
        let hostToUpsert = ServerHost(id: "h1", name: "H1", baseURL: URL(string: "https://example.com")!)
        store.upsertHost(hostToUpsert)

        // Refused to overwrite with defaults, original corrupt content is preserved
        let raw = try String(contentsOf: storeFile, encoding: .utf8)
        XCTAssertEqual(raw, "corrupt content")
    }

    private func mockSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: config)
    }

    private func legacySyntheticHost() -> ServerHost {
        ServerHost(
            id: "hetzner",
            name: "Hetzner Server",
            baseURL: URL(string: "https://hetzner.botfleet.app")!,
            isLocal: false
        )
    }

    private func providerConfiguration(id: String) -> VMProviderConfiguration {
        VMProviderConfiguration(
            id: id,
            providerID: "custom-script",
            displayName: "Fixture Provider",
            apiToken: "fixture-token",
            command: "/usr/bin/true"
        )
    }
}
