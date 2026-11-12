import CryptoKit
import Foundation

// MARK: - Zulip Models & Errors

/// Errors emitted by `ZulipEventActor` and identity verification guards.
public enum ZulipActorError: LocalizedError, Sendable, Equatable {
    case ownerAccountRefused(String)
    case invalidBotEmail(String)
    case invalidSeatIdentity(String)
    case badEventQueueId(String)
    case transportError(String)
    case apiError(code: String, message: String)

    public var errorDescription: String? {
        switch self {
        case .ownerAccountRefused(let email):
            return "Refused to authenticate or post as owner account '\(email)'.  Agents must only use their assigned *-bot@... credential."
        case .invalidBotEmail(let email):
            return "Invalid bot credential email '\(email)'.  Bot email local-part must end with '-bot'."
        case .invalidSeatIdentity(let reason):
            return "Invalid agent seat identity: \(reason)"
        case .badEventQueueId(let queueId):
            return "Zulip event queue '\(queueId)' expired (BAD_EVENT_QUEUE_ID)."
        case .transportError(let detail):
            return "Zulip transport failure: \(detail)"
        case .apiError(let code, let message):
            return "Zulip API error (\(code)): \(message)"
        }
    }
}

/// A short, non-reversible preview of a credential, safe to put in an error
/// message: the first eight and the last four characters only, and nothing at
/// all for a credential too short to preview safely.
public enum CredentialPreview {
    public static func masked(_ credential: String) -> String {
        let characters = Array(credential)
        guard characters.count > 12 else { return "" }
        return String(characters.prefix(8)) + "…" + String(characters.suffix(4))
    }
}

/// Verified bot identity and Zulip connection credentials.
/// Enforces the fleet rule that an agent never authenticates or posts as Jay's owner account.
public struct ZulipBotIdentity: Sendable, Equatable {
    public let realmURL: URL
    public let botEmail: String
    public let apiKey: String
    public let seat: String
    public let sessionId: String

    private static let forbiddenOwnerPrefixes: Set<String> = [
        "jay",
        "owner",
        "admin",
        "jay.owner",
    ]

    /// A masked preview of the bot credential, safe to put in an error
    /// message.
    public static func maskedCredentialPreview(_ credential: String) -> String {
        CredentialPreview.masked(credential)
    }

    /// `realmURL` has no default on purpose.  The realm is deployment
    /// configuration, and a hardcoded default would let a caller that forgot
    /// to resolve it silently talk to one fixed site instead of the configured
    /// one.  The caller resolves it from the deployment's approved source.
    public init(
        realmURL: URL,
        botEmail: String,
        apiKey: String,
        seat: String,
        sessionId: String
    ) throws {
        let trimmedEmail = botEmail.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let parts = trimmedEmail.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else {
            throw ZulipActorError.invalidBotEmail(botEmail)
        }
        let localPart = String(parts[0])
        if Self.forbiddenOwnerPrefixes.contains(localPart) || !localPart.hasSuffix("-bot") {
            if Self.forbiddenOwnerPrefixes.contains(localPart) || localPart.hasPrefix("jay") {
                throw ZulipActorError.ownerAccountRefused(botEmail)
            }
            throw ZulipActorError.invalidBotEmail(botEmail)
        }

        let normalizedSeat = seat.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !normalizedSeat.isEmpty else {
            throw ZulipActorError.invalidSeatIdentity("AGENT_SEAT must not be empty.")
        }
        let trimmedSession = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSession.isEmpty else {
            throw ZulipActorError.invalidSeatIdentity("Session identifier must not be empty.")
        }
        guard !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ZulipActorError.invalidSeatIdentity("API key must not be empty.")
        }

        self.realmURL = realmURL
        self.botEmail = trimmedEmail
        self.apiKey = apiKey
        self.seat = normalizedSeat
        self.sessionId = trimmedSession
    }

    /// Formats the canonical `[SEAT·session]` prefix tag required on every Zulip message.
    public var sessionTag: String {
        "[\(seat)·\(sessionId)]"
    }

    /// Formats an outgoing message body with `repo:` first and the `[SEAT·session]` tag.
    public func formatOutboundMessage(repo: String, body: String) -> String {
        let cleanRepo = repo.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanBody = body.trimmingCharacters(in: .whitespacesAndNewlines)
        return "repo: \(cleanRepo)\n\(sessionTag) \(cleanBody)"
    }
}

/// Raw message payload received from Zulip `/api/v1/events` or `/api/v1/messages`.
public struct ZulipRawMessage: Codable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let senderEmail: String
    public let senderFullName: String
    public let streamName: String
    public let subject: String
    public let content: String
    public let timestamp: Double

    public init(
        id: Int,
        senderEmail: String,
        senderFullName: String,
        streamName: String,
        subject: String,
        content: String,
        timestamp: Double
    ) {
        self.id = id
        self.senderEmail = senderEmail
        self.senderFullName = senderFullName
        self.streamName = streamName
        self.subject = subject
        self.content = content
        self.timestamp = timestamp
    }
}

/// Peer message wrapped in `<untrusted_peer_message>` fences so peer messages are
/// strictly treated as coordination data and never as owner instructions.
public struct ZulipFencedMessage: Sendable, Equatable, Identifiable {
    public let id: Int
    public let senderEmail: String
    public let streamName: String
    public let topic: String
    public let rawContent: String
    public let fencedContent: String
    public let timestamp: Double
    /// Always `false` for peer coordination messages on Zulip.
    public let isOwnerInstruction: Bool = false

    public init(from raw: ZulipRawMessage) {
        self.id = raw.id
        self.senderEmail = raw.senderEmail
        self.streamName = raw.streamName
        self.topic = raw.subject
        self.rawContent = raw.content
        self.fencedContent = ZulipEventActor.fencePeerMessage(raw)
        self.timestamp = raw.timestamp
    }
}

/// Response from `/api/v1/register`.
public struct ZulipRegisterResponse: Codable, Sendable, Equatable {
    public let queueId: String
    public let lastEventId: Int
    /// The newest message id in the realm at registration time.  The first
    /// catch-up anchors here, so a fresh bot reads recent traffic instead of
    /// walking the whole message history from id 0.
    public let maxMessageId: Int

    public init(queueId: String, lastEventId: Int, maxMessageId: Int = 0) {
        self.queueId = queueId
        self.lastEventId = lastEventId
        self.maxMessageId = maxMessageId
    }
}

/// Single event inside `/api/v1/events`.
public struct ZulipEventEnvelope: Codable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let type: String
    public let message: ZulipRawMessage?

    public init(id: Int, type: String = "message", message: ZulipRawMessage? = nil) {
        self.id = id
        self.type = type
        self.message = message
    }
}

/// Response from `/api/v1/events`.
public struct ZulipEventsResponse: Codable, Sendable, Equatable {
    public let events: [ZulipEventEnvelope]

    public init(events: [ZulipEventEnvelope]) {
        self.events = events
    }
}

/// Transport protocol abstracting Zulip REST calls for deterministic unit testing and production `URLSession`.
public protocol ZulipTransport: Sendable {
    func registerEventQueue(identity: ZulipBotIdentity, eventTypes: [String]) async throws -> ZulipRegisterResponse
    func getEvents(identity: ZulipBotIdentity, queueId: String, lastEventId: Int) async throws -> ZulipEventsResponse
    func fetchMessagesAfter(identity: ZulipBotIdentity, anchorMessageId: Int, limit: Int) async throws -> [ZulipRawMessage]
    func postStreamMessage(identity: ZulipBotIdentity, stream: String, topic: String, content: String) async throws -> Int
}

/// Production `URLSession` implementation of `ZulipTransport`.
public struct URLSessionZulipTransport: ZulipTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    private func basicAuthHeader(for identity: ZulipBotIdentity) -> String {
        let credentials = "\(identity.botEmail):\(identity.apiKey)"
        let encoded = Data(credentials.utf8).base64EncodedString()
        return "Basic \(encoded)"
    }

    /// Zulip reports a rejected credential with an error envelope.  The thrown
    /// error carries a masked preview of the key, so an operator can tell
    /// which credential was rejected without the key itself ever appearing.
    static func apiError(
        code: String,
        message: String,
        identity: ZulipBotIdentity
    ) -> ZulipActorError {
        guard isAuthFailureCode(code) else {
            return .apiError(code: code, message: message)
        }
        let preview = ZulipBotIdentity.maskedCredentialPreview(identity.apiKey)
        let suffix = preview.isEmpty ? "" : " (credential \(preview))"
        return .apiError(
            code: "AUTH_REJECTED",
            message: "Zulip rejected the bot credential\(suffix): \(message)"
        )
    }

    /// The error codes Zulip uses for a credential it will not accept.
    static func isAuthFailureCode(_ code: String) -> Bool {
        let upper = code.uppercased()
        return upper == "INVALID_API_KEY"
            || upper == "INVALID_API_KEY_OR_EMAIL"
            || upper == "AUTHENTICATION_FAILED"
            || upper == "UNAUTHORIZED"
    }

    public func registerEventQueue(identity: ZulipBotIdentity, eventTypes: [String]) async throws -> ZulipRegisterResponse {
        let url = identity.realmURL.appendingPathComponent("api/v1/register")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(basicAuthHeader(for: identity), forHTTPHeaderField: "Authorization")
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")

        let encodedTypes = (try? JSONSerialization.data(withJSONObject: eventTypes)).flatMap { String(data: $0, encoding: .utf8) } ?? "[\"message\"]"
        var components = URLComponents()
        components.queryItems = [URLQueryItem(name: "event_types", value: encodedTypes)]
        request.httpBody = Data((components.percentEncodedQuery ?? "").utf8)

        let (data, _) = try await session.data(for: request)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ZulipActorError.transportError("Malformed JSON from /api/v1/register")
        }
        if let result = json["result"] as? String, result == "error" {
            let code = (json["code"] as? String) ?? "UNKNOWN"
            let msg = (json["msg"] as? String) ?? "Unknown error"
            throw Self.apiError(code: code, message: msg, identity: identity)
        }
        guard let queueId = json["queue_id"] as? String,
              let lastEventId = json["last_event_id"] as? Int else {
            throw ZulipActorError.transportError("Missing queue_id or last_event_id")
        }
        let maxMessageId = (json["max_message_id"] as? Int) ?? 0
        return ZulipRegisterResponse(queueId: queueId, lastEventId: lastEventId, maxMessageId: maxMessageId)
    }

    public func getEvents(identity: ZulipBotIdentity, queueId: String, lastEventId: Int) async throws -> ZulipEventsResponse {
        guard var components = URLComponents(
            url: identity.realmURL.appendingPathComponent("api/v1/events"),
            resolvingAgainstBaseURL: false
        ) else {
            throw ZulipActorError.transportError("Could not build the Zulip events URL")
        }
        components.queryItems = [
            URLQueryItem(name: "queue_id", value: queueId),
            URLQueryItem(name: "last_event_id", value: String(lastEventId)),
            URLQueryItem(name: "dont_block", value: "false"),
        ]
        guard let url = components.url else {
            throw ZulipActorError.transportError("Could not build the Zulip events URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue(basicAuthHeader(for: identity), forHTTPHeaderField: "Authorization")

        let (data, _) = try await session.data(for: request)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ZulipActorError.transportError("Malformed JSON from /api/v1/events")
        }
        if let result = json["result"] as? String, result == "error" {
            let code = (json["code"] as? String) ?? "UNKNOWN"
            let msg = (json["msg"] as? String) ?? "Unknown error"
            if code == "BAD_EVENT_QUEUE_ID" {
                throw ZulipActorError.badEventQueueId(queueId)
            }
            throw Self.apiError(code: code, message: msg, identity: identity)
        }
        let rawEvents = (json["events"] as? [[String: Any]]) ?? []
        var parsedEvents: [ZulipEventEnvelope] = []
        for item in rawEvents {
            guard let eventId = item["id"] as? Int else { continue }
            let type = (item["type"] as? String) ?? "message"
            var rawMsg: ZulipRawMessage?
            if let msgDict = item["message"] as? [String: Any],
               let msgId = msgDict["id"] as? Int {
                rawMsg = ZulipRawMessage(
                    id: msgId,
                    senderEmail: (msgDict["sender_email"] as? String) ?? "",
                    senderFullName: (msgDict["sender_full_name"] as? String) ?? "",
                    streamName: (msgDict["display_recipient"] as? String) ?? "",
                    subject: (msgDict["subject"] as? String) ?? "",
                    content: (msgDict["content"] as? String) ?? "",
                    timestamp: (msgDict["timestamp"] as? Double) ?? 0
                )
            }
            parsedEvents.append(ZulipEventEnvelope(id: eventId, type: type, message: rawMsg))
        }
        return ZulipEventsResponse(events: parsedEvents)
    }

    public func fetchMessagesAfter(identity: ZulipBotIdentity, anchorMessageId: Int, limit: Int) async throws -> [ZulipRawMessage] {
        guard var components = URLComponents(
            url: identity.realmURL.appendingPathComponent("api/v1/messages"),
            resolvingAgainstBaseURL: false
        ) else {
            throw ZulipActorError.transportError("Could not build the Zulip messages URL")
        }
        components.queryItems = [
            URLQueryItem(name: "anchor", value: String(anchorMessageId)),
            URLQueryItem(name: "include_anchor", value: "false"),
            URLQueryItem(name: "num_before", value: "0"),
            URLQueryItem(name: "num_after", value: String(limit)),
        ]
        guard let url = components.url else {
            throw ZulipActorError.transportError("Could not build the Zulip messages URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue(basicAuthHeader(for: identity), forHTTPHeaderField: "Authorization")

        let (data, _) = try await session.data(for: request)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ZulipActorError.transportError("Malformed JSON from /api/v1/messages")
        }
        // An error envelope carries no `messages` key.  Treating it as "no
        // messages" would report an empty catch-up and let the caller believe
        // the backfill succeeded, so the envelope is surfaced instead.
        if let result = json["result"] as? String, result == "error" {
            let code = (json["code"] as? String) ?? "UNKNOWN"
            let msg = (json["msg"] as? String) ?? "Unknown error"
            throw Self.apiError(code: code, message: msg, identity: identity)
        }
        guard let messages = json["messages"] as? [[String: Any]] else {
            throw ZulipActorError.transportError("Malformed messages payload from /api/v1/messages")
        }
        return messages.compactMap { msgDict in
            guard let msgId = msgDict["id"] as? Int else { return nil }
            return ZulipRawMessage(
                id: msgId,
                senderEmail: (msgDict["sender_email"] as? String) ?? "",
                senderFullName: (msgDict["sender_full_name"] as? String) ?? "",
                streamName: (msgDict["display_recipient"] as? String) ?? "",
                subject: (msgDict["subject"] as? String) ?? "",
                content: (msgDict["content"] as? String) ?? "",
                timestamp: (msgDict["timestamp"] as? Double) ?? 0
            )
        }
    }

    public func postStreamMessage(identity: ZulipBotIdentity, stream: String, topic: String, content: String) async throws -> Int {
        let url = identity.realmURL.appendingPathComponent("api/v1/messages")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(basicAuthHeader(for: identity), forHTTPHeaderField: "Authorization")
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")

        var components = URLComponents()
        components.queryItems = [
            URLQueryItem(name: "type", value: "stream"),
            URLQueryItem(name: "to", value: stream),
            URLQueryItem(name: "topic", value: topic),
            URLQueryItem(name: "content", value: content),
        ]
        request.httpBody = Data((components.percentEncodedQuery ?? "").utf8)

        let (data, _) = try await session.data(for: request)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ZulipActorError.transportError("Malformed JSON from /api/v1/messages")
        }
        if let result = json["result"] as? String, result == "error" {
            let code = (json["code"] as? String) ?? "UNKNOWN"
            let msg = (json["msg"] as? String) ?? "Unknown error"
            throw Self.apiError(code: code, message: msg, identity: identity)
        }
        guard let msgId = json["id"] as? Int else {
            throw ZulipActorError.transportError("Failed to decode sent message ID")
        }
        return msgId
    }
}

// MARK: - ZulipEventActor

/// Long-polling Zulip event queue actor with `2.0s..60.0s` (`±30%` jitter) exponential backoff,
/// automatic `BAD_EVENT_QUEUE_ID` re-registration with anchor catch-up, message ID deduplication,
/// owner-account refusal guards, and `<untrusted_peer_message>` fencing.
public actor ZulipEventActor {
    public let identity: ZulipBotIdentity
    private let transport: ZulipTransport
    private let sleepHandler: @Sendable (TimeInterval) async -> Void
    private let randomFactorProvider: @Sendable () -> Double

    public private(set) var queueId: String?
    public private(set) var lastEventId: Int = -1
    public private(set) var highWaterMessageId: Int = 0
    public private(set) var reRegistrationCount: Int = 0
    public private(set) var consecutiveFailures: Int = 0
    public private(set) var recordedBackoffDelays: [TimeInterval] = []

    private var seenMessageIds: Set<Int> = []
    private var seenOrder: [Int] = []
    private let deduplicationCapacity: Int

    /// How many messages one backfill reads.
    public static let catchUpLimit: Int = 1_000

    public init(
        identity: ZulipBotIdentity,
        transport: ZulipTransport = URLSessionZulipTransport(),
        deduplicationCapacity: Int = 10_000,
        randomFactorProvider: @escaping @Sendable () -> Double = { Double.random(in: 0.7...1.3) },
        sleepHandler: @escaping @Sendable (TimeInterval) async -> Void = { seconds in
            try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
        }
    ) {
        self.identity = identity
        self.transport = transport
        self.deduplicationCapacity = max(100, deduplicationCapacity)
        self.randomFactorProvider = randomFactorProvider
        self.sleepHandler = sleepHandler
    }

    /// Computes the exponential backoff delay in `[2.0s, 60.0s]` scaled by `±30%` jitter (`0.7...1.3`).
    /// Formula: `min(60.0, 2.0 * pow(2.0, attempt)) * jitterFactor`.
    public static func computeBackoffDelay(attempt: Int, jitterFactor: Double? = nil) -> TimeInterval {
        let clampedAttempt = max(0, attempt)
        let exponent = min(clampedAttempt, 10)
        let base = min(60.0, 2.0 * pow(2.0, Double(exponent)))
        let rawJitter = jitterFactor ?? Double.random(in: 0.7...1.3)
        let clampedJitter = min(1.3, max(0.7, rawJitter))
        return base * clampedJitter
    }

    /// Wraps a raw Zulip peer message in `<untrusted_peer_message>` tags and escapes any embedded closing tags
    /// so peer coordination traffic can never break out of the fence or masquerade as owner instructions.
    public static func fencePeerMessage(_ message: ZulipRawMessage) -> String {
        let sanitizedBody = message.content.replacingOccurrences(
            of: "</untrusted_peer_message>",
            with: "&lt;/untrusted_peer_message&gt;"
        )
        return """
        <untrusted_peer_message sender="\(escapeFenceAttribute(message.senderEmail))" stream="\(escapeFenceAttribute(message.streamName))" topic="\(escapeFenceAttribute(message.subject))" message_id="\(message.id)">
        \(sanitizedBody)
        </untrusted_peer_message>
        """
    }

    /// Escapes a value that is interpolated into a fence attribute.  A quote
    /// would close the attribute early and let a peer inject their own
    /// attribute or element into the fence.
    static func escapeFenceAttribute(_ value: String) -> String {
        var escaped = ""
        escaped.reserveCapacity(value.count)
        for character in value {
            switch character {
            case "&":
                escaped += "&amp;"
            case "<":
                escaped += "&lt;"
            case ">":
                escaped += "&gt;"
            case "\"":
                escaped += "&quot;"
            case "'":
                escaped += "&#39;"
            case "\n":
                escaped += "&#10;"
            case "\r":
                escaped += "&#13;"
            // The Unicode line terminators are line breaks to a downstream
            // parser even though Swift does not treat them as `Character`
            // newlines.
            case "\u{0085}":
                escaped += "&#133;"
            case "\u{2028}":
                escaped += "&#8232;"
            case "\u{2029}":
                escaped += "&#8233;"
            default:
                escaped.append(character)
            }
        }
        return escaped
    }

    /// Performs a single long-poll cycle, automatically registering the queue if needed,
    /// handling `BAD_EVENT_QUEUE_ID` by re-registering and backfilling missed messages from `highWaterMessageId`,
    /// and deduplicating all emitted `ZulipFencedMessage` values.
    public func pollOnce() async throws -> [ZulipFencedMessage] {
        do {
            // The catch-up messages are the result of the backfill itself, so
            // they are emitted too.  Dropping them here would mark them as
            // seen (the ingest is what advances the high-water mark) and lose
            // them for good.
            var caughtUp: [ZulipFencedMessage] = []
            if queueId == nil {
                caughtUp = try await registerAndCatchUp()
            }
            guard let activeQueueId = queueId else {
                return caughtUp
            }

            let response: ZulipEventsResponse
            do {
                response = try await transport.getEvents(
                    identity: identity,
                    queueId: activeQueueId,
                    lastEventId: lastEventId
                )
            } catch let error as ZulipActorError {
                switch error {
                case .badEventQueueId:
                    queueId = nil
                    reRegistrationCount += 1
                    var recovered = try await registerAndCatchUp()
                    if let newQueueId = queueId {
                        let postRegisterEvents = try await transport.getEvents(
                            identity: identity,
                            queueId: newQueueId,
                            lastEventId: lastEventId
                        )
                        recovered.append(contentsOf: ingestEvents(postRegisterEvents.events))
                    }
                    consecutiveFailures = 0
                    return recovered
                case .apiError(let code, _) where code == "BAD_EVENT_QUEUE_ID":
                    queueId = nil
                    reRegistrationCount += 1
                    var recovered = try await registerAndCatchUp()
                    if let newQueueId = queueId {
                        let postRegisterEvents = try await transport.getEvents(
                            identity: identity,
                            queueId: newQueueId,
                            lastEventId: lastEventId
                        )
                        recovered.append(contentsOf: ingestEvents(postRegisterEvents.events))
                    }
                    consecutiveFailures = 0
                    return recovered
                default:
                    throw error
                }
            }

            let emitted = ingestEvents(response.events)
            consecutiveFailures = 0
            return caughtUp + emitted
        } catch {
            let delay = Self.computeBackoffDelay(
                attempt: consecutiveFailures,
                jitterFactor: randomFactorProvider()
            )
            consecutiveFailures += 1
            recordedBackoffDelays.append(delay)
            await sleepHandler(delay)
            throw error
        }
    }

    /// Polls with automatic retry until a poll succeeds or `maxAttempts` is reached.
    /// Used to recover cleanly across multi-minute network blackouts without losing or duplicating messages.
    public func pollWithRecovery(maxAttempts: Int = 20) async throws -> [ZulipFencedMessage] {
        var lastError: Error?
        for _ in 0..<max(1, maxAttempts) {
            do {
                return try await pollOnce()
            } catch {
                lastError = error
            }
        }
        throw lastError ?? ZulipActorError.transportError("Exhausted retry attempts")
    }

    /// Sends a formatted stream message using the verified bot identity (`repo:` first + `[SEAT·session]` tag).
    public func postCoordinationUpdate(
        repo: String,
        stream: String = "Work-In-Progress",
        topic: String,
        body: String
    ) async throws -> Int {
        let formatted = identity.formatOutboundMessage(repo: repo, body: body)
        return try await transport.postStreamMessage(
            identity: identity,
            stream: stream,
            topic: topic,
            content: formatted
        )
    }

    @discardableResult
    private func registerAndCatchUp() async throws -> [ZulipFencedMessage] {
        let previousHighWater = highWaterMessageId
        let reg = try await transport.registerEventQueue(identity: identity, eventTypes: ["message"])

        // Anchor the backfill at the last message this actor emitted.  A first
        // registration has no high-water mark yet, so it anchors one window
        // back from the realm's newest message: the bot picks up the recent
        // traffic instead of walking the whole message history from id 0, and
        // it still sees the messages that arrived just before it started.
        let anchor = previousHighWater > 0
            ? previousHighWater
            : max(0, reg.maxMessageId - Self.catchUpLimit)

        // Backfill any messages that arrived while the queue was unregistered or expired.
        let missed = try await transport.fetchMessagesAfter(
            identity: identity,
            anchorMessageId: anchor,
            limit: Self.catchUpLimit
        )

        // The new queue is adopted only after the backfill succeeded.  Adopting
        // it first would leave the actor polling a fresh queue with the missed
        // messages still unread, and a failed backfill would skip them for
        // good: the next poll would anchor past them.
        self.queueId = reg.queueId
        self.lastEventId = reg.lastEventId
        let ingested = ingestRawMessages(missed)
        if previousHighWater == 0, reg.maxMessageId > highWaterMessageId {
            self.highWaterMessageId = reg.maxMessageId
        }
        return ingested
    }

    private func ingestEvents(_ events: [ZulipEventEnvelope]) -> [ZulipFencedMessage] {
        var rawMessages: [ZulipRawMessage] = []
        for event in events {
            if event.id > lastEventId {
                lastEventId = event.id
            }
            if let message = event.message {
                rawMessages.append(message)
            }
        }
        return ingestRawMessages(rawMessages)
    }

    private func ingestRawMessages(_ messages: [ZulipRawMessage]) -> [ZulipFencedMessage] {
        let sorted = messages.sorted { $0.id < $1.id }
        var emitted: [ZulipFencedMessage] = []
        for msg in sorted {
            guard !seenMessageIds.contains(msg.id) else {
                continue
            }
            seenMessageIds.insert(msg.id)
            seenOrder.append(msg.id)
            if seenOrder.count > deduplicationCapacity {
                let evicted = seenOrder.removeFirst()
                seenMessageIds.remove(evicted)
            }
            if msg.id > highWaterMessageId {
                highWaterMessageId = msg.id
            }
            emitted.append(ZulipFencedMessage(from: msg))
        }
        return emitted
    }
}

// MARK: - LinearSyncClient (GraphQL Issue State Sync)

/// Errors emitted by `LinearSyncClient`.
public enum LinearSyncError: LocalizedError, Sendable, Equatable {
    case invalidSeat(String)
    case emptyIssueId
    case graphQLError(String)
    case mutationInFlight(String)

    public var errorDescription: String? {
        switch self {
        case .invalidSeat(let reason):
            return "LinearSyncClient seat validation failed: \(reason)"
        case .emptyIssueId:
            return "Linear issue identifier must not be empty."
        case .graphQLError(let detail):
            return "Linear GraphQL error: \(detail)"
        case .mutationInFlight(let key):
            return "A Linear mutation with idempotency key \(key) is already in flight."
        }
    }
}

/// Receipt returned by a Linear state sync mutation (`claim`, `status`, `comment`).
public struct LinearSyncReceipt: Codable, Sendable, Equatable {
    public let operation: String
    public let issueId: String
    public let seat: String
    public let sessionTag: String
    public let idempotencyKey: String
    public let stateOrBody: String
    public let wasDeduplicated: Bool

    public init(
        operation: String,
        issueId: String,
        seat: String,
        sessionTag: String,
        idempotencyKey: String,
        stateOrBody: String,
        wasDeduplicated: Bool = false
    ) {
        self.operation = operation
        self.issueId = issueId
        self.seat = seat
        self.sessionTag = sessionTag
        self.idempotencyKey = idempotencyKey
        self.stateOrBody = stateOrBody
        self.wasDeduplicated = wasDeduplicated
    }

    public func markingDeduplicated() -> LinearSyncReceipt {
        LinearSyncReceipt(
            operation: operation,
            issueId: issueId,
            seat: seat,
            sessionTag: sessionTag,
            idempotencyKey: idempotencyKey,
            stateOrBody: stateOrBody,
            wasDeduplicated: true
        )
    }
}

/// GraphQL request payload sent to Linear.
public struct LinearGraphQLRequest: Sendable, Equatable {
    public let query: String
    public let variables: [String: String]
    public let idempotencyKey: String

    public init(query: String, variables: [String: String], idempotencyKey: String) {
        self.query = query
        self.variables = variables
        self.idempotencyKey = idempotencyKey
    }
}

/// Transport protocol for executing Linear GraphQL requests.
public protocol LinearGraphQLTransport: Sendable {
    func execute(_ request: LinearGraphQLRequest, apiKey: String) async throws -> [String: String]
    /// Resolves a workflow state name to the UUID that `issueUpdate` expects
    /// in `stateId`.  Linear's mutation input takes the state id, not the
    /// name, so a state change has to look the id up first.
    func workflowStateId(named stateName: String, apiKey: String) async throws -> String
}

/// Default `URLSession` transport for Linear's GraphQL endpoint (`https://api.linear.app/graphql`).
public struct URLSessionLinearGraphQLTransport: LinearGraphQLTransport {
    private let endpoint: URL
    private let session: URLSession

    /// The Linear GraphQL endpoint.  There is no force-unwrapped default:
    /// `URL(string:)` returns an optional, and the endpoint is validated when
    /// the transport is built.
    public init(
        endpoint: URL? = nil,
        session: URLSession = .shared
    ) throws {
        guard let resolved = endpoint ?? URL(string: "https://api.linear.app/graphql") else {
            throw LinearSyncError.graphQLError("Invalid Linear GraphQL endpoint URL.")
        }
        self.endpoint = resolved
        self.session = session
    }

    public func execute(_ request: LinearGraphQLRequest, apiKey: String) async throws -> [String: String] {
        var urlRequest = URLRequest(url: endpoint)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue(apiKey, forHTTPHeaderField: "Authorization")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue(request.idempotencyKey, forHTTPHeaderField: "Idempotency-Key")

        let payload: [String: Any] = [
            "query": request.query,
            "variables": request.variables,
        ]
        urlRequest.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (data, _) = try await session.data(for: urlRequest)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw LinearSyncError.graphQLError("Invalid GraphQL JSON response")
        }
        if let errors = json["errors"] as? [[String: Any]],
           let firstMsg = errors.first?["message"] as? String {
            throw LinearSyncError.graphQLError(firstMsg)
        }
        // A GraphQL response can carry an empty `errors` array and still report
        // a failed mutation inside `data`.  Linear sets `success: false`
        // there, and treating that as a success would report a claim or a
        // status change that never happened.
        if let dataPayload = json["data"] as? [String: Any] {
            for (field, value) in dataPayload {
                guard let fieldPayload = value as? [String: Any] else { continue }
                if let success = fieldPayload["success"] as? Bool, success == false {
                    throw LinearSyncError.graphQLError("Linear reported \(field) as unsuccessful")
                }
            }
        }
        return ["ok": "true"]
    }

    public func workflowStateId(named stateName: String, apiKey: String) async throws -> String {
        let query = """
        query WorkflowStateId($stateName: String!) {
            workflowStates(filter: { name: { eq: $stateName } }, first: 1) {
                nodes { id name }
            }
        }
        """
        let payload: [String: Any] = [
            "query": query,
            "variables": ["stateName": stateName],
        ]
        var urlRequest = URLRequest(url: endpoint)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue(apiKey, forHTTPHeaderField: "Authorization")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (data, _) = try await session.data(for: urlRequest)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw LinearSyncError.graphQLError("Invalid GraphQL JSON response")
        }
        if let errors = json["errors"] as? [[String: Any]] {
            // A rejected credential is reported with a masked preview of the
            // key rather than the provider's raw message, so the failure is
            // diagnosable without the key ever appearing in the error.
            if Self.isAuthFailure(errors) {
                let preview = CredentialPreview.masked(apiKey)
                let suffix = preview.isEmpty ? "" : " (credential \(preview))"
                throw LinearSyncError.graphQLError(
                    "Linear rejected the API credential\(suffix)"
                )
            }
            if let firstMsg = errors.first?["message"] as? String {
                throw LinearSyncError.graphQLError(firstMsg)
            }
        }
        guard let states = (json["data"] as? [String: Any])?["workflowStates"] as? [String: Any],
              let nodes = states["nodes"] as? [[String: Any]],
              let first = nodes.first,
              let id = first["id"] as? String,
              !id.isEmpty else {
            throw LinearSyncError.graphQLError("No Linear workflow state named '\(stateName)'")
        }
        return id
    }

    /// True when a GraphQL error list reports a rejected credential.
    static func isAuthFailure(_ errors: [[String: Any]]) -> Bool {
        for error in errors {
            let code = ((error["extensions"] as? [String: Any])?["code"] as? String) ?? ""
            let message = (error["message"] as? String) ?? ""
            let haystack = "\(code) \(message)".uppercased()
            if haystack.contains("AUTHENTICATION")
                || haystack.contains("UNAUTHENTICATED")
                || haystack.contains("INVALID_API_KEY")
                || haystack.contains("UNAUTHORIZED") {
                return true
            }
        }
        return false
    }
}

/// Swift GraphQL actor for Linear issue state synchronization (`claim`, `status`, `comment`).
/// Enforces seat identity (`AGENT_SEAT`), formats `[SEAT·session]` tags, and deduplicates mutations via idempotency keys.
public actor LinearSyncClient {
    public let seat: String
    public let sessionId: String
    private let apiKey: String
    private let transport: LinearGraphQLTransport
    private var completedByIdempotencyKey: [String: LinearSyncReceipt] = [:]
    /// Keys whose mutation is in flight.  A second caller that arrives before
    /// the first one finishes must not send the mutation again: the receipt
    /// cache is only written after the await, so without this set two
    /// concurrent callers would both post.
    private var inFlightIdempotencyKeys: Set<String> = []
    /// Workflow state ids by name.  A workspace state id does not change, so
    /// one lookup per state name is enough; a failed lookup drops the entry.
    private var workflowStateIdsByName: [String: String] = [:]

    public init(
        seat: String,
        sessionId: String,
        apiKey: String,
        transport: LinearGraphQLTransport? = nil
    ) throws {
        let cleanSeat = seat.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !cleanSeat.isEmpty else {
            throw LinearSyncError.invalidSeat("AGENT_SEAT is required for Linear writes.")
        }
        let cleanSession = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanSession.isEmpty else {
            throw LinearSyncError.invalidSeat("Session ID is required for Linear writes.")
        }
        guard !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw LinearSyncError.invalidSeat("Linear API key must not be empty.")
        }

        self.seat = cleanSeat
        self.sessionId = cleanSession
        self.apiKey = apiKey
        if let transport {
            self.transport = transport
        } else {
            self.transport = try URLSessionLinearGraphQLTransport()
        }
    }

    public nonisolated var sessionTag: String {
        "[\(seat)·\(sessionId)]"
    }

    /// A stable digest for an idempotency key.  `hashValue` is seeded per
    /// process, so the same comment would get a different key after a restart
    /// and the de-duplication would silently stop matching.
    static func stableIdempotencyDigest(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    /// Claims a Linear issue (`In Progress`) and posts the claiming seat's branch and worktree metadata.
    public func claim(
        issueId: String,
        branch: String,
        worktree: String,
        idempotencyKey: String? = nil
    ) async throws -> LinearSyncReceipt {
        let cleanIssue = issueId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanIssue.isEmpty else { throw LinearSyncError.emptyIssueId }

        let key = idempotencyKey ?? "claim:\(cleanIssue):\(seat):\(branch)"
        if let existing = completedByIdempotencyKey[key] {
            return existing.markingDeduplicated()
        }
        try beginMutation(key: key)
        defer { endMutation(key: key) }

        let formattedNote = "\(sessionTag) Claimed \(cleanIssue) on branch `\(branch)` in `\(worktree)`."
        // `issueUpdate` takes the workflow state id, not its name, so the name
        // is resolved to the UUID Linear expects.
        let stateId = try await resolveWorkflowStateId(named: "In Progress")
        let mutation = """
        mutation ClaimIssue($issueId: String!, $stateId: String!, $commentBody: String!) {
            issueUpdate(id: $issueId, input: { stateId: $stateId }) { success }
            commentCreate(input: { issueId: $issueId, body: $commentBody }) { success }
        }
        """
        let req = LinearGraphQLRequest(
            query: mutation,
            variables: [
                "issueId": cleanIssue,
                "stateId": stateId,
                "commentBody": formattedNote,
            ],
            idempotencyKey: key
        )
        _ = try await transport.execute(req, apiKey: apiKey)

        let receipt = LinearSyncReceipt(
            operation: "claim",
            issueId: cleanIssue,
            seat: seat,
            sessionTag: sessionTag,
            idempotencyKey: key,
            stateOrBody: formattedNote
        )
        completedByIdempotencyKey[key] = receipt
        return receipt
    }

    /// Updates a Linear issue's workflow state (`In Progress`, `Done`, `Deployed`, `Canceled`) with an optional resolution comment.
    public func updateStatus(
        issueId: String,
        status: String,
        resolution: String? = nil,
        idempotencyKey: String? = nil
    ) async throws -> LinearSyncReceipt {
        let cleanIssue = issueId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanIssue.isEmpty else { throw LinearSyncError.emptyIssueId }

        let key = idempotencyKey ?? "status:\(cleanIssue):\(seat):\(status):\(resolution ?? "")"
        if let existing = completedByIdempotencyKey[key] {
            return existing.markingDeduplicated()
        }
        try beginMutation(key: key)
        defer { endMutation(key: key) }

        let summary = resolution.map { "\(sessionTag) Status -> \(status): \($0)" } ?? "\(sessionTag) Status -> \(status)"
        // `issueUpdate` takes the workflow state id, not its name.
        let stateId = try await resolveWorkflowStateId(named: status)
        let mutation = """
        mutation UpdateIssueStatus($issueId: String!, $stateId: String!, $commentBody: String!) {
            issueUpdate(id: $issueId, input: { stateId: $stateId }) { success }
            commentCreate(input: { issueId: $issueId, body: $commentBody }) { success }
        }
        """
        let req = LinearGraphQLRequest(
            query: mutation,
            variables: [
                "issueId": cleanIssue,
                "stateId": stateId,
                "commentBody": summary,
            ],
            idempotencyKey: key
        )
        _ = try await transport.execute(req, apiKey: apiKey)

        let receipt = LinearSyncReceipt(
            operation: "status",
            issueId: cleanIssue,
            seat: seat,
            sessionTag: sessionTag,
            idempotencyKey: key,
            stateOrBody: summary
        )
        completedByIdempotencyKey[key] = receipt
        return receipt
    }

    /// Posts a tagged progress or closeout comment on a Linear issue.
    public func comment(
        issueId: String,
        body: String,
        idempotencyKey: String? = nil
    ) async throws -> LinearSyncReceipt {
        let cleanIssue = issueId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanIssue.isEmpty else { throw LinearSyncError.emptyIssueId }

        let taggedBody = body.hasPrefix(sessionTag) ? body : "\(sessionTag) \(body)"
        // `hashValue` is seeded per process, so the same comment would get a
        // different key after a restart and the de-duplication would stop
        // matching.  A stable digest keeps the key the same across restarts.
        let key = idempotencyKey
            ?? "comment:\(cleanIssue):\(seat):\(Self.stableIdempotencyDigest(taggedBody))"
        if let existing = completedByIdempotencyKey[key] {
            return existing.markingDeduplicated()
        }
        try beginMutation(key: key)
        defer { endMutation(key: key) }

        let mutation = """
        mutation CreateIssueComment($issueId: String!, $body: String!) {
            commentCreate(input: { issueId: $issueId, body: $body }) { success }
        }
        """
        let req = LinearGraphQLRequest(
            query: mutation,
            variables: [
                "issueId": cleanIssue,
                "body": taggedBody,
            ],
            idempotencyKey: key
        )
        _ = try await transport.execute(req, apiKey: apiKey)

        let receipt = LinearSyncReceipt(
            operation: "comment",
            issueId: cleanIssue,
            seat: seat,
            sessionTag: sessionTag,
            idempotencyKey: key,
            stateOrBody: taggedBody
        )
        completedByIdempotencyKey[key] = receipt
        return receipt
    }

    /// Resolves a workflow state name to its UUID, caching the answer.  A
    /// workspace state id does not change, so re-querying it for every
    /// mutation only costs latency and API quota.
    private func resolveWorkflowStateId(named stateName: String) async throws -> String {
        if let cached = workflowStateIdsByName[stateName] {
            return cached
        }
        do {
            let resolved = try await transport.workflowStateId(named: stateName, apiKey: apiKey)
            workflowStateIdsByName[stateName] = resolved
            return resolved
        } catch {
            workflowStateIdsByName.removeValue(forKey: stateName)
            throw error
        }
    }

    /// Reserves an idempotency key for a mutation that is about to be sent.
    /// The receipt cache is only written once the mutation returns, so without
    /// this reservation two concurrent callers could send the same mutation.
    private func beginMutation(key: String) throws {
        guard !inFlightIdempotencyKeys.contains(key) else {
            throw LinearSyncError.mutationInFlight(key)
        }
        inFlightIdempotencyKeys.insert(key)
    }

    /// Releases the reservation for a mutation that finished, successfully or
    /// not.
    private func endMutation(key: String) {
        inFlightIdempotencyKeys.remove(key)
    }
}
