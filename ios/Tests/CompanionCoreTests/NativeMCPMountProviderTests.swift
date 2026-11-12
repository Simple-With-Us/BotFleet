import Foundation
import Testing
@testable import CompanionCore
#if canImport(Network)
import Network
#endif
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

        // Re-mounting the unchanged catalog reuses the token (in-flight turns
        // keep working); a changed catalog rotates and revokes the old token.
        let refreshed = try await provider.register(context)
        #expect(refreshed == token)
        #expect(httpBody(await provider.respond(to: httpRequest(path: "/mcp/\(token)", body: #"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#))).status == 200)
        let changed = NativeMCPMountContext(serverId: "docs", botId: "bot-a", identity: mountIdentity(), tools: [granted, NativeToolDefinition(serverId: "docs", name: "list_docs")]) { name, _ in
            await callsBox.record(name)
            return Data(#"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}]}}"#.utf8)
        }
        let replacement = try await provider.register(changed)
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

    @Test("Framing distinguishes incomplete from malformed requests")
    func framingClassification() {
        // Complete request and its still-arriving prefix.
        let full = httpRequest(path: "/mcp/t", body: #"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)
        #expect(NativeMCPLocalMountProvider.framing(full) == .complete)
        #expect(NativeMCPLocalMountProvider.framing(Data(full.prefix(full.count - 3))) == .incomplete)
        #expect(NativeMCPLocalMountProvider.framing(Data("POST /mcp/t HTTP/1.1\r\nContent-Length: 5\r\n\r\nhe".utf8)) == .incomplete)
        #expect(NativeMCPLocalMountProvider.framing(Data()) == .incomplete)
        #expect(NativeMCPLocalMountProvider.framing(Data("POS".utf8)) == .incomplete)
        // Malformed: garbage request line, bad Content-Length, chunked, missing
        // Content-Length, colon-less header, body longer than declared.
        #expect(NativeMCPLocalMountProvider.framing(Data("HELLO\r\n\r\n".utf8)) == .malformed)
        #expect(NativeMCPLocalMountProvider.framing(Data("HELLO\r\n".utf8)) == .malformed)
        #expect(NativeMCPLocalMountProvider.framing(Data("POST /mcp/t HTTP/1.1\r\nContent-Length: abc\r\n\r\n".utf8)) == .malformed)
        #expect(NativeMCPLocalMountProvider.framing(Data("POST /mcp/t HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n".utf8)) == .malformed)
        #expect(NativeMCPLocalMountProvider.framing(Data("POST /mcp/t HTTP/1.1\r\nHost: x\r\n\r\n".utf8)) == .malformed)
        #expect(NativeMCPLocalMountProvider.framing(Data("POST /mcp/t HTTP/1.1\r\nBogusHeader\r\nContent-Length: 0\r\n\r\n".utf8)) == .malformed)
        #expect(NativeMCPLocalMountProvider.framing(Data("POST /mcp/t HTTP/1.1\r\nContent-Length: 2\r\n\r\nhello".utf8)) == .malformed)
    }

    #if canImport(Network)
    @Test("Refresh keeps the mount URL stable; catalog or identity change rotates it")
    func refreshKeepsURLStable() async throws {
        let provider = NativeMCPLocalMountProvider()
        defer { Task { await provider.stop() } }
        let call: @Sendable (String, String) async throws -> Data = { _, _ in
            Data(#"{"jsonrpc":"2.0","id":1,"result":{"content":[]}}"#.utf8)
        }
        func context(_ identity: NativeToolIdentity = mountIdentity(), tools: [NativeToolDefinition] = [NativeToolDefinition(serverId: "docs", name: "read_docs")]) -> NativeMCPMountContext {
            NativeMCPMountContext(serverId: "docs", botId: "bot-a", identity: identity, tools: tools, callTool: call)
        }
        func url(_ endpoint: NativeMCPMountEndpoint) -> String {
            guard case .loopbackHTTP(let value) = endpoint else { return "" }
            return value
        }
        let first = try await url(provider.mount(context()))
        // Periodic refresh with the same catalog (even tools reordered) reuses the URL.
        let second = try await url(provider.mount(context(tools: [NativeToolDefinition(serverId: "docs", name: "read_docs")])))
        #expect(second == first)
        let token = String(first.split(separator: "/").last ?? "")
        #expect(httpBody(await provider.respond(to: httpRequest(path: "/mcp/\(token)", body: #"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#))).status == 200)
        // Changed catalog rotates; the in-flight URL for the old grant is revoked.
        let expanded = try await url(provider.mount(context(tools: [NativeToolDefinition(serverId: "docs", name: "read_docs"), NativeToolDefinition(serverId: "docs", name: "list_docs")])))
        #expect(expanded != first)
        #expect(httpBody(await provider.respond(to: httpRequest(path: "/mcp/\(token)", body: #"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#))).status == 404)
        // Changed identity rotates too.
        let reidentified = try await url(provider.mount(context(mountIdentity("other-user"), tools: [NativeToolDefinition(serverId: "docs", name: "read_docs"), NativeToolDefinition(serverId: "docs", name: "list_docs")])))
        #expect(reidentified != expanded)
    }

    @Test("Concurrent mounts share one listener and one port")
    func concurrentMountsSingleListener() async throws {
        let provider = NativeMCPLocalMountProvider()
        defer { Task { await provider.stop() } }
        let call: @Sendable (String, String) async throws -> Data = { _, _ in
            Data(#"{"jsonrpc":"2.0","id":1,"result":{"content":[]}}"#.utf8)
        }
        let endpoints = try await withThrowingTaskGroup(of: NativeMCPMountEndpoint.self) { group in
            for index in 0..<8 {
                group.addTask {
                    try await provider.mount(NativeMCPMountContext(
                        serverId: "docs", botId: "bot-\(index)", identity: mountIdentity(),
                        tools: [NativeToolDefinition(serverId: "docs", name: "read_docs")], callTool: call))
                }
            }
            var collected: [NativeMCPMountEndpoint] = []
            for try await endpoint in group { collected.append(endpoint) }
            return collected
        }
        let urls: [String] = endpoints.compactMap { endpoint in
            guard case .loopbackHTTP(let value) = endpoint else { return nil }
            return value
        }
        #expect(urls.count == 8)
        #expect(Set(urls).count == 8) // distinct unguessable tokens
        let ports = Set(urls.compactMap { URLComponents(string: $0)?.port })
        #expect(ports.count == 1)
        let boundPort = await provider.listeningPort
        #expect(ports.first.map(UInt16.init) == boundPort)
        let creationCount = await provider.listenerCreationCount
        #expect(creationCount == 1)
        // Every concurrent mount actually serves its granted catalog.
        for url in urls {
            let token = String(url.split(separator: "/").last ?? "")
            #expect(httpBody(await provider.respond(to: httpRequest(path: "/mcp/\(token)", body: #"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#))).status == 200)
        }
    }

    @Test("Malformed socket request is answered 400 promptly, not left hanging")
    func malformedSocketRequestGets400() async throws {
        let provider = NativeMCPLocalMountProvider()
        defer { Task { await provider.stop() } }
        let call: @Sendable (String, String) async throws -> Data = { _, _ in
            Data(#"{"jsonrpc":"2.0","id":1,"result":{"content":[]}}"#.utf8)
        }
        _ = try await provider.mount(NativeMCPMountContext(
            serverId: "docs", botId: "bot-a", identity: mountIdentity(),
            tools: [NativeToolDefinition(serverId: "docs", name: "read_docs")], callTool: call))
        let port = try #require(await provider.listeningPort)
        // Garbage with a header terminator, write side left open: the server
        // must reply 400 on its own instead of waiting for more bytes or EOF.
        let garbage = try await rawSocketExchange(port: port, payload: Data("HELLO\r\n\r\n".utf8))
        #expect(String(decoding: garbage, as: UTF8.self).hasPrefix("HTTP/1.1 400"))
        let badLength = try await rawSocketExchange(port: port, payload: Data("POST /mcp/t HTTP/1.1\r\nContent-Length: abc\r\n\r\n".utf8))
        #expect(String(decoding: badLength, as: UTF8.self).hasPrefix("HTTP/1.1 400"))
    }
    #endif
}

private actor MountCallsBox {
    private(set) var names: [String] = []
    func record(_ name: String) { names.append(name) }
}

#if canImport(Network)
/// Sends raw bytes on a loopback NWConnection (write side stays open) and
/// returns the first response chunk; fails after 10s so a hung server fails
/// the test instead of the suite.
private func rawSocketExchange(port: UInt16, payload: Data) async throws -> Data {
    let connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port) ?? .any, using: .tcp)
    let queue = DispatchQueue(label: "mount-test-raw-socket")
    func boxed() async throws -> Data {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            let settlement = RawSocketSettlement()
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    connection.send(content: payload, completion: .contentProcessed { _ in })
                    connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, _, error in
                        if let data, !data.isEmpty {
                            settlement.once { continuation.resume(returning: data) }
                        } else if let error {
                            settlement.once { continuation.resume(throwing: error) }
                        } else {
                            settlement.once { continuation.resume(returning: Data()) }
                        }
                        connection.cancel()
                    }
                case .failed(let error):
                    settlement.once { continuation.resume(throwing: error) }
                default:
                    break
                }
            }
            connection.start(queue: queue)
        }
    }
    return try await withThrowingTaskGroup(of: Data.self) { group in
        group.addTask { try await boxed() }
        group.addTask {
            try await Task.sleep(for: .seconds(10))
            connection.cancel()
            throw NativeTurnToolError.invalidResponse
        }
        let result = try await group.next() ?? Data()
        group.cancelAll()
        return result
    }
}

private final class RawSocketSettlement: @unchecked Sendable {
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
