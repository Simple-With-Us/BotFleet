//
//  KaraokeAlign.swift
//  CompanionCore
//
//  Which word on screen is being spoken now.  A mirror of
//  shared/karaoke-align.ts: the same tokenizer, the same integer-scored
//  banded alignment, and the same timeline rules, checked against the shared
//  fixture Tests/CompanionCoreTests/Fixtures/karaoke-align.json.
//
//  Display words come from the RENDERED message text (on iOS, the string of
//  the rendered AttributedString), not from its markdown.  Offsets are UTF-16;
//  use SpeechSpans.stringRange / attributedRange to turn a word into a range
//  to color.  Times are milliseconds.
//

import Foundation

public struct KaraokeWord: Equatable, Sendable {
    /// UTF-16 offsets into the tokenized text, end exclusive.
    public let start: Int
    public let end: Int
    public let text: String
    /// Comparison key: compatibility-decomposed, marks and apostrophes
    /// removed, lower-cased.
    public let key: String
}

public struct KaraokeMapping: Equatable, Sendable {
    public let spokenCount: Int
    public let displayCount: Int
    /// The display word each spoken word is paired with or attached to; -1
    /// only when nothing pairs at all.
    public let spokenToDisplay: [Int]
    /// KaraokeAlign.spokenInserted ... spokenExpanded per spoken word.
    public let spokenKind: [Int]
    /// First and last spoken word paired with each display word; -1 when the
    /// display word was skipped.
    public let displayFirstSpoken: [Int]
    public let displayLastSpoken: [Int]
}

/// Content words on each side and how many the alignment really paired
/// (karaoke-align.ts KaraokeQuality).
public struct KaraokeQuality: Equatable, Sendable {
    public let spokenContent: Int
    public let spokenMatched: Int
    public let displayContent: Int
    public let displayMatched: Int

    public init(spokenContent: Int, spokenMatched: Int, displayContent: Int, displayMatched: Int) {
        self.spokenContent = spokenContent
        self.spokenMatched = spokenMatched
        self.displayContent = displayContent
        self.displayMatched = displayMatched
    }
}

public struct KaraokeAlignment: Equatable, Sendable {
    public let spokenWords: [KaraokeWord]
    public let displayWords: [KaraokeWord]
    public let mapping: KaraokeMapping
    /// True when the script's spans guided the alignment.
    public let guided: Bool
    public let quality: KaraokeQuality
    /// guided || KaraokeAlign.followable(quality): false means show no
    /// highlight.
    public let followable: Bool
}

public struct KaraokeClip: Equatable, Sendable {
    public var spokenStart: Int
    public var spokenEnd: Int
    public var startMs: Double
    public var durationMs: Double

    public init(spokenStart: Int, spokenEnd: Int, startMs: Double, durationMs: Double) {
        self.spokenStart = spokenStart
        self.spokenEnd = spokenEnd
        self.startMs = startMs
        self.durationMs = durationMs
    }
}

public enum KaraokeAlign {
    public static let spokenInserted = 0
    public static let spokenExact = 1
    public static let spokenEquivalent = 2
    public static let spokenFuzzy = 3
    public static let spokenSubstituted = 4
    public static let spokenExpanded = 5

    /// About fifteen characters a second, the on-device synthesizer's pace.
    public static let defaultMsPerChar: Double = 65

    // MARK: Tokenizer

    // swiftlint:disable:next force_try
    private static let wordPattern = try! NSRegularExpression(
        pattern: #"[\p{L}\p{M}\p{N}]+(?:['\x{2019}\x{02BC}][\p{L}\p{M}\p{N}]+)*"#
    )

    public static func wordKey(_ raw: String) -> String {
        if raw.utf16.allSatisfy({ $0 < 0x80 }) {
            return String(raw.lowercased().filter { $0 != "'" })
        }
        var scalars = String.UnicodeScalarView()
        for scalar in raw.decomposedStringWithCompatibilityMapping.unicodeScalars {
            switch scalar.properties.generalCategory {
            case .nonspacingMark, .spacingMark, .enclosingMark: continue
            default: scalars.append(scalar)
            }
        }
        let lowered = String(scalars).lowercased()
        return String(lowered.unicodeScalars.filter { $0 != "'" && $0 != "\u{2019}" && $0 != "\u{02BC}" }
            .reduce(into: String.UnicodeScalarView()) { $0.append($1) })
    }

    /// The one tokenizer for spoken text, display text and markdown source.
    public static func tokenize(_ text: String) -> [KaraokeWord] {
        let ns = text as NSString
        var out: [KaraokeWord] = []
        for m in wordPattern.matches(in: text, options: [], range: NSRange(location: 0, length: ns.length)) {
            let word = ns.substring(with: m.range)
            let key = wordKey(word)
            if key.isEmpty { continue }
            out.append(KaraokeWord(start: m.range.location, end: m.range.location + m.range.length, text: word, key: key))
        }
        return out
    }

    // MARK: Numbers

    private static let units: [String: Int] = [
        "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
    ]
    private static let teens: [String: Int] = [
        "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
        "seventeen": 17, "eighteen": 18, "nineteen": 19,
    ]
    private static let tens: [String: Int] = [
        "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
    ]
    private static let scales: [String: Int] = ["thousand": 1_000, "million": 1_000_000, "billion": 1_000_000_000]
    /// karaoke-align.ts ORDINAL_*: the last word of a reading.
    private static let ordinalUnits: [String: Int] = [
        "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7, "eighth": 8, "ninth": 9,
    ]
    private static let ordinalTeens: [String: Int] = [
        "tenth": 10, "eleventh": 11, "twelfth": 12, "thirteenth": 13, "fourteenth": 14, "fifteenth": 15, "sixteenth": 16,
        "seventeenth": 17, "eighteenth": 18, "nineteenth": 19,
    ]
    private static let ordinalTens: [String: Int] = [
        "twentieth": 20, "thirtieth": 30, "fortieth": 40, "fiftieth": 50, "sixtieth": 60, "seventieth": 70,
        "eightieth": 80, "ninetieth": 90,
    ]
    /// karaoke-align.ts NUMBER_WORDS: every word numberKey knows, except
    /// "first" and "second", which stand alone too often to equal a digit.
    private static let numberWords: [String: String] = {
        var out: [String: String] = [:]
        for table in [units, teens, tens, ordinalUnits, ordinalTeens, ordinalTens] {
            for (word, n) in table where word != "first" && word != "second" { out[word] = String(n) }
        }
        return out
    }()

    private static func isAsciiDigits(_ key: String) -> Bool {
        !key.isEmpty && key.utf16.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
    }

    private static func stripLeadingZeros(_ digits: [UInt16]) -> String {
        var units = digits
        while units.count > 1 && units[0] == 0x30 { units.removeFirst() }
        return String(utf16CodeUnits: units, count: units.count)
    }

    /// Value of one word as a decimal string ("007" -> "7", "seven" -> "7",
    /// "24th" -> "24", "fourth" -> "4").
    public static func numberKey(_ key: String) -> String? {
        guard let c0 = key.utf16.first else { return nil }
        if c0 >= 0x30 && c0 <= 0x39 {
            if isAsciiDigits(key) { return stripLeadingZeros(Array(key.utf16)) }
            // digits, then st, nd, rd or th
            let all = Array(key.utf16)
            guard all.count >= 3 else { return nil }
            let suffix = String(utf16CodeUnits: Array(all.suffix(2)), count: 2)
            let digits = Array(all.dropLast(2))
            guard ["st", "nd", "rd", "th"].contains(suffix), digits.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) else { return nil }
            return stripLeadingZeros(digits)
        }
        return numberWords[key]
    }

    private static func digitOf(_ key: String) -> String? {
        if key == "oh" { return "0" }
        if let v = units[key] { return String(v) }
        if key.utf16.count == 1, let u = key.utf16.first, u >= 0x30 && u <= 0x39 { return key }
        return nil
    }

    private enum Last { case none, unit, teen, tens, hundred, scale, and, ordinal }

    private static func parseCardinal(_ keys: [String]) -> String? {
        var total = 0
        var current = 0
        var last = Last.none
        for key in keys {
            if last == .ordinal { return nil }
            if let o = ordinalUnits[key] {
                guard last == .none || last == .tens || last == .hundred || last == .scale || last == .and else { return nil }
                current += o
                last = .ordinal
            } else if let o = ordinalTeens[key] ?? ordinalTens[key] {
                guard last == .none || last == .hundred || last == .scale || last == .and else { return nil }
                current += o
                last = .ordinal
            } else if let u = units[key], key != "zero" {
                guard last == .none || last == .tens || last == .hundred || last == .scale || last == .and else { return nil }
                current += u
                last = .unit
            } else if let t = teens[key] {
                guard last == .none || last == .hundred || last == .scale || last == .and else { return nil }
                current += t
                last = .teen
            } else if let t = tens[key] {
                guard last == .none || last == .hundred || last == .scale || last == .and else { return nil }
                current += t
                last = .tens
            } else if key == "hundred" {
                guard current > 0, current < 100, last != .hundred, last != .and else { return nil }
                current *= 100
                last = .hundred
            } else if let scale = scales[key] {
                guard current > 0, last != .and else { return nil }
                total += current * scale
                current = 0
                last = .scale
            } else if key == "and" {
                guard last == .hundred || last == .scale else { return nil }
                last = .and
            } else {
                return nil
            }
        }
        if last == .none || last == .and { return nil }
        return String(total + current)
    }

    private static func parseGrouped(_ keys: [String]) -> String? {
        var out = ""
        var groups = 0
        var i = 0
        while i < keys.count {
            let key = keys[i]
            let next: String? = i + 1 < keys.count ? keys[i + 1] : nil
            if let t = tens[key] {
                if let next, let u = units[next], next != "zero" {
                    out += String(t + u)
                    i += 2
                } else {
                    out += String(t)
                    i += 1
                }
            } else if let t = teens[key] {
                out += String(t)
                i += 1
            } else if key == "oh", groups > 0, let next, let u = units[next], next != "zero" {
                out += "0\(u)"
                i += 2
            } else if groups == 0, let u = units[key], key != "zero" {
                out += String(u)
                i += 1
            } else {
                return nil
            }
            groups += 1
        }
        return groups >= 2 ? out : nil
    }

    /// Longest run read as a number (karaoke-align.ts MAX_EXPANSION).
    private static let maxExpansion = 8
    /// Longest run joined into one code (karaoke-align.ts MAX_JOINED).  It
    /// keeps the run length within the aligner's UInt8 move record.
    private static let maxJoined = 40

    /// A word inside a spelled-out code: a digit or teen word as its
    /// digits, anything else as itself.
    private static func codedPiece(_ key: String) -> String {
        if let d = digitOf(key) { return d }
        if let t = teens[key] { return String(t) }
        return key
    }

    /// Every prefix of every display key, at scalar boundaries.  A joined
    /// reading only grows while it is still one of these.
    private static func keyPrefixes(_ words: [KaraokeWord]) -> Set<String> {
        var out = Set<String>()
        for w in words {
            var acc = String.UnicodeScalarView()
            for scalar in w.key.unicodeScalars {
                acc.append(scalar)
                out.insert(String(acc))
            }
        }
        return out
    }

    /// For each spoken word, display values a run of words starting there
    /// can stand for, with the run lengths (karaoke-align.ts
    /// spokenExpansions): keys joined raw and with digit and teen words as
    /// digits (2...maxJoined words), and cardinals with an ordinal end and
    /// paired years (2...maxExpansion words).  Only values `accept` keeps are
    /// recorded.
    private static func spokenExpansions(
        _ words: [KaraokeWord],
        prefixes: Set<String>,
        accept: (String) -> Bool
    ) -> [[String: [Int]]?] {
        var out = [[String: [Int]]?](repeating: nil, count: words.count)
        func add(_ i: Int, _ value: String?, _ k: Int) {
            guard let value, accept(value) else { return }
            var map = out[i] ?? [:]
            var list = map[value] ?? []
            if !list.contains(k) { list.append(k) }
            map[value] = list
            out[i] = map
        }
        for i in 0..<words.count {
            let first = words[i].key
            let numeric = digitOf(first) != nil || teens[first] != nil || tens[first] != nil
            var raw: String? = prefixes.contains(first) ? first : nil
            let firstCoded = codedPiece(first)
            var coded: String? = prefixes.contains(firstCoded) ? firstCoded : nil
            var keys = [first]
            var k = 2
            while k <= maxJoined && i + k <= words.count {
                let asNumber = numeric && k <= maxExpansion
                if raw == nil && coded == nil && !asNumber { break }
                let key = words[i + k - 1].key
                if asNumber { keys.append(key) }
                if let joined = raw.map({ $0 + key }) {
                    if prefixes.contains(joined) {
                        raw = joined
                        add(i, joined, k)
                    } else {
                        raw = nil
                    }
                }
                if let joined = coded.map({ $0 + codedPiece(key) }) {
                    if prefixes.contains(joined) {
                        coded = joined
                        add(i, joined, k)
                    } else {
                        coded = nil
                    }
                }
                if asNumber {
                    add(i, parseCardinal(keys), k)
                    add(i, parseGrouped(keys), k)
                }
                k += 1
            }
        }
        return out
    }

    // MARK: Aligner

    private struct Params {
        var exact: Int
        var equivalent: Int
        var fuzzy: Int
        var substitute: Int
        var expand: Int
        var skipCol: Int
        var insertRow: Int
        var numbers: Bool
        var band: Int
    }

    private static let spokenParams = Params(
        exact: 30, equivalent: 30, fuzzy: 15, substitute: -6, expand: 30, skipCol: -3, insertRow: -10, numbers: true, band: 40
    )
    private static let guidedBand = 16
    private static let projectionParams = Params(
        exact: 30, equivalent: 30, fuzzy: 15, substitute: -12, expand: 30, skipCol: -1, insertRow: -10, numbers: false, band: 24
    )
    /// karaoke-align.ts PROJECTION_EXTRA_BAND_MAX: the projection's band
    /// widens by the difference in word counts, up to this many.
    private static let projectionExtraBandMax = 1000
    private static let neg = -1_000_000_000

    public static func fuzzyWordMatch(_ a: String, _ b: String) -> Bool {
        fuzzyUnitsMatch(Array(a.utf16), Array(b.utf16))
    }

    /// fuzzyWordMatch over keys already split into UTF-16 units, so the
    /// aligner's inner loop allocates nothing per cell.
    private static func fuzzyUnitsMatch(_ x: [UInt16], _ y: [UInt16]) -> Bool {
        if x.count < 4 || y.count < 4 { return false }
        if abs(x.count - y.count) > 2 { return false }
        if x[0] != y[0] { return false }
        var prefix = 0
        while prefix < min(x.count, y.count) && x[prefix] == y[prefix] { prefix += 1 }
        if prefix >= 5 { return true }
        let limit = max(x.count, y.count) >= 8 ? 2 : 1
        var prev = Array(0...y.count)
        var cur = [Int](repeating: 0, count: y.count + 1)
        for i in 1...x.count {
            cur[0] = i
            var rowMin = cur[0]
            for j in 1...y.count {
                let cost = x[i - 1] == y[j - 1] ? 0 : 1
                cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
                if cur[j] < rowMin { rowMin = cur[j] }
            }
            if rowMin > limit { return false }
            swap(&prev, &cur)
        }
        return prev[y.count] <= limit
    }

    private static func anchorChain(_ rows: [Int], _ cols: [Int]) -> [(Int, Int)] {
        var tails: [Int] = []
        var prev = [Int](repeating: -1, count: rows.count)
        for a in 0..<rows.count {
            var lo = 0
            var hi = tails.count
            while lo < hi {
                let mid = (lo + hi) >> 1
                if cols[tails[mid]] <= cols[a] { lo = mid + 1 } else { hi = mid }
            }
            prev[a] = lo > 0 ? tails[lo - 1] : -1
            if lo == tails.count { tails.append(a) } else { tails[lo] = a }
        }
        var chain: [(Int, Int)] = []
        var at = tails.last ?? -1
        while at >= 0 {
            chain.append((rows[at], cols[at]))
            at = prev[at]
        }
        return chain.reversed()
    }

    private static func uniqueAnchors(_ rows: [KaraokeWord], _ cols: [KaraokeWord]) -> [(Int, Int)] {
        var rowCount: [String: Int] = [:]
        var colCount: [String: Int] = [:]
        var colAt: [String: Int] = [:]
        for w in rows { rowCount[w.key, default: 0] += 1 }
        for (j, w) in cols.enumerated() {
            colCount[w.key, default: 0] += 1
            colAt[w.key] = j
        }
        var anchorRows: [Int] = []
        var anchorCols: [Int] = []
        for (i, w) in rows.enumerated() where rowCount[w.key] == 1 && colCount[w.key] == 1 {
            anchorRows.append(i)
            anchorCols.append(colAt[w.key]!)
        }
        return anchorChain(anchorRows, anchorCols)
    }

    private static func guideAnchors(_ guide: [Int], _ rowCount: Int, _ colCount: Int) -> [(Int, Int)] {
        var anchorRows: [Int] = []
        var anchorCols: [Int] = []
        for i in 0..<min(rowCount, guide.count) {
            let g = guide[i]
            if g >= 0 && g < colCount {
                anchorRows.append(i)
                anchorCols.append(g)
            }
        }
        return anchorChain(anchorRows, anchorCols)
    }

    private struct CoreResult {
        var rowToCol: [Int]
        var rowKind: [Int]
        var colFirstRow: [Int]
        var colLastRow: [Int]
    }

    private static func floorDiv(_ a: Int, _ b: Int) -> Int {
        let q = a / b
        return (a % b != 0 && ((a < 0) != (b < 0))) ? q - 1 : q
    }

    private static func alignCore(
        _ rows: [KaraokeWord],
        _ cols: [KaraokeWord],
        _ params: Params,
        _ anchors: [(Int, Int)],
        _ band: Int,
        _ pronunciations: [Pronunciation] = []
    ) -> CoreResult {
        let R = rows.count
        let C = cols.count
        var result = CoreResult(
            rowToCol: [Int](repeating: -1, count: R),
            rowKind: [Int](repeating: 0, count: R),
            colFirstRow: [Int](repeating: -1, count: C),
            colLastRow: [Int](repeating: -1, count: C)
        )
        if R == 0 || C == 0 { return result }

        var points: [(Int, Int)] = [(0, 0)]
        for (r, c) in anchors {
            let (lr, lc) = points[points.count - 1]
            if r > lr && c >= lc && r < R && c < C { points.append((r, c)) }
        }
        points.append((R, C))
        var centreLo = [Int](repeating: 0, count: R + 1)
        var centreHi = [Int](repeating: 0, count: R + 1)
        for p in 0..<(points.count - 1) {
            let (r0, c0) = points[p]
            let (r1, c1) = points[p + 1]
            let dr = r1 - r0
            let dc = c1 - c0
            for i in r0...r1 {
                let num = (i - r0) * dc
                centreLo[i] = c0 + floorDiv(num, dr)
                centreHi[i] = c0 + floorDiv(num + dr - 1, dr)
            }
        }
        var lo = [Int](repeating: 0, count: R + 1)
        var hi = [Int](repeating: 0, count: R + 1)
        for i in 0...R {
            lo[i] = max(0, min(C, centreLo[i] - band))
            hi[i] = max(0, min(C, centreHi[min(i + 1, R)] + band))
        }
        lo[0] = 0
        hi[R] = C
        if R > 0 {
            for i in stride(from: R - 1, through: 0, by: -1) where lo[i] > lo[i + 1] { lo[i] = lo[i + 1] }
            for i in 1...R where hi[i] < hi[i - 1] { hi[i] = hi[i - 1] }
        }

        var offset = [Int](repeating: 0, count: R + 2)
        for i in 0...R { offset[i + 1] = offset[i] + (hi[i] - lo[i] + 1) }
        let total = offset[R + 1]
        var score = [Int](repeating: neg, count: total)
        var move = [UInt8](repeating: 0, count: total)
        var moveK = [UInt8](repeating: 0, count: total)
        func at(_ i: Int, _ j: Int) -> Int { j < lo[i] || j > hi[i] ? -1 : offset[i] + (j - lo[i]) }

        var ids: [String: Int] = [:]
        func intern(_ key: String) -> Int {
            if let id = ids[key] { return id }
            let id = ids.count
            ids[key] = id
            return id
        }
        let rowKey = rows.map { intern($0.key) }
        let colKey = cols.map { intern($0.key) }
        // Split once, not per cell: classify runs for every cell in the band.
        let rowUnits = rows.map { Array($0.key.utf16) }
        let colUnits = cols.map { Array($0.key.utf16) }
        var nums: [String: Int] = [:]
        func internNum(_ value: String?) -> Int {
            guard let value else { return -1 }
            if let id = nums[value] { return id }
            let id = nums.count
            nums[value] = id
            return id
        }
        var rowNum = [Int](repeating: -1, count: R)
        var colNum = [Int](repeating: -1, count: C)
        var colValues = Set<String>()
        // By the display key's id, and (for a number reading) by the display
        // word's number value.
        var expansions = [[Int: [Int]]?](repeating: nil, count: R)
        var numExpansions = [[Int: [Int]]?](repeating: nil, count: R)
        func put(_ table: inout [Int: [Int]], _ id: Int, _ ks: [Int]) {
            var list = table[id] ?? []
            for k in ks where !list.contains(k) { list.append(k) }
            table[id] = list
        }
        if params.numbers {
            for i in 0..<R { rowNum[i] = internNum(numberKey(rows[i].key)) }
            for j in 0..<C {
                let n = numberKey(cols[j].key)
                colNum[j] = internNum(n)
                if let n { colValues.insert(n) }
            }
            let colWords = Set(cols.map(\.key))
            let accept: (String) -> Bool = { value in
                if colWords.contains(value) { return true }
                return isAsciiDigits(value) && colValues.contains(stripLeadingZeros(Array(value.utf16)))
            }
            let raw = spokenExpansions(rows, prefixes: keyPrefixes(cols), accept: accept)
            for i in 0..<R {
                guard let table = raw[i] else { continue }
                var byId: [Int: [Int]] = [:]
                var byNum: [Int: [Int]] = [:]
                for (value, ks) in table {
                    if let id = ids[value] { put(&byId, id, ks) }
                    if isAsciiDigits(value), let numId = nums[stripLeadingZeros(Array(value.utf16))] { put(&byNum, numId, ks) }
                }
                if !byId.isEmpty { expansions[i] = byId }
                if !byNum.isEmpty { numExpansions[i] = byNum }
            }
        }
        // The pronunciation list (karaoke-align.ts): a run of spoken words
        // that is exactly how a term is said expands to the term's (first)
        // display word.  In list order and after the number readings, so
        // ties break as they do in TypeScript.
        for entry in pronunciations {
            guard let termWord = tokenize(entry.term).first, let id = ids[termWord.key] else { continue }
            let sayKeys = tokenize(entry.say).map(\.key)
            let k = sayKeys.count
            if k == 0 || k > maxJoined || k > R { continue }
            for i in 0...(R - k) {
                var same = true
                var q = 0
                while q < k && same {
                    same = rows[i + q].key == sayKeys[q]
                    q += 1
                }
                if same {
                    var table = expansions[i] ?? [:]
                    put(&table, id, [k])
                    expansions[i] = table
                }
            }
        }
        func classify(_ i: Int, _ j: Int) -> Int {
            if rowKey[i] == colKey[j] { return spokenExact }
            if rowNum[i] >= 0 && rowNum[i] == colNum[j] { return spokenEquivalent }
            // The same cheap pre-check as the TypeScript classify, before the
            // edit distance.
            let a = rowUnits[i]
            let b = colUnits[j]
            if a.count >= 4, b.count >= 4, a[0] == b[0], abs(a.count - b.count) <= 2, fuzzyUnitsMatch(a, b) {
                return spokenFuzzy
            }
            return spokenSubstituted
        }
        let kindScore = [0, params.exact, params.equivalent, params.fuzzy, params.substitute]

        for i in 0...R {
            let rowLo = lo[i]
            let rowHi = hi[i]
            let base = offset[i] - rowLo
            let upLo = i > 0 ? lo[i - 1] : 0
            let upHi = i > 0 ? hi[i - 1] : -1
            let upBase = i > 0 ? offset[i - 1] - upLo : 0
            let table = i < R ? expansions[i] : nil
            let numTable = i < R ? numExpansions[i] : nil
            for j in rowLo...rowHi {
                let idx = base + j
                var best = score[idx]
                var bestMove = move[idx]
                if i == 0 && j == 0 {
                    best = 0
                    bestMove = 0
                }
                if i > 0 && j > 0 && j - 1 >= upLo && j - 1 <= upHi {
                    let d = score[upBase + j - 1]
                    if d > neg {
                        let s = d + kindScore[classify(i - 1, j - 1)]
                        if s > best {
                            best = s
                            bestMove = 1
                        }
                    }
                }
                if j > rowLo {
                    let l = score[idx - 1]
                    if l > neg {
                        let s = l + params.skipCol
                        if s > best {
                            best = s
                            bestMove = 2
                        }
                    }
                }
                if i > 0 && j >= upLo && j <= upHi {
                    let u = score[upBase + j]
                    if u > neg {
                        let s = u + params.insertRow
                        if s > best {
                            best = s
                            bestMove = 3
                        }
                    }
                }
                score[idx] = best
                move[idx] = bestMove
                if table != nil || numTable != nil, best > neg, j < C {
                    for pass in 0..<2 {
                        let ks = pass == 0 ? table?[colKey[j]] : (colNum[j] >= 0 ? numTable?[colNum[j]] : nil)
                        guard let ks else { continue }
                        for k in ks {
                            if i + k > R { continue }
                            let target = at(i + k, j + 1)
                            if target < 0 { continue }
                            let s = best + params.expand
                            if s > score[target] {
                                score[target] = s
                                move[target] = 4
                                moveK[target] = UInt8(k)
                            }
                        }
                    }
                }
            }
        }

        var i = R
        var j = C
        while i > 0 || j > 0 {
            let idx = at(i, j)
            let m = idx >= 0 ? move[idx] : 0
            if m == 1 {
                result.rowToCol[i - 1] = j - 1
                result.rowKind[i - 1] = classify(i - 1, j - 1)
                i -= 1
                j -= 1
            } else if m == 4 {
                let k = Int(moveK[idx])
                for r in (i - k)..<i {
                    result.rowToCol[r] = j - 1
                    result.rowKind[r] = spokenExpanded
                }
                i -= k
                j -= 1
            } else if m == 2 || (m == 0 && i == 0) {
                j -= 1
            } else {
                i -= 1
            }
        }
        for r in 0..<R {
            let c = result.rowToCol[r]
            if c < 0 { continue }
            if result.colFirstRow[c] < 0 { result.colFirstRow[c] = r }
            result.colLastRow[c] = r
        }
        return result
    }

    /// For each display word, the markdown source word it renders, or -1.
    public static func projectDisplayToSource(_ displayWords: [KaraokeWord], _ sourceWords: [KaraokeWord]) -> [Int] {
        // Source-only words between anchors pull the path off the straight
        // line by up to their count; a fixed band then follows the wrong guide.
        let extra = min(projectionExtraBandMax, abs(sourceWords.count - displayWords.count))
        let core = alignCore(
            displayWords, sourceWords, projectionParams, uniqueAnchors(displayWords, sourceWords), projectionParams.band + extra
        )
        return (0..<displayWords.count).map { d in
            core.rowKind[d] == spokenExact || core.rowKind[d] == spokenFuzzy ? core.rowToCol[d] : -1
        }
    }

    private static func tokenAtOrAfter(_ tokens: [KaraokeWord], _ offset: Int) -> Int {
        var lo = 0
        var hi = tokens.count
        while lo < hi {
            let mid = (lo + hi) >> 1
            if tokens[mid].end <= offset { lo = mid + 1 } else { hi = mid }
        }
        return lo
    }

    /// speakable()'s fence patterns (karaoke-align.ts FENCES); `\z` is
    /// JavaScript's `$` without the multiline flag.
    private static let fences: [NSRegularExpression] = [
        #"```[^\n]*\n[\s\S]*?(?:```|\z)"#,
        #"~~~[^\n]*\n[\s\S]*?(?:~~~|\z)"#,
    ].map { pattern in
        // Constant patterns; a failure is a programming error the tests catch.
        // swiftlint:disable:next force_try
        try! NSRegularExpression(pattern: pattern)
    }

    /// Source words inside a fenced code block.  The bubble never shows
    /// them as reply text, so they stay out of the projection.
    private static func fencedWords(_ sourceText: String, _ sourceWords: [KaraokeWord]) -> [Bool] {
        var fenced = [Bool](repeating: false, count: sourceWords.count)
        let range = NSRange(location: 0, length: (sourceText as NSString).length)
        for pattern in fences {
            for m in pattern.matches(in: sourceText, options: [], range: range) {
                let start = m.range.location
                let end = start + m.range.length
                var w = tokenAtOrAfter(sourceWords, start)
                while w < sourceWords.count && sourceWords[w].start < end {
                    if sourceWords[w].start >= start { fenced[w] = true }
                    w += 1
                }
            }
        }
        return fenced
    }

    /// Expected display word per spoken word from the script's spans; -1
    /// where nothing on screen corresponds.
    public static func guideFromSpans(
        _ spokenWords: [KaraokeWord],
        segments: [SpeechSpan],
        sourceText: String,
        displayWords: [KaraokeWord]
    ) -> [Int] {
        var guide = [Int](repeating: -1, count: spokenWords.count)
        let sourceWords = tokenize(sourceText)
        if sourceWords.isEmpty || displayWords.isEmpty || segments.isEmpty { return guide }
        // Project onto the words the screen can show (not a fence's code),
        // then index back.
        let fenced = fencedWords(sourceText, sourceWords)
        let shown = sourceWords.indices.filter { !fenced[$0] }
        let displayToShown = projectDisplayToSource(displayWords, shown.map { sourceWords[$0] })
        var sourceToDisplay = [Int](repeating: -1, count: sourceWords.count)
        for (d, k) in displayToShown.enumerated() where k >= 0 && sourceToDisplay[shown[k]] < 0 {
            sourceToDisplay[shown[k]] = d
        }
        var next = -1
        for s in stride(from: sourceWords.count - 1, through: 0, by: -1) {
            if sourceToDisplay[s] >= 0 { next = sourceToDisplay[s] } else { sourceToDisplay[s] = next }
        }
        for (i, w) in spokenWords.enumerated() {
            let offset = SpeechSpans.sourceOffset(at: w.start, in: segments)
            let s = tokenAtOrAfter(sourceWords, offset)
            guide[i] = s < sourceWords.count ? sourceToDisplay[s] : -1
        }
        return guide
    }

    /// Pair spoken words with display words.
    public static func alignWords(
        _ spokenWords: [KaraokeWord],
        _ displayWords: [KaraokeWord],
        guide: [Int]? = nil,
        pronunciations: [Pronunciation] = []
    ) -> KaraokeMapping {
        let S = spokenWords.count
        let D = displayWords.count
        let anchors = guide.map { guideAnchors($0, S, D) } ?? uniqueAnchors(spokenWords, displayWords)
        let core = alignCore(
            spokenWords,
            displayWords,
            spokenParams,
            anchors,
            guide != nil ? guidedBand : spokenParams.band,
            pronunciations
        )
        var spokenToDisplay = [Int](repeating: -1, count: S)
        var previous = -1
        for s in 0..<S {
            if core.rowToCol[s] >= 0 { previous = core.rowToCol[s] }
            spokenToDisplay[s] = core.rowToCol[s] >= 0 ? core.rowToCol[s] : previous
        }
        var following = -1
        for s in stride(from: S - 1, through: 0, by: -1) {
            if core.rowToCol[s] >= 0 { following = core.rowToCol[s] } else if spokenToDisplay[s] < 0 { spokenToDisplay[s] = following }
        }
        return KaraokeMapping(
            spokenCount: S,
            displayCount: D,
            spokenToDisplay: spokenToDisplay,
            spokenKind: core.rowKind,
            displayFirstSpoken: core.colFirstRow,
            displayLastSpoken: core.colLastRow
        )
    }

    // MARK: Is it worth following?

    /// karaoke-align.ts FUNCTION_WORDS and SPOKEN_GLUE_WORDS.
    private static let functionWords: Set<String> = [
        "a", "an", "the", "and", "or", "but", "nor", "of", "to", "in", "on", "at", "for", "with", "by", "from", "as", "into",
        "is", "are", "was", "were", "be", "been", "being", "am", "it", "its", "this", "that", "these", "those", "i", "you",
        "we", "they", "he", "she", "me", "my", "your", "our", "their", "so", "then", "there", "here", "do", "does", "did",
        "has", "have", "had", "not", "no", "if", "now", "just", "also", "can", "will", "would", "up", "out", "all",
    ]
    private static let spokenGlueWords: Set<String> = [
        "dot", "slash", "colon", "underscore", "dash", "hyphen", "point", "percent", "dollar", "dollars", "cents", "plus",
        "minus", "equals", "hash", "first", "next", "finally", "lastly", "second", "third", "oh",
    ]
    /// karaoke-align.ts FOLLOW_SPOKEN_MIN (the reasoning and the
    /// measurements are there).  How much of the screen is covered is not a
    /// bar: a long list retold in a sentence is swept, not left dark.
    public static let followSpokenMin = (num: 1, den: 3)

    public static func quality(_ spokenWords: [KaraokeWord], _ displayWords: [KaraokeWord], _ mapping: KaraokeMapping) -> KaraokeQuality {
        var spokenContent = 0
        var spokenMatched = 0
        var hit = [Bool](repeating: false, count: displayWords.count)
        for s in 0..<spokenWords.count {
            let kind = mapping.spokenKind[s]
            let matched = kind == spokenExact || kind == spokenEquivalent || kind == spokenFuzzy || kind == spokenExpanded
            let d = mapping.spokenToDisplay[s]
            if matched && d >= 0 { hit[d] = true }
            let key = spokenWords[s].key
            if functionWords.contains(key) || spokenGlueWords.contains(key) { continue }
            spokenContent += 1
            if matched { spokenMatched += 1 }
        }
        var displayContent = 0
        var displayMatched = 0
        for d in 0..<displayWords.count where !functionWords.contains(displayWords[d].key) {
            displayContent += 1
            if hit[d] { displayMatched += 1 }
        }
        return KaraokeQuality(
            spokenContent: spokenContent, spokenMatched: spokenMatched, displayContent: displayContent, displayMatched: displayMatched
        )
    }

    /// Whether the highlight should follow an unguided alignment at all.
    /// The display counts are reported for diagnostics only.
    public static func followable(_ q: KaraokeQuality) -> Bool {
        if q.spokenMatched == 0 { return false }
        return q.spokenMatched * followSpokenMin.den >= q.spokenContent * followSpokenMin.num
    }

    /// The whole alignment in one call.  `segments` + `sourceText` are the
    /// spoken script's spans and the markdown they index; without them (a
    /// distilled script) the alignment anchors on words that occur once on
    /// each side.  MiniMax pause tags in `spokenText` are blanked first.
    /// `pronunciations` is the workspace list in force, so a respelled term
    /// ("sequel") pairs with the term on screen ("SQL").
    public static func alignSpokenToDisplay(
        spokenText: String,
        displayText: String,
        segments: [SpeechSpan]? = nil,
        sourceText: String? = nil,
        pronunciations: [Pronunciation] = []
    ) -> KaraokeAlignment {
        let spokenWords = tokenize(SpokenPause.mask(spokenText))
        let displayWords = tokenize(displayText)
        var guide: [Int]?
        if let segments, let sourceText, !sourceText.isEmpty {
            guide = guideFromSpans(spokenWords, segments: segments, sourceText: sourceText, displayWords: displayWords)
        }
        let guided = guide?.contains(where: { $0 >= 0 }) ?? false
        let mapping = alignWords(spokenWords, displayWords, guide: guided ? guide : nil, pronunciations: pronunciations)
        let quality = quality(spokenWords, displayWords, mapping)
        return KaraokeAlignment(
            spokenWords: spokenWords,
            displayWords: displayWords,
            mapping: mapping,
            guided: guided,
            quality: quality,
            // Spans tie every spoken word to its source, so a guided script
            // is always followed.
            followable: guided || followable(quality)
        )
    }

    // MARK: Timing

    /// Display-word times from spoken-word times.  `spokenTimes` is flat
    /// [start0, end0, start1, end1, ...] in ms; so is the result.
    public static func buildTimeline(
        spokenTimes: [Double],
        mapping: KaraokeMapping,
        skipStepMs: Double = 40,
        skipMaxMs: Double = 320
    ) -> [Double] {
        let S = mapping.spokenCount
        let D = mapping.displayCount
        var out = [Double](repeating: 0, count: D * 2)
        if D == 0 { return out }

        var paired: [Int] = []
        for j in 0..<D {
            let first = mapping.displayFirstSpoken[j]
            if first < 0 { continue }
            paired.append(j)
            out[2 * j] = spokenTimes[2 * first]
            out[2 * j + 1] = spokenTimes[2 * mapping.displayLastSpoken[j] + 1]
        }

        if paired.isEmpty {
            let t0 = S > 0 ? spokenTimes[0] : 0
            let t1 = S > 0 ? spokenTimes[2 * S - 1] : 0
            for j in 0..<D {
                out[2 * j] = t0 + ((t1 - t0) * Double(j)) / Double(D)
                out[2 * j + 1] = t0 + ((t1 - t0) * Double(j + 1)) / Double(D)
            }
            return out
        }

        for s in 0..<S where mapping.spokenKind[s] == spokenInserted {
            let j = mapping.spokenToDisplay[s]
            if j < 0 || mapping.displayFirstSpoken[j] < 0 { continue }
            if s > mapping.displayLastSpoken[j] {
                if spokenTimes[2 * s + 1] > out[2 * j + 1] { out[2 * j + 1] = spokenTimes[2 * s + 1] }
            } else if s < mapping.displayFirstSpoken[j] {
                if spokenTimes[2 * s] < out[2 * j] { out[2 * j] = spokenTimes[2 * s] }
            }
        }

        for p in 0..<paired.count {
            let j = paired[p]
            if p > 0 {
                let prev = paired[p - 1]
                if out[2 * j] < out[2 * prev] { out[2 * j] = out[2 * prev] }
                if out[2 * prev + 1] > out[2 * j] { out[2 * prev + 1] = out[2 * j] }
            }
            if out[2 * j + 1] < out[2 * j] { out[2 * j + 1] = out[2 * j] }
        }

        func sweep(_ from: Int, _ to: Int, _ startMs: Double, _ endMs: Double) {
            let run = to - from
            for k in 0..<run {
                out[2 * (from + k)] = startMs + ((endMs - startMs) * Double(k)) / Double(run)
                out[2 * (from + k) + 1] = startMs + ((endMs - startMs) * Double(k + 1)) / Double(run)
            }
        }

        let firstPaired = paired[0]
        if firstPaired > 0 {
            let budget = min(skipMaxMs, Double(firstPaired) * skipStepMs)
            sweep(0, firstPaired, out[2 * firstPaired] - budget, out[2 * firstPaired])
        }
        if paired.count > 1 {
            for p in 0..<(paired.count - 1) {
                let before = paired[p]
                let after = paired[p + 1]
                let run = after - before - 1
                if run <= 0 { continue }
                let budget = min(skipMaxMs, Double(run) * skipStepMs)
                let nextStart = out[2 * after]
                var sweepStart = nextStart - budget
                let halfway = out[2 * before] + (out[2 * before + 1] - out[2 * before]) / 2
                if sweepStart < halfway { sweepStart = halfway }
                if out[2 * before + 1] > sweepStart { out[2 * before + 1] = sweepStart }
                sweep(before + 1, after, sweepStart, nextStart)
            }
        }
        let lastPaired = paired[paired.count - 1]
        if lastPaired < D - 1 {
            let run = D - 1 - lastPaired
            let budget = min(skipMaxMs, Double(run) * skipStepMs)
            sweep(lastPaired + 1, D, out[2 * lastPaired + 1], out[2 * lastPaired + 1] + budget)
        }
        return out
    }

    /// Spoken-word times spread over clips by character offset (MiniMax).
    public static func proportionalWordTimes(_ spokenWords: [KaraokeWord], clips: [KaraokeClip]) -> [Double] {
        var out = [Double](repeating: 0, count: spokenWords.count * 2)
        var c = 0
        var carry = clips.first?.startMs ?? 0
        for (i, w) in spokenWords.enumerated() {
            while c < clips.count && clips[c].spokenEnd <= w.start {
                carry = clips[c].startMs + clips[c].durationMs
                c += 1
            }
            guard c < clips.count, w.start >= clips[c].spokenStart else {
                out[2 * i] = carry
                out[2 * i + 1] = carry
                continue
            }
            let clip = clips[c]
            let length = max(1, clip.spokenEnd - clip.spokenStart)
            let from = max(0, w.start - clip.spokenStart)
            let to = min(length, w.end - clip.spokenStart)
            out[2 * i] = clip.startMs + (clip.durationMs * Double(from)) / Double(length)
            out[2 * i + 1] = clip.startMs + (clip.durationMs * Double(to)) / Double(length)
        }
        return out
    }

    /// Estimated back-to-back clips at `msPerChar` per character.
    public static func estimatedClips(_ utterances: [SpokenUtterance], msPerChar: Double = defaultMsPerChar) -> [KaraokeClip] {
        var t = 0.0
        return utterances.map { u in
            let duration = Double(max(0, u.spokenEnd - u.spokenStart)) * msPerChar
            let clip = KaraokeClip(spokenStart: u.spokenStart, spokenEnd: u.spokenEnd, startMs: t, durationMs: duration)
            t += duration
            return clip
        }
    }

    /// The spoken word at a UTF-16 offset (containing it, else the next one),
    /// or -1 past the last word.  For willSpeakRangeOfSpeechString locations.
    public static func wordIndex(atUTF16 offset: Int, in words: [KaraokeWord]) -> Int {
        let index = tokenAtOrAfter(words, offset)
        return index < words.count ? index : -1
    }
}
