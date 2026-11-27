import Foundation
import SQLite3
import Testing
@testable import CompanionCore

@Suite("First-launch import of the legacy Node stores (BF-2710)")
struct NativeLegacyStoreImportTests {
    @Test("The first harness-free run imports the legacy stores and writes the marker")
    func importsOnce() async throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }
        try fixture.writeLegacyStore()
        let database = try DatabaseService(path: ":memory:")

        let outcome = await fixture.importer(harnessIsGone: true).runIfNeeded(into: database)

        #expect(outcome == .imported(bots: 1, threads: 1, messages: 2, parityVerified: true))
        #expect(FileManager.default.fileExists(atPath: fixture.markerURL.path))
        let marker = try JSONDecoder().decode(
            NativeLegacyStoreImport.Marker.self,
            from: Data(contentsOf: fixture.markerURL)
        )
        #expect(marker.bots == 1)
        #expect(marker.messages == 2)
        #expect(marker.parityVerified)
        #expect(marker.fullyVerified == marker.warnings.isEmpty)
        #expect(try await database.loadBots().map(\.id) == ["bot-1"])
        #expect(try await database.loadMessages(forThread: "thread-bot-1").count == 2)
    }

    @Test("Reopening skips the import and leaves the transcript as it was")
    func reopeningDoesNotDuplicate() async throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }
        try fixture.writeLegacyStore()
        let database = try DatabaseService(path: ":memory:")
        let importer = fixture.importer(harnessIsGone: true)
        _ = await importer.runIfNeeded(into: database)

        let again = await importer.runIfNeeded(into: database)

        #expect(again == .skipped(.alreadyImported))
        #expect(try await database.loadBots().count == 1)
        #expect(try await database.loadMessages(forThread: "thread-bot-1").count == 2)
    }

    @Test("A marker beside a reset native store is not trusted, so the import runs again")
    func markerBesideEmptyStoreReimports() async throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }
        try fixture.writeLegacyStore()
        let importer = fixture.importer(harnessIsGone: true)
        let first = try DatabaseService(path: ":memory:")
        _ = await importer.runIfNeeded(into: first)
        #expect(FileManager.default.fileExists(atPath: fixture.markerURL.path))

        let reset = try DatabaseService(path: ":memory:")
        let outcome = await importer.runIfNeeded(into: reset)

        #expect(outcome == .imported(bots: 1, threads: 1, messages: 2, parityVerified: true))
        #expect(try await reset.loadBots().map(\.id) == ["bot-1"])
    }

    @Test("Nothing is imported while a harness LaunchAgent is installed")
    func harnessPresentSkips() async throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }
        try fixture.writeLegacyStore()
        let database = try DatabaseService(path: ":memory:")

        let outcome = await fixture.importer(harnessIsGone: false).runIfNeeded(into: database)

        #expect(outcome == .skipped(.harnessPresent))
        #expect(!FileManager.default.fileExists(atPath: fixture.markerURL.path))
        #expect(try await database.loadBots().isEmpty)
    }

    @Test("A Mac with no legacy bots.json has nothing to import")
    func noLegacyStoreSkips() async throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }
        let database = try DatabaseService(path: ":memory:")

        let outcome = await fixture.importer(harnessIsGone: true).runIfNeeded(into: database)

        #expect(outcome == .skipped(.noLegacyStore))
        #expect(!FileManager.default.fileExists(atPath: fixture.markerURL.path))
    }

    @Test("A failed import writes no marker, so the next launch tries again")
    func failureRetriesNextLaunch() async throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }
        try fixture.writeLegacyStore(extraBotKey: "notAKnownKey")
        let database = try DatabaseService(path: ":memory:")
        let importer = fixture.importer(harnessIsGone: true)

        let first = await importer.runIfNeeded(into: database)
        guard case .failed = first else {
            Issue.record("expected the importer to refuse an unknown bots.json key, got \(first)")
            return
        }
        #expect(!FileManager.default.fileExists(atPath: fixture.markerURL.path))

        try fixture.writeLegacyStore()
        let second = await importer.runIfNeeded(into: database)
        #expect(second == .imported(bots: 1, threads: 1, messages: 2, parityVerified: true))
    }

    @Test("The Mac app's import reads the data directory and checks every harness plist")
    func macDataDirectoryWiring() async throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }
        let plists = [
            fixture.base.appendingPathComponent("app.botfleet.server.plist"),
            fixture.base.appendingPathComponent("com.jay.botfleet-server.plist"),
        ]
        let legacyImport = NativeLegacyStoreImport.forMacDataDirectory(fixture.dataDir, harnessPlists: plists)

        #expect(legacyImport.sourceDirectory == fixture.dataDir)
        #expect(legacyImport.markerURL == fixture.markerURL)
        #expect(legacyImport.harnessIsGone())
        // The legacy label alone still counts as an installed harness.
        try Data().write(to: plists[1])
        #expect(!legacyImport.harnessIsGone())
    }

    @Test("The runtime host imports before it registers, so imported bots register in the same pass")
    func hostImportsBeforeRegistering() async throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }
        try fixture.writeLegacyStore()
        let legacyImport = fixture.importer(harnessIsGone: true)
        let workspaces = fixture.base.appendingPathComponent("workspaces", isDirectory: true)
        let host = NativeMacRuntimeHost(prepare: { database in
            _ = await legacyImport.runIfNeeded(into: database)
        }) {
            let database = try DatabaseService(path: ":memory:")
            return (database, NativeMacCompanionRuntime(database: database, workspacesRoot: workspaces))
        }

        let opened = try host.open()
        let report = await opened.registration.value

        #expect(report.loadFailure == nil)
        // Whether this host can build the bot's driver decides which list it
        // lands in; either way registration saw the imported bot.
        #expect((report.registered + report.skipped.map(\.botId)).contains("bot-1"))
    }

    // MARK: - Fixture

    private struct Fixture {
        let base: URL
        let dataDir: URL
        var markerURL: URL {
            dataDir.appendingPathComponent("native", isDirectory: true)
                .appendingPathComponent("legacy-import.json")
        }

        init() throws {
            base = FileManager.default.temporaryDirectory
                .appendingPathComponent("legacy-import-\(UUID().uuidString)", isDirectory: true)
            dataDir = base.appendingPathComponent("botfleet", isDirectory: true)
            try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        }

        func importer(harnessIsGone: Bool) -> NativeLegacyStoreImport {
            NativeLegacyStoreImport(
                sourceDirectory: dataDir,
                markerURL: markerURL,
                harnessIsGone: { harnessIsGone }
            )
        }

        /// One bot with its thread in `bots.json` and two messages on that
        /// thread in `messages.db`, in the Node harness's schema.
        func writeLegacyStore(extraBotKey: String? = nil) throws {
            let extra = extraBotKey.map { ",\n    \"\($0)\": true" } ?? ""
            let botsJSON = """
            [
              {
                "id": "bot-1",
                "threadId": "thread-bot-1",
                "name": "Builder",
                "title": "Assistant",
                "description": "",
                "notifications": true,
                "color": "blue",
                "unread": false,
                "modelSelection": {"instanceId": "claude", "model": "sonnet"},
                "createdAt": 1700000000000\(extra)
              }
            ]
            """
            try Data(botsJSON.utf8).write(to: dataDir.appendingPathComponent("bots.json"))
            let dbURL = dataDir.appendingPathComponent("messages.db")
            if FileManager.default.fileExists(atPath: dbURL.path) { return }
            try Self.writeMessagesDB(at: dbURL.path)
        }

        func cleanup() { try? FileManager.default.removeItem(at: base) }

        private static func writeMessagesDB(at path: String) throws {
            var db: OpaquePointer?
            guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK else {
                throw DatabaseError.openFailed("could not create the legacy messages.db")
            }
            defer { sqlite3_close(db) }
            let sql = """
            CREATE TABLE messages (
                thread_id TEXT NOT NULL,
                id TEXT NOT NULL,
                at INTEGER NOT NULL,
                role TEXT NOT NULL,
                kind TEXT NOT NULL,
                text TEXT,
                json TEXT NOT NULL,
                PRIMARY KEY (thread_id, id)
            );
            CREATE TABLE thread_state (
                thread_id TEXT PRIMARY KEY,
                active_leaf_id TEXT NOT NULL
            );
            CREATE TABLE running_helpers (
                thread_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                PRIMARY KEY (thread_id, message_id)
            );
            INSERT INTO messages VALUES ('thread-bot-1', 'm-1', 1700000100000, 'user', 'text', 'Hello',
                '{"id":"m-1","role":"user","kind":"text","at":1700000100000,"text":"Hello"}');
            INSERT INTO messages VALUES ('thread-bot-1', 'm-2', 1700000200000, 'bot', 'text', 'Hi there',
                '{"id":"m-2","role":"bot","kind":"text","at":1700000200000,"text":"Hi there"}');
            INSERT INTO thread_state VALUES ('thread-bot-1', 'm-2');
            """
            guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else {
                throw DatabaseError.executionFailed("could not fill the legacy messages.db")
            }
        }
    }
}
