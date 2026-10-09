//
//  KaraokePlayhead.swift
//  CompanionCore
//
//  When each word on screen is spoken, and what to paint at a moment.
//  The timing half of src/lib/karaoke-highlight.ts, without the painting:
//
//  - A timeline is flat [start0, end0, start1, end1, ...] per display word
//    in ms (KaraokeAlign.buildTimeline).  A hosted voice (MiniMax) plays one;
//    its clock is the audio position (`KaraokeClipClock`).
//  - Live mode is Apple Personal Voice: each word is cued as the
//    synthesizer reports it.  Words the voice skipped (a code block, a URL)
//    are swept through quickly before the cued word.
//  - `frame(at:)` says which word is current, how much of it has "rolled
//    in" (grapheme by grapheme over its duration), and which words just
//    finished and are fading back to normal ink.  Under Reduce Motion whole
//    words step on and nothing trails.
//
//  Times are milliseconds on one clock the caller picks.
//

import Foundation

/// What to paint at one moment.  Equatable, so a caller repaints only when
/// the picture changes, not every display frame.
public struct KaraokeFrame: Equatable, Sendable {
    /// The display word being spoken, or -1.
    public var current: Int
    /// UTF-16 units of the current word painted, from its start.
    public var lit: Int
    /// Words that just finished, newest first.
    public var trail: [KaraokeTrailWord]

    public init(current: Int = -1, lit: Int = 0, trail: [KaraokeTrailWord] = []) {
        self.current = current
        self.lit = lit
        self.trail = trail
    }

    public static let none = KaraokeFrame()
}

public struct KaraokeTrailWord: Equatable, Sendable {
    public let index: Int
    /// 0 is the strongest, just after the word ended.
    public let level: Int

    public init(index: Int, level: Int) {
        self.index = index
        self.level = level
    }
}

public struct KaraokePlayhead: Sendable {
    /// A live word's first estimate when the caller has none.
    public static let liveDefaultMs: Double = 320
    /// Under Reduce Motion a word swept past faster than this is not shown.
    public static let reducedMotionMinMs: Double = 80

    public let words: [KaraokeWord]
    public let reducedMotion: Bool
    /// How long a finished word keeps the softer accent.
    public var trailMs: Double = 220
    /// How many steps the trail fades through.
    public var trailLevels: Int = 3
    /// Live mode: sweep step and ceiling for skipped words (as the timeline).
    public var skipStepMs: Double = 40
    public var skipMaxMs: Double = 320

    public private(set) var timeline: [Double]
    public private(set) var isLive = false
    private var liveIndex = -1

    public init(words: [KaraokeWord], reducedMotion: Bool) {
        self.words = words
        self.reducedMotion = reducedMotion
        self.timeline = [Double](repeating: .infinity, count: words.count * 2)
    }

    /// Timeline mode.  Missing entries are "not yet".
    public mutating func setTimeline(_ next: [Double]) {
        isLive = false
        liveIndex = -1
        timeline = (0..<(words.count * 2)).map { $0 < next.count ? next[$0] : .infinity }
    }

    /// Live mode: word `index` starts at `atMs` (default `nowMs`) and lasts
    /// `durationMs`.  Earlier unspoken words are swept quickly first.  A cue
    /// for the same word extends it.  A time in the future is treated as
    /// now, and a word never starts before the previous one.  A cue for an
    /// earlier word (a restart) makes everything after it unspoken again.
    public mutating func cue(_ index: Int, durationMs: Double = KaraokePlayhead.liveDefaultMs, atMs: Double? = nil, nowMs: Double) {
        guard index >= 0, index < words.count else { return }
        if !isLive {
            isLive = true
            liveIndex = -1
            timeline = [Double](repeating: .infinity, count: words.count * 2)
        }
        let duration = max(0, durationMs)
        var at = atMs.map { $0.isFinite ? min(nowMs, $0) : nowMs } ?? nowMs
        if liveIndex >= 0 && index >= liveIndex { at = max(at, timeline[2 * liveIndex]) }
        if index == liveIndex {
            timeline[2 * index + 1] = max(timeline[2 * index + 1], at + duration)
            return
        }
        if index < liveIndex {
            for i in index..<words.count {
                timeline[2 * i] = .infinity
                timeline[2 * i + 1] = .infinity
            }
        } else if liveIndex >= 0 && timeline[2 * liveIndex + 1] > at {
            timeline[2 * liveIndex + 1] = at
        }
        let from = max(0, index < liveIndex ? index : liveIndex + 1)
        let run = index - from
        let budget = min(skipMaxMs, Double(run) * skipStepMs)
        for k in 0..<max(0, run) {
            timeline[2 * (from + k)] = at + (budget * Double(k)) / Double(run)
            timeline[2 * (from + k) + 1] = at + (budget * Double(k + 1)) / Double(run)
        }
        timeline[2 * index] = at + budget
        timeline[2 * index + 1] = at + budget + duration
        liveIndex = index
    }

    /// The last word whose start is at or before `t`, or -1.
    public func index(at t: Double) -> Int {
        var lo = 0
        var hi = words.count - 1
        var found = -1
        while lo <= hi {
            let mid = (lo + hi) / 2
            if timeline[2 * mid] <= t {
                found = mid
                lo = mid + 1
            } else {
                hi = mid - 1
            }
        }
        return found
    }

    /// What to paint at `t`.
    public func frame(at t: Double) -> KaraokeFrame {
        guard !words.isEmpty else { return .none }
        let c = index(at: t)
        var frame = KaraokeFrame()
        if c >= 0 {
            let start = timeline[2 * c]
            let end = timeline[2 * c + 1]
            let duration = end - start
            let speaking = t < end
            if speaking && (!reducedMotion || duration >= Self.reducedMotionMinMs) {
                let word = words[c]
                var cut = word.end - word.start
                if !reducedMotion && duration > 0 && duration.isFinite {
                    let bounds = Self.graphemeBoundaries(word.text)
                    let steps = bounds.count - 1
                    let progress = max(0, min(1, (t - start) / duration))
                    // At least the first grapheme is lit as soon as the word starts.
                    cut = bounds[max(1, min(steps, Int((progress * Double(steps)).rounded(.up))))]
                }
                frame.current = c
                frame.lit = cut
            }
        }
        if !reducedMotion && trailMs > 0 && c >= 0 {
            // Recently finished words, newest first; ends never decrease, so
            // stop at the first one that finished too long ago.
            var i = frame.current == c ? c - 1 : c
            var n = 0
            while i >= 0 && n < 8 {
                defer { i -= 1; n += 1 }
                let end = timeline[2 * i + 1]
                if end > t { continue }
                let since = t - end
                if since >= trailMs { break }
                let level = min(trailLevels - 1, Int(since / trailMs * Double(trailLevels)))
                frame.trail.append(KaraokeTrailWord(index: i, level: level))
            }
        }
        return frame
    }

    /// True once the timeline has played out, trail included.  Never in
    /// live mode: the voice decides when that ends.
    public func finished(at t: Double) -> Bool {
        if words.isEmpty { return true }
        if isLive { return false }
        return t >= timeline[2 * words.count - 1] + trailMs
    }

    /// True when nothing is left to animate at `t` for what is known so
    /// far: a timeline has played out, or a live voice's last cued word and
    /// its trail are over.  A new cue wakes a live playhead again.
    public func idle(at t: Double) -> Bool {
        if words.isEmpty { return true }
        guard isLive else { return finished(at: t) }
        guard liveIndex >= 0 else { return true }
        return t >= timeline[2 * liveIndex + 1] + trailMs
    }

    /// UTF-16 offsets of grapheme boundaries in `text`, from 0 to its length.
    public static func graphemeBoundaries(_ text: String) -> [Int] {
        var out = [0]
        var at = 0
        for character in text {
            at += character.utf16.count
            out.append(at)
        }
        if out.last != text.utf16.count { out.append(text.utf16.count) }
        return out
    }
}

/// A hosted voice's clock: one clip per utterance, played back to back.
/// A mirror of ClipsKaraoke in src/lib/tts/karaoke-feed.ts.
///
/// Each clip window starts as an estimate and takes the clip's real length
/// once the player knows it; later windows shift so each starts where the
/// one before ends.  The clock is the playing clip's start plus the
/// player's position, held between clips, clamped to a measured clip's
/// length, and never going backwards.
public struct KaraokeClipClock: Sendable {
    public private(set) var clips: [KaraokeClip]
    private var index = -1
    private var attached = false
    private var held: Double = 0
    private var measured = Set<Int>()

    public init(clips: [KaraokeClip]) {
        self.clips = clips
    }

    /// A clip is playing.  While none is (between clips) the clock holds
    /// still, so nothing on screen changes until the next clip attaches.
    public var isAttached: Bool { attached }

    /// Clip `index` is now the audible one, `durationSeconds` long.  True
    /// when the windows moved (re-time the words).
    @discardableResult
    public mutating func attach(_ index: Int, durationSeconds: Double) -> Bool {
        self.index = index
        attached = true
        if index >= 0, index < clips.count, clips[index].startMs > held { held = clips[index].startMs }
        return measure(index, seconds: durationSeconds)
    }

    /// The real length of clip `index`.  True when the windows moved.
    @discardableResult
    public mutating func measure(_ index: Int, seconds: Double) -> Bool {
        guard index >= 0, index < clips.count, seconds.isFinite, seconds > 0 else { return false }
        let durationMs = seconds * 1000
        if measured.contains(index) && abs(clips[index].durationMs - durationMs) < 1 { return false }
        clips[index].durationMs = durationMs
        measured.insert(index)
        if index + 1 < clips.count {
            for i in (index + 1)..<clips.count {
                clips[i].startMs = clips[i - 1].startMs + clips[i - 1].durationMs
            }
        }
        return true
    }

    /// Clip `index` stopped being audible.  The clock holds at its end until
    /// the next clip starts.
    public mutating func detach(_ index: Int, finished: Bool) {
        guard index == self.index else { return }
        attached = false
        if finished, index >= 0, index < clips.count {
            held = max(held, clips[index].startMs + clips[index].durationMs)
        }
    }

    /// Position on the clip timeline in ms.  `currentTime` is the attached
    /// player's position in seconds.
    public mutating func time(currentTime: Double?) -> Double {
        if attached, index >= 0, index < clips.count, let seconds = currentTime, seconds.isFinite, seconds >= 0 {
            var at = clips[index].startMs + seconds * 1000
            if measured.contains(index) { at = min(at, clips[index].startMs + clips[index].durationMs) }
            if at > held { held = at }
        }
        return held
    }
}
