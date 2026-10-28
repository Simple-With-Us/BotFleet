import XCTest
@testable import CompanionCore

final class DiagnosticsAndSentryTests: XCTestCase {

    // MARK: - Secret Redaction Tests

    func testCredentialEnvNamesContainsExpectedEntries() {
        XCTAssertTrue(DiagnosticsReporter.credentialEnvNames.contains("XAI_API_KEY"))
        XCTAssertTrue(DiagnosticsReporter.credentialEnvNames.contains("MINIMAX_API_KEY"))
        XCTAssertTrue(DiagnosticsReporter.credentialEnvNames.contains("INFISICAL_CLIENT_SECRET"))
        XCTAssertTrue(DiagnosticsReporter.credentialEnvNames.contains("INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET"))
        XCTAssertEqual(DiagnosticsReporter.credentialEnvNames.count, 27)
    }

    func testRedactsCredentialEnvVarsInText() {
        let secretKey = "xai-" + "1234567890abcdef1234"
        let input = "Server starting with " + "XAI_" + "API_KEY=\(secretKey) and " + "MINIMAX_" + "API_KEY=\"secret-mini-key-value\""
        let redacted = DiagnosticsReporter.redactSecrets(in: input)

        XCTAssertFalse(redacted.contains(secretKey))
        XCTAssertFalse(redacted.contains("secret-mini-key-value"))
        XCTAssertTrue(redacted.contains("XAI_API_KEY=«redacted 24 chars»"))
        XCTAssertTrue(redacted.contains("MINIMAX_API_KEY=«redacted 21 chars»"))
    }

    func testRedactsAuthorizationAndBearerHeaders() {
        let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" + "." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0"
        let input = "GET /api/system/control Authorization: Bearer \(jwt)"
        let redacted = DiagnosticsReporter.redactSecrets(in: input)

        XCTAssertFalse(redacted.contains("Bearer eyJ"))
        XCTAssertTrue(redacted.contains("Authorization=«redacted"))
    }

    func testRedactsPemPrivateKeyBlocks() {
        let input = """
        Loading TLS key:
        -----BEGIN RSA PRIVATE KEY-----
        MIIEowIBAAKCAQEA0Y1+abcdefghijklmnopqrstuvwxyz
        1234567890ABCDEFGH
        -----END RSA PRIVATE KEY-----
        Key loaded successfully.
        """
        let redacted = DiagnosticsReporter.redactSecrets(in: input)

        XCTAssertFalse(redacted.contains("MIIEowIBAAKCAQEA0Y1+abcdefghijklmnopqrstuvwxyz"))
        XCTAssertTrue(redacted.contains("-----BEGIN RSA PRIVATE KEY-----«redacted private key»-----END RSA PRIVATE KEY-----"))
        XCTAssertTrue(redacted.contains("Key loaded successfully."))
    }

    func testRedactsKnownCredentialTokenPrefixes() {
        let tokens = [
            "sk-" + "ant-" + "api03-abcdefghijklmnopqrstuvwxyz123456",
            "xai-" + "12345678901234567890abcdef",
            "gsk_" + "1234567890123456789012345678901234567890",
            "hf_" + "123456789012345678901234567890",
            "ghp_" + "12345678901234567890",
            "github_" + "pat_" + "12345678901234567890",
            "xox" + "b-" + "123456789012-" + "1234567890123",
            "sk_" + "live_" + "12345678",
            "ak_" + "1234567890123456",
            "whsec_" + "12345678",
            "ya29." + "1234",
            "glpat-" + "12345678",
            "A" + "KIA" + "IOSFODNN7EXAMPLE",
            "A" + "Iza" + "SyD-1234567890abcdefghijklmnopqr",
            "npm_" + "12345678901234567890",
        ]

        for token in tokens {
            let text = "Found token: \(token) in response"
            let redacted = DiagnosticsReporter.redactSecrets(in: text)
            XCTAssertFalse(redacted.contains(token), "Failed to redact token \(token)")
            XCTAssertTrue(redacted.contains("«redacted \(token.count) chars»"), "Incorrect mask for token \(token)")
        }
    }

    // MARK: - Config Summary Flattening & Filtering Tests

    func testFlattenAndFilterConfigSummaryPreservesOnlyBoolsAndNumbers() {
        let input: [String: Any] = [
            "server": [
                "harness": [
                    "running": true,
                    "pid": 8799,
                    "secretToken": "super_secret_token_123", // String must be dropped!
                ],
                "activeWorkCount": 0,
            ],
            "client": [
                "autoUpdate": false,
                "tokenList": ["secret1", "secret2"], // Array must be dropped!
            ],
            "user": "Alice", // Top-level string must be dropped!
        ]

        let filtered = DiagnosticsReporter.flattenAndFilterConfigSummary(input)

        XCTAssertEqual(filtered["server.harness.running"], "true")
        XCTAssertEqual(filtered["server.harness.pid"], "8799")
        XCTAssertEqual(filtered["server.activeWorkCount"], "0")
        XCTAssertEqual(filtered["client.autoUpdate"], "false")

        XCTAssertNil(filtered["server.harness.secretToken"])
        XCTAssertNil(filtered["client.tokenList"])
        XCTAssertNil(filtered["user"])
    }

    // MARK: - Log Tail Decoding Tests

    func testDecodeLogTailDropsPartialFirstLineWhenTruncated() {
        let rawLog = "partial first line before newline\nsecond complete line\nthird complete line\n"
        let data = rawLog.data(using: .utf8)!

        let (truncatedTail, bytes1) = DiagnosticsReporter.decodeLogTail(data: data, truncated: true)
        XCTAssertFalse(truncatedTail.contains("partial first line"))
        XCTAssertTrue(truncatedTail.contains("second complete line"))
        XCTAssertTrue(truncatedTail.contains("third complete line"))
        XCTAssertEqual(bytes1, "second complete line\nthird complete line\n".utf8.count)

        let (fullTail, bytes2) = DiagnosticsReporter.decodeLogTail(data: data, truncated: false)
        XCTAssertTrue(fullTail.contains("partial first line"))
        XCTAssertEqual(bytes2, data.count)
    }

    // MARK: - Report Generation & File Export Tests

    func testBuildDiagnosticsReportMatchesFormat() {
        let appInfo = [
            "version": "1.0.30",
            "platform": "macOS",
            "arch": "arm64",
            "osVersion": "15.0",
            "buildCommit": "abcdef123456",
        ]
        let configSummary: [String: Any] = [
            "server": ["ready": true, "port": 8799],
        ]
        let sampleKey = "sk-" + "ant-api03-" + "123456789012345678"
        let logTail = "2026-10-26T00:00:00Z [INFO] Server started with key=\(sampleKey)"

        let report = DiagnosticsReporter.buildDiagnosticsReport(
            appInfo: appInfo,
            configSummary: configSummary,
            logTail: logTail,
            now: Date(timeIntervalSince1970: 1729900800)
        )

        XCTAssertTrue(report.hasPrefix("BotFleet diagnostics"))
        XCTAssertTrue(report.contains("## App"))
        XCTAssertTrue(report.contains("version=1.0.30"))
        XCTAssertTrue(report.contains("platform=macOS"))
        XCTAssertTrue(report.contains("## Configuration"))
        XCTAssertTrue(report.contains("server.ready=true"))
        XCTAssertTrue(report.contains("server.port=8799"))
        XCTAssertTrue(report.contains("## Server log tail — known credential patterns auto-masked"))
        XCTAssertFalse(report.contains("sk-ant-api03-123456789012345678"))
        XCTAssertTrue(report.contains("key=«redacted 31 chars»"))
    }

    func testExportDiagnosticsEnforces0600FilePermissions() throws {
        let tempDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let fileURL = tempDir.appendingPathComponent(DiagnosticsReporter.diagnosticsFileName())

        try DiagnosticsReporter.exportDiagnostics(
            to: fileURL,
            appInfo: ["version": "1.0.0"],
            configSummary: ["ready": true],
            logTail: "Test log line"
        )

        XCTAssertTrue(FileManager.default.fileExists(atPath: fileURL.path))
        let attributes = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        let posixPermissions = (attributes[.posixPermissions] as? NSNumber)?.intValue
        XCTAssertEqual(posixPermissions, 0o600)
    }

    // MARK: - MacSentryPolicy Tests

    func testReleaseShaResolutionPriority() {
        let envWithRelease = ["SENTRY_RELEASE": "724425968dcc", "GITHUB_SHA": "abcdef1234567890"]
        XCTAssertEqual(MacSentryPolicy.resolveReleaseSHA(env: envWithRelease), "724425968dcc")

        let envWithGithubSha = ["GITHUB_SHA": "abcdef1234567890"]
        XCTAssertEqual(MacSentryPolicy.resolveReleaseSHA(env: envWithGithubSha), "abcdef1234567890")

        let envWithBundle = [String: String]()
        XCTAssertEqual(MacSentryPolicy.resolveReleaseSHA(env: envWithBundle, bundleCommit: "fedcba0987654321"), "fedcba0987654321")

        XCTAssertNil(MacSentryPolicy.resolveReleaseSHA(env: ["GITHUB_SHA": "not_a_sha"]))
    }

    func testRedactQueryStringTokens() {
        let rawURL = "https://botfleet.app/api/stream?botId=b1&token=secret_token_val&key=xyz123&keepalive=true"
        let redacted = MacSentryPolicy.redactQueryStringTokens(in: rawURL)

        XCTAssertFalse(redacted.contains("secret_token_val"))
        XCTAssertFalse(redacted.contains("xyz123"))
        XCTAssertTrue(redacted.contains("token=[redacted]"))
        XCTAssertTrue(redacted.contains("key=[redacted]"))
        XCTAssertTrue(redacted.contains("botId=b1"))
        XCTAssertTrue(redacted.contains("keepalive=true"))
    }

    func testScrubRequestStripsHeadersAndSanitizesURL() {
        let url = URL(string: "https://botfleet.app/api/system?secret=abc12345")!
        let headers = ["Authorization": "Bearer sensitive_token", "X-Custom": "value"]

        let (sanitizedURL, scrubbedHeaders) = MacSentryPolicy.scrubRequest(url: url, headers: headers)

        XCTAssertEqual(scrubbedHeaders, [:])
        XCTAssertEqual(sanitizedURL?.absoluteString, "https://botfleet.app/api/system?secret=%5Bredacted%5D")
    }

    func testShouldActivateSentryHonorsEnvAndFormat() {
        XCTAssertFalse(MacSentryPolicy.shouldActivateSentry(dsn: "https://example.com/123", env: ["VITEST": "true"]))
        XCTAssertFalse(MacSentryPolicy.shouldActivateSentry(dsn: "https://example.com/123", env: ["NODE_ENV": "test"]))
        XCTAssertFalse(MacSentryPolicy.shouldActivateSentry(dsn: "", env: [:]))
        XCTAssertFalse(MacSentryPolicy.shouldActivateSentry(dsn: "http://insecure.com/123", env: [:]))
        XCTAssertTrue(MacSentryPolicy.shouldActivateSentry(dsn: "https://key@o1.ingest.sentry.io/123", env: [:]))
    }
}
