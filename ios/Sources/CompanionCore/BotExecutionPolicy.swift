import Foundation

/// How a bot's ordinary approval cards are reviewed: the wire value of
/// `autoReview`.  The labels are the desktop's Review Routine Approvals
/// control (`src/components/SettingsPanel.tsx`).
public enum AutoReviewMode: String, CaseIterable, Hashable, Sendable {
    case off
    case shadow
    case enforce

    /// What the computer stores, read the way the desktop reads it: anything
    /// that is not `shadow` or `enforce` is off.
    public init(stored: String?) {
        self = stored.flatMap(Self.init(rawValue:)) ?? .off
    }

    public var label: String {
        switch self {
        case .off: "Off"
        case .shadow: "Watch"
        case .enforce: "On"
        }
    }

    public var summary: String {
        switch self {
        case .off: "Every undecided approval waits for you."
        case .shadow: "Record the review without answering the card."
        case .enforce: "Answer only reviews that return a strict approval."
        }
    }
}

/// What the phone may do with a bot's execution policy, and what it tells the
/// person while it does.
///
/// Owner ruling, 2026-10-09: bots get Bypass Permissions, Auto Mode, Auto
/// Review and peer-contact approval from the phone too (#323 had kept them on
/// the computer; `companion/src/routes.ts` has the history).  What did not
/// move is host control of the person's real desktop:
///
/// - The computer refuses to turn Auto Mode ON for a bot that can use This Mac,
///   because Auto Mode is the one switch that lets a click on the real desktop
///   go unasked, and the warning dialog for that pair is the Mac's
///   (`PAIRED_AUTO_ON_THIS_MAC_ERROR` in server/index.ts).  Turning it off is
///   always the phone's.
/// - Bypass Permissions never answers a request that controls This Mac
///   (`server/auto-approve.ts`), so host control still asks on a bot in bypass,
///   and the phone may switch it on for any bot.
///
/// Every sentence gap below is a no-break space plus a space, the way the
/// rest of the app writes them.
public enum BotExecutionPolicy {
    /// Whether the phone can ask for Auto Mode to be turned ON for a bot with
    /// these computers.  False when the bot holds This Mac, because the
    /// computer would refuse.  An Auto bot (no list) is left to the computer,
    /// which knows whether it can reach the desktop: the phone asks, and shows
    /// the computer's own sentence if it declines.  Bypass Permissions has no
    /// such condition.
    public static func mayTurnOnAuto(computers: [String]?) -> Bool {
        !BotComputers.holdsThisMac(computers)
    }

    /// Said under the Auto Mode switch, always, because an Auto bot's answer
    /// is the computer's.
    public static let thisMacNote =
        "A bot that can use This Mac can only be put in Auto Mode in BotFleet on your computer.\u{00A0} Turning it off works from here."

    // MARK: - Bypass Permissions

    public static let bypassTitle = "Enable Bypass Permissions?"

    public static let bypassConfirmButton = "Enable Bypass Permissions"

    /// The confirm button when the model is one the desktop calls high risk.
    public static let bypassRiskyConfirmButton = "I Understand the Risks, Enable Bypass"

    /// The short form of the desktop's `BypassPermissionsWarning`, with the
    /// two facts it leaves out: it covers destructive actions and credential
    /// files, and turns a webhook or alert starts while nobody is watching.
    public static func bypassWarning(botName: String, model: String?) -> String {
        var text = "\(botName) will run commands, file edits and routine proposals without waiting for approval cards.\u{00A0} "
        text += "That includes destructive actions and credential files, and turns started by a webhook or alert while you are away.\u{00A0} "
        text += "Actions that control This Mac still ask."
        if BypassModelRisk.isHighRisk(model: model) {
            text += "\u{00A0} \(BypassModelRisk.label(model)) is a small or unrecognized model, which is more likely to run something destructive.\u{00A0} Consider a frontier model first."
        }
        return text
    }

    /// The line under the Bypass Permissions switch.  What it does on a
    /// particular engine, when that is not the plain answer, is
    /// `BypassCoverage.note`.
    public static func bypassSummary(isOn: Bool) -> String {
        isOn
            ? "Active.\u{00A0} Every tool call and command is approved automatically, except actions that control This Mac."
            : "Approve every tool call and command automatically, with no approval cards.\u{00A0} Actions that control This Mac still ask."
    }

    /// The Auto Mode line, from the desktop: it keeps going, but a guard can
    /// still stop it.
    public static func autoSummary(isOn: Bool) -> String {
        isOn
            ? "Keeps going on its own.\u{00A0} You will still be asked about anything destructive, and about questions it asks you."
            : "Approve each action yourself.\u{00A0} Turn on to let this bot keep working without stopping to ask."
    }

    public static func autoReviewSummary(bypassIsOn: Bool, support: EngineSupport) -> String {
        if bypassIsOn {
            return "Bypass Permissions is on, so routine approvals are answered before any review."
        }
        switch support {
        case .supported:
            return "The same engine reviews ordinary approval cards.\u{00A0} Safety rules, unattended turns, This Mac and questions still wait for you."
        case .unsupported:
            return "This engine cannot run an isolated review safely.\u{00A0} Approvals will wait for you, or turn on Bypass Permissions."
        case .unknown:
            return "Waiting to hear what this engine supports."
        }
    }

    public static func peerCommsSummary(isOn: Bool, support: EngineSupport) -> String {
        if isOn { return "This bot will stop and ask before it reaches out to another bot." }
        switch support {
        case .supported:
            return "This bot talks to teammates on its own, without a confirmation step."
        case .unsupported:
            return "This engine cannot contact other bots."
        case .unknown:
            return "Waiting to hear what this engine supports."
        }
    }

    // MARK: - What the engine can do

    /// Whether the engine can answer a bounded review, which Auto Review
    /// needs.  The desktop reads a missing answer as no
    /// (`botCapabilityGates`), and so does the phone for turning it on, but it
    /// does not SAY the engine cannot until the computer has said so.
    public static func autoReviewSupport(_ engine: Instance?) -> EngineSupport {
        support(engine?.capabilities?.approvalReview, engineKnown: engine != nil)
    }

    /// Whether the engine can contact other bots, which asking first needs.
    public static func peerCommsSupport(_ engine: Instance?) -> EngineSupport {
        support(engine?.capabilities?.agentsMcp, engineKnown: engine != nil)
    }

    private static func support(_ flag: Bool?, engineKnown: Bool) -> EngineSupport {
        guard engineKnown, let flag else { return .unknown }
        return flag ? .supported : .unsupported
    }
}

/// What a bot's Bypass Permissions switch does on an engine, as the computer
/// reports it (`shared/bypass-coverage.ts`): the engine's approval requests are
/// answered, its own skip-approvals mode is turned on, or the engine never asks.
/// The notes are that file's, word for word; `companion/test/ios-client-parity.test.ts`
/// fails if they drift.
public enum BypassCoverage: String, Sendable {
    case asks
    case native
    case none

    /// An absent or unrecognized answer reads as `asks`, which says nothing: a
    /// computer too old to report it, or a newer one, never makes the phone
    /// claim the switch is dead.
    public init(wire: String?) {
        self = wire.flatMap(Self.init(rawValue:)) ?? .asks
    }

    public init(engine: Instance?) {
        self.init(wire: engine?.capabilities?.bypassCoverage)
    }

    /// Shown under the Bypass Permissions switch, or nil when it works as described.
    public var note: String? {
        switch self {
        case .asks: nil
        case .native: "This engine has no approval cards.\u{00A0} Bypass Permissions turns on its skip-permissions mode for turns that do not control This Mac."
        case .none: "This engine never asks for approval, so Bypass Permissions changes nothing for it."
        }
    }
}

/// What an engine reports about a capability a control depends on.  `unknown`
/// is a computer that has not answered yet, or one too old to say: not the
/// same claim as `unsupported`, and never worded as if it were.
public enum EngineSupport: Equatable, Sendable {
    case supported
    case unsupported
    case unknown

    /// Whether a control that needs it may be switched ON.  Only a computer
    /// that said yes counts, the way the desktop gates it.
    public var allowsTurningOn: Bool { self == .supported }
}

/// Which models the desktop warns about before a bypass
/// (`shared/model-safety.ts`).  The patterns are that file's `HIGH_RISK_PATTERNS`
/// verbatim, and `companion/test/ios-client-parity.test.ts` fails if the two
/// lists drift.  An unknown model counts as risky, the way the desktop reads it.
public enum BypassModelRisk {
    static let highRiskPatterns: [String] = [
        #"\bhaiku\b"#,
        #"\bmini\b"#,
        #"\bflash(-lite)?\b"#,
        #"\bnano\b"#,
        #"\bmicro\b"#,
        #"\bsmall\b"#,
        #"\blite\b"#,
        #"\binstant\b"#,
        #"\bgpt-3\.5"#,
        #"\bgpt-4-0[36]1[34]\b"#,
        #"\bclaude-2\b"#,
        #"\b(?:1|3|7|8|14)b\b"#,
    ]

    public static func isHighRisk(model: String?) -> Bool {
        let name = (model ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if name.isEmpty { return true }
        return highRiskPatterns.contains { pattern in
            name.range(of: pattern, options: .regularExpression) != nil
        }
    }

    /// How the warning names the model.
    static func label(_ model: String?) -> String {
        let name = (model ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "This bot's model" : name
    }
}
