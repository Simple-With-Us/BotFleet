import Foundation

/// Errors emitted by `PluginSandboxHost` when validating plugin roots or identifiers.
public enum PluginSandboxError: LocalizedError, Equatable, Sendable {
    case invalidPluginId(String)
    case sandboxRootInvalid
    case unsafePath(String)

    public var errorDescription: String? {
        switch self {
        case .invalidPluginId(let id):
            return "Invalid plugin identifier '\(id)'."
        case .sandboxRootInvalid:
            return "Plugin sandbox root must be an absolute non-root file URL."
        case .unsafePath(let detail):
            return "Refused unsafe plugin sandbox path: \(detail)"
        }
    }
}

/// Sandbox confinement and child-environment allowlist policy for native plugins (`BF-2620`).
public struct PluginSandboxPolicy: Equatable, Sendable {
    public let sandboxRoot: URL
    public let allowedEnvKeys: Set<String>

    public init(
        sandboxRoot: URL,
        allowedEnvKeys: Set<String> = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]
    ) {
        self.sandboxRoot = sandboxRoot
        self.allowedEnvKeys = allowedEnvKeys
    }
}

/// Confines plugin workspaces under a private sandbox root and scrubs credential
/// environment variables before spawning plugin child processes (`BF-2620`).
public actor PluginSandboxHost {
    public let policy: PluginSandboxPolicy

    private static let forbiddenCredentialKeysUpper: Set<String> = {
        var keys = Set(DiagnosticsReporter.credentialEnvNames.map { $0.uppercased() })
        keys.formUnion([
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "GEMINI_API_KEY",
            "GITHUB_TOKEN",
            "GH_TOKEN",
            "INFISICAL_PROJECT_ID",
            "BOTFLEET_BEARER_TOKEN",
        ])
        return keys
    }()

    public init(policy: PluginSandboxPolicy) {
        self.policy = policy
    }

    /// Resolves and optionally creates `<sandboxRoot>/<pluginId>`, rejecting traversal
    /// and symlink escapes outside the canonicalized sandbox root.
    public func pluginDirectory(for pluginId: String, create: Bool = true) throws -> URL {
        guard Self.isValidPluginId(pluginId) else {
            throw PluginSandboxError.invalidPluginId(pluginId)
        }
        let rootURL = policy.sandboxRoot
        guard rootURL.isFileURL,
              rootURL.path.hasPrefix("/"),
              rootURL.path != "/",
              !rootURL.path.contains("\0") else {
            throw PluginSandboxError.sandboxRootInvalid
        }
        if create {
            try FileManager.default.createDirectory(
                at: rootURL,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        }
        let resolvedRoot = rootURL.standardizedFileURL.resolvingSymlinksInPath()
        guard resolvedRoot.path.hasPrefix("/"), resolvedRoot.path != "/" else {
            throw PluginSandboxError.sandboxRootInvalid
        }
        let candidate = resolvedRoot.appendingPathComponent(pluginId, isDirectory: true)
        if create {
            try FileManager.default.createDirectory(
                at: candidate,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        }
        let resolvedCandidate = candidate.standardizedFileURL.resolvingSymlinksInPath()
        guard resolvedCandidate.path.hasPrefix(resolvedRoot.path + "/") else {
            throw PluginSandboxError.unsafePath("Resolved directory escapes sandbox root.")
        }
        return resolvedCandidate
    }

    /// Returns a scrubbed child environment retaining only safe allowlisted keys and
    /// stripping all known credential environment variables regardless of casing.
    public func sanitizedEnvironment(
        from base: [String: String],
        additionalAllowedKeys: Set<String> = []
    ) -> [String: String] {
        let allowed = policy.allowedEnvKeys.union(additionalAllowedKeys)
        var result: [String: String] = [:]
        for (key, value) in base {
            guard Self.isValidEnvKey(key), !value.contains("\0") else { continue }
            guard allowed.contains(key) else { continue }
            let upper = key.uppercased()
            if Self.forbiddenCredentialKeysUpper.contains(upper) {
                continue
            }
            if upper.hasSuffix("_API_KEY") || upper.hasSuffix("_SECRET") || upper.hasSuffix("_TOKEN") {
                continue
            }
            result[key] = value
        }
        return result
    }

    private static func isValidPluginId(_ value: String) -> Bool {
        !value.isEmpty &&
            value.utf8.count <= 128 &&
            value.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil
    }

    private static func isValidEnvKey(_ key: String) -> Bool {
        !key.isEmpty && key.range(of: #"^[A-Za-z_][A-Za-z0-9_]*$"#, options: .regularExpression) != nil
    }
}

/// Single hit returned from Fleet Recall search; always tagged untrusted data.
public struct RecallSearchHit: Codable, Equatable, Sendable {
    public let title: String
    public let source: String
    public let score: Double
    public let snippet: String
    public let url: String?
    public let isUntrusted: Bool

    public init(
        title: String,
        source: String,
        score: Double,
        snippet: String,
        url: String? = nil,
        isUntrusted: Bool = true
    ) {
        self.title = title
        self.source = source
        self.score = score
        self.snippet = snippet
        self.url = url
        self.isUntrusted = isUntrusted
    }
}

/// Transport abstraction allowing `NativeRecallClient` to be tested offline or backed by Fleet Recall HTTP/MCP.
public protocol RecallSearchTransport: Sendable {
    func search(query: String, app: String?, limit: Int) async throws -> [RecallSearchHit]
}

/// Errors thrown by `NativeRecallClient` on invalid input, secret-gate refusals, or unconfigured transport.
public enum NativeRecallError: LocalizedError, Equatable, Sendable {
    case emptyQuery
    case suspectedSecretRefused(field: String)
    case transportUnavailable

    public var errorDescription: String? {
        switch self {
        case .emptyQuery:
            return "Recall search query must not be empty."
        case .suspectedSecretRefused(let field):
            return "Refused recall search because '\(field)' appears to contain a credential or secret."
        case .transportUnavailable:
            return "Fleet Recall transport is not configured."
        }
    }
}

/// Swift Fleet Recall client (`BF-2620`) enforcing preflight credential scanning before
/// any query leaves the process and tagging every result as untrusted data.
public actor NativeRecallClient {
    private let transport: (any RecallSearchTransport)?

    public init(transport: (any RecallSearchTransport)? = nil) {
        self.transport = transport
    }

    /// Preflight-scans `query` and `app`, clamps `limit` to `1...10`, and marks every
    /// returned hit `isUntrusted = true`.
    public func search(
        query: String,
        app: String? = nil,
        limit: Int = 5
    ) async throws -> [RecallSearchHit] {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedQuery.isEmpty else {
            throw NativeRecallError.emptyQuery
        }
        guard DiagnosticsReporter.redactSecrets(in: trimmedQuery) == trimmedQuery else {
            throw NativeRecallError.suspectedSecretRefused(field: "query")
        }

        let cleanApp: String?
        if let app {
            let trimmedApp = app.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmedApp.isEmpty {
                cleanApp = nil
            } else {
                guard DiagnosticsReporter.redactSecrets(in: trimmedApp) == trimmedApp else {
                    throw NativeRecallError.suspectedSecretRefused(field: "app")
                }
                cleanApp = trimmedApp
            }
        } else {
            cleanApp = nil
        }

        guard let transport else {
            throw NativeRecallError.transportUnavailable
        }

        let clampedLimit = min(10, max(1, limit))
        let hits = try await transport.search(query: trimmedQuery, app: cleanApp, limit: clampedLimit)
        return hits.map { hit in
            RecallSearchHit(
                title: hit.title,
                source: hit.source,
                score: hit.score,
                snippet: hit.snippet,
                url: hit.url,
                isUntrusted: true
            )
        }
    }
}
