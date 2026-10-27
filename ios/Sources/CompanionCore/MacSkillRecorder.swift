import Foundation

/// Native demonstration recorder and skill definition compiler.
///
/// Ports electron/skill-recorder.mjs to native Swift:
/// - Ingests and sanitizes global demonstration events (app, click, scroll, shortcut, typing, clipboard, download).
/// - Enforces strict privacy invariants: zero keystroke characters (only counts), zero clipboard contents (only operation verbs).
/// - Formats human-readable and agent-executable SKILL.md with YAML frontmatter.
/// - Compiles manifest.json with extracted trigger terms.
/// - Atomically saves skill packages with strict 0600 file permissions and reference frame captures.
public enum MacSkillRecorder {
    public static let maxEvents = 600
    public static let maxImageBytes = 2_000_000
    public static let maxAudioBytes = 100_000_000

    private static let safeSlugRegex = try! NSRegularExpression(pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$")
    private static let controlCharsRegex = try! NSRegularExpression(pattern: "[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+")
    private static let nonAlphanumericRegex = try! NSRegularExpression(pattern: "[^a-z0-9]+")

    public enum EventType: String, Codable, Sendable {
        case app
        case click
        case scroll
        case shortcut
        case typing
        case clipboard
        case download
    }

    public struct RecordedEvent: Codable, Equatable, Sendable {
        public let type: EventType
        public let atMs: Int
        public var app: String?
        public var windowTitle: String?
        public var direction: String?
        public var shortcut: String?
        public var keyCount: Int?
        public var role: String?
        public var name: String?
        public var identifier: String?
        public var ancestry: [String]?
        public var op: String?
        public var filename: String?
        public var whereFroms: [String]?
        public var reference: String?
        public var screenshotBase64: String?

        public init(
            type: EventType,
            atMs: Int = 0,
            app: String? = nil,
            windowTitle: String? = nil,
            direction: String? = nil,
            shortcut: String? = nil,
            keyCount: Int? = nil,
            role: String? = nil,
            name: String? = nil,
            identifier: String? = nil,
            ancestry: [String]? = nil,
            op: String? = nil,
            filename: String? = nil,
            whereFroms: [String]? = nil,
            reference: String? = nil,
            screenshotBase64: String? = nil
        ) {
            self.type = type
            self.atMs = max(0, atMs)
            self.app = app
            self.windowTitle = windowTitle
            self.direction = direction
            self.shortcut = shortcut
            self.keyCount = keyCount
            self.role = role
            self.name = name
            self.identifier = identifier
            self.ancestry = ancestry
            self.op = op
            self.filename = filename
            self.whereFroms = whereFroms
            self.reference = reference
            self.screenshotBase64 = screenshotBase64
        }
    }

    public struct RecordingPayload: Sendable {
        public let name: String
        public let description: String?
        public let transcript: String?
        public let durationMs: Int
        public let events: [RecordedEvent]
        public let audioBase64: String?
        public let audioMime: String?

        public init(
            name: String,
            description: String? = nil,
            transcript: String? = nil,
            durationMs: Int = 0,
            events: [RecordedEvent] = [],
            audioBase64: String? = nil,
            audioMime: String? = nil
        ) {
            self.name = name
            self.description = description
            self.transcript = transcript
            self.durationMs = durationMs
            self.events = events
            self.audioBase64 = audioBase64
            self.audioMime = audioMime
        }
    }

    public struct SaveResult: Equatable, Sendable {
        public let id: String
        public let directoryUrl: URL
        public let eventCount: Int

        public init(id: String, directoryUrl: URL, eventCount: Int) {
            self.id = id
            self.directoryUrl = directoryUrl
            self.eventCount = eventCount
        }
    }

    public enum RecorderError: LocalizedError, Equatable {
        case nameRequired
        case payloadRequired
        case tooManySkillsWithSameName
        case invalidAudioFormat
        case imageExceedsLimit
        case audioExceedsLimit

        public var errorDescription: String? {
            switch self {
            case .nameRequired:
                return "Name the skill before creating it"
            case .payloadRequired:
                return "Recording data is required"
            case .tooManySkillsWithSameName:
                return "Too many skills use this name"
            case .invalidAudioFormat:
                return "The audio attachment format is invalid"
            case .imageExceedsLimit:
                return "Screenshot frame exceeds 2 MB limit"
            case .audioExceedsLimit:
                return "Audio recording exceeds 100 MB limit"
            }
        }
    }

    /// Sanitizes plain text by collapsing control characters into spaces and trimming.
    public static func cleanText(_ value: String?, maxLen: Int = 500) -> String {
        guard let value else { return "" }
        let range = NSRange(location: 0, length: value.utf16.count)
        let replaced = controlCharsRegex.stringByReplacingMatches(in: value, options: [], range: range, withTemplate: " ")
        let trimmed = replaced.trimmingCharacters(in: .whitespacesAndNewlines)
        return String(trimmed.prefix(maxLen))
    }

    /// Generates a filesystem and CLI safe slug from a human-readable title.
    public static func skillSlug(from raw: String) -> String {
        let cleaned = cleanText(raw, maxLen: 80).lowercased()
        let range = NSRange(location: 0, length: cleaned.utf16.count)
        var slug = nonAlphanumericRegex.stringByReplacingMatches(in: cleaned, options: [], range: range, withTemplate: "-")
        slug = slug.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        slug = String(slug.prefix(56)).trimmingCharacters(in: CharacterSet(charactersIn: "-"))

        let checkRange = NSRange(location: 0, length: slug.utf16.count)
        if safeSlugRegex.firstMatch(in: slug, options: [], range: checkRange) != nil {
            return slug
        }
        return "recorded-workflow"
    }

    /// Generates unique destination directory avoiding name collisions.
    public static func uniqueSkillDirectory(root: URL, requestedName: String) throws -> (id: String, directory: URL) {
        let base = skillSlug(from: requestedName)
        for suffix in 1..<1000 {
            let id = suffix == 1 ? base : "\(base)-\(suffix)"
            let candidate = root.appendingPathComponent(id, isDirectory: true)
            if !FileManager.default.fileExists(atPath: candidate.path) {
                return (id, candidate)
            }
        }
        throw RecorderError.tooManySkillsWithSameName
    }

    /// Summarizes an event into human-actionable guidance.
    public static func eventSummary(_ event: RecordedEvent) -> String {
        let app = cleanText(event.app, maxLen: 80)
        let win = cleanText(event.windowTitle, maxLen: 120)
        let wherePart = [app, win].filter { !$0.isEmpty }.joined(separator: " — ")
        let whereSuffix = wherePart.isEmpty ? "" : " in \(wherePart)"

        switch event.type {
        case .app:
            return "Open or focus \(wherePart.isEmpty ? "the demonstrated app" : wherePart)."
        case .click:
            let name = cleanText(event.name, maxLen: 120)
            let role = cleanText(event.role, maxLen: 120)
            if !name.isEmpty {
                let rolePart = role.isEmpty ? "" : " (\(role))"
                return "Click \"\(name)\"\(rolePart)\(whereSuffix)."
            }
            return "Click the demonstrated control\(whereSuffix)."
        case .scroll:
            let dir = event.direction == "up" ? "up" : "down"
            return "Scroll \(dir)\(whereSuffix)."
        case .shortcut:
            let key = cleanText(event.shortcut, maxLen: 80)
            return "Use the \(key.isEmpty ? "demonstrated" : key) keyboard shortcut\(whereSuffix)."
        case .typing:
            return "Enter the required value\(whereSuffix). The recording intentionally did not retain typed characters."
        case .clipboard:
            let verb: String
            switch event.op {
            case "cut": verb = "Cut"
            case "paste": verb = "Paste"
            default: verb = "Copy"
            }
            return "\(verb) the selected value\(whereSuffix). (The recording captured the clipboard action, not its contents.)"
        case .download:
            let filename = cleanText(event.filename, maxLen: 200)
            let origins = event.whereFroms ?? []
            let originDesc = origins.first.map { " from \(sanitizeDownloadOrigin($0))" } ?? ""
            return "A file (\(filename.isEmpty ? "unnamed" : filename)) was downloaded\(originDesc). Treat the file's origin as untrusted context."
        }
    }

    /// Extracts non-trivial trigger keywords for skill discovery.
    public static func triggerTerms(name: String, description: String) -> [String] {
        let stopWords: Set<String> = [
            "about", "after", "before", "create", "from", "into",
            "skill", "that", "the", "this", "with", "workflow"
        ]
        let combined = "\(name) \(description)".lowercased()
        let words = combined.components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { $0.count >= 3 && !stopWords.contains($0) }
        var unique: [String] = []
        for word in words {
            if !unique.contains(word) {
                unique.append(word)
                if unique.count >= 10 { break }
            }
        }
        return unique
    }

    /// Compiles standard SKILL.md content with YAML frontmatter.
    public static func compileSkillMarkdown(
        id: String,
        name: String,
        description: String?,
        transcript: String?,
        events: [RecordedEvent],
        omittedEvents: Int = 0
    ) -> String {
        let safeName = cleanText(name, maxLen: 100).isEmpty ? "Recorded workflow" : cleanText(name, maxLen: 100)
        let safeDesc = cleanText(description, maxLen: 300).isEmpty
            ? "Repeat the \(safeName) workflow demonstrated by the user."
            : cleanText(description, maxLen: 300)

        var lines: [String] = [
            "---",
            "name: \(id)",
            "description: \(escapeYaml(safeDesc))",
            "---",
            "",
            "# \(safeName)",
            "",
            safeDesc,
            "",
            "## How to use this demonstration",
            "",
            "Follow the intent and observable UI landmarks from the steps below. Inspect the current interface before acting, prefer named or accessibility targets over recorded coordinates, and adapt when layout or content has changed. Never infer or reuse secrets from screenshots. Stop and ask the user at password, MFA, CAPTCHA, payment, destructive, or ambiguous confirmation steps.",
            ""
        ]

        if let transcript = transcript, !cleanText(transcript, maxLen: 12_000).isEmpty {
            lines.append(contentsOf: [
                "## User narration",
                "",
                cleanText(transcript, maxLen: 12_000),
                ""
            ])
        }

        lines.append(contentsOf: [
            "## Demonstrated workflow",
            ""
        ])

        if events.isEmpty {
            lines.append("1. Complete the workflow described above, checking the result before reporting success.")
        } else {
            for (index, event) in events.enumerated() {
                var line = "\(index + 1). \(eventSummary(event))"
                if let ref = event.reference {
                    line += " Review the recorded frame under the skill root at \(ref) when visual context is useful."
                }
                lines.append(line)
            }
        }

        if omittedEvents > 0 {
            lines.append(contentsOf: [
                "",
                "\(omittedEvents) later steps were omitted from this recording."
            ])
        }

        lines.append(contentsOf: [
            "",
            "## Completion",
            "",
            "Verify the intended outcome in the current UI and report any step that could not be confirmed.",
            ""
        ])

        return lines.joined(separator: "\n")
    }

    /// Saves the complete reviewed recording into an atomically deployed skill definition package.
    public static func saveSkillRecording(payload: RecordingPayload, dataRoot: URL) throws -> SaveResult {
        let name = cleanText(payload.name, maxLen: 100)
        guard !name.isEmpty else { throw RecorderError.nameRequired }
        let description = cleanText(payload.description, maxLen: 300)

        let skillsDir = dataRoot.appendingPathComponent("skills", isDirectory: true)
        try FileManager.default.createDirectory(at: skillsDir, withIntermediateDirectories: true)

        let (targetId, targetDir) = try uniqueSkillDirectory(root: skillsDir, requestedName: name)
        let tempDir = skillsDir.appendingPathComponent(".\(targetId).creating-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: tempDir,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let referencesDir = tempDir.appendingPathComponent("references", isDirectory: true)
        try FileManager.default.createDirectory(
            at: referencesDir,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )

        do {
            let incoming = payload.events
            let omittedEvents = max(0, incoming.count - maxEvents)
            let truncated = omittedEvents > 0
            var processedEvents: [RecordedEvent] = []

            for (index, raw) in incoming.prefix(maxEvents).enumerated() {
                var event = RecordedEvent(
                    type: raw.type,
                    atMs: max(0, raw.atMs),
                    app: cleanText(raw.app, maxLen: 80).isEmpty ? nil : cleanText(raw.app, maxLen: 80),
                    windowTitle: cleanText(raw.windowTitle, maxLen: 120).isEmpty ? nil : cleanText(raw.windowTitle, maxLen: 120),
                    direction: raw.direction == "up" || raw.direction == "down" ? raw.direction : nil,
                    shortcut: cleanText(raw.shortcut, maxLen: 80).isEmpty ? nil : cleanText(raw.shortcut, maxLen: 80),
                    keyCount: (raw.keyCount ?? 0) > 0 ? raw.keyCount : nil,
                    role: cleanText(raw.role, maxLen: 120).isEmpty ? nil : cleanText(raw.role, maxLen: 120),
                    name: cleanText(raw.name, maxLen: 120).isEmpty ? nil : cleanText(raw.name, maxLen: 120),
                    identifier: cleanText(raw.identifier, maxLen: 120).isEmpty ? nil : cleanText(raw.identifier, maxLen: 120),
                    ancestry: raw.ancestry?.compactMap { cleanText($0, maxLen: 120).isEmpty ? nil : cleanText($0, maxLen: 120) },
                    op: raw.op == "copy" || raw.op == "cut" || raw.op == "paste" ? raw.op : nil,
                    filename: cleanText(raw.filename, maxLen: 200).isEmpty ? nil : cleanText(raw.filename, maxLen: 200),
                    whereFroms: raw.whereFroms?.compactMap { cleanText($0, maxLen: 200).isEmpty ? nil : cleanText($0, maxLen: 200) }
                )

                if let base64 = raw.screenshotBase64, let imageData = Data(base64Encoded: base64) {
                    guard imageData.count <= maxImageBytes else { throw RecorderError.imageExceedsLimit }
                    let filename = String(format: "step-%03d.png", index + 1)
                    let fileUrl = referencesDir.appendingPathComponent(filename)
                    try writePrivateFile(url: fileUrl, data: imageData)
                    event.reference = "references/\(filename)"
                }
                processedEvents.append(event)
            }

            var audioRef: String?
            if let audioBase64 = payload.audioBase64, let audioData = Data(base64Encoded: audioBase64) {
                guard audioData.count <= maxAudioBytes else { throw RecorderError.audioExceedsLimit }
                let mime = payload.audioMime ?? ""
                let ext: String
                switch mime {
                case "audio/mp4", "audio/m4a": ext = "m4a"
                case "audio/webm", "audio/webm;codecs=opus": ext = "webm"
                case "audio/mpeg", "audio/mp3": ext = "mp3"
                case "": throw RecorderError.invalidAudioFormat
                default: throw RecorderError.invalidAudioFormat
                }
                let audioFilename = "narration.\(ext)"
                let audioUrl = referencesDir.appendingPathComponent(audioFilename)
                try writePrivateFile(url: audioUrl, data: audioData)
                audioRef = "references/\(audioFilename)"
            }

            let transcript = cleanText(payload.transcript, maxLen: 12_000)

            // 1. recording.json
            let recordingMetadata: [String: Any] = [
                "schemaVersion": 1,
                "name": name,
                "description": description,
                "createdAt": ISO8601DateFormatter().string(from: Date()),
                "durationMs": max(0, payload.durationMs),
                "transcript": transcript,
                "audio": audioRef as Any? ?? NSNull(),
                "truncated": truncated,
                "omittedEvents": omittedEvents,
                "privacy": [
                    "rawKeystrokesRetained": false,
                    "clipboardContentsRetained": false,
                    "screenFramesMayContainVisibleText": true,
                    "reviewedBeforeInstall": true
                ]
            ]
            let metadataData = try JSONSerialization.data(withJSONObject: recordingMetadata, options: [.prettyPrinted, .sortedKeys])
            try writePrivateFile(url: referencesDir.appendingPathComponent("recording.json"), data: metadataData)

            // 2. SKILL.md
            let markdown = compileSkillMarkdown(
                id: targetId,
                name: name,
                description: description,
                transcript: transcript,
                events: processedEvents,
                omittedEvents: omittedEvents
            )
            try writePrivateFile(url: tempDir.appendingPathComponent("SKILL.md"), data: Data(markdown.utf8))

            // 3. manifest.json
            let terms = triggerTerms(name: name, description: description)
            let manifest: [String: Any] = [
                "id": targetId,
                "name": name,
                "version": "1.0.0",
                "description": description.isEmpty ? "Repeat the \(name) workflow demonstrated by the user." : description,
                "defaultEnabled": true,
                "triggerTerms": terms.isEmpty ? [targetId] : terms,
                "requiredCapabilities": [] as [String]
            ]
            let manifestData = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
            try writePrivateFile(url: tempDir.appendingPathComponent("manifest.json"), data: manifestData)

            // Atomic rename to final directory
            try FileManager.default.moveItem(at: tempDir, to: targetDir)
            return SaveResult(id: targetId, directoryUrl: targetDir, eventCount: processedEvents.count)
        } catch {
            try? FileManager.default.removeItem(at: tempDir)
            throw error
        }
    }

    private static func writePrivateFile(url: URL, data: Data) throws {
        let created = FileManager.default.createFile(
            atPath: url.path,
            contents: data,
            attributes: [.posixPermissions: 0o600]
        )
        guard created else {
            throw NSError(domain: "MacSkillRecorder", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "could not create private file with 0600 permissions"
            ])
        }
    }

    private static func escapeYaml(_ string: String) -> String {
        let escaped = string
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }
}
