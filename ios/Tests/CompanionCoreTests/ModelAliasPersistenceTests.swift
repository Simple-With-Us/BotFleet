import XCTest
@testable import CompanionCore

final class ModelAliasPersistenceTests: XCTestCase {
    func testModelSelectionEncodesAndDecodesLatestField() throws {
        let original = ModelSelection(
            instanceId: "cursor",
            model: "composer-2.5",
            effort: nil,
            latest: "composer",
            fallbacks: [
                ModelSelection(instanceId: "claude", model: "claude-sonnet-4.6", latest: "sonnet")
            ]
        )

        let data = try JSONEncoder().encode(original)
        let jsonObject = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(jsonObject["latest"] as? String, "composer")

        let fallbacksJson = try XCTUnwrap(jsonObject["fallbacks"] as? [[String: Any]])
        XCTAssertEqual(fallbacksJson.first?["latest"] as? String, "sonnet")

        let decoded = try JSONDecoder().decode(ModelSelection.self, from: data)
        XCTAssertEqual(decoded, original)
        XCTAssertEqual(decoded.latest, "composer")
        XCTAssertEqual(decoded.fallbacks?.first?.latest, "sonnet")
    }

    func testModelSelectionExtractsAliasFromLegacyModelString() throws {
        let legacyJson = """
        {
            "instanceId": "cursor",
            "model": "Latest Composer"
        }
        """
        let decoded = try JSONDecoder().decode(ModelSelection.self, from: Data(legacyJson.utf8))
        XCTAssertEqual(decoded.latest, "composer")
        XCTAssertEqual(decoded.model, "Latest Composer")

        let hyphenJson = """
        {
            "instanceId": "claude",
            "model": "latest-sonnet"
        }
        """
        let decodedHyphen = try JSONDecoder().decode(ModelSelection.self, from: Data(hyphenJson.utf8))
        XCTAssertEqual(decodedHyphen.latest, "sonnet")
    }

    func testLatestOptionsForCursorAndClaude() {
        let cursorInstance = Instance(
            instanceId: "cursor-1",
            name: "Cursor",
            driverKind: "cursorAgent",
            models: InstanceModels(
                default: "composer-2.5",
                options: [
                    ModelOption(id: "composer-1.5", label: "Composer 1.5"),
                    ModelOption(id: "composer-2.5", label: "Composer 2.5")
                ]
            )
        )

        let cursorOpts = ModelLineage.latestOptions(for: cursorInstance)
        XCTAssertEqual(cursorOpts.count, 1)
        XCTAssertEqual(cursorOpts.first?.classKey, "composer")
        XCTAssertEqual(cursorOpts.first?.label, "Latest Composer")
        XCTAssertEqual(cursorOpts.first?.resolvedId, "composer-2.5")

        let claudeInstance = Instance(
            instanceId: "claude-1",
            name: "Claude",
            driverKind: "claudeAgent",
            models: InstanceModels(
                default: "claude-sonnet-4.6",
                options: [
                    ModelOption(id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5"),
                    ModelOption(id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6"),
                    ModelOption(id: "claude-opus-4.1", label: "Claude Opus 4.1")
                ]
            )
        )

        let claudeOpts = ModelLineage.latestOptions(for: claudeInstance)
        let sonnetOpt = claudeOpts.first(where: { $0.classKey == "sonnet" })
        XCTAssertNotNil(sonnetOpt)
        XCTAssertEqual(sonnetOpt?.label, "Latest Sonnet")
        XCTAssertEqual(sonnetOpt?.resolvedId, "claude-sonnet-4.6")
    }

    func testDisplayLabelMatchesWebFormat() {
        let cursorInstance = Instance(
            instanceId: "cursor",
            name: "Cursor",
            driverKind: "cursorAgent",
            models: InstanceModels(
                default: "composer-2.5",
                options: [
                    ModelOption(id: "composer-1.5", label: "Composer 1.5"),
                    ModelOption(id: "composer-2.5", label: "Composer 2.5")
                ]
            )
        )

        let selectionWithLatest = ModelSelection(
            instanceId: "cursor",
            model: "composer-2.5",
            latest: "composer"
        )
        let label = ModelLineage.displayLabel(selection: selectionWithLatest, instance: cursorInstance)
        XCTAssertEqual(label, "Latest Composer \u{00B7} composer-2.5")

        let concreteSelection = ModelSelection(
            instanceId: "cursor",
            model: "composer-2.5",
            latest: nil
        )
        let concreteLabel = ModelLineage.displayLabel(selection: concreteSelection, instance: cursorInstance)
        XCTAssertEqual(concreteLabel, "Composer 2.5")
    }

    func testSimulatedPickerReopeningPreservesLatest() {
        // Initial state when user previously picked Latest Composer
        let savedSelection = ModelSelection(
            instanceId: "cursor",
            model: "composer-2.5",
            latest: "composer"
        )

        // Simulate sheet/picker init: it derives latest from initial.latest ?? detectAlias
        let pickerInitialLatest = savedSelection.latest ?? ModelLineage.detectAlias(from: savedSelection.model)
        XCTAssertEqual(pickerInitialLatest, "composer", "Picker must initialize its floating state without snapping to concrete model")

        // In the picker tag binding: if latest is present, tag is 'latest:composer'
        let pickerTag = (pickerInitialLatest != nil && !pickerInitialLatest!.isEmpty)
            ? "latest:\(pickerInitialLatest!)"
            : savedSelection.model
        XCTAssertEqual(pickerTag, "latest:composer", "Picker selection binding must select the Latest section item")
    }

    func testAppRestartPersistenceAcrossSerialization() throws {
        // Bot saved with latest alias
        let originalBot = try JSONDecoder().decode(Bot.self, from: Data("""
        {
            "id": "bot-test",
            "threadId": "main",
            "name": "Builder",
            "title": "",
            "description": "",
            "notifications": true,
            "color": "green",
            "unread": false,
            "createdAt": 1000,
            "modelSelection": {
                "instanceId": "cursor",
                "model": "composer-2.5",
                "latest": "composer"
            }
        }
        """.utf8))

        XCTAssertEqual(originalBot.modelSelection.latest, "composer")

        // Simulate app shutdown: write to disk / SQLite database raw JSON
        let storedData = try JSONEncoder().encode(originalBot)

        // Simulate app restart: reload from storage
        let restoredBot = try JSONDecoder().decode(Bot.self, from: storedData)
        XCTAssertEqual(restoredBot.modelSelection.latest, "composer")
        XCTAssertEqual(restoredBot.modelSelection.model, "composer-2.5")
    }

    func testFleetModelsWithPrimaryAndFallbackPreservesLatest() {
        let base = ModelSelection(instanceId: "cursor", model: "composer-1.5")

        let withPrimaryLatest = FleetModels.withPrimary(
            base,
            instanceId: "cursor",
            model: "composer-2.5",
            latest: "composer",
            effortLevels: nil
        )
        XCTAssertEqual(withPrimaryLatest.latest, "composer")
        XCTAssertEqual(withPrimaryLatest.model, "composer-2.5")

        let baseWithFallbacks = ModelSelection(
            instanceId: "cursor",
            model: "composer-2.5",
            latest: "composer",
            fallbacks: [ModelSelection(instanceId: "claude", model: "claude-haiku-4-5")]
        )

        let withFallbackLatest = FleetModels.withFallback(
            baseWithFallbacks,
            at: 0,
            instanceId: "claude",
            model: "claude-sonnet-4.6",
            latest: "sonnet",
            effortLevels: nil
        )
        XCTAssertEqual(withFallbackLatest.fallbacks?.first?.latest, "sonnet")
        XCTAssertEqual(withFallbackLatest.fallbacks?.first?.model, "claude-sonnet-4.6")
    }
}
