import XCTest
@testable import CompanionCore

/// The remote engine whose turns run on box.ascii.dev is named for where it
/// runs.  It used to be called "Computer", which read as a generic word for the
/// machine in your hand.
final class EngineDisplayNameTests: XCTestCase {
    func testBoxEngineFallbackNameIsAsciiDevBox() throws {
        // An older Mac-side harness ships no displayName; the phone names the
        // engine from its driver kind.
        let instance = try decodeInstance(#"{"instanceId":"computer","driverKind":"boxAgent"}"#)
        XCTAssertEqual(instance.settingsDisplayName, "ASCII.dev Box")
    }

    func testBoxEngineUsesTheMacSideNameWhenThereIsOne() throws {
        let instance = try decodeInstance(
            #"{"instanceId":"computer","driverKind":"boxAgent","displayName":"ASCII.dev Box"}"#
        )
        XCTAssertEqual(instance.settingsDisplayName, "ASCII.dev Box")
    }

    private func decodeInstance(_ fields: String) throws -> Instance {
        // Every field but the two under test is boilerplate the decoder needs.
        let open = fields.dropLast()
        let json = """
        {"instances":[\(open),
          "snapshot":{"state":"available"},
          "models":{"default":"claude-fable-5","options":[]}
        }]}
        """
        return try XCTUnwrap(
            JSONDecoder().decode(InstanceList.self, from: Data(json.utf8)).instances.first
        )
    }
}
