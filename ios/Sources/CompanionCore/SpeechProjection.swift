// What an on-device voice says, and the small pure rules that keep a long
// read going.
//
// The harness projects every reply for speech (`speakable` and
// `toUtterances` in server/tts/speech-text.ts) and returns those utterances
// from POST /audio, even for an Apple Personal Voice.  The phone speaks
// them.  `SpeechProjection.segments(fromReply:)` is the fallback for when
// that request fails: it follows the same rules closely enough that a
// reply never comes out as raw markdown, URLs, or code, but it is not a
// parity contract, and the harness projection always wins when it answers.
import Foundation

/// One utterance for an on-device voice.
public struct SpeechSegment: Equatable, Sendable {
    public var text: String
    /// The last utterance of a paragraph.  A voice pauses a little longer
    /// after it than between sentences.
    public var endsParagraph: Bool

    public init(text: String, endsParagraph: Bool = false) {
        self.text = text
        self.endsParagraph = endsParagraph
    }
}

public enum SpeechProjection {
    /// The harness caps an utterance at 320 characters; stay there.
    public static let maxSegmentCharacters = 320

    /// The harness's utterances, packed into fewer, longer utterances for a
    /// synthesizer.  The harness collapses paragraphs before splitting, so
    /// these carry no paragraph breaks.
    public static func segments(
        fromUtterances utterances: [String],
        maxCharacters: Int = maxSegmentCharacters
    ) -> [SpeechSegment] {
        PersonalVoiceChunker.pack(utterances, maxCharacters: maxCharacters)
            .map { SpeechSegment(text: $0) }
    }

    /// A stored reply, projected for speech on this device: attachment
    /// markers and voice-summary tags removed, paragraphs split first, then
    /// sentences, each utterance at most `maxCharacters`.
    public static func segments(
        fromReply reply: String,
        maxCharacters: Int = maxSegmentCharacters
    ) -> [SpeechSegment] {
        var text = ChatAttachments.split(reply).display
        text = spokenReply(text)
        text = text.replacingOccurrences(of: "\r\n", with: "\n")
        // A fence can hold blank lines, so describe it before splitting on
        // them, and give the description a paragraph of its own.
        text = replacingFences(in: text) { "\n\n\(describeCodeBlock($0))\n\n" }

        var segments: [SpeechSegment] = []
        for paragraph in paragraphs(of: text) {
            let spoken = speakable(paragraph)
            guard !spoken.isEmpty else { continue }
            let chunks = PersonalVoiceChunker.chunk(text: spoken, maxCharacters: maxCharacters)
            for (index, chunk) in chunks.enumerated() {
                segments.append(SpeechSegment(text: chunk, endsParagraph: index == chunks.count - 1))
            }
        }
        return segments
    }

    /// The voice half of a reply written with the voice-summary protocol,
    /// otherwise the reply with any stray protocol tags removed.  Mirrors
    /// `spokenReply` in shared/voice-summary.ts.
    public static func spokenReply(_ text: String) -> String {
        guard !text.isEmpty else { return "" }
        let tags = #"\[/?(?:voice_summary|written_answer)\]"#
        if let groups = firstMatch(
            #"\[voice_summary\]\s*([\s\S]*?)\s*\[/voice_summary\]\s*\[written_answer\]\s*([\s\S]*?)(?:\[/written_answer\])?\s*\z"#,
            in: text, options: [.caseInsensitive]
        ) {
            let voice = replace(tags, in: groups[1] ?? "", options: [.caseInsensitive], template: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let written = replace(tags, in: groups[2] ?? "", options: [.caseInsensitive], template: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !voice.isEmpty, !written.isEmpty { return voice }
        }
        if let groups = firstMatch(
            #"\[voice_summary\]\s*([\s\S]*?)(?:\[/voice_summary\]|\[written_answer\]|\z)"#,
            in: text, options: [.caseInsensitive]
        ), let partial = groups[1], !partial.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return replace(tags, in: partial, options: [.caseInsensitive], template: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return replace(tags, in: text, options: [.caseInsensitive], template: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The written half of a reply: what the bubble's text is made from,
    /// and the text the harness's karaoke spans index.  Mirrors
    /// `writtenReply` in shared/voice-summary.ts character for character
    /// (JavaScript's `\s` and `trim()`), because a client compares its
    /// UTF-16 length with the spans' `sourceLength` before trusting them.
    public static func writtenReply(_ text: String) -> String {
        guard !text.isEmpty else { return "" }
        if let split = splitVoiceSummary(text) { return split.written }
        return stripVoiceSummaryTags(text)
    }

    /// JavaScript's `\s` (and the set `String.prototype.trim` removes).
    private static let jsSpace = #"[\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]"#
    private static let jsTrimSet = CharacterSet(charactersIn: "\t\n\u{0B}\u{0C}\r \u{A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")
    private static let protocolTags = #"\[/?(?:voice_summary|written_answer)\]"#

    private static func jsTrim(_ text: String) -> String {
        text.trimmingCharacters(in: jsTrimSet)
    }

    /// `splitVoiceSummary` in shared/voice-summary.ts.
    private static func splitVoiceSummary(_ text: String) -> (voice: String, written: String)? {
        let s = jsSpace
        guard let groups = firstMatch(
            #"\[voice_summary\]"# + s + #"*([\s\S]*?)"# + s + #"*\[/voice_summary\]"# + s + #"*\[written_answer\]"# + s + #"*([\s\S]*?)(?:\[/written_answer\])?"# + s + #"*\z"#,
            in: text, options: [.caseInsensitive]
        ) else { return nil }
        let rawVoice = groups[1] ?? ""
        let rawWritten = groups[2] ?? ""
        guard !jsTrim(rawVoice).isEmpty, !jsTrim(rawWritten).isEmpty else { return nil }
        let voice = jsTrim(replace(protocolTags, in: rawVoice, options: [.caseInsensitive], template: ""))
        let written = jsTrim(replace(protocolTags, in: rawWritten, options: [.caseInsensitive], template: ""))
        guard !voice.isEmpty, !written.isEmpty else { return nil }
        return (voice, written)
    }

    /// `stripVoiceSummaryTags` in shared/voice-summary.ts: only a reply that
    /// begins with the protocol is touched.
    private static func stripVoiceSummaryTags(_ text: String) -> String {
        guard !text.isEmpty else { return "" }
        if let split = splitVoiceSummary(text) { return split.written }
        let s = jsSpace
        guard firstMatch(#"\A"# + s + #"*\[voice_summary\]"#, in: text, options: [.caseInsensitive]) != nil else { return text }
        var clean = text
        if let groups = firstMatch(
            #"\[written_answer\]([\s\S]*?)(?:\[/written_answer\]"# + s + #"*)?\z"#,
            in: clean, options: [.caseInsensitive]
        ) {
            clean = groups[1] ?? ""
        } else if let lead = regex(#"\A"# + s + #"*\[voice_summary\][\s\S]*?(?:\[/voice_summary\]"# + s + #"*|\z)"#, [.caseInsensitive]),
                  let match = lead.firstMatch(in: clean, options: [], range: NSRange(location: 0, length: (clean as NSString).length)) {
            clean = (clean as NSString).replacingCharacters(in: match.range, with: "")
        }
        clean = jsTrim(replace(protocolTags, in: clean, options: [.caseInsensitive], template: ""))
        return clean.isEmpty ? text : clean
    }

    /// Markdown to a line a voice can read.  Follows `speakable` in
    /// server/tts/speech-text.ts rule for rule: say the prose, name the
    /// artifacts, drop the syntax.
    public static func speakable(_ input: String) -> String {
        guard !input.isEmpty else { return "" }
        var text = replacingFences(in: input) { ". \(describeCodeBlock($0)) " }

        // images before links: the syntax differs by one character
        text = replace(#"!\[([^\]]*)\]\([^)]*\)"#, in: text) { groups in
            let alt = groups[1] ?? ""
            return alt.isEmpty ? ". (an image) " : ". (image: \(alt)) "
        }
        text = replace(#"\[([^\]]+)\]\([^)]*\)"#, in: text, template: "$1")
        text = replace(#"<https?://[^>\s]+>"#, in: text, template: " a link ")
        text = replace(#"\bhttps?://\S+"#, in: text, template: " a link ")

        // tables: drop the separator row, read a row as a list of cells.
        // Line-local (spaces and tabs, not \s) so one row never swallows
        // the line break before the next.
        text = replace(#"^[ \t]*\|?[ \t:-]*\|[ \t|:-]*$"#, in: text, options: [.anchorsMatchLines], template: "")
        text = replace(#"^[ \t]*\|(.+)\|[ \t]*$"#, in: text, options: [.anchorsMatchLines]) { groups in
            (groups[1] ?? "")
                .split(separator: "|")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
                .joined(separator: ", ")
        }

        // inline code: short identifiers carry meaning, long ones do not
        text = replace("`([^`\\n]+)`", in: text) { groups in
            let code = groups[1] ?? ""
            return (code as NSString).length <= 40 ? code : " that snippet "
        }

        // headings become sentences so the voice pauses
        text = replace(#"^\s{0,3}#{1,6}\s+(.*)$"#, in: text, options: [.anchorsMatchLines]) { groups in
            let head = groups[1] ?? ""
            if firstMatch(#"[.!?:;]\s*$"#, in: head) != nil { return head }
            return head.trimmingCharacters(in: .whitespaces) + "."
        }

        // list scaffolding, quotes, rules
        text = replace(#"^\s*[-*+]\s+"#, in: text, options: [.anchorsMatchLines], template: "")
        text = replace(#"^\s*\d+[.)]\s+"#, in: text, options: [.anchorsMatchLines], template: "")
        text = replace(#"^\s*>\s?"#, in: text, options: [.anchorsMatchLines], template: "")
        text = replace(#"^\s*(?:[-*_]\s*){3,}$"#, in: text, options: [.anchorsMatchLines], template: "")

        // emphasis and strikethrough markers
        text = replace(#"(\*\*|__)(.*?)\1"#, in: text, template: "$2")
        text = replace(#"(\*|_)(?=\S)(.*?)(?<=\S)\1"#, in: text, template: "$2")
        text = replace(#"~~(.*?)~~"#, in: text, template: "$1")

        // checkboxes read as literal brackets otherwise
        text = replace(#"\[[ xX]\]\s*"#, in: text, template: "")

        // a path's directories are for the eye
        text = replace(#"(?:[\w.@-]+/){1,}([\w.-]+\.\w{1,6})\b"#, in: text, template: "$1")

        // emoji and pictographs: a voice ignores them or names them
        text = replace(
            #"[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}\x{FE00}-\x{FE0F}\x{2190}-\x{21FF}\x{2B00}-\x{2BFF}]"#,
            in: text, template: ""
        )

        // HTML entities read as the character the bubble shows; the
        // sentence gap `.&nbsp; ` is a pause, not the word "nbsp"
        text = replace(#"(?i)&(nbsp|#160|#xa0|amp|lt|gt|quot|apos|#39);"#, in: text) { groups in
            SpeechSpans.spokenEntity(groups[1] ?? "")
        }

        // line breaks become audible pauses
        text = replace(#"\n{2,}"#, in: text, template: ". ")
        text = replace(#"\n"#, in: text, template: ". ")

        // tidy the punctuation the substitutions pile up
        text = replace(#"\s+"#, in: text, template: " ")
        text = replace(#"\s+([.,!?;:])"#, in: text, template: "$1")
        text = replace(#"(?:\.\s*){2,}"#, in: text, template: ". ")
        text = replace(#",\s*\."#, in: text, template: ".")
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)

        // nothing to say means nothing to send, not a lone full stop
        return firstMatch(#"[\p{L}\p{N}]"#, in: text) == nil ? "" : text
    }

    // MARK: - Helpers

    private static let spokenLanguages: [String: String] = [
        "ts": "TypeScript", "tsx": "TypeScript", "js": "JavaScript", "jsx": "JavaScript",
        "py": "Python", "sh": "shell", "bash": "shell", "zsh": "shell", "json": "JSON",
        "yml": "YAML", "yaml": "YAML", "sql": "SQL", "rs": "Rust", "go": "Go",
        "swift": "Swift", "diff": "diff",
    ]

    /// "(a Swift code block)" from a fence's info string.
    static func describeCodeBlock(_ info: String) -> String {
        let first = info.trimmingCharacters(in: .whitespaces)
            .split(whereSeparator: { $0 == " " || $0 == "\t" }).first.map(String.init) ?? ""
        let lang = first.filter { $0.isLetter || $0.isNumber || $0 == "+" || $0 == "#" }.lowercased()
        if let name = spokenLanguages[lang] { return "(a \(name) code block)" }
        return "(a code block)"
    }

    private static func replacingFences(in text: String, with describe: (String) -> String) -> String {
        var out = replace("```([^\\n]*)\\n[\\s\\S]*?(?:```|\\z)", in: text) { describe($0[1] ?? "") }
        out = replace("~~~([^\\n]*)\\n[\\s\\S]*?(?:~~~|\\z)", in: out) { describe($0[1] ?? "") }
        return out
    }

    private static func paragraphs(of text: String) -> [String] {
        let marker = "\u{0000}"
        return replace(#"\n[ \t]*\n\s*"#, in: text, template: marker)
            .components(separatedBy: marker)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private static func regex(_ pattern: String, _ options: NSRegularExpression.Options) -> NSRegularExpression? {
        try? NSRegularExpression(pattern: pattern, options: options)
    }

    private static func replace(
        _ pattern: String,
        in text: String,
        options: NSRegularExpression.Options = [],
        template: String
    ) -> String {
        guard let regex = regex(pattern, options) else { return text }
        let range = NSRange(location: 0, length: (text as NSString).length)
        return regex.stringByReplacingMatches(in: text, options: [], range: range, withTemplate: template)
    }

    private static func replace(
        _ pattern: String,
        in text: String,
        options: NSRegularExpression.Options = [],
        transform: ([String?]) -> String
    ) -> String {
        guard let regex = regex(pattern, options) else { return text }
        let ns = text as NSString
        var result = ""
        var cursor = 0
        for match in regex.matches(in: text, options: [], range: NSRange(location: 0, length: ns.length)) {
            result += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            result += transform(groups(of: match, in: ns))
            cursor = match.range.location + match.range.length
        }
        result += ns.substring(from: cursor)
        return result
    }

    private static func firstMatch(
        _ pattern: String,
        in text: String,
        options: NSRegularExpression.Options = []
    ) -> [String?]? {
        guard let regex = regex(pattern, options) else { return nil }
        let ns = text as NSString
        guard let match = regex.firstMatch(in: text, options: [], range: NSRange(location: 0, length: ns.length)) else {
            return nil
        }
        return groups(of: match, in: ns)
    }

    private static func groups(of match: NSTextCheckingResult, in ns: NSString) -> [String?] {
        (0..<match.numberOfRanges).map { index in
            let range = match.range(at: index)
            return range.location == NSNotFound ? nil : ns.substring(with: range)
        }
    }
}

/// Where to pick up after AVSpeechSynthesizer cancels an utterance on its
/// own.  The same rule as `remainderAfterCancel` in the Mac speech helper:
/// `nextRangeLocation` is the UTF-16 start of the word that was about to be
/// spoken (from willSpeakRange).  Zero means nothing audible was committed,
/// so the whole utterance is retried; otherwise the in-progress word may be
/// heard once more, and nothing before it is.
public enum PersonalVoiceResume {
    public static func remainder(of text: String, nextRangeLocation: Int) -> String {
        let ns = text as NSString
        let location = min(max(nextRangeLocation, 0), ns.length)
        if location == 0 { return text }
        if location >= ns.length { return "" }
        // Never start inside a composed character (an emoji's surrogate pair).
        let start = ns.rangeOfComposedCharacterSequence(at: location).location
        return ns.substring(from: start)
    }
}

/// When to give up on an utterance that stopped reporting progress.
///
/// Whether willSpeakRange fires for every Personal Voice is not verified, so
/// silence alone cannot mean a stall: a long utterance may report nothing
/// between didStart and didFinish.  The deadline is therefore the later of
/// "no progress for `stallSeconds`" and "twice the expected read time, plus
/// slack".  Paused time (an interruption) does not count; the caller moves
/// `startedAt` forward by the pause.
public enum SpeechWatchdog {
    public static let stallSeconds: TimeInterval = 10
    /// A deliberately slow read: about 14 characters a second at the default
    /// rate, doubled, plus five seconds for the synthesizer to start.
    public static func expectedSeconds(forUTF16Length length: Int) -> TimeInterval {
        Double(max(length, 0)) / 14 * 2 + 5
    }

    public static func deadline(startedAt: Date, lastProgressAt: Date, utf16Length: Int) -> Date {
        max(
            lastProgressAt.addingTimeInterval(stallSeconds),
            startedAt.addingTimeInterval(expectedSeconds(forUTF16Length: utf16Length))
        )
    }
}
