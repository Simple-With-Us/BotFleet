// The harness's wire types, in Swift.
//
// These mirror `server/store.ts` and the payloads in `server/index.ts`.
// There is no shared type system across the two languages, so the contract
// is pinned by fixtures instead: `Tests/CompanionCoreTests/Fixtures` holds
// real responses captured from a running server, and the decoding tests
// read them. When the server changes a payload, a test here fails.
//
// Everything the server may omit is optional, and nothing is decoded more
// strictly than it has to be — a phone that refuses to show a conversation
// because one message gained a field is worse than one that ignores it.
import Foundation

// MARK: - Messages

public struct OptionCard: Codable, Hashable, Sendable {
    public var title: String
    public var subtitle: String
    public var options: [String]
    public var answered: String?
    public var dismissed: Bool?
    /// Present when this card is a live provider ask — the thing that makes
    /// it answerable rather than historical.
    public var requestId: String?
    public var tool: String?
    /// Why auto mode stopped to ask anyway.
    public var held: String?
    /// The narrow grant "always allow" would remember, e.g. `Bash:git`.
    public var allowKey: String?

    /// A card is actionable while it is unanswered and still has a request
    /// behind it. Everything else is transcript.
    public var isPending: Bool {
        requestId != nil && answered == nil && dismissed != true
    }

    /// Permission cards carry a tool; questions do not.
    public var isPermission: Bool { tool != nil }

    /// The wire API accepts an approval behavior rather than the button's
    /// display text. Treat the one refusal as deny and every other offered
    /// permission choice as allow: providers may say "Approve", "Yes", or
    /// "Always allow", and none of those should accidentally become a deny.
    public func responseBehavior(for choice: String) -> String {
        Self.responseBehavior(for: choice, isPermission: isPermission)
    }

    /// The ID-only form is used by Live Activity buttons, which carry the
    /// card kind but not the full card payload.
    public static func responseBehavior(for choice: String, isPermission: Bool) -> String {
        guard isPermission else { return "answer" }
        return isRefusal(choice) ? "deny" : "allow"
    }

    /// Shared by all of the app's card surfaces and by Live Activities.
    public static func isRefusal(_ choice: String) -> Bool {
        choice.trimmingCharacters(in: .whitespacesAndNewlines)
            .caseInsensitiveCompare("Deny") == .orderedSame
    }

    /// A provider can call its positive choice "Always allow", but the paired
    /// route supports only the current request.  Keep the provider's wire
    /// choice for the response while giving every phone surface honest copy.
    public func displayChoice(for choice: String) -> String {
        guard isPermission else { return choice }
        let normalized = choice.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.caseInsensitiveCompare("Always allow") == .orderedSame ? "Allow once" : choice
    }
}

public struct ToolActivity: Codable, Hashable, Sendable {
    public var name: String
    public var ok: Bool?
    /// The same chip as a phrase a voice can read.
    public var spoken: String?
    /// Marks an error fixed by installing something, not by retrying.
    public var setup: Bool?
}

public struct Sender: Codable, Hashable, Sendable {
    public var botId: String
    public var name: String
    public var color: String
}

public struct Reaction: Codable, Hashable, Sendable {
    public var emoji: String
    public var by: String
}

public struct CommChip: Codable, Hashable, Sendable {
    public var groupId: String
    public var withBotId: String
    public var withName: String
    public var withColor: String
}

public struct Message: Codable, Hashable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case text, options, activity, screen
        /// A kind this build has never heard of.
        ///
        /// Not decorative. `kind` is not optional, so without this a single
        /// unrecognised message fails the decode of the whole response it
        /// arrived in — the thread does not render one message oddly, it
        /// does not render. The harness gains message kinds on its own
        /// schedule and the phone is updated on the App Store's, so "newer
        /// computer than phone" is the normal state of things, not an edge
        /// case. Degrading to the text a message carries is worth more than
        /// being right about its shape.
        case unknown

        public init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .unknown
        }
    }

    public enum Role: String, Codable, Sendable {
        case bot, user
        /// Auto-delivered instructions (routine, webhook, resource).  Never
        /// a person typing.  Older phones that lack this case fall through
        /// the decoder to `.bot`, which is left-aligned and not blue.
        case system

        /// Same reasoning, and `bot` rather than a third case: an unplaceable
        /// message drawn as yours would be the phone claiming you said
        /// something you did not.
        public init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Role(rawValue: raw) ?? .bot
        }
    }

    public var id: String
    public var role: Role
    public var kind: Kind
    public var at: Double
    public var text: String?
    /// For a `role == .system` message: what actually fired it —
    /// "schedule", "manual", "webhook", or "resource". Raw string (not an
    /// enum) so an older phone that predates a new trigger kind still
    /// decodes the message; absent on rows persisted before this field
    /// existed.
    public var automationSource: String? = nil
    public var card: OptionCard?
    public var tool: ToolActivity?
    /// The message this one follows; nil at the thread root. Two messages
    /// sharing a parent are a fork.
    public var parentId: String?
    /// Rooms: which member said this.
    public var from: Sender?
    public var reactions: [Reaction]?
    public var comm: CommChip?
    /// Screen messages in the paged shape: the pixels live behind
    /// `/api/threads/:threadId/messages/:id/image` rather than inline.
    public var hasImage: Bool?
    /// Screen messages in the full shape: base64 pixels, inline.
    public var png: String?
    public var mime: String?
    /// Identity of a steer-queue entry. The 202 busy-send body carries this
    /// as `queueId`; drain stamps the same value on the real user line so
    /// the pending chip can retire. Absent on ordinary messages.
    public var queueId: String? = nil
    /// Client-only: this row is still waiting in the in-memory steer-queue
    /// and has not been appended to the transcript yet.
    public var queued: Bool? = nil
    /// User line that landed inside a running turn (server `steered: true`).
    /// Shown as the "Sent mid-turn" chip; distinct from the pending queue.
    public var steered: Bool? = nil

    public var date: Date { Date(timeIntervalSince1970: at / 1000) }
}

/// One send the phone is holding until the stream appends it.
///
/// Busy-bot 202 rows use `queued == true` and keep the clock chip.
/// Ordinary sends use `queued == false` so the user's own bubble is on
/// screen the moment they tap send, without claiming the steer-queue.
public struct QueuedSend: Hashable, Sendable {
    public var queueId: String
    public var text: String
    public var queued: Bool

    public init(queueId: String, text: String, queued: Bool = true) {
        self.queueId = queueId
        self.text = text
        self.queued = queued
    }
}

/// Body of `POST /api/bots/:id/messages`. A live send is `{ok:true}`; a
/// busy bot is `{ok:true, queued:true, queueId, threadId}`.
public struct SendMessageResult: Codable, Hashable, Sendable {
    public var ok: Bool?
    public var queued: Bool?
    public var steered: Bool?
    public var queueId: String?
    public var threadId: String?
}

// MARK: - Bots and rooms

public struct ModelSelection: Codable, Hashable, Sendable {
    public var instanceId: String
    public var model: String
    /// Kept as a string so a newer server's saved value still round-trips
    /// through an older phone until the person explicitly changes it.
    public var effort: String?
    public var fallbacks: [ModelSelection]?

    public init(instanceId: String, model: String, effort: String? = nil, fallbacks: [ModelSelection]? = nil) {
        self.instanceId = instanceId
        self.model = model
        self.effort = effort
        self.fallbacks = fallbacks
    }
}

public struct TaskUsage: Codable, Hashable, Sendable {
    public var input: Int
    public var output: Int
    public var cachedInput: Int?
    public var costUsd: Double?
    public var turns: Int
}

public struct BotTask: Codable, Hashable, Sendable {
    public var threadId: String
    public var title: String
    public var createdAt: Double
    /// Last message in this task's thread. Absent on older harnesses.
    public var lastActivity: Double?
    public var lastMessage: Message?
    public var usage: TaskUsage?
    public var modelSelection: ModelSelection?
}

public struct Bot: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var threadId: String
    public var name: String
    public var title: String
    public var description: String
    public var notifications: Bool
    public var color: String
    /// An app-owned `/api/attachments/:name` URL. The URL is intentionally
    /// relative so every paired device fetches it from its own computer.
    public var avatarUrl: String?
    /// `mascot` ignores `avatarUrl`; the other values describe the image mask.
    public var avatarCrop: AvatarCrop?
    public var unread: Bool
    public var modelSelection: ModelSelection
    public var createdAt: Double
    public var busy: Bool?
    public var pinned: Bool?
    public var hidden: Bool?
    public var chiefOfStaff: Bool?
    public var approvePeerComms: Bool?
    public var section: String?
    public var autoApprove: Bool?
    public var autoReview: String?
    public var alwaysAllow: [String]?
    public var composio: Bool?
    /// Which computers this bot may run on: "local", "cloud", and/or "vm".
    /// Absent means the harness predates multi-computer bots.
    public var computers: [String]?
    /// Which cloud computer backs a bot whose `computers` include "cloud".
    /// Absent (older harnesses included) means the hosted Box; "vps" means
    /// the user's own server, which has no interactive desktop to offer a
    /// phone.
    public var cloudBackend: String?
    public var autoStartVps: Bool?
    public var cwd: String?
    public var extraCwds: [String]?
    public var userNotes: String?
    public var speakReplies: Bool?
    public var voice: String?
    public var mascotExpression: String?
    public var tasks: [BotTask]?
    public var messages: [Message]?
    public var activeLeafId: String?
    /// Paged responses only: there is more transcript above what you got.
    public var hasMore: Bool?
}

public enum AvatarCrop: String, Codable, CaseIterable, Hashable, Sendable {
    case mascot, circle, rounded, square

    /// The desktop may gain crop modes before this app updates. Falling back
    /// keeps the complete bot/fleet payload decodable and guarantees a safe,
    /// deterministic identity image instead of dropping the agent.
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .mascot
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public struct GroupResponder: Codable, Hashable, Sendable {
    public var kind: String
    public var botId: String?

    // Memberwise initializers are internal to the module; the App target
    // builds a responder from its picker state, so expose one publicly.
    public init(kind: String, botId: String? = nil) {
        self.kind = kind
        self.botId = botId
    }
}

public struct Room: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var threadId: String
    public var name: String
    public var memberIds: [String]
    public var defaultResponder: GroupResponder
    public var bulletin: String
    public var unread: Bool
    public var createdAt: Double
    public var dm: Bool?
    public var avatarUrl: String?
    public var section: String?
    public var avatarCrop: AvatarCrop?
    public var cwd: String?
    public var extraCwds: [String]?
    public var busyBotId: String?
    /// Covers the whole room operation, including setup and handoff windows
    /// where no individual responder owns the provider turn yet.
    public var working: Bool?
    public var messages: [Message]?
    public var hasMore: Bool?

    /// Older harnesses expose only `busyBotId`; current ones send `working`.
    public var isWorking: Bool { working ?? (busyBotId != nil) }

    /// Bot-to-bot DMs are not user rooms.  They belong under Bot Chats.
    public var isBotToBot: Bool { dm == true }
}

// MARK: - Responses

private struct Lossy<Element: Decodable>: Decodable {
    let value: Element?

    init(from decoder: Decoder) throws {
        value = try? Element(from: decoder)
    }
}

public struct Fleet: Decodable, Sendable {
    public var bots: [Bot]
    public var groups: [Room]

    private enum CodingKeys: String, CodingKey { case bots, groups }

    public init(bots: [Bot], groups: [Room]) {
        self.bots = bots
        self.groups = groups
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        bots = try container.decodeIfPresent([Lossy<Bot>].self, forKey: .bots)?.compactMap(\.value) ?? []
        groups = try container.decodeIfPresent([Lossy<Room>].self, forKey: .groups)?.compactMap(\.value) ?? []
    }
}

public struct ThreadPage: Codable, Sendable {
    public var messages: [Message]
    public var hasMore: Bool?
}

public struct SearchHit: Codable, Hashable, Identifiable, Sendable {
    public var threadId: String
    public var messageId: String
    public var at: Double
    public var role: Message.Role
    public var kind: Message.Kind
    public var snippet: String
    public var matchStart: Int
    public var matchLength: Int
    public var botId: String?
    public var groupId: String?
    public var name: String
    /// Attribution for the hit (e.g. "Scheduled Run" for system/automation
    /// starters).  Absent on older servers; Codable ignores unknown keys and
    /// older clients ignore this field.
    public var from: String?
    public var task: String?
    public var onActivePath: Bool

    public var id: String { "\(threadId):\(messageId)" }
}

public struct TranscriptExport: Sendable {
    public var data: Data
    public var filename: String
    public var contentType: String

    public init(data: Data, filename: String, contentType: String) {
        self.data = data
        self.filename = filename
        self.contentType = contentType
    }
}

public struct PairedDevice: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var createdAt: Double
    public var lastSeenAt: Double
}

public struct PairResponse: Codable, Sendable {
    public var token: String
    public var device: PairedDevice
    /// What the computer calls itself — worth showing so someone with two
    /// paired machines can tell them apart.
    public var serverName: String
    /// Every address the computer answers on, best first. Stored with the
    /// connection so the app can walk to the next one when the address it
    /// paired on stops resolving. Absent from older sidecars.
    public var hosts: [String]?
    /// Full HTTPS/HTTP routes from newer sidecars. Absent during a staggered
    /// rollout; `hosts` remains the compatibility path for older builds.
    public var endpoints: [CompanionEndpoint]?

    private enum CodingKeys: String, CodingKey {
        case token, device, serverName, hosts, endpoints
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        token = try container.decode(String.self, forKey: .token)
        device = try container.decode(PairedDevice.self, forKey: .device)
        serverName = try container.decode(String.self, forKey: .serverName)
        hosts = try container.decodeIfPresent([String].self, forKey: .hosts)
        if container.contains(.endpoints) {
            // These routes are advisory and the credential may already have
            // been redeemed. One malformed or future-kind entry must not
            // discard the valid token and legacy host fallback with it.
            endpoints = (try? container.decode([Lossy<CompanionEndpoint>].self, forKey: .endpoints))?
                .compactMap(\.value) ?? []
        } else {
            endpoints = nil
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(token, forKey: .token)
        try container.encode(device, forKey: .device)
        try container.encode(serverName, forKey: .serverName)
        try container.encodeIfPresent(hosts, forKey: .hosts)
        try container.encodeIfPresent(endpoints, forKey: .endpoints)
    }
}

/// The authenticated, refreshable connection identity advertised by the
/// companion sidecar at `GET /api/companion/endpoints`.
///
/// This intentionally mirrors only the non-secret routing subset of a pair
/// response. Existing paired phones can learn that hosted access was enabled
/// later without minting another device token or scanning another QR code.
public struct CompanionConnectionMetadata: Decodable, Sendable {
    public var serverName: String
    public var hosts: [String]?
    public var endpoints: [CompanionEndpoint]

    private enum CodingKeys: String, CodingKey { case serverName, hosts, endpoints }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        serverName = try container.decode(String.self, forKey: .serverName)
        hosts = try container.decodeIfPresent([String].self, forKey: .hosts)

        // Endpoint metadata is a replacement snapshot, not an optional hint.
        // Keep a future malformed kind from discarding valid routes beside it,
        // but reject a response with no usable route so the caller retains its
        // last known-good snapshot.
        let decoded = try container.decode([Lossy<CompanionEndpoint>].self, forKey: .endpoints)
            .compactMap(\.value)
        let stable = decoded.enumerated().sorted {
            $0.element.priority == $1.element.priority
                ? $0.offset < $1.offset
                : $0.element.priority < $1.element.priority
        }.map(\.element)
        var seen = Set<String>()
        endpoints = stable.filter { seen.insert($0.url).inserted }.prefix(8).map { $0 }
        guard !endpoints.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: .endpoints,
                in: container,
                debugDescription: "Companion endpoint metadata must contain at least one valid route."
            )
        }
    }
}

/// A freshly minted provider viewer. It is deliberately not Codable for
/// persistence: the URL is a short-lived bearer credential and belongs only
/// in memory for the browser session that requested it.
public struct CloudDesktopSession: Decodable, Sendable {
    public let url: URL

    private enum CodingKeys: String, CodingKey { case joinUrl }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let raw = try container.decode(String.self, forKey: .joinUrl)
        guard let parsed = URL(string: raw),
              parsed.scheme?.lowercased() == "https",
              parsed.host != nil
        else {
            throw DecodingError.dataCorruptedError(
                forKey: .joinUrl,
                in: container,
                debugDescription: "Cloud desktop URL must be HTTPS"
            )
        }
        url = parsed
    }
}

public struct ProviderSnapshot: Codable, Hashable, Sendable {
    public var state: String
    public var reason: String?
    public var authenticated: Bool?
    public var version: String?

    public var isAvailable: Bool { state == "available" }
}

public struct ModelOption: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var label: String
}

public struct ModelCatalog: Codable, Hashable, Sendable {
    public var `default`: String
    public var options: [ModelOption]
}

public struct InstanceCapabilities: Codable, Hashable, Sendable {
    public var effortLevels: [String]?
}

public struct Instance: Codable, Hashable, Identifiable, Sendable {
    public var instanceId: String
    public var driverKind: String
    public var displayName: String?
    public var snapshot: ProviderSnapshot
    public var models: ModelCatalog
    public var capabilities: InstanceCapabilities?

    public var id: String { instanceId }
}

public struct InstanceList: Codable, Sendable {
    public var instances: [Instance]
}

/// Which engine actually speaks — `VoiceProvider` in `server/tts/index.ts`.
/// Derived from `ConfigFlag.provider`, never decoded straight off the wire.
public enum VoiceProvider: Hashable, Sendable {
    case elevenlabs
    case system
}

public struct ConfigFlag: Codable, Hashable, Sendable {
    public var configured: Bool
    public var apiKeyConfigured: Bool?
    public var ready: Bool?
    public var voice: String?
    /// The voice engine, absent on a computer that predates the choice. Read
    /// it through `ConfigStatus.voiceProvider`, which applies the server's own
    /// fallback; nothing should compare this string directly.
    public var provider: String?
}

public struct Profile: Codable, Hashable, Sendable {
    public var name: String
    public var email: String
}

/// What this person calls a room, in both forms.  The harness resolves the
/// pair — including a custom word — so the phone never has to guess a plural.
public struct RoomLabels: Codable, Hashable, Sendable {
    public var singular: String
    public var plural: String

    public init(singular: String, plural: String) {
        self.singular = singular
        self.plural = plural
    }
}

public struct ConfigStatus: Codable, Sendable {
    public var composio: ConfigFlag?
    public var box: ConfigFlag?
    public var tts: ConfigFlag?
    public var imageGen: ConfigFlag?
    public var profile: Profile?
    public var terminology: String?
    /// The finished words, resolved by the harness so every client agrees.
    /// Absent only when talking to a harness older than this feature.
    public var roomLabels: RoomLabels?
    /// `simple` or `projects`.  Absent means simple.  A leftover `fleet`
    /// value is treated as projects.
    public var conversationMode: String?
    public var sidebarSectionOrder: [String]?

    public var isProjectsMode: Bool {
        let raw = conversationMode?.lowercased()
        return raw == "projects" || raw == "fleet"
    }

    public var allowsMultipleBotThreads: Bool { isProjectsMode }

    public var primarySingular: String { isProjectsMode ? "Thread" : "Bot" }
    public var primaryPlural: String { isProjectsMode ? "Threads" : "Bots" }
    /// The create control always mints a bot record, even in projects mode
    /// where that bot is painted as a thread.  It names what it makes.
    public var newPrimaryLabel: String { "New Bot" }

    public var roomTerminologyLabel: String {
        roomLabels?.singular ?? Self.presetLabels(terminology).singular
    }

    public var roomTerminologyPlural: String {
        roomLabels?.plural ?? Self.presetLabels(terminology).plural
    }

    /// The fallback for an older harness that sends only the key.  A word it
    /// has never heard of still renders as Channels rather than as nothing.
    static func presetLabels(_ terminology: String?) -> RoomLabels {
        switch terminology?.lowercased() {
        case "groups": return RoomLabels(singular: "Group", plural: "Groups")
        case "projects": return RoomLabels(singular: "Project", plural: "Projects")
        case "apps": return RoomLabels(singular: "App", plural: "Apps")
        case "topics": return RoomLabels(singular: "Topic", plural: "Topics")
        case "repos": return RoomLabels(singular: "Repo", plural: "Repos")
        default: return RoomLabels(singular: "Channel", plural: "Channels")
        }
    }

    /// Whether synthesis is available on the paired computer. Deliberately
    /// provider-neutral: under ElevenLabs this is a key on file, while under
    /// the built-in engine `providerConfigured` in `server/tts/index.ts`
    /// reports whether the computer has voices it can use and no credential
    /// exists at all. Only the reason behind the flag changes — so anything
    /// that *explains* a false here has to ask `voiceProvider` first.
    /// Either way the credential itself never appears in this response.
    public var isTTSConfigured: Bool {
        tts?.configured == true || tts?.apiKeyConfigured == true
    }

    /// An empty voice means there is no workspace fallback. Clients must not
    /// present that state as a usable "Workspace default" choice.
    public var hasWorkspaceDefaultVoice: Bool {
        !(tts?.voice?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    }

    public func canSpeak(agentVoice: String?) -> Bool {
        let hasAgentVoice = !(agentVoice?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
        return isTTSConfigured && (hasAgentVoice || hasWorkspaceDefaultVoice)
    }

    /// `voiceProvider(cfg)` in `server/tts/index.ts`: only the exact string
    /// `"system"` selects the built-in engine. A missing field — a computer
    /// older than the choice — and an engine this build has never heard of
    /// both fall back to ElevenLabs, which is the server's own rule and what
    /// keeps an unrecognised engine from being explained to the user with
    /// copy written for a different one.
    public var voiceProvider: VoiceProvider {
        tts?.provider == "system" ? .system : .elevenlabs
    }
}

// MARK: - Agent profiles, voices, routines, and notifications

public struct BotProfilePatch: Encodable, Sendable {
    /// `nil` means "leave the field alone". Profile actions deliberately send
    /// only the fields they own so an avatar upload cannot overwrite identity
    /// or voice values that changed on another client while the sheet was open.
    public var name: String?
    public var title: String?
    public var description: String?
    public var notifications: Bool?
    public var avatarUrl: AvatarURL?
    public var avatarCrop: AvatarCrop?
    public var voice: String?
    public var speakReplies: Bool?
    public var modelSelection: ModelSelection?
    public var section: SectionString?

    public enum SectionString: Equatable, Sendable {
        case set(String)
        case clear
    }

    /// `avatarUrl` needs three wire states: omitted, a stored path, or JSON
    /// null to clear. A nested optional would technically represent that, but
    /// makes call sites easy to get wrong (`nil` is ambiguous at a glance).
    public enum AvatarURL: Equatable, Sendable {
        case set(String)
        case clear
    }

    public init(
        name: String? = nil,
        title: String? = nil,
        description: String? = nil,
        notifications: Bool? = nil,
        avatarUrl: AvatarURL? = nil,
        avatarCrop: AvatarCrop? = nil,
        voice: String? = nil,
        speakReplies: Bool? = nil,
        modelSelection: ModelSelection? = nil,
        section: SectionString? = nil
    ) {
        self.name = name
        self.title = title
        self.description = description
        self.notifications = notifications
        self.avatarUrl = avatarUrl
        self.avatarCrop = avatarCrop
        self.voice = voice
        self.speakReplies = speakReplies
        self.modelSelection = modelSelection
        self.section = section
    }

    private enum CodingKeys: String, CodingKey {
        case name, title, description, notifications, avatarUrl, avatarCrop, voice, speakReplies, modelSelection, section
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encodeIfPresent(name, forKey: .name)
        try values.encodeIfPresent(title, forKey: .title)
        try values.encodeIfPresent(description, forKey: .description)
        try values.encodeIfPresent(notifications, forKey: .notifications)
        if let avatarUrl {
            switch avatarUrl {
            case let .set(path): try values.encode(path, forKey: .avatarUrl)
            case .clear: try values.encodeNil(forKey: .avatarUrl)
            }
        }
        try values.encodeIfPresent(avatarCrop, forKey: .avatarCrop)
        try values.encodeIfPresent(voice, forKey: .voice)
        try values.encodeIfPresent(speakReplies, forKey: .speakReplies)
        try values.encodeIfPresent(modelSelection, forKey: .modelSelection)
        if let section {
            switch section {
            case let .set(val): try values.encode(val, forKey: .section)
            case .clear: try values.encodeNil(forKey: .section)
            }
        }
    }
}

public struct Voice: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var label: String
    public var description: String?
}

public struct RoutineSchedule: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case once, daily
        /// A schedule introduced by a newer desktop. It remains visible but
        /// cannot be toggled or saved until the user chooses a supported kind.
        case unknown

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Self(rawValue: raw) ?? .unknown
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }
    public var type: Kind
    public var at: Double?
    public var time: String?
    public var weekdays: [Int]?
    public var timeZone: String?

    public init(
        type: Kind,
        at: Double? = nil,
        time: String? = nil,
        weekdays: [Int]? = nil,
        timeZone: String? = nil
    ) {
        self.type = type
        self.at = at
        self.time = time
        self.weekdays = weekdays
        self.timeZone = timeZone
    }

    public static func once(at: Date) -> Self {
        .init(type: .once, at: at.timeIntervalSince1970 * 1_000)
    }

    public static func daily(time: String, weekdays: [Int], timeZone: String? = nil) -> Self {
        .init(type: .daily, time: time, weekdays: weekdays, timeZone: timeZone)
    }
}

public func routineEditorTimeDate(_ value: String?, in timeZone: TimeZone) -> Date {
    let parts = (value ?? "09:00").split(separator: ":").compactMap { Int($0) }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    // A time-only picker needs an arbitrary backing day.  Using today can
    // normalize a stored 02:30 to 03:00 on a spring-forward day and an
    // untouched save then changes every future occurrence.
    let components = DateComponents(
        timeZone: timeZone,
        year: 2001,
        month: 1,
        day: 15,
        hour: parts.first ?? 9,
        minute: parts.count > 1 ? parts[1] : 0,
        second: 0
    )
    return calendar.date(from: components) ?? Date(timeIntervalSince1970: 978_307_200)
}

public func routineTimeZoneForUpdate(
    effectiveTimeZone: String?,
    source: String?,
    existingScheduleType: RoutineSchedule.Kind?
) -> String? {
    source == "host" && existingScheduleType == .daily ? nil : effectiveTimeZone
}

public func routineEditorTimeZoneIdentifier(
    effectiveTimeZone: String?,
    existingScheduleType: RoutineSchedule.Kind?,
    currentTimeZone: TimeZone = .current
) -> String? {
    effectiveTimeZone ?? (existingScheduleType == .daily ? nil : currentTimeZone.identifier)
}

public struct Routine: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var prompt: String
    public var botId: String
    public var runOn: String
    public var enabled: Bool
    public var schedule: RoutineSchedule
    public var scheduleTimeZoneSource: String? = nil
    public var durationMinutes: Int
    public var nextRunAt: Double?
    public var createdAt: Double
    public var updatedAt: Double
}

public struct RoutineRun: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var routineId: String
    public var routineName: String
    public var prompt: String?
    public var durationMinutes: Int?
    public var botId: String
    public var runOn: String
    public var scheduledFor: Double
    public var status: String
    public var manual: Bool
    public var triggerSource: String?
    public var threadId: String?
    public var startedAt: Double?
    public var finishedAt: Double?
    public var output: String?
    public var error: String?
    public var createdAt: Double
    public var seenAt: Double?
}

public struct RoutineInput: Encodable, Sendable {
    public var name: String
    public var prompt: String
    public var botId: String
    public var runOn: String
    public var enabled: Bool?
    public var schedule: RoutineSchedule
    public var durationMinutes: Int

    public init(
        name: String, prompt: String, botId: String, runOn: String = "maus",
        enabled: Bool? = nil, schedule: RoutineSchedule, durationMinutes: Int = 30
    ) {
        self.name = name
        self.prompt = prompt
        self.botId = botId
        self.runOn = runOn
        self.enabled = enabled
        self.schedule = schedule
        self.durationMinutes = durationMinutes
    }
}

public enum RoutineRunLocation: String, CaseIterable, Codable, Hashable, Sendable {
    case maus
    case cloud
}

/// Desktop-equivalent run-location availability, derived only from paired-safe
/// status endpoints. Selecting Cloud VM requires both the host credential and
/// an available Box agent. An existing cloud routine remains editable without
/// silently changing where it runs if that VM is temporarily unavailable.
public struct RoutineRunAvailability: Equatable, Sendable {
    public var cloudConfigured: Bool
    public var cloudInstanceAvailable: Bool

    public init(config: ConfigStatus?, instances: [Instance]) {
        cloudConfigured = config?.box?.configured == true
        cloudInstanceAvailable = instances.contains {
            $0.driverKind == "boxAgent" && $0.snapshot.isAvailable
        }
    }

    public var cloudReady: Bool { cloudConfigured && cloudInstanceAvailable }

    public func canSelect(_ location: RoutineRunLocation, preserving current: RoutineRunLocation) -> Bool {
        location == .maus || cloudReady || current == .cloud
    }
}

public extension Routine {
    var runLocation: RoutineRunLocation {
        RoutineRunLocation(rawValue: runOn) ?? .maus
    }

    /// Mirrors the desktop `canToggleRoutine` policy. A one-time routine has
    /// no meaningful Resume action once its scheduled instant has passed.
    func canToggle(at date: Date = Date()) -> Bool {
        switch schedule.type {
        case .daily:
            true
        case .once:
            (schedule.at ?? -.infinity) > date.timeIntervalSince1970 * 1_000
        case .unknown:
            false
        }
    }
}

public struct NotificationTarget: Equatable, Sendable {
    public let botId: String
    public let threadId: String
    /// The pending request this notification answers, when the harness sent
    /// one (see `NotificationFrame.requestId`).  Nil for an older harness,
    /// or for a notification that never carried one to begin with.
    public let requestId: String?
    /// approval · question · done · routine-failed — carried through so
    /// Approve/Deny can tell a permission card from a free-text question
    /// without a network round trip.
    public let kind: String?

    public init?(botId: String?, threadId: String?, requestId: String? = nil, kind: String? = nil) {
        guard let botId, let threadId,
              !botId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !threadId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        self.botId = botId
        self.threadId = threadId
        self.requestId = requestId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? requestId : nil
        self.kind = kind
    }

    public init?(payload: [String: String]) {
        self.init(botId: payload["botId"], threadId: payload["threadId"])
    }

    /// Local banners store flat string keys.  APNs also nests `thread-id`
    /// under `aps`.  Either shape must open the same bot and task — and,
    /// when present, answer the same pending request.
    public static func fromRemoteUserInfo(_ userInfo: [AnyHashable: Any]) -> NotificationTarget? {
        func string(from value: Any?) -> String? {
            guard let value = value as? String else { return nil }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        let botId = string(from: userInfo["botId"])
        let nested = userInfo["aps"] as? [AnyHashable: Any]
        let threadId = string(from: userInfo["threadId"]) ?? string(from: nested?["thread-id"])
        return NotificationTarget(
            botId: botId,
            threadId: threadId,
            requestId: string(from: userInfo["requestId"]),
            kind: string(from: userInfo["kind"])
        )
    }

    public func requiresTaskSwitch(activeThreadId: String) -> Bool {
        threadId != activeThreadId
    }
}

// MARK: - Connected apps

public struct ConnectorCard: Codable, Hashable, Identifiable, Sendable {
    public var slug: String
    public var label: String
    public var blurb: String
    public var logo: String?
    public var domain: String?
    public var id: String { slug }
}

public struct ConnectorAccount: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var alias: String?
    public var status: String

    /// Composio lifecycle values include both `ACTIVE` and `INACTIVE`; an
    /// exact normalized comparison avoids rendering the latter as connected.
    public var isActive: Bool {
        status.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() == "ACTIVE"
    }
}

public struct ConnectorStatus: Codable, Hashable, Sendable {
    public var connected: Bool
    public var pending: Bool?
    public var status: String?
    public var accounts: [ConnectorAccount]?
}

public struct ConnectorCatalog: Codable, Sendable {
    public var configured: Bool
    public var mode: String?
    public var source: String?
    public var cards: [ConnectorCard]
}

public struct ConnectorStatuses: Codable, Sendable {
    public var configured: Bool
    public var services: [String: ConnectorStatus]
    /// `"ok"`, `"unavailable"`, or absent on a computer that predates the
    /// field. Read it through `isAuthoritative`; nothing should compare it
    /// directly.
    public var credentialStore: String?
    /// Explicit inventory authority from current servers.  Older computers
    /// omit it; then `credentialStore` is the only signal.
    public var authoritative: Bool?

    /// Whether `services` is an inventory or an admission of ignorance.
    ///
    /// Current servers send `authoritative: false` on a 200 when the
    /// credential is pending or an upstream check failed.  Those must not
    /// replace a previously verified list.  Older computers omit the field;
    /// then only `credentialStore == "unavailable"` withdraws the claim.
    public var isAuthoritative: Bool {
        if let authoritative { return authoritative }
        return credentialStore != "unavailable"
    }
}

/// The harness's error body. Every non-2xx response carries one.
public struct APIErrorBody: Codable, Sendable {
    public var error: String
}

/// One frame of a bot's computer, as it arrives on the stream.
public struct ScreenFrame: Hashable, Sendable {
    public var png: String
    public var mime: String

    public init(png: String, mime: String) {
        self.png = png
        self.mime = mime
    }

    /// Decoded pixels, or nil if the base64 was not what it claimed to be.
    /// Returning nil rather than throwing keeps the caller a view.
    public var data: Data? { Data(base64Encoded: png) }
}

/// `POST /api/bots` — the harness answers with the bot it made.
public struct CreatedBot: Codable, Sendable {
    public var bot: Bot
}

/// `POST /api/groups` — the harness answers with the room it made.
public struct CreatedRoom: Codable, Sendable {
    public var group: Room
}

struct SearchResponse: Codable, Sendable {
    var hits: [SearchHit]
}

struct MessageResponse: Codable, Sendable {
    var message: Message
}

struct ActiveBranchResponse: Codable, Sendable {
    var activeLeafId: String
}

struct BotResponse: Codable, Sendable {
    var bot: Bot
}
struct VoiceListResponse: Codable, Sendable {
    var voices: [Voice]
    var error: String?
}

public struct AttachmentResponse: Codable, Sendable {
    public var path: String
    public var mime: String
    public var bytes: Int
}

struct GeneratedAvatarResponse: Codable, Sendable {
    var avatarUrl: String
    var bot: Bot
}

struct RoutinesResponse: Codable, Sendable {
    var routines: [Routine]
    var runs: [RoutineRun]
}

struct RoutineResponse: Codable, Sendable { var routine: Routine }
struct RoutineRunResponse: Codable, Sendable { var run: RoutineRun }

struct ConnectorAuthorizationResponse: Codable, Sendable {
    var url: String
}

public struct RoomPatch: Encodable, Sendable {
    public var name: String?
    public var bulletin: String?
    public var avatarUrl: BotProfilePatch.AvatarURL?
    public var avatarCrop: AvatarCrop?
    public var cwd: String?
    public var extraCwds: [String]?
    public var defaultResponder: GroupResponder?
    public var memberIds: [String]?
    public var section: BotProfilePatch.SectionString?

    public init(
        name: String? = nil,
        bulletin: String? = nil,
        avatarUrl: BotProfilePatch.AvatarURL? = nil,
        avatarCrop: AvatarCrop? = nil,
        cwd: String? = nil,
        extraCwds: [String]? = nil,
        defaultResponder: GroupResponder? = nil,
        memberIds: [String]? = nil,
        section: BotProfilePatch.SectionString? = nil
    ) {
        self.name = name
        self.bulletin = bulletin
        self.avatarUrl = avatarUrl
        self.avatarCrop = avatarCrop
        self.cwd = cwd
        self.extraCwds = extraCwds
        self.defaultResponder = defaultResponder
        self.memberIds = memberIds
        self.section = section
    }

    private enum CodingKeys: String, CodingKey {
        case name, bulletin, avatarUrl, avatarCrop, cwd, extraCwds, defaultResponder, memberIds, section
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encodeIfPresent(name, forKey: .name)
        try values.encodeIfPresent(bulletin, forKey: .bulletin)
        if let avatarUrl {
            switch avatarUrl {
            case let .set(path): try values.encode(path, forKey: .avatarUrl)
            case .clear: try values.encodeNil(forKey: .avatarUrl)
            }
        }
        try values.encodeIfPresent(avatarCrop, forKey: .avatarCrop)
        try values.encodeIfPresent(cwd, forKey: .cwd)
        try values.encodeIfPresent(extraCwds, forKey: .extraCwds)
        try values.encodeIfPresent(defaultResponder, forKey: .defaultResponder)
        try values.encodeIfPresent(memberIds, forKey: .memberIds)
        if let section {
            switch section {
            case let .set(val): try values.encode(val, forKey: .section)
            case .clear: try values.encodeNil(forKey: .section)
            }
        }
    }
}

// MARK: - Mac update
//
// `GET/POST /api/update/*` on the harness — a companion-only view onto the
// same on-demand transaction `scripts/update-botfleet-mac.mjs` runs from the
// desktop.  The phone never drives the transaction directly; it only reads
// this status and asks the harness to check or run it.

/// The Mac's own running build, as the harness sees it right now.
public struct MacInstalledBuild: Codable, Hashable, Sendable {
    /// Absent on a harness that predates version stamping — a short commit
    /// is still worth showing when there is no marketing version to pair it with.
    public var version: String?
    public var sourceCommit: String
    public var installedAt: String?

    public init(version: String? = nil, sourceCommit: String, installedAt: String? = nil) {
        self.version = version
        self.sourceCommit = sourceCommit
        self.installedAt = installedAt
    }
}

/// One commit between the installed build and what is available, newest first.
public struct MacUpdateCommit: Codable, Hashable, Sendable {
    public var sha: String
    public var subject: String

    public init(sha: String, subject: String) {
        self.sha = sha
        self.subject = subject
    }
}

/// What `origin/main` has that the installed build does not.
public struct MacAvailableUpdate: Codable, Hashable, Sendable {
    public var sourceCommit: String
    public var version: String?
    public var aheadBy: Int
    public var commits: [MacUpdateCommit]

    public init(sourceCommit: String, version: String? = nil, aheadBy: Int, commits: [MacUpdateCommit] = []) {
        self.sourceCommit = sourceCommit
        self.version = version
        self.aheadBy = aheadBy
        self.commits = commits
    }
}

/// An update transaction while it is still running, mirroring the updater's
/// own step names rather than inventing a client-side vocabulary for them.
public struct MacUpdateRun: Codable, Hashable, Sendable {
    public var runId: String
    public var startedAt: String
    public var step: String
    public var progress: Double?
    public var logTail: [String]

    public init(runId: String, startedAt: String, step: String, progress: Double? = nil, logTail: [String] = []) {
        self.runId = runId
        self.startedAt = startedAt
        self.step = step
        self.progress = progress
        self.logTail = logTail
    }
}

/// How the most recently finished transaction ended.
public enum MacUpdateOutcome: String, Codable, Hashable, Sendable {
    case verified
    case rolledBack = "rolled-back"
    case failed
    case refused
    /// An outcome this build has never heard of.  The card still has a
    /// finished run to report; guessing "failed" would claim something the
    /// harness never said.
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = MacUpdateOutcome(rawValue: raw) ?? .unknown
    }
}

/// The most recent update transaction to finish, whether or not one is
/// running again now.
public struct MacUpdateLastRun: Codable, Hashable, Sendable {
    public var runId: String
    public var startedAt: String
    public var finishedAt: String
    public var outcome: MacUpdateOutcome
    public var message: String
    public var receiptPath: String?

    public init(
        runId: String,
        startedAt: String,
        finishedAt: String,
        outcome: MacUpdateOutcome,
        message: String,
        receiptPath: String? = nil
    ) {
        self.runId = runId
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.outcome = outcome
        self.message = message
        self.receiptPath = receiptPath
    }
}

/// What this paired device is allowed to do right now.  The card disables its
/// own buttons from this rather than inferring it from `running`/`lastRun` —
/// the harness may refuse for reasons that are its own to know and explain,
/// such as another client already updating or a dirty checkout.
public struct MacUpdateCapabilities: Codable, Hashable, Sendable {
    public var canCheck: Bool
    public var canRun: Bool
    public var reasons: [String]

    public init(canCheck: Bool, canRun: Bool, reasons: [String] = []) {
        self.canCheck = canCheck
        self.canRun = canRun
        self.reasons = reasons
    }
}

/// `GET /api/update/status`, `POST /api/update/check`, and the `update.status`
/// stream event all answer with this same shape.
public struct MacUpdateStatus: Codable, Hashable, Sendable {
    public var installed: MacInstalledBuild
    public var available: MacAvailableUpdate?
    /// `null` before this Mac has ever checked — distinct from a real,
    /// long-ago timestamp, and worth its own "Not checked yet" copy rather
    /// than folding it into `available == nil`.
    public var checkedAt: String?
    /// Why the last check produced no answer, `nil` when it produced one.
    ///
    /// A failed `git fetch` leaves the Mac's `origin/main` ref exactly where
    /// the last good fetch left it, so the comparison behind `available`
    /// would report a computer that has been offline for a week as up to
    /// date.  The harness deliberately does not move `checkedAt` in that
    /// case and sets this instead, so the card can say the check failed
    /// rather than repeat a stale answer as if it were fresh.  Absent on a
    /// harness that predates the field, which decodes as `nil` — the same
    /// as a check that worked.
    public var checkError: String?
    public var running: MacUpdateRun?
    public var lastRun: MacUpdateLastRun?
    public var capabilities: MacUpdateCapabilities

    public init(
        installed: MacInstalledBuild,
        available: MacAvailableUpdate? = nil,
        checkedAt: String? = nil,
        checkError: String? = nil,
        running: MacUpdateRun? = nil,
        lastRun: MacUpdateLastRun? = nil,
        capabilities: MacUpdateCapabilities
    ) {
        self.installed = installed
        self.available = available
        self.checkedAt = checkedAt
        self.checkError = checkError
        self.running = running
        self.lastRun = lastRun
        self.capabilities = capabilities
    }
}

/// Parses the ISO-8601 timestamps a `MacUpdateStatus` carries as strings.
///
/// Both spellings have to work.  The harness stamps `checkedAt` with
/// JavaScript's `Date.prototype.toISOString()` (`server/update-control.ts`),
/// which always emits milliseconds — `2026-09-14T08:46:09.123Z` — while a
/// default `ISO8601DateFormatter` rejects fractional seconds outright,
/// because `formatOptions` defaults to `.withInternetDateTime` alone.  So
/// the fractional spelling is tried first and the whole-second one second:
/// an `available.json` restored from disk, a hand-written fixture, and any
/// future harness may carry either, and a parse that fails leaves the card
/// showing the user a raw ISO string.
///
/// Lives here rather than in the card so `swift test` can cover it — the
/// app target is not built by `swift test --package-path ios` at all.
public enum MacUpdateTimestamp {
    public static func date(from text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: text) { return date }
        let wholeSecond = ISO8601DateFormatter()
        wholeSecond.formatOptions = [.withInternetDateTime]
        return wholeSecond.date(from: text)
    }
}

/// `POST /api/update/run`'s 202 body: the run it just started, plus the
/// status right after starting it — the phone renders progress from this
/// without a follow-up GET.
public struct MacUpdateRunStarted: Codable, Hashable, Sendable {
    public var runId: String
    public var status: MacUpdateStatus

    public init(runId: String, status: MacUpdateStatus) {
        self.runId = runId
        self.status = status
    }
}

/// `POST /api/update/check`'s 502 body — why the harness could not reach
/// the update source, plus the same status shape a 200 would have carried.
struct MacUpdateCheckFailureBody: Decodable, Sendable {
    var error: String
    var status: MacUpdateStatus
}

/// A check the harness could not complete.  Not an `APIError.status` for the
/// same reason `MacUpdateRunRefusal` is not: the 502 body carries a full
/// `MacUpdateStatus`, and the card needs that as much as the sentence — the
/// installed build and the capabilities are still current, only the
/// comparison is missing.  Modelled as a throw rather than a field on a
/// returned status so a caller cannot mistake a failed check for a
/// successful one just by ignoring `checkError`.
public struct MacUpdateCheckFailure: Error, LocalizedError, Sendable {
    public var message: String
    public var status: MacUpdateStatus

    public init(message: String, status: MacUpdateStatus) {
        self.message = message
        self.status = status
    }

    public var errorDescription: String? { message }
}

/// `POST /api/update/run`'s 409 body — the harness's reason plus the same
/// status a 202 would have carried, so `CompanionClient.runUpdate()` can
/// hand both to the caller instead of only an error string.
struct MacUpdateRunRefusalBody: Decodable, Sendable {
    var error: String
    var status: MacUpdateStatus
}

/// A refused `runUpdate()` — a run already in progress, or one of
/// `capabilities.reasons` — carrying both the harness's own reason and the
/// status right now.  Kept apart from `APIError` because that type's
/// `.status(code:message:)` case has no room for the status object every
/// other caller of `runUpdate()` also needs.
public struct MacUpdateRunRefusal: Error, LocalizedError, Sendable {
    public var message: String
    public var status: MacUpdateStatus

    public init(message: String, status: MacUpdateStatus) {
        self.message = message
        self.status = status
    }

    public var errorDescription: String? { message }
}
