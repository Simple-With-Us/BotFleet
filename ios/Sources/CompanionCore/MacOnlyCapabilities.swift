import Foundation

/// Host platform reported on placement and resource wire contracts.
public enum MacOnlyCapabilityPlatform: String, Codable, Equatable, Sendable {
    case darwin
    case linux
}

/// Why a command requires a host capability, in the words the placer records.
///
/// Mirrors `DerivedCapability` in `shared/mac-only-capabilities.ts`.
public struct DerivedCapability: Equatable, Sendable {
    public let capability: String
    /// The command word (or pair) that derived the requirement, e.g. `xcodebuild` or `swift build`.
    public let command: String
    /// The placement reason recorded on the job, e.g. `"needs xcodebuild"`.
    public let reason: String

    public init(capability: String = "macos", command: String, reason: String? = nil) {
        self.capability = capability
        self.command = command
        self.reason = reason ?? "needs \(command)"
    }
}

/// The shared Mac-only command table (native server mode plan, slice 8a).
///
/// A command whose first word is in this table needs the `macos` capability,
/// so placement never considers a Linux server for it.  The table is small and
/// deliberate: a wrong entry in either direction is visible because the placer
/// records `"needs <command>"` as the placement reason, and an explicit pin
/// overrides the derivation.  Mirrors `shared/mac-only-capabilities.ts` the way
/// `BotComputers` mirrors the computer table; the two copies must name the same
/// commands.
public enum MacOnlyCapabilities {
    /// Commands that only exist, or only act on this Mac, under macOS.
    public static let macOnlyCommands: [String] = [
        "xcodebuild",
        "xcrun",
        "simctl",
        "codesign",
        "notarytool",
        "osascript",
        "open",
    ]

    /// Map of each Mac-only command to the placement reason the controller records.
    public static let macOnlyCommandReasons: [String: String] = Dictionary(
        uniqueKeysWithValues: macOnlyCommands.map { ($0, "needs \($0)") }
    )

    private static let sudoLike: Set<String> = ["sudo", "doas"]
    /// `sudo` flags that consume the following word (`sudo -u worker …`).
    private static let sudoValueFlags: Set<String> = ["-u", "-g", "-U", "-h", "-p", "-r", "-t", "-C", "-D"]
    private static let shellLike: Set<String> = ["sh", "bash", "dash", "zsh", "ksh"]

    /// The first command word of a shell command: past leading `VAR=value`
    /// assignments and any directory part (`/usr/bin/xcodebuild` counts).
    public static func firstCommandWord(_ command: String) -> String? {
        firstTwoWords(command).first
    }

    /// A path that only exists on a Mac: a home folder under `/Users/`.
    public static func isMacPath(_ path: String?) -> Bool {
        guard let path else { return false }
        return path == "/Users" || path.hasPrefix("/Users/")
    }

    /// The capability a command needs by derivation, or `nil` when it is
    /// automatic.  `swift build` counts only under a Mac path, because the same
    /// words build a Linux package on the server.
    public static func derivedCapability(_ command: String, cwd: String? = nil) -> DerivedCapability? {
        deriveFromCommand(command, cwd: cwd, depth: 0)
    }

    /// Overload matching `derivedCapability(forCommand:cwd:)` call sites.
    public static func derivedCapability(forCommand command: String, cwd: String? = nil) -> DerivedCapability? {
        deriveFromCommand(command, cwd: cwd, depth: 0)
    }

    /// Whether a host reporting `capabilities` may run this command at all.
    public static func hostCanRunCommand<C: Collection>(
        capabilities: C,
        command: String,
        cwd: String? = nil
    ) -> Bool where C.Element == String {
        guard let derived = derivedCapability(command, cwd: cwd) else { return true }
        return capabilities.contains(derived.capability)
    }

    /// Whether a host on `hostPlatform` (`"darwin"` or `"linux"`) may run this
    /// command, returning the derived requirement when one exists.
    public static func hostCanRunCommand(
        hostPlatform: String,
        command: String,
        cwd: String? = nil
    ) -> (allowed: Bool, required: DerivedCapability?) {
        let derived = derivedCapability(command, cwd: cwd)
        guard let derived else { return (true, nil) }
        let isMac = hostPlatform == MacOnlyCapabilityPlatform.darwin.rawValue || hostPlatform == "macos"
        return (isMac, derived)
    }

    /// Typed overload of `hostCanRunCommand(hostPlatform:command:cwd:)`.
    public static func hostCanRunCommand(
        hostPlatform: MacOnlyCapabilityPlatform,
        command: String,
        cwd: String? = nil
    ) -> (allowed: Bool, required: DerivedCapability?) {
        hostCanRunCommand(hostPlatform: hostPlatform.rawValue, command: command, cwd: cwd)
    }

    // MARK: - Shell Parsing Helpers

    private static func firstTwoWords(_ command: String) -> [String] {
        let separators = CharacterSet(charactersIn: ";&|")
        let head: String
        if let range = command.rangeOfCharacter(from: separators) {
            head = String(command[..<range.lowerBound])
        } else {
            head = command
        }
        var words: [String] = []
        let tokens = head
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
        for token in tokens {
            if isEnvAssignment(token) { continue }
            let lastComponent = headWord(token)
            let stripped = stripLeadingAndTrailingSingleQuoteChar(lastComponent)
            words.append(stripped)
            if words.count == 2 { break }
        }
        return words
    }

    private static func stripLeadingAndTrailingSingleQuoteChar(_ value: String) -> String {
        var result = value
        if let first = result.first, first == "'" || first == "\"" {
            result.removeFirst()
        }
        if let last = result.last, last == "'" || last == "\"" {
            result.removeLast()
        }
        return result
    }

    private static func splitSegments(_ command: String) -> [String] {
        let separators = CharacterSet(charactersIn: ";&|\n")
        return command
            .components(separatedBy: separators)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private static func tokenize(_ segment: String) -> [String] {
        var tokens: [String] = []
        var current = ""
        var quote: Character?
        for ch in segment {
            if let activeQuote = quote {
                if ch == activeQuote {
                    quote = nil
                } else {
                    current.append(ch)
                }
            } else if ch == "'" || ch == "\"" {
                quote = ch
            } else if ch == " " || ch == "\t" {
                if !current.isEmpty {
                    tokens.append(current)
                    current = ""
                }
            } else {
                current.append(ch)
            }
        }
        if !current.isEmpty {
            tokens.append(current)
        }
        return tokens
    }

    private static func headWord(_ token: String) -> String {
        token.split(separator: "/", omittingEmptySubsequences: true).last.map(String.init) ?? token
    }

    private static func isEnvAssignment(_ token: String) -> Bool {
        guard let eqIndex = token.firstIndex(of: "="), eqIndex > token.startIndex else {
            return false
        }
        let name = token[..<eqIndex]
        guard let first = name.first, first.isASCII && (first.isLetter || first == "_") else {
            return false
        }
        return name.dropFirst().allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }
    }

    private enum ResolvedSegment {
        case words([String])
        case script(String)
    }

    private static func resolveSegment(_ tokens: [String]) -> ResolvedSegment? {
        var rest = ArraySlice(tokens)
        for _ in 0..<4 {
            while let first = rest.first, isEnvAssignment(first) {
                rest.removeFirst()
            }
            guard let firstToken = rest.first else { return nil }
            let head = headWord(firstToken)
            if sudoLike.contains(head) {
                rest.removeFirst()
                while let flag = rest.first, flag.hasPrefix("-"), flag.count > 1, flag != "--" {
                    rest.removeFirst()
                    if sudoValueFlags.contains(flag), !rest.isEmpty {
                        rest.removeFirst()
                    }
                }
                if rest.first == "--" {
                    rest.removeFirst()
                }
                continue
            }
            if head == "env" {
                rest.removeFirst()
                while let flag = rest.first,
                      flag == "--" || flag.hasPrefix("-") || isEnvAssignment(flag) {
                    rest.removeFirst()
                    if (flag == "-u" || flag == "--unset"), !rest.isEmpty {
                        rest.removeFirst()
                    }
                    if flag == "--" {
                        break
                    }
                }
                continue
            }
            if shellLike.contains(head) {
                rest.removeFirst()
                while let first = rest.first, isEnvAssignment(first) {
                    rest.removeFirst()
                }
                guard let flag = rest.first else { return nil }
                if flag.hasPrefix("-"), flag.contains("c"), rest.count >= 2 {
                    let scriptIndex = rest.index(after: rest.startIndex)
                    return .script(rest[scriptIndex])
                }
                return nil
            }
            return .words(Array(rest.prefix(2)).map(headWord))
        }
        return nil
    }

    private static func deriveFromCommand(_ command: String, cwd: String?, depth: Int) -> DerivedCapability? {
        guard depth <= 4 else { return nil }
        for segment in splitSegments(command) {
            guard let resolved = resolveSegment(tokenize(segment)) else { continue }
            switch resolved {
            case .script(let script):
                if let hit = deriveFromCommand(script, cwd: cwd, depth: depth + 1) {
                    return hit
                }
            case .words(let words):
                guard let first = words.first, !first.isEmpty else { continue }
                let second = words.count > 1 ? words[1] : nil
                if macOnlyCommands.contains(first) {
                    return DerivedCapability(capability: "macos", command: first, reason: "needs \(first)")
                }
                if first == "swift", second == "build", isMacPath(cwd) {
                    return DerivedCapability(capability: "macos", command: "swift build", reason: "needs swift build")
                }
            }
        }
        return nil
    }
}
