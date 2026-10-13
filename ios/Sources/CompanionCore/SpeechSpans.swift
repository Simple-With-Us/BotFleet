//
//  SpeechSpans.swift
//  CompanionCore
//
//  The spoken script with every character traced back to the message text it
//  came from.  A mirror of shared/speech-spans.ts, which re-runs the server's
//  speakable() rules (server/tts/speech-text.ts) over a text whose units each
//  carry their source span.  Both implementations read the same fixture,
//  Tests/CompanionCoreTests/Fixtures/speech-spans.json, so they cannot drift.
//
//  Offsets are UTF-16 code units, the same as a JavaScript string index.  The
//  rules run with NSRegularExpression over NSString, which is natively UTF-16,
//  and convert to String.Index only through `SpeechSpans.stringRange`.
//
//  ICU's defaults differ from JavaScript's non-Unicode regex mode: `\w`, `\d`
//  and `\b` are Unicode-aware in ICU and ASCII in JavaScript, ICU's `\s` lacks
//  U+FEFF, `.` excludes more line terminators, and `^`/`$` treat CRLF as one
//  break.  Every pattern below spells those out explicitly instead.
//

import Foundation

public struct SpeechSpan: Equatable, Sendable {
    public enum Kind: Int, Sendable {
        /// Spoken units are the source units, one for one.
        case copy = 0
        /// Text the rules wrote in place of the source span (which may be empty).
        case insert = 1
    }

    /// Spoken text offsets (UTF-16), end exclusive.
    public var spokenStart: Int
    public var spokenEnd: Int
    /// Source (message markdown) offsets (UTF-16), end exclusive.
    public var srcStart: Int
    public var srcEnd: Int
    public var kind: Kind

    public init(spokenStart: Int, spokenEnd: Int, srcStart: Int, srcEnd: Int, kind: Kind) {
        self.spokenStart = spokenStart
        self.spokenEnd = spokenEnd
        self.srcStart = srcStart
        self.srcEnd = srcEnd
        self.kind = kind
    }
}

public struct SpokenScript: Equatable, Sendable {
    /// Exactly what the server's speakable() returns for the same input.
    public let text: String
    /// Cover `text` in order with no gaps; source starts never decrease.
    public let segments: [SpeechSpan]
}

public struct SpokenUtterance: Equatable, Sendable {
    /// Exactly one entry of the server's toUtterances() for the same input.
    public let text: String
    /// Where this utterance sits inside SpokenScript.text (UTF-16).
    public let spokenStart: Int
    public let spokenEnd: Int
    /// Spoken offsets here are local to `text`; source offsets are global.
    public let segments: [SpeechSpan]
}

public enum SpeechSpans {
    /// speech-spans.ts spokenEntity: what an HTML entity's name (`nbsp`,
    /// `#39`, any case) reads as.  Every no-break-space form is a plain
    /// space, so the fleet's sentence gap is a pause, not the word "nbsp".
    public static func spokenEntity(_ name: String) -> String {
        switch name.lowercased() {
        case "nbsp", "#160", "#xa0": return " "
        case "amp": return "&"
        case "lt": return "<"
        case "gt": return ">"
        case "quot": return "\""
        default: return "'"
        }
    }

    /// speakable(displayText) plus the source span behind every spoken unit.
    public static func speakableWithSpans(_ displayText: String) -> SpokenScript {
        let tracked = speakableTracked(displayText)
        return SpokenScript(text: tracked.string, segments: segments(of: tracked))
    }

    /// toUtterances(displayText) with each utterance's spans.  Defaults match
    /// server/tts/speech-text.ts (minChars 12, maxChars 320).
    public static func utterancesWithSpans(_ displayText: String, minChars: Int = 12, maxChars: Int = 320) -> [SpokenUtterance] {
        let script = speakableTracked(displayText)
        if script.units.isEmpty { return [] }

        let marked = replace(script, boundary) { m, _ in
            let tail = m.range(at: 2).location != NSNotFound ? m.range(at: 2) : m.range(at: 1)
            let tailEnd = tail.location + tail.length
            return group(m, 1) + group(m, 2) + [.literalOver("\u{0000}", tailEnd, m.range.location + m.range.length)]
        }

        var rough: [Tracked] = []
        var pieceStart = 0
        for i in 0...marked.units.count {
            if i == marked.units.count || marked.units[i] == 0 {
                let piece = trim(slice(marked, pieceStart, i))
                if !piece.units.isEmpty { rough.append(piece) }
                pieceStart = i + 1
            }
        }

        var merged: [Tracked] = []
        for piece in rough {
            let parts = piece.units.count <= maxChars ? [piece] : splitLong(piece, maxChars: maxChars)
            for part in parts {
                if let prev = merged.last, prev.units.count < minChars || part.units.count < minChars {
                    merged[merged.count - 1] = join(prev, " ", part)
                } else {
                    merged.append(part)
                }
            }
        }

        let scriptText = script.nsString
        var out: [SpokenUtterance] = []
        var cursor = 0
        for utterance in merged {
            let text = utterance.string
            let found = scriptText.range(
                of: text,
                options: [.literal],
                range: NSRange(location: cursor, length: scriptText.length - cursor)
            )
            let start = found.location != NSNotFound ? found.location : cursor
            let end = start + utterance.units.count
            if found.location != NSNotFound { cursor = end }
            out.append(SpokenUtterance(text: text, spokenStart: start, spokenEnd: end, segments: segments(of: utterance)))
        }
        return out
    }

    /// Index of the segment covering spoken offset `offset`, or -1.
    public static func segmentIndex(at offset: Int, in segments: [SpeechSpan]) -> Int {
        var lo = 0
        var hi = segments.count - 1
        var found = -1
        while lo <= hi {
            let mid = (lo + hi) >> 1
            if segments[mid].spokenStart <= offset {
                found = mid
                lo = mid + 1
            } else {
                hi = mid - 1
            }
        }
        return found
    }

    /// Source offset for a spoken offset: exact inside a copy span, spread
    /// proportionally across the replaced source inside an insert span.
    public static func sourceOffset(at spokenOffset: Int, in segments: [SpeechSpan]) -> Int {
        let index = segmentIndex(at: spokenOffset, in: segments)
        guard index >= 0 else { return 0 }
        let seg = segments[index]
        let into = max(0, min(spokenOffset, seg.spokenEnd) - seg.spokenStart)
        if seg.kind == .copy { return min(seg.srcEnd, seg.srcStart + into) }
        let spokenLength = max(1, seg.spokenEnd - seg.spokenStart)
        return seg.srcStart + (into * (seg.srcEnd - seg.srcStart)) / spokenLength
    }

    /// String range for UTF-16 offsets [start, end) in `text`, or nil when an
    /// offset falls outside the text or inside a surrogate pair.
    public static func stringRange(utf16 start: Int, _ end: Int, in text: String) -> Range<String.Index>? {
        let utf16 = text.utf16
        guard start >= 0, end >= start, end <= utf16.count else { return nil }
        let lower = utf16.index(utf16.startIndex, offsetBy: start)
        let upper = utf16.index(lower, offsetBy: end - start)
        guard let a = lower.samePosition(in: text.unicodeScalars),
              let b = upper.samePosition(in: text.unicodeScalars)
        else { return nil }
        return a..<b
    }

    /// The same, for the rendered AttributedString iOS highlights.
    public static func attributedRange(utf16 start: Int, _ end: Int, in text: AttributedString) -> Range<AttributedString.Index>? {
        let plain = String(text.characters)
        guard let range = stringRange(utf16: start, end, in: plain) else { return nil }
        let scalarStart = plain.unicodeScalars.distance(from: plain.unicodeScalars.startIndex, to: range.lowerBound)
        let scalarCount = plain.unicodeScalars.distance(from: range.lowerBound, to: range.upperBound)
        let lower = text.unicodeScalars.index(text.unicodeScalars.startIndex, offsetBy: scalarStart)
        let upper = text.unicodeScalars.index(lower, offsetBy: scalarCount)
        return lower..<upper
    }
}

// MARK: - Tracked text

/// A UTF-16 string whose every unit remembers the source span it came from.
struct Tracked {
    var units: [UInt16]
    var srcStart: [Int]
    var srcEnd: [Int]
    var kind: [UInt8]

    static let empty = Tracked(units: [], srcStart: [], srcEnd: [], kind: [])

    init(units: [UInt16], srcStart: [Int], srcEnd: [Int], kind: [UInt8]) {
        self.units = units
        self.srcStart = srcStart
        self.srcEnd = srcEnd
        self.kind = kind
    }

    init(source: String) {
        units = Array(source.utf16)
        srcStart = Array(0..<units.count)
        srcEnd = Array(1..<(units.count + 1))
        kind = Array(repeating: 0, count: units.count)
    }

    var nsString: NSString { NSString(characters: units, length: units.count) }
    var string: String { String(utf16CodeUnits: units, count: units.count) }
}

private struct TrackedBuilder {
    var out = Tracked.empty

    mutating func copy(_ from: Tracked, _ start: Int, _ end: Int) {
        guard end > start else { return }
        out.units.append(contentsOf: from.units[start..<end])
        out.srcStart.append(contentsOf: from.srcStart[start..<end])
        out.srcEnd.append(contentsOf: from.srcEnd[start..<end])
        out.kind.append(contentsOf: from.kind[start..<end])
    }

    mutating func literal(_ text: [UInt16], _ srcStart: Int, _ srcEnd: Int) {
        guard !text.isEmpty else { return }
        out.units.append(contentsOf: text)
        out.srcStart.append(contentsOf: repeatElement(srcStart, count: text.count))
        out.srcEnd.append(contentsOf: repeatElement(srcEnd, count: text.count))
        out.kind.append(contentsOf: repeatElement(1, count: text.count))
    }
}

/// One piece of a replacement.
enum Part {
    /// Literal text standing in for the matched units between the copies
    /// around it.
    case literal(String)
    /// The current text's units [a, b), mapping kept.
    case copy(Int, Int)
    /// Literal text standing in for the current text's units [a, b).
    case literalOver(String, Int, Int)
}

private func spanOf(_ t: Tracked, _ start: Int, _ end: Int) -> (Int, Int) {
    if end <= start {
        let point = start > 0 ? t.srcEnd[start - 1] : (t.srcStart.first ?? 0)
        return (point, point)
    }
    var lo = t.srcStart[start]
    var hi = t.srcEnd[start]
    var i = start + 1
    while i < end {
        if t.srcStart[i] < lo { lo = t.srcStart[i] }
        if t.srcEnd[i] > hi { hi = t.srcEnd[i] }
        i += 1
    }
    return (lo, hi)
}

private func group(_ m: NSTextCheckingResult, _ n: Int) -> [Part] {
    let r = m.range(at: n)
    return r.location == NSNotFound ? [] : [.copy(r.location, r.location + r.length)]
}

private func groupText(_ m: NSTextCheckingResult, _ n: Int, _ t: Tracked) -> [UInt16]? {
    let r = m.range(at: n)
    return r.location == NSNotFound ? nil : Array(t.units[r.location..<(r.location + r.length)])
}

/// String.prototype.replace with a function, tracked.
private func replace(_ t: Tracked, _ regex: NSRegularExpression, _ replacer: (NSTextCheckingResult, Tracked) -> [Part]) -> Tracked {
    let ns = t.nsString
    var b = TrackedBuilder()
    var last = 0
    for m in regex.matches(in: ns as String, options: [], range: NSRange(location: 0, length: ns.length)) {
        let start = m.range.location
        let end = start + m.range.length
        b.copy(t, last, start)
        let parts = replacer(m, t)
        var replacement: [UInt16] = []
        for part in parts {
            switch part {
            case .literal(let text): replacement.append(contentsOf: text.utf16)
            case .copy(let a, let z): replacement.append(contentsOf: t.units[a..<z])
            case .literalOver(let text, _, _): replacement.append(contentsOf: text.utf16)
            }
        }
        if replacement.elementsEqual(t.units[start..<end]) {
            b.copy(t, start, end)
        } else {
            for (p, part) in parts.enumerated() {
                switch part {
                case .literal(let text):
                    var gapStart = start
                    var q = p - 1
                    while q >= 0 {
                        if case .copy(_, let z) = parts[q] { gapStart = z; break }
                        q -= 1
                    }
                    var gapEnd = end
                    q = p + 1
                    while q < parts.count {
                        if case .copy(let a, _) = parts[q] { gapEnd = a; break }
                        q += 1
                    }
                    let (a, z) = spanOf(t, gapStart, max(gapStart, gapEnd))
                    b.literal(Array(text.utf16), a, z)
                case .copy(let a, let z):
                    b.copy(t, a, z)
                case .literalOver(let text, let over0, let over1):
                    let (a, z) = spanOf(t, over0, over1)
                    b.literal(Array(text.utf16), a, z)
                }
            }
        }
        last = end
    }
    b.copy(t, last, t.units.count)
    return b.out
}

private func slice(_ t: Tracked, _ start: Int, _ end: Int) -> Tracked {
    Tracked(
        units: Array(t.units[start..<end]),
        srcStart: Array(t.srcStart[start..<end]),
        srcEnd: Array(t.srcEnd[start..<end]),
        kind: Array(t.kind[start..<end])
    )
}

/// JavaScript's whitespace (`\s`, and String.prototype.trim): WhiteSpace plus
/// LineTerminator, including U+FEFF, which ICU and Foundation leave out.
func isJSSpace(_ unit: UInt16) -> Bool {
    switch unit {
    case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
        return true
    case 0x2000...0x200A:
        return true
    default:
        return false
    }
}

private func trimBounds(_ units: [UInt16], _ start: Int, _ end: Int) -> (Int, Int) {
    var a = start
    var z = end
    while a < z && isJSSpace(units[a]) { a += 1 }
    while z > a && isJSSpace(units[z - 1]) { z -= 1 }
    return (a, z)
}

private func trim(_ t: Tracked) -> Tracked {
    let (a, z) = trimBounds(t.units, 0, t.units.count)
    return a == 0 && z == t.units.count ? t : slice(t, a, z)
}

private func join(_ left: Tracked, _ joiner: String, _ right: Tracked) -> Tracked {
    var b = TrackedBuilder()
    b.copy(left, 0, left.units.count)
    let point = !left.units.isEmpty ? left.srcEnd[left.units.count - 1] : (right.srcStart.first ?? 0)
    let next = !right.units.isEmpty ? right.srcStart[0] : point
    b.literal(Array(joiner.utf16), min(point, next), max(point, next))
    b.copy(right, 0, right.units.count)
    return b.out
}

private func segments(of t: Tracked) -> [SpeechSpan] {
    var out: [SpeechSpan] = []
    for i in 0..<t.units.count {
        let kind: SpeechSpan.Kind = t.kind[i] == 0 ? .copy : .insert
        let s = t.srcStart[i]
        let e = t.srcEnd[i]
        if var current = out.last, current.kind == kind,
           kind == .copy ? current.srcEnd == s : (current.srcStart == s && current.srcEnd == e) {
            current.spokenEnd = i + 1
            if kind == .copy { current.srcEnd = e }
            out[out.count - 1] = current
        } else {
            out.append(SpeechSpan(spokenStart: i, spokenEnd: i + 1, srcStart: s, srcEnd: e, kind: kind))
        }
    }
    return out
}

// MARK: - The rules, in speakable()'s order

/// JavaScript non-Unicode regex pieces, spelled out for ICU.
private enum JS {
    static let spaceChars = #"\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}"#
    /// `\s`
    static let s = "[\(spaceChars)]"
    /// `\S`
    static let S = "[^\(spaceChars)]"
    /// `.` without the s flag
    static let dot = #"[^\n\r\x{2028}\x{2029}]"#
    /// `^` with the m flag
    static let bol = #"(?<![^\n\r\x{2028}\x{2029}])"#
    /// `$` with the m flag
    static let eol = #"(?![^\n\r\x{2028}\x{2029}])"#
    /// `\b` (ASCII word characters)
    static let b = #"(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))"#
    static let w = "[A-Za-z0-9_]"
}

private func re(_ pattern: String) -> NSRegularExpression {
    // The patterns are constants; a failure here is a programming error the
    // fixture tests catch on the first run.
    // swiftlint:disable:next force_try
    try! NSRegularExpression(pattern: pattern, options: [])
}


private enum Rules {
    static let backtickFence = re(#"```([^\n]*)\n[\s\S]*?(?:```|\z)"#)
    static let tildeFence = re(#"~~~([^\n]*)\n[\s\S]*?(?:~~~|\z)"#)
    static let image = re(#"!\[([^\]]*)\]\([^)]*\)"#)
    static let link = re(#"\[([^\]]+)\]\([^)]*\)"#)
    static let angleUrl = re("<https?://[^>\(JS.spaceChars)]+>")
    static let bareUrl = re("\(JS.b)https?://\(JS.S)+")
    static let tableSeparator = re("\(JS.bol)\(JS.s)*\\|?[\(JS.spaceChars):\\-]*\\|[\(JS.spaceChars)|:\\-]*\(JS.eol)")
    static let tableRow = re("\(JS.bol)\(JS.s)*\\|(\(JS.dot)+)\\|\(JS.s)*\(JS.eol)")
    static let inlineCode = re(#"`([^`\n]+)`"#)
    static let heading = re("\(JS.bol)\(JS.s){0,3}#{1,6}\(JS.s)+(\(JS.dot)*)\(JS.eol)")
    static let bullet = re("\(JS.bol)\(JS.s)*[-*+]\(JS.s)+")
    static let numbered = re("\(JS.bol)\(JS.s)*[0-9]+[.)]\(JS.s)+")
    static let quote = re("\(JS.bol)\(JS.s)*>\(JS.s)?")
    static let rule = re("\(JS.bol)\(JS.s)*(?:[-*_]\(JS.s)*){3,}\(JS.eol)")
    static let strong = re("(\\*\\*|__)(\(JS.dot)*?)\\1")
    static let emphasis = re("(\\*|_)(?=\(JS.S))(\(JS.dot)*?)(?<=\(JS.S))\\1")
    static let strike = re("~~(\(JS.dot)*?)~~")
    static let checkbox = re("\\[[ xX]\\]\(JS.s)*")
    static let path = re("(?:[A-Za-z0-9_.@\\-]+/){1,}([A-Za-z0-9_.\\-]+\\.\(JS.w){1,6})\(JS.b)")
    static let emoji = re(#"[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}\x{FE00}-\x{FE0F}\x{2190}-\x{21FF}\x{2B00}-\x{2BFF}]"#)
    /// speech-spans.ts SPOKEN_ENTITY, case-insensitive like its `i` flag.
    static let entity = re(#"(?i)&(nbsp|#160|#xa0|amp|lt|gt|quot|apos|#39);"#)
    static let paragraph = re(#"\n{2,}"#)
    static let newline = re(#"\n"#)
    static let spaces = re("\(JS.s)+")
    static let spaceBeforePunctuation = re("\(JS.s)+([.,!?;:])")
    static let dots = re("(?:\\.\(JS.s)*){2,}")
    static let commaDot = re(",\(JS.s)*\\.")
    static let letterOrNumber = re(#"[\p{L}\p{N}]"#)
    static let endsSentence = re("[.!?:;]\(JS.s)*\\z")
}

/// The sentence boundary from speech-text.ts BOUNDARY.  The `\b` inside the
/// abbreviation lookbehind becomes "not preceded by an ASCII word character".
private let boundary = re(
    "(?<!(?<![A-Za-z0-9_])(?:e\\.g|i\\.e|etc|vs|Dr|Mr|Mrs|Ms|No|approx))(?<![.0-9])([.!?])([\"')\\]]*)\(JS.s)+"
)

/// Identical to speech-text.ts describeCodeBlock.
private func describeCodeBlock(_ fence: [UInt16]) -> String {
    let (a, z) = trimBounds(fence, 0, fence.count)
    var end = a
    while end < z && !isJSSpace(fence[end]) { end += 1 }
    var lang = ""
    for unit in fence[a..<end] {
        let isAlnum = (unit >= 0x61 && unit <= 0x7A) || (unit >= 0x41 && unit <= 0x5A) || (unit >= 0x30 && unit <= 0x39)
        if isAlnum || unit == 0x2B || unit == 0x23 {
            lang.unicodeScalars.append(Unicode.Scalar(UInt8(unit)))
        }
    }
    let spoken: [String: String] = [
        "ts": "TypeScript", "tsx": "TypeScript", "js": "JavaScript", "jsx": "JavaScript", "py": "Python",
        "sh": "shell", "bash": "shell", "zsh": "shell", "json": "JSON", "yml": "YAML", "yaml": "YAML",
        "sql": "SQL", "rs": "Rust", "go": "Go", "swift": "Swift", "diff": "diff",
    ]
    if let name = spoken[lang.lowercased()] { return ". (a \(name) code block) " }
    return ". (a code block) "
}

private func matches(_ regex: NSRegularExpression, _ units: [UInt16]) -> Bool {
    let ns = NSString(characters: units, length: units.count)
    return regex.firstMatch(in: ns as String, options: [], range: NSRange(location: 0, length: ns.length)) != nil
}

func speakableTracked(_ input: String) -> Tracked {
    var t = Tracked(source: input)
    if t.units.isEmpty { return t }

    t = replace(t, Rules.backtickFence) { m, t in [.literal(describeCodeBlock(groupText(m, 1, t) ?? []))] }
    t = replace(t, Rules.tildeFence) { m, t in [.literal(describeCodeBlock(groupText(m, 1, t) ?? []))] }

    t = replace(t, Rules.image) { m, t in
        let alt = groupText(m, 1, t) ?? []
        return alt.isEmpty ? [.literal(". (an image) ")] : [.literal(". (image: ")] + group(m, 1) + [.literal(") ")]
    }
    t = replace(t, Rules.link) { m, _ in group(m, 1) }
    t = replace(t, Rules.angleUrl) { _, _ in [.literal(" a link ")] }
    t = replace(t, Rules.bareUrl) { _, _ in [.literal(" a link ")] }

    t = replace(t, Rules.tableSeparator) { _, _ in [] }
    t = replace(t, Rules.tableRow) { m, t in
        let row = m.range(at: 1)
        let rowStart = row.location
        let rowEnd = row.location + row.length
        var cells: [(Int, Int)] = []
        var cellStart = rowStart
        var i = rowStart
        while i <= rowEnd {
            if i == rowEnd || t.units[i] == 0x7C {
                let (a, z) = trimBounds(t.units, cellStart, i)
                if z > a { cells.append((a, z)) }
                cellStart = i + 1
            }
            i += 1
        }
        var parts: [Part] = []
        for (index, cell) in cells.enumerated() {
            if index > 0 { parts.append(.literalOver(", ", cells[index - 1].1, cell.0)) }
            parts.append(.copy(cell.0, cell.1))
        }
        return parts
    }

    t = replace(t, Rules.inlineCode) { m, _ in
        m.range(at: 1).length <= 40 ? group(m, 1) : [.literal(" that snippet ")]
    }

    t = replace(t, Rules.heading) { m, t in
        let head = groupText(m, 1, t) ?? []
        if matches(Rules.endsSentence, head) { return group(m, 1) }
        let r = m.range(at: 1)
        if r.location == NSNotFound { return [.literal(".")] }
        let (a, z) = trimBounds(t.units, r.location, r.location + r.length)
        return [.copy(a, z), .literal(".")]
    }

    t = replace(t, Rules.bullet) { _, _ in [] }
    t = replace(t, Rules.numbered) { _, _ in [] }
    t = replace(t, Rules.quote) { _, _ in [] }
    t = replace(t, Rules.rule) { _, _ in [] }

    t = replace(t, Rules.strong) { m, _ in group(m, 2) }
    t = replace(t, Rules.emphasis) { m, _ in group(m, 2) }
    t = replace(t, Rules.strike) { m, _ in group(m, 1) }

    t = replace(t, Rules.checkbox) { _, _ in [] }

    t = replace(t, Rules.path) { m, _ in group(m, 1) }

    t = replace(t, Rules.emoji) { _, _ in [] }

    t = replace(t, Rules.entity) { m, t in
        [.literal(SpeechSpans.spokenEntity(String(decoding: groupText(m, 1, t) ?? [], as: UTF16.self)))]
    }

    t = replace(t, Rules.paragraph) { _, _ in [.literal(". ")] }
    t = replace(t, Rules.newline) { _, _ in [.literal(". ")] }

    t = replace(t, Rules.spaces) { _, _ in [.literal(" ")] }
    t = replace(t, Rules.spaceBeforePunctuation) { m, _ in group(m, 1) }
    t = replace(t, Rules.dots) { _, _ in [.literal(". ")] }
    t = replace(t, Rules.commaDot) { _, _ in [.literal(".")] }
    t = trim(t)

    return matches(Rules.letterOrNumber, t.units) ? t : Tracked.empty
}

private func lastIndex(of needle: [UInt16], in haystack: ArraySlice<UInt16>) -> Int {
    guard needle.count <= haystack.count else { return -1 }
    var i = haystack.endIndex - needle.count
    while i >= haystack.startIndex {
        var hit = true
        for k in 0..<needle.count where haystack[i + k] != needle[k] {
            hit = false
            break
        }
        if hit { return i - haystack.startIndex }
        i -= 1
    }
    return -1
}

private func splitLong(_ piece: Tracked, maxChars: Int) -> [Tracked] {
    let comma = Array(", ".utf16)
    let semicolon = Array("; ".utf16)
    let dash = Array(" \u{2014} ".utf16)
    let space: [UInt16] = [0x20]
    var out: [Tracked] = []
    var rest = piece
    while rest.units.count > maxChars {
        let window = rest.units[0..<maxChars]
        let at = max(lastIndex(of: comma, in: window), lastIndex(of: semicolon, in: window), lastIndex(of: dash, in: window))
        // `at > maxChars / 2` in JavaScript compares against a fraction.
        let cut = Double(at) > Double(maxChars) / 2 ? at + 1 : lastIndex(of: space, in: window)
        if cut <= 0 { break }
        out.append(trim(slice(rest, 0, cut)))
        rest = trim(slice(rest, cut, rest.units.count))
    }
    if !rest.units.isEmpty { out.append(rest) }
    return out
}
