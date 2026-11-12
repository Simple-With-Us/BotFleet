// Composer keyboard chrome — when the slash HUD and fallback bars show.
//
// Views live in the app target (UIKit `inputAccessoryView`).  CompanionCore
// holds the rules so `swift test` can lock them without a simulator.
import Foundation

public enum ComposerInputChrome {
    public static let hideKeyboardTitle = "Hide"
    public static let hideKeyboardSymbolName = "chevron.down"

    /// Slash command HUD appears only after the user types `/`.
    public static func showsSlashCommandBar(draft: String) -> Bool {
        draft.hasPrefix("/")
    }

    /// Above-composer row when the keyboard accessory bar cannot be used.
    public static func showsFallbackKeyboardBar(
        composerFocused: Bool,
        slashBarVisible: Bool,
        keyboardAccessoryAvailable: Bool
    ) -> Bool {
        composerFocused && !slashBarVisible && !keyboardAccessoryAvailable
    }
}
