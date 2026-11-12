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

    /// The SF Symbol name the native Mac surface uses to draw this expression.
    public var symbolName: String {
        switch self {
        case .sleeping: return "moon.zzz.fill"
        case .waking: return "sunrise.fill"
        case .idle: return "cpu"
        case .listening: return "ear.and.waveform"
        case .thinking: return "brain"
        case .searching: return "magnifyingglass"
        case .working: return "gearshape.2.fill"
        case .excited: return "sparkles"
        case .surprised: return "exclamationmark.circle.fill"
        case .suspicious: return "eye.trianglebadge.exclamationmark"
        case .angry: return "flame.fill"
        case .drowsy: return "zzz"
        case .happy: return "face.smiling.fill"
        case .curious: return "questionmark.bubble.fill"
        case .confused: return "questionmark.circle.fill"
        case .bored: return "clock.fill"
        case .proud: return "star.fill"
        case .shy: return "hand.raised.slash.fill"
        case .sad: return "cloud.rain.fill"
        case .laughing: return "face.smiling.inverse"
        case .scared: return "bolt.trianglebadge.exclamationmark.fill"
        case .playful: return "gamecontroller.fill"
        case .celebrate: return "party.popper.fill"
        case .orbit: return "atom"
        case .radar: return "dot.radiowaves.left.and.right"
        case .progress: return "chart.bar.fill"
        case .spawning: return "plus.square.on.square"
        case .humming: return "music.note"
        case .loading: return "arrow.triangle.2.circlepath"
        case .dictating: return "mic.fill"
        case .writing: return "pencil.line"
        case .sending: return "paperplane.fill"
        case .receiving: return "tray.and.arrow.down.fill"
        case .uploading: return "arrow.up.doc.fill"
        case .notifying: return "bell.badge.fill"
        case .alerting: return "hand.raised.fill"
        case .dragging: return "hand.draw.fill"
        case .bouncing: return "arrow.up.and.down.circle.fill"
        case .poweringDown: return "poweroff"
        case .fleet: return "square.grid.2x2.fill"
        case .crash: return "exclamationmark.triangle.fill"
        case .memory: return "memorychip.fill"
        case .tools: return "wrench.and.screwdriver.fill"
        case .routine: return "calendar.badge.clock"
        case .screen: return "display"
        case .git: return "point.3.connected.trianglepath.dotted"
        case .webhook: return "link"
        case .computer: return "desktopcomputer"
        case .typing: return "keyboard.fill"
        case .speaking: return "speaker.wave.2.fill"
        case .sneaking: return "eyeglasses"
        }
    }

    /// The human-readable label for tooltips and VoiceOver.
    public var displayLabel: String {
        switch self {
        case .poweringDown:
            return "Powering Down"
        default:
            return rawValue.capitalized
        }
    }

    /// Whether the expression animates when Reduce Motion is off.
    public var isAnimated: Bool {
        switch self {
        case .waking, .listening, .thinking, .searching, .working, .excited,
             .laughing, .playful, .celebrate, .orbit, .radar, .progress,
             .spawning, .humming, .loading, .dictating, .writing, .sending,
             .receiving, .uploading, .notifying, .alerting, .dragging,
             .bouncing, .typing, .speaking:
            return true
        case .sleeping, .idle, .surprised, .suspicious, .angry, .drowsy,
             .happy, .curious, .confused, .bored, .proud, .shy, .sad,
             .scared, .poweringDown, .fleet, .crash, .memory, .tools,
             .routine, .screen, .git, .webhook, .computer, .sneaking:
            return false
        }
    }

    /// Maps the full mascot expression onto the sidebar's canonical status category.
    public var canonicalCategory: MacBotMascotExpression {
        switch self {
        case .sleeping, .drowsy, .poweringDown:
            return .offline
        case .alerting, .notifying, .surprised, .scared:
            return .waiting
        case .thinking, .searching, .curious, .confused, .memory, .orbit, .radar:
            return .thinking
        case .working, .waking, .listening, .progress, .spawning, .loading,
             .dictating, .writing, .sending, .receiving, .uploading, .dragging,
             .bouncing, .tools, .routine, .screen, .git, .webhook, .computer,
             .typing, .speaking, .sneaking:
            return .working
        case .happy, .excited, .proud, .laughing, .playful, .celebrate, .humming:
            return .happy
        case .angry, .crash, .sad, .suspicious:
            return .error
        case .idle, .bored, .shy, .fleet:
            return .idle
        }
    }

    /// Resolves a bot's live mascot expression from its state, pending cards,
    /// reasoning stream, and connection health.
    public static func resolve(
        for bot: Bot,
        hasPendingCard: Bool = false,
        hasReasoning: Bool = false,
        isConnected: Bool = true
    ) -> MacMascotExpression {
        if !isConnected || bot.isOff {
            if let raw = bot.mascotExpression?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
               raw == MacMascotExpression.poweringDown.rawValue {
                return .poweringDown
            }
            return .sleeping
        }
        if hasPendingCard {
            return .alerting
        }
        if hasReasoning {
            return .thinking
        }
        if bot.busy == true {
            return .working
        }
        if let raw = bot.mascotExpression?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
           let explicit = MacMascotExpression(rawValue: raw) {
            return explicit
        }
        return .idle
    }
}

// MARK: - TV-Face render resolution

/// Resolved TV-Face expression names for bot states that must not collapse when
/// rendered as TV-Face (matches src/components/tv-face/manifest.ts).
public enum MacMascotTvFaceRenderMap {
    public static let expressionByBotState: [String: String] = [
        "sneaking": "sneaking",
    ]
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

    /// The SF Symbol name the status pill renders alongside its label.
    public var symbolName: String {
        switch self {
        case .connected: return "checkmark.circle.fill"
        case .reconnecting: return "arrow.triangle.2.circlepath"
        case .offline: return "bolt.slash.fill"
        case .error: return "exclamationmark.triangle.fill"
        }
    }

    /// The VoiceOver accessibility label for the status pill.
    public var accessibilityLabel: String {
        "Connection status: \(label)"
    }

    /// The VoiceOver accessibility label for the status pill, including any
    /// visible detail text such as the connected endpoint or failure reason.
    public func accessibilityLabel(detailText: String?) -> String {
        guard let detail = detailText?.trimmingCharacters(in: .whitespacesAndNewlines),
              !detail.isEmpty,
              detail != label,
              detail != accessibilityLabel else {
            return accessibilityLabel
        }
        return "\(accessibilityLabel), \(detail)"
    }

    /// The semantic system color token name for the status pill across light and dark appearances.
    public var semanticColorToken: String {
        switch self {
        case .connected: return "systemGreen"
        case .reconnecting: return "systemYellow"
        case .offline: return "systemGray"
        case .error: return "systemRed"
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

    /// True when the theme mode defers to macOS system appearance rather than pinning a scheme.
    public var followsSystemAppearance: Bool {
        self == .system
    }

    /// The effective macOS appearances this theme mode resolves across light and dark environments.
    public var effectiveAppearances: [String] {
        switch self {
        case .light: return ["aqua"]
        case .dark: return ["darkAqua"]
        case .system: return ["aqua", "darkAqua"]
        }
    }
}

/// A rendered light/dark visual snapshot entry for the BF-2496 parity suite.
public struct MacVisualSurfaceSnapshot: Sendable, Codable, Equatable {
    public let themeMode: MacThemeMode
    public let effectiveAppearance: String
    public let backgroundToken: String
    public let foregroundToken: String
    public let mascotSnapshots: [MascotSnapshot]
    public let statusPillSnapshots: [StatusPillSnapshot]

    public struct MascotSnapshot: Sendable, Codable, Equatable {
        public let expression: MacMascotExpression
        public let symbolName: String
        public let displayLabel: String
        public let canonicalCategory: String
        public let isAnimated: Bool
        public let badgeTintToken: String

        public init(
            expression: MacMascotExpression,
            symbolName: String,
            displayLabel: String,
            canonicalCategory: String,
            isAnimated: Bool,
            badgeTintToken: String
        ) {
            self.expression = expression
            self.symbolName = symbolName
            self.displayLabel = displayLabel
            self.canonicalCategory = canonicalCategory
            self.isAnimated = isAnimated
            self.badgeTintToken = badgeTintToken
        }
    }

    public struct StatusPillSnapshot: Sendable, Codable, Equatable {
        public let kind: MacStatusPillKind
        public let label: String
        public let symbolName: String
        public let accessibilityLabel: String
        public let semanticColorToken: String

        public init(
            kind: MacStatusPillKind,
            label: String,
            symbolName: String,
            accessibilityLabel: String,
            semanticColorToken: String
        ) {
            self.kind = kind
            self.label = label
            self.symbolName = symbolName
            self.accessibilityLabel = accessibilityLabel
            self.semanticColorToken = semanticColorToken
        }
    }

    public init(
        themeMode: MacThemeMode,
        effectiveAppearance: String,
        backgroundToken: String,
        foregroundToken: String,
        mascotSnapshots: [MascotSnapshot],
        statusPillSnapshots: [StatusPillSnapshot]
    ) {
        self.themeMode = themeMode
        self.effectiveAppearance = effectiveAppearance
        self.backgroundToken = backgroundToken
        self.foregroundToken = foregroundToken
        self.mascotSnapshots = mascotSnapshots
        self.statusPillSnapshots = statusPillSnapshots
    }
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
