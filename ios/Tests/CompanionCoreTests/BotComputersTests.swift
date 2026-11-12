import Foundation
import XCTest
@testable import CompanionCore

/// What the phone sends when the person flips a computer switch.  The harness
/// answers a `computers` write from a paired phone with its own rule (This Mac
/// must come out the way it went in), so these pin the half of that rule the
/// phone owns: it never asks to change This Mac, even when the sheet is stale.
final class BotComputersTests: XCTestCase {
    func testNothingChangedSendsNothing() {
        XCTAssertNil(BotComputers.updated(current: ["vm"], baseline: ["vm"], picks: ["vm"]))
        XCTAssertNil(BotComputers.updated(current: nil, baseline: [], picks: []))
        // This Mac is not a switch the phone owns: the form carrying it in its
        // state, changed or not, is not a change.
        XCTAssertNil(BotComputers.updated(current: ["vm", "local"], baseline: ["vm", "local"], picks: ["vm", "local"]))
        XCTAssertNil(BotComputers.updated(current: ["vm"], baseline: ["vm"], picks: ["vm", "local"]))
    }

    func testSwitchingCloudAndVmIsSentInTheComputersOrder() {
        XCTAssertEqual(
            BotComputers.updated(current: [], baseline: [], picks: ["vm", "cloud"]),
            ["cloud", "vm"]
        )
        XCTAssertEqual(
            BotComputers.updated(current: ["cloud", "vm"], baseline: ["cloud", "vm"], picks: ["cloud"]),
            ["cloud"]
        )
        XCTAssertEqual(
            BotComputers.updated(current: ["cloud"], baseline: ["cloud"], picks: []),
            []
        )
    }

    func testThisMacComesOutTheWayItWentIn() {
        // Held: carried through, however the other two are switched.
        XCTAssertEqual(
            BotComputers.updated(current: ["local"], baseline: ["local"], picks: ["local", "vm"]),
            ["vm", "local"]
        )
        XCTAssertEqual(
            BotComputers.updated(current: ["cloud", "local"], baseline: ["cloud", "local"], picks: ["local"]),
            ["local"]
        )
        // Not held: never added, even if the form somehow shows it on.
        XCTAssertEqual(
            BotComputers.updated(current: ["vm"], baseline: ["vm"], picks: ["vm", "cloud", "local"]),
            ["cloud", "vm"]
        )
    }

    func testAChangeMadeOnTheComputerWhileTheSheetWasOpenIsNotUndone() {
        // The sheet opened with no This Mac, and the computer granted it before
        // the save.  The request keeps it: refusing the save for a change the
        // person did not make would be the always-failing control again.
        XCTAssertEqual(
            BotComputers.updated(current: ["local"], baseline: [], picks: ["vm"]),
            ["vm", "local"]
        )
        // And the other switch the computer changed is not overwritten with the
        // stale copy the form opened with.
        XCTAssertEqual(
            BotComputers.updated(current: ["cloud", "vm"], baseline: ["vm"], picks: ["vm", "cloud"]),
            nil
        )
        XCTAssertEqual(
            BotComputers.updated(current: ["cloud", "vm"], baseline: ["vm"], picks: []),
            ["cloud"]
        )
    }

    func testAnAutoBotBecomesAListOnTheFirstSwitch() {
        // `nil` is Auto (the computer picks).  Like the desktop, the first
        // switch turns it into an explicit list of what was picked.
        XCTAssertEqual(
            BotComputers.updated(current: nil, baseline: [], picks: ["vm"]),
            ["vm"]
        )
    }

    func testHoldsThisMac() {
        XCTAssertTrue(BotComputers.holdsThisMac(["vm", "local"]))
        XCTAssertFalse(BotComputers.holdsThisMac(["vm"]))
        XCTAssertFalse(BotComputers.holdsThisMac([]))
        XCTAssertFalse(BotComputers.holdsThisMac(nil))
    }

    func testTheProfileRequestCarriesTheComputersAndNeverTheMacOnlyPolicy() throws {
        let patch = BotProfilePatch(
            computers: BotComputers.updated(current: ["local"], baseline: [], picks: ["cloud"]),
            cwd: .set("/Users/jay/Code/BotFleet")
        )
        let data = try JSONEncoder().encode(patch)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body.keys.sorted(), ["computers", "cwd"])
        XCTAssertEqual(body["computers"] as? [String], ["cloud", "local"])
        XCTAssertEqual(body["cwd"] as? String, "/Users/jay/Code/BotFleet")

        // The type has no way to say these, so a screen cannot ask for them
        // and have the whole save refused (companion/src/routes.ts).
        let everything = try JSONEncoder().encode(BotProfilePatch(
            name: "n", title: "t", description: "d", notifications: true,
            computers: ["cloud"], cwd: .clear
        ))
        let keys = try XCTUnwrap(JSONSerialization.jsonObject(with: everything) as? [String: Any]).keys
        for refused in ["autoApprove", "autoReview", "approvePeerComms"] {
            XCTAssertFalse(keys.contains(refused), refused)
        }
    }
}

/// A new room's first settings travel in the create request, so a refusal
/// leaves no half-made room (the New Room sheet used to create, then patch).
final class RoomCreateBodyTests: XCTestCase {
    func testABareRoomSendsWhatItAlwaysDid() {
        let body = CompanionClient.roomCreateBody(
            name: nil, memberIds: ["b1"], cwd: nil, bulletin: nil, defaultResponder: nil
        )
        XCTAssertEqual(body.keys.sorted(), ["memberIds"])
        XCTAssertEqual(body["memberIds"] as? [String], ["b1"])
        let blank = CompanionClient.roomCreateBody(
            name: "  ", memberIds: ["b1"], cwd: " \n", bulletin: "   ", defaultResponder: nil
        )
        XCTAssertEqual(blank.keys.sorted(), ["memberIds"])
    }

    func testFolderBulletinAndResponderRideInTheCreate() throws {
        let body = CompanionClient.roomCreateBody(
            name: "Planning",
            memberIds: ["b1", "b2"],
            cwd: "  /Users/jay/Code/BotFleet \n",
            bulletin: " Ship it ",
            defaultResponder: GroupResponder(kind: "member", botId: "b2")
        )
        XCTAssertEqual(body["name"] as? String, "Planning")
        XCTAssertEqual(body["cwd"] as? String, "/Users/jay/Code/BotFleet")
        XCTAssertEqual(body["bulletin"] as? String, "Ship it")
        let responder = try XCTUnwrap(body["defaultResponder"] as? [String: Any])
        XCTAssertEqual(responder["kind"] as? String, "member")
        XCTAssertEqual(responder["botId"] as? String, "b2")

        let mentions = CompanionClient.roomCreateBody(
            name: nil, memberIds: ["b1"], cwd: nil, bulletin: nil,
            defaultResponder: GroupResponder(kind: "mentions")
        )
        let mentionsResponder = try XCTUnwrap(mentions["defaultResponder"] as? [String: Any])
        XCTAssertEqual(mentionsResponder.keys.sorted(), ["kind"])
    }
}
