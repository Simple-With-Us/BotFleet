import XCTest
@testable import CompanionCore

final class PlacementModeAvailabilityTests: XCTestCase {
    private let serverHostID = "server:11111111-1111-4111-8111-111111111111"

    private func unverifiedRemoteHost() throws -> HostRecord {
        HostRecord(name: "Hetzner", origin: try HostOrigin("https://fixture.test"))
    }

    private func verifiedRemoteHost() throws -> HostRecord {
        HostRecord(name: "Hetzner", origin: try HostOrigin("https://fixture.test"), hostId: serverHostID)
    }

    func testEmptyStoreDisablesServerModesWithAddServerReason() {
        let model = PlacementModeAvailability.evaluate(
            hosts: [.thisMac],
            selectedServerID: nil,
            placement: PlacementSettings()
        )
        XCTAssertFalse(model.hasRemoteServer)
        XCTAssertFalse(model.hasVerifiedServer)
        XCTAssertFalse(model.canTakeOverOnThisMac)
        XCTAssertNil(model.takeOverCaption)
        XCTAssertNil(model.savedVsAppliedCaption)
        XCTAssertEqual(model.options.map(\.mode), [.localOnly, .serverFirst, .macFirst])

        let local = model.options[0]
        XCTAssertTrue(local.isSelectable)
        XCTAssertNil(local.disabledReason)
        XCTAssertEqual(local.title, "This Mac Only")

        for serverOption in model.options.dropFirst() {
            XCTAssertFalse(serverOption.isSelectable)
            XCTAssertEqual(serverOption.disabledReason, "Add a server to use this mode.")
        }
    }

    func testUnverifiedServerRequiresTestBeforeServerModes() throws {
        let unverified = try unverifiedRemoteHost()
        let model = PlacementModeAvailability.evaluate(
            hosts: [.thisMac, unverified],
            selectedServerID: unverified.id,
            placement: PlacementSettings()
        )
        XCTAssertTrue(model.hasRemoteServer)
        XCTAssertFalse(model.hasVerifiedServer)
        XCTAssertTrue(model.options[0].isSelectable)
        XCTAssertEqual(model.options[1].disabledReason, "Test this server before using this mode.")
        XCTAssertEqual(model.options[2].disabledReason, "Test this server before using this mode.")
    }

    func testVerifiedServerEnablesAllModesAndExposesOverflowOnServerFirst() throws {
        let verified = try verifiedRemoteHost()
        let model = PlacementModeAvailability.evaluate(
            hosts: [.thisMac, verified],
            selectedServerID: verified.id,
            placement: PlacementSettings()
        )
        XCTAssertTrue(model.hasRemoteServer)
        XCTAssertTrue(model.hasVerifiedServer)
        XCTAssertTrue(model.options.allSatisfy(\.isSelectable))
        XCTAssertFalse(model.options[0].showsOverflowToggle)
        XCTAssertTrue(model.options[1].showsOverflowToggle)
        XCTAssertEqual(model.options[1].overflowTitle, "Allow Overflow To This Mac")
        XCTAssertFalse(model.options[2].showsOverflowToggle)
    }

    func testRunningJobsBlockModeTransitionsUntilIdleOrTakeover() throws {
        let verified = try verifiedRemoteHost()
        let macBlocked = PlacementModeAvailability.evaluate(
            hosts: [.thisMac, verified],
            selectedServerID: verified.id,
            placement: PlacementSettings(),
            runningLocalJobsCount: 1
        )
        XCTAssertEqual(macBlocked.options[1].disabledReason, "Finish or stop 1 job running on this Mac first")
        XCTAssertTrue(macBlocked.options[0].isSelectable)
        XCTAssertTrue(macBlocked.options[2].isSelectable)

        var serverApplied = PlacementSettings()
        serverApplied.saved = PlacementSelection(mode: .serverFirst, serverID: verified.id, allowOverflowToThisMac: true)
        serverApplied.applied = serverApplied.saved
        let serverBlocked = PlacementModeAvailability.evaluate(
            hosts: [.thisMac, verified],
            selectedServerID: verified.id,
            placement: serverApplied,
            runningServerJobsCount: 2,
            serverReachable: true
        )
        XCTAssertEqual(serverBlocked.options[0].disabledReason, "Finish or stop 2 jobs running on the server first")
        XCTAssertTrue(serverBlocked.options[1].isSelectable)
        XCTAssertEqual(serverBlocked.options[2].disabledReason, "Finish or stop 2 jobs running on the server first")
        XCTAssertFalse(serverBlocked.canTakeOverOnThisMac)

        var macFirstApplied = PlacementSettings()
        macFirstApplied.saved = PlacementSelection(mode: .macFirst, serverID: verified.id, allowOverflowToThisMac: false)
        macFirstApplied.applied = macFirstApplied.saved
        let macFirstToLocalBlocked = PlacementModeAvailability.evaluate(
            hosts: [.thisMac, verified],
            selectedServerID: verified.id,
            placement: macFirstApplied,
            runningServerJobsCount: 1,
            serverReachable: true
        )
        XCTAssertFalse(macFirstToLocalBlocked.options[0].isSelectable)
        XCTAssertEqual(macFirstToLocalBlocked.options[0].disabledReason, "Finish or stop 1 job running on the server first")
        XCTAssertTrue(macFirstToLocalBlocked.options[1].isSelectable)
        XCTAssertTrue(macFirstToLocalBlocked.options[2].isSelectable)

        let unreachableDisallowsCleanSwitches = PlacementModeAvailability.evaluate(
            hosts: [.thisMac, verified],
            selectedServerID: verified.id,
            placement: serverApplied,
            runningServerJobsCount: 2,
            serverReachable: false
        )
        XCTAssertFalse(unreachableDisallowsCleanSwitches.options[0].isSelectable)
        XCTAssertEqual(unreachableDisallowsCleanSwitches.options[0].disabledReason, PlacementModeAvailability.takeOverAvailableCaption)
        XCTAssertTrue(unreachableDisallowsCleanSwitches.options[1].isSelectable)
        XCTAssertFalse(unreachableDisallowsCleanSwitches.options[2].isSelectable)
        XCTAssertTrue(unreachableDisallowsCleanSwitches.canTakeOverOnThisMac)
        XCTAssertEqual(unreachableDisallowsCleanSwitches.takeOverCaption, PlacementModeAvailability.takeOverAvailableCaption)

        let unreachableMacFirstBlocksServerFirst = PlacementModeAvailability.evaluate(
            hosts: [.thisMac, verified],
            selectedServerID: verified.id,
            placement: macFirstApplied,
            serverReachable: false
        )
        XCTAssertFalse(unreachableMacFirstBlocksServerFirst.options[1].isSelectable)
        XCTAssertFalse(unreachableMacFirstBlocksServerFirst.canTakeOverOnThisMac)

        // Switching off reachable serverFirst with a server-owned overflow job running only on the Mac worker
        // (runningLocalJobsCount = 1, runningServerJobsCount = 0) must still fence both localOnly and macFirst.
        let serverOverflowOnMacOnly = PlacementModeAvailability.evaluate(
            hosts: [.thisMac, verified],
            selectedServerID: verified.id,
            placement: serverApplied,
            runningLocalJobsCount: 1,
            runningServerJobsCount: 0,
            serverReachable: true
        )
        XCTAssertFalse(serverOverflowOnMacOnly.options[0].isSelectable)
        XCTAssertEqual(serverOverflowOnMacOnly.options[0].disabledReason, "Finish or stop 1 job running on this Mac first")
        XCTAssertTrue(serverOverflowOnMacOnly.options[1].isSelectable)
        XCTAssertFalse(serverOverflowOnMacOnly.options[2].isSelectable)
        XCTAssertEqual(serverOverflowOnMacOnly.options[2].disabledReason, "Finish or stop 1 job running on this Mac first")
    }

    func testAppliedModeRemainsSelectableEvenIfServerRemovedOrUnmatched() throws {
        let verified = try verifiedRemoteHost()
        var serverApplied = PlacementSettings()
        serverApplied.saved = PlacementSelection(mode: .serverFirst, serverID: verified.id)
        serverApplied.applied = serverApplied.saved

        let removedServer = PlacementModeAvailability.evaluate(
            hosts: [.thisMac],
            selectedServerID: verified.id,
            placement: serverApplied
        )
        XCTAssertTrue(removedServer.options[0].isSelectable)
        XCTAssertTrue(removedServer.options[1].isSelectable)
        XCTAssertNil(removedServer.options[1].disabledReason)
        XCTAssertFalse(removedServer.options[2].isSelectable)

        let unmatchedSelection = PlacementModeAvailability.evaluate(
            hosts: [.thisMac, verified],
            selectedServerID: "missing-server-id",
            placement: PlacementSettings()
        )
        XCTAssertTrue(unmatchedSelection.options[0].isSelectable)
        XCTAssertFalse(unmatchedSelection.options[1].isSelectable)
        XCTAssertEqual(unmatchedSelection.options[1].disabledReason, PlacementModeAvailability.selectServerReason)
        XCTAssertFalse(unmatchedSelection.options[2].isSelectable)
        XCTAssertEqual(unmatchedSelection.options[2].disabledReason, PlacementModeAvailability.selectServerReason)
    }

    func testSavedVsAppliedAndUnreachableBannerCopy() throws {
        let verified = try verifiedRemoteHost()
        var settings = PlacementSettings()
        settings.saved = PlacementSelection(mode: .serverFirst, serverID: verified.id, allowOverflowToThisMac: false)
        let model = PlacementModeAvailability.evaluate(
            hosts: [.thisMac, verified],
            selectedServerID: verified.id,
            placement: settings
        )
        XCTAssertEqual(model.savedVsAppliedCaption, PlacementModeAvailability.unappliedSelectionCaption)

        let banner = PlacementModeAvailability.unreachableBanner(serverName: "Hetzner", originHost: "fleet.ts.net")
        XCTAssertTrue(banner.hasPrefix("Can't reach Hetzner at fleet.ts.net."))
        XCTAssertTrue(banner.contains("Work already running on this Mac finishes."))
        XCTAssertTrue(banner.contains("New work is refused until Hetzner returns or you take over."))
    }
}
