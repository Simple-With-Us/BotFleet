import XCTest
@testable import CompanionCore

private actor SuspendedHostLoad {
    private var continuation: CheckedContinuation<[HostRecord]?, Never>?
    func load() async -> [HostRecord]? { await withCheckedContinuation { continuation = $0 } }
    func started() -> Bool { continuation != nil }
    func finish(_ hosts: [HostRecord]?) { continuation?.resume(returning: hosts); continuation = nil }
}

@MainActor
final class MacLocalConnectionBootstrapTests: XCTestCase {
    func testDisconnectDuringSuspendedStartupPreventsAnyConnection() async throws {
        let load = SuspendedHostLoad()
        var generation = UUID()
        let captured = generation
        var connected: [HostRecord] = []
        let launch = Task {
            await MacLocalConnectionBootstrap.run(loadHosts: { await load.load() },
                isCurrent: { generation == captured }, connect: { connected.append($0) })
        }
        for _ in 0..<500 { if await load.started() { break }; await Task.yield() }
        generation = UUID()
        await load.finish([.thisMac])
        await launch.value
        XCTAssertTrue(connected.isEmpty)
    }
    func testSuspendedStartupSelectsOnlyTheSavedThisMacOrigin() async throws {
        let load = SuspendedHostLoad()
        var connected: [HostRecord] = []
        let remote = HostRecord(name: "Fixture", origin: try HostOrigin("https://fixture.test"))
        var local = HostRecord.thisMac; local.origin = try HostOrigin("http://127.0.0.1:17893")
        let launch = Task {
            await MacLocalConnectionBootstrap.run(loadHosts: { await load.load() },
                isCurrent: { true }, connect: { connected.append($0) })
        }
        for _ in 0..<500 { if await load.started() { break }; await Task.yield() }
        await load.finish([remote, local])
        await launch.value
        XCTAssertEqual(connected, [local])
    }
    func testFailedOrAnchorlessLoadAndCancelledStartupRemainDisconnected() async throws {
        let remote = HostRecord(name: "Fixture", origin: try HostOrigin("https://fixture.test"))
        let cases: [[HostRecord]?] = [nil, [remote]]
        for records in cases {
            var connected = false
            await MacLocalConnectionBootstrap.run(loadHosts: { records }, isCurrent: { true }, connect: { _ in connected = true })
            XCTAssertFalse(connected)
        }
        let load = SuspendedHostLoad()
        var connected = false
        let launch = Task {
            await MacLocalConnectionBootstrap.run(loadHosts: { await load.load() },
                isCurrent: { true }, connect: { _ in connected = true })
        }
        for _ in 0..<500 { if await load.started() { break }; await Task.yield() }
        launch.cancel(); await load.finish([.thisMac]); await launch.value
        XCTAssertFalse(connected)
    }
}
