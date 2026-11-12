import Foundation
import SQLite3
import Testing
@testable import CompanionCore

/// Store-integrity tests for the native `messages` table (BF-2495).
///
/// These cover two ways the native store could lose or mis-pair data:
///
///   * a message id that exists in two threads in the legacy Node store, and
///   * a store created before the FTS triggers were rewritten, where the FTS
///     rowid can drift away from the message rowid it belongs to.
@Suite("Phase 1 native store integrity (BF-2495)")
struct Phase1DatabaseStoreIntegrityTests {

    // MARK: - Helpers

    /// Creates a store with the trigger bodies the native store shipped with
    /// before the FTS triggers were rewritten onto `rowid`.
    ///
    /// The legacy bodies let SQLite assign the FTS rowid itself, and the
    /// legacy update trigger removed a row by `message_id` before inserting a
    /// replacement, so an updated message moved to a new FTS rowid while its
    /// `messages` rowid stayed put.
    private func createLegacyTriggerStore(at path: String) throws {
        var db: OpaquePointer?
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK else {
            throw DatabaseError.openFailed("Failed to create the legacy-trigger store")
        }
        defer { sqlite3_close(db) }

        let schema = """
        CREATE TABLE IF NOT EXISTS threads (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            bot_id TEXT,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            role TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'text',
            content TEXT NOT NULL,
            created_at REAL NOT NULL,
            model TEXT,
            active_leaf_id TEXT,
            FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content,
            thread_id UNINDEXED,
            message_id UNINDEXED,
            tokenize = 'porter unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS trg_messages_ai AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(content, thread_id, message_id)
            VALUES (new.content, new.thread_id, new.id);
        END;

        CREATE TRIGGER IF NOT EXISTS trg_messages_ad AFTER DELETE ON messages BEGIN
            DELETE FROM messages_fts WHERE message_id = old.id;
        END;

        CREATE TRIGGER IF NOT EXISTS trg_messages_au AFTER UPDATE ON messages BEGIN
            DELETE FROM messages_fts WHERE message_id = old.id;
            INSERT INTO messages_fts(content, thread_id, message_id)
            VALUES (new.content, new.thread_id, new.id);
        END;
        """
        guard sqlite3_exec(db, schema, nil, nil, nil) == SQLITE_OK else {
            throw DatabaseError.executionFailed("Failed to initialize the legacy-trigger schema")
        }

        let seed = """
        INSERT INTO threads (id, title, bot_id, created_at, updated_at)
        VALUES ('thread-1', 'Thread one', 'bot-1', 1000, 1000);

        INSERT INTO messages (id, thread_id, role, kind, content, created_at)
        VALUES ('msg-alpha', 'thread-1', 'user', 'text', 'alpha original word', 1001);

        INSERT INTO messages (id, thread_id, role, kind, content, created_at)
        VALUES ('msg-beta', 'thread-1', 'assistant', 'text', 'beta original word', 1002);

        INSERT INTO messages (id, thread_id, role, kind, content, created_at)
        VALUES ('msg-gamma', 'thread-1', 'assistant', 'text', 'gamma original word', 1003);

        UPDATE messages SET content = 'beta updated word' WHERE id = 'msg-beta';

        INSERT INTO messages (id, thread_id, role, kind, content, created_at)
        VALUES ('msg-delta', 'thread-1', 'assistant', 'text', 'delta original word', 1004);
        """
        guard sqlite3_exec(db, seed, nil, nil, nil) == SQLITE_OK else {
            throw DatabaseError.executionFailed("Failed to seed the legacy-trigger store")
        }
    }

    private func makeTempDirectory() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("botfleet-store-integrity-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    // MARK: - Cross-Thread Message Id Collision

    @Test("A message id that belongs to another thread is refused rather than re-homed")
    func crossThreadMessageIdIsRefused() async throws {
        let dir = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try DatabaseService(path: dir.appendingPathComponent("store.sqlite").path)

        try await db.upsertThread(ThreadRecord(
            id: "thread-a", title: "Thread A", botId: "bot-1", createdAt: 1000, updatedAt: 1000
        ))
        try await db.upsertThread(ThreadRecord(
            id: "thread-b", title: "Thread B", botId: "bot-1", createdAt: 1000, updatedAt: 1000
        ))

        let inThreadA = MessageRecord(
            id: "shared-id", threadId: "thread-a", role: "user", kind: "text",
            content: "the original message", createdAt: 1001
        )
        try await db.insertMessage(inThreadA)

        // The same message id arriving for another thread must not move the
        // message out of the thread that owns it.
        let inThreadB = MessageRecord(
            id: "shared-id", threadId: "thread-b", role: "user", kind: "text",
            content: "a different message with the same id", createdAt: 1002
        )
        var thrown: DatabaseError?
        do {
            try await db.insertMessage(inThreadB)
        } catch let error as DatabaseError {
            thrown = error
        }
        #expect(thrown != nil, "Writing a message id owned by another thread must fail loudly.")
        if case .messageThreadConflict(let id, let existingThreadId, let incomingThreadId) = thrown {
            #expect(id == "shared-id")
            #expect(existingThreadId == "thread-a")
            #expect(incomingThreadId == "thread-b")
        } else {
            Issue.record("Expected a messageThreadConflict error, got \(String(describing: thrown)).")
        }

        // The original message is untouched.
        let stored = try await db.loadMessages(forThread: "thread-a")
        #expect(stored.count == 1)
        #expect(stored.first?.content == "the original message")
        #expect(stored.first?.threadId == "thread-a")

        let otherThread = try await db.loadMessages(forThread: "thread-b")
        #expect(otherThread.isEmpty)
    }

    @Test("A batch that carries a message id owned by another thread is refused as a whole")
    func crossThreadMessageIdInBatchIsRefused() async throws {
        let dir = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try DatabaseService(path: dir.appendingPathComponent("store.sqlite").path)

        try await db.upsertThread(ThreadRecord(
            id: "thread-a", title: "Thread A", botId: "bot-1", createdAt: 1000, updatedAt: 1000
        ))
        try await db.upsertThread(ThreadRecord(
            id: "thread-b", title: "Thread B", botId: "bot-1", createdAt: 1000, updatedAt: 1000
        ))

        try await db.insertMessagesBatch([
            MessageRecord(id: "shared-id", threadId: "thread-a", role: "user", kind: "text",
                          content: "the original message", createdAt: 1001)
        ])

        var thrown: DatabaseError?
        do {
            try await db.insertMessagesBatch([
                MessageRecord(id: "fresh-id", threadId: "thread-b", role: "user", kind: "text",
                              content: "a brand new message", createdAt: 1002),
                MessageRecord(id: "shared-id", threadId: "thread-b", role: "user", kind: "text",
                              content: "a different message with the same id", createdAt: 1003)
            ])
        } catch let error as DatabaseError {
            thrown = error
        }
        #expect(thrown != nil, "A batch carrying another thread's message id must fail loudly.")
        if case .messageThreadConflict(let id, let existingThreadId, let incomingThreadId) = thrown {
            #expect(id == "shared-id")
            #expect(existingThreadId == "thread-a")
            #expect(incomingThreadId == "thread-b")
        } else {
            Issue.record("Expected a messageThreadConflict error, got \(String(describing: thrown)).")
        }

        // The batch is rolled back, so the row written before the collision is
        // not left behind either.
        let otherThread = try await db.loadMessages(forThread: "thread-b")
        #expect(otherThread.isEmpty)
        let originalThread = try await db.loadMessages(forThread: "thread-a")
        #expect(originalThread.count == 1)
        #expect(originalThread.first?.content == "the original message")
    }

    // MARK: - Legacy FTS Trigger Bodies

    @Test("A store carrying the legacy FTS triggers is resynced so search pairs snippets with the right message")
    func legacyTriggerStoreIsResynced() async throws {
        let dir = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("legacy.sqlite").path
        try createLegacyTriggerStore(at: path)

        // Before the store is opened by the native engine, the legacy update
        // trigger has already moved the updated message to a fresh FTS rowid
        // that no longer matches its `messages` rowid.
        let db = try DatabaseService(path: path)

        let betaHits = try await db.search(query: "beta", limit: 50)
        #expect(betaHits.count == 1, "The updated message must still be searchable by its own content.")
        #expect(betaHits.first?.id == "msg-beta")
        #expect(betaHits.first?.content.contains("beta updated word") == true)

        let deltaHits = try await db.search(query: "delta", limit: 50)
        #expect(deltaHits.count == 1)
        #expect(deltaHits.first?.id == "msg-delta")
        #expect(deltaHits.first?.content.contains("delta original word") == true)

        // Every message is reachable, so the resync did not drop or
        // mis-pair a row.
        for (term, expectedId) in [("alpha", "msg-alpha"), ("gamma", "msg-gamma")] {
            let hits = try await db.search(query: term, limit: 50)
            #expect(hits.count == 1, "Expected exactly one hit for '\(term)'.")
            #expect(hits.first?.id == expectedId)
        }
    }

    @Test("A store opened twice keeps the FTS index in step with the message rowids")
    func reopenedStoreKeepsFTSInStep() async throws {
        let dir = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("reopened.sqlite").path
        try createLegacyTriggerStore(at: path)

        // The first open replaces the legacy trigger bodies and resyncs the
        // index.  The second open must not resync again or drop anything.
        let first = try DatabaseService(path: path)
        let second = try DatabaseService(path: path)

        for db in [first, second] {
            let betaHits = try await db.search(query: "beta", limit: 50)
            #expect(betaHits.count == 1)
            #expect(betaHits.first?.id == "msg-beta")
        }
    }

    @Test("A message inserted after the legacy triggers were replaced lands on its own FTS rowid")
    func newInsertAfterTriggerReplacementUsesItsOwnRowid() async throws {
        let dir = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("new-insert.sqlite").path
        try createLegacyTriggerStore(at: path)

        let db = try DatabaseService(path: path)
        try await db.insertMessage(MessageRecord(
            id: "msg-epsilon", threadId: "thread-1", role: "user", kind: "text",
            content: "epsilon brand new word", createdAt: 1005
        ))

        let hits = try await db.search(query: "epsilon", limit: 50)
        #expect(hits.count == 1)
        #expect(hits.first?.id == "msg-epsilon")
        #expect(hits.first?.content == "epsilon brand new word")
    }

    // MARK: - Opening An Existing Store

    @Test("Reopening a healthy store runs no schema DDL")
    func reopeningAHealthyStoreRunsNoSchemaDDL() async throws {
        let dir = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("healthy.sqlite").path

        let first = try DatabaseService(path: path)
        let versionAfterFirstOpen = try await first.schemaVersion()
        #expect(versionAfterFirstOpen > 0, "The first open provisions the schema.")

        // The second open must not rewrite the triggers.  A schema change
        // would mean a write transaction on every launch, which is what made
        // a concurrent writer fail the open outright.
        let second = try DatabaseService(path: path)
        let versionAfterSecondOpen = try await second.schemaVersion()
        #expect(versionAfterSecondOpen == versionAfterFirstOpen,
                "Reopening a healthy store must not change the schema, so the launch path stays read-only.")

        // The triggers are still the current bodies.
        let triggers = try await second.triggerDefinitions()
        #expect(triggers["trg_messages_ai"]?.contains("rowid") == true)
        #expect(triggers["trg_messages_ad"]?.contains("rowid") == true)
        #expect(triggers["trg_messages_au"]?.contains("rowid") == true)
    }

    @Test("The store waits for a lock held by another writer instead of failing at once")
    func theStoreWaitsForAConcurrentWriter() async throws {
        let dir = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try DatabaseService(path: dir.appendingPathComponent("busy.sqlite").path)

        // Without a busy timeout the very first statement that needs the
        // write lock fails with SQLITE_BUSY while another writer holds it.
        let timeout = try await db.busyTimeoutMilliseconds()
        #expect(timeout > 0, "The connection must wait for a lock held by another writer.")
    }

    @Test("A store whose triggers were lost gets them back, and its index stays in step")
    func storeWithLostTriggersGetsThemBack() async throws {
        let dir = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("lost-triggers.sqlite").path

        let db = try DatabaseService(path: path)
        try await db.upsertThread(ThreadRecord(
            id: "thread-1", title: "Thread one", botId: "bot-1", createdAt: 1000, updatedAt: 1000
        ))
        try await db.insertMessage(MessageRecord(
            id: "msg-alpha", threadId: "thread-1", role: "user", kind: "text",
            content: "alpha original word", createdAt: 1001
        ))
        try await db.insertMessage(MessageRecord(
            id: "msg-beta", threadId: "thread-1", role: "assistant", kind: "text",
            content: "beta original word", createdAt: 1002
        ))

        // An interrupted launch can leave the triggers gone.  Drop them
        // behind the service's back, the way a half-finished replacement
        // would.
        try dropMessageTriggers(at: path)
        let withoutTriggers = try DatabaseService(path: path, createSchemaIfNeeded: false)
        let dropped = try await withoutTriggers.triggerDefinitions()
        #expect(dropped["trg_messages_ai"] == nil)

        // The next open puts them back.
        let reopened = try DatabaseService(path: path)
        let restored = try await reopened.triggerDefinitions()
        #expect(restored["trg_messages_ai"]?.contains("rowid") == true)
        #expect(restored["trg_messages_ad"]?.contains("rowid") == true)
        #expect(restored["trg_messages_au"]?.contains("rowid") == true)

        // And the index still pairs a snippet with the right message.
        let hits = try await reopened.search(query: "beta", limit: 50)
        #expect(hits.count == 1)
        #expect(hits.first?.id == "msg-beta")
        #expect(hits.first?.content == "beta original word")
    }

    /// Drops the FTS triggers behind the service's back, the way an
    /// interrupted trigger replacement would leave the store.
    private func dropMessageTriggers(at path: String) throws {
        var db: OpaquePointer?
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else {
            throw DatabaseError.openFailed("Failed to open the store to drop its triggers")
        }
        defer { sqlite3_close(db) }

        let sql = """
        DROP TRIGGER IF EXISTS trg_messages_ai;
        DROP TRIGGER IF EXISTS trg_messages_ad;
        DROP TRIGGER IF EXISTS trg_messages_au;
        """
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else {
            throw DatabaseError.executionFailed("Failed to drop the message triggers")
        }
    }
}
