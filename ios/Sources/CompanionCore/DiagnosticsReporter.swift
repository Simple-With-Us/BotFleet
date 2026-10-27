import Foundation

/// Pure-Swift secret redaction and diagnostics report bundle generator for BotFleet.
///
/// Mirrors `electron/diagnostics.mjs` and `shared/redact.ts` byte-for-byte in security invariants:
/// 1. The collector never reads secret values into memory (presence/boolean/numeric flags only).
/// 2. Any string that passes into log tails or reports is scrubbed through multi-layered regexes.
/// 3. Redacted tokens report `«redacted N chars»` to preserve debugging lengths without exposing bytes.
/// 4. Diagnostics exports write with strict `0600` POSIX file permissions.
public enum DiagnosticsReporter {

    /// Exact credential environment variable names mirroring `electron/diagnostics.mjs`
    /// and `WORKSPACE_CREDENTIAL_ENV` in `server/config.ts`.
    public static let credentialEnvNames: [String] = [
        "XAI_API_KEY",
        "OPENAI_COMPAT_API_KEY",
        "OPENAI_COMPAT_URL",
        "MINIMAX_API_KEY",
        "MINIMAX_BASE_URL",
        "BOTFLEET_LINQAPP_API_KEY",
        "LINQ_API_TOKEN",
        "LINQ_WEBHOOK_SECRET",
        "BOX_TOKEN",
        "OPENCODE_API_KEY",
        "OMB_TTS_KEY",
        "AZURE_SPEECH_KEY",
        "AZURE_SPEECH_REGION",
        "META_SPEECH_API_KEY",
        "GROQ_API_KEY",
        "ASSEMBLYAI_API_KEY",
        "OMB_OPENAI_IMAGE_KEY",
        "COMPOSIO_API_KEY",
        "OMB_COMPOSIO_BROKER_TOKEN",
        "DEEPSEEK_API_KEY",
        "DEEPSEEK_URL",
        "INFISICAL_CLIENT_ID",
        "INFISICAL_CLIENT_SECRET",
        "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
        "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
    ]

    /// Unmistakable credential token prefix patterns mirroring `CREDENTIAL_TOKEN_FORMATS`.
    public static let credentialTokenPatterns: [String] = [
        #"\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}"#,
        #"\bxai-[A-Za-z0-9_-]{20,}"#,
        #"\bgsk_[A-Za-z0-9]{40,}"#,
        #"\bhf_[A-Za-z0-9]{30,}"#,
        #"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}"#,
        #"\bgithub_pat_[A-Za-z0-9_]{20,}"#,
        #"\bxox[abposr]-[A-Za-z0-9-]{20,}"#,
        #"\bsk_(?:live|test)_[A-Za-z0-9]{8,}"#,
        #"\bak_[A-Za-z0-9_-]{16,}"#,
        #"\bwhsec_[A-Za-z0-9_-]{8,}"#,
        #"\bya29\.[A-Za-z0-9_-]{4,}"#,
        #"\bglpat-[A-Za-z0-9_-]{8,}"#,
        #"\bAKIA[0-9A-Z]{16}\b"#,
        #"\bAIza[0-9A-Za-z_-]{30,}"#,
        #"\bnpm_[A-Za-z0-9]{20,}"#,
        #"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?"#,
    ]

    private static let keyValuePairRegex = try! NSRegularExpression(
        pattern: #"\b([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s"',;)\]}]+)"#,
        options: [.caseInsensitive]
    )

    private static let authorizationRegex = try! NSRegularExpression(
        pattern: #"\b(authorization)\s*[:=]\s*(?:"|')?([A-Za-z][A-Za-z0-9_-]*\s+[A-Za-z0-9._~+/=-]+)(?:"|')?"#,
        options: [.caseInsensitive]
    )

    private static let bearerRegex = try! NSRegularExpression(
        pattern: #"(\bbearer\s+)([A-Za-z0-9._~+/=-]{8,})"#,
        options: [.caseInsensitive]
    )

    private static let pemBlockRegex = try! NSRegularExpression(
        pattern: #"(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)"#,
        options: []
    )

    private static let credentialEnvRegex = try! NSRegularExpression(
        pattern: #"\b("# + credentialEnvNames.joined(separator: "|") + #")\s*[:=]\s*"# + valuePartPattern,
        options: [.caseInsensitive]
    )

    private static let compiledTokenRegexes: [NSRegularExpression] = {
        // A pattern that does not compile is a programming error. Dropping it
        // would silently stop redacting that credential shape, so crash instead.
        credentialTokenPatterns.map { try! NSRegularExpression(pattern: $0, options: []) }
    }()

    private static let valuePartPattern = #"("[^"]*"|'[^']*'|[^\s"',;)\]}]+)"#

    public static func mask(_ value: String) -> String {
        "«redacted \(value.count) chars»"
    }

    private static func unquote(_ value: String) -> String {
        var str = value
        if (str.hasPrefix("\"") && str.hasSuffix("\"")) || (str.hasPrefix("'") && str.hasSuffix("'")) {
            str.removeFirst()
            str.removeLast()
        }
        return str
    }

    /// Redacts all known credential formats, env vars, authorization headers, and PEM keys from text.
    public static func redactSecrets(in text: String) -> String {
        var out = text
        let alreadyMaskedMarker = "«redacted"

        // 1. Env vars matching CREDENTIAL_ENV_NAMES
        do {
            let range = NSRange(out.startIndex..<out.endIndex, in: out)
            let matches = credentialEnvRegex.matches(in: out, options: [], range: range).reversed()
            for match in matches {
                guard let keyRange = Range(match.range(at: 1), in: out),
                      let valRange = Range(match.range(at: 2), in: out),
                      let fullRange = Range(match.range, in: out) else { continue }
                let key = String(out[keyRange])
                let rawEnvVal = String(out[valRange])
                if rawEnvVal.contains(alreadyMaskedMarker) { continue }
                let val = unquote(rawEnvVal)
                let replacement = "\(key)=\(mask(val))"
                out.replaceSubrange(fullRange, with: replacement)
            }
        }

        // 2. Authorization headers
        do {
            let range = NSRange(out.startIndex..<out.endIndex, in: out)
            let matches = authorizationRegex.matches(in: out, options: [], range: range).reversed()
            for match in matches {
                guard let keyRange = Range(match.range(at: 1), in: out),
                      let valRange = Range(match.range(at: 2), in: out),
                      let fullRange = Range(match.range, in: out) else { continue }
                let key = String(out[keyRange])
                let val = String(out[valRange])
                if val.contains(alreadyMaskedMarker) { continue }
                let replacement = "\(key)=\(mask(val))"
                out.replaceSubrange(fullRange, with: replacement)
            }
        }

        // 3. Bearer tokens
        do {
            let range = NSRange(out.startIndex..<out.endIndex, in: out)
            let matches = bearerRegex.matches(in: out, options: [], range: range).reversed()
            for match in matches {
                guard let leadRange = Range(match.range(at: 1), in: out),
                      let tokenRange = Range(match.range(at: 2), in: out),
                      let fullRange = Range(match.range, in: out) else { continue }
                let lead = String(out[leadRange])
                let token = String(out[tokenRange])
                if token.contains(alreadyMaskedMarker) { continue }
                let replacement = "\(lead)\(mask(token))"
                out.replaceSubrange(fullRange, with: replacement)
            }
        }

        // 4. PEM private key blocks
        do {
            let range = NSRange(out.startIndex..<out.endIndex, in: out)
            let matches = pemBlockRegex.matches(in: out, options: [], range: range).reversed()
            for match in matches {
                guard let openRange = Range(match.range(at: 1), in: out),
                      let closeRange = Range(match.range(at: 2), in: out),
                      let fullRange = Range(match.range, in: out) else { continue }
                let open = String(out[openRange])
                let close = String(out[closeRange])
                let replacement = "\(open)«redacted private key»\(close)"
                out.replaceSubrange(fullRange, with: replacement)
            }
        }

        // 5. Generic Key-Value Pairs
        do {
            let range = NSRange(out.startIndex..<out.endIndex, in: out)
            let matches = keyValuePairRegex.matches(in: out, options: [], range: range).reversed()
            for match in matches {
                guard let keyRange = Range(match.range(at: 1), in: out),
                      let valRange = Range(match.range(at: 2), in: out),
                      let fullRange = Range(match.range, in: out) else { continue }
                let rawVal = String(out[valRange])
                if rawVal.contains(alreadyMaskedMarker) { continue }
                let key = String(out[keyRange])
                let val = unquote(rawVal)
                let replacement = "\(key)=\(mask(val))"
                out.replaceSubrange(fullRange, with: replacement)
            }
        }

        // 6. Token shapes
        for regex in compiledTokenRegexes {
            let range = NSRange(out.startIndex..<out.endIndex, in: out)
            let matches = regex.matches(in: out, options: [], range: range).reversed()
            for match in matches {
                guard let fullRange = Range(match.range, in: out) else { continue }
                let found = String(out[fullRange])
                if found.contains(alreadyMaskedMarker) { continue }
                out.replaceSubrange(fullRange, with: mask(found))
            }
        }

        return out
    }

    /// Decodes a bounded log buffer without exporting a partial first line that began before the boundary.
    public static func decodeLogTail(data: Data, truncated: Bool = false) -> (tail: String, bytes: Int) {
        var complete = data
        if truncated {
            if let newlineIndex = data.firstIndex(of: 0x0a) {
                complete = data.subdata(in: (newlineIndex + 1)..<data.endIndex)
            } else {
                complete = Data()
            }
        }
        let str = String(data: complete, encoding: .utf8) ?? ""
        return (tail: str, bytes: complete.count)
    }

    /// Generates canonical file name: `botfleet-diagnostics-YYYYMMDD-HHMMSS.txt`
    public static func diagnosticsFileName(date: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return "botfleet-diagnostics-\(formatter.string(from: date)).txt"
    }

    /// Flatten nested dictionary down to dot-separated keys, strictly preserving only booleans and finite numbers.
    public static func flattenAndFilterConfigSummary(_ input: [String: Any], prefix: String = "", depth: Int = 0) -> [String: String] {
        var out: [String: String] = [:]
        guard depth < 3 else { return out }

        for (key, value) in input {
            let path = prefix.isEmpty ? key : "\(prefix).\(key)"
            if let numVal = value as? NSNumber {
                // Inspect the NSNumber before any Bool bridge: JSON numbers 0 and 1
                // also bridge to Bool, which would turn a count into "false"/"true".
                // Only a real CFBoolean is a boolean.
                if CFGetTypeID(numVal) == CFBooleanGetTypeID() {
                    out[path] = numVal.boolValue ? "true" : "false"
                } else if numVal.doubleValue.isFinite {
                    out[path] = "\(numVal)"
                }
                // NaN and Infinity are dropped, like every other non-finite value.
            } else if let boolVal = value as? Bool {
                out[path] = boolVal ? "true" : "false"
            } else if let dict = value as? [String: Any] {
                let nested = flattenAndFilterConfigSummary(dict, prefix: path, depth: depth + 1)
                for (k, v) in nested { out[k] = v }
            }
            // Strings, Arrays, and all other types are deliberately discarded to prevent leaking secrets.
        }
        return out
    }

    /// Builds a diagnostics report formatted identically to `electron/diagnostics.mjs`.
    public static func buildDiagnosticsReport(
        appInfo: [String: String] = [:],
        configSummary: [String: Any] = [:],
        logTail: String? = nil,
        now: Date = Date()
    ) -> String {
        var lines: [String] = []
        let isoFormatter = ISO8601DateFormatter()
        let timestamp = isoFormatter.string(from: now)

        lines.append("BotFleet diagnostics")
        lines.append("Generated: \(timestamp)")
        lines.append("")
        lines.append("## App")

        let appKeys = ["version", "platform", "arch", "osVersion", "buildCommit", "packaged", "uptimeSeconds"]
        for key in appKeys {
            if let val = appInfo[key] {
                lines.append("\(key)=\(redactSecrets(in: val))")
            }
        }

        lines.append("")
        lines.append("## Configuration")
        lines.append("# presence/count/mode only — credentials stay OS-encrypted and are never read")

        let filtered = flattenAndFilterConfigSummary(configSummary)
        if filtered.isEmpty {
            lines.append("(no configuration summary available)")
        } else {
            for key in filtered.keys.sorted() {
                if let val = filtered[key] {
                    lines.append("\(key)=\(val)")
                }
            }
        }

        lines.append("")
        if let tail = logTail, !tail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            lines.append("## Server log tail — known credential patterns auto-masked")
            let redacted = redactSecrets(in: tail)
            let logLines = redacted.components(separatedBy: .newlines)
            for line in logLines {
                lines.append(line)
            }
        } else {
            lines.append("## Server log tail")
            lines.append("(server log unavailable)")
        }

        lines.append("")
        return lines.joined(separator: "\n")
    }

    /// Exports diagnostics bundle to a specified URL, enforcing strict 0600 POSIX permissions.
    @discardableResult
    public static func exportDiagnostics(
        to destinationURL: URL,
        appInfo: [String: String] = [:],
        configSummary: [String: Any] = [:],
        logTail: String? = nil,
        now: Date = Date()
    ) throws -> URL {
        let content = buildDiagnosticsReport(appInfo: appInfo, configSummary: configSummary, logTail: logTail, now: now)
        let data = content.data(using: .utf8) ?? Data()

        let tempURL = destinationURL.deletingLastPathComponent().appendingPathComponent(".\(destinationURL.lastPathComponent).tmp")
        // The temp file is created already 0600, so it is never readable by others,
        // and a permission failure aborts the export instead of leaving a
        // world-readable diagnostics file behind.
        let fm = FileManager.default
        try? fm.removeItem(at: tempURL)
        guard fm.createFile(atPath: tempURL.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        do {
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tempURL.path)
            if fm.fileExists(atPath: destinationURL.path) {
                _ = try fm.replaceItemAt(destinationURL, withItemAt: tempURL)
            } else {
                try fm.moveItem(at: tempURL, to: destinationURL)
            }
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destinationURL.path)
        } catch {
            try? fm.removeItem(at: tempURL)
            try? fm.removeItem(at: destinationURL)
            throw error
        }

        return destinationURL
    }
}
