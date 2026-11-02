import Foundation

// Redaction for logs and transcripts.
//
// Swift port of `shared/redact.ts` (P-BF-6 native rewrite slice): the native
// tee writes every provider message verbatim, and the messages that set a
// session up carry the credentials the agent is handed. The log keeps the
// SHAPE and loses the VALUES: a redacted entry still tells you a token was
// passed, under which name, and how long it was.
//
// Behavioral parity notes:
// - Lengths reported by the mask marker count UTF-16 code units, exactly like
//   JavaScript `String.length`, so `«redacted N chars»` agrees with the TS
//   side byte for byte on every input.
// - End anchors that are `$` in the TS patterns (end of text, never before a
//   trailing newline) are spelled `\z` here: without the multiline flag both
//   `NSRegularExpression` `$` and JavaScript `$` would differ on text ending
//   in `\n`, and JavaScript is end-only.
// - The hand-rolled scans (`wrapperQuoteAt`, `walkBacktick`,
//   `walkBalancedSpan`, `bareValueEnd`) step over `Character`s and use the
//   JavaScript non-unicode `\s` set (see `isRedactSpace`), so ASCII log text
//   behaves identically and non-ASCII text can never be misread as syntax.
// - Word boundaries that are `\b` in the TS patterns (ASCII-only without
//   the unicode flag) are spelled `(?<![A-Za-z0-9_])` / `(?![A-Za-z0-9_])`
//   here: `NSRegularExpression` `\b` uses ICU Unicode word characters and
//   would miss tokens glued to non-ASCII letters that TS matches.
// - `\s` inside the patterns is spelled as the explicit JavaScript set
//   `[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]`:
//   ICU `\s` additionally matches U+0085, which JavaScript `\s` does not.
// - `"\n"` lookups that mirror `lastIndexOf("\n")` run over Unicode scalars:
//   a `Character` search cannot see the `\n` inside a CRLF grapheme cluster.

/// Namespace for the `shared/redact.ts` port. All entry points are static.
public enum Redact {
    // MARK: - Credential-shaped names and values

    /// Key names whose value is a credential. Matched case-insensitively as a
    /// substring, so KEY catches ANTHROPIC_API_KEY and x-api-key.
    private static let secretKeyParts = [
        "token", "secret", "password", "passwd", "apikey", "api_key",
        "authorization", "auth_token",
    ]

    /// `key` alone is too broad — it matches `keyboard`, `keys`, `hotkey`.
    /// Only a standalone `key`/`keys` or a `_`/`.`/`-` suffix counts, which is
    /// how every real one is spelled (API_KEY, consumer-key, xai_key).
    static func isSecretName(_ name: String) -> Bool {
        let lower = name.lowercased()
        if secretKeyParts.contains(where: { lower.contains($0) }) { return true }
        return lower.range(of: #"(^|[_.-])keys?$"#, options: .regularExpression) != nil
    }

    static func mask(_ value: String) -> String {
        "«redacted \(value.utf16.count) chars»"
    }

    // MARK: - JavaScript character classes

    /// JavaScript `\s` without the unicode flag: the exact set the TS
    /// patterns and scans test against.
    static func isRedactSpace(_ c: Character) -> Bool {
        // CRLF is one grapheme cluster (two scalars): both halves are
        // JavaScript whitespace, so the cluster counts, exactly like the
        // two units `String.trim()` and `/\s/` see in TypeScript.
        if c == "\r\n" { return true }
        guard c.unicodeScalars.count == 1, let v = c.unicodeScalars.first?.value else { return false }
        switch v {
        case 0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020, 0x00A0, 0x1680,
             0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
             0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000,
             0xFEFF:
            return true
        default:
            return false
        }
    }

    /// JavaScript `[A-Za-z0-9_]` (and `\b` word characters without /u).
    static func isWordChar(_ c: Character) -> Bool {
        guard c.unicodeScalars.count == 1, let v = c.unicodeScalars.first?.value else { return false }
        return (v >= 0x41 && v <= 0x5A) || (v >= 0x61 && v <= 0x7A)
            || (v >= 0x30 && v <= 0x39) || v == 0x5F
    }

    /// JavaScript `String.trim()`.
    static func jsTrim(_ s: String) -> String {
        var start = s.startIndex
        var end = s.endIndex
        while start < end && isRedactSpace(s[start]) { s.formIndex(after: &start) }
        while end > start && isRedactSpace(s[s.index(before: end)]) { end = s.index(before: end) }
        return String(s[start..<end])
    }

    /// Trailing-blank strip for a bare header value: `[^\S\r\n]+$` — every
    /// JavaScript whitespace except CR/LF belongs to the line, not the
    /// credential.
    static func stripTrailingBlanks(_ s: String) -> String {
        var end = s.endIndex
        while end > s.startIndex {
            let p = s.index(before: end)
            let c = s[p]
            if c == "\r" || c == "\n" || c == "\r\n" || !isRedactSpace(c) { break }
            end = p
        }
        return String(s[..<end])
    }

    // MARK: - Content-shaped secrets

    /// The credential-shape list, published so there is exactly ONE of them.
    /// Same shapes as `CREDENTIAL_TOKEN_PATTERNS` in `shared/redact.ts`;
    /// compiled without `.caseInsensitive` exactly like the TS `/g` patterns.
    public static let credentialTokenPatternSources: [String] = [
        #"(?<![A-Za-z0-9_])sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}"#,
        #"(?<![A-Za-z0-9_])xai-[A-Za-z0-9_-]{20,}"#,
        #"(?<![A-Za-z0-9_])gsk_[A-Za-z0-9]{40,}"#,
        #"(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}"#,
        #"(?<![A-Za-z0-9_])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}"#,
        #"(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}"#,
        #"(?<![A-Za-z0-9_])xox[abposr]-[A-Za-z0-9-]{20,}"#,
        #"(?<![A-Za-z0-9_])sk_(?:live|test)_[A-Za-z0-9]{8,}"#,
        #"(?<![A-Za-z0-9_])ak_[A-Za-z0-9_-]{16,}"#,
        #"(?<![A-Za-z0-9_])whsec_[A-Za-z0-9_-]{8,}"#,
        #"(?<![A-Za-z0-9_])ya29\.[A-Za-z0-9_-]{4,}"#,
        #"(?<![A-Za-z0-9_])glpat-[A-Za-z0-9_-]{8,}"#,
        #"(?<![A-Za-z0-9_])AKIA[0-9A-Z]{16}(?![A-Za-z0-9_])"#,
        #"(?<![A-Za-z0-9_])AIza[0-9A-Za-z_-]{30,}"#,
        #"(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{20,}"#,
        #"(?<![A-Za-z0-9_])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?"#,
        #"(?<![A-Za-z0-9_])st\.[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{16,}){0,3}"#,
    ]

    /// Compiled view of ``credentialTokenPatternSources``. Every entry
    /// replaces over all matches (the TS list is global-flagged).
    public static let credentialTokenPatterns: [NSRegularExpression] = credentialTokenPatternSources.map {
        // Fail fast: a bad pattern must crash in development, not silently skip redaction.
        try! NSRegularExpression(pattern: $0, options: [])
    }

    /// `Bearer <token>` standing on its own, anywhere. Case-insensitive, with
    /// the 12-character minimum that keeps "Bearer [REDACTED] are sent in the …" out.
    private static let bearerPattern = try! NSRegularExpression(
        pattern: #"((?<![A-Za-z0-9_])Bearer[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+)([A-Za-z0-9._~+/=-]{12,})"#,
        options: [.caseInsensitive]
    )

    /// An authorization value INTRODUCED BY A QUOTE — the JSON and config
    /// spelling. The quote that opened it is what ends it; end of text closes
    /// it too for a value whose closing quote was clipped away upstream.
    private static let authHeaderQuotedPattern = try! NSRegularExpression(
        pattern: #"(?<![A-Za-z0-9_])((?:proxy-)?authorization)(["']?[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*[=:][\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*)(["'])([A-Za-z][A-Za-z0-9-]{2,}[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+)?((?:\\.|(?!\3)[^\\\r\n])+)(\3|\z)"#,
        options: [.caseInsensitive]
    )

    /// A BARE authorization value — an HTTP header line, an access log, or an
    /// echoed stderr line. Runs to the end of its line, cut at the wrapper's
    /// closing quote when the header sits inside one (see `bareValueEnd`).
    private static let authHeaderBarePattern = try! NSRegularExpression(
        pattern: #"(?<![A-Za-z0-9_])((?:proxy-)?authorization)(["']?[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*[=:](?![\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*["'])[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*)([A-Za-z][A-Za-z0-9-]{2,}[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+)?([^\r\n]+)"#,
        options: [.caseInsensitive]
    )

    // MARK: - Header wrapper and shell-word scans

    /// The quote wrapping the header, if the header sits inside one.
    struct HeaderWrapper {
        var quote: Character
        /// How many backslashes the wrapper was written behind.
        var backslashes: Int
    }

    /// Looks only BEFORE the header name, on its own line: the wrapper is the
    /// quote found by stepping backwards over blanks, and it only counts when
    /// it is the odd, opening member of its pair at its own escaping level.
    static func wrapperQuoteAt(_ text: String, _ index: String.Index) -> HeaderWrapper? {
        // Mirrors `text.lastIndexOf("\n", index - 1) + 1` over UTF-16 units:
        // a `Character` search cannot see the `\n` inside a CRLF grapheme
        // cluster, so the lookup runs on `NSString`, whose unit domain is
        // exactly the one TypeScript indexes in.
        let lineStart: String.Index = {
            if index == text.startIndex { return text.startIndex }
            let ns = text as NSString
            let before = NSRange(text.startIndex..<index, in: text)
            let found = ns.range(of: "\n", options: .backwards, range: before)
            guard found.location != NSNotFound, let r = Range(found, in: text) else { return text.startIndex }
            return r.upperBound
        }()
        guard index > lineStart else { return nil }
        var at = text.index(before: index)
        while at > lineStart && isRedactSpace(text[at]) { at = text.index(before: at) }
        let quote = text[at]
        guard quote == "\"" || quote == "'" else { return nil }
        var backslashes = 0
        var b = at
        while b > lineStart && text[text.index(before: b)] == "\\" {
            backslashes += 1
            b = text.index(before: b)
        }
        var seen = 0
        var openQuote: Character?
        var i = lineStart
        while i < at {
            let ch = text[i]
            if ch == "\"" || ch == "'" {
                var run = 0
                var r = i
                while r > lineStart && text[text.index(before: r)] == "\\" {
                    run += 1
                    r = text.index(before: r)
                }
                if run == backslashes {
                    if openQuote == nil {
                        openQuote = ch
                        if ch == quote { seen += 1 }
                    } else if ch == openQuote {
                        openQuote = nil
                        if ch == quote { seen += 1 }
                    }
                }
            }
            i = text.index(after: i)
        }
        return seen % 2 == 0 ? HeaderWrapper(quote: quote, backslashes: backslashes) : nil
    }

    /// Walks a backtick command substitution to its matching close, starting
    /// AT the opening backtick. Only `` \` `` specifically escapes the close.
    static func walkBacktick(_ value: String, _ backtickIndex: String.Index) -> String.Index {
        var k = value.index(after: backtickIndex)
        while k < value.endIndex {
            if value[k] == "\\" {
                let n = value.index(after: k)
                if n < value.endIndex && value[n] == "`" {
                    k = value.index(after: n)
                    continue
                }
            }
            if value[k] == "`" { return value.index(after: k) }
            k = value.index(after: k)
        }
        return value.endIndex
    }

    /// How many levels of nested expansion `walkBalancedSpan` recurses into
    /// before falling back to flat counting. Generous against anything real,
    /// and load-bearing: untrusted output can hand this thousands of nested
    /// openers, and recursing into every one would overflow the stack.
    private static let maxExpansionNesting = 64

    /// Walks a balanced `(…)`/`{…}` span to its matching close, starting just
    /// past the OPENING bracket. Tracks quote state, backslash escapes,
    /// nested expansions as atomic units, and `case`/`esac` regions (where a
    /// bare `)` is a pattern terminator, not this level's close) for parens.
    static func walkBalancedSpan(
        _ value: String,
        _ openIndex: String.Index,
        open: Character,
        close: Character,
        budget: Int = maxExpansionNesting
    ) -> String.Index {
        var depth = 1
        var caseStack: [Int] = []
        func atWordBoundaryBefore(_ pos: String.Index) -> Bool {
            if pos <= value.startIndex { return true }
            return !isWordChar(value[value.index(before: pos)])
        }
        func atWordBoundaryAfter(_ pos: String.Index, offset: Int) -> Bool {
            guard let after = value.index(pos, offsetBy: offset, limitedBy: value.endIndex) else { return true }
            if after >= value.endIndex { return true }
            return !isWordChar(value[after])
        }
        var j = openIndex
        var innerQuote: Character?
        while j < value.endIndex && depth > 0 {
            let inner = value[j]
            if innerQuote == "'" {
                if inner == "'" { innerQuote = nil }
                j = value.index(after: j)
                continue
            }
            if innerQuote == "\"" {
                if inner == "\\" && value.index(after: j) < value.endIndex {
                    j = value.index(value.index(after: j), offsetBy: 1, limitedBy: value.endIndex) ?? value.endIndex
                    continue
                }
                if inner == "\"" {
                    innerQuote = nil
                    j = value.index(after: j)
                    continue
                }
                if budget > 0 && inner == "$" {
                    let n = value.index(after: j)
                    if n < value.endIndex && (value[n] == "(" || value[n] == "{") {
                        let nestedOpen = value[n]
                        j = walkBalancedSpan(value, value.index(after: n), open: nestedOpen, close: nestedOpen == "(" ? ")" : "}", budget: budget - 1)
                        continue
                    }
                }
                if inner == "`" {
                    j = walkBacktick(value, j)
                    continue
                }
                j = value.index(after: j)
                continue
            }
            if inner == "'" || inner == "\"" {
                innerQuote = inner
                j = value.index(after: j)
                continue
            }
            if inner == "\\" && value.index(after: j) < value.endIndex {
                j = value.index(value.index(after: j), offsetBy: 1, limitedBy: value.endIndex) ?? value.endIndex
                continue
            }
            if budget > 0 && inner == "$" {
                let n = value.index(after: j)
                if n < value.endIndex && (value[n] == "(" || value[n] == "{") {
                    let nestedOpen = value[n]
                    j = walkBalancedSpan(value, value.index(after: n), open: nestedOpen, close: nestedOpen == "(" ? ")" : "}", budget: budget - 1)
                    continue
                }
            }
            if inner == "$" {
                let n = value.index(after: j)
                if n < value.endIndex && value[n] == "'" {
                    var k = value.index(after: n)
                    while k < value.endIndex {
                        if value[k] == "\\" && value.index(after: k) < value.endIndex {
                            k = value.index(value.index(after: k), offsetBy: 1, limitedBy: value.endIndex) ?? value.endIndex
                            continue
                        }
                        if value[k] == "'" {
                            k = value.index(after: k)
                            break
                        }
                        k = value.index(after: k)
                    }
                    j = k
                    continue
                }
            }
            if inner == "`" {
                j = walkBacktick(value, j)
                continue
            }
            if budget > 0 && (inner == "<" || inner == ">") {
                let n = value.index(after: j)
                if n < value.endIndex && value[n] == "(" {
                    j = walkBalancedSpan(value, value.index(after: n), open: "(", close: ")", budget: budget - 1)
                    continue
                }
            }
            if open == "(" && close == ")" {
                if inner == "c" && value[j...].hasPrefix("case") && atWordBoundaryBefore(j) && atWordBoundaryAfter(j, offset: 4) {
                    caseStack.append(depth)
                    j = value.index(j, offsetBy: 4, limitedBy: value.endIndex) ?? value.endIndex
                    continue
                }
                if inner == "e" && value[j...].hasPrefix("esac") && atWordBoundaryBefore(j) && atWordBoundaryAfter(j, offset: 4) {
                    if caseStack.last == depth { caseStack.removeLast() }
                    j = value.index(j, offsetBy: 4, limitedBy: value.endIndex) ?? value.endIndex
                    continue
                }
                if inner == ")" && caseStack.last == depth {
                    j = value.index(after: j)
                    continue
                }
            }
            if inner == open {
                depth += 1
            } else if inner == close {
                depth -= 1
            }
            j = value.index(after: j)
        }
        return j
    }

    /// How much of a bare header value is the credential: everything up to
    /// the wrapper's closing quote, or all of it when nothing wrapped the
    /// header. The closing quote is the one written at the wrapper's OWN
    /// escaping level; a `$`/backtick run, an empty inline parameter, and a
    /// process substitution glue on and are walked forward rather than
    /// trusted as the close.
    static func bareValueEnd(_ value: String, wrapper: HeaderWrapper?) -> String.Index {
        guard let wrapper else { return value.endIndex }
        func runBefore(_ pos: String.Index) -> Int {
            var run = 0
            var q = pos
            while q > value.startIndex && value[value.index(before: q)] == "\\" {
                run += 1
                q = value.index(before: q)
            }
            return run
        }
        func isWrapperQuote(_ pos: String.Index) -> Bool {
            pos < value.endIndex && value[pos] == wrapper.quote && runBefore(pos) == wrapper.backslashes
        }
        var i = value.startIndex
        while i < value.endIndex {
            if !isWrapperQuote(i) {
                i = value.index(after: i)
                continue
            }
            let run = runBefore(i)
            let after: Character? = {
                let n = value.index(after: i)
                return n < value.endIndex ? value[n] : nil
            }()
            let before: Character? = i > value.startIndex ? value[value.index(before: i)] : nil
            let emptyInlineParam = after == wrapper.quote && before == "="
            let processSubst: Bool = {
                guard after == "<" || after == ">" else { return false }
                let n1 = value.index(after: i)
                let n2 = value.index(after: n1)
                return n2 < value.endIndex && value[n2] == "("
            }()
            if after == "$" || after == "`" || emptyInlineParam || processSubst {
                var j = value.index(after: i)
                var atBoundary = false
                while j < value.endIndex && !isWrapperQuote(j) {
                    let ch = value[j]
                    let n1 = value.index(after: j)
                    let next: Character? = n1 < value.endIndex ? value[n1] : nil
                    if (ch == "$" || ch == "<" || ch == ">") && next == "(" {
                        j = walkBalancedSpan(value, value.index(after: n1), open: "(", close: ")")
                        continue
                    }
                    if ch == "$" && next == "{" {
                        j = walkBalancedSpan(value, value.index(after: n1), open: "{", close: "}")
                        continue
                    }
                    if ch == "$" && next == "'" {
                        var k = value.index(after: n1)
                        while k < value.endIndex {
                            if value[k] == "\\" && value.index(after: k) < value.endIndex {
                                k = value.index(value.index(after: k), offsetBy: 1, limitedBy: value.endIndex) ?? value.endIndex
                                continue
                            }
                            if value[k] == "'" {
                                k = value.index(after: k)
                                break
                            }
                            k = value.index(after: k)
                        }
                        j = k
                        continue
                    }
                    if ch == "`" {
                        j = walkBacktick(value, j)
                        continue
                    }
                    if ch == "\\" && n1 < value.endIndex {
                        j = value.index(n1, offsetBy: 1, limitedBy: value.endIndex) ?? value.endIndex
                        continue
                    }
                    if isRedactSpace(ch) || ch == ";" || ch == "&" || ch == "|" {
                        atBoundary = true
                        break
                    }
                    j = n1
                }
                if !atBoundary && j < value.endIndex {
                    i = value.index(after: j)
                    continue
                }
                return value.index(i, offsetBy: -run, limitedBy: value.startIndex) ?? value.startIndex
            }
            let closes: Bool = {
                guard let after else { return true }
                if isRedactSpace(after) { return true }
                return ";|&<>)\\]},'\"".contains(after)
            }()
            if closes {
                return value.index(i, offsetBy: -run, limitedBy: value.startIndex) ?? value.startIndex
            }
            return value.endIndex
        }
        return value.endIndex
    }

    // MARK: - Schemes, placeholders, and status words

    /// Scheme words that justify a SHORT credential behind them. Spelled out
    /// here and nowhere else; the patterns never name scheme words.
    private static let shortCredentialSchemes: Set<String> = [
        "basic", "bearer", "digest", "oauth", "token", "negotiate", "ntlm",
        "hawk", "mac", "apikey", "sso",
    ]

    /// How long a value has to be before it is worth masking. A real scheme
    /// retires the eight-character floor; anything else keeps it so prose
    /// after a colon is not masked.
    static func minMaskable(_ scheme: String?) -> Int {
        guard let scheme else { return 8 }
        return shortCredentialSchemes.contains(jsTrim(scheme).lowercased()) ? 1 : 8
    }

    /// A documentation placeholder, not a credential.
    private static let placeholderWords: Set<String> = [
        "token", "tokens", "secret", "key", "apikey", "api_key", "api-key",
        "credential", "credentials", "password", "passwd", "value",
        "placeholder", "changeme", "redacted", "none", "null", "blank", "empty",
    ]

    /// Instruction verbs a sentence uses to introduce a placeholder.
    private static let placeholderLeadWords: Set<String> = [
        "use", "set", "send", "add", "include", "provide", "pass", "specify",
    ]

    /// Does the CLAUSE this match sits in open with a recognised instruction
    /// verb? Only as far back as the nearest shell separator, and `set` with
    /// an option flag right after it is a builtin call, not a lead-in.
    static func hasPlaceholderLeadIn(_ before: String) -> Bool {
        // Mirrors `before.lastIndexOf(sep) + 1` over UTF-16 units: a
        // `Character` search cannot see the `\n` inside a CRLF grapheme
        // cluster, so every separator lookup runs on `NSString`.
        var clauseStart = before.startIndex
        let ns = before as NSString
        for sep in [";", "&", "|", "\n"] {
            let found = ns.range(of: sep, options: .backwards)
            if found.location != NSNotFound,
               let r = Range(found, in: before),
               r.upperBound > clauseStart {
                clauseStart = r.upperBound
            }
        }
        let words = jsTrim(String(before[clauseStart...])).split(whereSeparator: isRedactSpace).map(String.init)
        guard let firstWord = words.first, !firstWord.isEmpty else { return false }
        let normalized = firstWord.lowercased().filter { $0 >= "a" && $0 <= "z" }
        guard placeholderLeadWords.contains(normalized) else { return false }
        if normalized == "set", words.count > 1, words[1].hasPrefix("-") { return false }
        return true
    }

    /// Words a status sentence is made of, where a credential would be.
    private static let statusWords: Set<String> = [
        "no", "not", "none", "never", "nil", "null", "missing", "absent",
        "unset", "empty", "blank", "provided", "present", "configured", "set",
        "sent", "found", "yet", "value", "header", "required", "available",
        "was", "is", "a", "any", "the",
    ]

    static func isPlaceholder(_ value: String, leadIn: Bool, precedingWord: String? = nil) -> Bool {
        let t = jsTrim(value)
        var end = t.endIndex
        while end > t.startIndex {
            let p = t.index(before: end)
            let c = t[p]
            if c == "." || c == "," || c == ";" || c == ":" || c == "!" || c == "?" { end = p } else { break }
        }
        var trimmed = String(t[..<end])
        if trimmed.isEmpty { trimmed = t }
        if let first = trimmed.first, let last = trimmed.last,
           (first == "<" || first == "{" || first == "[") && (last == ">" || last == "}" || last == "]") {
            let middle = trimmed.dropFirst().dropLast()
            if !middle.contains(where: { isRedactSpace($0) || "<>{}[]".contains($0) }) { return true }
        }
        if leadIn && !trimmed.isEmpty
            && trimmed.allSatisfy({ $0 == "x" || $0 == "X" || $0 == "*" || $0 == "." || $0 == "…" }) {
            return true
        }
        let word = trimmed.lowercased()
        var unprefixed = word
        for prefix in ["your-", "your_", "my-", "my_", "the-", "the_"] {
            if word.hasPrefix(prefix) {
                unprefixed = String(word.dropFirst(prefix.count))
                break
            }
        }
        if unprefixed != word && placeholderWords.contains(unprefixed) { return true }
        if leadIn && placeholderWords.contains(word) { return true }
        let lead = precedingWord.map { jsTrim($0).lowercased() }
        var parts = word.split(whereSeparator: isRedactSpace).map(String.init)
        if let lead, statusWords.contains(lead) { parts.insert(lead, at: 0) }
        return parts.count > 1 && parts.allSatisfy({ statusWords.contains($0) })
    }

    // MARK: - Key=value shapes and the masked marker

    private static let pemBlockPattern = try! NSRegularExpression(
        pattern: #"(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY-----|\z)"#,
        options: []
    )

    /// key=value / key: value / key="value" where the key is secret-shaped.
    /// `authorization` is deliberately NOT in this list: the AUTH_HEADER
    /// patterns own that key end to end.
    private static let keyValuePattern = try! NSRegularExpression(
        pattern: #"(?<![A-Za-z0-9_])((?:[A-Za-z0-9_-]*_)?(?:api[_-]?key|apikey|secret|token|password|passwd|auth[_-]?token|access[_-]?key|private[_-]?key)s?)(["']?[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*[=:][\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*)(["']?)([A-Za-z0-9._~+/=-]{8,})\3"#,
        options: [.caseInsensitive]
    )

    /// The same key list, for a value whose CLOSING quote was lost upstream.
    /// Anchored at end-of-text, because that is the only place a quote that
    /// never closes can legitimately come from. Single match (no /g), like TS.
    private static let keyValueUnterminatedPattern = try! NSRegularExpression(
        pattern: #"(?<![A-Za-z0-9_])((?:[A-Za-z0-9_-]*_)?(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?)(["']?[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*[=:][\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*)(["'])([^"']{8,})\z"#,
        options: [.caseInsensitive]
    )

    /// Text that is nothing but masks already. WHOLLY masked, not "contains a
    /// mask": a value that is only partly masked still has a live secret in
    /// the rest of it, so it must go through the pass again.
    private static let whollyMaskedPattern = try! NSRegularExpression(
        pattern: #"^[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF,;]*(?:«redacted \d+ chars»[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF,;]*)+\z"#,
        options: []
    )

    static func isWhollyMasked(_ s: String) -> Bool {
        let range = NSRange(s.startIndex..<s.endIndex, in: s)
        return whollyMaskedPattern.firstMatch(in: s, options: [], range: range) != nil
    }

    // MARK: - Replacement engine

    /// Applies a global pattern with a replacer closure, mirroring
    /// `String.replace` with a `/g` regex and a function: matches are found
    /// up front in the stage's input, the replacer sees the 1-based capture
    /// groups (`nil` when a group did not participate), the match range, and
    /// the whole stage input, and returning `nil` keeps the original text.
    static func replaceAllMatches(
        in text: String,
        _ regex: NSRegularExpression,
        _ replacer: ([String?], Range<String.Index>, String) -> String?
    ) -> String {
        let fullRange = NSRange(text.startIndex..<text.endIndex, in: text)
        let matches = regex.matches(in: text, options: [], range: fullRange)
        if matches.isEmpty { return text }
        var result = ""
        result.reserveCapacity(text.count)
        var cursor = text.startIndex
        for m in matches {
            guard let r = Range(m.range, in: text) else { continue }
            result += text[cursor..<r.lowerBound]
            var groups: [String?] = []
            groups.reserveCapacity(max(0, m.numberOfRanges - 1))
            for idx in 1..<m.numberOfRanges {
                let gr = m.range(at: idx)
                if gr.location == NSNotFound {
                    groups.append(nil)
                } else if let sr = Range(gr, in: text) {
                    groups.append(String(text[sr]))
                } else {
                    groups.append(nil)
                }
            }
            result += replacer(groups, r, text) ?? String(text[r])
            cursor = r.upperBound
        }
        result += text[cursor...]
        return result
    }

    // MARK: - The content pass

    /// Deep redaction of one string: PEM blocks, authorization headers, token
    /// shapes, Bearer [REDACTED], and secret-shaped key=value pairs, in the order the
    /// TS pass applies them (the header pass runs before the prefix pass so a
    /// partly-masked value never trips the later one).
    public static func redactSecretsInText(_ text: String) -> String {
        guard text.utf16.count >= 8 else { return text }
        var out = text
        out = replaceAllMatches(in: out, pemBlockPattern) { groups, _, _ in
            let open = groups[0] ?? ""
            let body = groups[1] ?? ""
            let close = groups[2] ?? ""
            let trimmed = jsTrim(body)
            if isWhollyMasked(trimmed) { return nil }
            if trimmed.isEmpty && close.isEmpty { return open }
            let masked = mask(trimmed)
            return close.isEmpty ? "\(open)\n\(masked)" : "\(open)\n\(masked)\n\(close)"
        }
        // The authorization header goes FIRST, before the prefix pass.
        // Quote-introduced first, bare second: neither can claim the other's
        // header, so the order only reads in rule order.
        out = replaceAllMatches(in: out, authHeaderQuotedPattern) { groups, matchRange, whole in
            let key = groups[0] ?? ""
            let sep = groups[1] ?? ""
            let quote = groups[2] ?? ""
            let scheme = groups[3]
            let value = groups[4] ?? ""
            let close = groups[5] ?? ""
            // A value that ran to the end of the text lost its closing quote
            // to a clip, and the scheme goes INSIDE the mask on that path
            // alone — the only shape KEY_VALUE_UNTERMINATED still sees.
            let body = close.isEmpty ? (scheme ?? "") + value : value
            if body.utf16.count < minMaskable(scheme)
                || isWhollyMasked(body)
                || isPlaceholder(
                    body,
                    leadIn: hasPlaceholderLeadIn(String(whole[..<matchRange.lowerBound])),
                    precedingWord: close.isEmpty ? nil : scheme
                ) {
                return nil
            }
            let kept = close.isEmpty ? "" : (scheme ?? "")
            return "\(key)\(sep)\(quote)\(kept)\(mask(body))\(close)"
        }
        out = replaceAllMatches(in: out, authHeaderBarePattern) { groups, matchRange, whole in
            let key = groups[0] ?? ""
            let sep = groups[1] ?? ""
            let scheme = groups[2]
            let value = groups[3] ?? ""
            let end = bareValueEnd(value, wrapper: wrapperQuoteAt(whole, matchRange.lowerBound))
            var credEnd = end
            while credEnd > value.startIndex {
                let p = value.index(before: credEnd)
                let c = value[p]
                if c == "\r" || c == "\n" || c == "\r\n" || !isRedactSpace(c) { break }
                credEnd = p
            }
            let credential = String(value[..<credEnd])
            if credential.utf16.count < minMaskable(scheme)
                || isWhollyMasked(credential)
                || isPlaceholder(
                    credential,
                    leadIn: hasPlaceholderLeadIn(String(whole[..<matchRange.lowerBound])),
                    precedingWord: scheme
                ) {
                return nil
            }
            return "\(key)\(sep)\(scheme ?? "")\(mask(credential))\(value[credEnd...])"
        }
        for re in credentialTokenPatterns {
            out = replaceAllMatches(in: out, re) { _, matchRange, whole in
                mask(String(whole[matchRange]))
            }
        }
        out = replaceAllMatches(in: out, bearerPattern) { groups, matchRange, whole in
            let lead = groups[0] ?? ""
            let tok = groups[1] ?? ""
            if isPlaceholder(tok, leadIn: hasPlaceholderLeadIn(String(whole[..<matchRange.lowerBound]))) {
                return nil
            }
            return "\(lead)\(mask(tok))"
        }
        out = replaceAllMatches(in: out, keyValuePattern) { groups, _, _ in
            let key = groups[0] ?? ""
            let sep = groups[1] ?? ""
            let quote = groups[2] ?? ""
            let value = groups[3] ?? ""
            return "\(key)\(sep)\(quote)\(mask(value))\(quote)"
        }
        let unterminatedRange = NSRange(out.startIndex..<out.endIndex, in: out)
        if let m = keyValueUnterminatedPattern.firstMatch(in: out, options: [], range: unterminatedRange),
           let r = Range(m.range, in: out) {
            var groups: [String?] = []
            for idx in 1..<m.numberOfRanges {
                let gr = m.range(at: idx)
                if gr.location == NSNotFound {
                    groups.append(nil)
                } else if let sr = Range(gr, in: out) {
                    groups.append(String(out[sr]))
                } else {
                    groups.append(nil)
                }
            }
            let value = groups.count > 3 ? (groups[3] ?? "") : ""
            if !isWhollyMasked(value) {
                let key = groups.count > 0 ? (groups[0] ?? "") : ""
                let sep = groups.count > 1 ? (groups[1] ?? "") : ""
                let quote = groups.count > 2 ? (groups[2] ?? "") : ""
                out = out.replacingCharacters(in: r, with: "\(key)\(sep)\(quote)\(mask(value))")
            }
        }
        return out
    }

    // MARK: - The tree walk both public deep redactors share

    /// `text` is what every string that is NOT under a secret-shaped key goes
    /// through. A secret-shaped key is masked outright either way.
    private static func redactTree(_ input: Any?, depth: Int, text: (String) -> String) -> Any? {
        if let s = input as? String { return text(s) }
        if depth > 12 || input == nil { return input }
        if input is NSNull { return input }
        if let arr = input as? [Any?] {
            return arr.map { item -> Any? in
                if let dict = item as? [String: Any],
                   let name = dict["name"] as? String,
                   let entryValue = dict["value"] as? String {
                    var entry = dict
                    // A non-secret-shaped name does not clear the value of
                    // suspicion: the same content pass every other string in
                    // this tree gets catches a credential stashed under an
                    // ordinary-looking name.
                    entry["value"] = isSecretName(name) ? mask(entryValue) : text(entryValue)
                    return entry
                }
                return redactTree(item, depth: depth + 1, text: text)
            }
        }
        if let arr = input as? [Any] {
            return arr.map { item -> Any? in
                if let dict = item as? [String: Any],
                   let name = dict["name"] as? String,
                   let entryValue = dict["value"] as? String {
                    var entry = dict
                    entry["value"] = isSecretName(name) ? mask(entryValue) : text(entryValue)
                    return entry
                }
                return redactTree(item, depth: depth + 1, text: text)
            }
        }
        if let dict = input as? [String: Any?] {
            var out: [String: Any?] = [:]
            for (key, value) in dict {
                if let s = value as? String, isSecretName(key) {
                    out[key] = mask(s)
                    continue
                }
                out[key] = redactTree(value, depth: depth + 1, text: text)
            }
            return out
        }
        if let dict = input as? [String: Any] {
            var out: [String: Any] = [:]
            for (key, value) in dict {
                if let s = value as? String, isSecretName(key) {
                    out[key] = mask(s)
                    continue
                }
                out[key] = redactTree(value, depth: depth + 1, text: text) as Any
            }
            return out
        }
        return input
    }

    /// Deep copy with credential VALUES replaced. Handles the two shapes that
    /// actually carry them: a plain object of env vars (`{KEY: "v"}`) and the
    /// ACP wire shape (env: `[{name, value}]`). Anything unrecognised is
    /// copied as-is.
    public static func redactSecrets(_ input: Any?, depth: Int = 0) -> Any? {
        redactTree(input, depth: depth, text: redactSecretsInText)
    }

    /// The same tree walk with the caller's own content pass for every string
    /// that is not under a secret-shaped key.
    public static func redactSecretsWith(_ input: Any?, text: (String) -> String) -> Any? {
        redactTree(input, depth: 0, text: text)
    }

    // MARK: - The log tee cap

    /// Cap on how much of one string the canonical event log keeps, in UTF-16
    /// code units — the same unit `String.length` (and the marker) uses.
    public static let logTeeMaxStringChars = 256 * 1024

    /// Content pass for the log tee: redact, THEN cut. The order is
    /// load-bearing — cutting first would end the string in a marker instead,
    /// and a secret straddling the boundary would ship its prefix in the
    /// clear. The elided tail is never written, redacted or not.
    public static func redactSecretsInLogText(_ text: String, maxChars: Int = logTeeMaxStringChars) -> String {
        if text.utf16.count <= maxChars { return redactSecretsInText(text) }
        let elided = text.utf16.count - maxChars
        // Slice in UTF-16 units like `String.slice`; a boundary that lands
        // inside a surrogate pair drops the dangling high half (a Swift
        // string cannot hold the lone surrogate JavaScript would keep).
        var headUnits = Array(text.utf16.prefix(maxChars))
        if let last = headUnits.last, (0xD800...0xDBFF).contains(last) { headUnits.removeLast() }
        let head = String(decoding: headUnits, as: UTF16.self)
        return "\(redactSecretsInText(head))[… \(elided) characters elided from log]"
    }

    /// `redactSecrets` for a destination that is a log file rather than a
    /// live consumer: identical tree, identical masking, plus a per-string
    /// length cap so the cost of redacting one event is bounded by the cap.
    public static func redactSecretsForLog(_ input: Any?, maxChars: Int = logTeeMaxStringChars) -> Any? {
        redactTree(input, depth: 0, text: { redactSecretsInLogText($0, maxChars: maxChars) })
    }
}
