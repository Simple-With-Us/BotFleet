import Foundation
#if canImport(Darwin)
import Darwin
#endif

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
    ///
    /// Tokenizes on Unicode scalars, never grapheme clusters: the shell is
    /// byte-oriented, so a quote, backtick or dollar followed by a combining
    /// mark is still that ASCII byte to the shell, and scalar comparison
    /// keeps it that way here too.  Empty words (`''`, `""`) are refused —
    /// one would otherwise resolve to the working directory itself.
    static func words(_ command: String) -> [String]? {
        let scalars = Array(command.unicodeScalars)
        if scalars.contains(where: { $0.value == 0 || $0 == "\r" || $0 == "\n" }) { return nil }
        func isSpace(_ scalar: UnicodeScalar) -> Bool { scalar == " " || scalar == "\t" }
        func wordString(_ range: Range<Int>) -> String {
            String(String.UnicodeScalarView(scalars[range]))
        }
        let bareAllowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_./~+@%:,=-".unicodeScalars)
        var out: [String] = []
        var index = 0
        while index < scalars.count {
            while index < scalars.count && isSpace(scalars[index]) { index += 1 }
            if index >= scalars.count { break }
            let word: String
            if scalars[index] == "'" {
                var end = index + 1
                while end < scalars.count && scalars[end] != "'" { end += 1 }
                guard end < scalars.count else { return nil }
                word = wordString((index + 1)..<end)
                index = end + 1
            } else if scalars[index] == "\"" {
                var end = index + 1
                while end < scalars.count && scalars[end] != "\"" {
                    let scalar = scalars[end]
                    if scalar == "$" || scalar == "`" || scalar == "\\" || scalar == "!" { return nil }
                    end += 1
                }
                guard end < scalars.count else { return nil }
                word = wordString((index + 1)..<end)
                index = end + 1
            } else {
                var end = index
                while end < scalars.count && bareAllowed.contains(scalars[end]) { end += 1 }
                guard end > index else { return nil }
                word = wordString(index..<end)
                if word.contains("~") || word.hasPrefix("=") { return nil }
                index = end
            }
            guard !word.isEmpty else { return nil }
            guard index >= scalars.count || isSpace(scalars[index]) else { return nil }
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

    /// `realpath(3)` canonicalization, so roots, candidates and an opened
    /// handle's `F_GETPATH` all speak the same path language (`/var` and
    /// `/private/var` must not compare unequal).  Nil when the path does
    /// not exist.
    private static func realPath(_ path: String) -> String? {
        guard let cString = realpath(path, nil) else { return nil }
        defer { free(cString) }
        return String(cString: cString)
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

    /// Every path exists, carries no symlink at or below an own root, and
    /// resolves inside one of `roots`.
    ///
    /// Fail-closed rules, beyond plain resolved-path containment:
    /// - A symlinked final component is never auto-approved, even when it
    ///   points inside the roots today: its target can be repointed between
    ///   this check and the agent's own open.
    /// - A symlinked intermediate component whose parent resolves inside a
    ///   root is likewise refused (system links above the roots, such as
    ///   `/var` -> `/private/var`, are outside the bot's control and pass).
    /// - The candidate is opened once with `O_NOFOLLOW` and the opened
    ///   handle's own path (`F_GETPATH`) must equal the resolved path, so a
    ///   swap raced against the resolve is caught at check time.
    /// - A directory target (what `grep -r`, `rg` and `ls -R` traverse) is
    ///   walked without following links; any symlink anywhere under it, or
    ///   a tree too large to walk, refuses auto-approval.  The reachable
    ///   set of a recursive tool then cannot leave the roots, whatever
    ///   link-following semantics the agent's `grep`/`rg` build has.
    ///
    /// Residual risk, stated plainly: this is a permission predicate for an
    /// external agent process, which re-opens the path itself after the
    /// approval reply — no file descriptor can be handed across.  A process
    /// that can write inside the bot's folders could still replace a
    /// regular file with a symlink in the approval-to-execution window.
    /// Refusing every symlink-bearing path above narrows that window to
    /// regular-file replacement; it does not eliminate it.
    public static func readsOnly(paths: [String], cwd: String, roots: [String]) -> Bool {
        guard !paths.isEmpty, !roots.isEmpty, paths.allSatisfy({ !$0.isEmpty }) else { return false }
        return paths.allSatisfy { path in
            validatedInsideRoots(path: path, cwd: cwd, roots: roots)
        }
    }

    private static func validatedInsideRoots(path: String, cwd: String, roots: [String]) -> Bool {
        let lexicalURL = path.hasPrefix("/")
            ? URL(fileURLWithPath: path)
            : URL(fileURLWithPath: cwd, isDirectory: true).appendingPathComponent(path)
        let lexical = lexicalURL.standardizedFileURL.path

        var info = stat()
        guard lstat(lexical, &info) == 0 else { return false }
        let kind = info.st_mode & S_IFMT
        // Only regular files and directories: anything else (a FIFO would
        // block the open below, a device is not a plain read) asks a human.
        guard kind == S_IFREG || kind == S_IFDIR else { return false }

        guard let resolved = realPath(lexical),
              roots.contains(where: { isInside(resolved, root: $0) }) else { return false }

        // Intermediate components: refuse a symlink whose parent already
        // resolves inside an own root (i.e. a link the bot's area contains).
        let components = lexical.split(separator: "/", omittingEmptySubsequences: true)
        var prefix = ""
        for (offset, component) in components.enumerated() {
            prefix += "/" + component
            if offset == components.count - 1 { break }
            var prefixInfo = stat()
            guard lstat(prefix, &prefixInfo) == 0 else { return false }
            if prefixInfo.st_mode & S_IFMT == S_IFLNK {
                let parent = (prefix as NSString).deletingLastPathComponent
                guard let resolvedParent = realPath(parent.isEmpty ? "/" : parent) else { return false }
                if roots.contains(where: { isInside(resolvedParent, root: $0) }) { return false }
            }
        }

        // Validate the opened handle, not just the path.
        let fd = open(lexical, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard fcntl(fd, F_GETPATH, &buffer) == 0, String(cString: buffer) == resolved else { return false }

        if kind == S_IFDIR { return treeContainsNoSymlinks(resolved) }
        return true
    }

    /// The whole tree under `directory`, walked by `lstat` without following
    /// any link: false on the first symlink, unreadable entry, or a tree
    /// larger than the walk budget.
    private static func treeContainsNoSymlinks(_ directory: String) -> Bool {
        var stack = [directory]
        var visited = 0
        while let current = stack.popLast() {
            guard let entries = try? FileManager.default.contentsOfDirectory(atPath: current) else { return false }
            for entry in entries {
                visited += 1
                guard visited <= 10_000 else { return false }
                let candidate = current + "/" + entry
                var entryInfo = stat()
                guard lstat(candidate, &entryInfo) == 0 else { return false }
                let entryKind = entryInfo.st_mode & S_IFMT
                if entryKind == S_IFLNK { return false }
                if entryKind == S_IFDIR { stack.append(candidate) }
            }
        }
        return true
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
