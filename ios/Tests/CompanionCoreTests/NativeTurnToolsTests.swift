import Foundation
import Testing
@testable import CompanionCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private func toolIdentity(_ user: String = "owner", generation: UInt64 = 1) -> NativeToolIdentity {
    NativeToolIdentity(hostId: "mac:fixture", installationId: "installation", userId: user, generation: generation)
}

private func testTool(_ name: String, server: String = "docs") -> NativeToolDefinition {
    NativeToolDefinition(serverId: server, name: name, inputSchemaJSON: #"{"type":"object","properties":{"query":{"type":"string","maxLength":200}},"required":["query"],"additionalProperties":false}"#)
}

private actor ToolHTTPFixture: NativeTurnToolHTTPClient {
    private var requests: [URLRequest] = []
    private var heldPath: String?
    private var releaseContinuation: CheckedContinuation<Void, Never>?
    private var enteredWaiters: [CheckedContinuation<Void, Never>] = []
    private var entered = false
    var returnedUser: String?
    private var sse = false
    private var protocolVersion = "2025-03-26"
    var brokenPaths: Set<String> = []
    var catalogs: [String: [NativeToolDefinition]] = [:]

    func setCatalog(_ tools: [NativeToolDefinition], path: String = "/mcp") { catalogs[path] = tools }
    func setReturnedUser(_ value: String?) { returnedUser = value }
    func useSSE(protocolVersion: String = "2025-06-18") { sse = true; self.protocolVersion = protocolVersion }
    func breakPath(_ path: String) { brokenPaths.insert(path) }
    func holdNextInitialize(path: String = "/mcp") { heldPath = path; entered = false }

    func waitUntilHeld() async {
        if entered { return }
        await withCheckedContinuation { enteredWaiters.append($0) }
    }

    func release() { releaseContinuation?.resume(); releaseContinuation = nil }
    func recorded() -> [URLRequest] { requests }

    func execute(_ request: URLRequest) async throws -> NativeMCPHTTPResponse {
        requests.append(request)
        let path = request.url?.path ?? ""
        if brokenPaths.contains(path) { throw NativeTurnToolError.invalidResponse }
        let frame = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
        let method = frame?["method"] as? String ?? ""
        if method == "initialize", heldPath == path {
            heldPath = nil; entered = true
            for waiter in enteredWaiters { waiter.resume() }
            enteredWaiters.removeAll()
            await withCheckedContinuation { releaseContinuation = $0 }
        }
        if method == "notifications/initialized" { return NativeMCPHTTPResponse(status: 202, body: Data()) }
        let result: [String: Any]
        if method == "initialize" {
            result = ["protocolVersion": protocolVersion, "capabilities": [:], "serverInfo": ["name": "fixture", "version": "1"],
                      "config": returnedUser.map { ["user_id": $0] } ?? [:]]
        } else if method == "tools/list" {
            let tools = catalogs[path] ?? [testTool("read_docs")]
            result = ["tools": try tools.map { tool in
                ["name": tool.name, "description": tool.description,
                 "inputSchema": try JSONSerialization.jsonObject(with: Data(tool.inputSchemaJSON.utf8))] as [String: Any]
            }]
        } else if method == "tools/call" {
            result = ["content": [["type": "text", "text": "fixture result"]]]
        } else { throw NativeTurnToolError.invalidResponse }
        let body = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": 1, "result": result])
        if sse {
            let text = ": keepalive\r\n\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\r\n\r\nevent: message\r\ndata: \(String(decoding: body, as: UTF8.self))\r\n\r\n"
            return NativeMCPHTTPResponse(status: 200, headers: ["mcp-session-id": "private-fixture-session", "Content-Type": "text/event-stream"], body: Data(text.utf8))
        }
        return NativeMCPHTTPResponse(status: 200, headers: ["mcp-session-id": "private-fixture-session"], body: body)
    }
}

private actor ToolCredentialsFixture: NativeTurnToolCredentialResolver {
    private let returnedIdentity: NativeToolIdentity?
    init(returnedIdentity: NativeToolIdentity? = nil) { self.returnedIdentity = returnedIdentity }
    func credential(reference: String, identity: NativeToolIdentity) async throws -> NativeMCPPrivateCredential {
        NativeMCPPrivateCredential(identity: returnedIdentity ?? identity, headers: [
            "Authorization": "Bearer private-upstream-fixture",
            "CF-Access-Client-Id": "private-cloudflare-id",
            "CF-Access-Client-Secret": "private-cloudflare-secret",
        ])
    }
}

private actor ToolMountFixture: NativeMCPMountProvider {
    private var contexts: [String: NativeMCPMountContext] = [:]
    func mount(_ context: NativeMCPMountContext) async throws -> NativeMCPMountEndpoint {
        contexts["\(context.botId)/\(context.serverId)"] = context
        return .loopbackHTTP(url: "http://127.0.0.1:18181/\(context.botId)/\(context.serverId)")
    }
    func call(bot: String, server: String = "docs", name: String, arguments: String = #"{"query":"fixture"}"#) async throws -> Data {
        guard let context = contexts["\(bot)/\(server)"] else { throw NativeTurnToolError.mountUnavailable }
        return try await context.callTool(name, arguments)
    }
}

private final class ToolClockFixture: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Date(timeIntervalSince1970: 1_000)
    func now() -> Date { lock.lock(); defer { lock.unlock() }; return value }
    func advance(_ seconds: TimeInterval) { lock.lock(); defer { lock.unlock() }; value.addTimeInterval(seconds) }
}

@Suite("Native Turn Tool Preparation")
struct NativeTurnToolsTests {
    @Test("Bounded SSE envelopes and negotiated protocol versions work through discovery and tool calls")
    func sseAndNegotiatedProtocol() async throws {
        let http = ToolHTTPFixture(), mounts = ToolMountFixture()
        await http.useSSE()
        let tools = NativeTurnToolsActor(client: http, mountProvider: mounts)
        try await tools.configure(NativeBotToolConfiguration(botId: "a", identity: toolIdentity(), routes: [
            NativeMCPServerRoute(id: "docs", upstream: "https://fixture.test/mcp", grantedBotIds: ["a"], readOnlyTools: ["read_docs"]),
        ]))
        await tools.refresh(botId: "a")
        #expect(await tools.prepare(botId: "a")?.tools.map(\.name) == ["read_docs"])
        let result = try await mounts.call(bot: "a", name: "read_docs")
        let envelope = try #require(JSONSerialization.jsonObject(with: result) as? [String: Any])
        #expect(envelope["result"] != nil)
        let requests = await http.recorded()
        #expect(requests.count == 4)
        #expect(requests[0].value(forHTTPHeaderField: "MCP-Protocol-Version") == nil)
        for request in requests.dropFirst() {
            #expect(request.value(forHTTPHeaderField: "MCP-Protocol-Version") == "2025-06-18")
            #expect(request.value(forHTTPHeaderField: "mcp-session-id") == "private-fixture-session")
        }
    }

    @Test("Exact MCP addresses and queries keep private credential headers in the HTTP client")
    func exactAddressAndPrivateHeaders() async throws {
        let bytes = Data(#"{"jsonrpc":"2.0","method":"tools/list"}"#.utf8)
        for (upstream, path, query, expected) in [
            ("https://worker.test/mcp?team=acme", "", "", "https://worker.test/mcp?team=acme"),
            ("https://worker.test/mcp/", "", "", "https://worker.test/mcp/"),
            ("https://worker.test/mcp?team=acme", "/events", "?cursor=a%2Fb", "https://worker.test/mcp/events?team=acme&cursor=a%2Fb"),
            ("https://worker.test/a%2Fb/mcp", "", "", "https://worker.test/a%2Fb/mcp"),
        ] {
            let request = try NativeMCPUpstreamRequest.make(upstream: upstream, path: path, query: query, headers: [:], body: bytes)
            #expect(request.url?.absoluteString == expected)
        }
        let http = ToolHTTPFixture(), mounts = ToolMountFixture()
        let tools = NativeTurnToolsActor(client: http, credentials: ToolCredentialsFixture(), mountProvider: mounts)
        try await tools.configure(NativeBotToolConfiguration(botId: "bot", identity: toolIdentity(), routes: [
            NativeMCPServerRoute(id: "docs", upstream: "https://worker.test/mcp?team=acme", grantedBotIds: ["bot"],
                                 credentialReference: "owned-reference", readOnlyTools: ["read_docs"]),
        ]))
        await tools.refresh(botId: "bot")
        let preparation = try #require(await tools.prepare(botId: "bot"))
        #expect(preparation.tools.map(\.name) == ["read_docs"])
        let sent = await http.recorded()
        #expect(sent.count == 3)
        for request in sent {
            #expect(request.url?.absoluteString == "https://worker.test/mcp?team=acme")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer private-upstream-fixture")
            #expect(request.value(forHTTPHeaderField: "CF-Access-Client-Id") == "private-cloudflare-id")
            #expect(request.value(forHTTPHeaderField: "CF-Access-Client-Secret") == "private-cloudflare-secret")
        }
        let input = try TurnInput(threadId: "thread", botId: "bot", prompt: "Read docs").withToolPreparation(preparation)
        let encoded = try #require(String(data: JSONEncoder().encode(input), encoding: .utf8))
        #expect(!encoded.contains("private-"))
        #expect(!encoded.contains("worker.test"))
        #expect(!encoded.contains("CF-Access"))
        let acp = try preparation.acpServers(forBot: "bot")
        #expect(acp[0]["url"] as? String == "http://127.0.0.1:18181/bot/docs")
        #expect((acp[0]["headers"] as? [String])?.isEmpty == true)
        #expect(try preparation.claudeConfigurationJSON(forBot: "bot").contains("127.0.0.1:18181"))
        #expect(try preparation.codexConfigurationOverrides(forBot: "bot") == [#"mcp_servers.docs.url="http://127.0.0.1:18181/bot/docs""#])
        let result = try await mounts.call(bot: "bot", name: "read_docs")
        #expect(!result.isEmpty)
    }

    @Test("The combined runtime and MCP catalog is deterministic at 128 and 129 tools")
    func combinedBudget() throws {
        let runtime = [testTool("ask_user", server: "runtime")]
        let agents = [testTool("list_bots", server: "agents")]
        let remote = (0..<127).map { testTool(String(format: "tool_%03d", $0)) }
        let exact = NativeTurnToolCatalog.assemble(runtime: runtime, builtIn: agents, remote: Array(remote.prefix(126)))
        #expect(exact.count == 128)
        let overflowing = NativeTurnToolCatalog.assemble(runtime: runtime, builtIn: agents, remote: remote)
        #expect(overflowing.count == 128)
        #expect(overflowing == exact)
        #expect(overflowing == NativeTurnToolCatalog.assemble(runtime: runtime, builtIn: agents, remote: Array(remote.reversed())))
        #expect(overflowing.first?.name == "ask_user")
        #expect(overflowing[1].name == "list_bots")
    }

    @Test("Compact schemas preserve constraints and property names without merging approval domains")
    func compactSchema() throws {
        let schema = #"{"type":"object","title":"Long title","examples":[{}],"properties":{"title":{"type":"string","title":"Field title","minLength":1,"maxLength":200,"pattern":"^[a-z]+$"},"items":{"type":"array","minItems":1,"maxItems":32,"uniqueItems":true,"items":{"type":"integer","minimum":1,"maximum":12}}},"required":["title"],"additionalProperties":false}"#
        let compacted = try NativeTurnToolCatalog.compactSchema(schema)
        let result = try #require(JSONSerialization.jsonObject(with: Data(compacted.utf8)) as? [String: Any])
        #expect(result["title"] == nil)
        #expect(result["examples"] == nil)
        let properties = try #require(result["properties"] as? [String: [String: Any]])
        #expect(properties["title"]?["minLength"] as? Int == 1)
        #expect(properties["title"]?["maxLength"] as? Int == 200)
        #expect(properties["title"]?["pattern"] as? String == "^[a-z]+$")
        #expect(properties["items"]?["uniqueItems"] as? Bool == true)
        #expect(result["additionalProperties"] as? Bool == false)
    }

    @Test("Bot owners, explicit grants, app scopes, and server failures stay isolated")
    func grantsAndFailures() async throws {
        let http = ToolHTTPFixture(), mounts = ToolMountFixture()
        await http.setCatalog([testTool("GMAIL_FETCH_EMAILS"), testTool("GMAIL_SEND_EMAIL"), testTool("OTHER_DANGEROUS_TOOL")], path: "/apps")
        await http.breakPath("/broken")
        let tools = NativeTurnToolsActor(client: http, mountProvider: mounts)
        try await tools.configure(NativeBotToolConfiguration(botId: "a", identity: toolIdentity(), routes: [
            NativeMCPServerRoute(id: "apps", upstream: "https://fixture.test/apps", ownerBotId: "a", grantedBotIds: ["a"], access: .write, connectedApps: true),
            NativeMCPServerRoute(id: "broken", upstream: "https://fixture.test/broken", grantedBotIds: ["a"], readOnlyTools: ["read_docs"]),
            NativeMCPServerRoute(id: "other_bot", upstream: "https://fixture.test/private", ownerBotId: "b", grantedBotIds: ["a", "b"], access: .write),
            NativeMCPServerRoute(id: "not_granted", upstream: "https://fixture.test/not-granted", grantedBotIds: ["b"], access: .write),
        ], appGrants: ["gmail": .read]))
        try await tools.configure(NativeBotToolConfiguration(botId: "b", identity: toolIdentity("other"), routes: [
            NativeMCPServerRoute(id: "docs", upstream: "https://fixture.test/mcp", grantedBotIds: ["b"], readOnlyTools: ["read_docs"]),
        ]))
        await tools.refresh(botId: "a")
        await tools.refresh(botId: "b")
        let a = try #require(await tools.prepare(botId: "a")), b = try #require(await tools.prepare(botId: "b"))
        #expect(a.tools.map(\.name) == ["gmail.search_emails"])
        #expect(a.omissions == ["broken is unavailable for this bot"])
        #expect(b.tools.map(\.name) == ["read_docs"])
        let requests = await http.recorded()
        #expect(!requests.contains { ["/private", "/not-granted"].contains($0.url?.path ?? "") })
        do { _ = try await mounts.call(bot: "a", server: "apps", name: "gmail_send_email"); Issue.record("A read grant allowed an email send") }
        catch { #expect(error as? NativeTurnToolError == .deniedTool) }
        _ = try await mounts.call(bot: "a", server: "apps", name: "gmail_search_emails")
        let last = try #require(await http.recorded().last)
        let frame = try #require(JSONSerialization.jsonObject(with: last.httpBody!) as? [String: Any])
        #expect((frame["params"] as? [String: Any])?["name"] as? String == "GMAIL_FETCH_EMAILS")
    }

    @Test("A credential or remote session for another user is refused before it can become a mount")
    func mismatchedIdentity() async throws {
        let http = ToolHTTPFixture(), mounts = ToolMountFixture()
        let tools = NativeTurnToolsActor(client: http, credentials: ToolCredentialsFixture(returnedIdentity: toolIdentity("stranger")), mountProvider: mounts)
        let route = NativeMCPServerRoute(id: "docs", upstream: "https://fixture.test/mcp", grantedBotIds: ["a"], credentialReference: "reference", readOnlyTools: ["read_docs"])
        try await tools.configure(NativeBotToolConfiguration(botId: "a", identity: toolIdentity(), routes: [route]))
        await tools.refresh(botId: "a")
        #expect(await http.recorded().isEmpty)
        #expect(await tools.prepare(botId: "a")?.mounts.isEmpty == true)
        await http.setReturnedUser("stranger")
        let remoteMismatch = NativeTurnToolsActor(client: http, credentials: ToolCredentialsFixture(), mountProvider: mounts)
        try await remoteMismatch.configure(NativeBotToolConfiguration(botId: "a", identity: toolIdentity(), routes: [route]))
        await remoteMismatch.refresh(botId: "a")
        #expect(await remoteMismatch.prepare(botId: "a")?.mounts.isEmpty == true)
        #expect(await http.recorded().count == 1)
    }

    @Test("A turn reads a cached snapshot without waiting for refresh and stale generation responses are discarded")
    func nonblockingRefreshAndStaleGeneration() async throws {
        let http = ToolHTTPFixture(), mounts = ToolMountFixture(), clock = ToolClockFixture()
        let tools = NativeTurnToolsActor(client: http, mountProvider: mounts, now: { clock.now() })
        let route = NativeMCPServerRoute(id: "docs", upstream: "https://fixture.test/mcp", grantedBotIds: ["a"], readOnlyTools: ["read_docs"])
        try await tools.configure(NativeBotToolConfiguration(botId: "a", identity: toolIdentity(), routes: [route]))
        await tools.refresh(botId: "a")
        let initial = try #require(await tools.prepare(botId: "a"))
        await http.holdNextInitialize()
        clock.advance(61)
        let cached = try #require(await tools.prepare(botId: "a"))
        #expect(cached == initial)
        await http.waitUntilHeld()
        #expect(await tools.prepare(botId: "a") == initial)
        try await tools.configure(NativeBotToolConfiguration(botId: "a", identity: toolIdentity(generation: 2), routes: [route]))
        await tools.refresh(botId: "a")
        let new = try #require(await tools.prepare(botId: "a"))
        #expect(new.identity.generation == 2)
        await http.release()
        for _ in 0..<10 { await Task.yield() }
        #expect(await tools.prepare(botId: "a") == new)
        #expect(await tools.isCurrent(initial) == false)
        do { try initial.validate(forBot: "a", identity: toolIdentity(generation: 2)); Issue.record("A stale identity was accepted") }
        catch { #expect(error as? NativeTurnToolError == .wrongIdentity) }
    }

    @Test("Missing mount providers fail closed and forged bot mounts fail before engine serialization")
    func missingProviderAndForgedPreparation() async throws {
        let http = ToolHTTPFixture(), tools = NativeTurnToolsActor(client: http)
        try await tools.configure(NativeBotToolConfiguration(botId: "a", identity: toolIdentity(), routes: [
            NativeMCPServerRoute(id: "docs", upstream: "https://fixture.test/mcp", grantedBotIds: ["a"], readOnlyTools: ["read_docs"]),
        ]))
        await tools.refresh(botId: "a")
        let preparation = try #require(await tools.prepare(botId: "a"))
        #expect(preparation.tools.isEmpty)
        #expect(preparation.mounts.isEmpty)
        #expect(preparation.omissions == ["docs has no native MCP mount provider"])
        let forged = NativeTurnToolPreparation(botId: "a", identity: toolIdentity(), mounts: [
            NativeMCPServerMount(name: "docs", botId: "b", identity: toolIdentity(), endpoint: .loopbackHTTP(url: "http://127.0.0.1:18181/mcp")),
        ])
        for operation in [
            { _ = try forged.acpServers(forBot: "a") },
            { _ = try forged.claudeConfigurationJSON(forBot: "a") },
            { _ = try forged.codexConfigurationOverrides(forBot: "a") },
            { _ = try TurnInput(threadId: "thread", botId: "a", prompt: "fixture").withToolPreparation(forged) },
        ] {
            do { try operation(); Issue.record("A forged bot mount reached a runtime") }
            catch { #expect(error as? NativeTurnToolError == .wrongIdentity) }
        }
        let directUpstream = NativeTurnToolPreparation(botId: "a", identity: toolIdentity(), mounts: [
            NativeMCPServerMount(name: "docs", botId: "a", identity: toolIdentity(), endpoint: .loopbackHTTP(url: "https://upstream.test/mcp")),
        ])
        do { _ = try directUpstream.acpServers(forBot: "a"); Issue.record("An upstream server bypassed the private proxy") }
        catch { #expect(error as? NativeTurnToolError == .invalidEndpoint) }
    }
}
