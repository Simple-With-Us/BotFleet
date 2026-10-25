import Foundation
import SQLite3
import Testing
@testable import CompanionCore

@Suite("Phase 1 StoreImporter, PackageLinkAllowlist & MacPerformanceHarness (BF-2495, BF-2496)")
struct Phase1StoreImporterAndPerfTests {

    // MARK: - Helpers to Build Synthetic ~/.botfleet Fixture

    private func createLegacyMessagesDb(at path: String, extraColumn: String? = nil) throws {
        var db: OpaquePointer?
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK else {
            throw DatabaseError.openFailed("Failed to create legacy messages.db")
        }
        defer { sqlite3_close(db) }

        let extraColDef = extraColumn.map { ", \($0) TEXT" } ?? ""
        let schema = """
        PRAGMA journal_mode = WAL;
        CREATE TABLE messages (
            thread_id TEXT NOT NULL,
            id TEXT NOT NULL,
            at INTEGER NOT NULL,
            role TEXT NOT NULL,
            kind TEXT NOT NULL,
            text TEXT NOT NULL,
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
        guard sqlite3_exec(db, schema, nil, nil, nil) == SQLITE_OK else {
            throw DatabaseError.executionFailed("Failed to initialize legacy schema")
        }

        let rows: [(String, String, Int64, String, String, String, String)] = [
            ("thread-bot-1", "m-1", 1_700_000_100_000, "user", "text", "Hello native Swift store", "{\"id\":\"m-1\",\"role\":\"user\",\"kind\":\"text\",\"at\":1700000100000,\"text\":\"Hello native Swift store\"}"),
            ("thread-bot-1", "m-2", 1_700_000_200_000, "bot", "text", "Running native SQLite WAL mode with zero idle CPU.", "{\"id\":\"m-2\",\"role\":\"bot\",\"kind\":\"text\",\"at\":1700000200000,\"text\":\"Running native SQLite WAL mode with zero idle CPU.\"}"),
            ("thread-room-1", "m-3", 1_700_000_300_000, "user", "text", "Check room thread import parity", "{\"id\":\"m-3\",\"role\":\"user\",\"kind\":\"text\",\"at\":1700000300000,\"text\":\"Check room thread import parity\"}")
        ]

        let sql = "INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?);"
        let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for row in rows {
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
                throw DatabaseError.prepareFailed("Failed to prepare legacy insert")
            }
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_text(stmt, 1, row.0, -1, SQLITE_TRANSIENT)
            sqlite3_bind_text(stmt, 2, row.1, -1, SQLITE_TRANSIENT)
            sqlite3_bind_int64(stmt, 3, row.2)
            sqlite3_bind_text(stmt, 4, row.3, -1, SQLITE_TRANSIENT)
            sqlite3_bind_text(stmt, 5, row.4, -1, SQLITE_TRANSIENT)
            sqlite3_bind_text(stmt, 6, row.5, -1, SQLITE_TRANSIENT)
            sqlite3_bind_text(stmt, 7, row.6, -1, SQLITE_TRANSIENT)
            guard sqlite3_step(stmt) == SQLITE_DONE else {
                throw DatabaseError.executionFailed("Failed to step legacy insert")
            }
        }
    }

    private func populateSourceFixture(in dir: URL, extraColumn: String? = nil) throws {
        try createLegacyMessagesDb(
            at: dir.appendingPathComponent("messages.db").path,
            extraColumn: extraColumn
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
          "routineRequestReceipts": {}
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

    // MARK: - StoreImporter Parity, Idempotency, Resume & Unknown-Column Tests

    @Test("StoreImporter imports ~/.botfleet fixture with 100% row-count and SHA-256 content parity and is idempotent")
    func storeImporterParityAndIdempotency() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("botfleet-import-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
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
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("botfleet-resume-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
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
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("botfleet-unknown-col-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
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
            context: .testRunner
        )
        #expect(report.fts5StemmingVerified == true)
        #expect(report.fts5SupersetOfLikeVerified == true)
        #expect(report.visualParity.allPassed == true)

        // Every enforced metric has to pass.  The wall-clock budgets are
        // measured on a shared runner, so CI applies a documented tolerance to
        // them; the product budget is asserted separately below, so nobody can
        // widen the specification to turn this gate green.
        for metric in report.metrics where metric.enforced {
            #expect(metric.passed == true, "Metric '\(metric.name)' breached budget: \(metric.measuredValue) \(metric.unit) > \(metric.budgetLimit) \(metric.unit)")
        }
        #expect(report.allPassed == true)

        // The product budgets are the P-BF-6 specification and must not drift.
        let specBudgets: [String: Double] = [
            "Cold start time": MacPerformanceBudget.maxColdStartMs,
            "Idle memory footprint": Double(MacPerformanceBudget.maxIdleMemoryBytes) / (1024.0 * 1024.0),
            "Idle CPU usage": MacPerformanceBudget.maxIdleCpuPercent,
            "5-bot streaming memory": Double(MacPerformanceBudget.maxStreamingMemoryBytes) / (1024.0 * 1024.0),
            "100 tok/s streaming CPU": MacPerformanceBudget.maxStreamingCpuPercent,
            "CUA 60fps memory drift": Double(MacPerformanceBudget.maxCuaMemoryDriftBytes) / (1024.0 * 1024.0),
            "FTS5 search latency (p95)": MacPerformanceBudget.maxFts5P95LatencyMs,
            "SQLite WAL size after checkpoint": Double(MacPerformanceBudget.maxWalSizeBytes) / (1024.0 * 1024.0)
        ]

        // The harness also prints the FTS5 latency including the caller's round
        // trip.  It is context, not a gate, and it carries the same product
        // budget as the latency it sits beside.
        let reportedOnlyNames: Set<String> = [
            "FTS5 search latency incl. caller round trip (p95, reported only)"
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
        // The process-scoped budgets (memory and CPU) describe the app, and a
        // test run measures the test runner instead, so they are enforced by
        // the standalone `MacPerfHarness` executable rather than here.
        let gatedNames: Set<String> = [
            "Cold start time",
            "CUA 60fps memory drift",
            "FTS5 search latency (p95)",
            "SQLite WAL size after checkpoint"
        ]
        #expect(Set(report.metrics.filter { $0.enforced }.map(\.name)) == gatedNames)
    }
}
