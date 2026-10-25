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

    public init(
        realmURL: URL = URL(string: "https://simplewithus.zulipchat.com")!,
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

    public init(queueId: String, lastEventId: Int) {
        self.queueId = queueId
        self.lastEventId = lastEventId
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
            throw ZulipActorError.apiError(code: code, message: msg)
        }
        guard let queueId = json["queue_id"] as? String,
              let lastEventId = json["last_event_id"] as? Int else {
            throw ZulipActorError.transportError("Missing queue_id or last_event_id")
        }
        return ZulipRegisterResponse(queueId: queueId, lastEventId: lastEventId)
    }

    public func getEvents(identity: ZulipBotIdentity, queueId: String, lastEventId: Int) async throws -> ZulipEventsResponse {
        var components = URLComponents(url: identity.realmURL.appendingPathComponent("api/v1/events"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "queue_id", value: queueId),
            URLQueryItem(name: "last_event_id", value: String(lastEventId)),
            URLQueryItem(name: "dont_block", value: "false"),
        ]
        var request = URLRequest(url: components.url!)
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
            throw ZulipActorError.apiError(code: code, message: msg)
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
        var components = URLComponents(url: identity.realmURL.appendingPathComponent("api/v1/messages"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "anchor", value: String(anchorMessageId)),
            URLQueryItem(name: "include_anchor", value: "false"),
            URLQueryItem(name: "num_before", value: "0"),
            URLQueryItem(name: "num_after", value: String(limit)),
        ]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "GET"
        request.setValue(basicAuthHeader(for: identity), forHTTPHeaderField: "Authorization")

        let (data, _) = try await session.data(for: request)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let messages = json["messages"] as? [[String: Any]] else {
            return []
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
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let msgId = json["id"] as? Int else {
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
        <untrusted_peer_message sender="\(message.senderEmail)" stream="\(message.streamName)" topic="\(message.subject)" message_id="\(message.id)">
        \(sanitizedBody)
        </untrusted_peer_message>
        """
    }

    /// Performs a single long-poll cycle, automatically registering the queue if needed,
    /// handling `BAD_EVENT_QUEUE_ID` by re-registering and backfilling missed messages from `highWaterMessageId`,
    /// and deduplicating all emitted `ZulipFencedMessage` values.
    public func pollOnce() async throws -> [ZulipFencedMessage] {
        do {
            if queueId == nil {
                try await registerAndCatchUp()
            }
            guard let activeQueueId = queueId else {
                return []
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
            return emitted
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
        self.queueId = reg.queueId
        self.lastEventId = reg.lastEventId

        // Backfill any messages that arrived while the queue was unregistered or expired.
        let missed = try await transport.fetchMessagesAfter(
            identity: identity,
            anchorMessageId: previousHighWater,
            limit: 1_000
        )
        return ingestRawMessages(missed)
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

    public var errorDescription: String? {
        switch self {
        case .invalidSeat(let reason):
            return "LinearSyncClient seat validation failed: \(reason)"
        case .emptyIssueId:
            return "Linear issue identifier must not be empty."
        case .graphQLError(let detail):
            return "Linear GraphQL error: \(detail)"
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
}

/// Default `URLSession` transport for Linear's GraphQL endpoint (`https://api.linear.app/graphql`).
public struct URLSessionLinearGraphQLTransport: LinearGraphQLTransport {
    private let endpoint: URL
    private let session: URLSession

    public init(
        endpoint: URL = URL(string: "https://api.linear.app/graphql")!,
        session: URLSession = .shared
    ) {
        self.endpoint = endpoint
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
        return ["ok": "true"]
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

    public init(
        seat: String,
        sessionId: String,
        apiKey: String,
        transport: LinearGraphQLTransport = URLSessionLinearGraphQLTransport()
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
        self.transport = transport
    }

    public nonisolated var sessionTag: String {
        "[\(seat)·\(sessionId)]"
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

        let formattedNote = "\(sessionTag) Claimed \(cleanIssue) on branch `\(branch)` in `\(worktree)`."
        let mutation = """
        mutation ClaimIssue($issueId: String!, $stateName: String!, $commentBody: String!) {
            issueUpdate(id: $issueId, input: { stateId: $stateName }) { success }
            commentCreate(input: { issueId: $issueId, body: $commentBody }) { success }
        }
        """
        let req = LinearGraphQLRequest(
            query: mutation,
            variables: [
                "issueId": cleanIssue,
                "stateName": "In Progress",
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

        let summary = resolution.map { "\(sessionTag) Status -> \(status): \($0)" } ?? "\(sessionTag) Status -> \(status)"
        let mutation = """
        mutation UpdateIssueStatus($issueId: String!, $status: String!, $commentBody: String!) {
            issueUpdate(id: $issueId, input: { stateId: $status }) { success }
            commentCreate(input: { issueId: $issueId, body: $commentBody }) { success }
        }
        """
        let req = LinearGraphQLRequest(
            query: mutation,
            variables: [
                "issueId": cleanIssue,
                "status": status,
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
        let key = idempotencyKey ?? "comment:\(cleanIssue):\(seat):\(taggedBody.hashValue)"
        if let existing = completedByIdempotencyKey[key] {
            return existing.markingDeduplicated()
        }

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
}
