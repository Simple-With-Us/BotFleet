// The native Mac app's visual design contract.
//
// This file is the single source of truth the Mac app renders from, and the
//  contract the BF-2496 visual parity gate checks.  It lives in CompanionCore
//  because the Mac app, the iOS app and the performance harness all import
//  that module, so the vocabulary cannot drift between the app and the gate.
//
// The mascot vocabulary is the legacy desktop vocabulary, verbatim.  The Mac
//  app replaces that desktop, so it has to draw the same faces the desktop
//  drew.  src/lib/mascot.ts is the source of truth, and the parity test
//  compares this list against it, so a change on either side has to be a
//  deliberate change on both.
//
// The theme is system-driven.  The owner ruling is that the system theme is
//  the first-visit default, so the app resolves every color from the system
//  palette instead of carrying a palette of its own.

import Foundation

// MARK: - Mascot Expressions

/// The mascot expressions the Mac app can draw.
///
/// Every case is a legacy desktop expression.  The parity test compares this
///  list against the legacy STATE_GROUPS vocabulary in src/lib/mascot.ts.
public enum MacMascotExpression: String, CaseIterable, Sendable, Codable {
    case sleeping = "sleeping"
    case waking = "waking"
    case idle = "idle"
    case listening = "listening"
    case thinking = "thinking"
    case searching = "searching"
    case working = "working"
    case excited = "excited"
    case surprised = "surprised"
    case suspicious = "suspicious"
    case angry = "angry"
    case drowsy = "drowsy"
    case happy = "happy"
    case curious = "curious"
    case confused = "confused"
    case bored = "bored"
    case proud = "proud"
    case shy = "shy"
    case sad = "sad"
    case laughing = "laughing"
    case scared = "scared"
    case playful = "playful"
    case celebrate = "celebrate"
    case orbit = "orbit"
    case radar = "radar"
    case progress = "progress"
    case spawning = "spawning"
    case humming = "humming"
    case loading = "loading"
    case dictating = "dictating"
    case writing = "writing"
    case sending = "sending"
    case receiving = "receiving"
    case uploading = "uploading"
    case notifying = "notifying"
    case alerting = "alerting"
    case dragging = "dragging"
    case bouncing = "bouncing"
    case poweringDown = "powering-down"
    case fleet = "fleet"
    case crash = "crash"
    case memory = "memory"
    case tools = "tools"
    case routine = "routine"
    case screen = "screen"
    case git = "git"
    case webhook = "webhook"
    case computer = "computer"
    case typing = "typing"
    case speaking = "speaking"
    case sneaking = "sneaking"
}

// MARK: - Status Pills

/// The status pills the Mac app can show next to a bot.
///
/// The legacy desktop had no status pill, so this vocabulary is native.  It
///  has to stay in step with the app's own connection states: the parity test
///  reads the app's MacConnectionStatus cases and fails when a state has no
///  pill, or a pill has no state.
public enum MacStatusPillKind: String, CaseIterable, Sendable, Codable {
    case connected
    case reconnecting
    case offline
    case error

    /// The label the pill shows.
    public var label: String {
        switch self {
        case .connected: return "Connected"
        case .reconnecting: return "Connecting"
        case .offline: return "Disconnected"
        case .error: return "Error"
        }
    }
}

/// Maps the app's connection states onto the shared pill vocabulary.
///
/// The keys are the app's own MacConnectionStatus case names.  The parity test
///  reads that enum out of the app source and fails when the two drift apart,
///  so a new connection state cannot ship without a decision about its pill.
public enum MacConnectionStatusPill {
    public static let pillByConnectionState: [String: MacStatusPillKind] = [
        "disconnected": .offline,
        "connecting": .reconnecting,
        "connected": .connected,
        "failed": .error,
    ]
}

// MARK: - Theme

/// How the Mac app resolves its appearance.
public enum MacThemeMode: String, CaseIterable, Sendable, Codable {
    case light
    case dark
    case system
}

/// The design tokens the Mac app and the parity gate share.
public enum MacDesignTokens {
    /// The app follows the system appearance.  The owner ruling is that the
    ///  system theme is the first-visit default, so the default is not a
    ///  fixed light or dark palette.
    public static let defaultThemeMode: MacThemeMode = .system
}

// MARK: - Mascot Palette

/// The mascot body colors, taken verbatim from the legacy desktop palette.
///
/// These are the only hardcoded colors the product carries, and they belong to
///  the mascot, not to the theme.  The parity test compares them against
///  BOT_COLORS in src/lib/mascot.ts.
public enum MacMascotPalette {
    public static let colors: [String: String] = [
        "green": "#009957",
        "blue": "#377FE6",
        "red": "#D94B52",
        "orange": "#E78531",
        "purple": "#8057C8",
        "cyan": "#0EA5C6",
        "pink": "#D84F8B",
        "yellow": "#D8A729",
        "teal": "#01A492",
        "coral": "#E5634E",
        "white": "#E8EAED",
        "black": "#2D3036",
    ]
}
