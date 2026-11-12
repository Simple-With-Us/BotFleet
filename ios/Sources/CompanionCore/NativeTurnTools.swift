import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The executor's identity, never a paired device's bearer or an upstream credential.
public struct NativeToolIdentity: Codable, Hashable, Sendable {
    public let hostId: String
    public let installationId: String
    public let userId: String
    public let generation: UInt64

    public init(hostId: String, installationId: String, userId: String, generation: UInt64) {
        self.hostId = hostId
        self.installationId = installationId
        self.userId = userId
        self.generation = generation
    }

    fileprivate var isValid: Bool { !hostId.isEmpty && !installationId.isEmpty && !userId.isEmpty }
}

public enum NativeTurnToolError: Error, Equatable, Sendable {
    case invalidConfiguration
    case wrongIdentity
    case stalePreparation
    case deniedTool
    case invalidEndpoint
    case invalidSchema
    case invalidResponse
    case mountUnavailable
}

public enum NativeToolAccess: String, Codable, Sendable { case read, draft, write }

/// Private settings, kept outside TurnInput and the engine's serialized configuration.
public struct NativeMCPServerRoute: Equatable, Sendable {
    public let id: String
    public let upstream: String
    public let ownerBotId: String?
    public let grantedBotIds: Set<String>
    public let credentialReference: String?
    public let allowedTools: Set<String>?
    public let readOnlyTools: Set<String>
    public let access: NativeToolAccess
    public let connectedApps: Bool

    public init(id: String, upstream: String, ownerBotId: String? = nil, grantedBotIds: Set<String>,
                credentialReference: String? = nil, allowedTools: Set<String>? = nil,
                readOnlyTools: Set<String> = [], access: NativeToolAccess = .read, connectedApps: Bool = false) {
        self.id = id; self.upstream = upstream; self.ownerBotId = ownerBotId
        self.grantedBotIds = grantedBotIds; self.credentialReference = credentialReference
        self.allowedTools = allowedTools; self.readOnlyTools = readOnlyTools
        self.access = access; self.connectedApps = connectedApps
    }

    fileprivate func allows(botId: String) -> Bool {
        grantedBotIds.contains(botId) && (ownerBotId == nil || ownerBotId == botId)
    }
}

public struct NativeToolDefinition: Codable, Equatable, Sendable {
    public let serverId: String
    public let name: String
    public let upstreamName: String
    public let description: String
    public let inputSchemaJSON: String
    public let access: NativeToolAccess

    public init(serverId: String, name: String, upstreamName: String? = nil, description: String = "",
                inputSchemaJSON: String = #"{"type":"object","properties":{},"additionalProperties":false}"#,
                access: NativeToolAccess = .read) {
        self.serverId = serverId; self.name = name; self.upstreamName = upstreamName ?? name
        self.description = description; self.inputSchemaJSON = inputSchemaJSON; self.access = access
    }

    public var portableName: String { name.replacingOccurrences(of: ".", with: "_") }
}

/// A mount provider must expose only the granted catalog through a private local proxy or stdio bridge.
/// This value has no upstream headers, credential references, or environment credentials.
public enum NativeMCPMountEndpoint: Codable, Equatable, Sendable {
    case stdio(command: String, arguments: [String])
    case loopbackHTTP(url: String)

    fileprivate func validate() throws {
        switch self {
        case .stdio(let command, _):
            guard !command.isEmpty else { throw NativeTurnToolError.invalidEndpoint }
        case .loopbackHTTP(let raw):
            guard let url = URLComponents(string: raw), url.scheme == "http",
                  ["127.0.0.1", "localhost", "[::1]", "::1"].contains(url.host?.lowercased() ?? ""),
                  url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
                throw NativeTurnToolError.invalidEndpoint
            }
        }
    }
}

public struct NativeMCPServerMount: Codable, Equatable, Sendable {
    public let name: String
    public let botId: String
    public let identity: NativeToolIdentity
    public let endpoint: NativeMCPMountEndpoint

    public init(name: String, botId: String, identity: NativeToolIdentity, endpoint: NativeMCPMountEndpoint) {
        self.name = name; self.botId = botId; self.identity = identity; self.endpoint = endpoint
    }
}

public struct NativeTurnToolPreparation: Codable, Equatable, Sendable {
    public let botId: String
    public let identity: NativeToolIdentity
    public let tools: [NativeToolDefinition]
    public let mounts: [NativeMCPServerMount]
    public let omissions: [String]

    public init(botId: String, identity: NativeToolIdentity, tools: [NativeToolDefinition] = [],
                mounts: [NativeMCPServerMount] = [], omissions: [String] = []) {
        self.botId = botId; self.identity = identity; self.tools = tools; self.mounts = mounts; self.omissions = omissions
    }

    public func validate(forBot requestedBotId: String, identity expected: NativeToolIdentity? = nil) throws {
        guard botId == requestedBotId, identity.isValid, expected == nil || expected == identity,
              tools.count <= NativeTurnToolCatalog.maximumTools,
              Set(mounts.map(\.name)).count == mounts.count else { throw NativeTurnToolError.wrongIdentity }
        for mount in mounts {
            guard mount.botId == botId, mount.identity == identity, NativeTurnToolCatalog.validName(mount.name) else {
                throw NativeTurnToolError.wrongIdentity
            }
            try mount.endpoint.validate()
        }
    }

    public func acpServers(forBot botId: String) throws -> [[String: Any]] {
        try validate(forBot: botId)
        return mounts.map { mount in
            switch mount.endpoint {
            case .stdio(let command, let arguments):
                return ["name": mount.name, "command": command, "args": arguments, "env": []] as [String: Any]
            case .loopbackHTTP(let url):
                return ["type": "http", "name": mount.name, "url": url, "headers": []] as [String: Any]
            }
        }
    }

    public func claudeConfigurationJSON(forBot botId: String) throws -> String {
        try validate(forBot: botId)
        var servers: [String: Any] = [:]
        for mount in mounts {
            switch mount.endpoint {
            case .stdio(let command, let arguments):
                servers[mount.name] = ["command": command, "args": arguments, "env": [:]] as [String: Any]
            case .loopbackHTTP(let url):
                servers[mount.name] = ["type": "http", "url": url, "headers": [:]] as [String: Any]
            }
        }
        return try nativeToolJSON(["mcpServers": servers])
    }

    public func codexConfigurationOverrides(forBot botId: String) throws -> [String] {
        try validate(forBot: botId)
        return try mounts.flatMap { mount -> [String] in
            let key = "mcp_servers.\(mount.name)"
            switch mount.endpoint {
            case .stdio(let command, let arguments):
                return ["\(key).command=\(try nativeToolJSON(command))", "\(key).args=\(try nativeToolJSON(arguments))"]
            case .loopbackHTTP(let url): return ["\(key).url=\(try nativeToolJSON(url))"]
            }
        }
    }
}

/// Pure catalog assembly keeps runtime tools inside the same 128-entry budget.
public enum NativeTurnToolCatalog {
    public static let maximumTools = 128

    public static func validName(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 64 && value.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil
    }

    public static func compactSchema(_ json: String) throws -> String {
        guard json.utf8.count <= 64 * 1024, let data = json.data(using: .utf8),
              let root = try JSONSerialization.jsonObject(with: data) as? [String: Any], root["type"] as? String == "object" else {
            throw NativeTurnToolError.invalidSchema
        }
        func compact(_ schema: [String: Any]) -> [String: Any] {
            var result = schema
            for key in ["title", "$comment", "examples", "deprecated"] { result.removeValue(forKey: key) }
            for key in ["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"] {
                if let children = result[key] as? [String: [String: Any]] { result[key] = children.mapValues(compact) }
            }
            for key in ["items", "additionalProperties", "contains", "not", "if", "then", "else", "propertyNames", "unevaluatedProperties", "unevaluatedItems"] {
                if let child = result[key] as? [String: Any] { result[key] = compact(child) }
            }
            for key in ["anyOf", "allOf", "oneOf", "prefixItems"] {
                if let children = result[key] as? [[String: Any]] { result[key] = children.map(compact) }
            }
            return result
        }
        return try nativeToolJSON(compact(root))
    }

    public static func assemble(runtime: [NativeToolDefinition], builtIn: [NativeToolDefinition], remote: [NativeToolDefinition]) -> [NativeToolDefinition] {
        func order(_ lhs: NativeToolDefinition, _ rhs: NativeToolDefinition) -> Bool {
            if lhs.serverId != rhs.serverId { return lhs.serverId < rhs.serverId }
            if lhs.name != rhs.name { return lhs.name < rhs.name }
            return lhs.upstreamName < rhs.upstreamName
        }
        let prioritized = builtIn.sorted {
            if ($0.serverId == "agents") != ($1.serverId == "agents") { return $0.serverId == "agents" }
            return order($0, $1)
        }
        var seen: Set<String> = []
        return (runtime.sorted(by: order) + prioritized + remote.sorted(by: order)).filter {
            seen.insert("\($0.serverId)\u{0}\($0.name)").inserted
        }.prefix(maximumTools).map { $0 }
    }

    public static let appAliases: [String: String] = [
        "GMAIL_FETCH_EMAILS": "gmail.search_emails",
        "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID": "gmail.read_email",
        "GMAIL_FETCH_MESSAGE_BY_THREAD_ID": "gmail.read_email_thread",
        "GMAIL_CREATE_EMAIL_DRAFT": "gmail.create_draft",
        "GMAIL_SEND_EMAIL": "gmail.send_email",
        "GOOGLECALENDAR_EVENTS_LIST": "googlecalendar.list_events",
        "GOOGLECALENDAR_LIST_CALENDARS": "googlecalendar.list_calendars",
    ]
}

public struct NativeMCPPrivateCredential: Sendable {
    public let identity: NativeToolIdentity
    public let headers: [String: String]
    public init(identity: NativeToolIdentity, headers: [String: String]) { self.identity = identity; self.headers = headers }
}

public protocol NativeTurnToolCredentialResolver: Sendable {
    func credential(reference: String, identity: NativeToolIdentity) async throws -> NativeMCPPrivateCredential
}

public struct NativeMCPHTTPResponse: Sendable {
    public let status: Int
    public let headers: [String: String]
    public let body: Data
    public init(status: Int, headers: [String: String] = [:], body: Data) { self.status = status; self.headers = headers; self.body = body }
    fileprivate func header(_ name: String) -> String? { headers.first { $0.key.lowercased() == name.lowercased() }?.value }
}

public protocol NativeTurnToolHTTPClient: Sendable {
    func execute(_ request: URLRequest) async throws -> NativeMCPHTTPResponse
}

/// No incoming phone request or its headers are accepted by this builder.
public enum NativeMCPUpstreamRequest {
    public static func make(upstream: String, path: String = "", query: String = "", headers: [String: String], body: Data) throws -> URLRequest {
        let malformedEscape = #"%(?![0-9A-Fa-f]{2})"#
        let decodedPath = path.removingPercentEncoding
        guard var url = URLComponents(string: upstream), ["https", "http"].contains(url.scheme ?? ""), url.host != nil,
              url.user == nil, url.password == nil, url.fragment == nil,
              path.range(of: malformedEscape, options: .regularExpression) == nil,
              query.range(of: malformedEscape, options: .regularExpression) == nil,
              decodedPath != nil, !decodedPath!.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }),
              path.isEmpty || (path.hasPrefix("/") && !path.hasPrefix("//") && !path.contains("?") && !path.contains("#")) else {
            throw NativeTurnToolError.invalidEndpoint
        }
        if !path.isEmpty {
            var base = url.percentEncodedPath
            while base.hasSuffix("/") { base.removeLast() }
            url.percentEncodedPath = base + path
        }
        if !query.isEmpty {
            let own = query.hasPrefix("?") ? String(query.dropFirst()) : query
            guard !own.contains("#") else { throw NativeTurnToolError.invalidEndpoint }
            if !own.isEmpty { url.percentEncodedQuery = [url.percentEncodedQuery, own].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "&") }
        }
        guard let target = url.url else { throw NativeTurnToolError.invalidEndpoint }
        var request = URLRequest(url: target, timeoutInterval: 10)
        request.httpMethod = "POST"; request.httpBody = body
        for (name, value) in headers {
            guard !name.contains("\r"), !name.contains("\n"), !value.contains("\r"), !value.contains("\n"),
                  !["host", "content-length", "connection", "transfer-encoding"].contains(name.lowercased()) else {
                throw NativeTurnToolError.invalidConfiguration
            }
            request.setValue(value, forHTTPHeaderField: name)
        }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        return request
    }
}

public struct NativeMCPMountContext: Sendable {
    public let serverId: String
    public let botId: String
    public let identity: NativeToolIdentity
    public let tools: [NativeToolDefinition]
    /// The bridge must list only `tools` and use this checked call rather than forwarding arbitrary MCP methods.
    public let callTool: @Sendable (String, String) async throws -> Data
}

public protocol NativeMCPMountProvider: Sendable {
    func mount(_ context: NativeMCPMountContext) async throws -> NativeMCPMountEndpoint
}

public struct NativeBotToolConfiguration: Sendable {
    public let botId: String
    public let identity: NativeToolIdentity
    public let routes: [NativeMCPServerRoute]
    public let appGrants: [String: NativeToolAccess]
    public let runtimeTools: [NativeToolDefinition]
    public let builtInTools: [NativeToolDefinition]

    public init(botId: String, identity: NativeToolIdentity, routes: [NativeMCPServerRoute], appGrants: [String: NativeToolAccess] = [:],
                runtimeTools: [NativeToolDefinition] = [], builtInTools: [NativeToolDefinition] = []) {
        self.botId = botId; self.identity = identity; self.routes = routes; self.appGrants = appGrants
        self.runtimeTools = runtimeTools; self.builtInTools = builtInTools
    }
}

/// Per-bot snapshots make refresh independent of turn dispatch and of another bot's broken server.
public actor NativeTurnToolsActor {
    private struct Configuration { let value: NativeBotToolConfiguration; let revision: UInt64 }
    private struct Snapshot { let revision: UInt64; let at: Date; let preparation: NativeTurnToolPreparation }
    private struct Session { let revision: UInt64; let id: String?; let protocolVersion: String; let tools: [NativeToolDefinition] }
    private let client: any NativeTurnToolHTTPClient
    private let credentials: (any NativeTurnToolCredentialResolver)?
    private let mountProvider: (any NativeMCPMountProvider)?
    private let refreshInterval: TimeInterval
    private let now: @Sendable () -> Date
    private var configurations: [String: Configuration] = [:]
    private var snapshots: [String: Snapshot] = [:]
    private var sessions: [String: [String: Session]] = [:]
    private var refreshes: [String: Task<Void, Never>] = [:]
    private var nextRevision: UInt64 = 0

    public init(client: any NativeTurnToolHTTPClient, credentials: (any NativeTurnToolCredentialResolver)? = nil,
                mountProvider: (any NativeMCPMountProvider)? = nil, refreshInterval: TimeInterval = 60,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.client = client; self.credentials = credentials; self.mountProvider = mountProvider
        self.refreshInterval = max(1, refreshInterval); self.now = now
    }

    public func configure(_ value: NativeBotToolConfiguration) throws {
        let nativeIds = Set((value.runtimeTools + value.builtInTools).map(\.serverId))
        guard !value.botId.isEmpty, value.identity.isValid, value.routes.count <= 64,
              Set(value.routes.map(\.id)).count == value.routes.count,
              value.routes.allSatisfy({ NativeTurnToolCatalog.validName($0.id) && !nativeIds.contains($0.id) }) else { throw NativeTurnToolError.invalidConfiguration }
        nextRevision &+= 1
        configurations[value.botId] = Configuration(value: value, revision: nextRevision)
        snapshots.removeValue(forKey: value.botId); sessions.removeValue(forKey: value.botId)
        refreshes.removeValue(forKey: value.botId)?.cancel()
    }

    public func removeBot(_ botId: String) {
        configurations.removeValue(forKey: botId); snapshots.removeValue(forKey: botId); sessions.removeValue(forKey: botId)
        refreshes.removeValue(forKey: botId)?.cancel()
    }

    /// Returns the current snapshot immediately; the first request starts a refresh rather than waiting on it.
    public func prepare(botId: String) -> NativeTurnToolPreparation? {
        guard let config = configurations[botId] else { return nil }
        let snapshot = snapshots[botId]
        if snapshot == nil || now().timeIntervalSince(snapshot!.at) >= refreshInterval { startRefresh(botId: botId, config: config) }
        if let snapshot, snapshot.revision == config.revision { return snapshot.preparation }
        return NativeTurnToolPreparation(botId: botId, identity: config.value.identity,
            tools: NativeTurnToolCatalog.assemble(runtime: config.value.runtimeTools, builtIn: config.value.builtInTools, remote: []),
            omissions: ["Connected tools are refreshing; this turn uses the available native catalog"])
    }

    public func refresh(botId: String) async {
        guard let config = configurations[botId] else { return }
        startRefresh(botId: botId, config: config)
        await refreshes[botId]?.value
    }

    public func isCurrent(_ preparation: NativeTurnToolPreparation) -> Bool {
        guard let config = configurations[preparation.botId], config.value.identity == preparation.identity,
              let snapshot = snapshots[preparation.botId], snapshot.revision == config.revision else { return false }
        return snapshot.preparation == preparation
    }

    private func startRefresh(botId: String, config: Configuration) {
        guard refreshes[botId] == nil else { return }
        refreshes[botId] = Task { await self.performRefresh(botId: botId, config: config) }
    }

    private func current(_ botId: String, _ config: Configuration) throws {
        guard !Task.isCancelled, configurations[botId]?.revision == config.revision,
              configurations[botId]?.value.identity == config.value.identity else { throw NativeTurnToolError.stalePreparation }
    }

    private func headers(botId: String, route: NativeMCPServerRoute, config: Configuration) async throws -> [String: String] {
        try current(botId, config)
        guard let reference = route.credentialReference else { return [:] }
        guard let credentials else { throw NativeTurnToolError.mountUnavailable }
        let value = try await credentials.credential(reference: reference, identity: config.value.identity)
        try current(botId, config)
        guard value.identity == config.value.identity else { throw NativeTurnToolError.wrongIdentity }
        return value.headers
    }

    private func request(botId: String, route: NativeMCPServerRoute, config: Configuration,
                         method: String, params: [String: Any] = [:], sessionId: String? = nil, protocolVersion: String? = nil) async throws -> NativeMCPHTTPResponse {
        var privateHeaders = try await headers(botId: botId, route: route, config: config)
        if let sessionId { privateHeaders["mcp-session-id"] = sessionId }
        if let protocolVersion { privateHeaders["MCP-Protocol-Version"] = protocolVersion }
        let body = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": 1, "method": method, "params": params])
        let request = try NativeMCPUpstreamRequest.make(upstream: route.upstream, headers: privateHeaders, body: body)
        let response = try await client.execute(request)
        try current(botId, config)
        guard (200..<300).contains(response.status), response.body.count <= 1024 * 1024 else { throw NativeTurnToolError.invalidResponse }
        return response
    }

    private func discover(botId: String, route: NativeMCPServerRoute, config: Configuration) async throws -> Session {
        let initialized = try await request(botId: botId, route: route, config: config, method: "initialize", params: [
            "protocolVersion": "2025-03-26", "capabilities": [:], "clientInfo": ["name": "BotFleet", "version": "0.1.0"]
        ])
        let initial = try nativeMCPEnvelope(initialized.body)
        guard initial["error"] == nil, let initialResult = initial["result"] as? [String: Any],
              let protocolVersion = initialResult["protocolVersion"] as? String,
              ["2024-11-05", "2025-03-26", "2025-06-18"].contains(protocolVersion) else { throw NativeTurnToolError.invalidResponse }
        let returnedUser = (initialResult["config"] as? [String: Any])?["user_id"] as? String
        if let returnedUser, returnedUser != config.value.identity.userId { throw NativeTurnToolError.wrongIdentity }
        let sessionId = initialized.header("mcp-session-id")
        var notificationHeaders = try await headers(botId: botId, route: route, config: config)
        if let sessionId { notificationHeaders["mcp-session-id"] = sessionId }
        notificationHeaders["MCP-Protocol-Version"] = protocolVersion
        let notification = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "method": "notifications/initialized"])
        let notificationRequest = try NativeMCPUpstreamRequest.make(upstream: route.upstream, headers: notificationHeaders, body: notification)
        let notified = try await client.execute(notificationRequest)
        try current(botId, config)
        guard (200..<300).contains(notified.status) else { throw NativeTurnToolError.invalidResponse }
        let listed = try await request(botId: botId, route: route, config: config, method: "tools/list", sessionId: sessionId, protocolVersion: protocolVersion)
        let envelope = try nativeMCPEnvelope(listed.body)
        guard envelope["error"] == nil,
              let result = envelope["result"] as? [String: Any], result["nextCursor"] == nil,
              let entries = result["tools"] as? [[String: Any]], entries.count <= 512 else { throw NativeTurnToolError.invalidResponse }
        var definitions: [NativeToolDefinition] = []
        var names: Set<String> = []
        for entry in entries {
            guard let original = entry["name"] as? String, !original.isEmpty, original.utf8.count <= 128,
                  names.insert(original).inserted, let schema = entry["inputSchema"] as? [String: Any] else { throw NativeTurnToolError.invalidResponse }
            if let allowed = route.allowedTools, !allowed.contains(original) { continue }
            let alias = NativeTurnToolCatalog.appAliases[original]
            let access: NativeToolAccess = original == "GMAIL_SEND_EMAIL" ? .write : original == "GMAIL_CREATE_EMAIL_DRAFT" ? .draft :
                (alias != nil || route.readOnlyTools.contains(original) ? .read : .write)
            if route.access == .read && access != .read { continue }
            if route.access == .draft && access == .write { continue }
            if route.connectedApps {
                guard let alias, let app = alias.split(separator: ".").first.map(String.init), let grant = config.value.appGrants[app] else { continue }
                if grant == .read && access != .read { continue }
                if grant == .draft && access == .write { continue }
            }
            definitions.append(NativeToolDefinition(serverId: route.id, name: alias ?? original, upstreamName: original,
                description: entry["description"] as? String ?? "", inputSchemaJSON: try NativeTurnToolCatalog.compactSchema(nativeToolJSON(schema)), access: access))
        }
        return Session(revision: config.revision, id: sessionId, protocolVersion: protocolVersion, tools: definitions)
    }

    private func performRefresh(botId: String, config: Configuration) async {
        defer { if configurations[botId]?.revision == config.revision { refreshes.removeValue(forKey: botId) } }
        var available: [String: Session] = [:]
        var omissions: [String] = []
        for route in config.value.routes.sorted(by: { $0.id < $1.id }) where route.allows(botId: botId) {
            do { available[route.id] = try await discover(botId: botId, route: route, config: config) }
            catch {
                guard configurations[botId]?.revision == config.revision else { return }
                omissions.append("\(route.id) is unavailable for this bot")
            }
        }
        do { try current(botId, config) } catch { return }
        let allRemote = available.values.flatMap(\.tools)
        let catalog = NativeTurnToolCatalog.assemble(runtime: config.value.runtimeTools, builtIn: config.value.builtInTools, remote: allRemote)
        if catalog.count < config.value.runtimeTools.count + config.value.builtInTools.count + allRemote.count {
            omissions.append("Some tools were left out to fit the combined 128-tool limit")
        }
        var mounts: [NativeMCPServerMount] = []
        var mounted: Set<String> = []
        for route in config.value.routes.sorted(by: { $0.id < $1.id }) where available[route.id] != nil {
            let selected = catalog.filter { $0.serverId == route.id }
            guard !selected.isEmpty else { continue }
            guard let mountProvider else { omissions.append("\(route.id) has no native MCP mount provider"); continue }
            do {
                let endpoint = try await mountProvider.mount(NativeMCPMountContext(serverId: route.id, botId: botId, identity: config.value.identity, tools: selected,
                    callTool: { [weak self] name, arguments in
                        guard let self else { throw NativeTurnToolError.mountUnavailable }
                        return try await self.callTool(botId: botId, routeId: route.id, identity: config.value.identity, revision: config.revision, name: name, argumentsJSON: arguments)
                    }))
                try current(botId, config); try endpoint.validate()
                mounts.append(NativeMCPServerMount(name: route.id, botId: botId, identity: config.value.identity, endpoint: endpoint)); mounted.insert(route.id)
            } catch {
                guard configurations[botId]?.revision == config.revision else { return }
                omissions.append("\(route.id) could not mount its granted tools")
            }
        }
        do { try current(botId, config) } catch { return }
        let remoteIds = Set(config.value.routes.map(\.id))
        let visible = catalog.filter { !remoteIds.contains($0.serverId) || mounted.contains($0.serverId) }
        sessions[botId] = available
        snapshots[botId] = Snapshot(revision: config.revision, at: now(), preparation:
            NativeTurnToolPreparation(botId: botId, identity: config.value.identity, tools: visible, mounts: mounts, omissions: omissions))
    }

    private func callTool(botId: String, routeId: String, identity: NativeToolIdentity, revision: UInt64, name: String, argumentsJSON: String) async throws -> Data {
        guard let config = configurations[botId], config.revision == revision, config.value.identity == identity,
              let route = config.value.routes.first(where: { $0.id == routeId && $0.allows(botId: botId) }),
              let snapshot = snapshots[botId], snapshot.revision == revision,
              let definition = snapshot.preparation.tools.first(where: { $0.serverId == routeId && ($0.name == name || $0.portableName == name) }),
              let session = sessions[botId]?[routeId], session.revision == revision,
              argumentsJSON.utf8.count <= 256 * 1024, let data = argumentsJSON.data(using: .utf8),
              let arguments = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NativeTurnToolError.deniedTool }
        let response = try await request(botId: botId, route: route, config: config, method: "tools/call",
            params: ["name": definition.upstreamName, "arguments": arguments], sessionId: session.id, protocolVersion: session.protocolVersion)
        return Data(try nativeToolJSON(nativeMCPEnvelope(response.body)).utf8)
    }
}

private func nativeToolJSON(_ value: Any) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes])
    guard let result = String(data: data, encoding: .utf8) else { throw NativeTurnToolError.invalidResponse }
    return result
}

/// Streamable HTTP may return a JSON envelope or bounded SSE frames carrying that same envelope.
private func nativeMCPEnvelope(_ data: Data) throws -> [String: Any] {
    guard data.count <= 1024 * 1024 else { throw NativeTurnToolError.invalidResponse }
    if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], object["id"] as? Int == 1 { return object }
    guard let text = String(data: data, encoding: .utf8) else { throw NativeTurnToolError.invalidResponse }
    let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
    for frame in normalized.components(separatedBy: "\n\n") {
        let payload = frame.components(separatedBy: "\n").filter { $0.hasPrefix("data:") }.map {
            let value = String($0.dropFirst(5))
            return value.hasPrefix(" ") ? String(value.dropFirst()) : value
        }.joined(separator: "\n")
        if let object = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any], object["id"] as? Int == 1 { return object }
    }
    throw NativeTurnToolError.invalidResponse
}
