import Foundation

/// Message grouping — the shared Mac/iOS contract in
/// docs/specs/chat-message-grouping.md.
///
/// `groupActivityRuns` folds consecutive tool activities into runs.
/// `groupMessageRuns` generalises that: a run is any consecutive stretch from
/// one speaker inside `groupMessageTimeGap`, so a text turn with two prose
/// bubbles is a run too, and gets a header and an identity.
///
/// Tool runs keep their extra rules — failures stay enumerated, `error:`
/// tools and comm rows never fold — because those are about not hiding
/// something the user needs.

/// How long a pause can be and still be the same run.
///
/// Deliberately distinct from `transcriptStretchGap` (30 min).  That one
/// decides *stamping*; this one decides *membership*.  Conflating them would
/// let a group survive a 45-minute pause, which is not a group.
public let groupMessageTimeGap: TimeInterval = 60

/// The identity a message groups under.  Not `role`: a `user`-role message
/// mirrored from a peer bot renders on the same side as the human's, so role
/// alone would merge two different speakers into one run.
public func messageGroupingSpeaker(_ message: Message) -> String {
    switch message.role {
    case .system:
        // An auto-delivered instruction is its own event; two routine rows
        // arriving together are still two events.
        return "system:\(message.automationSource ?? "unknown")"
    case .bot:
        return "bot:\(message.from?.botId ?? "")"
    case .user:
        guard let sender = message.from else { return "user:me" }
        return "bot:\(sender.botId)"
    }
}

/// True when `next` continues the run that `previous` is in.
public func messagesShareGroup(_ previous: Message, _ next: Message) -> Bool {
    if previous.role == .system || next.role == .system { return false }
    guard messageGroupingSpeaker(previous) == messageGroupingSpeaker(next) else { return false }
    guard previous.parentId == next.parentId else { return false }
    return next.date.timeIntervalSince(previous.date) <= groupMessageTimeGap
}

/// True when this message is a foldable tool step.
private func isGroupableTool(_ message: Message) -> Bool {
    message.role != .system && isFoldableActivity(message)
}

/// True when this message is groupable prose (not a system row, tool chip,
/// option card, screenshot, or delegation/comm event).
internal func isGroupableProse(_ message: Message) -> Bool {
    message.role != .system &&
        message.kind == .text &&
        message.comm == nil &&
        message.card == nil &&
        !isFoldableActivity(message)
}

/// Group consecutive same-speaker messages, preserving order and identity.
public func groupMessageRuns(_ messages: [Message]) -> [TranscriptItem] {
    var items: [TranscriptItem] = []
    var run: [Message] = []

    func flush() {
        if run.count > 1 {
            items.append(.run(id: run[0].id, messages: run))
        } else {
            for msg in run { items.append(.message(msg)) }
        }
        run.removeAll()
    }

    for message in messages {
        guard let previous = run.last else {
            // The first message always opens a run.  Emitting it straight to
            // `items` instead is why text messages could never group: the next
            // one would find `run` empty and start over.
            run.append(message)
            continue
        }
        // A tool step joins only a run of other tool steps, and prose joins
        // only a run of other prose.  That keeps a text bubble between two
        // tools ending that run rather than being swallowed by it, while
        // still letting a text turn form a group of its own.
        let bothTools = isGroupableTool(previous) && isGroupableTool(message)
        let bothText = isGroupableProse(previous) && isGroupableProse(message)
        if (bothTools || bothText) && messagesShareGroup(previous, message) {
            run.append(message)
        } else {
            flush()
            run.append(message)
        }
    }
    flush()
    return items
}

/// The spoken/announced form of a transcript row.
///
/// A group is one accessibility element: VoiceOver must not walk its members
/// one at a time, but the failure count has to survive the fold, because a
/// run that quietly swallows a failure is how a user misses their deploy broke.
public func messageRunAccessibilityLabel(
    _ item: TranscriptItem,
    sender: String? = nil,
    relativeTime: String? = nil
) -> String {
    let messages = item.messages
    let count = messages.count
    var parts: [String] = []
    if let sender, !sender.isEmpty {
        parts.append(sender)
    }
    if count <= 1 {
        parts.append("\(count) message")
    } else {
        let failed = messages.filter { $0.tool?.ok == false }.count
        parts.append("\(count) messages")
        if messages.contains(where: { $0.tool != nil }) {
            let (_, summary, _) = describeActivityRun(messages)
            parts.append(summary)
            if failed > 0 {
                parts.append("\(failed) failed")
            }
        }
    }
    if let relativeTime, !relativeTime.isEmpty {
        parts.append(relativeTime)
    }
    return parts.joined(separator: ", ")
}
