// What the Updates pill shows: only the chats doing something.
//
// Three kinds, in the order a person cares about them — a bot that has
// stopped and needs an answer, a bot mid-turn, and a bot that finished with
// something you have not read. A bot that is idle and read is not an update
// and never appears here; that is what the roster below is for.
import Foundation
import CompanionCore

struct ChatUpdate: Identifiable, Hashable {
    enum Kind: Int, Comparable {
        case needsYou = 0, working, toReview
        static func < (a: Kind, b: Kind) -> Bool { a.rawValue < b.rawValue }
    }

    let chat: Chat
    let kind: Kind
    /// One line under the name — the question, what it is doing, or what it said.
    let line: String
    /// The card to answer, when `kind == .needsYou`.
    let card: OptionCard?

    var id: String { chat.id }
}

extension CompanionState {
    var updates: [ChatUpdate] {
        var out: [ChatUpdate] = []
        var seen = Set<String>()

        // Newest approval first, one per chat: the pill headlines the most
        // recent thing that stopped, and the sheet lists the rest.
        for pending in pendingApprovals {
            guard let chat = chat(forThread: pending.threadId), seen.insert(chat.id).inserted else { continue }
            let card = pending.message.card
            out.append(ChatUpdate(chat: chat, kind: .needsYou, line: card?.subtitle ?? card?.title ?? "", card: card))
        }

        for bot in bots where bot.hidden != true {
            let chat = Chat.bot(bot)
            guard !seen.contains(chat.id) else { continue }
            if bot.busy == true {
                seen.insert(chat.id)
                out.append(ChatUpdate(chat: chat, kind: .working, line: workingLine(chat: chat), card: nil))
            } else if bot.unread {
                seen.insert(chat.id)
                out.append(ChatUpdate(chat: chat, kind: .toReview, line: lastLine(chat: chat), card: nil))
            }
        }
        for room in rooms {
            let chat = Chat.room(room)
            guard !seen.contains(chat.id) else { continue }
            if room.busyBotId != nil {
                seen.insert(chat.id)
                out.append(ChatUpdate(chat: chat, kind: .working, line: workingLine(chat: chat), card: nil))
            } else if room.unread {
                seen.insert(chat.id)
                out.append(ChatUpdate(chat: chat, kind: .toReview, line: lastLine(chat: chat), card: nil))
            }
        }
        return out.sorted { $0.kind < $1.kind }
    }

    func chat(forThread threadId: String) -> Chat? {
        if let bot = bot(forThread: threadId) { return .bot(bot) }
        if let room = room(forThread: threadId) { return .room(room) }
        return nil
    }

    private func workingLine(chat: Chat) -> String {
        let threadIds: [String]
        switch chat {
        case let .bot(bot): threadIds = [bot.threadId] + (bot.tasks ?? []).map(\.threadId)
        case let .room(room): threadIds = [room.threadId]
        }
        
        for threadId in threadIds {
            if let live = streaming[threadId], !live.isEmpty {
                return String(live.suffix(120)).replacingOccurrences(of: "\n", with: " ")
            }
        }
        
        let last = newestLoadedMessage(for: chat)
        if let last = last, last.kind == .activity, let tool = last.tool {
            return tool.name
        }
        return "Working…"
    }

    private func lastLine(chat: Chat) -> String {
        guard let last = newestLoadedMessage(for: chat) else { return "" }
        switch last.kind {
        case .text, .unknown: return last.text ?? ""
        case .options: return last.card?.title ?? ""
        case .activity: return last.tool?.name ?? ""
        case .screen: return "Screenshot"
        }
    }
}
