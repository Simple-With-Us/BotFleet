import Foundation
import XCTest
@testable import CompanionCore

/// The Models screen's pure rules: the Apply to All Bots body, the per-bot
/// fallback places, the engine chips and the filter.  Mirrors
/// `src/lib/default-model-slots.ts` and `shared/model-limits.ts`.
final class DefaultModelSlotsTests: XCTestCase {
    private let sonnet = DefaultModelSlot(instanceId: "claude", model: "claude-sonnet-4-6")
    private let gpt = DefaultModelSlot(instanceId: "codex", model: "gpt-5.5")

    private func body(_ value: ApplyModelDefaultsBody) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func slotsObject(_ value: ApplyModelDefaultsBody) throws -> [String: Any] {
        try XCTUnwrap(try body(value)["slots"] as? [String: Any])
    }

    // MARK: - Body

    func testPrimaryOnlyBodyHasNullFallbackPlaces() throws {
        let value = DefaultModelSlots.applyModelDefaultsBody(
            primary: sonnet,
            fallbacks: DefaultModelSlots.emptyFallbacks()
        )
        let root = try body(value)
        XCTAssertEqual(root.keys.sorted(), ["slots"], "the sidecar refuses unknown top-level keys")
        let slots = try slotsObject(value)
        XCTAssertEqual(slots.keys.sorted(), ["fallbacks", "primary"])
        let primary = try XCTUnwrap(slots["primary"] as? [String: Any])
        XCTAssertEqual(primary["instanceId"] as? String, "claude")
        XCTAssertEqual(primary["model"] as? String, "claude-sonnet-4-6")
        XCTAssertNil(primary["latest"], "a pinned slot sends no latest")
        let fallbacks = try XCTUnwrap(slots["fallbacks"] as? [Any])
        XCTAssertEqual(fallbacks.count, 3)
        XCTAssertTrue(fallbacks.allSatisfy { $0 is NSNull })
    }

    func testFallbackTwoOnlyKeepsPlacesOneAndThreeNull() throws {
        let fallbacks = DefaultModelSlots.withSlot(DefaultModelSlots.emptyFallbacks(), at: 1, gpt)
        let value = DefaultModelSlots.applyModelDefaultsBody(primary: nil, fallbacks: fallbacks)
        let slots = try slotsObject(value)
        XCTAssertTrue(slots["primary"] is NSNull, "an empty primary is an explicit null")
        let places = try XCTUnwrap(slots["fallbacks"] as? [Any])
        XCTAssertEqual(places.count, 3)
        XCTAssertTrue(places[0] is NSNull)
        XCTAssertEqual((places[1] as? [String: Any])?["model"] as? String, "gpt-5.5")
        XCTAssertTrue(places[2] is NSNull)
    }

    func testBodyAlwaysCarriesExactlyThreePlaces() throws {
        let short = DefaultModelSlots.applyModelDefaultsBody(primary: sonnet, fallbacks: [gpt])
        let shortPlaces = try XCTUnwrap(try slotsObject(short)["fallbacks"] as? [Any])
        XCTAssertEqual(shortPlaces.count, 3)
        XCTAssertEqual((shortPlaces[0] as? [String: Any])?["instanceId"] as? String, "codex")
        XCTAssertTrue(shortPlaces[1] is NSNull)

        let long = DefaultModelSlots.applyModelDefaultsBody(primary: nil, fallbacks: [gpt, gpt, gpt, sonnet])
        XCTAssertEqual(long.fallbacks.count, 3, "never more places than the cap")
        let longPlaces = try XCTUnwrap(try slotsObject(long)["fallbacks"] as? [Any])
        XCTAssertEqual(longPlaces.count, 3)
    }

    func testFloatingLatestIsCarriedAndEffortAndFallbacksAreStripped() throws {
        let floating = DefaultModelSlot(instanceId: "claude", model: "claude-sonnet-4-6", latest: "sonnet")
        let slots = try slotsObject(DefaultModelSlots.applyModelDefaultsBody(primary: floating, fallbacks: []))
        let primary = try XCTUnwrap(slots["primary"] as? [String: Any])
        XCTAssertEqual(primary["latest"] as? String, "sonnet")

        let pick = ModelSelection(
            instanceId: "codex",
            model: "gpt-5.5",
            effort: "high",
            fallbacks: [ModelSelection(instanceId: "claude", model: "claude-haiku-4-5")]
        )
        let slot = DefaultModelSlots.slotFromPick(pick)
        XCTAssertEqual(slot, DefaultModelSlot(instanceId: "codex", model: "gpt-5.5"))
        let picked = try slotsObject(DefaultModelSlots.applyModelDefaultsBody(primary: slot, fallbacks: []))
        let encoded = try XCTUnwrap(picked["primary"] as? [String: Any])
        XCTAssertEqual(encoded.keys.sorted(), ["instanceId", "model"], "never effort or fallbacks")
    }

    func testWithSlotIgnoresOutOfRangePlaces() {
        let empty = DefaultModelSlots.emptyFallbacks()
        XCTAssertEqual(empty.count, 3)
        XCTAssertEqual(DefaultModelSlots.withSlot(empty, at: 3, gpt), empty)
        XCTAssertEqual(DefaultModelSlots.withSlot(empty, at: -1, gpt), empty)
        let set = DefaultModelSlots.withSlot(empty, at: 2, gpt)
        XCTAssertEqual(set, [nil, nil, gpt])
        XCTAssertEqual(DefaultModelSlots.withSlot(set, at: 2, nil), empty)
    }

    func testHasDefaults() {
        let empty = DefaultModelSlots.emptyFallbacks()
        XCTAssertFalse(DefaultModelSlots.hasDefaults(primary: nil, fallbacks: empty))
        XCTAssertTrue(DefaultModelSlots.hasDefaults(primary: sonnet, fallbacks: empty))
        XCTAssertTrue(DefaultModelSlots.hasDefaults(
            primary: nil,
            fallbacks: DefaultModelSlots.withSlot(empty, at: 2, gpt)
        ))
    }

    // MARK: - Result

    func testResultDecodesSkippedAndItsSummary() throws {
        let data = Data(#"""
        {"ok":true,"applied":2,"skipped":[
          {"id":"b1","name":"Ada","reason":"busy"},
          {"id":"b2","name":"Grace","reason":"Fallback 1 is empty, so Fallback 2 cannot be set"}
        ]}
        """#.utf8)
        let result = try JSONDecoder().decode(ApplyModelDefaultsResult.self, from: data)
        XCTAssertEqual(result.applied, 2)
        XCTAssertEqual(result.skipped.map(\.id), ["b1", "b2"])
        XCTAssertEqual(
            result.skippedSummary,
            "Still on their own model: Ada (busy), Grace (Fallback 1 is empty, so Fallback 2 cannot be set)."
        )
    }

    func testResultToleratesMissingSkipped() throws {
        let result = try JSONDecoder().decode(
            ApplyModelDefaultsResult.self,
            from: Data(#"{"ok":true,"applied":4}"#.utf8)
        )
        XCTAssertEqual(result, ApplyModelDefaultsResult(applied: 4))
        XCTAssertNil(result.skippedSummary)
    }

    // MARK: - Fallback places

    func testFallbackPlacesOfferOnlyTheNextEmptyPlaceUnderTheCap() {
        XCTAssertEqual(FleetModels.fallbackPlaces(stored: 0), [.add(0)])
        XCTAssertEqual(FleetModels.fallbackPlaces(stored: 1), [.stored(0), .add(1)])
        XCTAssertEqual(FleetModels.fallbackPlaces(stored: 2), [.stored(0), .stored(1), .add(2)])
        XCTAssertEqual(FleetModels.fallbackPlaces(stored: 3), [.stored(0), .stored(1), .stored(2)])
    }

    func testFallbackPlacesNeverHideAChainOverTheCap() {
        XCTAssertEqual(ModelLimits.fallbackSlotCount(stored: 5), 5)
        XCTAssertEqual(ModelLimits.fallbackSlotCount(stored: 1), 3)
        XCTAssertFalse(ModelLimits.canAddFallback(stored: 4))
        XCTAssertEqual(
            FleetModels.fallbackPlaces(stored: 4),
            [.stored(0), .stored(1), .stored(2), .stored(3)]
        )
    }

    // MARK: - Per-bot edits

    func testWithPrimaryKeepsFallbacksAndOnlyASupportedEffort() {
        let chain = [ModelSelection(instanceId: "codex", model: "gpt-5.5")]
        let selection = ModelSelection(instanceId: "claude", model: "claude-opus-4-1", effort: "high", fallbacks: chain)

        let kept = FleetModels.withPrimary(selection, instanceId: "claude", model: "claude-sonnet-4-6", effortLevels: ["low", "high"])
        XCTAssertEqual(kept.model, "claude-sonnet-4-6")
        XCTAssertEqual(kept.effort, "high")
        XCTAssertEqual(kept.fallbacks, chain)

        let dropped = FleetModels.withPrimary(selection, instanceId: "claude", model: "claude-haiku-4-5", effortLevels: [])
        XCTAssertNil(dropped.effort)
        XCTAssertEqual(dropped.fallbacks, chain)

        let unknown = FleetModels.withPrimary(selection, instanceId: "mystery", model: "m", effortLevels: nil)
        XCTAssertEqual(unknown.effort, "high", "an engine this phone cannot see leaves the effort alone")
    }

    func testFallbackEditsAddChangeAndRemoveInPlace() throws {
        let base = ModelSelection(instanceId: "claude", model: "claude-sonnet-4-6", effort: "high")

        let one = try XCTUnwrap(FleetModels.addingFallback(base))
        XCTAssertEqual(one.fallbacks, [ModelSelection(instanceId: "claude", model: "claude-sonnet-4-6")],
                       "seeded from the primary, without its effort")
        XCTAssertEqual(one.effort, "high")

        let two = try XCTUnwrap(FleetModels.addingFallback(one))
        let changed = FleetModels.withFallback(two, at: 1, instanceId: "codex", model: "gpt-5.5", effortLevels: nil)
        XCTAssertEqual(changed.fallbacks?.map(\.model), ["claude-sonnet-4-6", "gpt-5.5"])
        XCTAssertEqual(FleetModels.withFallback(two, at: 5, instanceId: "x", model: "y", effortLevels: nil), two)

        let removed = FleetModels.removingFallback(changed, at: 0)
        XCTAssertEqual(removed.fallbacks?.map(\.model), ["gpt-5.5"])
        let none = FleetModels.removingFallback(removed, at: 0)
        XCTAssertEqual(none.fallbacks, [], "removing the last sends an empty list")

        var full = base
        full.fallbacks = Array(repeating: ModelSelection(instanceId: "codex", model: "gpt-5.5"), count: 3)
        XCTAssertNil(FleetModels.addingFallback(full))
    }

    // MARK: - Bots

    private func bot(
        _ id: String,
        name: String,
        title: String = "",
        instanceId: String,
        model: String,
        fallbackModels: [String] = [],
        hidden: Bool? = nil
    ) throws -> Bot {
        var object: [String: Any] = [
            "id": id,
            "threadId": "t-\(id)",
            "name": name,
            "title": title,
            "description": "",
            "notifications": true,
            "color": "blue",
            "unread": false,
            "createdAt": 1,
            "modelSelection": [
                "instanceId": instanceId,
                "model": model,
                "fallbacks": fallbackModels.map { ["instanceId": "codex", "model": $0] },
            ] as [String: Any],
        ]
        if let hidden { object["hidden"] = hidden }
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(Bot.self, from: data)
    }

    func testEngineSpreadCountsListedBotsMostFirstWithStableTies() throws {
        let bots = [
            try bot("a", name: "A", instanceId: "codex", model: "gpt-5.5"),
            try bot("b", name: "B", instanceId: "claude", model: "claude-sonnet-4-6"),
            try bot("c", name: "C", instanceId: "claude", model: "claude-opus-4-1"),
            try bot("d", name: "D", instanceId: "grok", model: "grok-4"),
            try bot("e", name: "E", instanceId: "grok", model: "grok-4", hidden: true),
        ]
        XCTAssertEqual(FleetModels.engineSpread(bots), [
            FleetModels.EngineCount(instanceId: "claude", count: 2),
            FleetModels.EngineCount(instanceId: "codex", count: 1),
            FleetModels.EngineCount(instanceId: "grok", count: 1),
        ])
    }

    func testFilterMatchesNameTitleAndModelsAndSkipsHiddenBots() throws {
        let bots = [
            try bot("a", name: "Ada", title: "Research", instanceId: "claude", model: "claude-sonnet-4-6"),
            try bot("b", name: "Grace", instanceId: "codex", model: "gpt-5.5", fallbackModels: ["o4-mini"]),
            try bot("c", name: "Archived", instanceId: "claude", model: "claude-sonnet-4-6", hidden: true),
        ]
        XCTAssertEqual(FleetModels.filteredBots(bots, query: "").map(\.id), ["a", "b"])
        XCTAssertEqual(FleetModels.filteredBots(bots, query: "  ada ").map(\.id), ["a"])
        XCTAssertEqual(FleetModels.filteredBots(bots, query: "RESEARCH").map(\.id), ["a"])
        XCTAssertEqual(FleetModels.filteredBots(bots, query: "sonnet").map(\.id), ["a"])
        XCTAssertEqual(FleetModels.filteredBots(bots, query: "o4-mini").map(\.id), ["b"])
        XCTAssertEqual(FleetModels.filteredBots(bots, query: "archived").map(\.id), [])
        XCTAssertEqual(FleetModels.standIn(bots)?.id, "a")
        XCTAssertNil(FleetModels.standIn([try bot("z", name: "Z", instanceId: "c", model: "m", hidden: true)]))
    }

    // MARK: - Engines

    private func instances(_ json: String) throws -> [Instance] {
        try JSONDecoder().decode([Instance].self, from: Data(json.utf8))
    }

    func testChoosableEnginesMirrorTheProfilePicker() throws {
        let roster = try instances(#"""
        [
          {"instanceId":"claude","driverKind":"claude","snapshot":{"state":"available"},"models":{"default":"s","options":[{"id":"s","label":"Sonnet"}]}},
          {"instanceId":"codex","driverKind":"codex","snapshot":{"state":"unavailable"},"models":{"default":"g","options":[{"id":"g","label":"GPT"}]}},
          {"instanceId":"box","driverKind":"boxAgent","snapshot":{"state":"available","hidden":true},"models":{"default":"b","options":[]}},
          {"instanceId":"deepseek","driverKind":"deepseek","snapshot":{"state":"available"},"models":{"default":"d","options":[]}},
          {"instanceId":"off","driverKind":"grok","snapshot":{"state":"available","reason":"Disabled in settings"},"models":{"default":"o","options":[]}}
        ]
        """#)
        XCTAssertEqual(FleetModels.choosableEngines(roster, keeping: nil).map(\.instanceId), ["claude"])
        XCTAssertEqual(
            FleetModels.choosableEngines(roster, keeping: "codex").map(\.instanceId),
            ["claude", "codex"],
            "the engine a place already uses stays offered"
        )
        XCTAssertEqual(FleetModels.choosableEngines(roster, keeping: "deepseek").map(\.instanceId), ["claude", "deepseek"])

        let nothingReady = try instances(#"""
        [{"instanceId":"codex","driverKind":"codex","snapshot":{"state":"unavailable"},"models":{"default":"g","options":[]}}]
        """#)
        XCTAssertEqual(
            FleetModels.choosableEngines(nothingReady, keeping: nil).map(\.instanceId),
            ["codex"],
            "never an empty picker while the computer lists engines"
        )
    }
}
