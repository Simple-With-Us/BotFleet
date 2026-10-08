//
//  KaraokeScript.swift
//  CompanionCore
//
//  The spoken script a reply's voice reads, as the harness hands it over for
//  karaoke.  A mirror of shared/spoken-script.ts.
//
//  POST /audio with `spans: true` answers `script: "written"` when the voice
//  reads the reply as written (the default), plus `spans`: for every
//  utterance, the source span of each stretch of spoken text in
//  writtenReply(message.text).  A summary (an explicit Voice Summary mode)
//  answers `script: "summary"` and carries no spans, and gets no karaoke.
//
//  Wire format, version `SpokenSpansWire.currentFormat`:
//    { format: 1, source: "written", sourceLength, utterances: [[Int]] }
//  Each utterance entry is a flat list of quintuples
//    [spokenStart, spokenEnd, srcStart, srcEnd, kind, ...]
//  Spoken offsets are LOCAL to that utterance, source offsets index the
//  written reply, kind is 0 (copy) or 1 (insert).  Every offset is a UTF-16
//  code unit, the same unit as a JavaScript string index and NSString.
//

import Foundation

/// The `spans` member of the /audio answer.
public struct SpokenSpansWire: Codable, Equatable, Sendable {
    public static let currentFormat = 1

    public var format: Int
    public var source: String
    /// Length of writtenReply(message.text) in UTF-16 code units.
    public var sourceLength: Int
    public var utterances: [[Int]]

    public init(format: Int = SpokenSpansWire.currentFormat, source: String = "written", sourceLength: Int, utterances: [[Int]]) {
        self.format = format
        self.source = source
        self.sourceLength = sourceLength
        self.utterances = utterances
    }

    /// The spans for `utterances` made from `sourceText` (what the harness
    /// sends; used here for the local fallback and in tests).
    public static func encode(sourceText: String, utterances: [SpokenUtterance]) -> SpokenSpansWire {
        SpokenSpansWire(
            sourceLength: sourceText.utf16.count,
            utterances: utterances.map { utterance in
                utterance.segments.flatMap { [$0.spokenStart, $0.spokenEnd, $0.srcStart, $0.srcEnd, $0.kind.rawValue] }
            }
        )
    }
}

/// Everything a highlighter needs to line a voice up with the message.
public struct KaraokeScript: Equatable, Sendable {
    public struct Utterance: Equatable, Sendable {
        /// Where the utterance sits in `spokenText`, UTF-16, end exclusive.
        public let spokenStart: Int
        public let spokenEnd: Int
    }

    /// The utterances joined with single spaces: exactly the words voiced,
    /// in order.  Clip windows and Personal Voice chunks index into this.
    public let spokenText: String
    public let utterances: [Utterance]
    /// Spans with spoken offsets in `spokenText` and source offsets in the
    /// written reply.  Empty when the spans were absent or did not check
    /// out; the aligner then anchors on words that occur once on each side.
    public let segments: [SpeechSpan]
    /// Length of the source the spans index, or nil without spans.
    public let sourceLength: Int?

    /// The script for `utterances` as the harness returned them, with the
    /// spans when they are present and consistent.  Bad spans are dropped
    /// rather than trusted, so the highlight falls back to unguided
    /// alignment instead of pointing at the wrong words.
    public static func fromWire(utterances texts: [String], wire: SpokenSpansWire?) -> KaraokeScript {
        var placed: [Utterance] = []
        var at = 0
        for text in texts {
            let length = text.utf16.count
            placed.append(Utterance(spokenStart: at, spokenEnd: at + length))
            at += length + 1
        }
        let spokenText = texts.joined(separator: " ")
        let bare = KaraokeScript(spokenText: spokenText, utterances: placed, segments: [], sourceLength: nil)
        guard let wire,
              wire.format == SpokenSpansWire.currentFormat,
              wire.source == "written",
              wire.sourceLength >= 0,
              wire.utterances.count == texts.count
        else { return bare }

        var segments: [SpeechSpan] = []
        for index in texts.indices {
            guard let decoded = decode(
                wire.utterances[index],
                utteranceLength: placed[index].spokenEnd - placed[index].spokenStart,
                offset: placed[index].spokenStart,
                sourceLength: wire.sourceLength
            ) else { return bare }
            if let last = segments.last, let first = decoded.first, first.srcStart < last.srcStart { return bare }
            segments.append(contentsOf: decoded)
        }
        return KaraokeScript(spokenText: spokenText, utterances: placed, segments: segments, sourceLength: wire.sourceLength)
    }

    /// A script with no spans, for speech this phone projected itself.
    public static func unguided(utterances texts: [String]) -> KaraokeScript {
        fromWire(utterances: texts, wire: nil)
    }

    /// One utterance's quintuples, checked; nil when anything is off.
    private static func decode(_ flat: [Int], utteranceLength: Int, offset: Int, sourceLength: Int) -> [SpeechSpan]? {
        guard flat.count % 5 == 0 else { return nil }
        var out: [SpeechSpan] = []
        var lastSpoken = 0
        var lastSrc = 0
        var i = 0
        while i < flat.count {
            let spokenStart = flat[i], spokenEnd = flat[i + 1], srcStart = flat[i + 2], srcEnd = flat[i + 3], kind = flat[i + 4]
            i += 5
            guard spokenStart >= 0, spokenEnd >= 0, srcStart >= 0, srcEnd >= 0,
                  let spanKind = SpeechSpan.Kind(rawValue: kind),
                  spokenStart >= lastSpoken, spokenEnd >= spokenStart, spokenEnd <= utteranceLength,
                  srcStart >= lastSrc, srcEnd >= srcStart, srcEnd <= sourceLength
            else { return nil }
            lastSpoken = spokenEnd
            lastSrc = srcStart
            out.append(SpeechSpan(
                spokenStart: spokenStart + offset,
                spokenEnd: spokenEnd + offset,
                srcStart: srcStart,
                srcEnd: srcEnd,
                kind: spanKind
            ))
        }
        return out
    }

    /// True when the spans index `sourceText` (the client's own
    /// writtenReply(message.text)).  A different length means a different
    /// text, so the spans would guide the alignment to the wrong words.
    public func guides(_ sourceText: String) -> Bool {
        !segments.isEmpty && sourceLength == sourceText.utf16.count
    }

    /// Where each chunk a synthesizer speaks starts in `spokenText`, or -1
    /// when it cannot be found.  Chunks are found in order, each after the
    /// last, so a sentence said twice maps to the right occurrence.  (The
    /// Mac does the same: `spokenText.indexOf(group, cursor)`.)
    public func chunkStarts(_ chunks: [String]) -> [Int] {
        let spoken = spokenText as NSString
        var cursor = 0
        return chunks.map { chunk in
            guard !chunk.isEmpty, cursor <= spoken.length else { return -1 }
            let found = spoken.range(
                of: chunk,
                options: [.literal],
                range: NSRange(location: cursor, length: spoken.length - cursor)
            )
            guard found.location != NSNotFound else { return -1 }
            cursor = found.location + found.length
            return found.location
        }
    }

    /// Back-to-back clip windows estimated at `msPerChar`, one per
    /// utterance.  A hosted voice replaces each estimate with the clip's
    /// real length once it is known (`KaraokeClipClock`).
    public func estimatedClips(msPerChar: Double = KaraokeAlign.defaultMsPerChar) -> [KaraokeClip] {
        var t = 0.0
        return utterances.map { u in
            let duration = Double(max(0, u.spokenEnd - u.spokenStart)) * msPerChar
            defer { t += duration }
            return KaraokeClip(spokenStart: u.spokenStart, spokenEnd: u.spokenEnd, startMs: t, durationMs: duration)
        }
    }
}

extension MessageVoice {
    /// The written-mode script the harness answered with, or nil for a
    /// summary (no karaoke) or a harness too old to say.
    public var karaokeScript: KaraokeScript? {
        guard script == "written", let utterances, !utterances.isEmpty else { return nil }
        return KaraokeScript.fromWire(utterances: utterances, wire: spans)
    }
}
