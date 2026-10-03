// TV-Face expression mapping — mirrors src/components/tv-face/manifest.ts.
// Keep in lockstep with the web pack so a bot that is "thinking" on desktop
// plays the same face on the phone. Covers every face on the TV-Face expression
// sheet that ships art (stills and/or GIFs).
import Foundation

public enum TVFaceExpression: String, CaseIterable, Sendable {
    case resting, sleeping, waking, listening, thinking
    case searching, working, happy, excited, celebrate
    case confused, curious, sad, alerting, angry, scared
    case loading, sending, receiving, notifying, typing
    case speaking, powering_down, fleet, crash, memory
    case tools, routine, screen, git, webhook, computer
    case surprised, suspicious, shy, bored, drowsy
    case proud, playful, laughing
    // Sheet faces that previously only existed as stills / aliases:
    case orbit, progress, radar, uploading, sneaking, spawning
}

public enum TVFaceManifest {
    /// Expressions that ship enter + hold + return GIFs.
    public static let hasEnterReturn: Set<TVFaceExpression> = [
        .listening, .thinking, .typing, .speaking, .computer,
        .fleet, .crash, .memory, .tools, .routine, .screen, .git, .webhook,
    ]

    /// Fixed enter/return duration contract with the asset pack (ms).
    public static let transitionMs: Int = 1000

    /// Every face on the TV-Face sheet that the player can select.
    public static let sheetExpressions: [TVFaceExpression] = [
        .alerting, .angry, .bored, .celebrate, .computer, .confused,
        .crash, .curious, .drowsy, .excited, .fleet, .git,
        .happy, .laughing, .listening, .loading, .memory, .notifying,
        .orbit, .playful, .powering_down, .progress, .proud, .radar,
        .receiving, .resting, .routine, .sad, .scared, .screen,
        .searching, .shy, .sleeping, .sneaking, .surprised, .thinking,
        .tools, .typing, .uploading, .webhook, .working,
    ]

    /// BotState → expression. Prefer a 1:1 map whenever a sheet face exists.
    public static func expression(for state: BotState) -> TVFaceExpression {
        switch state {
        case .sleeping: return .sleeping
        case .waking: return .waking
        case .idle: return .resting
        case .listening: return .listening
        case .thinking, .thinkingDots: return .thinking
        case .searching: return .searching
        case .working, .humming: return .working
        case .excited, .bouncing: return .excited
        case .surprised: return .surprised
        case .suspicious: return .suspicious
        case .angry: return .angry
        case .drowsy: return .drowsy
        case .happy: return .happy
        case .curious: return .curious
        case .confused: return .confused
        case .bored: return .bored
        case .proud: return .proud
        case .shy: return .shy
        case .sad: return .sad
        case .laughing: return .laughing
        case .scared: return .scared
        case .playful: return .playful
        case .celebrate: return .celebrate
        // Morphs keep their sheet faces (not remapped to fleet/searching/routine)
        case .orbit: return .orbit
        case .radar: return .radar
        case .progress: return .progress
        case .spawning: return .spawning
        case .loading: return .loading
        case .dictating: return .speaking
        case .writing: return .typing
        case .sending: return .sending
        case .receiving: return .receiving
        case .uploading: return .uploading
        case .notifying: return .notifying
        case .alerting: return .alerting
        case .dragging: return .screen
        case .poweringDown: return .powering_down
        // Grok Actions — super-specific sheet faces
        case .fleet: return .fleet
        case .crash: return .crash
        case .memory: return .memory
        case .tools: return .tools
        case .routine: return .routine
        case .screen: return .screen
        case .git: return .git
        case .webhook: return .webhook
        case .computer: return .computer
        case .typing: return .typing
        case .speaking: return .speaking
        case .sneaking: return .sneaking
        }
    }

    /// Skin directory name. orange is the default pack.
    public static func skinDir(_ color: String) -> String {
        let shipped: Set<String> = [
            "orange", "blue", "green", "purple", "pink", "red",
            "cyan", "yellow", "teal", "coral", "white", "black",
        ]
        if color == "orange" || !shipped.contains(color) { return "default" }
        return color
    }
}

public enum TVFaceFrameKind: String, Sendable {
    case enter, hold, `return`, still
}

public struct TVFaceFrameStep: Sendable {
    public let expression: TVFaceExpression
    public let kind: TVFaceFrameKind
    public let delayAfterMs: Int
}

public enum TVFacePlanner {
    /// Same enter/hold/return rules as web `planFrame`.
    public static func plan(from prev: TVFaceExpression, to next: TVFaceExpression) -> [TVFaceFrameStep] {
        if prev == next {
            return [TVFaceFrameStep(expression: next, kind: .hold, delayAfterMs: 0)]
        }
        if next == .resting {
            if !TVFaceManifest.hasEnterReturn.contains(prev) {
                return [TVFaceFrameStep(expression: .resting, kind: .still, delayAfterMs: 0)]
            }
            return [
                TVFaceFrameStep(expression: prev, kind: .return, delayAfterMs: TVFaceManifest.transitionMs),
                TVFaceFrameStep(expression: .resting, kind: .still, delayAfterMs: 0),
            ]
        }
        if prev == .resting {
            if !TVFaceManifest.hasEnterReturn.contains(next) {
                return [TVFaceFrameStep(expression: next, kind: .hold, delayAfterMs: 0)]
            }
            return [
                TVFaceFrameStep(expression: next, kind: .enter, delayAfterMs: TVFaceManifest.transitionMs),
                TVFaceFrameStep(expression: next, kind: .hold, delayAfterMs: 0),
            ]
        }
        return [TVFaceFrameStep(expression: next, kind: .hold, delayAfterMs: 0)]
    }
}
