import Foundation
import Testing
@testable import CompanionCore

/// The Swift half of `Fixtures/import-parity-report.json` (BF-2648).
///
/// `scripts/archive-node-store.node-test.mjs` reads the same file and checks
/// it against the node `ImportParityReportSchema` and `importParityVerdict`.
/// The report is the one thing the Swift importer writes and the node
/// decommission bundle reads, and the only link between the two sides was that
/// the key names happen to match.  This fixture is that link made a test:
/// renaming, removing or adding a stored field on `StoreImportParityReport`
/// (or on `RoutineRequestReceiptRecord`) fails here, and a change on the node
/// side that the fixture does not follow fails there.
///
/// The fixture is synthetic.  It carries no store data and no real report.
/// The two verdict keys are not part of the Codable encoding, because
/// `isParityVerified` and `isFullyVerified` are computed.
/// `Scripts/StoreImportParityProbe/main.swift` adds them to the object it
/// writes, so the fixture carries them and the stored-field key set is the
/// fixture's keys minus those two.
@Suite("Store Import Parity Report Contract (BF-2648)")
struct StoreImportParityReportContractTests {
    private static let verdictKeys: Set<String> = ["isParityVerified", "isFullyVerified"]

    private func fixtureData() throws -> Data {
        let url = try #require(
            Bundle.module.url(forResource: "import-parity-report", withExtension: "json", subdirectory: "Fixtures")
                ?? Bundle.module.url(forResource: "import-parity-report", withExtension: "json")
        )
        return try Data(contentsOf: url)
    }

    private func jsonObject(_ data: Data) throws -> [String: Any] {
        let value = try JSONSerialization.jsonObject(with: data)
        return try #require(value as? [String: Any])
    }

    @Test("The fixture decodes as the report the importer produces")
    func fixtureDecodesAsTheReport() throws {
        let report = try JSONDecoder().decode(StoreImportParityReport.self, from: try fixtureData())
        #expect(report.sourceMessageCount == 2048)
        #expect(report.targetMessageCount == 2048)
        #expect(report.sourceMessageMetadataDroppedCount == 0)
        #expect(report.sourceMessageMetadataPreservedFields == ["parentId", "reactions"])
        #expect(report.sourceBodyDigestSHA256 == report.targetBodyDigestSHA256)
        #expect(report.sourceBodyDigestSHA256.count == 64)
        #expect(report.mismatches.isEmpty)
        #expect(report.warnings.isEmpty)
        #expect(report.routineRequestReceipts.count == 1)
        let receipt = try #require(report.routineRequestReceipts.first)
        #expect(receipt.requestId == "req-synthetic-0001")
        #expect(receipt.fingerprintVersion == 1)
        #expect(receipt.appliedAt == 1_760_000_000_000)
    }

    @Test("A report missing a stored field does not decode")
    func reportMissingAStoredFieldDoesNotDecode() throws {
        var object = try jsonObject(try fixtureData())
        let removed = object.removeValue(forKey: "targetBodyDigestSHA256")
        #expect(removed != nil)
        let stripped = try JSONSerialization.data(withJSONObject: object)
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(StoreImportParityReport.self, from: stripped)
        }
    }

    @Test("The fixture's own verdict flags are the ones the decoded report computes")
    func verdictFlagsAgreeWithTheFixture() throws {
        let data = try fixtureData()
        let fixture = try jsonObject(data)
        let report = try JSONDecoder().decode(StoreImportParityReport.self, from: data)
        #expect(report.isParityVerified)
        #expect(report.isFullyVerified)
        #expect((fixture["isParityVerified"] as? Bool) == report.isParityVerified)
        #expect((fixture["isFullyVerified"] as? Bool) == report.isFullyVerified)
    }

    @Test("The encoded report has exactly the fixture's stored-field keys")
    func encodedKeysMatchTheFixture() throws {
        let data = try fixtureData()
        let fixture = try jsonObject(data)
        let report = try JSONDecoder().decode(StoreImportParityReport.self, from: data)
        let encoded = try jsonObject(try JSONEncoder().encode(report))

        let expectedKeys = Set(fixture.keys).subtracting(Self.verdictKeys)
        let encodedKeys = Set(encoded.keys)
        #expect(
            encodedKeys == expectedKeys,
            "encoded-only keys: \(encodedKeys.subtracting(expectedKeys).sorted()), fixture-only keys: \(expectedKeys.subtracting(encodedKeys).sorted())"
        )
        // The two verdict keys are the probe's, and the fixture has to carry both.
        #expect(Set(fixture.keys).isSuperset(of: Self.verdictKeys))
        #expect(expectedKeys.count == 30)
    }

    @Test("The encoded receipt has exactly the fixture's receipt keys")
    func encodedReceiptKeysMatchTheFixture() throws {
        let data = try fixtureData()
        let fixture = try jsonObject(data)
        let report = try JSONDecoder().decode(StoreImportParityReport.self, from: data)
        let encoded = try jsonObject(try JSONEncoder().encode(report))

        let fixtureReceipts = try #require(fixture["routineRequestReceipts"] as? [[String: Any]])
        let encodedReceipts = try #require(encoded["routineRequestReceipts"] as? [[String: Any]])
        let fixtureReceipt = try #require(fixtureReceipts.first)
        let encodedReceipt = try #require(encodedReceipts.first)
        let fixtureKeys = Set(fixtureReceipt.keys)
        let encodedKeys = Set(encodedReceipt.keys)
        #expect(
            encodedKeys == fixtureKeys,
            "encoded-only keys: \(encodedKeys.subtracting(fixtureKeys).sorted()), fixture-only keys: \(fixtureKeys.subtracting(encodedKeys).sorted())"
        )
        #expect(fixtureKeys.count == 9)
    }
}
