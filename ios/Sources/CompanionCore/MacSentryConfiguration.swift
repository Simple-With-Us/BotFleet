import Foundation

/// Sentry telemetry configuration and scrubbing policy for the native macOS desktop application.
///
/// Implements the exact security and scrubbing contract of Electron's `initDesktopSentry` (main.mjs lines 104-185):
/// 1. Release SHA resolution from environment candidates (`SENTRY_RELEASE`, `GITHUB_SHA`, `VERCEL_GIT_COMMIT_SHA`)
///    and packaged build identity (`SOURCE_COMMIT`).
/// 2. Restrictive data collection policy: default PII disabled, zero screenshots, zero view hierarchies,
///    masked text and images for session replay.
/// 3. Request scrubbing in `beforeSend`: all request headers stripped to `[:]`, and query strings redacted.
/// 4. Breadcrumb scrubbing in `beforeBreadcrumb`: all sensitive token parameters masked.
public enum MacSentryPolicy {

    public static let releaseShaRegex = try! NSRegularExpression(pattern: #"^[0-9a-f]{7,40}$"#, options: [.caseInsensitive])

    public static let sensitiveQueryParamRegex = try! NSRegularExpression(
        // Match the full parameter name containing a sensitive keyword (api_key, access_token, …).
        pattern: #"([?&])([^=?&#\s]*(?:token|key|secret|authorization|auth|password)[^=?&#\s]*)=[^&#\s]*"#,
        options: [.caseInsensitive]
    )

    /// Resolves the canonical release SHA from environment or bundle metadata.
    public static func resolveReleaseSHA(
        env: [String: String] = ProcessInfo.processInfo.environment,
        bundleCommit: String? = nil
    ) -> String? {
        var candidates: [String] = []

        for key in ["SENTRY_RELEASE", "GITHUB_SHA", "VERCEL_GIT_COMMIT_SHA"] {
            if let val = env[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !val.isEmpty {
                candidates.append(val)
            }
        }

        if let commit = bundleCommit?.trimmingCharacters(in: .whitespacesAndNewlines), !commit.isEmpty {
            candidates.append(commit)
        }

        let unknownCommit = String(repeating: "0", count: 40)
        for candidate in candidates {
            if candidate != "unknown", candidate != unknownCommit, isValidReleaseSha(candidate) {
                return candidate
            }
        }

        return nil
    }

    /// Verifies if a given string is a valid git commit SHA (7 to 40 hex characters).
    public static func isValidReleaseSha(_ sha: String) -> Bool {
        let range = NSRange(sha.startIndex..<sha.endIndex, in: sha)
        return releaseShaRegex.firstMatch(in: sha, options: [], range: range) != nil
    }

    /// Redacts sensitive query string tokens (token, key, secret, auth, authorization, password) in URLs.
    public static func redactQueryStringTokens(in urlString: String) -> String {
        guard !urlString.isEmpty else { return urlString }
        var out = urlString
        let range = NSRange(out.startIndex..<out.endIndex, in: out)
        let matches = sensitiveQueryParamRegex.matches(in: out, options: [], range: range).reversed()

        for match in matches {
            guard let leadRange = Range(match.range(at: 1), in: out),
                  let nameRange = Range(match.range(at: 2), in: out),
                  let fullRange = Range(match.range, in: out) else { continue }
            let lead = String(out[leadRange])
            let name = String(out[nameRange])
            out.replaceSubrange(fullRange, with: "\(lead)\(name)=[redacted]")
        }

        return out
    }

    /// Scrubs desktop request information before dispatching to Sentry.
    ///
    /// Headers are completely cleared to prevent credential or auth token transmission.
    /// URL query parameters are thoroughly redacted.
    public static func scrubRequest(
        url: URL?,
        headers: [String: String]?
    ) -> (sanitizedURL: URL?, scrubbedHeaders: [String: String]) {
        let scrubbedHeaders: [String: String] = [:]
        guard let url = url else {
            return (sanitizedURL: nil, scrubbedHeaders: scrubbedHeaders)
        }

        let redacted = redactQueryStringTokens(in: url.absoluteString)
        let sanitizedURL = URL(string: redacted)
        return (sanitizedURL: sanitizedURL, scrubbedHeaders: scrubbedHeaders)
    }

    /// Scrubs breadcrumb URL strings before recording.
    public static func scrubBreadcrumbURL(_ url: String?) -> String? {
        guard let url = url, !url.isEmpty else { return url }
        return redactQueryStringTokens(in: url)
    }

    /// Evaluates if desktop Sentry telemetry should activate based on DSN presence and test execution flags.
    public static func shouldActivateSentry(
        dsn: String?,
        env: [String: String] = ProcessInfo.processInfo.environment
    ) -> Bool {
        if env["VITEST"] == "true" || env["NODE_ENV"] == "test" || env["XCTestConfigurationFilePath"] != nil {
            return false
        }
        guard let dsn = dsn?.trimmingCharacters(in: .whitespacesAndNewlines), !dsn.isEmpty else {
            return false
        }
        return dsn.hasPrefix("https://")
    }

    /// Assembles the desktop options contract when Sentry may activate, or
    /// returns nil when it must stay inert (no DSN, a non-HTTPS DSN, or a
    /// test runner).  The Mac app starter feeds the result straight into the
    /// Sentry SDK, so this assembly is the testable half of the wiring:  the
    /// activation gate and the release stamp are decided here, not in the
    /// app target.
    public static func desktopOptions(
        dsn: String?,
        env: [String: String] = ProcessInfo.processInfo.environment,
        bundleCommit: String? = nil
    ) -> DesktopSentryOptions? {
        guard shouldActivateSentry(dsn: dsn, env: env),
              let dsn = dsn?.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return nil
        }
        return DesktopSentryOptions(
            dsn: dsn,
            release: resolveReleaseSHA(env: env, bundleCommit: bundleCommit)
        )
    }

    /// Captures the standard restrictive Sentry options contract for the native macOS desktop app.
    public struct DesktopSentryOptions: Equatable, Sendable {
        public let dsn: String
        public let environment: String
        public let release: String?
        public let sendDefaultPii: Bool
        public let attachScreenshot: Bool
        public let attachViewHierarchy: Bool
        public let sessionReplayMaskAllText: Bool
        public let sessionReplayMaskAllImages: Bool

        public init(
            dsn: String,
            environment: String = "production",
            release: String? = nil,
            sendDefaultPii: Bool = false,
            attachScreenshot: Bool = false,
            attachViewHierarchy: Bool = false,
            sessionReplayMaskAllText: Bool = true,
            sessionReplayMaskAllImages: Bool = true
        ) {
            self.dsn = dsn
            self.environment = environment
            self.release = release
            self.sendDefaultPii = sendDefaultPii
            self.attachScreenshot = attachScreenshot
            self.attachViewHierarchy = attachViewHierarchy
            self.sessionReplayMaskAllText = sessionReplayMaskAllText
            self.sessionReplayMaskAllImages = sessionReplayMaskAllImages
        }
    }
}
