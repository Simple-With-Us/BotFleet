import Foundation

/// A grouped item in a chat transcript — either a single message or a folded run of tool activities.
///
/// A run's id is its first message's id, with no prefix.  A lone activity is
/// `.message(X)` until a second one joins it and it becomes `.run(id: X)`;
/// keeping the id lets the transcript row, and any scroll aimed at it,
/// survive that change instead of being torn down and rebuilt.
public enum TranscriptItem: Identifiable, Hashable, Sendable {
    case message(Message)
    case run(id: String, messages: [Message])

    public var id: String {
        switch self {
        case let .message(msg): return msg.id
        case let .run(id, _): return id
        }
    }

    public var messages: [Message] {
        switch self {
        case let .message(msg): return [msg]
        case let .run(_, msgs): return msgs
        }
    }

    public var date: Date {
        switch self {
        case let .message(msg): return msg.date
        case let .run(_, msgs): return msgs.first?.date ?? Date()
        }
    }
}

/// A step that may be folded into an activity run.
public func isFoldableActivity(_ message: Message) -> Bool {
    guard message.kind == .activity, let tool = message.tool else { return false }
    if message.comm != nil { return false }
    return !tool.name.hasPrefix("error:")
}

/// Fold consecutive tool activities into grouped runs.
public func groupActivityRuns(_ messages: [Message]) -> [TranscriptItem] {
    var items: [TranscriptItem] = []
    var run: [Message] = []

    func flush() {
        if run.count > 1 {
            items.append(.run(id: run[0].id, messages: run))
        } else {
            for msg in run {
                items.append(.message(msg))
            }
        }
        run.removeAll()
    }

    for message in messages {
        if isFoldableActivity(message) {
            if let first = run.first {
                if first.role != message.role ||
                    first.from?.botId != message.from?.botId {
                    flush()
                }
            }
            run.append(message)
            continue
        }
        flush()
        items.append(.message(message))
    }
    flush()
    return items
}

/// The id of the transcript row that shows `messageId`.  Only rows carry a
/// scroll id, so a message folded into an activity run is reached through
/// its run; aiming a scroll at the message itself silently does nothing.
public func transcriptRowId(containing messageId: String, in items: [TranscriptItem]) -> String? {
    items.first { item in item.messages.contains { $0.id == messageId } }?.id
}

/// Describes a folded activity run with tool breakdown and failure count.
public func describeActivityRun(_ messages: [Message]) -> (headline: String, summary: String, failedCount: Int) {
    var counts: [(name: String, count: Int)] = []
    for msg in messages {
        let name = msg.tool?.name ?? "step"
        if let idx = counts.firstIndex(where: { $0.name == name }) {
            counts[idx].count += 1
        } else {
            counts.append((name: name, count: 1))
        }
    }
    let parts = counts.map { $0.count > 1 ? "\($0.name) ×\($0.count)" : $0.name }
    let maxShown = 3
    let shown = parts.prefix(maxShown).joined(separator: ", ")
    let rest = parts.count > maxShown ? " +\(parts.count - maxShown) more" : ""
    let failed = messages.filter { $0.tool?.ok == false }.count

    let headline = "\(messages.count) \(messages.count == 1 ? "tool call" : "tool calls")"
    let summary = "\(shown)\(rest)"
    return (headline: headline, summary: summary, failedCount: failed)
}
