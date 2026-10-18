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

    public init(
        id: String,
        threadId: String,
        role: String,
        kind: String = "text",
        content: String,
        createdAt: Double = Date().timeIntervalSince1970,
        model: String? = nil,
        activeLeafId: String? = nil
    ) {
        self.id = id
        self.threadId = threadId
        self.role = role
        self.kind = kind
        self.content = content
        self.createdAt = createdAt
        self.model = model
        self.activeLeafId = activeLeafId
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

public enum DatabaseError: LocalizedError, Equatable {
    case openFailed(String)
    case executionFailed(String)
    case prepareFailed(String)
    case stepFailed(String)
    case notFound

    public var errorDescription: String? {
        switch self {
        case .openFailed(let msg): return "Failed to open SQLite database: \(msg)"
        case .executionFailed(let msg): return "SQLite execution failed: \(msg)"
        case .prepareFailed(let msg): return "SQLite statement prepare failed: \(msg)"
        case .stepFailed(let msg): return "SQLite step failed: \(msg)"
        case .notFound: return "Requested record not found in database"
        }
    }
}

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// Native Swift SQLite persistence engine with WAL mode and FTS5 full-text search.
/// Replaces flat JSON transcript parsing and fsyncSync file rewrites with sub-millisecond
/// transactional reads, concurrent background writes, and instant snippet search.
public actor DatabaseService {
    private var db: OpaquePointer?

    public init(path: String? = nil) throws {
        let dbPath = path ?? ":memory:"
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

        try execute(sql: "PRAGMA journal_mode = WAL;")
        try execute(sql: "PRAGMA synchronous = NORMAL;")
        try execute(sql: "PRAGMA foreign_keys = ON;")

        try createSchema()
    }

    deinit {
        if let db = db {
            sqlite3_close(db)
        }
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

    private func createSchema() throws {
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

        CREATE INDEX IF NOT EXISTS idx_messages_thread_created ON messages(thread_id, created_at);

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
        """
        try execute(sql: schema)
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
        INSERT OR REPLACE INTO messages (id, thread_id, role, kind, content, created_at, model, active_leaf_id)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8);
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

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw DatabaseError.stepFailed(String(cString: sqlite3_errmsg(db)))
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
            ? "SELECT id, thread_id, role, kind, content, created_at, model, active_leaf_id FROM messages WHERE thread_id = ?1 ORDER BY created_at ASC LIMIT ?2;"
            : "SELECT id, thread_id, role, kind, content, created_at, model, active_leaf_id FROM messages WHERE thread_id = ?1 AND created_at < ?3 ORDER BY created_at ASC LIMIT ?2;"

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

            results.append(MessageRecord(
                id: id,
                threadId: threadId,
                role: role,
                kind: kind,
                content: content,
                createdAt: createdAt,
                model: model,
                activeLeafId: activeLeafId
            ))
        }
        return results
    }

    // MARK: - Full-Text Search (FTS5)

    /// Full-text search across transcripts using SQLite3 FTS5 with BM25 ranking and highlighted snippets.
    public func search(query: String, inThread threadId: String? = nil, limit: Int = 50) throws -> [DatabaseSearchResult] {
        guard let db = db else { throw DatabaseError.openFailed("Database connection closed") }
        let cleanQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanQuery.isEmpty else { return [] }

        // Sanitize query tokens for FTS5 syntax
        let formattedQuery = cleanQuery
            .components(separatedBy: .whitespaces)
            .filter { !$0.isEmpty }
            .map { "\"\($0.replacingOccurrences(of: "\"", with: "\"\""))\"*" }
            .joined(separator: " ")

        let sql = threadId == nil
            ? """
            SELECT m.id, m.thread_id, snippet(messages_fts, 0, '<b>', '</b>', '…', 32), m.content, m.created_at
            FROM messages_fts fts
            JOIN messages m ON fts.message_id = m.id
            WHERE messages_fts MATCH ?1
            ORDER BY bm25(messages_fts)
            LIMIT ?2;
            """
            : """
            SELECT m.id, m.thread_id, snippet(messages_fts, 0, '<b>', '</b>', '…', 32), m.content, m.created_at
            FROM messages_fts fts
            JOIN messages m ON fts.message_id = m.id
            WHERE messages_fts MATCH ?1 AND fts.thread_id = ?3
            ORDER BY bm25(messages_fts)
            LIMIT ?2;
            """

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
        return results
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
}
