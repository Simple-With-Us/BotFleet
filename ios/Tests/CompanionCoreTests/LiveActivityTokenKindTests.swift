import XCTest
@testable import CompanionCore

/// The two Live Activity tokens are a wire contract with the sidecar: it
/// stores them differently and cannot use one for the other's job.  Renaming a
/// raw value here is a silent break — the sidecar keeps storing a token under a
/// kind it never recognises and the feature dies quietly.
final class LiveActivityTokenKindTests: XCTestCase {
    func testRawValuesAreTheOnTheWireStrings() {
        XCTAssertEqual(LiveActivityTokenKind.pushToStart.rawValue, "push-to-start")
        XCTAssertEqual(LiveActivityTokenKind.update.rawValue, "update")
    }

    func testDecodesFromWhatTheSidecarStores() {
        let decoded = try? JSONDecoder().decode(LiveActivityTokenKind.self, from: Data("\"push-to-start\"".utf8))
        XCTAssertEqual(decoded, .pushToStart)
    }
}