// Chat attachments: the same prompt tags the desktop composer emits.
//
// The harness stores bytes under ~/.botfleet/attachments/<uuid>.<ext> and
// answers with that disk path.  Agents open the path; they cannot open an
// /api/attachments URL.  Avatars still use the URL form via uploadAvatar.
import Foundation

public enum ChatAttachmentKind: String, Sendable, Equatable {
    case image
    case file
}

/// One file waiting to be uploaded, then folded into the prompt.
public struct PendingChatAttachment: Sendable, Identifiable, Equatable, Hashable {
    public let id: UUID
    public var name: String
    public var mime: String
    public var data: Data

    public init(id: UUID = UUID(), name: String, mime: String, data: Data) {
        self.id = id
        self.name = name
        self.mime = mime
        self.data = data
    }

    public var kind: ChatAttachmentKind {
        ChatAttachments.isImageMIME(mime) ? .image : .file
    }

    public var size: Int { data.count }

    public static func == (left: PendingChatAttachment, right: PendingChatAttachment) -> Bool {
        left.id == right.id
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}

/// A disk path the prompt will name, after POST /api/attachments succeeds.
public struct ChatPromptAttachment: Sendable, Equatable {
    public var kind: ChatAttachmentKind
    public var path: String

    public init(kind: ChatAttachmentKind, path: String) {
        self.kind = kind
        self.path = path
    }
}

public struct SplitChatAttachments: Sendable, Equatable {
    public var display: String
    public var images: [String]
    public var files: [String]

    public init(display: String, images: [String], files: [String]) {
        self.display = display
        self.images = images
        self.files = files
    }
}

public enum ChatAttachments {
    public static let imageMaxBytes = 10 * 1_024 * 1_024
    public static let fileMaxBytes = 25 * 1_024 * 1_024
    /// Formats that both the companion GET route and UIImage-backed views
    /// render.  Other image uploads must be converted before they are sent.
    public static let displayImageMIME: Set<String> = [
        "image/png", "image/jpeg", "image/gif", "image/webp",
    ]

    /// Mimes the harness POST /api/attachments accepts.
    public static let allowedMIME: Set<String> = [
        "image/png", "image/jpeg", "image/gif", "image/webp",
        "image/heic", "image/heif", "image/avif",
        "image/bmp", "image/svg+xml",
        "application/pdf", "text/plain", "text/markdown", "text/csv",
        "application/json", "application/zip", "application/gzip",
        "audio/mpeg", "audio/wav", "audio/ogg", "audio/opus",
        "audio/mp4", "audio/x-m4a", "audio/aac", "audio/webm",
        "video/mp4",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/octet-stream",
    ]

    public static func normalizeMIME(_ mime: String) -> String {
        mime.split(separator: ";").first.map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? mime.lowercased()
    }

    public static func isImageMIME(_ mime: String) -> Bool {
        let normalized = normalizeMIME(mime)
        return normalized.hasPrefix("image/") && allowedMIME.contains(normalized)
    }

    public static func isAllowedMIME(_ mime: String) -> Bool {
        allowedMIME.contains(normalizeMIME(mime))
    }

    public static func isDisplayImageMIME(_ mime: String) -> Bool {
        displayImageMIME.contains(normalizeMIME(mime))
    }

    public static func maxBytes(forMIME mime: String) -> Int {
        isImageMIME(mime) ? imageMaxBytes : fileMaxBytes
    }

    /// Magic-byte sniff for every image type the harness accepts.
    public static func sniffImageMIME(_ data: Data) -> String? {
        let bytes = [UInt8](data.prefix(12))
        if bytes.starts(with: [0x89, 0x50, 0x4e, 0x47]) { return "image/png" }
        if bytes.starts(with: [0xff, 0xd8, 0xff]) { return "image/jpeg" }
        if bytes.starts(with: Array("GIF8".utf8)) { return "image/gif" }
        if bytes.count >= 12,
           String(bytes: bytes[0..<4], encoding: .ascii) == "RIFF",
           String(bytes: bytes[8..<12], encoding: .ascii) == "WEBP" {
            return "image/webp"
        }
        // ftyp....heic / heif / mif1
        if bytes.count >= 12,
           String(bytes: bytes[4..<8], encoding: .ascii) == "ftyp" {
            let brand = String(bytes: bytes[8..<12], encoding: .ascii) ?? ""
            if brand.hasPrefix("hei") || brand == "mif1" { return "image/heic" }
            if brand.hasPrefix("avif") { return "image/avif" }
        }
        if bytes.starts(with: [0x42, 0x4d]) { return "image/bmp" }
        if let prefix = String(data: data.prefix(256), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
           prefix.hasPrefix("<svg") || prefix.hasPrefix("<?xml") {
            return "image/svg+xml"
        }
        return nil
    }

    public static func mime(forExtension ext: String) -> String {
        switch ext.lowercased() {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "heic": return "image/heic"
        case "heif": return "image/heif"
        case "avif": return "image/avif"
        case "bmp": return "image/bmp"
        case "svg": return "image/svg+xml"
        case "pdf": return "application/pdf"
        case "txt": return "text/plain"
        case "md", "markdown": return "text/markdown"
        case "csv": return "text/csv"
        case "json": return "application/json"
        case "zip": return "application/zip"
        case "gz", "gzip": return "application/gzip"
        case "mp3": return "audio/mpeg"
        case "wav": return "audio/wav"
        case "ogg": return "audio/ogg"
        case "opus": return "audio/opus"
        case "m4a": return "audio/mp4"
        case "aac": return "audio/aac"
        case "webm": return "audio/webm"
        case "mp4": return "video/mp4"
        case "doc": return "application/msword"
        case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        case "xls": return "application/vnd.ms-excel"
        case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        default: return "application/octet-stream"
        }
    }

    /// The prompt the bot receives: typed text, then one tag per attachment.
    /// Mirror `src/lib/composer-attachments.ts` composeMessage exactly.
    public static func composeMessage(text: String, attachments: [ChatPromptAttachment]) -> String {
        var parts = [text.trimmingCharacters(in: .whitespacesAndNewlines)]
        for attachment in attachments {
            let path = escapeAttribute(attachment.path)
            switch attachment.kind {
            case .image:
                parts.append("<attached-image path=\"\(path)\" />")
            case .file:
                parts.append("<attached-file path=\"\(path)\" />")
            }
        }
        return parts.filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    /// File paths are untrusted prompt content.  Keep them inside the quoted
    /// attribute even when a filename contains XML characters or line breaks.
    public static func escapeAttribute(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\t", with: "&#9;")
            .replacingOccurrences(of: "\r", with: "&#13;")
            .replacingOccurrences(of: "\n", with: "&#10;")
    }

    public static func unescapeAttribute(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&#9;", with: "\t")
            .replacingOccurrences(of: "&#13;", with: "\r")
            .replacingOccurrences(of: "&#10;", with: "\n")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    /// Split a stored message into display text and the paths it attached.
    public static func split(_ text: String) -> SplitChatAttachments {
        var images: [String] = []
        var files: [String] = []
        let pattern = #"<attached-(image|file)\s+path="([^"]*)"\s*/?>(?:\s*\n)?"#
        let regex = try? NSRegularExpression(pattern: pattern)
        let ns = text as NSString
        let full = NSRange(location: 0, length: ns.length)
        regex?.enumerateMatches(in: text, range: full) { match, _, _ in
            guard let match, match.numberOfRanges >= 3 else { return }
            let kind = ns.substring(with: match.range(at: 1))
            let path = unescapeAttribute(ns.substring(with: match.range(at: 2)))
            guard !path.isEmpty else { return }
            if kind == "image" {
                images.append(path)
            } else {
                files.append(path)
            }
        }
        let stripped = regex?.stringByReplacingMatches(in: text, range: full, withTemplate: "") ?? text
        return SplitChatAttachments(
            display: stripped.trimmingCharacters(in: .whitespacesAndNewlines),
            images: images,
            files: files
        )
    }

    public static func attachmentBasename(_ path: String) -> String {
        let posix = path.split(separator: "/").last.map(String.init) ?? path
        return posix.split(separator: "\\").last.map(String.init) ?? posix
    }

    /// The paired GET the phone uses to draw a transcript image.  Nil when
    /// the name would not pass the sidecar image allowlist.
    public static func fetchPath(forDiskPath path: String) -> String? {
        let name = attachmentBasename(path)
        guard isRenderableImageName(name) else { return nil }
        return "/api/attachments/\(name)"
    }

    public static func isRenderableImageName(_ name: String) -> Bool {
        let ext = (name as NSString).pathExtension.lowercased()
        let stem = (name as NSString).deletingPathExtension
        guard !stem.isEmpty, stem.utf8.allSatisfy({
            (48...57).contains($0) || (65...90).contains($0) ||
                (97...122).contains($0) || $0 == 45
        }) else { return false }
        return ["png", "jpg", "jpeg", "gif", "webp"].contains(ext)
    }

    public static func formatSize(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 {
            return String(format: "%.1f KB", Double(bytes) / 1024)
        }
        return String(format: "%.1f MB", Double(bytes) / (1024 * 1024))
    }
}
