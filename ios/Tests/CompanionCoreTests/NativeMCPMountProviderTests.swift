import Foundation
import Testing
@testable import CompanionCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private func mountIdentity(_ user: String = "owner") -> NativeToolIdentity {
    NativeToolIdentity(hostId: "mac:fixture", installationId: "installation", userId: user, generation: 1)
}

/// Minimal fake upstream MCP server behind the checked HTTP client seam.
private actor MountUpstreamFixture: NativeTurnToolHTTPClient {
    func execute(_ request: URLRequest) async throws -> NativeMCPHTTPResponse {
        let frame = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
        let method = frame?["method"] as? String ?? ""
        if method == "notifications/initialized" { return NativeMCPHTTPResponse(status: 202, body: Data()) }
        let result: [String: Any]
        switch method {
        case "initialize":
            result = ["protocolVersion": "2025-03-26", "capabilities": [:], "serverInfo": ["name": "fixture", "version": "1"], "config": [:]]
        case "tools/list":
            result = ["tools": [
                ["name": "read_docs", "description": "Read", "inputSchema": ["type": "object", "properties": [String: Any](), "additionalProperties": false]],
                ["name": "delete_docs", "description": "Delete", "inputSchema": ["type": "object", "properties": [String: Any](), "additionalProperties": false]],
            ] as [[String: Any]]]
        case "tools/call":
            result = ["content": [["type": "text", "text": "fixture result"]]]
        default:
            throw NativeTurnToolError.invalidResponse
        }
        let body = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": 1, "result": result])
        return NativeMCPHTTPResponse(status: 200, headers: ["mcp-session-id": "fixture-session"], body: body)
    }
}

private func httpRequest(path: String, body: String, method: String = "POST") -> Data {
    Data("\(method) \(path) HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)".utf8)
}

private func httpBody(_ response: Data) -> (status: Int, body: [String: Any]) {
    let text = String(decoding: response, as: UTF8.self)
    let status = Int(text.split(separator: " ").dropFirst().first ?? "0") ?? 0
    guard let split = text.range(of: "\r\n\r\n") else { return (status, [:]) }
    let body = String(text[split.upperBound...])
    return (status, (try? JSONSerialization.jsonObject(with: Data(body.utf8))) as? [String: Any] ?? [:])
}

@Suite("Native MCP Local Mount Provider")
struct NativeMCPMountProviderTests {
    @Test("Request handling lists and calls only the granted catalog and refuses everything else")
    func requestHandlingFailsClosed() async throws {
        let provider = NativeMCPLocalMountProvider()
        let callsBox = MountCallsBox()
        let granted = NativeToolDefinition(serverId: "docs", name: "read_docs")
        let context = NativeMCPMountContext(serverId: "docs", botId: "bot-a", identity: mountIdentity(), tools: [granted]) { name, _ in
            await callsBox.record(name)
            return Data(#"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}]}}"#.utf8)
        }
        let token = try await provider.register(context)

        let listed = httpBody(await provider.respond(to: httpRequest(path: "/mcp/\(token)", body: #"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#)))
        #expect(listed.status == 200)
        let tools = (listed.body["result"] as? [String: Any])?["tools"] as? [[String: Any]]
        #expect(tools?.map { $0["name"] as? String } == ["read_docs"])
        #expect(listed.body["id"] as? Int == 7)

        let called = httpBody(await provider.respond(to: httpRequest(path: "/mcp/\(token)", body: #"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"read_docs","arguments":{"query":"x"}}}"#)))
        #expect((called.body["result"] as? [String: Any])?["content"] != nil)
        #expect(await callsBox.names == ["read_docs"])

        // Ungranted tool, unknown token, other methods, GET, and batches fail closed.
        let denied = httpBody(await provider.respond(to: httpRequest(path: "/mcp/\(token)", body: #"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"delete_docs","arguments":{}}}"#)))
        #expect((denied.body["error"] as? [String: Any])?["code"] as? Int == -32602)
        #expect(await callsBox.names == ["read_docs"])
        #expect(httpBody(await provider.respond(to: httpRequest(path: "/mcp/not-a-token", body: #"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#))).status == 404)
        let unknown = httpBody(await provider.respond(to: httpRequest(path: "/mcp/\(token)", body: #"{"jsonrpc":"2.0","id":2,"method":"resources/list"}"#)))
        #expect((unknown.body["error"] as? [String: Any])?["code"] as? Int == -32601)
        #expect(httpBody(await provider.respond(to: httpRequest(path: "/mcp/\(token)", body: "", method: "GET"))).status == 405)
        #expect(httpBody(await provider.respond(to: httpRequest(path: "/mcp/\(token)", body: #"[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]"#))).status == 400)
        #expect(httpBody(await provider.respond(to: httpRequest(path: "/mcp/\(token)", body: #"{"jsonrpc":"2.0","method":"notifications/initialized"}"#))).status == 202)

        // Re-mounting revokes the previous token.
        let replacement = try await provider.register(context)
        #expect(replacement != token)
        #expect(httpBody(await provider.respond(to: httpRequest(path: "/mcp/\(token)", body: #"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#))).status == 404)
        await provider.unmount(botId: "bot-a", serverId: "docs")
        #expect(httpBody(await provider.respond(to: httpRequest(path: "/mcp/\(replacement)", body: #"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#))).status == 404)
    }

    @Test("Registration refuses empty, mismatched, or duplicate catalogs")
    func registrationValidation() async throws {
        let provider = NativeMCPLocalMountProvider()
        let call: @Sendable (String, String) async throws -> Data = { _, _ in Data() }
        for context in [
            NativeMCPMountContext(serverId: "docs", botId: "", identity: mountIdentity(), tools: [NativeToolDefinition(serverId: "docs", name: "x")], callTool: call),
            NativeMCPMountContext(serverId: "docs", botId: "a", identity: mountIdentity(), tools: [], callTool: call),
            NativeMCPMountContext(serverId: "docs", botId: "a", identity: mountIdentity(), tools: [NativeToolDefinition(serverId: "other", name: "x")], callTool: call),
            NativeMCPMountContext(serverId: "docs", botId: "a", identity: NativeToolIdentity(hostId: "", installationId: "i", userId: "u", generation: 1), tools: [NativeToolDefinition(serverId: "docs", name: "x")], callTool: call),
        ] {
            await #expect(throws: NativeTurnToolError.mountUnavailable) { try await provider.register(context) }
        }
    }

    @Test("Production stack keeps unknown bots unconfigured and route-free")
    func productionStackDefaultsClosed() async throws {
        let tools = NativeTurnToolsActor.localProduction()
        #expect(await tools.prepare(botId: "unknown-bot") == nil)
    }

    #if canImport(Network)
    @Test("Granted tool is callable end-to-end over the loopback mount; sibling bot gets no mount")
    func endToEndOverLoopback() async throws {
        let provider = NativeMCPLocalMountProvider()
        let tools = NativeTurnToolsActor(client: MountUpstreamFixture(), mountProvider: provider)
        try await tools.configure(NativeBotToolConfiguration(botId: "bot-a", identity: mountIdentity(), routes: [
            NativeMCPServerRoute(id: "docs", upstream: "https://fixture.test/mcp", grantedBotIds: ["bot-a"],
                                 allowedTools: ["read_docs"], readOnlyTools: ["read_docs"]),
        ]))
        try await tools.configure(NativeBotToolConfiguration(botId: "bot-b", identity: mountIdentity("sibling"), routes: [
            NativeMCPServerRoute(id: "docs", upstream: "https://fixture.test/mcp", grantedBotIds: ["bot-a"],
                                 allowedTools: ["read_docs"], readOnlyTools: ["read_docs"]),
        ]))
        await tools.refresh(botId: "bot-a")
        await tools.refresh(botId: "bot-b")
        defer { Task { await provider.stop() } }

        let preparation = try #require(await tools.prepare(botId: "bot-a"))
        #expect(preparation.tools.map(\.name) == ["read_docs"])
        let mount = try #require(preparation.mounts.first)
        guard case .loopbackHTTP(let url) = mount.endpoint else { Issue.record("Expected a loopback HTTP mount"); return }
        #expect(url.hasPrefix("http://127.0.0.1:"))
        #expect(!url.contains("fixture.test"))

        let sibling = try #require(await tools.prepare(botId: "bot-b"))
        #expect(sibling.tools.isEmpty)
        #expect(sibling.mounts.isEmpty)

        let session = URLSession(configuration: .ephemeral)
        func post(_ body: String) async throws -> [String: Any] {
            var request = URLRequest(url: try #require(URL(string: url)))
            request.httpMethod = "POST"
            request.httpBody = Data(body.utf8)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let (data, response) = try await session.data(for: request)
            #expect((response as? HTTPURLResponse)?.statusCode == 200)
            return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        let initialized = try await post(#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}"#)
        #expect((initialized["result"] as? [String: Any])?["protocolVersion"] as? String == "2025-03-26")
        let listed = try await post(#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#)
        let names = ((listed["result"] as? [String: Any])?["tools"] as? [[String: Any]])?.map { $0["name"] as? String }
        #expect(names == ["read_docs"])
        let called = try await post(#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_docs","arguments":{}}}"#)
        let content = (called["result"] as? [String: Any])?["content"] as? [[String: Any]]
        #expect(content?.first?["text"] as? String == "fixture result")
        let denied = try await post(#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"delete_docs","arguments":{}}}"#)
        #expect((denied["error"] as? [String: Any])?["code"] as? Int == -32602)
    }
    #endif
}

private actor MountCallsBox {
    private(set) var names: [String] = []
    func record(_ name: String) { names.append(name) }
}
