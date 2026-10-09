// Karaoke on iPhone: the reply being read aloud follows its own voice, in
// the bubble itself.
//
// The pieces that can be tested live in CompanionCore: the spoken script
// and its spans (KaraokeScript), the rendered words of the bubble
// (KaraokeDisplay), the alignment (KaraokeAlign), and the timing
// (KaraokePlayhead, KaraokeClipClock).  This file holds the parts that need
// UIKit and SwiftUI:
//
// - `KaraokeCenter` knows the one message following its voice.  Bubbles
//   read it to find out whether they are that message; it changes when a
//   read starts and ends, never per word.
// - `MessageKaraoke` drives that message: a display link runs only while
//   something is animating, computes the frame from the voice's clock, and
//   repaints only the blocks whose paint changed.
// - `KaraokeBlockState` is one block's painted text.  Each is observed only
//   by the one `InlineMarkdown` that draws it, so a word moving repaints
//   one paragraph, not the transcript.
//
// Only color and background change, never weight or size, so lines never
// re-wrap and the transcript never jumps.  Reduce Motion steps whole words
// with no sweep and no trail.
import AVFoundation
import CompanionCore
import QuartzCore
import SwiftUI

@Observable
@MainActor
final class KaraokeCenter {
    static let shared = KaraokeCenter()

    /// How long the last word keeps its trail after the voice finishes.
    static let lingerMs: UInt64 = 450

    private(set) var active: MessageKaraoke?
    @ObservationIgnored private var linger: Task<Void, Never>?

    /// The karaoke for `messageId`, or nil when another message (or none)
    /// is following its voice.
    func karaoke(for messageId: String) -> MessageKaraoke? {
        guard let active, active.messageId == messageId else { return nil }
        return active
    }

    /// Follow `script` over the reply `messageText`.  Nil when the bubble
    /// has no words to follow, the script is too long to align before the
    /// first word (KaraokeScript.isFollowable), or it does not line up with
    /// the message (a brief summary: KaraokeAlignment.followable, the same
    /// rule as the Mac's).
    @discardableResult
    func begin(messageId: String, messageText: String, script: KaraokeScript, mode: MessageKaraoke.Mode) -> MessageKaraoke? {
        clear()
        guard script.isFollowable else { return nil }
        let karaoke = MessageKaraoke(
            messageId: messageId,
            markdown: KaraokeDisplay.bubbleMarkdown(messageText),
            sourceText: SpeechProjection.writtenReply(messageText),
            script: script,
            mode: mode,
            reducedMotion: UIAccessibility.isReduceMotionEnabled
        )
        // Lighting scattered words would be worse than lighting none.
        guard karaoke.alignment.followable else {
            karaoke.dispose()
            return nil
        }
        active = karaoke
        return karaoke
    }

    /// The voice read to the end: let the last word settle, then clear.
    func finish(_ karaoke: MessageKaraoke?) {
        guard let karaoke, active === karaoke, !karaoke.isFinished else { return }
        karaoke.markFinished()
        linger?.cancel()
        linger = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.lingerMs * 1_000_000)
            guard !Task.isCancelled, let self, self.active === karaoke else { return }
            self.clear()
        }
    }

    /// The voice stopped early: clear at once.  A reply that finished keeps
    /// its short linger.
    func stop() {
        guard let active, !active.isFinished else { return }
        clear()
    }

    private func clear() {
        linger?.cancel()
        linger = nil
        active?.dispose()
        active = nil
    }
}

@MainActor
final class MessageKaraoke {
    enum Mode {
        /// A hosted voice: one audio clip per utterance.
        case clips
        /// Apple Personal Voice: words reported as they are spoken.
        case live
    }

    /// A live word's first estimate is at least this long; the next word's
    /// cue cuts it short.
    private static let liveMinMs: Double = 140

    let messageId: String
    let mode: Mode
    let display: KaraokeDisplay
    let alignment: KaraokeAlignment
    let script: KaraokeScript
    private(set) var isFinished = false

    private var playhead: KaraokePlayhead
    private var clipClock: KaraokeClipClock
    private weak var player: AVAudioPlayer?
    private var chunkStarts: [Int] = []
    /// Keyed by the block's index in `Markdown.blocks`, the bubble's
    /// ForEach offset.
    private let blocks: [Int: KaraokeBlockState]
    /// Current paint, by position in `display.blocks`.
    private var painted: [Int: KaraokeBlockPaint] = [:]
    private var frame = KaraokeFrame.none
    private var ticker: KaraokeTicker?
    private var disposed = false
    /// DEBUG fixture only: a pinned clock for screenshots.
    var debugClock: (() -> Double)?

    init(messageId: String, markdown: String, sourceText: String, script: KaraokeScript, mode: Mode, reducedMotion: Bool) {
        self.messageId = messageId
        self.mode = mode
        self.script = script
        let display = KaraokeDisplay(markdown: markdown)
        self.display = display
        // The spans index the written reply.  When this phone's copy of it
        // is not the text the harness projected (another length), they
        // would guide the alignment to the wrong words, so it anchors on
        // words that occur once on each side instead, as it does for a
        // distilled script, which has no spans.
        let guided = script.guides(sourceText)
        alignment = KaraokeAlign.alignSpokenToDisplay(
            spokenText: script.spokenText,
            displayText: display.text,
            segments: guided ? script.segments : nil,
            sourceText: guided ? sourceText : nil
        )
        playhead = KaraokePlayhead(words: display.words, reducedMotion: reducedMotion)
        clipClock = KaraokeClipClock(clips: script.estimatedClips())
        var states: [Int: KaraokeBlockState] = [:]
        for block in display.blocks {
            states[block.index] = KaraokeBlockState(markdown: block.markdown, base: block.rendered)
        }
        blocks = states
        if mode == .clips { retime() }
    }

    /// The painted text of block `index` when it still shows `markdown`.
    /// A bubble whose blocks are not the ones aligned paints nothing.
    func block(_ index: Int, markdown: String) -> KaraokeBlockState? {
        guard let state = blocks[index], state.markdown == markdown else { return nil }
        return state
    }

    // MARK: Hosted clips

    /// Clip `index` started playing in `player`.
    func attachClip(_ index: Int, player: AVAudioPlayer) {
        guard mode == .clips, !disposed else { return }
        self.player = player
        if clipClock.attach(index, durationSeconds: player.duration) { retime() }
        startTicking()
    }

    /// Clip `index` stopped being audible.
    func detachClip(_ index: Int, finished: Bool) {
        guard mode == .clips else { return }
        clipClock.detach(index, finished: finished)
    }

    /// Display-word times from the clip windows, proportional to character
    /// offsets within each clip.
    private func retime() {
        let spokenTimes = KaraokeAlign.proportionalWordTimes(alignment.spokenWords, clips: clipClock.clips)
        playhead.setTimeline(KaraokeAlign.buildTimeline(spokenTimes: spokenTimes, mapping: alignment.mapping))
    }

    // MARK: Personal Voice

    /// The texts the synthesizer speaks, in order (packed utterances).
    func setChunks(_ chunks: [String]) {
        chunkStarts = script.chunkStarts(chunks)
    }

    /// The synthesizer is about to speak the word at UTF-16 `location` of
    /// chunk `chunk`, as of `at` (CACurrentMediaTime seconds).
    func liveWord(chunk: Int, location: Int, at: CFTimeInterval) {
        guard mode == .live, !disposed, chunk >= 0, chunk < chunkStarts.count, chunkStarts[chunk] >= 0 else { return }
        let words = alignment.spokenWords
        let s = KaraokeAlign.wordIndex(atUTF16: chunkStarts[chunk] + location, in: words)
        guard s >= 0, s < alignment.mapping.spokenToDisplay.count else { return }
        let d = alignment.mapping.spokenToDisplay[s]
        guard d >= 0 else { return }
        let estimate = max(Self.liveMinMs, Double(words[s].end - words[s].start) * KaraokeAlign.defaultMsPerChar)
        playhead.cue(d, durationMs: estimate, atMs: at * 1000, nowMs: now())
        startTicking()
    }

    // MARK: Frames

    private func now() -> Double {
        if let debugClock { return debugClock() }
        switch mode {
        case .live:
            return CACurrentMediaTime() * 1000
        case .clips:
            return clipClock.time(currentTime: player?.currentTime)
        }
    }

    /// Paint the frame for the current clock once, without a display link
    /// (the DEBUG fixture's pinned clock).
    func renderNow() {
        tick()
    }

    private func startTicking() {
        guard ticker == nil, !disposed else { return }
        ticker = KaraokeTicker { [weak self] in
            guard let self else { return false }
            return self.tick()
        }
    }

    /// One display frame.  False once nothing is left to animate.
    @discardableResult
    private func tick() -> Bool {
        guard !disposed else { return false }
        let t = now()
        let next = playhead.frame(at: t)
        let changed = next != frame
        if changed {
            frame = next
            repaint()
        }
        // Between clips the clip clock holds still (the next one may still
        // be in synthesis), so the frame cannot change until attachClip,
        // which starts the ticker again.
        let waitingForClip = mode == .clips && debugClock == nil && !clipClock.isAttached && !changed
        if playhead.idle(at: t) || waitingForClip {
            ticker?.invalidate()
            ticker = nil
            return false
        }
        return true
    }

    private func repaint() {
        let next = display.paints(for: frame)
        for position in Set(painted.keys).union(next.keys) where painted[position] != next[position] {
            blocks[display.blocks[position].index]?.apply(next[position])
        }
        painted = next
    }

    func markFinished() {
        isFinished = true
    }

#if DEBUG
    /// The fixture's free-running clock needs the display link started.
    func debugStart() {
        startTicking()
    }

    /// When display word `index` is spoken on the current timeline.
    func debugWindow(_ index: Int) -> (start: Double, end: Double) {
        (playhead.timeline[2 * index], playhead.timeline[2 * index + 1])
    }
#endif

    /// Stop the display link and restore every painted block.
    func dispose() {
        guard !disposed else { return }
        disposed = true
        ticker?.invalidate()
        ticker = nil
        for position in painted.keys {
            blocks[display.blocks[position].index]?.apply(nil)
        }
        painted = [:]
        frame = .none
    }
}

/// One block's text with the karaoke paint applied.
@Observable
@MainActor
final class KaraokeBlockState {
    @ObservationIgnored let markdown: String
    @ObservationIgnored private let base: AttributedString
    @ObservationIgnored private let plain: String
    private(set) var text: AttributedString

    init(markdown: String, base: AttributedString) {
        self.markdown = markdown
        self.base = base
        plain = String(base.characters)
        text = base
    }

    func apply(_ paint: KaraokeBlockPaint?) {
        guard let paint, !paint.isEmpty else {
            text = base
            return
        }
        var out = base
        for trail in paint.trail {
            guard let range = range(trail.range, in: out) else { continue }
            out[range].foregroundColor = KaraokeStyle.trail[min(trail.level, KaraokeStyle.trail.count - 1)]
        }
        if let lit = paint.lit, let range = range(lit, in: out) {
            out[range].foregroundColor = KaraokeStyle.lit
            out[range].backgroundColor = KaraokeStyle.wash
        }
        text = out
    }

    /// UTF-16 offsets in the run to a range of `text`.
    private func range(_ utf16: Range<Int>, in text: AttributedString) -> Range<AttributedString.Index>? {
        guard let stringRange = SpeechSpans.stringRange(utf16: utf16.lowerBound, utf16.upperBound, in: plain) else { return nil }
        let scalars = plain.unicodeScalars
        let start = scalars.distance(from: scalars.startIndex, to: stringRange.lowerBound)
        let count = scalars.distance(from: stringRange.lowerBound, to: stringRange.upperBound)
        let lower = text.unicodeScalars.index(text.unicodeScalars.startIndex, offsetBy: start)
        let upper = text.unicodeScalars.index(lower, offsetBy: count)
        return lower..<upper
    }
}

/// The colors.  Color only: a weight or size change would re-wrap lines.
enum KaraokeStyle {
    /// The part of the current word already spoken.
    static let lit = Color.accentColor
    /// A light wash behind it, so the word reads as marked without a bold.
    static let wash = Color.accentColor.opacity(0.16)
    /// Words just spoken, fading from a softer accent back to normal ink.
    static let trail: [Color] = [0.55, 0.35, 0.18].map { Color.primary.mix(with: .accentColor, by: $0) }
}

/// A display link that runs while its owner has something to animate.
/// Thirty frames a second is plenty for a sweep one letter at a time.
private final class KaraokeTicker: NSObject {
    private var link: CADisplayLink?
    private let onTick: @MainActor () -> Bool

    init(onTick: @escaping @MainActor () -> Bool) {
        self.onTick = onTick
        super.init()
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 60, preferred: 30)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func tick() {
        let keepGoing = MainActor.assumeIsolated { onTick() }
        if !keepGoing { invalidate() }
    }

    /// The link retains its target, so this must run to free the ticker.
    func invalidate() {
        link?.invalidate()
        link = nil
    }
}

// MARK: - Rendering

private struct MessageKaraokeKey: EnvironmentKey {
    static var defaultValue: MessageKaraoke? { nil }
}

private struct MarkdownBlockIndexKey: EnvironmentKey {
    static var defaultValue: Int { -1 }
}

extension EnvironmentValues {
    /// The karaoke of the message this bubble draws, when it is the one
    /// being read aloud.
    var messageKaraoke: MessageKaraoke? {
        get { self[MessageKaraokeKey.self] }
        set { self[MessageKaraokeKey.self] = newValue }
    }

    /// Which `Markdown.blocks` entry a MarkdownText block is.
    var markdownBlockIndex: Int {
        get { self[MarkdownBlockIndexKey.self] }
        set { self[MarkdownBlockIndexKey.self] = newValue }
    }
}

/// A block's inline run.  The rendered markdown, or, while the message is
/// read aloud, the same run with the karaoke paint (observed per block).
struct InlineMarkdown: View {
    let text: String
    let caret: Text
    @Environment(\.messageKaraoke) private var karaoke
    @Environment(\.markdownBlockIndex) private var blockIndex

    var body: Text {
        let attributed = karaoke?.block(blockIndex, markdown: text)?.text ?? Markdown.inlineAttributed(text)
        return Text(attributed) + caret
    }
}
