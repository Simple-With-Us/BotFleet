import XCTest
@testable import CompanionCore

final class CollapsedSectionsTests: XCTestCase {
    func testRoundTripsASectionNameThatContainsAComma() {
        let sections: Set<String> = ["Sales, Marketing", "Bot Chats"]
        XCTAssertEqual(CollapsedSections.decode(CollapsedSections.encode(sections)), sections)
    }

    func testReadsTheLegacyCommaJoinedValue() {
        XCTAssertEqual(
            CollapsedSections.decode("Bot Chats,Bot ↔ Bot"),
            ["Bot Chats", "Bot ↔ Bot"]
        )
    }

    func testEmptyValueDecodesToNoCollapsedSections() {
        XCTAssertEqual(CollapsedSections.decode(""), [])
    }

    func testEncodeIsDeterministicForTheSameSet() {
        XCTAssertEqual(CollapsedSections.encode(["b", "a"]), CollapsedSections.encode(["a", "b"]))
    }

    func testEncodedValueIsAJSONArray() {
        XCTAssertEqual(CollapsedSections.encode(["a"]), "[\"a\"]")
    }
}
