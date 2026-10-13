// Roster organization from the phone: Archive and Restore, Pin, Mark As
// Unread, Make Chief Of Staff, Move To Section, Pin Message, and Delete.
//
// The desktop sidebar's bot menu (`BotContextMenu` in
// src/components/Sidebar.tsx) is the reference for every rule here.  The
// harness is the authority on what gets stored, but it does not enforce two
// rules the desktop enforces in its menu: keep at least one active bot, and
// only make a bot Chief of Staff when its engine can coordinate the others.
// The phone has to hold those itself, so they live here, where they are
// tested, and the views only ask.
//
// The bot PATCH reaches the harness through the paired sidecar, which refuses
// any body that names a field outside the six this file encodes
// (`COMPANION_BOT_ORGANIZE_FIELDS` in companion/src/routes.ts).
import Foundation

/// One message pin: pin this id, or unpin.  Unpinning is sent as JSON null.
public enum MessagePin: Equatable, Sendable {
    case set(String)
    case clear

    /// A missing or empty id unpins, the same way the harness reads it.
    public init(_ messageId: String?) {
        if let messageId, !messageId.isEmpty {
            self = .set(messageId)
        } else {
            self = .clear
        }
    }
}

/// The body of `PATCH /api/bots/:id` from the phone.  `nil` leaves a field
/// alone, so each action sends only the one field it owns and cannot
/// overwrite a change another device made meanwhile.
public struct BotOrganizePatch: Encodable, Equatable, Sendable {
    /// True archives the bot, false restores it.
    public var hidden: Bool?
    public var pinned: Bool?
    public var unread: Bool?
    public var chiefOfStaff: Bool?
    /// `.clear` sends JSON null, which takes the bot out of its section.
    public var section: BotProfilePatch.SectionString?
    public var pinnedMessageId: MessagePin?

    public init(
        hidden: Bool? = nil,
        pinned: Bool? = nil,
        unread: Bool? = nil,
        chiefOfStaff: Bool? = nil,
        section: BotProfilePatch.SectionString? = nil,
        pinnedMessageId: MessagePin? = nil
    ) {
        self.hidden = hidden
        self.pinned = pinned
        self.unread = unread
        self.chiefOfStaff = chiefOfStaff
        self.section = section
        self.pinnedMessageId = pinnedMessageId
    }

    /// The sidecar answers an empty body with "nothing to save", so a caller
    /// with nothing to change must not send one.
    public var isEmpty: Bool {
        hidden == nil && pinned == nil && unread == nil && chiefOfStaff == nil
            && section == nil && pinnedMessageId == nil
    }

    public static let archive = BotOrganizePatch(hidden: true)
    public static let restore = BotOrganizePatch(hidden: false)
    public static let markUnread = BotOrganizePatch(unread: true)

    public static func pin(_ pinned: Bool) -> BotOrganizePatch {
        BotOrganizePatch(pinned: pinned)
    }

    public static func chiefOfStaff(_ chief: Bool) -> BotOrganizePatch {
        BotOrganizePatch(chiefOfStaff: chief)
    }

    /// A blank name takes the bot out of its section, as the harness does.
    public static func moveToSection(_ section: String?) -> BotOrganizePatch {
        if let name = BotOrganize.normalizedSection(section) {
            return BotOrganizePatch(section: .set(name))
        }
        return BotOrganizePatch(section: .clear)
    }

    public static func pinMessage(_ messageId: String?) -> BotOrganizePatch {
        BotOrganizePatch(pinnedMessageId: MessagePin(messageId))
    }

    /// Every key this body can ever carry.  The sidecar's allowlist is exactly
    /// this set; a test pins the two together.
    public enum CodingKeys: String, CodingKey, CaseIterable {
        case hidden, pinned, unread, chiefOfStaff, section, pinnedMessageId
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encodeIfPresent(hidden, forKey: .hidden)
        try values.encodeIfPresent(pinned, forKey: .pinned)
        try values.encodeIfPresent(unread, forKey: .unread)
        try values.encodeIfPresent(chiefOfStaff, forKey: .chiefOfStaff)
        if let section {
            switch section {
            case let .set(name): try values.encode(name, forKey: .section)
            case .clear: try values.encodeNil(forKey: .section)
            }
        }
        if let pinnedMessageId {
            switch pinnedMessageId {
            case let .set(id): try values.encode(id, forKey: .pinnedMessageId)
            case .clear: try values.encodeNil(forKey: .pinnedMessageId)
            }
        }
    }
}

/// What a delete confirmation says.  Built here so the words are tested.
public struct DeleteConfirmation: Equatable, Sendable {
    public let title: String
    public let confirmLabel: String
    public let message: String

    public init(title: String, confirmLabel: String, message: String) {
        self.title = title
        self.confirmLabel = confirmLabel
        self.message = message
    }
}

public enum BotOrganize {
    /// The harness refuses a longer section name.  It measures JavaScript
    /// string length, which counts UTF-16 units, so this does too.
    public static let sectionMaxLength = 60

    public static let chiefNeedsCoordination = "Choose an engine with coordination first"
    public static let archiveChiefFirst = "Choose another Chief of Staff first"
    public static let archiveKeepOneBot = "Keep at least one active bot"

    /// Between sentences in user-visible copy: a non-breaking space and a
    /// space, so the gap survives SwiftUI's text layout.
    static let sentenceGap = "\u{00A0} "

    // MARK: - Archive

    /// Why Archive is off for this bot, or nil when it may be archived.  The
    /// Chief of Staff has to be replaced first (the harness refuses too), and
    /// the last active bot stays, as on the desktop.
    public static func archiveBlockReason(for bot: Bot, among bots: [Bot]) -> String? {
        if bot.chiefOfStaff == true { return archiveChiefFirst }
        let active = bots.filter { $0.hidden != true }.count
        if active <= 1 { return archiveKeepOneBot }
        return nil
    }

    /// Archived bots, by name, for the Archived Bots list.  Restore needs no
    /// rule: an archived bot may always come back.
    public static func archivedBots(_ bots: [Bot]) -> [Bot] {
        bots.filter { $0.hidden == true }.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    // MARK: - Chief of Staff

    /// Whether the bot's engine can reach the other bots.  An engine the
    /// roster does not list yet reads as no, so the item stays off until the
    /// engine list has loaded rather than offering something the bot cannot do.
    public static func canCoordinate(_ bot: Bot, instances: [Instance]) -> Bool {
        instances.first { $0.instanceId == bot.modelSelection.instanceId }?.capabilities?.agentsMcp == true
    }

    /// Why Make Chief Of Staff is off, or nil when it may be chosen.  Removing
    /// the role is never blocked.
    public static func makeChiefBlockReason(for bot: Bot, instances: [Instance]) -> String? {
        if bot.chiefOfStaff == true { return nil }
        return canCoordinate(bot, instances: instances) ? nil : chiefNeedsCoordination
    }

    /// The bots the harness demotes when `chief` takes the role: any other
    /// Chief of Staff in the same section.  The harness also sends each of
    /// them as its own `bot` frame; applying these first means the roster
    /// never shows two at once.  Transcripts are dropped from the copies, so
    /// folding them in can never replace a thread's scrollback.
    public static func demotedChiefs(after chief: Bot, in bots: [Bot]) -> [Bot] {
        guard chief.chiefOfStaff == true else { return [] }
        let section = normalizedSection(chief.section) ?? ""
        return bots.compactMap { bot in
            guard bot.id != chief.id,
                  bot.chiefOfStaff == true,
                  (normalizedSection(bot.section) ?? "") == section
            else { return nil }
            var demoted = bot
            demoted.chiefOfStaff = false
            demoted.messages = nil
            demoted.hasMore = nil
            return demoted
        }
    }

    /// What to fold into the roster once a bot PATCH has answered: the Chief
    /// of Staff it demoted, then the bot itself.  Empty when the bot is no
    /// longer in the roster.  A `bot.deleted` frame can land while the request
    /// is in flight, and applying the answer would put a deleted bot back, the
    /// same guard the room PATCH has before it applies its reply.
    public static func botsToApply(after updated: Bot, in bots: [Bot]) -> [Bot] {
        guard bots.contains(where: { $0.id == updated.id }) else { return [] }
        return demotedChiefs(after: updated, in: bots) + [updated]
    }

    // MARK: - Sections

    /// A stored section, trimmed; nil for none.
    public static func normalizedSection(_ section: String?) -> String? {
        guard let trimmed = section?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    /// The name a typed section becomes, or nil when it cannot be created:
    /// blank, or longer than the harness accepts.
    public static func sectionName(from raw: String) -> String? {
        guard let name = normalizedSection(raw), name.utf16.count <= sectionMaxLength else { return nil }
        return name
    }

    /// Typed text held to the length the harness accepts, cut on a whole
    /// character so an emoji is never split.
    public static func cappedSectionInput(_ raw: String) -> String {
        guard raw.utf16.count > sectionMaxLength else { return raw }
        var capped = ""
        var units = 0
        for character in raw {
            let width = String(character).utf16.count
            if units + width > sectionMaxLength { break }
            capped.append(character)
            units += width
        }
        return capped
    }

    /// The sections already in use, in the roster's order: the Mac's saved
    /// order first, then the rest by name.  Archived bots and bot-to-bot
    /// chats do not count, because neither shows in a section.
    public static func sectionNames(bots: [Bot], rooms: [Room], order: [String]) -> [String] {
        var names = Set<String>()
        for bot in bots where bot.hidden != true {
            if let name = normalizedSection(bot.section) { names.insert(name) }
        }
        for room in rooms where !room.isBotToBot {
            if let name = normalizedSection(room.section) { names.insert(name) }
        }
        var result: [String] = []
        for name in order where names.contains(name) {
            result.append(name)
            names.remove(name)
        }
        result.append(contentsOf: names.sorted())
        return result
    }

    // MARK: - Delete

    /// Written from what the harness does on delete: it stops a running
    /// turn, deletes every task transcript, removes the bot's computers, and
    /// turns off its routines, webhooks and triggers.
    public static func deleteBotConfirmation(name: String) -> DeleteConfirmation {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let who = trimmed.isEmpty ? "this bot" : trimmed
        let gap = sentenceGap
        return DeleteConfirmation(
            title: trimmed.isEmpty ? "Delete Bot?" : "Delete \(trimmed)?",
            confirmLabel: "Delete Bot",
            message: "Every conversation and task with \(who) is deleted for good, along with its computers, routines, webhooks and triggers."
                + "\(gap)A turn in progress is stopped."
                + "\(gap)This cannot be undone."
                + "\(gap)Archive it instead to keep the history."
        )
    }

    /// A room's delete removes its transcripts and tasks; its bots stay.
    /// `roomTerm` is the workspace's word for a room, such as Channel.
    public static func deleteRoomConfirmation(name: String, roomTerm: String) -> DeleteConfirmation {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let termTrimmed = roomTerm.trimmingCharacters(in: .whitespacesAndNewlines)
        let term = termTrimmed.isEmpty ? "Channel" : termTrimmed
        let label = term.prefix(1).uppercased() + term.dropFirst()
        let gap = sentenceGap
        return DeleteConfirmation(
            title: trimmed.isEmpty ? "Delete \(label)?" : "Delete \(trimmed)?",
            confirmLabel: "Delete \(label)",
            message: "Every conversation in this \(term.lowercased()) is deleted for good."
                + "\(gap)The bots in it are not affected."
                + "\(gap)This cannot be undone."
        )
    }

    // MARK: - Pinned message

    /// A message the harness will accept as a pin: settled text with an id
    /// of the shape it checks.  A row still waiting to send is drawn from a
    /// local id the harness never stored, so it cannot be pinned.
    public static func canPin(_ message: Message) -> Bool {
        guard message.kind == .text, isMessageId(message.id) else { return false }
        if let queueId = message.queueId, queueId == message.id { return false }
        return !pinnedText(message).isEmpty
    }

    /// The pinned message, when it is loaded and still text.  A pin whose
    /// message was deleted, edited away, or is not on this page resolves to
    /// nothing, and the banner is not drawn.
    public static func pinnedMessage(id: String?, in messages: [Message]) -> Message? {
        guard let id, !id.isEmpty else { return nil }
        guard let message = messages.first(where: { $0.id == id }), message.kind == .text else { return nil }
        return pinnedText(message).isEmpty ? nil : message
    }

    /// The pinned text on one line.
    public static func pinnedText(_ message: Message) -> String {
        (message.text ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// Who said the pinned message.  Another bot's line in a room arrives as
    /// a user message with a sender, so "You" is only what the person typed.
    public static func pinnedSender(_ message: Message, chatName: String?) -> String {
        if message.role == .user && message.from == nil { return "You" }
        if let name = message.from?.name, !name.isEmpty { return name }
        if let chatName, !chatName.isEmpty { return chatName }
        return "A bot"
    }

    /// `[\w-]+`, as both the sidecar and the harness check it.
    static func isMessageId(_ id: String) -> Bool {
        guard !id.isEmpty else { return false }
        return id.unicodeScalars.allSatisfy { scalar in
            switch scalar {
            case "a"..."z", "A"..."Z", "0"..."9", "_", "-": return true
            default: return false
            }
        }
    }

    // MARK: - Open chat

    /// The bot a chat screen shows is deleted or archived, so the screen
    /// should close rather than sit on a chat that is no longer in the list.
    public static func isBotGone(_ id: String, in bots: [Bot]) -> Bool {
        guard let bot = bots.first(where: { $0.id == id }) else { return true }
        return bot.hidden == true
    }

    public static func isRoomGone(_ id: String, in rooms: [Room]) -> Bool {
        !rooms.contains { $0.id == id }
    }
}
