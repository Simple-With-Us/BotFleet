import Foundation
import SQLite3

public struct ThreadRecord: Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let botId: String?
    public let createdAt: Double
    public let updatedAt: Double

    public init(id: String, title: String, botId: String? = nil, createdAt: Double = Date().timeIntervalSince1970, updatedAt: Double = Date().timeIntervalSince1970) {
        self.id = id
        self.title = title
        self.botId = botId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct MessageRecord: Equatable, Sendable, Identifiable {
    public let id: String
    public let threadId: String
    public let role: String
    public let kind: String
    public let content: String
    public let createdAt: Double
    public let model: String?
    public let activeLeafId: String?
    /// The part of the source message JSON the native columns have no home for.
    ///
    /// The legacy store keeps a message's parent id, its reactions, its card,
    /// its tool payload and its audio inside the message's own JSON.  The
    /// native columns carry the text of a message, so the rest of that JSON is
    /// kept verbatim here instead of being dropped, and the native app can
    /// read it back.
    public let metadataJSON: String?

    public init(
        id: String,
        threadId: String,
        role: String,
        kind: String = "text",
        content: String,
        createdAt: Double = Date().timeIntervalSince1970,
        model: String? = nil,
        activeLeafId: String? = nil,
        metadataJSON: String? = nil
    ) {
        self.id = id
        self.threadId = threadId
        self.role = role
        self.kind = kind
        self.content = content
        self.createdAt = createdAt
        self.model = model
        self.activeLeafId = activeLeafId
        self.metadataJSON = metadataJSON
    }
}

public struct DatabaseSearchResult: Equatable, Sendable, Identifiable {
    public let id: String
    public let threadId: String
    public let snippet: String
    public let content: String
    public let createdAt: Double

    public init(id: String, threadId: String, snippet: String, content: String, createdAt: Double) {
        self.id = id
        self.threadId = threadId
        self.snippet = snippet
        self.content = content
        self.createdAt = createdAt
    }
}

public struct RoutineRunRecord: Equatable, Sendable, Identifiable {
    public let id: String
    public let routineId: String
    public let botId: String
    public let status: String
    public let startedAt: Double
    public let completedAt: Double?
    public let error: String?

    public init(
        id: String,
        routineId: String,
        botId: String,
        status: String,
        startedAt: Double = Date().timeIntervalSince1970,
        completedAt: Double? = nil,
        error: String? = nil
    ) {
        self.id = id
        self.routineId = routineId
        self.botId = botId
        self.status = status
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.error = error
    }
}

public struct WebhookDeliveryRecord: Equatable, Sendable, Identifiable {
    public let id: String
    public let webhookId: String
    public let botId: String?
    public let statusCode: Int?
    public let deliveredAt: Double
    public let payload: String?
    public let response: String?

    public init(
        id: String,
        webhookId: String,
        botId: String? = nil,
        statusCode: Int? = nil,
        deliveredAt: Double = Date().timeIntervalSince1970,
        payload: String? = nil,
        response: String? = nil
    ) {
        self.id = id
        self.webhookId = webhookId
        self.botId = botId
        self.statusCode = statusCode
        self.deliveredAt = deliveredAt
        self.payload = payload
        self.response = response
    }
}

public struct StoredBotRecord: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let threadId: String?
    public let createdAt: Double
    public let rawJSON: String

    public init(id: String, name: String, threadId: String? = nil, createdAt: Double, rawJSON: String) {
        self.id = id
        self.name = name
        self.threadId = threadId
        self.createdAt = createdAt
        self.rawJSON = rawJSON
    }
}

public struct StoredRoutineRecord: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let botId: String
    public let schedule: String
    public let enabled: Bool
    public let createdAt: Double
    public let updatedAt: Double
    public let rawJSON: String

    public init(
        id: String,
        name: String,
        botId: String,
        schedule: String,
        enabled: Bool,
        createdAt: Double,
        updatedAt: Double,
        rawJSON: String
    ) {
        self.id = id
        self.name = name
        self.botId = botId
        self.schedule = schedule
        self.enabled = enabled
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.rawJSON = rawJSON
    }
}

public struct StoredWebhookRecord: Equatable, Sendable, Identifiable {
    public let id: String
    public let endpointId: String
    public let name: String
    public let botId: String
    public let enabled: Bool
    public let createdAt: Double
    public let updatedAt: Double
    public let rawJSON: String

    public init(
        id: String,
        endpointId: String,
        name: String,
        botId: String,
        enabled: Bool,
        createdAt: Double,
        updatedAt: Double,
        rawJSON: String
    ) {
        self.id = id
        self.endpointId = endpointId
        self.name = name
        self.botId = botId
        self.enabled = enabled
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.rawJSON = rawJSON
    }
}

public enum DatabaseError: LocalizedError, Equatable {
    case openFailed(String)
    case executionFailed(String)
    case prepareFailed(String)
    case stepFailed(String)
    case notFound
    /// A message id is already owned by a different thread.
    ///
    /// `messages` is keyed on `id`, while the legacy Node store keys a message
    /// on `(thread_id, id)`, so the same message id can exist in two threads
    /// there.  Writing it here would either drop a message or move it out of
    /// the thread that owns it, so the write is refused instead.
    case messageThreadConflict(id: String, existingThreadId: String, incomingThreadId: String)

    public var errorDescription: String? {
        switch self {
        case .openFailed(let msg): return "Failed to open SQLite database: \(msg)"
        case .executionFailed(let msg): return "SQLite execution failed: \(msg)"
        case .prepareFailed(let msg): return "SQLite statement prepare failed: \(msg)"
        case .stepFailed(let msg): return "SQLite step failed: \(msg)"
        case .notFound: return "Requested record not found in database"
        case .messageThreadConflict(let id, let existingThreadId, let incomingThreadId):
            return "Message '\(id)' already belongs to thread '\(existingThreadId)' and cannot be written to thread '\(incomingThreadId)'."
        }
    }
}

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// Native Swift SQLite persistence engine with WAL mode and FTS5 full-text search.
/// Replaces flat JSON transcript parsing and fsyncSync file rewrites with sub-millisecond
/// transactional reads, concurrent background writes, and instant snippet search.
public actor DatabaseService {
    private var db: OpaquePointer?
    private let databasePath: String

    /// Opens the native store.
    ///
    /// - Parameters:
    ///   - path: the store path, or nil for an in-memory store.
    ///   - createSchemaIfNeeded: false opens an already-provisioned store
    ///     without running the schema DDL.  The performance harness uses it
    ///     to time the launch path rather than the installer, because
    ///     `CREATE TABLE IF NOT EXISTS` is first-run install work.
    public init(path: String? = nil, createSchemaIfNeeded: Bool = true) throws {
        let dbPath = path ?? ":memory:"
        self.databasePath = dbPath
        if let parent = path.flatMap({ URL(fileURLWithPath: $0).deletingLastPathComponent().path }), parent != "/" && !parent.isEmpty {
            try? FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true)
        }

        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        if sqlite3_open_v2(dbPath, &handle, flags, nil) != SQLITE_OK {
            let msg = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "Unknown error"
            sqlite3_close(handle)
            throw DatabaseError.openFailed(msg)
        }
        self.db = handle

        // Another writer can hold the store's write lock, so an ordinary open
        // waits for it instead of failing with SQLITE_BUSY.  The pragma is set
        // before the first statement that can need the lock.
        try execute(sql: "PRAGMA busy_timeout = 5000;")
        try execute(sql: "PRAGMA journal_mode = WAL;")
        // sqlite3_exec reports no error when WAL is unsupported and SQLite
        // silently keeps rollback journaling; read the mode back so the
        // degradation is loud instead of invisible.
        if let mode = try queryString(sql: "PRAGMA journal_mode;"), mode.lowercased() != "wal" {
            NSLog("DatabaseService: WAL journal_mode unavailable (got '\(mode)'); concurrent reads and crash-safe writes are degraded on this filesystem.")
        }
        try execute(sql: "PRAGMA synchronous = NORMAL;")
        try execute(sql: "PRAGMA foreign_keys = ON;")
        // REPLACE-style writes fire delete+insert trigger pairs; without this,
        // the FTS delete triggers do not cascade.
        try execute(sql: "PRAGMA recursive_triggers = ON;")

        try createSchema(createIfNeeded: createSchemaIfNeeded)
    }

    deinit {
        if let db = db {
            sqlite3_close(db)
        }
    }

    private func queryString(sql: String) throws -> String? {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        guard let cText = sqlite3_column_text(stmt, 0) else { return nil }
        return String(cString: cText)
    }

    private func execute(sql: String) throws {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        var errmsg: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &errmsg) != SQLITE_OK {
            let msg = errmsg.map { String(cString: $0) } ?? "Unknown error"
            sqlite3_free(errmsg)
            throw DatabaseError.executionFailed(msg)
        }
    }

    /// Creates the native schema.
    ///
    /// - Parameter createIfNeeded: false leaves an already-provisioned store
    ///   alone.  The performance harness opens the store this way so the
    ///   launch path is timed instead of the installer.
    private func createSchema(createIfNeeded: Bool = true) throws {
        guard createIfNeeded else { return }
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
            metadata_json TEXT,
            FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_messages_thread_created ON messages(thread_id, created_at);

        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content,
            thread_id UNINDEXED,
            message_id UNINDEXED,
            tokenize = 'porter unicode61'
        );

        CREATE TABLE IF NOT EXISTS routine_runs (
            id TEXT PRIMARY KEY,
            routine_id TEXT NOT NULL,
            bot_id TEXT NOT NULL,
            status TEXT NOT NULL,
            started_at REAL NOT NULL,
            completed_at REAL,
            error TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_routine_runs_routine ON routine_runs(routine_id, started_at);

        CREATE TABLE IF NOT EXISTS native_event_waits (
            wait_id TEXT PRIMARY KEY,
            bot_id TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at REAL NOT NULL,
            deadline_at REAL NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0,
            snapshot_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_native_event_waits_bot_status ON native_event_waits(bot_id, status);

        CREATE TABLE IF NOT EXISTS native_event_wait_dispatches (
            wait_id TEXT PRIMARY KEY,
            accepted_at REAL NOT NULL
        );

        INSERT OR IGNORE INTO native_event_wait_dispatches (wait_id, accepted_at)
        SELECT wait_id, created_at FROM native_event_waits WHERE status IN ('accepted', 'completed', 'held');

        CREATE TABLE IF NOT EXISTS routine_request_receipts (
            request_id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            bot_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            action TEXT NOT NULL,
            fingerprint_version INTEGER NOT NULL,
            fingerprint TEXT NOT NULL,
            result_id TEXT NOT NULL,
            applied_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS webhook_deliveries (
            id TEXT PRIMARY KEY,
            webhook_id TEXT NOT NULL,
            bot_id TEXT,
            status_code INTEGER,
            delivered_at REAL NOT NULL,
            payload TEXT,
            response TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries ON webhook_deliveries(webhook_id, delivered_at);

        CREATE TABLE IF NOT EXISTS bots (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            thread_id TEXT,
            created_at REAL NOT NULL,
            raw_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS routines (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            bot_id TEXT NOT NULL,
            schedule TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            raw_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS webhooks (
            id TEXT PRIMARY KEY,
            endpoint_id TEXT NOT NULL,
            name TEXT NOT NULL,
            bot_id TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            raw_json TEXT NOT NULL
        );
        """
        try execute(sql: schema)
        // A store provisioned by an earlier native build does not carry the
        // metadata column yet, so add it when it is missing.  The check keeps
        // the launch path free of a write on a store that is already current.
        if try !tableHasColumn("metadata_json", inTable: "messages") {
            try execute(sql: "ALTER TABLE messages ADD COLUMN metadata_json TEXT;")
        }
        if try !tableHasColumn("revision", inTable: "native_event_waits") {
            try execute(sql: "ALTER TABLE native_event_waits ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;")
        }
        try ensureMessageTriggers()
    }

    /// Whether a table carries a named column.
    ///
    /// The table name is an internal constant, never anything from a caller.
    private func tableHasColumn(_ column: String, inTable table: String) throws -> Bool {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = "PRAGMA table_info(\(table));"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let name = sqlite3_column_text(stmt, 1) else { continue }
            if String(cString: name) == column {
                return true
            }
        }
        return false
    }

    /// Makes sure the FTS triggers exist and carry the current bodies.
    ///
    /// A store that predates the rewrite ran legacy trigger bodies: the
    /// insert trigger let SQLite assign the FTS rowid itself, and the update
    /// trigger removed a row by `message_id` before inserting a replacement
    /// with a new rowid.  A store still running those bodies ends up with an
    /// FTS rowid that no longer matches `messages.rowid`, so a search can pair
    /// a snippet with the wrong message.
    ///
    /// A healthy store already carries the three current triggers, so it is
    /// opened with no DDL at all.  A store that predates the rewrite, or one
    /// whose triggers were lost to an interrupted launch, has them replaced
    /// inside a single transaction: the drops, the creates and the index
    /// rebuild commit together, so a crash cannot leave the store with no
    /// triggers and a permanently stale index.
    private func ensureMessageTriggers() throws {
        let legacyTriggerCount = try countLegacyMessageTriggers()
        let currentTriggerCount = try countCurrentMessageTriggers()
        if currentTriggerCount == 3 && legacyTriggerCount == 0 {
            return
        }

        try execute(sql: "BEGIN IMMEDIATE TRANSACTION;")
        do {
            for name in ["trg_messages_ai", "trg_messages_ad", "trg_messages_au"] {
                try execute(sql: "DROP TRIGGER IF EXISTS \(name);")
            }
            try execute(sql: """
            CREATE TRIGGER trg_messages_ai AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(rowid, content, thread_id, message_id)
                VALUES (new.rowid, new.content, new.thread_id, new.id);
            END;

            CREATE TRIGGER trg_messages_ad AFTER DELETE ON messages BEGIN
                DELETE FROM messages_fts WHERE rowid = old.rowid;
            END;

            CREATE TRIGGER trg_messages_au AFTER UPDATE ON messages BEGIN
                DELETE FROM messages_fts WHERE rowid = old.rowid;
                INSERT INTO messages_fts(rowid, content, thread_id, message_id)
                VALUES (new.rowid, new.content, new.thread_id, new.id);
            END;
            """)

            // The index is rebuilt only when the store was still carrying the
            // legacy bodies, because those bodies are what let the FTS rowid
            // drift away from the message rowid it belongs to.
            if legacyTriggerCount > 0 {
                try resyncFTSIndexInCurrentTransaction()
            }
            try execute(sql: "COMMIT;")
        } catch {
            try? execute(sql: "ROLLBACK;")
            throw error
        }
    }

    /// Counts the message triggers that still carry a legacy body.
    ///
    /// A current body names `rowid`; a legacy one lets SQLite assign the FTS
    /// rowid itself.
    private func countLegacyMessageTriggers() throws -> Int {
        try countMessageTriggers(matching: "sql NOT LIKE '%rowid%'")
    }

    /// Counts the message triggers that carry the current body.
    private func countCurrentMessageTriggers() throws -> Int {
        try countMessageTriggers(matching: "sql LIKE '%rowid%'")
    }

    /// Counts the message triggers whose stored body matches the predicate.
    private func countMessageTriggers(matching predicate: String) throws -> Int {
        let sql = """
        SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'trigger'
          AND name IN ('trg_messages_ai', 'trg_messages_ad', 'trg_messages_au')
          AND \(predicate);
        """
        guard let value = try queryString(sql: sql) else { return 0 }
        return Int(value) ?? 0
    }

    /// Rebuilds the FTS index from `messages` so every index rowid matches the
    /// message rowid it belongs to.
    ///
    /// Runs inside the caller's transaction, so the rebuilt index and the
    /// replaced triggers commit together.
    private func resyncFTSIndexInCurrentTransaction() throws {
        try execute(sql: "DELETE FROM messages_fts;")
        try execute(sql: """
        INSERT INTO messages_fts(rowid, content, thread_id, message_id)
        SELECT rowid, content, thread_id, id FROM messages;
        """)
    }

    // MARK: - Thread Operations

    public func upsertThread(_ thread: ThreadRecord) throws {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = """
        INSERT INTO threads (id, title, bot_id, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            bot_id = excluded.bot_id,
            updated_at = excluded.updated_at;
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, (thread.id as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, (thread.title as NSString).utf8String, -1, SQLITE_TRANSIENT)
        if let botId = thread.botId {
            sqlite3_bind_text(stmt, 3, (botId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(stmt, 3)
        }
        sqlite3_bind_double(stmt, 4, thread.createdAt)
        sqlite3_bind_double(stmt, 5, thread.updatedAt)

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(String(cString: sqlite3_errmsg(db)))
        }
    }

    public func loadThreads(forBot botId: String? = nil, limit: Int = 100) throws -> [ThreadRecord] {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = botId == nil
            ? "SELECT id, title, bot_id, created_at, updated_at FROM threads ORDER BY updated_at DESC LIMIT ?1;"
            : "SELECT id, title, bot_id, created_at, updated_at FROM threads WHERE bot_id = ?2 ORDER BY updated_at DESC LIMIT ?1;"

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_int(stmt, 1, Int32(limit))
        if let botId = botId {
            sqlite3_bind_text(stmt, 2, (botId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        }

        var results: [ThreadRecord] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = String(cString: sqlite3_column_text(stmt, 0))
            let title = String(cString: sqlite3_column_text(stmt, 1))
            let botId = sqlite3_column_type(stmt, 2) != SQLITE_NULL ? String(cString: sqlite3_column_text(stmt, 2)) : nil
            let createdAt = sqlite3_column_double(stmt, 3)
            let updatedAt = sqlite3_column_double(stmt, 4)
            results.append(ThreadRecord(id: id, title: title, botId: botId, createdAt: createdAt, updatedAt: updatedAt))
        }
        return results
    }

    public func deleteThread(id: String) throws {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = "DELETE FROM threads WHERE id = ?1;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, (id as NSString).utf8String, -1, SQLITE_TRANSIENT)
        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(String(cString: sqlite3_errmsg(db)))
        }
    }

    // MARK: - Message Operations

    public func insertMessage(_ message: MessageRecord) throws {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = """
        INSERT INTO messages (id, thread_id, role, kind, content, created_at, model, active_leaf_id, metadata_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(id) DO UPDATE SET
            thread_id = excluded.thread_id,
            role = excluded.role,
            kind = excluded.kind,
            content = excluded.content,
            created_at = excluded.created_at,
            model = excluded.model,
            active_leaf_id = excluded.active_leaf_id,
            metadata_json = excluded.metadata_json
        WHERE messages.thread_id = excluded.thread_id;
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, (message.id as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, (message.threadId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 3, (message.role as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 4, (message.kind as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 5, (message.content as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_double(stmt, 6, message.createdAt)

        if let model = message.model {
            sqlite3_bind_text(stmt, 7, (model as NSString).utf8String, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(stmt, 7)
        }

        if let leaf = message.activeLeafId {
            sqlite3_bind_text(stmt, 8, (leaf as NSString).utf8String, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(stmt, 8)
        }

        if let metadata = message.metadataJSON {
            sqlite3_bind_text(stmt, 9, (metadata as NSString).utf8String, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(stmt, 9)
        }

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(String(cString: sqlite3_errmsg(db)))
        }
        // The update above only fires for a row that already belongs to this
        // thread, so a write that changed nothing means the message id is
        // owned by another thread.  That is refused rather than allowed to
        // move the message out of the thread that has it.
        if sqlite3_changes(db) == 0 {
            try throwIfOwnedByAnotherThread(message)
        }

        // Update thread updated_at timestamp inside the same logical write
        let updateThreadSql = "UPDATE threads SET updated_at = ?1 WHERE id = ?2;"
        var updateStmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, updateThreadSql, -1, &updateStmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(updateStmt) }
        sqlite3_bind_double(updateStmt, 1, message.createdAt)
        sqlite3_bind_text(updateStmt, 2, (message.threadId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        guard sqlite3_step(updateStmt) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(String(cString: sqlite3_errmsg(db)))
        }
    }

    public func loadMessages(forThread threadId: String, limit: Int = 100, before: Double? = nil) throws -> [MessageRecord] {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = before == nil
            ? "SELECT id, thread_id, role, kind, content, created_at, model, active_leaf_id, metadata_json FROM messages WHERE thread_id = ?1 ORDER BY created_at ASC LIMIT ?2;"
            : "SELECT id, thread_id, role, kind, content, created_at, model, active_leaf_id, metadata_json FROM messages WHERE thread_id = ?1 AND created_at < ?3 ORDER BY created_at ASC LIMIT ?2;"

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, (threadId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int(stmt, 2, Int32(limit))
        if let before = before {
            sqlite3_bind_double(stmt, 3, before)
        }

        var results: [MessageRecord] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = String(cString: sqlite3_column_text(stmt, 0))
            let threadId = String(cString: sqlite3_column_text(stmt, 1))
            let role = String(cString: sqlite3_column_text(stmt, 2))
            let kind = String(cString: sqlite3_column_text(stmt, 3))
            let content = String(cString: sqlite3_column_text(stmt, 4))
            let createdAt = sqlite3_column_double(stmt, 5)
            let model = sqlite3_column_type(stmt, 6) != SQLITE_NULL ? String(cString: sqlite3_column_text(stmt, 6)) : nil
            let activeLeafId = sqlite3_column_type(stmt, 7) != SQLITE_NULL ? String(cString: sqlite3_column_text(stmt, 7)) : nil
            let metadataJSON = sqlite3_column_type(stmt, 8) != SQLITE_NULL ? String(cString: sqlite3_column_text(stmt, 8)) : nil

            results.append(MessageRecord(
                id: id,
                threadId: threadId,
                role: role,
                kind: kind,
                content: content,
                createdAt: createdAt,
                model: model,
                activeLeafId: activeLeafId,
                metadataJSON: metadataJSON
            ))
        }
        return results
    }

    // MARK: - Full-Text Search (FTS5)

    /// Full-text search across transcripts using SQLite3 FTS5 with BM25 ranking and highlighted snippets.
    public func search(query: String, inThread threadId: String? = nil, limit: Int = 50) throws -> [DatabaseSearchResult] {
        try performSearch(query: query, inThread: threadId, limit: limit).results
    }

    /// Runs the same FTS5 search as `search(query:inThread:limit:)` and reports
    /// how long the query itself took.
    ///
    /// The duration is measured inside the actor, around the prepared
    /// statement.  A caller that times the `await` from outside also measures
    /// the actor hop and its own instrumentation, which says more about the
    /// caller's scheduler than about the search.
    func searchMeasuringLatency(
        query: String,
        inThread threadId: String? = nil,
        limit: Int = 50
    ) throws -> (results: [DatabaseSearchResult], durationMs: Double) {
        try performSearch(query: query, inThread: threadId, limit: limit)
    }

    private func performSearch(
        query: String,
        inThread threadId: String?,
        limit: Int
    ) throws -> (results: [DatabaseSearchResult], durationMs: Double) {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let cleanQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanQuery.isEmpty else { return ([], 0) }

        // Sanitize query tokens for FTS5 syntax
        let formattedQuery = cleanQuery
            .components(separatedBy: .whitespaces)
            .filter { !$0.isEmpty }
            .map { "\"\($0.replacingOccurrences(of: "\"", with: "\"\""))\"*" }
            .joined(separator: " ")

        let sql = threadId == nil
            ? """
            SELECT m.id, m.thread_id, fts.snip, m.content, m.created_at
            FROM (
                SELECT rowid, snippet(messages_fts, 0, '<b>', '</b>', '…', 32) AS snip, rank
                FROM messages_fts
                WHERE messages_fts MATCH ?1
                ORDER BY rank
                LIMIT ?2
            ) fts
            JOIN messages m ON m.rowid = fts.rowid
            ORDER BY fts.rank;
            """
            : """
            SELECT m.id, m.thread_id, fts.snip, m.content, m.created_at
            FROM (
                SELECT rowid, snippet(messages_fts, 0, '<b>', '</b>', '…', 32) AS snip, rank
                FROM messages_fts
                WHERE messages_fts MATCH ?1 AND thread_id = ?3
                ORDER BY rank
                LIMIT ?2
            ) fts
            JOIN messages m ON m.rowid = fts.rowid
            ORDER BY fts.rank;
            """

        let queryBegin = DispatchTime.now().uptimeNanoseconds

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, (formattedQuery as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int(stmt, 2, Int32(limit))
        if let threadId = threadId {
            sqlite3_bind_text(stmt, 3, (threadId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        }

        var results: [DatabaseSearchResult] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = String(cString: sqlite3_column_text(stmt, 0))
            let threadId = String(cString: sqlite3_column_text(stmt, 1))
            let snippet = String(cString: sqlite3_column_text(stmt, 2))
            let content = String(cString: sqlite3_column_text(stmt, 3))
            let createdAt = sqlite3_column_double(stmt, 4)

            results.append(DatabaseSearchResult(
                id: id,
                threadId: threadId,
                snippet: snippet,
                content: content,
                createdAt: createdAt
            ))
        }

        let queryEnd = DispatchTime.now().uptimeNanoseconds
        let durationMs = Double(queryEnd - queryBegin) / 1_000_000.0
        return (results, durationMs)
    }

    // MARK: - Routine Runs

    public func recordRoutineRun(_ run: RoutineRunRecord) throws {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = """
        INSERT OR REPLACE INTO routine_runs (id, routine_id, bot_id, status, started_at, completed_at, error)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, (run.id as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, (run.routineId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 3, (run.botId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 4, (run.status as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_double(stmt, 5, run.startedAt)

        if let completed = run.completedAt {
            sqlite3_bind_double(stmt, 6, completed)
        } else {
            sqlite3_bind_null(stmt, 6)
        }

        if let err = run.error {
            sqlite3_bind_text(stmt, 7, (err as NSString).utf8String, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(stmt, 7)
        }

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(String(cString: sqlite3_errmsg(db)))
        }
    }

    public func loadRoutineRuns(forRoutine routineId: String, limit: Int = 50) throws -> [RoutineRunRecord] {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = "SELECT id, routine_id, bot_id, status, started_at, completed_at, error FROM routine_runs WHERE routine_id = ?1 ORDER BY started_at DESC LIMIT ?2;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, (routineId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int(stmt, 2, Int32(limit))

        var results: [RoutineRunRecord] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = String(cString: sqlite3_column_text(stmt, 0))
            let routineId = String(cString: sqlite3_column_text(stmt, 1))
            let botId = String(cString: sqlite3_column_text(stmt, 2))
            let status = String(cString: sqlite3_column_text(stmt, 3))
            let startedAt = sqlite3_column_double(stmt, 4)
            let completedAt = sqlite3_column_type(stmt, 5) != SQLITE_NULL ? sqlite3_column_double(stmt, 5) : nil
            let error = sqlite3_column_type(stmt, 6) != SQLITE_NULL ? String(cString: sqlite3_column_text(stmt, 6)) : nil

            results.append(RoutineRunRecord(
                id: id,
                routineId: routineId,
                botId: botId,
                status: status,
                startedAt: startedAt,
                completedAt: completedAt,
                error: error
            ))
        }
        return results
    }

    // MARK: - Native Event Waits

    public func saveNativeEventWait(_ wait: NativeEventWait) throws {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let encoder = JSONEncoder()
        let encoded: String
        do {
            encoded = String(decoding: try encoder.encode(wait), as: UTF8.self)
        } catch {
            throw DatabaseError.executionFailed("Failed to encode native event wait: \(error.localizedDescription)")
        }
        let sql = """
        INSERT INTO native_event_waits (wait_id, bot_id, status, created_at, deadline_at, revision, snapshot_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(wait_id) DO UPDATE SET
            bot_id = excluded.bot_id,
            status = excluded.status,
            created_at = excluded.created_at,
            deadline_at = excluded.deadline_at,
            revision = excluded.revision,
            snapshot_json = excluded.snapshot_json;
        """
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_text(statement, 1, (wait.id as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(statement, 2, (wait.botId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(statement, 3, (wait.status.rawValue as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_double(statement, 4, wait.createdAt)
        sqlite3_bind_double(statement, 5, wait.deadlineAt)
        sqlite3_bind_int64(statement, 6, Int64(wait.revision))
        sqlite3_bind_text(statement, 7, (encoded as NSString).utf8String, -1, SQLITE_TRANSIENT)
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(String(cString: sqlite3_errmsg(db)))
        }
    }

    public func loadNativeEventWaits() throws -> [NativeEventWait] {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = "SELECT snapshot_json FROM native_event_waits ORDER BY created_at, wait_id;"
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(statement) }
        var waits: [NativeEventWait] = []
        let decoder = JSONDecoder()
        while true {
            let result = sqlite3_step(statement)
            if result == SQLITE_DONE { break }
            guard result == SQLITE_ROW else {
                throw DatabaseError.stepFailed(String(cString: sqlite3_errmsg(db)))
            }
            guard let text = sqlite3_column_text(statement, 0) else { continue }
            let data = Data(String(cString: text).utf8)
            do {
                waits.append(try decoder.decode(NativeEventWait.self, from: data))
            } catch {
                throw DatabaseError.executionFailed("Failed to decode a native event wait: \(error.localizedDescription)")
            }
        }
        return waits
    }

    public func deleteNativeEventWait(id: String) throws {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = "DELETE FROM native_event_waits WHERE wait_id = ?1;"
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_text(statement, 1, (id as NSString).utf8String, -1, SQLITE_TRANSIENT)
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(String(cString: sqlite3_errmsg(db)))
        }
    }

    public func claimNativeEventWaitDispatch(_ wait: NativeEventWait) throws -> Bool {
        guard wait.status == .dispatching else { return false }
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        try execute(sql: "BEGIN IMMEDIATE TRANSACTION;")
        do {
            let current = try loadNativeEventWaits().first(where: { $0.id == wait.id })
            guard let current, current.status == .dispatching, current.revision == wait.revision,
                  current.botId == wait.botId, current.threadId == wait.threadId, current.prompt == wait.prompt,
                  current.predicate == wait.predicate, current.revision < UInt64(Int64.max) else {
                try execute(sql: "ROLLBACK;")
                return false
            }
            // The id-only claim ledger outlives bounded visible wait history and is reset only with local app data.
            var claim: OpaquePointer?
            guard sqlite3_prepare_v2(db, "INSERT OR IGNORE INTO native_event_wait_dispatches (wait_id, accepted_at) VALUES (?1, ?2);", -1, &claim, nil) == SQLITE_OK else {
                throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
            }
            defer { sqlite3_finalize(claim) }
            sqlite3_bind_text(claim, 1, (wait.id as NSString).utf8String, -1, SQLITE_TRANSIENT)
            sqlite3_bind_double(claim, 2, Date().timeIntervalSince1970)
            guard sqlite3_step(claim) == SQLITE_DONE else { throw DatabaseError.stepFailed(String(cString: sqlite3_errmsg(db))) }
            guard sqlite3_changes(db) == 1 else {
                try execute(sql: "ROLLBACK;")
                return false
            }
            var accepted = current
            accepted.status = .accepted
            accepted.revision &+= 1
            let encoded = String(decoding: try JSONEncoder().encode(accepted), as: UTF8.self)
            let sql = """
            UPDATE native_event_waits
            SET status = ?1, revision = ?2, snapshot_json = ?3
            WHERE wait_id = ?4 AND status = ?5 AND revision = ?6;
            """
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
                throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
            }
            defer { sqlite3_finalize(statement) }
            sqlite3_bind_text(statement, 1, (accepted.status.rawValue as NSString).utf8String, -1, SQLITE_TRANSIENT)
            sqlite3_bind_int64(statement, 2, Int64(accepted.revision))
            sqlite3_bind_text(statement, 3, (encoded as NSString).utf8String, -1, SQLITE_TRANSIENT)
            sqlite3_bind_text(statement, 4, (wait.id as NSString).utf8String, -1, SQLITE_TRANSIENT)
            sqlite3_bind_text(statement, 5, (wait.status.rawValue as NSString).utf8String, -1, SQLITE_TRANSIENT)
            sqlite3_bind_int64(statement, 6, Int64(wait.revision))
            guard sqlite3_step(statement) == SQLITE_DONE else { throw DatabaseError.stepFailed(String(cString: sqlite3_errmsg(db))) }
            guard sqlite3_changes(db) == 1 else {
                try execute(sql: "ROLLBACK;")
                return false
            }
            try execute(sql: "COMMIT;")
            return true
        } catch {
            try? execute(sql: "ROLLBACK;")
            throw error
        }
    }

    public func replaceNativeEventWaitSnapshot(_ waits: [NativeEventWait]) throws {
        guard waits.count <= 150, Set(waits.map(\.id)).count == waits.count else {
            throw DatabaseError.executionFailed("Native event wait snapshot exceeds the 150 wait storage limit")
        }
        try execute(sql: "BEGIN IMMEDIATE TRANSACTION;")
        do {
            let existing = Dictionary(uniqueKeysWithValues: try loadNativeEventWaits().map { ($0.id, $0) })
            var reconciled: [String: NativeEventWait] = [:]
            let active: [NativeEventWaitStatus] = [.pending, .ready, .dispatching]
            let settled: [NativeEventWaitStatus] = [.held, .completed, .cancelled, .expired]
            let final: [NativeEventWaitStatus] = [.completed, .cancelled, .expired]
            for incoming in waits {
                if let previous = existing[incoming.id] {
                    if incoming.revision < previous.revision ||
                        (active.contains(incoming.status) && (previous.status == .accepted || settled.contains(previous.status))) ||
                        (incoming.revision == previous.revision && final.contains(previous.status) && !final.contains(incoming.status)) {
                        reconciled[incoming.id] = previous
                        continue
                    }
                }
                reconciled[incoming.id] = incoming
            }
            for previous in existing.values where previous.status == .accepted && reconciled[previous.id] == nil {
                reconciled[previous.id] = previous
            }
            guard reconciled.count <= 150 else { throw DatabaseError.executionFailed("Merged native event wait snapshot exceeds the 150 wait storage limit") }
            try execute(sql: "DELETE FROM native_event_waits;")
            for wait in reconciled.values {
                try saveNativeEventWait(wait)
            }
            try execute(sql: "COMMIT;")
        } catch {
            try? execute(sql: "ROLLBACK;")
            throw error
        }
    }

    // MARK: - Webhook Deliveries

    public func recordWebhookDelivery(_ delivery: WebhookDeliveryRecord) throws {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = """
        INSERT OR REPLACE INTO webhook_deliveries (id, webhook_id, bot_id, status_code, delivered_at, payload, response)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, (delivery.id as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, (delivery.webhookId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        if let botId = delivery.botId {
            sqlite3_bind_text(stmt, 3, (botId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(stmt, 3)
        }
        if let code = delivery.statusCode {
            sqlite3_bind_int(stmt, 4, Int32(code))
        } else {
            sqlite3_bind_null(stmt, 4)
        }
        sqlite3_bind_double(stmt, 5, delivery.deliveredAt)
        if let payload = delivery.payload {
            sqlite3_bind_text(stmt, 6, (payload as NSString).utf8String, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(stmt, 6)
        }
        if let response = delivery.response {
            sqlite3_bind_text(stmt, 7, (response as NSString).utf8String, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(stmt, 7)
        }

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(String(cString: sqlite3_errmsg(db)))
        }
    }

    // MARK: - Routine Request Receipts

    /// Records a durable commit receipt for a routine request.
    ///
    /// The receipt is the idempotency key that lets a routine request be
    /// confirmed again after a crash without applying its change twice, so it
    /// is keyed on the request id and replaced when the same request is
    /// recorded again.
    public func recordRoutineRequestReceipt(_ receipt: RoutineRequestReceiptRecord) throws {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = """
        INSERT OR REPLACE INTO routine_request_receipts
            (request_id, message_id, bot_id, thread_id, action, fingerprint_version, fingerprint, result_id, applied_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9);
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, (receipt.requestId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, (receipt.messageId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 3, (receipt.botId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 4, (receipt.threadId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 5, (receipt.action as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int(stmt, 6, Int32(receipt.fingerprintVersion))
        sqlite3_bind_text(stmt, 7, (receipt.fingerprint as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 8, (receipt.resultId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_double(stmt, 9, receipt.appliedAt)

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(String(cString: sqlite3_errmsg(db)))
        }
    }

    /// Every routine-request receipt, oldest first.
    public func loadRoutineRequestReceipts() throws -> [RoutineRequestReceiptRecord] {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = """
        SELECT request_id, message_id, bot_id, thread_id, action, fingerprint_version, fingerprint, result_id, applied_at
        FROM routine_request_receipts
        ORDER BY applied_at ASC, request_id ASC;
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        var receipts: [RoutineRequestReceiptRecord] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            receipts.append(RoutineRequestReceiptRecord(
                requestId: String(cString: sqlite3_column_text(stmt, 0)),
                messageId: String(cString: sqlite3_column_text(stmt, 1)),
                botId: String(cString: sqlite3_column_text(stmt, 2)),
                threadId: String(cString: sqlite3_column_text(stmt, 3)),
                action: String(cString: sqlite3_column_text(stmt, 4)),
                fingerprintVersion: Int(sqlite3_column_int64(stmt, 5)),
                fingerprint: String(cString: sqlite3_column_text(stmt, 6)),
                resultId: String(cString: sqlite3_column_text(stmt, 7)),
                appliedAt: sqlite3_column_double(stmt, 8)
            ))
        }
        return receipts
    }

    /// How many routine-request receipts the store holds.
    public func countRoutineRequestReceipts() throws -> Int {
        try countRows(inTable: "routine_request_receipts")
    }

    public func loadWebhookDeliveries(forWebhook webhookId: String, limit: Int = 50) throws -> [WebhookDeliveryRecord] {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = "SELECT id, webhook_id, bot_id, status_code, delivered_at, payload, response FROM webhook_deliveries WHERE webhook_id = ?1 ORDER BY delivered_at DESC LIMIT ?2;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, (webhookId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int(stmt, 2, Int32(limit))

        var results: [WebhookDeliveryRecord] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = String(cString: sqlite3_column_text(stmt, 0))
            let webhookId = String(cString: sqlite3_column_text(stmt, 1))
            let botId = sqlite3_column_type(stmt, 2) != SQLITE_NULL ? String(cString: sqlite3_column_text(stmt, 2)) : nil
            let statusCode = sqlite3_column_type(stmt, 3) != SQLITE_NULL ? Int(sqlite3_column_int(stmt, 3)) : nil
            let deliveredAt = sqlite3_column_double(stmt, 4)
            let payload = sqlite3_column_type(stmt, 5) != SQLITE_NULL ? String(cString: sqlite3_column_text(stmt, 5)) : nil
            let response = sqlite3_column_type(stmt, 6) != SQLITE_NULL ? String(cString: sqlite3_column_text(stmt, 6)) : nil

            results.append(WebhookDeliveryRecord(
                id: id,
                webhookId: webhookId,
                botId: botId,
                statusCode: statusCode,
                deliveredAt: deliveredAt,
                payload: payload,
                response: response
            ))
        }
        return results
    }

    // MARK: - Bot, Routine & Webhook Definition Tables

    public func upsertBot(_ bot: StoredBotRecord) throws {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = """
        INSERT INTO bots (id, name, thread_id, created_at, raw_json)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            thread_id = excluded.thread_id,
            created_at = excluded.created_at,
            raw_json = excluded.raw_json;
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, (bot.id as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, (bot.name as NSString).utf8String, -1, SQLITE_TRANSIENT)
        if let threadId = bot.threadId {
            sqlite3_bind_text(stmt, 3, (threadId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(stmt, 3)
        }
        sqlite3_bind_double(stmt, 4, bot.createdAt)
        sqlite3_bind_text(stmt, 5, (bot.rawJSON as NSString).utf8String, -1, SQLITE_TRANSIENT)

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(String(cString: sqlite3_errmsg(db)))
        }
    }

    public func loadBots() throws -> [StoredBotRecord] {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = "SELECT id, name, thread_id, created_at, raw_json FROM bots ORDER BY created_at ASC, id ASC;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        var results: [StoredBotRecord] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = String(cString: sqlite3_column_text(stmt, 0))
            let name = String(cString: sqlite3_column_text(stmt, 1))
            let threadId = sqlite3_column_type(stmt, 2) != SQLITE_NULL ? String(cString: sqlite3_column_text(stmt, 2)) : nil
            let createdAt = sqlite3_column_double(stmt, 3)
            let rawJSON = String(cString: sqlite3_column_text(stmt, 4))
            results.append(StoredBotRecord(id: id, name: name, threadId: threadId, createdAt: createdAt, rawJSON: rawJSON))
        }
        return results
    }

    public func upsertRoutine(_ routine: StoredRoutineRecord) throws {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = """
        INSERT INTO routines (id, name, bot_id, schedule, enabled, created_at, updated_at, raw_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            bot_id = excluded.bot_id,
            schedule = excluded.schedule,
            enabled = excluded.enabled,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            raw_json = excluded.raw_json;
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, (routine.id as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, (routine.name as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 3, (routine.botId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 4, (routine.schedule as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int(stmt, 5, routine.enabled ? 1 : 0)
        sqlite3_bind_double(stmt, 6, routine.createdAt)
        sqlite3_bind_double(stmt, 7, routine.updatedAt)
        sqlite3_bind_text(stmt, 8, (routine.rawJSON as NSString).utf8String, -1, SQLITE_TRANSIENT)

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(String(cString: sqlite3_errmsg(db)))
        }
    }

    public func loadRoutines() throws -> [StoredRoutineRecord] {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = "SELECT id, name, bot_id, schedule, enabled, created_at, updated_at, raw_json FROM routines ORDER BY created_at ASC, id ASC;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        var results: [StoredRoutineRecord] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = String(cString: sqlite3_column_text(stmt, 0))
            let name = String(cString: sqlite3_column_text(stmt, 1))
            let botId = String(cString: sqlite3_column_text(stmt, 2))
            let schedule = String(cString: sqlite3_column_text(stmt, 3))
            let enabled = sqlite3_column_int(stmt, 4) != 0
            let createdAt = sqlite3_column_double(stmt, 5)
            let updatedAt = sqlite3_column_double(stmt, 6)
            let rawJSON = String(cString: sqlite3_column_text(stmt, 7))
            results.append(StoredRoutineRecord(
                id: id,
                name: name,
                botId: botId,
                schedule: schedule,
                enabled: enabled,
                createdAt: createdAt,
                updatedAt: updatedAt,
                rawJSON: rawJSON
            ))
        }
        return results
    }

    public func upsertWebhook(_ webhook: StoredWebhookRecord) throws {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = """
        INSERT INTO webhooks (id, endpoint_id, name, bot_id, enabled, created_at, updated_at, raw_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(id) DO UPDATE SET
            endpoint_id = excluded.endpoint_id,
            name = excluded.name,
            bot_id = excluded.bot_id,
            enabled = excluded.enabled,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            raw_json = excluded.raw_json;
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, (webhook.id as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, (webhook.endpointId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 3, (webhook.name as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 4, (webhook.botId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int(stmt, 5, webhook.enabled ? 1 : 0)
        sqlite3_bind_double(stmt, 6, webhook.createdAt)
        sqlite3_bind_double(stmt, 7, webhook.updatedAt)
        sqlite3_bind_text(stmt, 8, (webhook.rawJSON as NSString).utf8String, -1, SQLITE_TRANSIENT)

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(String(cString: sqlite3_errmsg(db)))
        }
    }

    public func loadWebhooks() throws -> [StoredWebhookRecord] {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = "SELECT id, endpoint_id, name, bot_id, enabled, created_at, updated_at, raw_json FROM webhooks ORDER BY created_at ASC, id ASC;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        var results: [StoredWebhookRecord] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = String(cString: sqlite3_column_text(stmt, 0))
            let endpointId = String(cString: sqlite3_column_text(stmt, 1))
            let name = String(cString: sqlite3_column_text(stmt, 2))
            let botId = String(cString: sqlite3_column_text(stmt, 3))
            let enabled = sqlite3_column_int(stmt, 4) != 0
            let createdAt = sqlite3_column_double(stmt, 5)
            let updatedAt = sqlite3_column_double(stmt, 6)
            let rawJSON = String(cString: sqlite3_column_text(stmt, 7))
            results.append(StoredWebhookRecord(
                id: id,
                endpointId: endpointId,
                name: name,
                botId: botId,
                enabled: enabled,
                createdAt: createdAt,
                updatedAt: updatedAt,
                rawJSON: rawJSON
            ))
        }
        return results
    }

    // MARK: - Contract Aliases, Batch Import & Parity Queries

    public func save(_ message: MessageRecord) throws {
        try insertMessage(message)
    }

    public func loadThread(id: String) throws -> ThreadRecord? {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = "SELECT id, title, bot_id, created_at, updated_at FROM threads WHERE id = ?1 LIMIT 1;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, (id as NSString).utf8String, -1, SQLITE_TRANSIENT)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }

        let threadId = String(cString: sqlite3_column_text(stmt, 0))
        let title = String(cString: sqlite3_column_text(stmt, 1))
        let botId = sqlite3_column_type(stmt, 2) != SQLITE_NULL ? String(cString: sqlite3_column_text(stmt, 2)) : nil
        let createdAt = sqlite3_column_double(stmt, 3)
        let updatedAt = sqlite3_column_double(stmt, 4)
        return ThreadRecord(id: threadId, title: title, botId: botId, createdAt: createdAt, updatedAt: updatedAt)
    }

    /// Inserts or updates a batch of messages inside a single transaction.
    /// When `skipIdentical` is true, rows already in `messages` with identical fields
    /// are ignored (`WHERE` guard on `DO UPDATE`) so an idempotent rerun writes 0 rows
    /// and returns `0`.
    @discardableResult
    public func insertMessagesBatch(_ messages: [MessageRecord], skipIdentical: Bool = true) throws -> Int {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        guard !messages.isEmpty else { return 0 }

        try execute(sql: "BEGIN IMMEDIATE TRANSACTION;")
        do {
            let sql = skipIdentical
                ? """
                INSERT INTO messages (id, thread_id, role, kind, content, created_at, model, active_leaf_id, metadata_json)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(id) DO UPDATE SET
                    thread_id = excluded.thread_id,
                    role = excluded.role,
                    kind = excluded.kind,
                    content = excluded.content,
                    created_at = excluded.created_at,
                    model = excluded.model,
                    active_leaf_id = excluded.active_leaf_id,
                    metadata_json = excluded.metadata_json
                WHERE messages.thread_id = excluded.thread_id
                   AND (messages.role IS NOT excluded.role
                   OR messages.kind IS NOT excluded.kind
                   OR messages.content IS NOT excluded.content
                   OR messages.created_at IS NOT excluded.created_at
                   OR messages.model IS NOT excluded.model
                   OR messages.active_leaf_id IS NOT excluded.active_leaf_id
                   OR messages.metadata_json IS NOT excluded.metadata_json);
                """
                : """
                INSERT INTO messages (id, thread_id, role, kind, content, created_at, model, active_leaf_id, metadata_json)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(id) DO UPDATE SET
                    thread_id = excluded.thread_id,
                    role = excluded.role,
                    kind = excluded.kind,
                    content = excluded.content,
                    created_at = excluded.created_at,
                    model = excluded.model,
                    active_leaf_id = excluded.active_leaf_id,
                    metadata_json = excluded.metadata_json
                WHERE messages.thread_id = excluded.thread_id;
                """

            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
                throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
            }
            defer { sqlite3_finalize(stmt) }

            // The ownership probe is prepared once for the whole batch.  A
            // resumed or idempotent import skips every row it already wrote,
            // so one statement per row would double the statement traffic of
            // the import for no reason.
            var ownershipStmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, "SELECT thread_id FROM messages WHERE id = ?1 LIMIT 1;", -1, &ownershipStmt, nil) == SQLITE_OK else {
                throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
            }
            guard let preparedOwnershipStmt = ownershipStmt else {
                throw DatabaseError.prepareFailed("Ownership statement was not prepared")
            }
            defer { sqlite3_finalize(ownershipStmt) }

            var changedCount = 0
            for message in messages {
                sqlite3_reset(stmt)
                sqlite3_clear_bindings(stmt)

                sqlite3_bind_text(stmt, 1, (message.id as NSString).utf8String, -1, SQLITE_TRANSIENT)
                sqlite3_bind_text(stmt, 2, (message.threadId as NSString).utf8String, -1, SQLITE_TRANSIENT)
                sqlite3_bind_text(stmt, 3, (message.role as NSString).utf8String, -1, SQLITE_TRANSIENT)
                sqlite3_bind_text(stmt, 4, (message.kind as NSString).utf8String, -1, SQLITE_TRANSIENT)
                sqlite3_bind_text(stmt, 5, (message.content as NSString).utf8String, -1, SQLITE_TRANSIENT)
                sqlite3_bind_double(stmt, 6, message.createdAt)

                if let model = message.model {
                    sqlite3_bind_text(stmt, 7, (model as NSString).utf8String, -1, SQLITE_TRANSIENT)
                } else {
                    sqlite3_bind_null(stmt, 7)
                }

                if let leaf = message.activeLeafId {
                    sqlite3_bind_text(stmt, 8, (leaf as NSString).utf8String, -1, SQLITE_TRANSIENT)
                } else {
                    sqlite3_bind_null(stmt, 8)
                }

                if let metadata = message.metadataJSON {
                    sqlite3_bind_text(stmt, 9, (metadata as NSString).utf8String, -1, SQLITE_TRANSIENT)
                } else {
                    sqlite3_bind_null(stmt, 9)
                }

                guard sqlite3_step(stmt) == SQLITE_DONE else {
                    throw DatabaseError.stepFailed(String(cString: sqlite3_errmsg(db)))
                }
                let rowChanges = Int(sqlite3_changes(db))
                changedCount += rowChanges
                // A row that changed nothing was either already identical,
                // which is the idempotent skip this batch asked for, or it is
                // owned by another thread, which is refused.
                if rowChanges == 0 {
                    try throwIfOwnedByAnotherThread(message, using: preparedOwnershipStmt)
                }
            }

            try execute(sql: "COMMIT;")
            return changedCount
        } catch {
            try? execute(sql: "ROLLBACK;")
            throw error
        }
    }

    /// Throws when a message id is already owned by a different thread.
    ///
    /// `messages` is keyed on `id` while the legacy Node store keys a message
    /// on `(thread_id, id)`, so the same message id can exist in two threads
    /// in the source.  Writing the second one here would either drop a
    /// message or move it out of the thread that owns it, so it is refused
    /// with the two thread ids named.
    private func throwIfOwnedByAnotherThread(_ message: MessageRecord) throws {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = "SELECT thread_id FROM messages WHERE id = ?1 LIMIT 1;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }
        guard let preparedOwnershipStmt = stmt else {
            throw DatabaseError.prepareFailed("Ownership statement was not prepared")
        }
        try throwIfOwnedByAnotherThread(message, using: preparedOwnershipStmt)
    }

    /// Throws when a message id is already owned by a different thread.
    ///
    /// The probe reuses a statement the caller prepared once, so a batch that
    /// skips thousands of identical rows runs one prepared statement rather
    /// than one per row.
    private func throwIfOwnedByAnotherThread(_ message: MessageRecord, using ownershipStmt: OpaquePointer) throws {
        guard let existingThreadId = try threadIdOwningMessage(id: message.id, using: ownershipStmt),
              existingThreadId != message.threadId else {
            return
        }
        throw DatabaseError.messageThreadConflict(
            id: message.id,
            existingThreadId: existingThreadId,
            incomingThreadId: message.threadId
        )
    }

    /// The thread that currently holds a message id, if any.
    ///
    /// The statement is reused across calls, so it is reset and rebound before
    /// every probe.
    private func threadIdOwningMessage(id: String, using stmt: OpaquePointer) throws -> String? {
        sqlite3_reset(stmt)
        sqlite3_clear_bindings(stmt)
        sqlite3_bind_text(stmt, 1, (id as NSString).utf8String, -1, SQLITE_TRANSIENT)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        guard let cText = sqlite3_column_text(stmt, 0) else { return nil }
        return String(cString: cText)
    }

    /// The store's schema version, which SQLite bumps whenever the schema changes.
    ///
    /// Comparing it across two opens proves that the second open ran no DDL
    /// at all, which is what keeps a healthy store's launch path read-only.
    public func schemaVersion() throws -> Int {
        guard let value = try queryString(sql: "PRAGMA schema_version;") else { return 0 }
        return Int(value) ?? 0
    }

    /// How long the store waits for a lock held by another writer, in
    /// milliseconds.
    ///
    /// The connection sets a busy timeout so a concurrent writer turns an
    /// ordinary open into a wait instead of an immediate SQLITE_BUSY.
    public func busyTimeoutMilliseconds() throws -> Int {
        guard let value = try queryString(sql: "PRAGMA busy_timeout;") else { return 0 }
        return Int(value) ?? 0
    }

    /// The SQL text of every trigger this store carries, sorted by name.
    ///
    /// A test uses it to prove that the FTS triggers exist and carry the
    /// current bodies.
    public func triggerDefinitions() throws -> [String: String] {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = "SELECT name, COALESCE(sql, '') FROM sqlite_master WHERE type = 'trigger' ORDER BY name;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        var definitions: [String: String] = [:]
        while sqlite3_step(stmt) == SQLITE_ROW {
            definitions[String(cString: sqlite3_column_text(stmt, 0))] = String(cString: sqlite3_column_text(stmt, 1))
        }
        return definitions
    }

    public func countRows(inTable table: String) throws -> Int {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let allowedTables: Set<String> = [
            "threads", "messages", "messages_fts",
            "routine_runs", "routine_request_receipts", "webhook_deliveries",
            "native_event_waits", "native_event_wait_dispatches", "bots", "routines", "webhooks"
        ]
        guard allowedTables.contains(table) else {
            throw DatabaseError.executionFailed("Disallowed table name in countRows: \(table)")
        }
        let sql = "SELECT COUNT(*) FROM \(table);"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return 0 }
        return Int(sqlite3_column_int64(stmt, 0))
    }

    public func countOrphanedMessages() throws -> Int {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = """
        SELECT COUNT(*)
        FROM messages m
        LEFT JOIN threads t ON m.thread_id = t.id
        WHERE t.id IS NULL;
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return 0 }
        return Int(sqlite3_column_int64(stmt, 0))
    }

    public func messageCountsByThread() throws -> [String: Int] {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = "SELECT thread_id, COUNT(*) FROM messages GROUP BY thread_id;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        var counts: [String: Int] = [:]
        while sqlite3_step(stmt) == SQLITE_ROW {
            let threadId = String(cString: sqlite3_column_text(stmt, 0))
            let count = Int(sqlite3_column_int64(stmt, 1))
            counts[threadId] = count
        }
        return counts
    }

    public func streamMessageDigestElements(onRow: (String, String, String) -> Void) throws {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let sql = "SELECT thread_id, id, content FROM messages ORDER BY thread_id ASC, id ASC;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError.prepareFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        while sqlite3_step(stmt) == SQLITE_ROW {
            let threadId = String(cString: sqlite3_column_text(stmt, 0))
            let id = String(cString: sqlite3_column_text(stmt, 1))
            let content = String(cString: sqlite3_column_text(stmt, 2))
            onRow(threadId, id, content)
        }
    }

    /// Runs `PRAGMA wal_checkpoint(TRUNCATE)` so the `-wal` file is truncated back to 0 bytes
    /// once concurrent readers close, returning the resulting `-wal` file size in bytes.
    @discardableResult
    public func checkpointWALTruncate() throws -> UInt64 {
        try execute(sql: "PRAGMA wal_checkpoint(TRUNCATE);")
        return try currentWALSizeBytes()
    }

    /// Runs `PRAGMA wal_checkpoint(PASSIVE)` and returns the resulting `-wal`
    /// file size in bytes.
    ///
    /// A passive checkpoint copies the frames into the database without
    /// truncating the write-ahead log, so the returned size is the log's
    /// high-water mark.  A truncating checkpoint empties the file before it
    /// is measured, which is why the performance harness measures the log
    /// this way: the budget is about how much log a write burst produced,
    /// not about how much log is left after a checkpoint.
    @discardableResult
    public func checkpointWALPassive() throws -> UInt64 {
        try execute(sql: "PRAGMA wal_checkpoint(PASSIVE);")
        return try currentWALSizeBytes()
    }

    /// The current size of the `-wal` file in bytes, or 0 when there is none.
    public func currentWALSizeBytes() throws -> UInt64 {
        guard databasePath != ":memory:" else { return 0 }
        let walPath = databasePath + "-wal"
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: walPath),
              let size = attrs[.size] as? NSNumber else {
            return 0
        }
        return size.uint64Value
    }
}
