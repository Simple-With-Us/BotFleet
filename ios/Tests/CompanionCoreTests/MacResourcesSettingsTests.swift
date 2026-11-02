import Foundation
import XCTest
@testable import CompanionCore

private actor FixtureResourceHosts: ServersHostStore {
    var records: [HostRecord] = [.thisMac]
    var placement = PlacementSettings()
    var failRead = false

    func configure(records: [HostRecord], failRead: Bool = false) {
        self.records = records
        self.failRead = failRead
    }

    func hosts() throws -> [HostRecord] {
        if failRead { throw SavedHostError.unreadableStore }
        return records
    }

    func settings() throws -> PlacementSettings { placement }
    func upsert(_ host: HostRecord) throws {
        if let index = records.firstIndex(where: { $0.id == host.id }) {
            records[index] = host
        } else {
            records.append(host)
        }
    }
    func updateThisMacOrigin(_ origin: HostOrigin) throws { records[0].origin = origin }
    func remove(id: String, controllerID: String?, leasedHostIDs: Set<String>) throws {
        records.removeAll { $0.id == id }
    }
}

private final class FixtureResourceTokens: HostTokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]

    func read(for host: HostRecord) throws -> HostGateCredential? {
        lock.lock(); defer { lock.unlock() }
        return try values[host.id].map { try KeychainHostTokenStore.decode($0, for: host) }
    }

    func write(_ token: RedactedSecret, for host: HostRecord) throws {
        lock.lock(); defer { lock.unlock() }
        values[host.id] = try KeychainHostTokenStore.encode(token, for: host)
    }

    func remove(recordID: String) throws {
        lock.lock(); defer { lock.unlock() }
        values[recordID] = nil
    }
}

private actor HeldResourceFetch {
    var shouldHold = false
    var continuation: CheckedContinuation<HostResourcesReport, Never>?

    func setShouldHold(_ value: Bool) {
        shouldHold = value
    }

    func fetchOrWait(defaultReport: HostResourcesReport) async -> HostResourcesReport {
        guard shouldHold else { return defaultReport }
        return await withCheckedContinuation { continuation = $0 }
    }

    func isWaiting() -> Bool { continuation != nil }
    func resume(with report: HostResourcesReport) {
        continuation?.resume(returning: report)
        continuation = nil
    }
}

private final class HostResourcesURLProtocol: URLProtocol {
    static var handler: (URLRequest) -> (Int, Data) = { _ in (500, Data()) }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, data) = Self.handler(request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
final class MacResourcesSettingsTests: XCTestCase {
    private let gb: Double = pow(1024.0, 3.0)
    // 2026-10-29T19:14:00Z == 2:14 PM CDT
    private let sampleTimestampMs: Double = 1_793_301_240_000

    private func makeSample(
        cores: Double? = 10,
        loadPerCore: Double? = 2.41,
        ramTotalBytes: Double? = nil,
        ramAvailableBytes: Double? = nil,
        memoryPressure: String? = nil,
        memoryAvailablePercent: Double? = 63,
        swapTotalBytes: Double? = nil,
        swapUsedBytes: Double? = nil,
        diskTotalBytes: Double? = nil,
        diskFreeBytes: Double? = nil,
        inodesTotal: Double? = 6_000_000,
        inodesFree: Double? = 5_000_000,
        dataVolume: HostDataVolume? = HostDataVolume(device: "8:16", mountPoint: "/mnt/fleet-extra"),
        rootDiskFreeBytes: Double? = nil,
        storage: HostStorageState? = HostStorageState(online: true, dataDevice: "8:16", rootDevice: "8:1")
    ) -> HostCapacitySample {
        HostCapacitySample(
            at: sampleTimestampMs,
            cores: cores,
            loadPerCore: loadPerCore,
            ramTotalBytes: ramTotalBytes ?? 32 * gb,
            ramAvailableBytes: ramAvailableBytes ?? 20 * gb,
            memoryPressure: memoryPressure,
            memoryAvailablePercent: memoryAvailablePercent,
            swapTotalBytes: swapTotalBytes ?? 4 * gb,
            swapUsedBytes: swapUsedBytes ?? 3 * gb,
            diskTotalBytes: diskTotalBytes ?? 100 * gb,
            diskFreeBytes: diskFreeBytes ?? 60 * gb,
            inodesTotal: inodesTotal,
            inodesFree: inodesFree,
            dataVolume: dataVolume,
            rootDiskFreeBytes: rootDiskFreeBytes ?? 10 * gb,
            storage: storage
        )
    }

    private func makeReport(
        hostId: String = "mac:12345678-1234-1234-1234-123456789012",
        version: String? = "1.2.3",
        platform: String = "darwin",
        capabilities: [String] = ["shell", "macos", "desktop"],
        sample: HostCapacitySample? = nil,
        admission: HostAdmissionThresholds? = nil,
        enforcement: HostEnforcementMap = HostEnforcementMap(),
        limitations: [String] = ["Disk is an admission gate; no disk quota is observed"]
    ) -> HostResourcesReport {
        HostResourcesReport(
            hostId: hostId,
            version: version,
            platform: platform,
            capabilities: capabilities,
            sample: sample ?? makeSample(),
            storage: (sample ?? makeSample()).storage,
            admission: admission ?? HostAdmissionThresholds(maxSwapPercent: 98, minFreeDiskBytes: 2 * gb),
            enforcement: enforcement,
            observedLimits: [:],
            limitations: limitations
        )
    }

    func testMacSettingsSectionIncludesResourcesAndDeepLinks() {
        XCTAssertEqual(MacSettingsSection.resources.displayTitle, "Resources")
        XCTAssertEqual(MacSettingsSection.resources.symbolName, "gauge.with.dots.needle.33percent")
        XCTAssertEqual(
            MacSettingsDeepLinkRouter.section(for: URL(string: "botfleet://settings/resources")!),
            .resources
        )
        XCTAssertEqual(
            MacSettingsDeepLinkRouter.section(for: URL(string: "botfleet://settings?section=resources")!),
            .resources
        )
    }

    func testEnforcementSentenceExactCopyAndNoLimitOrCapOutsideKernelCap() {
        XCTAssertEqual(
            HostResourcesPresentation.enforcementSentence(
                .kernelCap(mechanism: "cgroup v2 memory.max, whole server"),
                noun: "the server"
            ),
            "Enforced by the system (cgroup v2 memory.max, whole server)"
        )
        XCTAssertEqual(
            HostResourcesPresentation.enforcementSentence(.stopWhenOver, noun: "the server"),
            "Watched: jobs are stopped if they exceed it"
        )
        XCTAssertEqual(
            HostResourcesPresentation.enforcementSentence(.gateOnly, noun: "this Mac"),
            "Checked before each job starts"
        )
        XCTAssertEqual(
            HostResourcesPresentation.enforcementSentence(.priorityOnly, noun: "this Mac"),
            "Full speed allowed.\u{00A0} Jobs run at background priority."
        )
        XCTAssertEqual(
            HostResourcesPresentation.enforcementSentence(.unsupported(reason: "No swap is configured"), noun: "this Mac"),
            "Not enforced on this Mac: No swap is configured"
        )
        XCTAssertEqual(
            HostResourcesPresentation.enforcementSentence(
                .notApplied(reason: "Disk reading unavailable; admission permits unknown readings", restartRequired: false),
                noun: "the server"
            ),
            "Not applied: Disk reading unavailable; admission permits unknown readings"
        )

        let nonKernelStates: [HostEnforcementState] = [
            .stopWhenOver,
            .gateOnly,
            .priorityOnly,
            .unsupported(reason: "No inode admission gate is active"),
            .notApplied(reason: "Server storage offline; new jobs are refused", restartRequired: false),
        ]
        for state in nonKernelStates {
            let text = HostResourcesPresentation.enforcementSentence(state, noun: "the server").lowercased()
            XCTAssertFalse(text.contains("limit"), text)
            XCTAssertFalse(text.contains("cap"), text)
        }
    }

    func testFormattersUnitsGroupingCentralTimeAndHostSubtitle() {
        XCTAssertEqual(HostResourcesPresentation.formatBytes(32 * gb), "32.0 GB")
        XCTAssertEqual(HostResourcesPresentation.formatBytes(2 * gb), "2.0 GB")
        XCTAssertEqual(HostResourcesPresentation.formatBytes(512 * 1024 * 1024), "512 MB")
        XCTAssertEqual(HostResourcesPresentation.formatBytes(0), "0 bytes")
        XCTAssertEqual(HostResourcesPresentation.formatBytes(nil), "Unknown")

        XCTAssertEqual(HostResourcesPresentation.formatCount(5_000_000, singular: "inode"), "5,000,000 inodes")
        XCTAssertEqual(HostResourcesPresentation.formatCount(1, singular: "core"), "1 core")
        XCTAssertEqual(HostResourcesPresentation.formatCount(10, singular: "core"), "10 cores")

        let central = HostResourcesPresentation.formatCentralTime(sampleTimestampMs)
        XCTAssertTrue(central.contains("2:14 PM"), central)
        XCTAssertTrue(central.contains("CDT") || central.contains("CST"), central)

        let macReport = makeReport()
        let linuxReport = makeReport(
            hostId: "server:12345678-1234-1234-1234-123456789012",
            platform: "linux"
        )
        XCTAssertEqual(HostResourcesPresentation.hostNoun(macReport), "this Mac")
        XCTAssertEqual(HostResourcesPresentation.hostNoun(linuxReport), "the server")
        XCTAssertEqual(
            HostResourcesPresentation.hostSubtitle(for: macReport),
            "macOS · 1.2.3 · shell, macos, desktop"
        )
    }

    func testAdmissionRowsSavedVsAppliedAndEffectiveMemoryEnforcement() {
        let base = makeReport()
        let baseByKey = Dictionary(uniqueKeysWithValues: HostResourcesPresentation.admissionRows(for: base).map { ($0.key, $0) })
        XCTAssertEqual(baseByKey["reservedCpuCores"]?.saved, "Not set")
        XCTAssertEqual(baseByKey["reservedRam"]?.saved, "Not set")
        XCTAssertEqual(baseByKey["minMemoryAvailablePercent"]?.saved, "Not set")
        XCTAssertEqual(baseByKey["minFreeInodes"]?.saved, "Not set")
        XCTAssertEqual(baseByKey["minFreeInodes"]?.applied, "Not set: no gate")
        XCTAssertNil(baseByKey["reservedCpuCores"]?.mismatch)
        XCTAssertEqual(baseByKey["reservedCpuCores"]?.envOverride, "BOTFLEET_JOBS_RESERVED_CPU_CORES")

        // Saved Mac CPU reservation never acts as a gate on macOS.
        let macCpuReserved = makeReport(
            admission: HostAdmissionThresholds(maxSwapPercent: 98, minFreeDiskBytes: 2 * gb, reservedCpuCores: 2)
        )
        let cpuRow = HostResourcesPresentation.admissionRows(for: macCpuReserved).first { $0.key == "reservedCpuCores" }!
        XCTAssertEqual(cpuRow.saved, "2 cores")
        XCTAssertTrue(cpuRow.applied.contains("Not applied on this Mac"))
        XCTAssertEqual(cpuRow.mismatch, cpuRow.applied)

        // Over-capacity reservation on Linux server shows no-capacity sentence.
        let overRamServer = makeReport(
            hostId: "server:12345678-1234-1234-1234-123456789012",
            platform: "linux",
            admission: HostAdmissionThresholds(maxSwapPercent: 98, minFreeDiskBytes: 2 * gb, reservedRamBytes: 32 * gb)
        )
        let ramRow = HostResourcesPresentation.admissionRows(for: overRamServer).first { $0.key == "reservedRam" }!
        XCTAssertEqual(ramRow.mismatch, HostResourcesPresentation.noCapacitySentence(platform: "linux"))
        XCTAssertTrue(ramRow.mismatch!.contains("\u{00A0} "))

        // Swapless host with headroom set keeps memory gate enforced.
        var swaplessSample = makeSample()
        swaplessSample.swapTotalBytes = 0
        swaplessSample.swapUsedBytes = 0
        let swaplessEnforcement = HostEnforcementMap(
            cpu: .priorityOnly,
            memory: .unsupported(reason: "No swap is configured; no RAM budget check is active"),
            swap: .unsupported(reason: "No swap is configured"),
            disk: .gateOnly,
            inodes: .unsupported(reason: "No inode admission gate is active"),
            io: .unsupported(reason: "No I/O rate enforcement observed")
        )
        let swaplessWithHeadroom = makeReport(
            hostId: "server:12345678-1234-1234-1234-123456789012",
            platform: "linux",
            sample: swaplessSample,
            admission: HostAdmissionThresholds(
                maxSwapPercent: 98,
                minFreeDiskBytes: 2 * gb,
                reservedRamBytes: 1 * gb,
                minMemoryAvailablePercent: 10
            ),
            enforcement: swaplessEnforcement
        )
        XCTAssertEqual(HostResourcesPresentation.effectiveMemoryEnforcement(for: swaplessWithHeadroom), .gateOnly)
        let swaplessByKey = Dictionary(
            uniqueKeysWithValues: HostResourcesPresentation.admissionRows(for: swaplessWithHeadroom).map { ($0.key, $0) }
        )
        XCTAssertEqual(swaplessByKey["reservedRam"]?.applied, "1.0 GB")
        XCTAssertNil(swaplessByKey["reservedRam"]?.mismatch)
        XCTAssertEqual(swaplessByKey["minMemoryAvailablePercent"]?.applied, "10%")
        XCTAssertNil(swaplessByKey["minMemoryAvailablePercent"]?.mismatch)
        XCTAssertEqual(swaplessByKey["maxSwapPercent"]?.applied, "Not enforced on the server: No swap is configured")
    }

    func testResourceRowsUnknownReadingOfflineStorageAndNullSafety() {
        var missingDisk = makeSample()
        missingDisk.diskFreeBytes = nil
        let missingDiskReport = makeReport(sample: missingDisk)
        let diskRow = HostResourcesPresentation.resourceRows(for: missingDiskReport).first { $0.key == "disk" }!
        XCTAssertTrue(diskRow.use.contains("Unknown"))
        XCTAssertTrue(diskRow.enforcement.contains("not checked before jobs start"))
        XCTAssertTrue(diskRow.enforcement.contains("2:14 PM"))

        var offlineSample = makeSample()
        offlineSample.storage = HostStorageState(online: false, dataDevice: nil, rootDevice: "8:1")
        let offlineReport = makeReport(sample: offlineSample)
        let offlineDisk = HostResourcesPresentation.resourceRows(for: offlineReport).first { $0.key == "disk" }!
        XCTAssertNotNil(offlineDisk.alert)
        XCTAssertTrue(offlineDisk.alert!.contains("/mnt/fleet-extra is not mounted"))
        XCTAssertTrue(offlineDisk.alert!.contains("\u{00A0} "))

        let cpuRow = HostResourcesPresentation.resourceRows(for: makeReport()).first { $0.key == "cpu" }!
        XCTAssertEqual(cpuRow.detected, "10 cores")
        XCTAssertTrue(cpuRow.use.contains("Load 2.41 per core"))
        XCTAssertEqual(cpuRow.enforcement, "Full speed allowed.\u{00A0} Jobs run at background priority.")

        let nullSample = HostCapacitySample(at: sampleTimestampMs)
        let nullReport = makeReport(sample: nullSample)
        for row in HostResourcesPresentation.resourceRows(for: nullReport) where row.key != "io" {
            XCTAssertFalse(row.detected.contains("0 GB"), row.key)
            XCTAssertFalse(row.use.contains("0 GB"), row.key)
        }
    }

    func testCoordinatorLoadsHostsPreservesReportDuringRefreshAndForwardsGateHeader() async throws {
        let store = FixtureResourceHosts()
        let tokens = FixtureResourceTokens()
        let remoteID = "server:11111111-1111-4111-8111-111111111111"
        let remoteHost = HostRecord(
            name: "Hetzner Server",
            origin: try HostOrigin("https://fixture.test"),
            hostId: remoteID
        )
        await store.configure(records: [.thisMac, remoteHost])
        try tokens.write(RedactedSecret("fixture-gate-token"), for: remoteHost)

        let held = HeldResourceFetch()
        let initialReport = makeReport()
        let remoteReport = makeReport(hostId: remoteID, platform: "linux", capabilities: ["shell"])

        let coordinator = ResourcesCoordinator(
            store: store,
            tokens: tokens,
            fetcher: { host, credential in
                if !host.isLocal {
                    XCTAssertNotNil(credential)
                }
                let fallback = host.isLocal ? initialReport : remoteReport
                return await held.fetchOrWait(defaultReport: fallback)
            }
        )

        await coordinator.load()
        XCTAssertEqual(coordinator.hosts, [.thisMac, remoteHost])
        XCTAssertEqual(coordinator.selectedHostID, HostRecord.localID)
        XCTAssertEqual(coordinator.state, .ready(initialReport))
        XCTAssertEqual(coordinator.currentReport, initialReport)

        // Trigger a refresh that stays in-flight and verify the previous report stays visible.
        await held.setShouldHold(true)
        let refreshTask = Task { await coordinator.refresh() }
        for _ in 0..<200 {
            if await held.isWaiting() { break }
            await Task.yield()
        }
        XCTAssertEqual(coordinator.state, .refreshing(initialReport))
        XCTAssertTrue(coordinator.state.isRefreshing)
        XCTAssertEqual(coordinator.currentReport, initialReport)

        var updatedReport = initialReport
        updatedReport.version = "1.2.4"
        await held.resume(with: updatedReport)
        await refreshTask.value
        XCTAssertEqual(coordinator.state, .ready(updatedReport))

        // Select the remote server and verify it loads cleanly.
        await held.setShouldHold(false)
        await coordinator.selectHost(id: remoteHost.id)
        XCTAssertEqual(coordinator.selectedHostID, remoteHost.id)
        XCTAssertEqual(coordinator.currentReport?.hostId, remoteID)
        XCTAssertEqual(coordinator.currentReport?.platform, "linux")
    }

    func testHostResourcesClientForwardsGateHeaderAndValidatesResponse() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [HostResourcesURLProtocol.self]
        let session = URLSession(configuration: config)
        addTeardownBlock { session.invalidateAndCancel() }

        let remoteID = "server:11111111-1111-4111-8111-111111111111"
        let origin = try HostOrigin("https://fixture.test")
        let host = HostRecord(name: "Remote", origin: origin, hostId: remoteID)
        let credential = try HostGateCredential(origin: origin, token: RedactedSecret("fixture-gate-token"))
        let expected = makeReport(hostId: remoteID, platform: "linux", capabilities: ["shell"])
        let encoded = try JSONEncoder().encode(expected)

        HostResourcesURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/host/resources")
            XCTAssertEqual(request.value(forHTTPHeaderField: "x-botfleet-gate-token"), "fixture-gate-token")
            return (200, encoded)
        }

        let client = HostResourcesClient(session: session)
        let decoded = try await client.fetchResources(host: host, credential: credential)
        XCTAssertEqual(decoded, expected)

        // Missing credential on remote host fails before making a network call.
        do {
            _ = try await client.fetchResources(host: host, credential: nil)
            XCTFail("Remote host without credential must fail")
        } catch {
            XCTAssertEqual(error as? SavedHostError, .credentialUnavailable)
        }

        // HTTP 403 maps to .authentication.
        HostResourcesURLProtocol.handler = { _ in (403, Data("{}".utf8)) }
        do {
            _ = try await client.fetchResources(host: host, credential: credential)
            XCTFail("HTTP 403 must throw .authentication")
        } catch {
            XCTAssertEqual(error as? SavedHostError, .authentication)
        }
    }
}
