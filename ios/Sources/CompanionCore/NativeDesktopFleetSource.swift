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
/// same `Bot` the harness sends, and its main thread's newest page of
/// transcript is attached the way a harness snapshot attaches it, with
/// `hasMore` saying whether older messages exist.  Messages are the
/// dispatcher's `MessageRecord`s in the shape the window folds: `assistant`
/// reads as the bot, times become milliseconds.
/// `settledFrames(threadId:)` is the `settled` hook
/// `NativeDesktopChatFrames.frames(from:threadId:settled:)` takes, so a
/// finished turn's stored reply lands before the live bubble clears.
///
/// Reads go one after another: `DatabaseService` is an actor over one
/// SQLite connection, so concurrent reads would queue on it anyway.
public struct NativeDesktopFleetSource: Sendable {
    /// How many of a thread's newest messages one read returns.
    public static let pageSize = 100

    private let database: DatabaseService

    public init(database: DatabaseService) {
        self.database = database
    }

    /// Every stored bot whose record decodes as a `Bot`, each with its main
    /// thread's newest stored messages.  A record that does not decode,
    /// names another bot's id, or whose transcript cannot be read is left
    /// out and named in `skipped`, never guessed at, and never costs the
    /// rest of the fleet.
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
            do {
                let page = try await recentTranscript(threadId: bot.threadId)
                bot.messages = page.messages
                bot.hasMore = page.hasMore
            } catch {
                skipped.append(NativeDesktopFleetSkip(
                    botId: record.id, reason: "the stored transcript cannot be read"
                ))
                continue
            }
            bots.append(bot)
        }
        return NativeDesktopFleetSnapshot(fleet: Fleet(bots: bots, groups: []), skipped: skipped)
    }

    /// The thread's newest stored messages as `.message` frames, oldest
    /// first, so the reply a turn just stored is always among them.  A store
    /// that cannot be read gives no frames: the turn still ends, and the
    /// next snapshot reconciles the transcript.
    public func settledFrames(threadId: String) async -> [Frame] {
        guard let page = try? await recentTranscript(threadId: threadId) else { return [] }
        return page.messages.map { Frame.message(threadId: threadId, message: $0) }
    }

    func recentTranscript(threadId: String) async throws -> (messages: [Message], hasMore: Bool) {
        let page = try await database.loadRecentMessages(forThread: threadId, limit: Self.pageSize)
        let messages = page.messages
            .compactMap(Self.message(from:))
            .sorted { $0.at == $1.at ? $0.id < $1.id : $0.at < $1.at }
        return (messages, page.hasMore)
    }

    /// One stored message in the window's shape, or nil when it cannot be
    /// read as one.  A stored kind left empty reads as text, the kind every
    /// dispatcher-written message has.
    static func message(from record: MessageRecord) -> Message? {
        let kind = record.kind.trimmingCharacters(in: .whitespacesAndNewlines)
        let json: [String: Any] = [
            "id": record.id,
            "at": record.createdAt * 1000,
            "role": role(fromStored: record.role),
            "kind": kind.isEmpty ? "text" : kind,
            "text": record.content
        ]
        guard JSONSerialization.isValidJSONObject(json),
              let data = try? JSONSerialization.data(withJSONObject: json) else { return nil }
        return try? JSONDecoder().decode(Message.self, from: data)
    }

    /// The dispatcher stores `user` and `assistant`; the window says `user`
    /// and `bot`.  Anything else that is not `system` reads as the bot,
    /// never as the person, for the reason `Message.Role` gives.
    private static func role(fromStored stored: String) -> String {
        switch stored {
        case "user": return "user"
        case "system": return "system"
        default: return "bot"
        }
    }
}
