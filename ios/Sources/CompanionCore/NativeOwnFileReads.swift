import Foundation

/// Opt-in own-file approval for the native permission gates, ported from
/// OpenMausBot #3791 (`server/own-file-reads.ts`): a bot reading its own files
/// never waits for the person.  A runner constructed without a policy keeps
/// the existing fail-closed handler path unchanged, so a composition that
/// cannot tell a guest turn from the owner's (the native `TurnInput` carries
/// no guest marker) simply does not pass one.
public struct NativeOwnFileReadPolicy: Equatable, Sendable {
    /// The data directory holding `workspaces/`, `task-workspaces/` and `bots/`.
    public let dataDirectory: String

    public init(dataDirectory: String) {
        self.dataDirectory = dataDirectory
    }
}

/// Plain-read classification and own-folder containment, mirroring upstream:
/// only the reading commands below, made of plain words alone, or a read
/// tool's own paths, with every path existing and inside the bot's own
/// folders once every symlink is followed.
public enum NativeOwnFileReads {
    private struct Reader {
        var flags: String
        var valued: String?
        var takesPattern: Bool = false
        var script: String?
    }

    private static let readers: [String: Reader] = [
        "cat": Reader(flags: #"^-[nbsvAET]+$"#),
        "head": Reader(flags: #"^-(?:[nqv]+|\d+)$"#, valued: #"^-[nc]$"#),
        "tail": Reader(flags: #"^-(?:[nqv]+|\d+)$"#, valued: #"^-[nc]$"#),
        "wc": Reader(flags: #"^-[lwcmL]+$"#),
        "ls": Reader(flags: #"^-[laAhRt1SrdFpG]+$"#),
        "nl": Reader(flags: #"^-[ba]+$"#),
        "stat": Reader(flags: #"^-L$"#),
        "grep": Reader(flags: #"^-(?:[nilcrvwxHhEFsoq]+|-color=never)$"#, valued: #"^-[ABCm]$"#, takesPattern: true),
        "rg": Reader(flags: #"^-(?:[nilcvwxHhFsS]+|-no-heading|-color=never)$"#, valued: #"^-[ABCmg]$"#, takesPattern: true),
        "sed": Reader(flags: #"^-n$"#, script: #"^(?:\d+|\$)(?:,(?:\d+|\$))?p$"#),
    ]

    private static func matches(_ pattern: String, _ value: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }

    /// Splits a command into plain words, or returns nil when any part is the
    /// shell's to expand (glob, variable, substitution, redirect, pipe,
    /// second command, newline, tilde or zsh `=cmd`).
    static func words(_ command: String) -> [String]? {
        if command.contains("\0") || command.contains("\r") || command.contains("\n") { return nil }
        let text = command.trimmingCharacters(in: CharacterSet(charactersIn: " \t"))
        let chars = Array(text)
        var out: [String] = []
        var index = 0
        let bareAllowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_./~+@%:,=-")
        while index < chars.count {
            while index < chars.count && (chars[index] == " " || chars[index] == "\t") { index += 1 }
            if index >= chars.count { break }
            let word: String
            if chars[index] == "'" {
                var end = index + 1
                while end < chars.count && chars[end] != "'" { end += 1 }
                guard end < chars.count else { return nil }
                word = String(chars[(index + 1)..<end])
                index = end + 1
            } else if chars[index] == "\"" {
                var end = index + 1
                while end < chars.count && chars[end] != "\"" {
                    if chars[end] == "$" || chars[end] == "`" || chars[end] == "\\" || chars[end] == "!" { return nil }
                    end += 1
                }
                guard end < chars.count else { return nil }
                word = String(chars[(index + 1)..<end])
                index = end + 1
            } else {
                var end = index
                while end < chars.count && String(chars[end]).rangeOfCharacter(from: bareAllowed) != nil { end += 1 }
                guard end > index else { return nil }
                word = String(chars[index..<end])
                if word.contains("~") || word.hasPrefix("=") { return nil }
                index = end
            }
            guard index >= chars.count || chars[index] == " " || chars[index] == "\t" else { return nil }
            out.append(word)
        }
        return out.isEmpty ? nil : out
    }

    /// The paths a shell command reads when it is one of the plain readers,
    /// or nil when it might do anything else.
    public static func readOnlyPaths(command: String) -> [String]? {
        guard let parts = words(command), let name = parts.first, let reader = readers[name] else { return nil }
        let rest = Array(parts.dropFirst())
        var paths: [String] = []
        var patternTaken = !reader.takesPattern
        var scriptTaken = reader.script == nil
        var endOfFlags = false
        var index = 0
        while index < rest.count {
            let word = rest[index]
            if !endOfFlags && word == "--" { endOfFlags = true; index += 1; continue }
            if !endOfFlags && word.hasPrefix("-") && word != "-" {
                if let valued = reader.valued, matches(valued, word) {
                    index += 1
                    guard index < rest.count else { return nil }
                    index += 1
                    continue
                }
                guard matches(reader.flags, word) else { return nil }
                index += 1
                continue
            }
            if !scriptTaken {
                guard let script = reader.script, matches(script, word) else { return nil }
                scriptTaken = true
                index += 1
                continue
            }
            if !patternTaken { patternTaken = true; index += 1; continue }
            if word == "-" { return nil }
            paths.append(word)
            index += 1
        }
        return scriptTaken && patternTaken && !paths.isEmpty ? paths : nil
    }

    /// The files an ACP `read` call names: its locations and the usual path
    /// fields of its input.  Nil for any other kind, or a relative path.
    public static func acpReadPaths(kind: String, locations: [String], rawInput: [String: Any]?) -> [String]? {
        guard kind == "read" else { return nil }
        var paths = locations
        for key in ["filePath", "file_path", "path"] {
            if let value = rawInput?[key] as? String { paths.append(value) }
        }
        paths = Array(Set(paths))
        guard !paths.isEmpty, paths.allSatisfy({ $0.hasPrefix("/") }) else { return nil }
        return paths
    }

    private static func realPath(_ path: String) -> String? {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else { return nil }
        return URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
    }

    private static func isInside(_ path: String, root: String) -> Bool {
        path == root || path.hasPrefix(root + "/")
    }

    /// The bot's own folders and files, as they are on disk: its folder, its
    /// conversation folders and its `SOUL.md` (never the whole record folder).
    public static func ownReadRoots(dataDirectory: String, botId: String) -> [String] {
        guard matches(#"^[A-Za-z0-9_-]{1,128}$"#, botId) else { return [] }
        let base = URL(fileURLWithPath: dataDirectory, isDirectory: true)
        return [
            base.appendingPathComponent("workspaces").appendingPathComponent(botId),
            base.appendingPathComponent("task-workspaces").appendingPathComponent(botId),
            base.appendingPathComponent("bots").appendingPathComponent(botId).appendingPathComponent("SOUL.md"),
        ].compactMap { realPath($0.path) }
    }

    /// Every path exists and is inside one of `roots` once links are followed.
    public static func readsOnly(paths: [String], cwd: String, roots: [String]) -> Bool {
        guard !paths.isEmpty, !roots.isEmpty else { return false }
        return paths.allSatisfy { path in
            let resolved = path.hasPrefix("/")
                ? path
                : URL(fileURLWithPath: cwd, isDirectory: true).appendingPathComponent(path).path
            guard let real = realPath(resolved) else { return false }
            return roots.contains { isInside(real, root: $0) }
        }
    }

    /// Whether a shell ask only reads the bot's own files.
    public static func readsOwnFiles(
        policy: NativeOwnFileReadPolicy, botId: String, command: String, cwd: String
    ) -> Bool {
        guard let paths = readOnlyPaths(command: command) else { return false }
        return readsOnly(
            paths: paths, cwd: cwd,
            roots: ownReadRoots(dataDirectory: policy.dataDirectory, botId: botId))
    }

    /// Whether a read tool's paths only read the bot's own files.
    public static func readsOwnFiles(
        policy: NativeOwnFileReadPolicy, botId: String, readPaths: [String]
    ) -> Bool {
        readsOnly(
            paths: readPaths, cwd: "/",
            roots: ownReadRoots(dataDirectory: policy.dataDirectory, botId: botId))
    }
}
