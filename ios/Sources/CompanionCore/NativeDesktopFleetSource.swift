import Foundation

/// A stored bot the window could not show, and why.
public struct NativeDesktopFleetSkip: Equatable, Sendable {
    public let botId: String
    public let reason: String

    public init(botId: String, reason: String) {
        self.botId = botId
        self.reason = reason
    }
}

/// What the native store gives the window: the fleet `CompanionState.hydrate`
/// takes, and the stored bots left out of it.
public struct NativeDesktopFleetSnapshot: Sendable {
    public let fleet: Fleet
    public let skipped: [NativeDesktopFleetSkip]
}

/// The Mac app's window contents when This Mac runs on the native engine
/// (`BF-2705`, slice 2b), read from the native store instead of the Node
/// harness's `GET /api/fleet` and event stream.
///
/// A stored bot's record is the harness's own bot JSON, so it decodes as the
/// same `Bot` the harness sends, and its main thread's transcript is attached
/// the way a harness snapshot attaches it.  Messages are the dispatcher's
/// `MessageRecord`s in the shape the window folds: `assistant` reads as the
/// bot, times become milliseconds.  `settledFrames(threadId:)` is the
/// `settled` hook `NativeDesktopChatFrames.frames(from:threadId:settled:)`
/// takes, so a finished turn's stored reply lands before the live bubble
/// clears.
public struct NativeDesktopFleetSource: Sendable {
    private let database: DatabaseService

    public init(database: DatabaseService) {
        self.database = database
    }

    /// Every stored bot whose record decodes as a `Bot`, each with its main
    /// thread's stored transcript.  A record that does not decode, or names
    /// another bot's id, is left out and named in `skipped`, never guessed
    /// at.
    public func snapshot() async throws -> NativeDesktopFleetSnapshot {
        let records = try await database.loadBots()
        let decoder = JSONDecoder()
        var bots: [Bot] = []
        var skipped: [NativeDesktopFleetSkip] = []
        for record in records {
            guard let data = record.rawJSON.data(using: .utf8),
                  var bot = try? decoder.decode(Bot.self, from: data) else {
                skipped.append(NativeDesktopFleetSkip(
                    botId: record.id, reason: "the stored record does not decode as a bot"
                ))
                continue
            }
            guard bot.id == record.id else {
                skipped.append(NativeDesktopFleetSkip(
                    botId: record.id, reason: "the stored record names another bot id"
                ))
                continue
            }
            bot.messages = try await transcript(threadId: bot.threadId)
            bot.hasMore = false
            bots.append(bot)
        }
        return NativeDesktopFleetSnapshot(fleet: Fleet(bots: bots, groups: []), skipped: skipped)
    }

    /// The thread's stored transcript as `.message` frames, oldest first.  A
    /// store that cannot be read gives no frames: the turn still ends, and
    /// the next snapshot reconciles the transcript.
    public func settledFrames(threadId: String) async -> [Frame] {
        guard let messages = try? await transcript(threadId: threadId) else { return [] }
        return messages.map { Frame.message(threadId: threadId, message: $0) }
    }

    func transcript(threadId: String) async throws -> [Message] {
        try await database.loadMessages(forThread: threadId)
            .compactMap(Self.message(from:))
            .sorted { $0.at == $1.at ? $0.id < $1.id : $0.at < $1.at }
    }

    /// One stored message in the window's shape, or nil when it cannot be
    /// read as one.
    static func message(from record: MessageRecord) -> Message? {
        var json: [String: Any] = ["id": record.id, "at": record.createdAt * 1000]
        json["role"] = role(fromStored: record.role)
        json["kind"] = record.kind
        if json["kind"] == nil { json["kind"] = "text" }
        json["text"] = record.content
        guard JSONSerialization.isValidJSONObject(json),
              let data = try? JSONSerialization.data(withJSONObject: json) else { return nil }
        return try? JSONDecoder().decode(Message.self, from: data)
    }

    /// The dispatcher stores `user` and `assistant`; the window says `user`
    /// and `bot`.  Anything else that is not `system` reads as the bot,
    /// never as the person, for the reason `Message.Role` gives.
    private static func role(fromStored stored: String?) -> String {
        switch stored {
        case "user": return "user"
        case "system": return "system"
        default: return "bot"
        }
    }
}
