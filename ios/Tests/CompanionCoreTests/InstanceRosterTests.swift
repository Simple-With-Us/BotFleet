import XCTest
@testable import CompanionCore

/// The engine roster the phone holds is ordered by the harness's `describedAt`
/// stamp, and an engine that is "hidden" (an optional integration nobody has set
/// up) stays out of every list unless a saved selection points at it.
final class InstanceRosterTests: XCTestCase {
    /// An instance decoded the way it arrives on the wire.
    private func instance(
        _ id: String,
        driver: String = "claudeAgent",
        state: String = "available",
        hidden: Bool? = nil,
        transient: Bool? = nil,
        version: String? = nil
    ) throws -> Instance {
        var snapshot = #"{"state":"\#(state)""#
        if let hidden { snapshot += #","hidden":\#(hidden)"# }
        if let transient { snapshot += #","transient":\#(transient)"# }
        if let version { snapshot += #","version":"\#(version)""# }
        snapshot += "}"
        let json = """
        {"instanceId":"\(id)","driverKind":"\(driver)","displayName":"\(id)","enabled":true,
         "snapshot":\(snapshot),"models":{"default":"m","options":[]}}
        """
        return try JSONDecoder().decode(Instance.self, from: Data(json.utf8))
    }

    // MARK: - Decoding the stamp

    func testInstanceListDecodesDescribedAt() throws {
        let json = #"{"instances":[],"describedAt":1790000000123}"#
        let list = try JSONDecoder().decode(InstanceList.self, from: Data(json.utf8))
        XCTAssertEqual(list.describedAt, 1_790_000_000_123)
    }

    func testInstanceListFromAnOlderHarnessHasNoStamp() throws {
        let list = try JSONDecoder().decode(InstanceList.self, from: Data(#"{"instances":[]}"#.utf8))
        XCTAssertNil(list.describedAt)
    }

    func testInstancesFrameFromAnOlderHarnessHasNoStamp() throws {
        let json = #"{"kind":"instances","seq":4,"instances":[]}"#
        let frame = try JSONDecoder().decode(StreamFrame.self, from: Data(json.utf8))
        guard case let .instances(_, describedAt) = frame.frame else {
            return XCTFail("expected .instances, got \(frame.frame)")
        }
        XCTAssertNil(describedAt)
    }

    // MARK: - Ordering

    func testInstallsTheFirstStampedRoster() throws {
        var roster = InstanceRoster()
        XCTAssertTrue(roster.apply([try instance("claude")], describedAt: 5))
        XCTAssertEqual(roster.instances.map(\.instanceId), ["claude"])
        XCTAssertEqual(roster.describedAt, 5)
    }

    func testAFetchOlderThanAPushDoesNotReplaceIt() throws {
        var roster = InstanceRoster()
        // The push (a slow probe settling) lands first with the newer stamp...
        XCTAssertTrue(roster.apply([try instance("claude", version: "pushed")], describedAt: 10))
        // ...then a REST response that was already in flight answers with the older one.
        XCTAssertFalse(roster.apply([try instance("claude", state: "unavailable")], describedAt: 7))
        XCTAssertEqual(roster.instances.first?.snapshot.version, "pushed")
        XCTAssertTrue(roster.instances.first?.snapshot.isAvailable == true)
        XCTAssertEqual(roster.describedAt, 10)
    }

    func testAPushOlderThanAFetchDoesNotReplaceIt() throws {
        var roster = InstanceRoster()
        XCTAssertTrue(roster.apply([try instance("claude", version: "fetched")], describedAt: 10))
        XCTAssertFalse(roster.apply([try instance("claude", state: "unavailable")], describedAt: 9))
        XCTAssertEqual(roster.instances.first?.snapshot.version, "fetched")
    }

    func testANewerRosterReplacesTheHeldOne() throws {
        var roster = InstanceRoster()
        roster.apply([try instance("claude")], describedAt: 1)
        XCTAssertTrue(roster.apply([try instance("claude"), try instance("codex")], describedAt: 2))
        XCTAssertEqual(roster.instances.map(\.instanceId), ["claude", "codex"])
        XCTAssertEqual(roster.describedAt, 2)
    }

    func testTheSameCommitArrivingTwiceInstallsHarmlessly() throws {
        var roster = InstanceRoster()
        XCTAssertTrue(roster.apply([try instance("claude")], describedAt: 3))
        // REST and SSE both carry stamp 3: equal means the same commit, not an older one.
        XCTAssertTrue(roster.apply([try instance("claude")], describedAt: 3))
        XCTAssertEqual(roster.instances.map(\.instanceId), ["claude"])
    }

    func testAnUnstampedAnswerInstallsAndLeavesTheMarkAlone() throws {
        var roster = InstanceRoster()
        roster.apply([try instance("claude")], describedAt: 10)
        // A harness that predates the stamp has nothing to order by.
        XCTAssertTrue(roster.apply([try instance("codex")], describedAt: nil))
        XCTAssertEqual(roster.instances.map(\.instanceId), ["codex"])
        XCTAssertEqual(roster.describedAt, 10)
        XCTAssertFalse(roster.apply([try instance("claude")], describedAt: 9))
    }

    func testAnUnstampedHarnessIsAlwaysInstalled() throws {
        var roster = InstanceRoster()
        XCTAssertTrue(roster.apply([try instance("claude")], describedAt: nil))
        XCTAssertTrue(roster.apply([try instance("codex")], describedAt: nil))
        XCTAssertEqual(roster.instances.map(\.instanceId), ["codex"])
    }

    func testResetForgetsTheRosterAndTheMark() throws {
        var roster = InstanceRoster()
        roster.apply([try instance("claude")], describedAt: 1_790_000_000_000)
        roster.reset()
        XCTAssertTrue(roster.instances.isEmpty)
        // Another computer's stamps share nothing with the last one's.
        XCTAssertTrue(roster.apply([try instance("codex")], describedAt: 5))
        XCTAssertEqual(roster.instances.map(\.instanceId), ["codex"])
    }

    func testForgetOrderKeepsTheRosterButNotTheMark() throws {
        var roster = InstanceRoster()
        roster.apply([try instance("claude")], describedAt: 1_790_000_000_000)
        roster.forgetOrder()
        // The pickers keep their engines while the next roster is on its way...
        XCTAssertEqual(roster.instances.map(\.instanceId), ["claude"])
        // ...and a restarted harness, whose clock sits below the old process's
        // last stamp, is no longer judged against it.
        XCTAssertTrue(roster.apply([try instance("codex")], describedAt: 1_789_999_000_000))
        XCTAssertEqual(roster.instances.map(\.instanceId), ["codex"])
        // Ordering holds again from that stamp on.
        XCTAssertFalse(roster.apply([try instance("claude")], describedAt: 1_789_998_000_000))
        XCTAssertEqual(roster.instances.map(\.instanceId), ["codex"])
    }

    func testAFetchStartedBeforeTheOrderWasForgottenIsRefused() throws {
        var roster = InstanceRoster()
        roster.apply([try instance("claude")], describedAt: 1_790_000_000_000)
        // A fetch goes out, then the stream reconnects cold and forgets the order.
        let startedAt = roster.orderEpoch
        roster.forgetOrder()
        // The new process's clock sits below the old one's last stamp, and its
        // first answer lands.
        XCTAssertTrue(roster.apply([try instance("codex")], describedAt: 1_789_999_000_000))
        // The old process's answer, with the higher stamp, arrives afterwards.
        // Installed, it would put the mark back and shut the new process out.
        XCTAssertFalse(roster.apply([try instance("claude")], describedAt: 1_790_000_000_500, startedAt: startedAt))
        XCTAssertEqual(roster.instances.map(\.instanceId), ["codex"])
        XCTAssertEqual(roster.describedAt, 1_789_999_000_000)
        // The new process's next push still gets through.
        XCTAssertTrue(roster.apply([try instance("codex", version: "2")], describedAt: 1_789_999_000_100))
        XCTAssertEqual(roster.instances.first?.snapshot.version, "2")
    }

    func testARefusedStaleFetchDoesNotMoveTheMark() throws {
        var roster = InstanceRoster()
        roster.apply([try instance("claude")], describedAt: 10)
        let startedAt = roster.orderEpoch
        roster.forgetOrder()
        XCTAssertFalse(roster.apply([try instance("codex")], describedAt: 50, startedAt: startedAt))
        XCTAssertEqual(roster.describedAt, -.infinity)
        XCTAssertEqual(roster.instances.map(\.instanceId), ["claude"])
    }

    func testAFetchStartedAfterTheOrderWasForgottenIsInstalled() throws {
        var roster = InstanceRoster()
        roster.apply([try instance("claude")], describedAt: 1_790_000_000_000)
        roster.forgetOrder()
        let startedAt = roster.orderEpoch
        XCTAssertTrue(roster.apply([try instance("codex")], describedAt: 5, startedAt: startedAt))
        XCTAssertEqual(roster.instances.map(\.instanceId), ["codex"])
    }

    func testAFetchWithNoEpochIsOrderedByTheMarkAlone() throws {
        var roster = InstanceRoster()
        roster.apply([try instance("claude")], describedAt: 10)
        roster.forgetOrder()
        // A push carries no epoch: it comes over the live stream, never from before the reset.
        XCTAssertTrue(roster.apply([try instance("codex")], describedAt: 3))
        XCTAssertFalse(roster.apply([try instance("claude")], describedAt: 2))
    }

    func testResetAlsoRefusesAFetchThatWasOnTheWire() throws {
        var roster = InstanceRoster()
        roster.apply([try instance("claude")], describedAt: 10)
        let startedAt = roster.orderEpoch
        roster.reset()
        XCTAssertFalse(roster.apply([try instance("claude")], describedAt: 10, startedAt: startedAt))
        XCTAssertTrue(roster.instances.isEmpty)
    }

    func testAPushedFrameAndAFetchAreOrderedByTheSameMark() throws {
        var roster = InstanceRoster()
        let frameJSON = """
        {"kind":"instances","seq":9,"describedAt":20,"instances":[
          {"instanceId":"claude","driverKind":"claudeAgent","snapshot":{"state":"available"},
           "models":{"default":"m","options":[]}}]}
        """
        let frame = try JSONDecoder().decode(StreamFrame.self, from: Data(frameJSON.utf8))
        guard case let .instances(pushed, pushedAt) = frame.frame else {
            return XCTFail("expected .instances, got \(frame.frame)")
        }
        XCTAssertTrue(roster.apply(pushed, describedAt: pushedAt))
        let list = try JSONDecoder().decode(
            InstanceList.self,
            from: Data(#"{"instances":[],"describedAt":19}"#.utf8)
        )
        XCTAssertFalse(roster.apply(list.instances, describedAt: list.describedAt))
        XCTAssertEqual(roster.instances.map(\.instanceId), ["claude"])
    }

    func testDriverKindsResolveEverySavedSelectionIncludingAHiddenOne() throws {
        var roster = InstanceRoster()
        roster.apply(
            [
                try instance("claude"),
                try instance("computer", driver: "boxAgent", state: "unavailable", hidden: true),
            ],
            describedAt: 1
        )
        XCTAssertEqual(roster.driverKinds, ["claude": "claudeAgent", "computer": "boxAgent"])
    }

    // MARK: - Checking

    func testASlowProbeReadsAsCheckingNotUnavailable() throws {
        let slow = try instance("claude", state: "unavailable", transient: true)
        XCTAssertTrue(slow.snapshot.isChecking)
        XCTAssertEqual(slow.snapshot.engineStatusLabel, "Checking")
        // A real answer is never "Checking", and an older harness sends no flag.
        let answered = try instance("claude", state: "unavailable", transient: false)
        XCTAssertEqual(answered.snapshot.engineStatusLabel, "Unavailable")
        XCTAssertEqual(try instance("claude", state: "unavailable").snapshot.engineStatusLabel, "Unavailable")
        XCTAssertEqual(try instance("claude").snapshot.engineStatusLabel, "Ready")
    }

    // MARK: - Hidden engines

    func testAHiddenEngineIsNotListed() throws {
        let box = try instance("computer", driver: "boxAgent", state: "unavailable", hidden: true)
        XCTAssertFalse(box.isListed())
        XCTAssertFalse(box.isListed(keeping: ["claude"]))
    }

    func testAHiddenEngineASavedSelectionPointsAtStaysResolvable() throws {
        let box = try instance("computer", driver: "boxAgent", state: "unavailable", hidden: true)
        XCTAssertTrue(box.isListed(keeping: ["computer"]))
    }

    func testAnEngineThatIsNotHiddenIsAlwaysListed() throws {
        XCTAssertTrue(try instance("claude").isListed())
        XCTAssertTrue(try instance("kimi", state: "unavailable").isListed())
        XCTAssertTrue(try instance("claude", hidden: false).isListed())
    }

    func testListedKeepsOrderAndDropsOnlyUnreferencedHiddenEngines() throws {
        let all = [
            try instance("claude"),
            try instance("computer", driver: "boxAgent", state: "unavailable", hidden: true),
            try instance("codex"),
            try instance("other-box", driver: "boxAgent", state: "unavailable", hidden: true),
        ]
        XCTAssertEqual(all.listed().map(\.instanceId), ["claude", "codex"])
        XCTAssertEqual(all.listed(keeping: ["other-box"]).map(\.instanceId), ["claude", "codex", "other-box"])
        XCTAssertEqual(all.listed(keeping: ["computer", "other-box"]).map(\.instanceId), ["claude", "computer", "codex", "other-box"])
    }
}
