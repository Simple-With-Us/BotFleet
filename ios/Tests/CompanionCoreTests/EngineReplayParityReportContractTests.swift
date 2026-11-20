import Foundation
import Testing
@testable import CompanionCore

/// The Swift half of `Fixtures/replay-parity-report.json` (BF-2647).
///
/// `scripts/emit-replay-receipt.node-test.mjs` reads the same file and
/// checks it against the node `ReplayReportSchema` and `replayVerdict`.
/// The report is the one thing the replay probe writes and the node
/// decommission bundle reads, and until BF-2647 the types lived only inside
/// the probe executable, so the link between the two sides was that the key
/// names happened to match.  The types are public CompanionCore types now,
/// and this fixture is that link made a test:  renaming, removing or adding
/// a stored field on the Swift side fails here, and a change on the node
/// side that the fixture does not follow fails there.
///
/// The fixture is synthetic.  It carries no real replay run:  one measured
/// engine with a passing fixture and one engine no replay family drives,
/// whose failing verdict is what keeps the report-level flag false.  Nil
/// optionals are omitted rather than written as null, exactly as the probe
/// encodes them.
@Suite("Engine Replay Parity Report Contract (BF-2647)")
struct EngineReplayParityReportContractTests {
    private func fixtureData() throws -> Data {
        let url = try #require(
            Bundle.module.url(forResource: "replay-parity-report", withExtension: "json", subdirectory: "Fixtures")
                ?? Bundle.module.url(forResource: "replay-parity-report", withExtension: "json")
        )
        return try Data(contentsOf: url)
    }

    private func jsonObject(_ data: Data) throws -> [String: Any] {
        let value = try JSONSerialization.jsonObject(with: data)
        return try #require(value as? [String: Any])
    }

    @Test("The fixture decodes as the report the probe writes")
    func fixtureDecodesAsTheReport() throws {
        let report = try JSONDecoder().decode(EngineReplayParityReport.self, from: try fixtureData())
        #expect(report.version == 1)
        #expect(report.requestedEngines == ["claude", "dsh"])
        #expect(report.engines.count == 2)

        // The measured engine carried one fixture and it held.
        let measured = try #require(report.engines.first { $0.engineId == "claude" })
        #expect(measured.measured)
        #expect(measured.family == "claude")
        #expect(measured.unmeasuredReason == nil)
        #expect(measured.fixtureCount == 1)
        #expect(measured.passedCount == 1)
        #expect(measured.isFullyVerified)
        #expect(measured.fixtures.first?.passed == true)
        #expect(measured.fixtures.first?.eventsMatched == true)
        #expect(measured.fixtures.first?.spawnSpecMatched == true)
        #expect(measured.fixtures.first?.stdinGuardHeld == true)

        // The unmeasured engine resolved to no family and names the reason;
        // it is never certified and never skipped.
        let unmeasured = try #require(report.engines.first { $0.engineId == "dsh" })
        #expect(!unmeasured.measured)
        #expect(unmeasured.family == nil)
        #expect(unmeasured.unmeasuredReason != nil)
        #expect(!unmeasured.isFullyVerified)

        // The stored report-level flag agrees with the pure aggregation, and
        // the aggregation says false because one named engine did not hold.
        #expect(!report.isFullyVerified)
        #expect(!EngineReplayParityReport.aggregateFullyVerified(engines: report.engines))
        #expect(report.isFullyVerified == EngineReplayParityReport.aggregateFullyVerified(engines: report.engines))
    }

    @Test("A stored flag that disagrees with the engines' verdicts is detectable")
    func contradictoryStoredFlagIsDetectable() throws {
        // The probe writes the flag from the aggregation, so the golden
        // fixture agrees.  A report that claimed fully verified while an
        // engine failed would decode — Codable cannot know the rule — but the
        // comparison the contract tests make must catch it on both sides.
        // The flag is flipped on the parsed object, not on fixture bytes, so
        // the test survives any reformat of the fixture.
        var driftedObject = try jsonObject(try fixtureData())
        driftedObject["isFullyVerified"] = true
        let drifted = try JSONSerialization.data(withJSONObject: driftedObject)
        let report = try JSONDecoder().decode(EngineReplayParityReport.self, from: drifted)
        #expect(report.isFullyVerified)
        #expect(report.isFullyVerified != EngineReplayParityReport.aggregateFullyVerified(engines: report.engines))
    }

    @Test("The aggregation is computed out of the engines' own verdicts")
    func aggregationComesFromTheEngines() {
        let held = EngineReplayReport(
            engineId: "claude", family: "claude", measured: true, unmeasuredReason: nil,
            fixtureCount: 1, passedCount: 1, fixtures: [], isFullyVerified: true
        )
        let unmeasured = EngineReplayReport(
            engineId: "dsh", family: nil, measured: false, unmeasuredReason: "no replay family drives this engine",
            fixtureCount: 0, passedCount: 0, fixtures: [], isFullyVerified: false
        )
        #expect(EngineReplayParityReport.aggregateFullyVerified(engines: [held]))
        #expect(!EngineReplayParityReport.aggregateFullyVerified(engines: [held, unmeasured]))
    }

    @Test("A report missing a stored field does not decode")
    func reportMissingAStoredFieldDoesNotDecode() throws {
        var object = try jsonObject(try fixtureData())
        let removed = object.removeValue(forKey: "requestedEngines")
        #expect(removed != nil)
        let stripped = try JSONSerialization.data(withJSONObject: object)
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(EngineReplayParityReport.self, from: stripped)
        }
    }

    @Test("The encoded report has exactly the fixture's keys, with nils omitted")
    func encodedKeysMatchTheFixture() throws {
        let fixture = try jsonObject(try fixtureData())
        let report = try JSONDecoder().decode(EngineReplayParityReport.self, from: try fixtureData())
        let encoded = try jsonObject(try JSONEncoder().encode(report))

        let encodedKeys = Set(encoded.keys)
        let fixtureKeys = Set(fixture.keys)
        #expect(
            encodedKeys == fixtureKeys,
            "encoded-only keys: \(encodedKeys.subtracting(fixtureKeys).sorted()), fixture-only keys: \(fixtureKeys.subtracting(encodedKeys).sorted())"
        )

        // The nil optionals are omitted, not written as null:  the measured
        // engine carries no `unmeasuredReason` key and the unmeasured one
        // carries no `family` key, exactly as the fixture shows.
        let fixtureEngines = try #require(fixture["engines"] as? [[String: Any]])
        let encodedEngines = try #require(encoded["engines"] as? [[String: Any]])
        #expect(encodedEngines.count == fixtureEngines.count)
        for (index, entry) in encodedEngines.enumerated() {
            let entryKeys = Set(entry.keys)
            let fixtureEngineKeys = Set(fixtureEngines[index].keys)
            #expect(
                entryKeys == fixtureEngineKeys,
                "engine \(index) encoded-only keys: \(entryKeys.subtracting(fixtureEngineKeys).sorted()), fixture-only keys: \(fixtureEngineKeys.subtracting(entryKeys).sorted())"
            )
            // The nested per-fixture payloads are pinned the same way:
            // `EngineReplayOutcome` carries optional stored fields, and a key
            // renamed or dropped there must fail this test rather than drift.
            // `zip` bounds the iteration, so a count mismatch surfaces as the
            // failed expectation above instead of an index trap.
            let fixtureFixtures = try #require(fixtureEngines[index]["fixtures"] as? [[String: Any]])
            let encodedFixtures = try #require(entry["fixtures"] as? [[String: Any]])
            #expect(encodedFixtures.count == fixtureFixtures.count)
            for (fixtureIndex, (encodedOutcome, fixtureOutcome)) in zip(encodedFixtures, fixtureFixtures).enumerated() {
                let outcomeKeys = Set(encodedOutcome.keys)
                let fixtureOutcomeKeys = Set(fixtureOutcome.keys)
                #expect(
                    outcomeKeys == fixtureOutcomeKeys,
                    "engine \(index) fixture \(fixtureIndex) encoded-only keys: \(outcomeKeys.subtracting(fixtureOutcomeKeys).sorted()), fixture-only keys: \(fixtureOutcomeKeys.subtracting(outcomeKeys).sorted())"
                )
            }
        }
        #expect(encodedEngines[0].keys.contains("family") && !encodedEngines[0].keys.contains("unmeasuredReason"))
        #expect(encodedEngines[1].keys.contains("unmeasuredReason") && !encodedEngines[1].keys.contains("family"))
    }

    @Test("A renamed key on the Swift side fails the decode instead of drifting")
    func renamedKeyFailsTheDecode() throws {
        let drifted = String(data: try fixtureData(), encoding: .utf8)!
            .replacingOccurrences(of: "\"engineId\"", with: "\"engine_id\"")
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(EngineReplayParityReport.self, from: Data(drifted.utf8))
        }
    }
}
