// Spoken approvals on a voice call: the rules, as pure functions.
//
// On a speech-to-speech call the user's speech reaches the model, not the
// app, so there is no second dictation channel to route "yes" through.  The
// model learns an approval is waiting, reads the request out loud, and hands
// the user's own words back for the app to map.  The app decides, never the
// model, and it decides with the same anchored rules the text path uses.
//
// This is a port of the approval section of src/lib/sts/call-session.ts
// (`spokenApprovalDecision`, `resolveStsApproval`, and the texts around
// them).  The two must agree word for word on what counts as consent,
// because a "yes" that allows on one client and stalls on another is a
// permission system that disagrees with itself.
import Foundation

/// What the caller's words amounted to.  Anything else is read as a reply to
/// the bot, not as consent.
public enum SpokenApprovalDecision: String, Hashable, Sendable {
    case allow
    case deny
    /// Not an answer: the model must ask again, and nothing is submitted.
    case unclear
}

/// Spoken answers to a permission card.  Anchored at both ends on purpose:
///
/// an approval must never be granted by a sentence that merely contained the
/// word "sure".  "I'm not sure" is not consent.  The two patterns cannot both
/// match, so there is no precedence question.
public func spokenApprovalDecision(_ answer: String?) -> SpokenApprovalDecision {
    let said = (answer ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if said.range(of: "^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|allow|approve|approved|fine|please do)\\b",
                   options: [.regularExpression, .caseInsensitive]) != nil {
        return .allow
    }
    if said.range(of: "^(no|nope|don'?t|do not|stop|deny|denied|cancel|never|skip it)\\b",
                   options: [.regularExpression, .caseInsensitive]) != nil {
        return .deny
    }
    return .unclear
}

/// The message recorded when the caller denies on a call.  Identical to the
/// desktop's VOICE_DENIAL_MESSAGE so the audit trail reads the same.
public let stsVoiceDenialMessage = "Denied by the user, on a call."

/// A permission waiting for an answer, as the call sees it.
public struct StsApprovalView: Hashable, Sendable {
    public var requestId: String
    /// The sentence the model reads aloud.
    public var prompt: String
    /// The tool asking, e.g. "run_command".
    public var tool: String

    public init(requestId: String, prompt: String, tool: String) {
        self.requestId = requestId
        self.prompt = prompt
        self.tool = tool
    }
}

/// What resolving one model turn amounts to.  Only `.decided` submits
/// anything; every other outcome goes back to the model as text, having
/// submitted nothing.
public enum StsApprovalOutcome: Hashable, Sendable {
    /// Nothing waiting under that id (or at all): answered elsewhere, or
    /// never existed.  Reading what is waiting can never submit anything.
    case stale(text: String)
    /// The words were not an answer.  Ask again; the card stays up.
    case unclear(requestId: String, text: String)
    /// What is waiting, for the model to read aloud.
    case ask(requestId: String, text: String)
    /// What is waiting, without submitting.
    case status(text: String)
    /// A decision the caller may now dispatch -- through the same respond
    /// route the card's own buttons use, so a spoken "yes" and a clicked
    /// "Allow" are one decision with one record.
    case decided(requestId: String, decision: SpokenApprovalDecision)
}

/// Resolve one `bot_engine` approval turn against what is actually waiting.
///
/// - A request already submitted by this call is invisible to the model: the
///   `decided` set holds ids claimed before dispatch, so a re-render in the
///   network gap cannot re-answer.
/// - A NAMED request that is not waiting resolves to nothing.  Falling back
///   to the oldest would let the model answer a different permission than
///   the one it read out.  No name at all means the oldest.
/// - "always allow" is structurally unreachable: there is no grant action,
///   only allow/deny for this request.  A voice decision must not be able to
///   create a durable grant.
public func resolveStsApproval(
    action: StsApprovalAction,
    requestId: String?,
    answer: String?,
    pending: [StsApprovalView],
    decided: Set<String>
) -> StsApprovalOutcome {
    let waiting = pending.filter { !decided.contains($0.requestId) }
    switch action {
    case .decide:
        let target: StsApprovalView?
        if let requestId, !requestId.isEmpty {
            target = waiting.first { $0.requestId == requestId }
        } else {
            target = waiting.first
        }
        guard let target else { return .stale(text: staleApprovalText()) }
        switch spokenApprovalDecision(answer) {
        case .unclear:
            return .unclear(requestId: target.requestId, text: unclearApprovalText(target))
        case .allow, .deny:
            return .decided(requestId: target.requestId, decision: spokenApprovalDecision(answer))
        }
    case .ask:
        let target: StsApprovalView?
        if let requestId, !requestId.isEmpty {
            target = waiting.first { $0.requestId == requestId }
        } else {
            target = waiting.first
        }
        guard let target else { return .stale(text: staleApprovalText()) }
        return .ask(requestId: target.requestId, text: askApprovalText(target))
    case .check:
        return .status(text: statusApprovalText(waiting))
    }
}

public enum StsApprovalAction: String, Hashable, Sendable {
    case check
    case ask
    case decide
}

/// Reachable and harmless: nothing is submitted.
public func staleApprovalText() -> String {
    "That request is no longer waiting for permission, so nothing was submitted.  " +
        "Do not answer it again.  If the work is still needed, call the engine for it."
}

func askApprovalText(_ approval: StsApprovalView) -> String {
    "Read this to the caller word for word, then wait for their answer:\n\(approval.prompt)\n" +
        "When they answer, call `bot_engine` again with approval action \"decide\", " +
        "request id \(approval.requestId), and their exact words as the answer.  Never answer it for them."
}

func unclearApprovalText(_ approval: StsApprovalView) -> String {
    "That was not a clear yes or no.  Ask the caller again, and tell them the approval for " +
        "\(approval.tool) is also on screen if they would rather tap it."
}

func statusApprovalText(_ waiting: [StsApprovalView]) -> String {
    if waiting.isEmpty {
        return "Nothing is waiting for permission."
    }
    let lines = waiting.enumerated().map { index, approval in
        "\(index + 1). \(approval.prompt)  Request id: \(approval.requestId)."
    }
    return "Waiting for permission:\n" + lines.joined(separator: "\n")
}
