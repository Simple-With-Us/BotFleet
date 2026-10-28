import Foundation
import SQLite3
import Testing
@testable import CompanionCore

@Suite("Phase 1 StoreImporter, PackageLinkAllowlist & MacPerformanceHarness (BF-2495, BF-2496)")
struct Phase1StoreImporterAndPerfTests {

    // MARK: - Helpers to Build Synthetic ~/.botfleet Fixture

    /// One legacy `messages` row.  `text` is nullable in the real Node schema:
    /// a screen message has no text and its JSON IS the message.
    private struct LegacyRow {
        let threadId: String
        let id: String
        let at: Int64
        let role: String
        let kind: String
        let text: String?
        let json: String
    }

    private func createLegacyDb(
        at path: String,
        rows: [LegacyRow],
        extraColumn: String? = nil,
        threadState: [(threadId: String, activeLeafId: String)] = []
    ) throws {
        var db: OpaquePointer?
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK else {
            throw DatabaseError.openFailed("Failed to create legacy messages.db")
        }
        defer { sqlite3_close(db) }

        let extraColDef = extraColumn.map { ", \($0) TEXT" } ?? ""
        var schema = """
        PRAGMA journal_mode = WAL;
        CREATE TABLE messages (
            thread_id TEXT NOT NULL,
            id TEXT NOT NULL,
            at INTEGER NOT NULL,
            role TEXT NOT NULL,
            kind TEXT NOT NULL,
            text TEXT,
            json TEXT NOT NULL\(extraColDef),
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
        """
        for state in threadState {
            schema += "\nINSERT INTO thread_state (thread_id, active_leaf_id) VALUES ('\(state.threadId)', '\(state.activeLeafId)');"
        }
        guard sqlite3_exec(db, schema, nil, nil, nil) == SQLITE_OK else {
            throw DatabaseError.executionFailed("Failed to initialize legacy schema")
        }

        let sql = "INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?);"
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for row in rows {
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
                throw DatabaseError.prepareFailed("Failed to prepare legacy insert")
            }
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_text(stmt, 1, row.threadId, -1, transient)
            sqlite3_bind_text(stmt, 2, row.id, -1, transient)
            sqlite3_bind_int64(stmt, 3, row.at)
            sqlite3_bind_text(stmt, 4, row.role, -1, transient)
            sqlite3_bind_text(stmt, 5, row.kind, -1, transient)
            if let text = row.text {
                sqlite3_bind_text(stmt, 6, text, -1, transient)
            } else {
                sqlite3_bind_null(stmt, 6)
            }
            sqlite3_bind_text(stmt, 7, row.json, -1, transient)
            guard sqlite3_step(stmt) == SQLITE_DONE else {
                throw DatabaseError.executionFailed("Failed to step legacy insert")
            }
        }
    }

    private func populateSourceFixture(in dir: URL, extraColumn: String? = nil) throws {
        try createLegacyDb(
            at: dir.appendingPathComponent("messages.db").path,
            rows: [
                LegacyRow(threadId: "thread-bot-1", id: "m-1", at: 1_700_000_100_000, role: "user", kind: "text", text: "Hello native Swift store", json: "{\"id\":\"m-1\",\"role\":\"user\",\"kind\":\"text\",\"at\":1700000100000,\"text\":\"Hello native Swift store\"}"),
                LegacyRow(threadId: "thread-bot-1", id: "m-2", at: 1_700_000_200_000, role: "bot", kind: "text", text: "Running native SQLite WAL mode with zero idle CPU.", json: "{\"id\":\"m-2\",\"role\":\"bot\",\"kind\":\"text\",\"at\":1700000200000,\"text\":\"Running native SQLite WAL mode with zero idle CPU.\"}"),
                LegacyRow(threadId: "thread-room-1", id: "m-3", at: 1_700_000_300_000, role: "user", kind: "text", text: "Check room thread import parity", json: "{\"id\":\"m-3\",\"role\":\"user\",\"kind\":\"text\",\"at\":1700000300000,\"text\":\"Check room thread import parity\"}")
            ],
            extraColumn: extraColumn,
            threadState: [(threadId: "thread-bot-1", activeLeafId: "m-2")]
        )

        let botsJson = """
        [
          {
            "id": "bot-1",
            "threadId": "thread-bot-1",
            "name": "Builder",
            "title": "Swift Architect",
            "description": "Builds native macOS targets",
            "notifications": true,
            "color": "blue",
            "unread": false,
            "createdAt": 1700000000000
          }
        ]
        """
        try Data(botsJson.utf8).write(to: dir.appendingPathComponent("bots.json"))

        let groupsJson = """
        [
          {
            "id": "room-1",
            "threadId": "thread-room-1",
            "name": "Architecture Room",
            "memberIds": ["bot-1"],
            "defaultResponder": { "kind": "everyone" },
            "bulletin": "Phase 1 foundation",
            "unread": false,
            "createdAt": 1700000050000
          }
        ]
        """
        try Data(groupsJson.utf8).write(to: dir.appendingPathComponent("groups.json"))

        let routinesJson = """
        {
          "version": 1,
          "routines": [
            {
              "id": "routine-1",
              "name": "Nightly Verification",
              "botId": "bot-1",
              "enabled": true,
              "createdAt": 1700000010000,
              "updatedAt": 1700000020000
            }
          ],
          "runs": [
            {
              "id": "run-1",
              "routineId": "routine-1",
              "botId": "bot-1",
              "status": "completed",
              "scheduledFor": 1700000100000,
              "startedAt": 1700000101000,
              "finishedAt": 1700000105000,
              "createdAt": 1700000100000
            }
          ],
          "botSnoozes": {},
          "routineRequestReceipts": []
        }
        """
        try Data(routinesJson.utf8).write(to: dir.appendingPathComponent("routines.json"))

        let webhooksJson = """
        {
          "version": 1,
          "webhooks": [
            {
              "id": "wh-1",
              "name": "GitHub Push Hook",
              "botId": "bot-1",
              "enabled": true,
              "createdAt": 1700000010000,
              "updatedAt": 1700000020000
            }
          ],
          "deliveries": [],
          "attempts": [
            {
              "id": "deliv-1",
              "webhookId": "wh-1",
              "statusCode": 200,
              "outcome": "completed",
              "receivedAt": 1700000200000,
              "preview": "{\\"ref\\":\\"refs/heads/main\\"}"
            }
          ]
        }
        """
        try Data(webhooksJson.utf8).write(to: dir.appendingPathComponent("webhooks.json"))
    }

    private func makeTempDir(_ label: String) throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("botfleet-\(label)-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    // MARK: - StoreImporter Parity, Idempotency, Resume & Unknown-Column Tests

    @Test("StoreImporter imports ~/.botfleet fixture with 100% row-count and SHA-256 content parity and is idempotent")
    func storeImporterParityAndIdempotency() async throws {
        let tempDir = try makeTempDir("import-test")
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try populateSourceFixture(in: tempDir)

        let targetDbPath = tempDir.appendingPathComponent("native-target.sqlite").path
        let db = try DatabaseService(path: targetDbPath)
        let importer = StoreImporter(batchSize: 2)

        // First import
        let report1 = try await importer.importStore(from: tempDir, into: db)
        #expect(report1.isParityVerified == true)
        #expect(report1.sourceBotCount == 1)
        #expect(report1.targetBotCount == 1)
        #expect(report1.sourceThreadCount == 2)
        #expect(report1.targetThreadCount == 2)
        #expect(report1.sourceMessageCount == 3)
        #expect(report1.targetMessageCount == 3)
        #expect(report1.newlyInsertedMessages == 3)
        #expect(report1.orphanedMessageCount == 0)
        #expect(report1.sourceBodyDigestSHA256 == report1.targetBodyDigestSHA256)
        #expect(report1.sourceRoutineCount == 1)
        #expect(report1.targetRoutineCount == 1)
        #expect(report1.sourceRoutineRunCount == 1)
        #expect(report1.targetRoutineRunCount == 1)
        #expect(report1.sourceWebhookCount == 1)
        #expect(report1.targetWebhookCount == 1)
        #expect(report1.sourceWebhookDeliveryCount == 1)
        #expect(report1.targetWebhookDeliveryCount == 1)

        // Second import (idempotency check: zero new messages inserted, counts and digest unchanged)
        let report2 = try await importer.importStore(from: tempDir, into: db)
        #expect(report2.isParityVerified == true)
        #expect(report2.newlyInsertedMessages == 0)
        #expect(report2.targetMessageCount == 3)
        #expect(report2.sourceBodyDigestSHA256 == report2.targetBodyDigestSHA256)

        // Verify DatabaseService contract aliases save(_:) and loadThread(id:)
        let loadedThread = try await db.loadThread(id: "thread-bot-1")
        #expect(loadedThread?.title == "Builder")
        let loadedMessages = try await db.loadMessages(forThread: "thread-bot-1")
        #expect(loadedMessages.count == 2)
    }

    @Test("StoreImporter resumes cleanly after simulated mid-import crash without duplicate rows")
    func storeImporterCrashResumeRecovery() async throws {
        let tempDir = try makeTempDir("resume-test")
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try populateSourceFixture(in: tempDir)

        let db = try DatabaseService(path: tempDir.appendingPathComponent("resume.sqlite").path)
        let importer = StoreImporter(batchSize: 1)

        // Simulate crash after batch 1
        do {
            _ = try await importer.importStore(from: tempDir, into: db, maxBatchesBeforeInterrupt: 1)
            Issue.record("Expected StoreImportError.interruptedAfterBatch to be thrown")
        } catch let error as StoreImportError {
            #expect(error == .interruptedAfterBatch(completedBatches: 1))
        }

        // Resume import across the full source store
        let report = try await importer.importStore(from: tempDir, into: db)
        #expect(report.isParityVerified == true)
        #expect(report.newlyInsertedMessages == 2)
        #expect(report.targetMessageCount == 3)
        #expect(report.orphanedMessageCount == 0)
        #expect(report.sourceBodyDigestSHA256 == report.targetBodyDigestSHA256)
    }

    @Test("StoreImporter fails loudly when source messages.db or JSON contains unknown columns or keys")
    func storeImporterRejectsUnknownColumnsAndKeys() async throws {
        let tempDir = try makeTempDir("unknown-col-test")
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try populateSourceFixture(in: tempDir, extraColumn: "unexpected_future_column")
        let db = try DatabaseService(path: ":memory:")
        let importer = StoreImporter(batchSize: 10)

        do {
            _ = try await importer.importStore(from: tempDir, into: db)
            Issue.record("Expected StoreImportError.unknownSourceColumns to be thrown")
        } catch let error as StoreImportError {
            if case let .unknownSourceColumns(source, columns) = error {
                #expect(source.contains("messages"))
                #expect(columns == ["unexpected_future_column"])
            } else {
                Issue.record("Unexpected StoreImportError case: \(error)")
            }
        }
    }

    // MARK: - Review Fix 1: the allowlists match the current Node schema

    @Test("StoreImporter accepts every field the current Node schema persists and still fails loudly on a genuinely unknown key")
    func storeImporterAcceptsCurrentNodeSchemaFields() async throws {
        let tempDir = try makeTempDir("schema-fields-test")
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try createLegacyDb(
            at: tempDir.appendingPathComponent("messages.db").path,
            rows: [
                LegacyRow(threadId: "thread-bot-1", id: "m-1", at: 1_700_000_100_000, role: "user", kind: "text", text: "hi", json: "{\"id\":\"m-1\",\"role\":\"user\",\"kind\":\"text\",\"at\":1700000100000,\"text\":\"hi\"}")
            ]
        )

        // Every field `server/store.ts` persists on a bot record today.
        let botsJson = """
        [
          {
            "id": "bot-1",
            "threadId": "thread-bot-1",
            "name": "Builder",
            "title": "Swift Architect",
            "description": "Builds native macOS targets",
            "notifications": true,
            "color": "blue",
            "unread": false,
            "createdAt": 1700000000000,
            "playbooks": [{ "key": "review", "name": "Review", "summary": "s", "triggers": ["t"], "instructions": "i" }],
            "installedPackage": { "id": "pkg-1", "name": "Package", "release": "1.0.0", "requiredApps": [] },
            "connectorTools": { "gmail": { "grants": [] } },
            "voices": { "mac": "voice-1" },
            "mcpServers": ["server-1"],
            "gitWorktreeLeases": true,
            "maxHistoryTurns": 12,
            "historySummaryModel": true,
            "pinnedMessageId": "m-1"
          }
        ]
        """
        try Data(botsJson.utf8).write(to: tempDir.appendingPathComponent("bots.json"))

        // `pinnedMessageId` is persisted on a group record too.
        let groupsJson = """
        [
          {
            "id": "room-1",
            "threadId": "thread-room-1",
            "name": "Architecture Room",
            "memberIds": ["bot-1"],
            "defaultResponder": { "kind": "everyone" },
            "bulletin": "Phase 1 foundation",
            "unread": false,
            "createdAt": 1700000050000,
            "pinnedMessageId": "m-1"
          }
        ]
        """
        try Data(groupsJson.utf8).write(to: tempDir.appendingPathComponent("groups.json"))

        // Every field `server/routines.ts` persists on a routine and a run.
        let routinesJson = """
        {
          "version": 1,
          "routines": [
            {
              "id": "routine-1",
              "name": "Nightly Verification",
              "botId": "bot-1",
              "enabled": true,
              "createdAt": 1700000010000,
              "updatedAt": 1700000020000,
              "oneShotWake": true,
              "scheduleTimeZoneSource": "stored",
              "toolPolicy": { "allow": ["ls"] }
            }
          ],
          "runs": [
            {
              "id": "run-1",
              "routineId": "routine-1",
              "botId": "bot-1",
              "status": "completed",
              "scheduledFor": 1700000100000,
              "startedAt": 1700000101000,
              "finishedAt": 1700000105000,
              "createdAt": 1700000100000,
              "toolPolicy": { "allow": ["ls"] },
              "denials": ["rm -rf /"],
              "holdReason": "bot is off",
              "hotDeferredAt": 1700000102000
            }
          ],
          "botSnoozes": {},
          "routineRequestReceipts": []
        }
        """
        try Data(routinesJson.utf8).write(to: tempDir.appendingPathComponent("routines.json"))

        let webhooksJson = """
        {
          "version": 1,
          "webhooks": [],
          "deliveries": [],
          "attempts": []
        }
        """
        try Data(webhooksJson.utf8).write(to: tempDir.appendingPathComponent("webhooks.json"))

        let db = try DatabaseService(path: tempDir.appendingPathComponent("native.sqlite").path)
        let importer = StoreImporter(batchSize: 10)

        let report = try await importer.importStore(from: tempDir, into: db)
        #expect(report.isParityVerified == true)
        #expect(report.sourceBotCount == 1)
        #expect(report.sourceRoutineCount == 1)
        #expect(report.sourceRoutineRunCount == 1)

        // A genuinely unknown field still fails loudly.
        let drifted = botsJson.replacingOccurrences(of: "\"pinnedMessageId\": \"m-1\"", with: "\"pinnedMessageId\": \"m-1\", \"futureNodeField\": 1")
        try Data(drifted.utf8).write(to: tempDir.appendingPathComponent("bots.json"))

        do {
            _ = try await importer.importStore(from: tempDir, into: db)
            Issue.record("Expected StoreImportError.unknownSourceColumns to be thrown for a genuinely unknown field")
        } catch let error as StoreImportError {
            if case let .unknownSourceColumns(source, columns) = error {
                #expect(source == "bots.json")
                #expect(columns == ["futureNodeField"])
            } else {
                Issue.record("Unexpected StoreImportError case: \(error)")
            }
        }
    }

    // MARK: - Review Fix 2: the durable ledgers are migrated, not dropped

    @Test("StoreImporter migrates the webhook delivery idempotency ledger and the routine request receipts")
    func storeImporterMigratesDurableLedgers() async throws {
        let tempDir = try makeTempDir("ledger-test")
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try populateSourceFixture(in: tempDir)

        // The webhook's endpoint owns the delivery keys, exactly like the Node store.
        let webhooksJson = """
        {
          "version": 1,
          "webhooks": [
            {
              "id": "wh-1",
              "endpointId": "ep-1",
              "name": "GitHub Push Hook",
              "botId": "bot-1",
              "enabled": true,
              "createdAt": 1700000010000,
              "updatedAt": 1700000020000
            }
          ],
          "deliveries": [
            { "key": "ep-1:delivery-1", "runId": "run-1", "at": 1700000300000 }
          ],
          "attempts": [
            {
              "id": "deliv-1",
              "webhookId": "wh-1",
              "statusCode": 200,
              "outcome": "accepted",
              "receivedAt": 1700000200000,
              "preview": "{\\"ref\\":\\"refs/heads/main\\"}"
            }
          ]
        }
        """
        try Data(webhooksJson.utf8).write(to: tempDir.appendingPathComponent("webhooks.json"))

        let routinesJson = """
        {
          "version": 1,
          "routines": [
            {
              "id": "routine-1",
              "name": "Nightly Verification",
              "botId": "bot-1",
              "enabled": true,
              "createdAt": 1700000010000,
              "updatedAt": 1700000020000
            }
          ],
          "runs": [],
          "botSnoozes": { "bot-1": 1700000900000 },
          "routineRequestReceipts": [
            {
              "requestId": "req-1",
              "messageId": "m-2",
              "botId": "bot-1",
              "threadId": "thread-bot-1",
              "action": "run_now",
              "fingerprintVersion": 1,
              "fingerprint": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              "resultId": "run-1",
              "appliedAt": 1700000400000
            }
          ]
        }
        """
        try Data(routinesJson.utf8).write(to: tempDir.appendingPathComponent("routines.json"))

        let db = try DatabaseService(path: tempDir.appendingPathComponent("native.sqlite").path)
        let importer = StoreImporter(batchSize: 10)

        let report = try await importer.importStore(from: tempDir, into: db)

        // The idempotency ledger is migrated, so a redelivered webhook is
        // still a duplicate after the migration.
        #expect(report.sourceWebhookDeliveryLedgerCount == 1)
        #expect(report.targetWebhookDeliveryLedgerCount == 1)
        #expect(report.sourceWebhookDeliveryCount == 2)
        #expect(report.targetWebhookDeliveryCount == 2)
        #expect(report.isParityVerified == true)

        let stored = try await db.loadWebhookDeliveries(forWebhook: "wh-1")
        #expect(stored.contains { $0.id == "ep-1:delivery-1" })
        let ledgerRow = stored.first { $0.id == "ep-1:delivery-1" }
        #expect(ledgerRow?.webhookId == "wh-1")
        #expect(ledgerRow?.botId == "bot-1")
        #expect(ledgerRow?.deliveredAt == 1_700_000_300)

        // The routine request receipts are migrated too, so a re-issued
        // routine card cannot apply the same change twice after the move.
        #expect(report.sourceRoutineRequestReceiptCount == 1)
        #expect(report.targetRoutineRequestReceiptCount == 1)
        #expect(report.routineRequestReceipts.count == 1)
        let receipt = report.routineRequestReceipts.first
        #expect(receipt?.requestId == "req-1")
        #expect(receipt?.resultId == "run-1")
        #expect(receipt?.action == "run_now")
        #expect(receipt?.fingerprintVersion == 1)
        #expect(receipt?.appliedAt == 1_700_000_400)

        // The receipt is in the store, not only in the report.
        let storedReceipts = try await db.loadRoutineRequestReceipts()
        #expect(storedReceipts.count == 1)
        let storedReceipt = storedReceipts.first
        #expect(storedReceipt?.requestId == "req-1")
        #expect(storedReceipt?.messageId == "m-2")
        #expect(storedReceipt?.botId == "bot-1")
        #expect(storedReceipt?.threadId == "thread-bot-1")
        #expect(storedReceipt?.action == "run_now")
        #expect(storedReceipt?.fingerprintVersion == 1)
        #expect(storedReceipt?.fingerprint == "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        #expect(storedReceipt?.resultId == "run-1")
        #expect(storedReceipt?.appliedAt == 1_700_000_400)
        #expect(try await db.countRoutineRequestReceipts() == 1)

        // Nothing was dropped, so there is no receipt gap to report.
        #expect(report.warnings.contains { $0.contains("routine request receipt") } == false)

        // The manual snooze has no native column either, and says so.
        #expect(report.warnings.contains { $0.contains("bot snooze") })
    }

    // MARK: - Review Fix: a cross-thread message id fails the import in the importer's own words

    @Test("The importer names both threads when a message id belongs to two of them")
    func theImporterNamesBothThreadsOnACrossThreadConflict() async throws {
        let tempDir = try makeTempDir("conflict-test")
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try populateSourceFixture(in: tempDir)

        // The legacy store keys a message on `(thread_id, id)`, so the same id
        // can live in two threads there.  The native store keys it on the id
        // alone, so the import has to refuse rather than drop one of them.
        let messagesPath = tempDir.appendingPathComponent("messages.db")
        try? FileManager.default.removeItem(at: messagesPath)
        try createLegacyDb(
            at: messagesPath.path,
            rows: [
                LegacyRow(threadId: "thread-bot-1", id: "m-dup", at: 1_700_000_100_000, role: "user", kind: "text", text: "the same id in one thread", json: "{\"id\":\"m-dup\",\"role\":\"user\",\"kind\":\"text\",\"at\":1700000100000,\"text\":\"the same id in one thread\"}"),
                LegacyRow(threadId: "thread-room-1", id: "m-dup", at: 1_700_000_200_000, role: "user", kind: "text", text: "the same id in another thread", json: "{\"id\":\"m-dup\",\"role\":\"user\",\"kind\":\"text\",\"at\":1700000200000,\"text\":\"the same id in another thread\"}")
            ]
        )

        let db = try DatabaseService(path: tempDir.appendingPathComponent("native.sqlite").path)
        let importer = StoreImporter(batchSize: 10)

        var thrown: StoreImportError?
        do {
            _ = try await importer.importStore(from: tempDir, into: db)
        } catch let error as StoreImportError {
            thrown = error
        } catch {
            Issue.record("Expected a StoreImportError, got \(String(describing: error)).")
        }

        #expect(thrown != nil, "A message id owned by two threads must fail the import with the importer's own error type.")
        if case .messageThreadConflict(let id, let existingThreadId, let incomingThreadId) = thrown {
            #expect(id == "m-dup")
            #expect(existingThreadId == "thread-bot-1")
            #expect(incomingThreadId == "thread-room-1")
        } else {
            Issue.record("Expected a messageThreadConflict error, got \(String(describing: thrown)).")
        }

        // The refused batch left nothing behind.
        let botThread = try await db.loadMessages(forThread: "thread-bot-1")
        #expect(botThread.isEmpty)
    }

    // MARK: - Review Fix 3: active_leaf_id belongs on one message, not all of them

    @Test("StoreImporter stamps active_leaf_id only on the thread's active leaf message")
    func storeImporterStampsActiveLeafOnlyOnTheLeaf() async throws {
        let tempDir = try makeTempDir("active-leaf-test")
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try populateSourceFixture(in: tempDir)

        let db = try DatabaseService(path: tempDir.appendingPathComponent("native.sqlite").path)
        let importer = StoreImporter(batchSize: 1)

        _ = try await importer.importStore(from: tempDir, into: db)

        let loaded = try await db.loadMessages(forThread: "thread-bot-1")
        #expect(loaded.count == 2)
        let byId = Dictionary(uniqueKeysWithValues: loaded.map { ($0.id, $0) })
        // The thread's active leaf is m-2, so only m-2 carries the leaf id.
        #expect(byId["m-2"]?.activeLeafId == "m-2")
        #expect(byId["m-1"]?.activeLeafId == nil)
        // A thread with no active leaf carries none at all.
        let room = try await db.loadMessages(forThread: "thread-room-1")
        #expect(room.allSatisfy { $0.activeLeafId == nil })
    }

    // MARK: - Review Fix 4: the source is read one bounded page at a time

    @Test("StoreImporter pages the source transcript and imports every row exactly once")
    func storeImporterPagesTheSourceTranscript() async throws {
        let tempDir = try makeTempDir("paged-read-test")
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let total = 25
        var rows: [LegacyRow] = []
        for index in 0..<total {
            let thread = index < 15 ? "thread-bot-1" : "thread-bot-2"
            let id = "m-\(index)"
            rows.append(LegacyRow(
                threadId: thread,
                id: id,
                at: 1_700_000_000_000 + Int64(index) * 1_000,
                role: index % 2 == 0 ? "user" : "bot",
                kind: "text",
                text: "message \(index)",
                json: "{\"id\":\"\(id)\",\"role\":\"user\",\"kind\":\"text\",\"at\":1700000000000,\"text\":\"message \(index)\"}"
            ))
        }
        try createLegacyDb(at: tempDir.appendingPathComponent("messages.db").path, rows: rows)

        let botsJson = """
        [
          { "id": "bot-1", "threadId": "thread-bot-1", "name": "Builder", "createdAt": 1700000000000 }
        ]
        """
        try Data(botsJson.utf8).write(to: tempDir.appendingPathComponent("bots.json"))

        // A page size of 2 means the importer reads 13 bounded pages.
        let db = try DatabaseService(path: tempDir.appendingPathComponent("native.sqlite").path)
        let importer = StoreImporter(batchSize: 2)
        let report = try await importer.importStore(from: tempDir, into: db)

        #expect(report.isParityVerified == true)
        #expect(report.sourceMessageCount == total)
        #expect(report.targetMessageCount == total)
        #expect(report.newlyInsertedMessages == total)
        #expect(report.sourceBodyDigestSHA256 == report.targetBodyDigestSHA256)
        #expect(report.perThreadMessageCountsMatch == true)
        #expect(report.orphanedMessageCount == 0)

        // The interrupt hook counts pages, so an interrupted run stops on a
        // page boundary and the resume finishes the rest exactly once.
        let resumedDb = try DatabaseService(path: tempDir.appendingPathComponent("resume.sqlite").path)
        do {
            _ = try await importer.importStore(from: tempDir, into: resumedDb, maxBatchesBeforeInterrupt: 3)
            Issue.record("Expected StoreImportError.interruptedAfterBatch to be thrown")
        } catch let error as StoreImportError {
            #expect(error == .interruptedAfterBatch(completedBatches: 3))
        }
        #expect(try await resumedDb.countRows(inTable: "messages") == 6)

        let resumed = try await importer.importStore(from: tempDir, into: resumedDb)
        #expect(resumed.isParityVerified == true)
        #expect(resumed.newlyInsertedMessages == total - 6)
        #expect(resumed.targetMessageCount == total)
        #expect(resumed.sourceBodyDigestSHA256 == resumed.targetBodyDigestSHA256)
    }

    // MARK: - Review Fix 5: the JSON metadata the native columns cannot carry is preserved

    @Test("StoreImporter preserves the JSON metadata the native columns cannot carry")
    func storeImporterPreservesMessageMetadata() async throws {
        let tempDir = try makeTempDir("metadata-test")
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try createLegacyDb(
            at: tempDir.appendingPathComponent("messages.db").path,
            rows: [
                LegacyRow(
                    threadId: "thread-bot-1",
                    id: "m-1",
                    at: 1_700_000_100_000,
                    role: "user",
                    kind: "text",
                    text: "parented message",
                    json: "{\"id\":\"m-1\",\"role\":\"user\",\"kind\":\"text\",\"at\":1700000100000,\"text\":\"parented message\",\"parentId\":\"m-0\",\"reactions\":[{\"emoji\":\"thumbsup\",\"by\":\"user\"}],\"card\":{\"kind\":\"options\"}}"
                ),
                // A row whose text is NULL keeps its whole JSON as the content,
                // so nothing is dropped from it.
                LegacyRow(
                    threadId: "thread-bot-1",
                    id: "m-2",
                    at: 1_700_000_200_000,
                    role: "bot",
                    kind: "screen",
                    text: nil,
                    json: "{\"id\":\"m-2\",\"role\":\"bot\",\"kind\":\"screen\",\"at\":1700000200000,\"png\":\"AAAA\"}"
                )
            ]
        )

        let botsJson = """
        [
          { "id": "bot-1", "threadId": "thread-bot-1", "name": "Builder", "createdAt": 1700000000000 }
        ]
        """
        try Data(botsJson.utf8).write(to: tempDir.appendingPathComponent("bots.json"))

        let db = try DatabaseService(path: tempDir.appendingPathComponent("native.sqlite").path)
        let importer = StoreImporter(batchSize: 10)
        let report = try await importer.importStore(from: tempDir, into: db)

        #expect(report.isParityVerified == true)
        // The metadata is counted, named, and fingerprinted as preserved.
        #expect(report.sourceMessageMetadataPreservedCount == 1)
        #expect(report.sourceMessageMetadataPreservedFields == ["card", "parentId", "reactions"])
        #expect(report.sourceMessageMetadataPreservedDigestSHA256.isEmpty == false)
        // Nothing was lost, so there is no metadata gap to report.
        #expect(report.sourceMessageMetadataDroppedCount == 0)
        #expect(report.warnings.contains { $0.contains("parentId") } == false)

        // The native row keeps the text, and the screen row keeps its JSON.
        let loaded = try await db.loadMessages(forThread: "thread-bot-1")
        let byId = Dictionary(uniqueKeysWithValues: loaded.map { ($0.id, $0) })
        #expect(byId["m-1"]?.content == "parented message")
        #expect(byId["m-2"]?.content.contains("\"png\"") == true)

        // The metadata itself is in the store, not only counted.
        let metadata = try #require(byId["m-1"]?.metadataJSON)
        #expect(metadata.contains("\"parentId\":\"m-0\""))
        #expect(metadata.contains("\"reactions\""))
        #expect(metadata.contains("\"card\""))
        // A row with nothing to preserve carries no metadata.
        #expect(byId["m-2"]?.metadataJSON == nil)

        // The preserved metadata survives a second import unchanged, so the
        // migration is still idempotent.
        let second = try await importer.importStore(from: tempDir, into: db)
        #expect(second.newlyInsertedMessages == 0)
        #expect(second.sourceMessageMetadataPreservedCount == 1)
        #expect(second.sourceMessageMetadataDroppedCount == 0)
    }

    // MARK: - PackageLinkAllowlist Tests

    @Test("PackageLinkAllowlist enforces strict GitHub HTTPS .md/.json rules matching electron/package-link.mjs")
    func packageLinkAllowlistValidation() {
        // Allowed URLs
        let validBlob = PackageLinkAllowlist.packageUrlFromDeepLink(
            "botfleet://install?url=https%3A%2F%2Fgithub.com%2FSimple-With-Us%2FBotFleet%2Fblob%2Fmain%2FAGENTS.md"
        )
        #expect(validBlob == "https://github.com/Simple-With-Us/BotFleet/blob/main/AGENTS.md")

        let validRaw = PackageLinkAllowlist.packageUrlFromCommandLine([
            "--flag",
            "botfleet://install?url=https%3A%2F%2Fraw.githubusercontent.com%2FSimple-With-Us%2FBotFleet%2Fmain%2Fpackage.json"
        ])
        #expect(validRaw == "https://raw.githubusercontent.com/Simple-With-Us/BotFleet/main/package.json")

        // Rejected URLs
        #expect(PackageLinkAllowlist.packageUrlFromDeepLink("botfleet://install?url=http%3A%2F%2Fgithub.com%2FSimple-With-Us%2FBotFleet%2Fblob%2Fmain%2FREADME.md") == nil)
        #expect(PackageLinkAllowlist.packageUrlFromDeepLink("botfleet://install?url=https%3A%2F%2Fevil.example.com%2FSimple-With-Us%2FBotFleet%2FREADME.md") == nil)
        #expect(PackageLinkAllowlist.packageUrlFromDeepLink("botfleet://install?url=https%3A%2F%2Fuser%3Apass%40github.com%2FSimple-With-Us%2FBotFleet%2FREADME.md") == nil)
        #expect(PackageLinkAllowlist.packageUrlFromDeepLink("botfleet://install?url=https%3A%2F%2Fgithub.com%3A8443%2FSimple-With-Us%2FBotFleet%2FREADME.md") == nil)
        #expect(PackageLinkAllowlist.packageUrlFromDeepLink("botfleet://install?url=https%3A%2F%2Fgithub.com%2FSimple-With-Us%2F..%2Fsecret.md") == nil)
        #expect(PackageLinkAllowlist.packageUrlFromDeepLink("botfleet://install?url=https%3A%2F%2Fgithub.com%2FSimple-With-Us%2FBotFleet%2Fblob%2Fmain%2Fscript.sh") == nil)
    }

    // MARK: - MacPerformanceHarness & Visual Parity Tests (BF-2496)

    @Test("MacPerformanceHarness reports the product budgets and passes every enforced check")
    func macPerformanceHarnessFullSuitePasses() async throws {
        // The harness runs inside the test runner here, so its process
        // footprint and CPU describe the runner rather than the app.  Those
        // metrics are reported and not enforced here; the standalone
        // `MacPerfHarness` executable is where they are enforced.
        let report = try await MacPerformanceHarness.runFullSuite(
            messageCount: 1_000,
            walInsertCount: 10_000,
            // The surface-sync sweep is measured at a smaller transcript here
            // so the suite does not pay for a 50,000-message transcript it
            // does not judge.  The metric is reported and not gated in the
            // test runner, so the shape it runs at changes nothing but the
            // time the suite takes.
            surfaceSyncTranscriptSizes: [1_000, 5_000],
            context: .testRunner
        )
        #expect(report.fts5StemmingVerified == true)
        #expect(report.fts5SupersetOfLikeVerified == true)
        #expect(report.visualParity.allPassed == true)

        // Every enforced metric has to pass.  The product budget is the
        // enforced limit on every host, a shared CI runner included: the
        // harness makes the wall-clock measurements robust instead of
        // relaxing the budget, so a breach is a breach everywhere.
        for metric in report.metrics where metric.enforced {
            #expect(metric.passed == true, "Metric '\(metric.name)' breached budget: \(metric.measuredValue) \(metric.unit) > \(metric.budgetLimit) \(metric.unit)")
        }
        #expect(report.allPassed == true)

        // The product budgets are the P-BF-6 specification.  They are pinned
        // here as literals on purpose.  Deriving the expectation from the
        // constants under test would let anyone widen a budget and keep this
        // gate green, which is the same tautology the visual parity gate had.
        let specBudgets: [String: Double] = [
            "Cold start time": 50.0,
            "Idle memory footprint": 80.0,
            "Idle CPU usage": 0.1,
            "5-bot streaming memory": 150.0,
            "100 tok/s streaming CPU (per bot)": 6.0,
            "CUA 60fps memory drift": 10.0,
            "FTS5 search latency (p95)": 10.0,
            "SQLite WAL size after checkpoint": 64.0,
            "Badge/menubar surface sync": 10.0
        ]
        #expect(MacPerformanceBudget.maxColdStartMs == 50.0)
        #expect(Double(MacPerformanceBudget.maxIdleMemoryBytes) / (1024.0 * 1024.0) == 80.0)
        #expect(MacPerformanceBudget.maxIdleCpuPercent == 0.1)
        #expect(Double(MacPerformanceBudget.maxStreamingMemoryBytes) / (1024.0 * 1024.0) == 150.0)
        #expect(MacPerformanceBudget.maxStreamingCpuPercent == 6.0)
        #expect(Double(MacPerformanceBudget.maxCuaMemoryDriftBytes) / (1024.0 * 1024.0) == 10.0)
        #expect(MacPerformanceBudget.maxFts5P95LatencyMs == 10.0)
        #expect(Double(MacPerformanceBudget.maxWalSizeBytes) / (1024.0 * 1024.0) == 64.0)
        #expect(MacPerformanceBudget.maxSurfaceSyncMs == 10.0)

        // The harness also prints the FTS5 latency including the caller's round
        // trip, and the pooled percentile over every raw sample.  Both are
        // context, not gates, and both carry the same product budget as the
        // latency they sit beside.
        let reportedOnlyNames: Set<String> = [
            "FTS5 search latency incl. caller round trip (p95, reported only)",
            "FTS5 search latency (pooled sample p95, reported only)"
        ]

        for metric in report.metrics {
            #expect(metric.measuredValue.isFinite == true, "Metric '\(metric.name)' produced a non-finite measurement.")
            if let pinned = specBudgets[metric.name] {
                #expect(pinned == metric.specBudgetLimit, "Metric '\(metric.name)' does not carry the P-BF-6 product budget.")
            } else {
                #expect(reportedOnlyNames.contains(metric.name), "Metric '\(metric.name)' is not pinned to a P-BF-6 product budget.")
                #expect(metric.enforced == false, "Metric '\(metric.name)' is reported only and must not gate the suite.")
                #expect(metric.specBudgetLimit == MacPerformanceBudget.maxFts5P95LatencyMs, "Metric '\(metric.name)' does not carry the FTS5 product budget.")
            }
        }
        #expect(report.metrics.count == specBudgets.count + reportedOnlyNames.count)

        // The set of budgets this suite gates on is fixed.  Demoting a metric
        // out of the gate would quietly remove its budget from the
        // specification, so the gated set is asserted by name.
        //
        // The process-scoped budgets (memory and CPU) describe the app, and
        // the wall-clock budgets are durations.  A test run measures the test
        // runner in both cases, because the runner runs its suites in
        // parallel in one process, so a duration measured here describes that
        // contention rather than the app.  Those six budgets are enforced by
        // the standalone `MacPerfHarness` executable, which has the process
        // to itself and which CI runs.  The two byte budgets below are
        // enforced here as well.
        let gatedNames: Set<String> = [
            "CUA 60fps memory drift",
            "SQLite WAL size after checkpoint"
        ]
        #expect(Set(report.metrics.filter { $0.enforced }.map(\.name)) == gatedNames)

        // Every product budget is gated by the standalone executable, and
        // that set is exactly the set of pinned product budgets.  A new
        // budget cannot be added without saying where it is enforced.
        #expect(MacPerformanceHarness.standaloneGatedMetricNames == Set(specBudgets.keys))

        // The budgets the test runner cannot judge are still reported, still
        // carry their product budget, and still say why they are not gated.
        let wallClockNames: Set<String> = [
            "Cold start time",
            "FTS5 search latency (p95)",
            "Badge/menubar surface sync"
        ]
        for metric in report.metrics where wallClockNames.contains(metric.name) {
            #expect(metric.enforced == false)
            #expect(metric.reportNote != nil)
            #expect(metric.specBudgetLimit == specBudgets[metric.name])
        }

        // The summary must not read as a full visual parity pass while the
        // app surface is still pending.
        let summary = report.formattedSummary()
        #expect(summary.contains("[PASS] Visual design contract:"))
        #expect(summary.contains("[PENDING] App visual surface:"))
    }

    @Test("The badge/menubar surface-sync budget still fails a regression, and the tail stays visible")
    func surfaceSyncBudgetStillFailsAndCarriesTheTail() async throws {
        // The badge, the menubar and the sidebar row answer "is anything
        // waiting?" by scanning the thread for a pending card, so the scan is
        // the thing the budget is about.  A rebuild over the budget has to
        // fail, or the gate could not catch the regression it exists for.
        let breach = MacPerformanceHarness.surfaceSyncMetric(measuredMs: 12.0, context: .standalone)
        #expect(breach.passed == false)
        #expect(breach.enforced == true)
        #expect(breach.name == "Badge/menubar surface sync")
        #expect(breach.specBudgetLimit == 10.0)

        let within = MacPerformanceHarness.surfaceSyncMetric(measuredMs: 1.0, context: .standalone)
        #expect(within.passed == true)
        #expect(within.enforced == true)

        // A duration measured inside the test runner describes the runner, so
        // the budget is reported there and enforced by the standalone
        // executable, which is where CI runs it.
        let inTestRunner = MacPerformanceHarness.surfaceSyncMetric(measuredMs: 1.0, context: .testRunner)
        #expect(inTestRunner.enforced == false)
        #expect(inTestRunner.reportNote != nil)
        #expect(inTestRunner.specBudgetLimit == 10.0)

        // The measurement itself has to describe the surfaces rather than a
        // private copy of their logic, so the harness builds a real state and
        // reads the real summaries off it.
        let report = try await MacPerformanceHarness.runFullSuite(
            messageCount: 200,
            walInsertCount: 100,
            surfaceSyncTranscriptSizes: [500],
            surfaceSyncRepeats: 2,
            context: .testRunner
        )
        let surfaceSync = try #require(
            report.metrics.first { $0.name == "Badge/menubar surface sync" },
            "The harness did not report the badge/menubar surface sync metric."
        )
        #expect(surfaceSync.measuredValue.isFinite == true)
        #expect(surfaceSync.measuredValue >= 0)
        #expect(surfaceSync.unit == "ms")
        #expect(surfaceSync.specBudgetLimit == MacPerformanceBudget.maxSurfaceSyncMs)
        // The note carries the whole curve, because a budget that hides the
        // tail is how a linear scan passes a gate and still stalls the app.
        #expect(surfaceSync.reportNote?.contains("500 msgs") == true)
    }

    @Test("The badge/menubar surface-sync sweep refuses an impossible configuration instead of trapping")
    func surfaceSyncSweepRefusesImpossibleConfiguration() async throws {
        // A zero-repeat sweep leaves the sample array empty, so the median
        // index would run off the end of it.  The suite has to reject the
        // configuration it cannot measure, not crash on it.
        await #expect(throws: MacPerformanceHarnessError.invalidSurfaceSyncConfiguration) {
            try await MacPerformanceHarness.runFullSuite(
                messageCount: 50,
                walInsertCount: 50,
                surfaceSyncTranscriptSizes: [200],
                surfaceSyncRepeats: 0,
                context: .testRunner
            )
        }

        // A sweep with no transcript size has nothing to report, and a
        // negative size is not a message count at all.
        await #expect(throws: MacPerformanceHarnessError.missingSurfaceSyncMeasurement) {
            try await MacPerformanceHarness.runFullSuite(
                messageCount: 50,
                walInsertCount: 50,
                surfaceSyncTranscriptSizes: [],
                surfaceSyncRepeats: 2,
                context: .testRunner
            )
        }

        await #expect(throws: MacPerformanceHarnessError.invalidSurfaceSyncConfiguration) {
            try await MacPerformanceHarness.runFullSuite(
                messageCount: 50,
                walInsertCount: 50,
                surfaceSyncTranscriptSizes: [-1],
                surfaceSyncRepeats: 2,
                context: .testRunner
            )
        }
    }

    @Test("The active streaming CPU budget is measured over the streaming second and still catches a regression")
    func streamingCpuBudgetIsMeasuredOverTheStreamingSecond() async throws {
        // The shape the P-BF-6 budget is written against: five bots, one
        // hundred tokens each, at one hundred tokens per second, so one
        // window covers exactly one simulated second of streaming.
        let shape = MacStreamingCpuShape.product
        #expect(shape.botCount == 5)
        #expect(shape.tokensPerBot == 100)
        #expect(shape.tokensPerSecond == 100)
        #expect(shape.repeats == 3)
        #expect(shape.simulatedSeconds == 1.0)

        // The budget's own arithmetic: the CPU a window costs over the
        // simulated second it covers.  A window that costs more than 6% of
        // one core breaches the 6% budget and one that costs less passes,
        // so the budget still fails a regression that makes streaming
        // expensive.
        let atBudget = MacPerformanceHarness.streamingCpuPercent(cpuSeconds: 0.060, simulatedSeconds: 1.0)
        #expect(abs(atBudget - 6.0) < 0.0001)
        #expect(atBudget <= MacPerformanceBudget.maxStreamingCpuPercent)
        let overBudget = MacPerformanceHarness.streamingCpuPercent(cpuSeconds: 0.0601, simulatedSeconds: 1.0)
        #expect(overBudget > MacPerformanceBudget.maxStreamingCpuPercent)
        let underBudget = MacPerformanceHarness.streamingCpuPercent(cpuSeconds: 0.010, simulatedSeconds: 1.0)
        #expect(underBudget < MacPerformanceBudget.maxStreamingCpuPercent)

        // A window that covers no simulated time cannot be converted, and it
        // must not turn into an infinite percentage that passes or fails at
        // random.
        #expect(MacPerformanceHarness.streamingCpuPercent(cpuSeconds: 0.060, simulatedSeconds: 0) == 0)

        // The budget is written for one bot, so a measurement of several bots
        // is divided by the bot count.  Five bots that cost 1.2% of a core
        // each cost six percent in total, and each bot meets the six percent
        // per-bot budget, so the reported number has to be the per-bot cost.
        let fiveBotsAtOnePointTwo = MacPerformanceHarness.streamingCpuPercent(
            cpuSeconds: 0.06,
            simulatedSeconds: 1.0,
            botCount: 5
        )
        #expect(abs(fiveBotsAtOnePointTwo - 1.2) < 0.0001)
        #expect(fiveBotsAtOnePointTwo <= MacPerformanceBudget.maxStreamingCpuPercent)

        // The gate's own verdict.  A window that costs more than 6% of one
        // core over its simulated second fails the budget, and the same
        // metric built from a cheap window passes, so the budget is still
        // able to fail a regression.  The window that breaches it is the
        // per-bot cost multiplied by the bot count, because the metric
        // divides the measured CPU by the bot count.
        let breach = MacPerformanceHarness.streamingCpuMetric(
            cpuSeconds: 0.0601 * Double(shape.botCount),
            shape: shape,
            context: .standalone
        )
        #expect(breach.passed == false)
        #expect(breach.enforced == true)
        #expect(breach.name == "100 tok/s streaming CPU (per bot)")
        #expect(breach.specBudgetLimit == 6.0)
        #expect(abs(breach.measuredValue - 6.01) < 0.0001)
        let within = MacPerformanceHarness.streamingCpuMetric(
            cpuSeconds: 0.010 * Double(shape.botCount),
            shape: shape,
            context: .standalone
        )
        #expect(within.passed == true)
        #expect(within.enforced == true)

        // The measurement itself.  The concurrency pool is warmed before the
        // measured windows, so the one-time cost of starting the process's
        // threads is not charged to streaming, and the reported number is
        // the median of the windows rather than one sample.
        let smallShape = MacStreamingCpuShape(botCount: 2, tokensPerBot: 4, tokensPerSecond: 40, repeats: 2)
        let measurement = try await MacPerformanceHarness.measureStreamingCpu(shape: smallShape)
        #expect(measurement.samples.count == smallShape.repeats)
        #expect(measurement.simulatedSeconds == smallShape.simulatedSeconds)
        #expect(measurement.cpuPercent.isFinite == true)

        // The reported number is the median of the windows, divided by the
        // simulated second and not by the wall clock the host took.  The
        // conversion takes no wall-clock input at all, so a host that
        // finishes the window slowly cannot move the number.  The sample
        // count is even here, so the median is the average of the two middle
        // windows rather than the upper one, which would be the largest
        // sample and would let one noisy window decide the gate.
        let ordered = measurement.samples.sorted()
        let median = (ordered[ordered.count / 2 - 1] + ordered[ordered.count / 2]) / 2.0
        #expect(abs(measurement.medianCpuSeconds - median) < 0.000000001)
        #expect(measurement.medianCpuSeconds >= ordered[ordered.count / 2 - 1] - 0.000000001)
        #expect(measurement.medianCpuSeconds <= ordered[ordered.count / 2] + 0.000000001)
        let expected = MacPerformanceHarness.streamingCpuPercent(
            cpuSeconds: median,
            simulatedSeconds: smallShape.simulatedSeconds,
            botCount: smallShape.botCount
        )
        #expect(abs(measurement.cpuPercent - expected) < 0.000001)
    }

    @Test("The idle CPU metric is the median of several quiet windows, so one noisy window cannot decide the gate")
    func idleCpuMetricIsTheMedianOfSeveralQuietWindows() async throws {
        // The idle CPU budget is a fraction of one percent, so it is a
        // fraction of a millisecond of CPU, and one window on a shared
        // runner decides the verdict by itself.  The metric is the median
        // of several quiet windows, like every other budgeted metric here.
        #expect(MacPerformanceHarness.idleCpuWindowCount >= 3)
        #expect(MacPerformanceHarness.idleCpuWindowNanoseconds == 500_000_000)

        // An even count has no middle sample, so the two middle ones are
        // averaged and the reported number is never the largest sample.
        #expect(MacPerformanceHarness.median(of: [1.0, 2.0]) == 1.5)
        #expect(MacPerformanceHarness.median(of: [1.0, 2.0, 3.0]) == 2.0)
        #expect(MacPerformanceHarness.median(of: []) == 0)

        // One window that caught a scheduler hiccup does not move the
        // median, and a process that burns CPU in every window still does.
        #expect(MacPerformanceHarness.median(of: [0.01, 0.02, 9.0, 0.02, 0.01]) == 0.02)
        #expect(MacPerformanceHarness.median(of: [0.11, 0.11, 0.12, 0.11, 0.11]) == 0.11)

        // The gate's own verdict.  The budget is unchanged, so a process
        // that idles above it still fails, and the metric says how it was
        // produced.
        let noisy = MacPerformanceHarness.idleCpuMetric(
            samples: [0.01, 0.02, 9.0, 0.02, 0.01],
            context: .standalone
        )
        #expect(noisy.name == "Idle CPU usage")
        #expect(noisy.measuredValue == 0.02)
        #expect(noisy.specBudgetLimit == 0.1)
        #expect(noisy.passed == true)
        #expect(noisy.enforced == true)
        #expect(noisy.reportNote?.contains("median") == true)

        let idle = MacPerformanceHarness.idleCpuMetric(
            samples: [0.11, 0.11, 0.12, 0.11, 0.11],
            context: .standalone
        )
        #expect(idle.measuredValue == 0.11)
        #expect(idle.passed == false)
        #expect(idle.enforced == true)

        // The windows are measured back to back, and each one is a share
        // of a core, so every sample is a finite share of a core.
        let samples = try await MacPerformanceHarness.measureIdleCpuSamples(
            windows: 3,
            windowNanoseconds: 20_000_000
        )
        #expect(samples.count == 3)
        #expect(samples.allSatisfy { $0 >= 0 && $0.isFinite })
    }

    @Test("A shape with impossible counts is held at one bot instead of trapping")
    func streamingCpuShapeHoldsImpossibleCounts() async throws {
        // A negative count would build a Range whose lower bound is above its
        // upper bound, and Swift's Range initializer traps on that, so the
        // harness would die instead of producing a measurement.  A count of
        // zero would be worse than a crash, because it would measure nothing
        // and report a clean pass, which is a gate that cannot fail.
        let shape = MacStreamingCpuShape(botCount: -3, tokensPerBot: 0, tokensPerSecond: -1, repeats: 0)
        #expect(shape.botCount == 1)
        #expect(shape.tokensPerBot == 1)
        #expect(shape.tokensPerSecond == 1)
        #expect(shape.repeats == 1)
        #expect(shape.simulatedSeconds == 1.0)

        // The measurement runs on the held shape, so the whole path is safe
        // and a measurement is still produced.
        let measurement = try await MacPerformanceHarness.measureStreamingCpu(shape: shape)
        #expect(measurement.samples.count == 1)
        #expect(measurement.cpuPercent.isFinite == true)
    }

    @Test("The streaming memory delta is measured from the footprint before the warm-up window")
    func streamingCpuMemoryDeltaSpansTheWarmUp() async throws {
        let shape = MacStreamingCpuShape(botCount: 2, tokensPerBot: 4, tokensPerSecond: 40, repeats: 2)
        let measurement = try await MacPerformanceHarness.measureStreamingCpu(shape: shape)

        // The baseline is the footprint from before the warm-up window ran,
        // and the delta runs from that baseline to the footprint after the
        // first measured window.  Measuring from the post-warm-up footprint
        // would report about nothing, and the streaming memory budget could
        // no longer fail however much the streaming load retained.
        #expect(measurement.memoryBaselineBytes > 0)
        #expect(measurement.memoryAfterBytes > 0)
        let expected = measurement.memoryAfterBytes > measurement.memoryBaselineBytes
            ? measurement.memoryAfterBytes - measurement.memoryBaselineBytes
            : 0
        #expect(measurement.memoryDeltaBytes == expected)
    }

    // MARK: - Visual parity against the legacy source and the app (BF-2496)

    /// The repository root, derived from this file's path.
    ///
    /// The test runs with the package directory as its working directory, so
    /// the root cannot be read off the working directory.
    private static func repoRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    /// The Mac app's Swift sources.
    private static func macAppSources(repoRoot: URL) throws -> [String] {
        let directory = repoRoot.appendingPathComponent("ios/MacApp")
        return try FileManager.default
            .contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .map { try String(contentsOf: $0, encoding: .utf8) }
    }

    /// The legacy desktop's mascot vocabulary, read out of the legacy source.
    ///
    /// The group names are keys rather than states.  They are either
    /// unquoted, or quoted with a space or an upper-case letter, so a
    /// lower-case-only pattern matches the states and nothing else.
    private static func legacyMascotStates(in source: String) throws -> [String] {
        guard let start = source.range(of: "STATE_GROUPS"),
              let end = source.range(of: "};", range: start.lowerBound..<source.endIndex) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let block = String(source[start.lowerBound..<end.lowerBound])
        let regex = try NSRegularExpression(pattern: "\"([a-z-]+)\"")
        let nsRange = NSRange(block.startIndex..<block.endIndex, in: block)
        var states: [String] = []
        for match in regex.matches(in: block, range: nsRange) {
            guard let range = Range(match.range(at: 1), in: block) else { continue }
            states.append(String(block[range]))
        }
        return states
    }

    /// The legacy desktop's mascot palette, read out of the legacy source.
    private static func legacyMascotPalette(in source: String) throws -> [String: String] {
        guard let start = source.range(of: "BOT_COLORS"),
              let end = source.range(of: "satisfies Record<BotColor", range: start.lowerBound..<source.endIndex) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let block = String(source[start.lowerBound..<end.lowerBound])
        let regex = try NSRegularExpression(pattern: "([a-z]+):\\s*\"(#[0-9A-Fa-f]{6})\"")
        let nsRange = NSRange(block.startIndex..<block.endIndex, in: block)
        var palette: [String: String] = [:]
        for match in regex.matches(in: block, range: nsRange) {
            guard let nameRange = Range(match.range(at: 1), in: block),
                  let hexRange = Range(match.range(at: 2), in: block) else { continue }
            palette[String(block[nameRange])] = String(block[hexRange])
        }
        return palette
    }

    @Test("The visual design contract carries the legacy mascot vocabulary and palette")
    func visualDesignContractMatchesTheLegacySource() throws {
        let repoRoot = Self.repoRoot()
        let source = try String(
            contentsOf: repoRoot.appendingPathComponent("src/lib/mascot.ts"),
            encoding: .utf8
        )
        let legacyStates = try Self.legacyMascotStates(in: source)
        let legacyPalette = try Self.legacyMascotPalette(in: source)

        #expect(legacyStates.count == 50)
        #expect(legacyPalette.count == 10)

        // The native contract is the legacy vocabulary, verbatim.
        #expect(Set(MacMascotExpression.allCases.map(\.rawValue)) == Set(legacyStates))
        #expect(MacMascotPalette.colors == legacyPalette)

        // The gate's pinned snapshot has to agree with the legacy source as
        // well, so widening the native contract is not a way to pass the gate.
        #expect(MacVisualParityExpectations.mascotExpressions == Set(legacyStates))
        #expect(MacVisualParityExpectations.mascotPalette == legacyPalette)

        // The comparison has to be able to fail.  The contract is checked
        // against the pinned snapshot, so dropping an expression breaks it.
        let drifted = MacMascotExpression.allCases.dropLast()
        #expect(Set(drifted.map(\.rawValue)) != MacVisualParityExpectations.mascotExpressions)
    }

    @Test("The Mac app follows the system theme and its connection states map onto the shared status pills")
    func macAppFollowsTheSystemThemeAndTheSharedStatusPills() throws {
        let repoRoot = Self.repoRoot()
        let sources = try Self.macAppSources(repoRoot: repoRoot)
        #expect(sources.isEmpty == false)

        // The app resolves its colors from the system palette, so it carries
        // no hex colors of its own.
        let hexPattern = try NSRegularExpression(pattern: "#[0-9A-Fa-f]{6}")
        for source in sources {
            let nsRange = NSRange(source.startIndex..<source.endIndex, in: source)
            #expect(
                hexPattern.firstMatch(in: source, range: nsRange) == nil,
                "The Mac app carries a hardcoded hex color; the theme has to follow the system."
            )
        }

        // The system theme is the first-visit default, so the app must not
        // pin an appearance of its own.
        #expect(sources.contains { $0.contains(".preferredColorScheme(") } == false)
        #expect(MacDesignTokens.defaultThemeMode == .system)

        // Every connection state the app can be in has a status pill, and
        // every pill belongs to a connection state.  A new state without a
        // pill decision fails here.
        let sessionSource = try String(
            contentsOf: repoRoot.appendingPathComponent("ios/MacApp/MacSession.swift"),
            encoding: .utf8
        )
        guard let enumStart = sessionSource.range(of: "enum MacConnectionStatus"),
              let enumEnd = sessionSource.range(of: "\n}", range: enumStart.lowerBound..<sessionSource.endIndex) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let enumBody = String(sessionSource[enumStart.lowerBound..<enumEnd.lowerBound])
        let casePattern = try NSRegularExpression(pattern: "case ([a-zA-Z]+)")
        let nsRange = NSRange(enumBody.startIndex..<enumBody.endIndex, in: enumBody)
        var connectionStates: Set<String> = []
        for match in casePattern.matches(in: enumBody, range: nsRange) {
            guard let range = Range(match.range(at: 1), in: enumBody) else { continue }
            connectionStates.insert(String(enumBody[range]))
        }

        #expect(connectionStates == Set(MacConnectionStatusPill.pillByConnectionState.keys))
        #expect(Set(MacConnectionStatusPill.pillByConnectionState.values) == Set(MacStatusPillKind.allCases))
    }

    @Test("The Mac app does not render the mascot or status pill surface yet")
    func macAppVisualSurfaceIsNotImplementedYet() throws {
        let repoRoot = Self.repoRoot()
        let sources = try Self.macAppSources(repoRoot: repoRoot)

        let rendersMascot = sources.contains { $0.contains("MacMascotExpression") }
        let rendersStatusPills = sources.contains { $0.contains("MacStatusPillKind") }
        let appSurfaceVerified = rendersMascot && rendersStatusPills

        // Phase 1 ships the shared design contract; the views that draw it
        // land with the Phase 2 and Phase 3 user interface.  This tripwire
        // fails the moment the app starts rendering the contract, so the
        // visual parity gate has to be updated to verify the app surface and
        // to run the snapshot suite BF-2496 asks for.
        #expect(
            appSurfaceVerified == false,
            "The Mac app renders the mascot or status pill surface now; update the visual parity gate to verify the app surface and to run the snapshot suite."
        )

        // The gate reports the app surface separately from the contract, so a
        // contract pass can never read as an app surface pass.
        let report = MacPerformanceHarness.verifyVisualParity(
            appSurfaceVerified: appSurfaceVerified,
            appSurfaceNote: "the Mac app does not render the mascot or status pill surface yet"
        )
        #expect(report.contractSnapshotVerified == true)
        #expect(report.appSurfaceVerified == false)
        #expect(report.allPassed == true)
    }
}
