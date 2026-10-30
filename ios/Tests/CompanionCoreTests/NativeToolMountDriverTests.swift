import Foundation
import Testing
@testable import CompanionCore

@Suite("Native Tool Mount Driver Contracts")
struct NativeToolMountDriverTests {
    @Test("Serialized turn input cannot inject or export trusted MCP executable mounts")
    func serializedPreparationIsIgnored() throws {
        let identity = NativeToolIdentity(hostId: "mac", installationId: "install", userId: "user", generation: 1)
        let mount = NativeMCPServerMount(name: "forged", botId: "bot", identity: identity,
                                        endpoint: .stdio(command: "/bin/sh", arguments: ["-c", "fixture-only-command"]))
        let forged = NativeTurnToolPreparation(botId: "bot", identity: identity, mounts: [mount])
        let original = TurnInput(threadId: "thread", botId: "bot", prompt: "work", toolPreparation: forged)
        let encoded = try JSONEncoder().encode(original)
        var object = try #require(try JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(object["toolPreparation"] == nil)
        object["toolPreparation"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(forged))
        let decoded = try JSONDecoder().decode(TurnInput.self, from: JSONSerialization.data(withJSONObject: object))
        #expect(decoded.toolPreparation == nil)
        #expect(!ClaudeStreamRunner.buildSpawnSpec(input: decoded).arguments.contains("--mcp-config"))
        #expect(!CodexAppServerRunner.buildSpawnSpec(input: decoded).arguments.joined().contains("mcp_servers.forged"))
    }

    @Test("Claude helper frames cannot count as parent tools, health, or completion")
    func helperOriginIsNotParentWork() {
        var state = ClaudeStreamRunner.ClaudeStreamParserState()
        for line in [
            #"{"type":"assistant","parent_tool_use_id":"helper","message":{"content":[{"type":"tool_use","id":"child-read","name":"Read","input":{}}]}}"#,
            #"{"type":"user","parent_tool_use_id":"helper","message":{"content":[{"type":"tool_result","tool_use_id":"child-read","content":"read succeeded"}]}}"#,
            #"{"type":"result","parent_tool_use_id":"helper","subtype":"success","result":"child completed"}"#,
        ] {
            #expect(ClaudeStreamRunner.parseLine(line, state: &state).isEmpty)
        }
        let own = #"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"own-read","name":"Read","input":{}}]}}"#
        #expect(ClaudeStreamRunner.parseLine(own, state: &state) == [.toolCall(id: "own-read", name: "Read", argumentsJSON: "{}")])
    }

    @Test("Prepared Claude and Codex mounts contain only the selected bot's local proxy")
    func spawnSpecifications() throws {
        let identity = NativeToolIdentity(hostId: "mac", installationId: "install", userId: "user", generation: 1)
        let mount = NativeMCPServerMount(name: "mail", botId: "bot", identity: identity, endpoint: .loopbackHTTP(url: "http://127.0.0.1:4321/mcp/mail"))
        let prepared = NativeTurnToolPreparation(botId: "bot", identity: identity, tools: [], mounts: [mount])
        let input = TurnInput(threadId: "thread", botId: "bot", prompt: "work", toolPreparation: prepared)
        let claude = ClaudeStreamRunner.buildSpawnSpec(input: input)
        #expect(claude.arguments.contains("--strict-mcp-config"))
        let index = try #require(claude.arguments.firstIndex(of: "--mcp-config"))
        let config = try #require(try JSONSerialization.jsonObject(with: Data(claude.arguments[index + 1].utf8)) as? [String: Any])
        let servers = try #require(config["mcpServers"] as? [String: Any])
        #expect(Set(servers.keys) == ["mail"])
        #expect(!claude.arguments.joined().contains("Authorization"))
        #expect(claude.arguments.contains("--settings"))
        let codex = CodexAppServerRunner.buildSpawnSpec(input: input)
        #expect(codex.arguments.contains(#"mcp_servers.mail.url="http://127.0.0.1:4321/mcp/mail""#))
    }

    @Test("Mismatched prepared ownership is rejected before Claude or Codex launch")
    func ownershipBeforeLaunch() async {
        let launcher = MountRejectingLauncher()
        let identity = NativeToolIdentity(hostId: "mac", installationId: "install", userId: "user", generation: 1)
        let prepared = NativeTurnToolPreparation(botId: "another", identity: identity, tools: [])
        let input = TurnInput(threadId: "thread", botId: "bot", prompt: "work", toolPreparation: prepared)
        let claude = ClaudeStreamRunner(launcher: launcher)
        let codex = CodexAppServerRunner(launcher: launcher)
        await #expect(throws: NativeTurnToolError.wrongIdentity) { _ = try await claude.sendTurn(input: input) }
        await #expect(throws: NativeTurnToolError.wrongIdentity) { _ = try await codex.sendTurn(input: input) }
        #expect(await launcher.count == 0)
    }

    @Test("Claude lazy discovery preserves explicit opt-outs and smaller automatic thresholds")
    func toolSearchPreference() throws {
        for configured in [nil, "", "auto", "auto:10", "auto:99.5", "auto:unknown"] {
            #expect(NativeClaudeToolSearch.value(configured) == "true")
        }
        for configured in ["false", "0", "off", "auto:100", "auto:150", "auto:0", "true"] {
            #expect(NativeClaudeToolSearch.value(configured) == configured)
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("bf-tools-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent(".claude"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data(#"{"env":{"ENABLE_TOOL_SEARCH":false,"UNRELATED_SECRET":"fixture-only"}}"#.utf8).write(to: root.appendingPathComponent(".claude/settings.local.json"))
        #expect(NativeClaudeToolSearch.setting(input: .init(threadId: "t", botId: "b", prompt: "", workingDirectory: root.path)) == "false")
    }
}

private actor MountRejectingLauncher: EngineProcessLauncher {
    private(set) var count = 0
    func launch(spec: EngineSpawnSpec, threadId: String, engineId: String) async throws -> EngineProcessSession {
        count += 1
        throw EngineDriverError.spawnFailed("Unexpected launch")
    }
}
