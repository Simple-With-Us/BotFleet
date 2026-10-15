import XCTest
@testable import CompanionCore

final class InputViewTests: XCTestCase {
    func testSlashBarHiddenUntilSlashTyped() {
        XCTAssertFalse(ComposerInputChrome.showsSlashCommandBar(draft: ""))
        XCTAssertFalse(ComposerInputChrome.showsSlashCommandBar(draft: "hello"))
        XCTAssertTrue(ComposerInputChrome.showsSlashCommandBar(draft: "/"))
        XCTAssertTrue(ComposerInputChrome.showsSlashCommandBar(draft: "/tasks"))
    }

    func testFallbackBarOnlyWhenFocusedWithoutAccessory() {
        XCTAssertFalse(ComposerInputChrome.showsFallbackKeyboardBar(
            composerFocused: false,
            slashBarVisible: false,
            keyboardAccessoryAvailable: false
        ))
        XCTAssertFalse(ComposerInputChrome.showsFallbackKeyboardBar(
            composerFocused: true,
            slashBarVisible: true,
            keyboardAccessoryAvailable: false
        ))
        XCTAssertFalse(ComposerInputChrome.showsFallbackKeyboardBar(
            composerFocused: true,
            slashBarVisible: false,
            keyboardAccessoryAvailable: true
        ))
        XCTAssertTrue(ComposerInputChrome.showsFallbackKeyboardBar(
            composerFocused: true,
            slashBarVisible: false,
            keyboardAccessoryAvailable: false
        ))
    }

    func testHideCopyUsesTitleCaseAndChevronDown() {
        XCTAssertEqual(ComposerInputChrome.hideKeyboardTitle, "Hide")
        XCTAssertEqual(ComposerInputChrome.hideKeyboardSymbolName, "chevron.down")
    }
}
