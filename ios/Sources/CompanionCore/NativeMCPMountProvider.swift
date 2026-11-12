import Foundation
#if canImport(Network)
import Network
#endif

/// Production local-only mount provider for native turns.
///
/// One loopback HTTP listener (127.0.0.1, ephemeral port, never advertised)
/// serves every mounted server under an unguessable per-bot/per-server token
/// path.  Each mount exposes exactly the granted catalog from its
/// `NativeMCPMountContext`: `tools/list` returns only those tools and
/// `tools/call` is dispatched through the context's checked `callTool`,
/// which revalidates bot, route, identity, and revision inside
/// `NativeTurnToolsActor`.  Unknown tokens, ungranted tools, sibling-bot
/// tools, and every other MCP method are refused.  The endpoint handed to
/// engines carries no headers, credential references, or upstream address,
/// and nothing about a request or credential is logged.
public actor NativeMCPLocalMountProvider: NativeMCPMountProvider {
    public static let maximumRequestBytes = 512 * 1024
    public static let maximumResponseBytes = 1024 * 1024 + 64 * 1024

    private var mountsByToken: [String: NativeMCPMountContext] = [:]
    private var tokenByKey: [String: String] = [:]
    private var fingerprintByKey: [String: MountFingerprint] = [:]

    /// Mount identity whose stability keeps a token (and URL) alive across
    /// periodic refreshes: bot/server come from the key, so this carries the
    /// identity plus the granted catalog in canonical order.
    private struct MountFingerprint: Equatable {
        let identity: NativeToolIdentity
        let tools: [NativeToolDefinition]

        init(_ context: NativeMCPMountContext) {
            identity = context.identity
            tools = context.tools.sorted {
                ($0.serverId, $0.name, $0.upstreamName, $0.description, $0.inputSchemaJSON, $0.access.rawValue)
                    < ($1.serverId, $1.name, $1.upstreamName, $1.description, $1.inputSchemaJSON, $1.access.rawValue)
            }
        }
    }

    #if canImport(Network)
    private var listener: NWListener?
    private var boundPort: UInt16?
    private var listenerStartTask: Task<UInt16, Error>?
    private var listenerStartID: UInt64 = 0
    /// Count of listeners ever created; concurrent mounts must keep this at 1.
    private(set) var listenerCreationCount = 0
    private let listenerQueue = DispatchQueue(label: "app.botfleet.local-mcp-mount", qos: .userInitiated)
    #endif

    public init() {}

    // MARK: - Mount lifecycle

    public func mount(_ context: NativeMCPMountContext) async throws -> NativeMCPMountEndpoint {
        let key = Self.key(context)
        let token = try register(context)
        #if canImport(Network)
        do {
            let port = try await ensureListener()
            // A newer mount may have superseded this token while the listener
            // start was suspended; never hand out a revoked URL.
            guard tokenByKey[key] == token else { throw NativeTurnToolError.mountUnavailable }
            return .loopbackHTTP(url: "http://127.0.0.1:\(port)/mcp/\(token)")
        } catch {
            removeMount(key: key, token: token)
            throw NativeTurnToolError.mountUnavailable
        }
        #else
        removeMount(key: key, token: token)
        throw NativeTurnToolError.mountUnavailable
        #endif
    }

    /// Removes a mount only while `token` is still the registration for
    /// `key`, so a failed or superseded mount cannot clobber a newer one.
    private func removeMount(key: String, token: String) {
        guard tokenByKey[key] == token else { return }
        tokenByKey.removeValue(forKey: key)
        fingerprintByKey.removeValue(forKey: key)
        mountsByToken.removeValue(forKey: token)
    }

    /// Validates the context and records it, reusing the existing token when
    /// the mount identity (bot, server, identity, granted catalog) is
    /// unchanged so a periodic refresh never revokes the URL an in-flight
    /// turn is using.  A changed identity or catalog rotates the token and
    /// revokes the previous one.  Internal so tests can exercise request
    /// handling without a socket.
    func register(_ context: NativeMCPMountContext) throws -> String {
        guard !context.botId.isEmpty,
              NativeTurnToolCatalog.validName(context.serverId),
              !context.identity.hostId.isEmpty,
              !context.identity.installationId.isEmpty,
              !context.identity.userId.isEmpty,
              !context.tools.isEmpty,
              context.tools.allSatisfy({ $0.serverId == context.serverId }),
              Set(context.tools.map(\.portableName)).count == context.tools.count
        else { throw NativeTurnToolError.mountUnavailable }
        let key = Self.key(context)
        let fingerprint = MountFingerprint(context)
        if let existing = tokenByKey[key], fingerprintByKey[key] == fingerprint {
            // Unchanged mount: keep the token/URL, swap in the fresh context
            // so calls dispatch through the newest checked closure.
            mountsByToken[existing] = context
            return existing
        }
        if let previous = tokenByKey[key] { mountsByToken.removeValue(forKey: previous) }
        var generator = SystemRandomNumberGenerator()
        let token = (0..<32).map { _ in String(format: "%02x", UInt8.random(in: .min ... .max, using: &generator)) }.joined()
        mountsByToken[token] = context
        tokenByKey[key] = token
        fingerprintByKey[key] = fingerprint
        return token
    }

    public func unmount(botId: String, serverId: String) {
        let key = "\(botId)\u{0}\(serverId)"
        fingerprintByKey.removeValue(forKey: key)
        if let token = tokenByKey.removeValue(forKey: key) { mountsByToken.removeValue(forKey: token) }
    }

    public func unmountAll() {
        mountsByToken.removeAll()
        tokenByKey.removeAll()
        fingerprintByKey.removeAll()
    }

    /// Stops the loopback listener and revokes every mount.
    public func stop() {
        unmountAll()
        #if canImport(Network)
        listenerStartID &+= 1
        listenerStartTask?.cancel()
        listenerStartTask = nil
        listener?.cancel()
        listener = nil
        boundPort = nil
        #endif
    }

    /// The port the loopback listener is bound to, once a mount started it.
    public var listeningPort: UInt16? {
        #if canImport(Network)
        return boundPort
        #else
        return nil
        #endif
    }

    private static func key(_ context: NativeMCPMountContext) -> String { "\(context.botId)\u{0}\(context.serverId)" }

    // MARK: - Request handling

    /// Answers one complete HTTP request.  Used by the socket glue and by
    /// tests; the returned bytes are a full HTTP response with the
    /// connection marked for close.
    func respond(to raw: Data) async -> Data {
        guard raw.count <= Self.maximumRequestBytes, let request = Self.parse(raw) else {
            return Self.http(status: 400, reason: "Bad Request", body: Data())
        }
        guard request.method == "POST" else {
            return Self.http(status: 405, reason: "Method Not Allowed", body: Data())
        }
        guard request.path.hasPrefix("/mcp/"),
              let context = mountsByToken[String(request.path.dropFirst(5))]
        else {
            return Self.http(status: 404, reason: "Not Found", body: Data())
        }
        guard let frame = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              frame["jsonrpc"] as? String == "2.0",
              let method = frame["method"] as? String
        else {
            return Self.http(status: 400, reason: "Bad Request", body: Data())
        }
        // Notifications never receive a JSON-RPC reply.
        guard let id = frame["id"], !(id is NSNull) else {
            return Self.http(status: 202, reason: "Accepted", body: Data())
        }
        let params = frame["params"] as? [String: Any] ?? [:]
        switch method {
        case "initialize":
            let requested = params["protocolVersion"] as? String
            let version = requested.flatMap { ["2024-11-05", "2025-03-26", "2025-06-18"].contains($0) ? $0 : nil } ?? "2025-03-26"
            return Self.rpc(id: id, result: [
                "protocolVersion": version,
                "capabilities": ["tools": [String: Any]()],
                "serverInfo": ["name": "botfleet-local-mcp", "version": "1"],
            ])
        case "ping":
            return Self.rpc(id: id, result: [:])
        case "tools/list":
            let tools: [[String: Any]] = context.tools.compactMap { tool in
                guard let schema = try? JSONSerialization.jsonObject(with: Data(tool.inputSchemaJSON.utf8)) else { return nil }
                return ["name": tool.portableName, "description": tool.description, "inputSchema": schema]
            }
            return Self.rpc(id: id, result: ["tools": tools])
        case "tools/call":
            return await callTool(id: id, context: context, params: params)
        default:
            return Self.rpcError(id: id, code: -32601, message: "method not found")
        }
    }

    private func callTool(id: Any, context: NativeMCPMountContext, params: [String: Any]) async -> Data {
        guard let name = params["name"] as? String,
              let tool = context.tools.first(where: { $0.portableName == name || $0.name == name })
        else {
            return Self.rpcError(id: id, code: -32602, message: "tool not granted")
        }
        let arguments = params["arguments"] as? [String: Any] ?? [:]
        guard let argumentsJSON = try? Self.json(arguments) else {
            return Self.rpcError(id: id, code: -32602, message: "invalid arguments")
        }
        do {
            let envelopeData = try await context.callTool(tool.name, argumentsJSON)
            guard envelopeData.count <= Self.maximumResponseBytes,
                  let envelope = try? JSONSerialization.jsonObject(with: envelopeData) as? [String: Any]
            else {
                return Self.rpcError(id: id, code: -32603, message: "tool call failed")
            }
            if let upstreamError = envelope["error"] as? [String: Any] {
                let code = upstreamError["code"] as? Int ?? -32603
                var message = upstreamError["message"] as? String ?? "tool call failed"
                if message.utf8.count > 512 { message = String(decoding: Array(message.utf8.prefix(512)), as: UTF8.self) }
                return Self.rpcError(id: id, code: code, message: message)
            }
            guard let result = envelope["result"] else {
                return Self.rpcError(id: id, code: -32603, message: "tool call failed")
            }
            return Self.rpc(id: id, result: result)
        } catch {
            return Self.rpcError(id: id, code: -32603, message: "tool call refused")
        }
    }

    // MARK: - Wire helpers

    private struct ParsedRequest { let method: String; let path: String; let body: Data }

    /// Whether a socket buffer holds a whole request, is still waiting for
    /// bytes, or can never become a valid request.  Malformed buffers are
    /// answered 400 immediately instead of being mistaken for incomplete
    /// ones and left hanging.
    enum RequestFraming: Equatable { case complete, incomplete, malformed }

    static func framing(_ raw: Data) -> RequestFraming { analyse(raw).framing }

    private static func parse(_ raw: Data) -> ParsedRequest? { analyse(raw).request }

    private static func analyse(_ raw: Data) -> (framing: RequestFraming, request: ParsedRequest?) {
        let crlf = raw.range(of: Data("\r\n\r\n".utf8))
        let lf = raw.range(of: Data("\n\n".utf8))
        let separator = [crlf, lf].compactMap { $0 }.min(by: { $0.lowerBound < $1.lowerBound })
        guard let separator else {
            return (partialHeadIsMalformed(raw) ? .malformed : .incomplete, nil)
        }
        guard let head = String(data: raw[..<separator.lowerBound], encoding: .utf8) else { return (.malformed, nil) }
        let lines = head.components(separatedBy: "\n").map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }
        guard let requestLine = lines.first, requestLineIsValid(requestLine) else { return (.malformed, nil) }
        let parts = requestLine.split(separator: " ")
        let target = String(parts[1])
        var contentLength: Int?
        for line in lines.dropFirst() {
            switch headerLineFraming(line, completeLine: true) {
            case .malformed: return (.malformed, nil)
            case .contentLength(let value): contentLength = value
            case .other: break
            }
        }
        guard let contentLength else { return (.malformed, nil) }
        let body = raw[separator.upperBound...]
        if body.count < contentLength { return (.incomplete, nil) }
        guard body.count == contentLength else { return (.malformed, nil) }
        return (.complete, ParsedRequest(method: String(parts[0]), path: target, body: Data(body)))
    }

    private static func requestLineIsValid(_ requestLine: String) -> Bool {
        let parts = requestLine.split(separator: " ")
        guard parts.count == 3, parts[2] == "HTTP/1.1" || parts[2] == "HTTP/1.0" else { return false }
        let target = String(parts[1])
        return !target.contains("?") && !target.contains("#")
    }

    private enum HeaderLine: Equatable { case other, contentLength(Int), malformed }

    private static func headerLineFraming(_ line: String, completeLine: Bool) -> HeaderLine {
        guard let colon = line.firstIndex(of: ":") else { return completeLine ? .malformed : .other }
        let name = line[..<colon].lowercased()
        let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        if name == "transfer-encoding" { return .malformed }
        if name == "content-length" {
            guard let length = Int(value), length >= 0, length <= maximumRequestBytes else { return .malformed }
            return .contentLength(length)
        }
        return .other
    }

    /// Before the header terminator arrives, a buffer is malformed only once
    /// a *complete* line can never be fixed by more bytes (a bad request line,
    /// a colon-less header, chunked encoding, or a bogus Content-Length).
    private static func partialHeadIsMalformed(_ raw: Data) -> Bool {
        guard let text = String(data: raw, encoding: .utf8) else {
            // Non-UTF-8 before any terminator: malformed once a line has ended.
            return raw.contains(UInt8(ascii: "\n"))
        }
        var lines = text.components(separatedBy: "\n").map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }
        if !text.hasSuffix("\n") { lines.removeLast() } // last segment is still arriving
        guard let requestLine = lines.first else { return false }
        guard requestLineIsValid(requestLine) else { return true }
        for line in lines.dropFirst() where headerLineFraming(line, completeLine: true) == .malformed { return true }
        return false
    }

    /// True when the buffer holds a full request under the declared
    /// `Content-Length`, so the socket reader knows when to stop.
    static func requestIsComplete(_ raw: Data) -> Bool { framing(raw) == .complete }

    private static func json(_ value: Any) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes])
        guard let result = String(data: data, encoding: .utf8) else { throw NativeTurnToolError.invalidResponse }
        return result
    }

    private static func rpc(id: Any, result: Any) -> Data {
        let body = (try? json(["jsonrpc": "2.0", "id": id, "result": result])) ?? "{}"
        return http(status: 200, reason: "OK", body: Data(body.utf8))
    }

    private static func rpcError(id: Any, code: Int, message: String) -> Data {
        let body = (try? json(["jsonrpc": "2.0", "id": id, "error": ["code": code, "message": message]])) ?? "{}"
        return http(status: 200, reason: "OK", body: Data(body.utf8))
    }

    private static func http(status: Int, reason: String, body: Data) -> Data {
        var response = Data("HTTP/1.1 \(status) \(reason)\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
        response.append(body)
        return response
    }
}

#if canImport(Network)
extension NativeMCPLocalMountProvider {
    /// Lazily binds the single loopback listener on the first mount, so
    /// constructing the provider opens nothing.
    private func ensureListener() async throws -> UInt16 {
        if let boundPort { return boundPort }
        // Single-flight: actor re-entrancy at the listener-start suspension
        // point must not let a concurrent mount create a second listener.
        if let listenerStartTask { return try await listenerStartTask.value }
        listenerStartID &+= 1
        let startID = listenerStartID
        let task = Task { try await self.startListener(startID: startID) }
        listenerStartTask = task
        return try await task.value
    }

    private func startListener(startID: UInt64) async throws -> UInt16 {
        defer { if listenerStartID == startID { listenerStartTask = nil } }
        if let boundPort { return boundPort }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host("127.0.0.1"), port: .any)
        let listener = try NWListener(using: parameters)
        listenerCreationCount += 1
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            Task { await self.serve(connection) }
        }
        self.listener = listener
        let settlement = LocalMountStartSettlement()
        do {
            let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
                listener.stateUpdateHandler = { [weak listener] state in
                    switch state {
                    case .ready:
                        if let port = listener?.port?.rawValue {
                            settlement.once { continuation.resume(returning: port) }
                        } else {
                            settlement.once { continuation.resume(throwing: NativeTurnToolError.mountUnavailable) }
                        }
                    case .failed:
                        settlement.once { continuation.resume(throwing: NativeTurnToolError.mountUnavailable) }
                    case .cancelled:
                        settlement.once { continuation.resume(throwing: NativeTurnToolError.mountUnavailable) }
                    default:
                        break
                    }
                }
                listener.start(queue: listenerQueue)
            }
            // stop() (or a newer start generation) invalidated this attempt.
            guard listenerStartID == startID, self.listener === listener else {
                listener.cancel()
                throw NativeTurnToolError.mountUnavailable
            }
            boundPort = port
            return port
        } catch {
            listener.cancel()
            if self.listener === listener { self.listener = nil }
            throw error
        }
    }

    private func serve(_ connection: NWConnection) {
        guard Self.isLoopbackPeer(connection.endpoint) else { connection.cancel(); return }
        connection.start(queue: listenerQueue)
        receive(on: connection, buffer: Data())
    }

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
            var accumulated = buffer
            if let data, !data.isEmpty { accumulated.append(data) }
            if error != nil {
                connection.cancel()
                return
            }
            func sendAndClose(_ response: Data) {
                connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
            }
            if accumulated.count > Self.maximumRequestBytes {
                sendAndClose(Self.http(status: 400, reason: "Bad Request", body: Data()))
                return
            }
            switch Self.framing(accumulated) {
            case .complete:
                Task {
                    guard let self else { connection.cancel(); return }
                    let response = await self.respond(to: accumulated)
                    sendAndClose(response)
                }
            case .malformed:
                sendAndClose(Self.http(status: 400, reason: "Bad Request", body: Data()))
            case .incomplete:
                if isComplete {
                    // Peer closed mid-request; answer 400 if anything arrived.
                    if accumulated.isEmpty { connection.cancel() } else {
                        sendAndClose(Self.http(status: 400, reason: "Bad Request", body: Data()))
                    }
                    return
                }
                Task { await self?.receive(on: connection, buffer: accumulated) }
            }
        }
    }

    private static func isLoopbackPeer(_ endpoint: NWEndpoint) -> Bool {
        switch endpoint {
        case .hostPort(let host, _):
            switch host {
            case .ipv4(let address): return address == .loopback
            case .ipv6(let address): return address == .loopback
            case .name(let name, _): return name.lowercased() == "localhost"
            @unknown default: return false
            }
        default:
            return false
        }
    }
}

/// Resumes a listener-start continuation at most once across state callbacks.
private final class LocalMountStartSettlement: @unchecked Sendable {
    private let lock = NSLock()
    private var settled = false
    func once(_ action: () -> Void) {
        lock.lock()
        guard !settled else { lock.unlock(); return }
        settled = true
        lock.unlock()
        action()
    }
}
#endif

public extension NativeTurnToolsActor {
    /// The production local stack: the bounded no-redirect URLSession MCP
    /// client plus the loopback mount provider.  Routes still require an
    /// explicit `configure(_:)` per bot, and routes naming a credential
    /// reference fail closed until a credential resolver is supplied.
    static func localProduction(
        credentials: (any NativeTurnToolCredentialResolver)? = nil,
        mountProvider: NativeMCPLocalMountProvider = NativeMCPLocalMountProvider()
    ) -> NativeTurnToolsActor {
        NativeTurnToolsActor(client: NativeMCPURLSessionHTTPClient(), credentials: credentials, mountProvider: mountProvider)
    }
}
