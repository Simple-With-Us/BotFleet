import Foundation
import Testing
@testable import CompanionCore

@Suite("Mac Bot Profile Derivation (BF-2689 Composition)")
struct MacBotProfileDerivationTests {
    /// A stored bot record carrying the full Node-era bot JSON.
    private func record(
        id: String = "bot-1",
        instanceId: String = "claude",
        model: String = "claude-sonnet-4-6",
        threadId: String? = "thread-1",
        recordThreadId: String? = nil
    ) -> StoredBotRecord {
        let json = """
        {"id":"\(id)","threadId":"\(threadId ?? "")","name":"Fixture","title":"Fixture",\
        "description":"","notifications":true,"color":"#fff","unread":false,\
        "modelSelection":{"instanceId":"\(instanceId)","model":"\(model)"},"createdAt":1}
        """
        return StoredBotRecord(id: id, name: "Fixture", threadId: recordThreadId, createdAt: 1, rawJSON: json)
    }

    @Test("Every CLI-login instance maps to its matrix engine")
    func instanceMapping() {
        #expect(MacBotProfileDerivation.matrixEngine(forInstanceId: "antigravity") == .antigravity)
        #expect(MacBotProfileDerivation.matrixEngine(forInstanceId: "claude") == .claude)
        #expect(MacBotProfileDerivation.matrixEngine(forInstanceId: "codex") == .codex)
        #expect(MacBotProfileDerivation.matrixEngine(forInstanceId: "grok") == .grokAcp)
        #expect(MacBotProfileDerivation.matrixEngine(forInstanceId: "mcode") == .mcode)
        #expect(MacBotProfileDerivation.matrixEngine(forInstanceId: "muse") == .muse)
        #expect(MacBotProfileDerivation.matrixEngine(forInstanceId: " Claude ") == .claude)
        #expect(MacBotProfileDerivation.matrixEngine(forInstanceId: "minimax-api") == nil)
        #expect(MacBotProfileDerivation.matrixEngine(forInstanceId: "cursor") == nil)
        #expect(MacBotProfileDerivation.matrixEngine(forInstanceId: "") == nil)
    }

    @Test("A stored bot derives its profile with the saved model")
    func deriveSavedModel() {
        let derived = MacBotProfileDerivation.derive(from: record())
        #expect(derived?.engine == .claude)
        #expect(derived?.profile.id == "bot-1")
        #expect(derived?.profile.threadId == "thread-1")
        #expect(derived?.profile.engineId == "claude")
        #expect(derived?.profile.modelId == "claude-sonnet-4-6")
    }

    @Test("An empty saved model derives nil so registration substitutes the matrix default")
    func deriveEmptyModel() {
        let derived = MacBotProfileDerivation.derive(from: record(model: "  "))
        #expect(derived?.profile.modelId == nil)
    }

    @Test("The record thread wins over the JSON thread")
    func deriveRecordThreadWins() {
        let derived = MacBotProfileDerivation.derive(from: record(recordThreadId: "thread-record"))
        #expect(derived?.profile.threadId == "thread-record")
    }

    @Test("Unsupported instances and undecodable records derive nothing")
    func deriveRefusals() {
        #expect(MacBotProfileDerivation.derive(from: record(instanceId: "minimax-api")) == nil)
        #expect(MacBotProfileDerivation.derive(from: record(threadId: "")) == nil)
        #expect(MacBotProfileDerivation.derive(from: StoredBotRecord(
            id: "bot-x", name: "X", createdAt: 1, rawJSON: "{}"
        )) == nil)
        #expect(MacBotProfileDerivation.derive(from: StoredBotRecord(
            id: "bot-x", name: "X", createdAt: 1, rawJSON: "not json"
        )) == nil)
    }

    @Test("CLI-login bots resolve available with an empty environment; secret engines and unknown bots do not")
    func cliLoginBoundary() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("botfleet-bf2689-creds-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let database = try DatabaseService(path: dir.appendingPathComponent("native.sqlite").path)
        try await database.upsertBot(record(id: "bot-cli", instanceId: "codex"))
        // A minimax-api bot derives no profile, so it can never resolve:
        // unknown to the native roster reads as unavailable, not available.
        try await database.upsertBot(record(id: "bot-api", instanceId: "minimax-api"))

        let credentials = DatabaseCliLoginCredentials(database: database)
        let cli = try await credentials.credentials(forBotId: "bot-cli")
        guard case .available(let environment) = cli else {
            Issue.record("CLI-login bot must resolve available")
            return
        }
        #expect(environment.isEmpty)
        let api = try await credentials.credentials(forBotId: "bot-api")
        guard case .unavailable = api else {
            Issue.record("secret-engine bot must resolve unavailable")
            return
        }
        let missing = try await credentials.credentials(forBotId: "bot-absent")
        guard case .unavailable = missing else {
            Issue.record("unknown bot must resolve unavailable")
            return
        }
    }

    @Test("Registration names skipped bots instead of substituting drivers")
    func registerStoredBotsReport() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("botfleet-bf2689-register-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let database = try DatabaseService(path: dir.appendingPathComponent("native.sqlite").path)
        try await database.upsertBot(record(id: "bot-cli", instanceId: "claude"))
        try await database.upsertBot(record(id: "bot-api", instanceId: "minimax-api"))

        let runtime = NativeMacCompanionRuntime(
            database: database,
            workspacesRoot: dir.appendingPathComponent("workspaces", isDirectory: true),
            credentials: DatabaseCliLoginCredentials(database: database)
        )
        let report = await runtime.registerStoredBots()
        #expect(report.skipped.contains { $0.botId == "bot-api" })
        #if os(macOS)
        #expect(report.registered == ["bot-cli"])
        let resolved = try await runtime.macExecutionContext.resolve(wait: NativeEventWait(
            botId: "bot-cli", threadId: "thread-1", prompt: "hello",
            predicate: .botIdle, createdAt: 1, deadlineAt: 2
        ))
        guard case .ready(let input) = resolved else {
            Issue.record("registered CLI bot must resolve ready")
            return
        }
        #expect(input.modelId == "claude-sonnet-4-6")
        #expect(input.workingDirectory?.hasSuffix("bot-cli") == true)
        #else
        // Off macOS there is no process launcher, so the derivable bot is
        // named as skipped and nothing pretends to be registered.
        #expect(report.registered.isEmpty)
        #expect(report.skipped.contains { $0.botId == "bot-cli" })
        #endif
    }
}
