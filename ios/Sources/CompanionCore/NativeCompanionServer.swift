import CryptoKit
import Foundation
#if canImport(Network)
import Network
#endif

/// Represents an incoming HTTP request to the native companion server.
/// Used both by the `NWListener` wire parser and by direct unit tests.
public struct CompanionHTTPRequest: Sendable, Equatable {
    public let method: String
    public let path: String
    public let queryItems: [String: String]
    public let headers: [String: String]
    public let body: Data?
    public let remoteAddress: String

    public init(
        method: String,
        path: String,
        queryItems: [String: String] = [:],
        headers: [String: String] = [:],
        body: Data? = nil,
        remoteAddress: String = "127.0.0.1"
    ) {
        self.method = method.uppercased()
        let (cleanPath, parsedQuery) = Self.splitPathAndQuery(path)
        self.path = cleanPath
        var mergedQuery = parsedQuery
        for (k, v) in queryItems {
            mergedQuery[k] = v
        }
        self.queryItems = mergedQuery
        self.headers = headers
        self.body = body
        self.remoteAddress = remoteAddress
    }

    public init(
        method: String,
        path: String,
        queryItems: [String: String] = [:],
        headers: [String: String] = [:],
        jsonString: String,
        remoteAddress: String = "127.0.0.1"
    ) {
        var updatedHeaders = headers
        if !updatedHeaders.keys.contains(where: { $0.lowercased() == "content-type" }) {
            updatedHeaders["Content-Type"] = "application/json"
        }
        self.init(
            method: method,
            path: path,
            queryItems: queryItems,
            headers: updatedHeaders,
            body: Data(jsonString.utf8),
            remoteAddress: remoteAddress
        )
    }

    public func headerValue(for name: String) -> String? {
        let lower = name.lowercased()
        return headers.first(where: { $0.key.lowercased() == lower })?.value
    }

    private static func splitPathAndQuery(_ rawPath: String) -> (String, [String: String]) {
        guard let questionIndex = rawPath.firstIndex(of: "?") else {
            return (rawPath, [:])
        }
        let cleanPath = String(rawPath[..<questionIndex])
        let queryString = String(rawPath[rawPath.index(after: questionIndex)...])
        var items: [String: String] = [:]
        var components = URLComponents()
        components.percentEncodedQuery = queryString
        for item in components.queryItems ?? [] {
            items[item.name] = item.value ?? ""
        }
        return (cleanPath, items)
    }
}

/// Represents an HTTP response returned by `NativeCompanionServer`.
public struct CompanionHTTPResponse: Sendable, Equatable {
    public let statusCode: Int
    public let headers: [String: String]
    public let body: Data

    public init(
        statusCode: Int,
        headers: [String: String] = ["Content-Type": "application/json; charset=utf-8"],
        body: Data
    ) {
        self.statusCode = statusCode
        self.headers = headers
        self.body = body
    }

    public var bodyString: String {
        String(data: body, encoding: .utf8) ?? ""
    }

    public func decodeJSON<T: Decodable>(_ type: T.Type, decoder: JSONDecoder = JSONDecoder()) throws -> T {
        try decoder.decode(type, from: body)
    }

    public static func json<T: Encodable>(_ statusCode: Int, _ payload: T, encoder: JSONEncoder = JSONEncoder()) -> CompanionHTTPResponse {
        let data = (try? encoder.encode(payload)) ?? Data("{}".utf8)
        return CompanionHTTPResponse(statusCode: statusCode, body: data)
    }

    public static func error(_ statusCode: Int, _ message: String) -> CompanionHTTPResponse {
        json(statusCode, ["error": message])
    }
}

/// Runtime configuration exposed and updated through `NativeCompanionServer`.
public struct CompanionServerConfig: Codable, Sendable, Equatable {
    public var allowRemoteDesktopLaunch: Bool
    public var autoUpdateEnabled: Bool
    public var roomTerminology: String
    public var dataDirectory: String?

    public init(
        allowRemoteDesktopLaunch: Bool = false,
        autoUpdateEnabled: Bool = true,
        roomTerminology: String = "Room",
        dataDirectory: String? = nil
    ) {
        self.allowRemoteDesktopLaunch = allowRemoteDesktopLaunch
        self.autoUpdateEnabled = autoUpdateEnabled
        self.roomTerminology = roomTerminology
        self.dataDirectory = dataDirectory
    }
}

/// Bot summary returned on `GET /api/bots` and `GET /api/fleet`.
public struct CompanionBotRecord: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public var name: String
    public var title: String
    public var status: String

    public init(id: String, name: String, title: String, status: String = "idle") {
        self.id = id
        self.name = name
        self.title = title
        self.status = status
    }
}

/// Search item returned by `GET /api/search`.
public struct CompanionSearchItem: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let threadId: String
    public let snippet: String
    public let content: String
    public let createdAt: Double

    public init(from result: DatabaseSearchResult) {
        self.id = result.id
        self.threadId = result.threadId
        self.snippet = result.snippet
        self.content = result.content
        self.createdAt = result.createdAt
    }
}

/// Search response envelope for `GET /api/search`.
public struct CompanionSearchResponse: Codable, Sendable, Equatable {
    public let results: [CompanionSearchItem]
}

// MARK: - Native APNs ES256 Provider

/// Errors thrown by `NativeAPNsProvider` when signing tokens or building push requests.
public enum NativeAPNsError: LocalizedError, Sendable, Equatable {
    case invalidPrivateKey(String)
    case invalidDeviceToken
    case malformedJWT
    case signatureVerificationFailed

    public var errorDescription: String? {
        switch self {
        case .invalidPrivateKey(let detail):
            return "Invalid APNs P-256 private key: \(detail)"
        case .invalidDeviceToken:
            return "Device token must be a non-empty hex string."
        case .malformedJWT:
            return "JWT does not contain three base64url segments."
        case .signatureVerificationFailed:
            return "ES256 JWT signature verification failed."
        }
    }
}

/// Pure-Swift APNs provider using CryptoKit `P256.Signing.PrivateKey` (`ES256`) JWT authentication.
/// Eliminates the Node sidecar `apns.ts` child process while sharing `PushSenderHealth` telemetry.
public actor NativeAPNsProvider {
    public let keyId: String
    public let teamId: String
    public let bundleId: String
    public let production: Bool

    private let signingMaterial: P256.Signing.PrivateKey
    private var cachedToken: (jwt: String, issuedAt: Date)?
    /// Reuse provider JWTs for 50 minutes (Apple enforces a 20-minute minimum refresh interval and 60-minute expiry).
    public static let tokenReuseInterval: TimeInterval = 50 * 60

    private var sentCount: Int = 0
    private var failedCount: Int = 0
    private var droppedCount: Int = 0
    private var lastSentAtMs: Double?
    private var lastErrorAtMs: Double?
    private var lastError: String?
    private var keyRejected: String?

    public init(
        p8PEM: String,
        keyId: String,
        teamId: String,
        bundleId: String = "app.botfleet.ios",
        production: Bool = true
    ) throws {
        do {
            self.signingMaterial = try P256.Signing.PrivateKey(pemRepresentation: p8PEM)
        } catch {
            throw NativeAPNsError.invalidPrivateKey(error.localizedDescription)
        }
        self.keyId = keyId
        self.teamId = teamId
        self.bundleId = bundleId
        self.production = production
    }

    public init(
        signingMaterial: P256.Signing.PrivateKey,
        keyId: String,
        teamId: String,
        bundleId: String = "app.botfleet.ios",
        production: Bool = true
    ) {
        self.signingMaterial = signingMaterial
        self.keyId = keyId
        self.teamId = teamId
        self.bundleId = bundleId
        self.production = production
    }

    public nonisolated var publicKey: P256.Signing.PublicKey {
        signingMaterial.publicKey
    }

    /// Generates or returns a cached ES256 JWT signed with the provider's `.p8` key.
    public func providerToken(now: Date = Date(), forceRefresh: Bool = false) throws -> String {
        if !forceRefresh,
           let cached = cachedToken,
           now.timeIntervalSince(cached.issuedAt) < Self.tokenReuseInterval,
           now.timeIntervalSince(cached.issuedAt) >= 0 {
            return cached.jwt
        }

        let jwt = try Self.generateES256JWT(
            signingMaterial: signingMaterial,
            keyId: keyId,
            teamId: teamId,
            issuedAt: now
        )
        cachedToken = (jwt, now)
        return jwt
    }

    /// Stateless helper that signs an APNs ES256 JWT using CryptoKit P-256.
    public static func generateES256JWT(
        signingMaterial: P256.Signing.PrivateKey,
        keyId: String,
        teamId: String,
        issuedAt: Date = Date()
    ) throws -> String {
        let iat = Int(issuedAt.timeIntervalSince1970.rounded(.down))
        let headerJSON = "{\"alg\":\"ES256\",\"kid\":\"\(keyId)\"}"
        let claimsJSON = "{\"iss\":\"\(teamId)\",\"iat\":\(iat)}"

        let headerB64 = base64URLEncode(Data(headerJSON.utf8))
        let claimsB64 = base64URLEncode(Data(claimsJSON.utf8))
        let signingInput = "\(headerB64).\(claimsB64)"

        let signature = try signingMaterial.signature(for: Data(signingInput.utf8))
        // JWS ES256 requires the 64-byte IEEE P1363 raw (r || s) representation.
        let signatureB64 = base64URLEncode(signature.rawRepresentation)
        return "\(signingInput).\(signatureB64)"
    }

    /// Verifies an ES256 JWT against a `P256.Signing.PublicKey` and returns the decoded header and claims dictionaries.
    public static func verifyES256JWT(
        _ jwt: String,
        publicKey: P256.Signing.PublicKey
    ) throws -> (header: [String: Any], claims: [String: Any]) {
        let parts = jwt.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else {
            throw NativeAPNsError.malformedJWT
        }
        let headerB64 = String(parts[0])
        let claimsB64 = String(parts[1])
        let signatureB64 = String(parts[2])

        guard let headerData = base64URLDecode(headerB64),
              let claimsData = base64URLDecode(claimsB64),
              let sigData = base64URLDecode(signatureB64) else {
            throw NativeAPNsError.malformedJWT
        }

        let signingInput = Data("\(headerB64).\(claimsB64)".utf8)
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: sigData)
        guard publicKey.isValidSignature(signature, for: signingInput) else {
            throw NativeAPNsError.signatureVerificationFailed
        }

        guard let headerObj = try JSONSerialization.jsonObject(with: headerData) as? [String: Any],
              let claimsObj = try JSONSerialization.jsonObject(with: claimsData) as? [String: Any] else {
            throw NativeAPNsError.malformedJWT
        }
        return (headerObj, claimsObj)
    }

    /// Builds an authenticated HTTP/2 APNs push `URLRequest`.
    public func buildPushRequest(
        deviceToken: String,
        payload: [String: Any],
        pushType: String = "alert",
        priority: Int = 10,
        topic: String? = nil,
        now: Date = Date()
    ) throws -> URLRequest {
        let trimmedToken = deviceToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedToken.isEmpty,
              trimmedToken.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) }) else {
            throw NativeAPNsError.invalidDeviceToken
        }

        let jwt = try providerToken(now: now)
        let host = production ? "api.push.apple.com" : "api.sandbox.push.apple.com"
        guard let url = URL(string: "https://\(host)/3/device/\(trimmedToken)") else {
            throw NativeAPNsError.invalidDeviceToken
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("bearer \(jwt)", forHTTPHeaderField: "authorization")
        request.setValue(topic ?? bundleId, forHTTPHeaderField: "apns-topic")
        request.setValue(pushType, forHTTPHeaderField: "apns-push-type")
        request.setValue(String(priority), forHTTPHeaderField: "apns-priority")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        return request
    }

    public func recordSendSuccess(at now: Date = Date()) {
        sentCount += 1
        lastSentAtMs = now.timeIntervalSince1970 * 1000.0
    }

    public func recordSendFailure(reason: String, isKeyRejected: Bool = false, at now: Date = Date()) {
        failedCount += 1
        lastErrorAtMs = now.timeIntervalSince1970 * 1000.0
        lastError = reason
        if isKeyRejected {
            keyRejected = reason
        }
    }

    public func healthSnapshot(tokensRegistered: Int) -> PushSenderHealth {
        PushSenderHealth(
            configured: true,
            production: production,
            tokensRegistered: tokensRegistered,
            sent: sentCount,
            failed: failedCount,
            lastSentAt: lastSentAtMs,
            lastErrorAt: lastErrorAtMs,
            lastError: lastError,
            keyRejected: keyRejected,
            dropped: droppedCount
        )
    }

    public static func base64URLEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func base64URLDecode(_ string: String) -> Data? {
        var base64 = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder > 0 {
            base64.append(String(repeating: "=", count: 4 - remainder))
        }
        return Data(base64Encoded: base64)
    }
}

// MARK: - NativeCompanionServer Actor

/// Errors thrown by `NativeCompanionServer` itself (not by the routes it serves).
public enum NativeCompanionServerError: LocalizedError, Sendable, Equatable {
    case invalidPort(UInt16)

    public var errorDescription: String? {
        switch self {
        case .invalidPort(let port):
            return "Invalid companion server port \(port)."
        }
    }
}

/// Upper bounds, in UTF-8 bytes, on the fields a paired device can send.
/// Every request body field is bounded before it can reach SQLite or the FTS
/// index, so a single request cannot exhaust memory or a downstream buffer.
public enum CompanionFieldLimits {
    public static let pairingCode = 128
    public static let searchQuery = 512
    public static let searchThreadId = 128
    public static let messageId = 128
    public static let messageRole = 64
    public static let messageKind = 64
    public static let messageContent = 64 * 1024
    public static let messageTitle = 512
    public static let pushToken = 512
    public static let roomTerminology = 256
}

/// Pure-Swift HTTP and SSE companion server actor built on `Network.framework`.
/// Enforces the default-deny allowlist from `companion/src/routes.ts`, constant-time
/// Bearer token verification, and both BF-2489 security gates on `POST /api/desktop/open`.
public actor NativeCompanionServer {
    private let database: DatabaseService
    private var pairedTokens: Set<String>
    private var pairingCode: String?
    /// When the open pairing window closes.  `nil` means no window is open.
    private var pairingCodeExpiresAt: Date?
    /// How many more wrong pairing codes the open window will accept.
    private var pairingAttemptsRemaining: Int = 0
    private var config: CompanionServerConfig
    private var bots: [CompanionBotRecord]
    private var pushTokens: Set<String> = []
    private var liveActivityTokens: Set<String> = []
    private var apnsProvider: NativeAPNsProvider?
    private var interruptedThreadIds: Set<String> = []
    private var sseContinuationById: [UUID: AsyncStream<String>.Continuation] = [:]

    public private(set) var desktopOpenCount: Int = 0
    public private(set) var shutdownRequested: Bool = false
    public private(set) var stoppedMarkerPath: String?

    /// A pairing window lives for two minutes and tolerates five wrong guesses
    /// before it burns, matching `companion/src/devices.ts`
    /// (`PAIRING_TTL_MS`, `MAX_PAIRING_ATTEMPTS`).
    public static let pairingWindowTTL: TimeInterval = 120
    public static let pairingMaxAttempts: Int = 5

    /// The default and the maximum number of rows one search may return.  The
    /// limit is clamped before it reaches `sqlite3_bind_int`, which takes an
    /// `Int32`: an oversized value would trap, and a negative value would
    /// become `LIMIT -1` (no limit at all).
    public static let defaultSearchLimit: Int = 50
    public static let maxSearchLimit: Int = 500

    /// The largest request the server buffers, in bytes.  A request is
    /// buffered before it is routed or authenticated, so an unauthenticated
    /// peer must not be able to grow the process's memory.
    public static let maxRequestBytes: Int = 256 * 1024

    /// How many SSE frames are kept for a subscriber that is not reading.
    /// The newest frames win, so a slow client cannot grow the buffer.
    public static let sseBufferCapacity: Int = 256

    /// The address returned for a peer whose endpoint kind this server does not
    /// recognise.  It is deliberately not a loopback address: an unclassified
    /// peer must fail the loopback gate closed, not open.
    public static let unclassifiedRemoteAddress: String = "0.0.0.0"

    private var onDesktopOpen: (@Sendable () async throws -> Void)?
    private var onShutdown: (@Sendable () async -> Void)?

    #if canImport(Network)
    private var listener: NWListener?
    private let listenerQueue = DispatchQueue(label: "app.botfleet.companion-server", qos: .userInitiated)
    #endif

    public init(
        database: DatabaseService,
        pairedTokens: Set<String> = [],
        pairingCode: String? = nil,
        config: CompanionServerConfig = CompanionServerConfig(),
        bots: [CompanionBotRecord] = [],
        apnsProvider: NativeAPNsProvider? = nil,
        onDesktopOpen: (@Sendable () async throws -> Void)? = nil,
        onShutdown: (@Sendable () async -> Void)? = nil
    ) {
        self.database = database
        self.pairedTokens = pairedTokens
        self.pairingCode = pairingCode
        self.pairingCodeExpiresAt = pairingCode.map { _ in
            Date().addingTimeInterval(NativeCompanionServer.pairingWindowTTL)
        }
        self.pairingAttemptsRemaining = pairingCode == nil ? 0 : NativeCompanionServer.pairingMaxAttempts
        self.config = config
        self.bots = bots
        self.apnsProvider = apnsProvider
        self.onDesktopOpen = onDesktopOpen
        self.onShutdown = onShutdown
    }

    // MARK: - Security Helpers

    /// Constant-time comparison of two secret strings so timing attacks cannot leak token prefixes.
    public static func constantTimeEquals(_ lhs: String, _ rhs: String) -> Bool {
        let lhsBytes = Array(lhs.utf8)
        let rhsBytes = Array(rhs.utf8)
        let maxCount = max(lhsBytes.count, rhsBytes.count)
        var diff: UInt8 = lhsBytes.count == rhsBytes.count ? 0 : 1
        for i in 0..<maxCount {
            let a = i < lhsBytes.count ? lhsBytes[i] : 0
            let b = i < rhsBytes.count ? rhsBytes[i] : 0
            diff |= (a ^ b)
        }
        return diff == 0
    }

    /// Loopback address classifier for BF-2489 and system shutdown routes.
    /// Accepts `127.0.0.1`, `::1`, and `::ffff:127.0.0.1` (with or without bracketed IPv6 notation).
    public static func isLoopbackAddress(_ rawAddress: String) -> Bool {
        var cleaned = rawAddress.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if cleaned.hasPrefix("[") && cleaned.hasSuffix("]") {
            cleaned.removeFirst()
            cleaned.removeLast()
        } else if cleaned.hasPrefix("["), let closeBracket = cleaned.firstIndex(of: "]") {
            cleaned = String(cleaned[cleaned.index(after: cleaned.startIndex)..<closeBracket])
        } else if cleaned.filter({ $0 == ":" }).count == 1, let colon = cleaned.lastIndex(of: ":") {
            // Strip port from IPv4 `127.0.0.1:54321`
            cleaned = String(cleaned[..<colon])
        }
        return cleaned == "127.0.0.1" || cleaned == "::1" || cleaned == "::ffff:127.0.0.1"
    }

    private func isAuthenticated(_ request: CompanionHTTPRequest) -> Bool {
        guard let authHeader = request.headerValue(for: "Authorization") else {
            return false
        }
        let prefix = "Bearer "
        guard authHeader.count > prefix.count,
              authHeader.lowercased().hasPrefix(prefix.lowercased()) else {
            return false
        }
        let candidate = String(authHeader.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
        guard !candidate.isEmpty else { return false }

        var matched = false
        for storedToken in pairedTokens {
            if Self.constantTimeEquals(candidate, storedToken) {
                matched = true
            }
        }
        return matched
    }

    // MARK: - Configuration & State Mutation

    public func setAllowRemoteDesktopLaunch(_ allowed: Bool) {
        config.allowRemoteDesktopLaunch = allowed
    }

    public func currentConfig() -> CompanionServerConfig {
        config
    }

    public func addPairedToken(_ token: String) {
        pairedTokens.insert(token)
    }

    /// Opens a pairing window for the Mac side to show on its own loopback
    /// page.  The code is a credential for `pairingWindowTTL` seconds and is
    /// spent by the first device that redeems it.
    public func openPairingWindow(
        code: String,
        ttl: TimeInterval = NativeCompanionServer.pairingWindowTTL,
        maxAttempts: Int = NativeCompanionServer.pairingMaxAttempts
    ) {
        pairingCode = code
        pairingCodeExpiresAt = Date().addingTimeInterval(ttl)
        pairingAttemptsRemaining = max(1, maxAttempts)
    }

    /// Closes the open pairing window, so a code that is still on screen stops
    /// working at once.
    public func closePairingWindow() {
        pairingCode = nil
        pairingCodeExpiresAt = nil
        pairingAttemptsRemaining = 0
    }

    /// Subscribes to Server-Sent Events emitted by the companion server.
    public func subscribeSSE() -> AsyncStream<String> {
        subscribeSSEWithIdentifier().stream
    }

    /// Subscribes to Server-Sent Events and returns the subscriber's id, so a
    /// caller that owns the transport can retire the subscription itself
    /// instead of waiting for the stream to terminate.
    func subscribeSSEWithIdentifier() -> (stream: AsyncStream<String>, id: UUID) {
        let id = UUID()
        let stream = AsyncStream<String>(bufferingPolicy: .bufferingNewest(Self.sseBufferCapacity)) { continuation in
            sseContinuationById[id] = continuation
            continuation.yield("event: connected\ndata: {\"ok\":true}\n\n")
            continuation.onTermination = { [weak self] _ in
                Task {
                    await self?.removeSSESubscriber(id: id)
                }
            }
        }
        return (stream, id)
    }

    private func removeSSESubscriber(id: UUID) {
        sseContinuationById.removeValue(forKey: id)
    }

    private func broadcastSSE(event: String, jsonPayload: String) {
        let frame = "event: \(event)\ndata: \(jsonPayload)\n\n"
        for continuation in sseContinuationById.values {
            continuation.yield(frame)
        }
    }

    /// Serializes an SSE payload with `JSONSerialization` so a client-supplied
    /// value cannot break the JSON body or forge an extra event frame.
    static func ssePayload(_ payload: [String: String]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return text
    }

    // MARK: - HTTP Request Router (Default-Deny Allowlist)

    /// Primary HTTP request entrypoint for both `NWConnection` and unit tests.
    /// Every route not explicitly listed on the companion allowlist returns `404 {"error":"no_route"}`.
    public func handleRequest(_ request: CompanionHTTPRequest) async -> CompanionHTTPResponse {
        let method = request.method.uppercased()
        let path = request.path

        // 1. Open routes (unauthenticated)
        if method == "GET" && path == "/api/health" {
            struct HealthPayload: Encodable {
                let ok: Bool
                let status: String
            }
            return .json(200, HealthPayload(ok: true, status: "healthy"))
        }

        if method == "POST" && path == "/api/pair" {
            return handlePair(request)
        }

        // 2. Bearer authentication check for all non-open routes
        guard isAuthenticated(request) else {
            return .error(401, "pair this device from Phone settings in BotFleet on your computer")
        }

        // 3. Default-deny allowlist dispatch
        switch (method, path) {
        case ("GET", "/api/fleet"):
            return handleGetFleet()

        case ("GET", "/api/bots"):
            return .json(200, bots)

        case ("GET", "/api/search"):
            return await handleSearch(request)

        case ("GET", "/api/config"):
            return .json(200, config)

        case ("PUT", "/api/config"):
            return handlePutConfig(request)

        case ("POST", "/api/companion/push-token"):
            return handleRegisterPushToken(request, isLiveActivity: false)

        case ("POST", "/api/companion/live-activity"),
             ("POST", "/api/companion/live-activity-token"):
            return handleRegisterPushToken(request, isLiveActivity: true)

        case ("GET", "/api/companion/push-health"):
            return await handlePushHealth()

        case ("POST", "/api/desktop/open"):
            return await handleDesktopOpen(request)

        case ("POST", "/api/system/shutdown"):
            return await handleSystemShutdown(request)

        case ("GET", "/api/events"):
            // The socket path streams `subscribeSSE()` frames and keeps the
            // connection open (see `streamEvents`).  This branch answers an
            // in-process caller with one well-formed frame.
            return CompanionHTTPResponse(
                statusCode: 200,
                headers: [
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                ],
                body: Data("event: connected\ndata: {\"ok\":true}\n\n".utf8)
            )

        default:
            if let threadRoute = matchThreadRoute(method: method, path: path) {
                return await handleThreadRoute(threadRoute, request: request)
            }
            // Default deny: anything unlisted returns 404 {"error":"no_route"} so a stolen token cannot map the API.
            return .error(404, "no_route")
        }
    }

    // MARK: - Route Handlers

    private func handlePair(_ request: CompanionHTTPRequest) -> CompanionHTTPResponse {
        struct PairRequest: Decodable {
            let code: String
            let deviceName: String?
        }
        guard let body = request.body,
              let payload = try? JSONDecoder().decode(PairRequest.self, from: body),
              !payload.code.isEmpty else {
            return .error(400, "invalid_pair_request")
        }
        guard payload.code.utf8.count <= CompanionFieldLimits.pairingCode else {
            return .error(400, "pairing_code_too_long")
        }

        // Fail closed.  With no open pairing window there is no code to check
        // against, and skipping the check would mint a working bearer token for
        // the first unauthenticated caller on the socket.
        guard let expectedCode = pairingCode, !expectedCode.isEmpty else {
            return .error(503, "pairing_unavailable")
        }
        if let expiry = pairingCodeExpiresAt, Date() >= expiry {
            closePairingWindow()
            return .error(503, "pairing_code_expired")
        }
        guard pairingAttemptsRemaining > 0 else {
            closePairingWindow()
            return .error(429, "pairing_attempts_exhausted")
        }
        guard Self.constantTimeEquals(payload.code, expectedCode) else {
            pairingAttemptsRemaining -= 1
            if pairingAttemptsRemaining <= 0 {
                closePairingWindow()
                return .error(429, "pairing_attempts_exhausted")
            }
            return .error(403, "invalid_pairing_code")
        }

        let issuedToken = "bf_tok_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())"
        pairedTokens.insert(issuedToken)
        // One code, one device: redeeming the code spends the window.
        closePairingWindow()
        return .json(200, [
            "token": issuedToken,
            "deviceId": UUID().uuidString.lowercased(),
        ])
    }

    private func handleGetFleet() -> CompanionHTTPResponse {
        struct FleetSummary: Encodable {
            let bots: [CompanionBotRecord]
            let pairedDevices: Int
            let pushTokensRegistered: Int
        }
        let summary = FleetSummary(
            bots: bots,
            pairedDevices: pairedTokens.count,
            pushTokensRegistered: pushTokens.count
        )
        return .json(200, summary)
    }

    private func handleSearch(_ request: CompanionHTTPRequest) async -> CompanionHTTPResponse {
        let query = request.queryItems["q"] ?? request.queryItems["query"] ?? ""
        let threadId = request.queryItems["threadId"]
        guard query.utf8.count <= CompanionFieldLimits.searchQuery else {
            return .error(400, "query_too_long")
        }
        if let threadId, threadId.utf8.count > CompanionFieldLimits.searchThreadId {
            return .error(400, "thread_id_too_long")
        }
        // `sqlite3_bind_int` takes an `Int32`, so an unclamped value would trap
        // the process, and a negative one would become `LIMIT -1` (no limit).
        let requestedLimit = request.queryItems["limit"].flatMap(Int.init) ?? Self.defaultSearchLimit
        let limit = min(max(requestedLimit, 1), Self.maxSearchLimit)

        do {
            let hits = try await database.search(query: query, inThread: threadId, limit: limit)
            let items = hits.map(CompanionSearchItem.init(from:))
            return .json(200, CompanionSearchResponse(results: items))
        } catch {
            return .error(500, "search_failed")
        }
    }

    private func handlePutConfig(_ request: CompanionHTTPRequest) -> CompanionHTTPResponse {
        struct ConfigPatch: Decodable {
            let allowRemoteDesktopLaunch: Bool?
            let autoUpdateEnabled: Bool?
            let roomTerminology: String?
        }
        guard let body = request.body,
              let patch = try? JSONDecoder().decode(ConfigPatch.self, from: body) else {
            return .error(400, "invalid_config_body")
        }
        // BF-2489: the desktop-launch gate is an owner-side Mac setting
        // (`server/knob-map.ts` -> `server.allowRemoteDesktopLaunch`), and the
        // companion proxy replays a phone request over loopback, so a phone
        // that could write it would clear both gates of `POST /api/desktop/open`.
        // It stays settable through the owner-side `setAllowRemoteDesktopLaunch`.
        if patch.allowRemoteDesktopLaunch != nil {
            return .error(403, "allowRemoteDesktopLaunch can only be changed on your computer")
        }
        if let autoUpdate = patch.autoUpdateEnabled {
            config.autoUpdateEnabled = autoUpdate
        }
        if let terminology = patch.roomTerminology {
            guard terminology.utf8.count <= CompanionFieldLimits.roomTerminology else {
                return .error(400, "room_terminology_too_long")
            }
            config.roomTerminology = terminology
        }
        return .json(200, config)
    }

    private func handleRegisterPushToken(_ request: CompanionHTTPRequest, isLiveActivity: Bool) -> CompanionHTTPResponse {
        guard let body = request.body,
              let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
            return .error(400, "invalid_json")
        }
        let unsupportedKey = json.keys.first(where: { $0 != "token" })
        if let unsupportedKey {
            return .error(400, "\(unsupportedKey) is not part of a token registration")
        }
        guard let token = json["token"] as? String, !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .error(400, "token must be a non-empty string")
        }
        guard token.utf8.count <= CompanionFieldLimits.pushToken else {
            return .error(400, "token_too_long")
        }
        if isLiveActivity {
            liveActivityTokens.insert(token)
        } else {
            pushTokens.insert(token)
        }
        return .json(200, ["ok": true])
    }

    private func handlePushHealth() async -> CompanionHTTPResponse {
        if let provider = apnsProvider {
            let snapshot = await provider.healthSnapshot(tokensRegistered: pushTokens.count)
            return .json(200, snapshot)
        }
        let unconfigured = PushSenderHealth(
            configured: false,
            production: nil,
            tokensRegistered: pushTokens.count,
            sent: 0,
            failed: 0,
            lastSentAt: nil,
            lastErrorAt: nil,
            lastError: nil,
            keyRejected: nil,
            dropped: 0
        )
        return .json(200, unconfigured)
    }

    /// Enforces both BF-2489 security gates on `POST /api/desktop/open`:
    /// 1. Loopback address guard (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`).
    /// 2. Explicit `allowRemoteDesktopLaunch == true` setting gate so a request replayed over
    ///    `127.0.0.1` by the companion proxy is still refused when disabled.
    private func handleDesktopOpen(_ request: CompanionHTTPRequest) async -> CompanionHTTPResponse {
        guard Self.isLoopbackAddress(request.remoteAddress) else {
            return .error(403, "Desktop launch requires a loopback connection")
        }
        guard config.allowRemoteDesktopLaunch else {
            return .error(403, "Opening the desktop app from iOS is disabled in Mac settings")
        }
        do {
            try await onDesktopOpen?()
            desktopOpenCount += 1
            return .json(200, ["ok": true, "launched": true])
        } catch {
            return .error(500, "Failed to launch desktop application")
        }
    }

    /// Enforces `POST /api/system/shutdown`: loopback-only + JSON content-type,
    /// writes `stopped.marker`, and invokes the shutdown callback.
    private func handleSystemShutdown(_ request: CompanionHTTPRequest) async -> CompanionHTTPResponse {
        guard Self.isLoopbackAddress(request.remoteAddress) else {
            return .error(403, "Shutdown requires a loopback connection")
        }
        guard let contentType = request.headerValue(for: "Content-Type")?.lowercased(),
              contentType.contains("application/json") else {
            return .error(415, "Content-Type must be application/json")
        }

        if let dataDir = config.dataDirectory, !dataDir.isEmpty {
            let markerURL = URL(fileURLWithPath: dataDir).appendingPathComponent("stopped.marker")
            do {
                try FileManager.default.createDirectory(atPath: dataDir, withIntermediateDirectories: true)
                let markerPayload = "{\"stoppedAt\":\(Date().timeIntervalSince1970)}\n"
                try Data(markerPayload.utf8).write(to: markerURL, options: .atomic)
            } catch {
                // A supervisor waits on `stopped.marker`; reporting a stop that
                // never wrote the marker leaves it waiting forever.
                return .error(500, "failed_to_write_stopped_marker")
            }
            stoppedMarkerPath = markerURL.path
        }

        shutdownRequested = true
        await onShutdown?()
        return .json(200, ["ok": true, "stopped": true])
    }

    // MARK: - Thread Sub-Routes

    private enum ThreadRoute {
        case getThread(String)
        case postMessage(String)
        case interruptThread(String)
    }

    private func matchThreadRoute(method: String, path: String) -> ThreadRoute? {
        let prefix = "/api/threads/"
        guard path.hasPrefix(prefix) else { return nil }
        let remainder = String(path.dropFirst(prefix.count))
        let segments = remainder.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard let threadId = segments.first, Self.isValidIdentifier(threadId) else {
            return nil
        }

        if segments.count == 1 && method == "GET" {
            return .getThread(threadId)
        }
        if segments.count == 2 && segments[1] == "messages" {
            if method == "GET" { return .getThread(threadId) }
            if method == "POST" { return .postMessage(threadId) }
        }
        if segments.count == 2 && segments[1] == "interrupt" && method == "POST" {
            return .interruptThread(threadId)
        }
        return nil
    }

    private static func isValidIdentifier(_ value: String) -> Bool {
        guard !value.isEmpty else { return false }
        return value.unicodeScalars.allSatisfy { scalar in
            CharacterSet.alphanumerics.contains(scalar) || scalar == "-" || scalar == "_"
        }
    }

    private func handleThreadRoute(_ route: ThreadRoute, request: CompanionHTTPRequest) async -> CompanionHTTPResponse {
        switch route {
        case .getThread(let threadId):
            do {
                let messages = try await database.loadMessages(forThread: threadId)
                struct ThreadMessageDTO: Encodable {
                    let id: String
                    let threadId: String
                    let role: String
                    let kind: String
                    let content: String
                    let createdAt: Double
                }
                struct ThreadEnvelope: Encodable {
                    let id: String
                    let messages: [ThreadMessageDTO]
                }
                let dtos = messages.map {
                    ThreadMessageDTO(
                        id: $0.id,
                        threadId: $0.threadId,
                        role: $0.role,
                        kind: $0.kind,
                        content: $0.content,
                        createdAt: $0.createdAt
                    )
                }
                return .json(200, ThreadEnvelope(id: threadId, messages: dtos))
            } catch {
                return .error(500, "failed_to_load_thread")
            }

        case .postMessage(let threadId):
            struct PostMessagePayload: Decodable {
                let id: String?
                let role: String?
                let kind: String?
                let content: String
                let title: String?
            }
            guard let body = request.body,
                  let payload = try? JSONDecoder().decode(PostMessagePayload.self, from: body),
                  !payload.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return .error(400, "content is required")
            }
            // Every field is bounded before it can reach SQLite or the FTS index.
            if let id = payload.id, id.utf8.count > CompanionFieldLimits.messageId {
                return .error(400, "id_too_long")
            }
            if let role = payload.role, role.utf8.count > CompanionFieldLimits.messageRole {
                return .error(400, "role_too_long")
            }
            if let kind = payload.kind, kind.utf8.count > CompanionFieldLimits.messageKind {
                return .error(400, "kind_too_long")
            }
            if payload.content.utf8.count > CompanionFieldLimits.messageContent {
                return .error(400, "content_too_long")
            }
            if let title = payload.title, title.utf8.count > CompanionFieldLimits.messageTitle {
                return .error(400, "title_too_long")
            }
            let messageId = payload.id ?? "msg_\(UUID().uuidString.lowercased())"
            let now = Date().timeIntervalSince1970
            do {
                try await database.upsertThread(
                    ThreadRecord(id: threadId, title: payload.title ?? threadId, updatedAt: now)
                )
                let record = MessageRecord(
                    id: messageId,
                    threadId: threadId,
                    role: payload.role ?? "user",
                    kind: payload.kind ?? "text",
                    content: payload.content,
                    createdAt: now
                )
                try await database.insertMessage(record)
                broadcastSSE(
                    event: "message.created",
                    jsonPayload: Self.ssePayload(["id": messageId, "threadId": threadId])
                )
                return .json(201, [
                    "id": messageId,
                    "threadId": threadId,
                    "role": record.role,
                    "content": record.content,
                ])
            } catch {
                return .error(500, "failed_to_save_message")
            }

        case .interruptThread(let threadId):
            struct InterruptPayload: Encodable {
                let ok: Bool
                let threadId: String
            }
            interruptedThreadIds.insert(threadId)
            broadcastSSE(event: "thread.interrupted", jsonPayload: Self.ssePayload(["threadId": threadId]))
            return .json(200, InterruptPayload(ok: true, threadId: threadId))
        }
    }

    // MARK: - Network.framework Listener

    #if canImport(Network)
    /// How the cleartext device port is bound.  The port carries the pairing
    /// credential, the minted bearer token and every transcript frame in the
    /// clear, so it binds loopback by default and a routable address only
    /// through an explicit LAN opt-in, mirroring `companion/src/lan-policy.ts`
    /// (`DEFAULT_LAN_POLICY`, `CLEARTEXT_LAN_ENV`).
    public struct ListenerOptions: Sendable, Equatable {
        /// The address the listener binds when the LAN opt-in is off.
        public var bindAddress: String
        /// Set only by an explicit LAN opt-in; it is the only way off loopback.
        public var allowCleartextLAN: Bool

        public init(bindAddress: String = "127.0.0.1", allowCleartextLAN: Bool = false) {
            self.bindAddress = bindAddress
            self.allowCleartextLAN = allowCleartextLAN
        }

        /// The address actually bound.
        public var resolvedBindAddress: String {
            allowCleartextLAN ? "0.0.0.0" : bindAddress
        }
    }

    public func startListening(port: UInt16 = 0, options: ListenerOptions = ListenerOptions()) throws {
        let nwPort: NWEndpoint.Port
        if port == 0 {
            nwPort = .any
        } else {
            guard let resolved = NWEndpoint.Port(rawValue: port) else {
                throw NativeCompanionServerError.invalidPort(port)
            }
            nwPort = resolved
        }
        let listener = try NWListener(using: .tcp, on: nwPort)
        // Loopback by default: the cleartext device port must not be reachable
        // from the network unless someone opted in on purpose.
        listener.parameters.requiredLocalEndpoint = .hostPort(
            host: NWEndpoint.Host(options.resolvedBindAddress),
            port: nwPort
        )
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            Task {
                await self.acceptConnection(connection)
            }
        }
        listener.start(queue: listenerQueue)
        self.listener = listener
    }

    public func stopListening() {
        listener?.cancel()
        listener = nil
    }

    private func acceptConnection(_ connection: NWConnection) {
        connection.start(queue: listenerQueue)
        receiveRequest(on: connection, buffer: Data())
    }

    /// Reads one HTTP request off the socket.  A body may arrive in more than
    /// one TCP segment, so the read continues until the declared
    /// `Content-Length` has arrived instead of taking the first segment as the
    /// whole request.  The completion runs on the listener queue, so every
    /// step back onto the actor hops through `Task`.
    private func receiveRequest(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
            var accumulated = buffer
            if let data, !data.isEmpty {
                accumulated.append(data)
            }
            if error != nil {
                connection.cancel()
                return
            }
            // The buffer holds the request before it is routed or
            // authenticated, so it is bounded.  A peer that keeps sending
            // must not be able to grow the process's memory.
            if accumulated.count > Self.maxRequestBytes {
                Self.rejectOversizedRequest(on: connection)
                return
            }
            // A declared length over the limit is refused before the body is
            // read, so the peer never gets to fill the buffer.
            if let declared = Self.declaredContentLength(accumulated), declared > Self.maxRequestBytes {
                Self.rejectOversizedRequest(on: connection)
                return
            }
            if Self.requestBodyIsComplete(accumulated) {
                Task {
                    await self?.handleIncomingRequest(accumulated, on: connection)
                }
                return
            }
            if isComplete {
                connection.cancel()
                return
            }
            Task {
                await self?.receiveRequest(on: connection, buffer: accumulated)
            }
        }
    }

    /// Answers a request whose declared or actual size is over the limit and
    /// closes the connection.
    private static func rejectOversizedRequest(on connection: NWConnection) {
        let response = CompanionHTTPResponse.error(413, "request_too_large")
        connection.send(content: serializeHTTPResponse(response), completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    /// Serves one complete request off an accepted socket.
    private func handleIncomingRequest(_ raw: Data, on connection: NWConnection) async {
        let remoteAddr = Self.extractRemoteAddress(from: connection.endpoint)
        guard let httpReq = Self.parseRawHTTPRequest(raw, remoteAddress: remoteAddr) else {
            connection.cancel()
            return
        }
        if httpReq.method == "GET" && httpReq.path == "/api/events" {
            streamEvents(over: connection, request: httpReq)
            return
        }
        let response = await handleRequest(httpReq)
        let wireData = Self.serializeHTTPResponse(response)
        connection.send(content: wireData, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    /// Streams `subscribeSSE()` frames onto an accepted socket and keeps the
    /// connection open, so `message.created` and `thread.interrupted` actually
    /// reach a network client.
    private func streamEvents(over connection: NWConnection, request: CompanionHTTPRequest) {
        guard isAuthenticated(request) else {
            let response = CompanionHTTPResponse.error(
                401,
                "pair this device from Phone settings in BotFleet on your computer"
            )
            connection.send(content: Self.serializeHTTPResponse(response), completion: .contentProcessed { _ in
                connection.cancel()
            })
            return
        }
        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n"
        connection.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
        let subscription = subscribeSSEWithIdentifier()
        Task.detached { [weak self] in
            for await frame in subscription.stream {
                // A write that fails means the peer is gone.  The loop ends
                // there, so the task and its subscriber do not outlive the
                // connection.
                let failed = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                    connection.send(content: Data(frame.utf8), completion: .contentProcessed { error in
                        continuation.resume(returning: error != nil)
                    })
                }
                if failed { break }
            }
            await self?.removeSSESubscriber(id: subscription.id)
            connection.cancel()
        }
    }

    /// True when the accumulated bytes hold a whole HTTP request: the header
    /// block is terminated and the declared `Content-Length` body has arrived.
    static func requestBodyIsComplete(_ data: Data) -> Bool {
        guard let separator = data.range(of: Data("\r\n\r\n".utf8)) else {
            return false
        }
        let bodyLength = data.distance(from: separator.upperBound, to: data.endIndex)
        let declared = declaredContentLength(data) ?? 0
        guard declared > 0 else { return true }
        return bodyLength >= declared
    }

    /// The `Content-Length` declared in a request's header block, if the
    /// header block has arrived and the value is a number.
    static func declaredContentLength(_ data: Data) -> Int? {
        guard let separator = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let headData = data[data.startIndex..<separator.lowerBound]
        guard let head = String(data: headData, encoding: .utf8) else { return nil }
        for line in head.components(separatedBy: "\r\n") {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = String(line[..<colon]).trimmingCharacters(in: .whitespaces).lowercased()
            guard name == "content-length" else { continue }
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            return Int(value)
        }
        return nil
    }

    private static func extractRemoteAddress(from endpoint: NWEndpoint) -> String {
        switch endpoint {
        case .hostPort(let host, _):
            switch host {
            case .ipv4(let addr):
                return "\(addr)"
            case .ipv6(let addr):
                return "\(addr)"
            case .name(let name, _):
                return name
            @unknown default:
                // Fail closed: an endpoint kind this build does not understand
                // must not be treated as loopback by the BF-2489 gate.
                return NativeCompanionServer.unclassifiedRemoteAddress
            }
        default:
            return NativeCompanionServer.unclassifiedRemoteAddress
        }
    }

    public static func parseRawHTTPRequest(_ data: Data, remoteAddress: String = "127.0.0.1") -> CompanionHTTPRequest? {
        // Split at the first header terminator only: a body may itself contain
        // the separator, and everything after the first one is the body.
        let separator = Data("\r\n\r\n".utf8)
        let headData: Data
        let bodyData: Data
        if let range = data.range(of: separator) {
            headData = Data(data[data.startIndex..<range.lowerBound])
            bodyData = Data(data[range.upperBound...])
        } else {
            headData = data
            bodyData = Data()
        }
        guard let head = String(data: headData, encoding: .utf8) else { return nil }
        let lines = head.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return nil }
        let tokens = requestLine.split(separator: " ")
        guard tokens.count >= 2 else { return nil }
        let method = String(tokens[0])
        let path = String(tokens[1])

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            if let colon = line.firstIndex(of: ":") {
                let key = String(line[..<colon]).trimmingCharacters(in: .whitespaces)
                let value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
                headers[key] = value
            }
        }
        return CompanionHTTPRequest(
            method: method,
            path: path,
            headers: headers,
            body: bodyData.isEmpty ? nil : bodyData,
            remoteAddress: remoteAddress
        )
    }

    public static func serializeHTTPResponse(_ response: CompanionHTTPResponse) -> Data {
        var head = "HTTP/1.1 \(response.statusCode) OK\r\n"
        var headers = response.headers
        headers["Content-Length"] = "\(response.body.count)"
        for (k, v) in headers {
            head += "\(k): \(v)\r\n"
        }
        head += "\r\n"
        var out = Data(head.utf8)
        out.append(response.body)
        return out
    }
    #endif
}
