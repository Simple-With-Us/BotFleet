// Playback for a voice call: provider PCM16 out of the speaker, scheduled
// gaplessly, with played-duration tracking for barge-in.
//
// Both providers send 24 kHz mono PCM16.  The player keeps its own clock
// (`nextStart`) so chunks schedule back to back with no gaps and no overlap,
// exactly like the desktop's LivePlayback nextStart chaining.
//
// Barge-in needs to know how much the caller actually heard: when the user
// speaks over the bot, playback stops locally and the session is told to
// drop the unheard tail (`playedMs()` feeds the truncate call).  Without the
// truncate the model keeps generating audio for an utterance the caller cut
// off, and talks over itself for the rest of the turn.
import AVFoundation
import Foundation
import CompanionCore

@MainActor
public final class VoicePlayback: ObservableObject {
    /// 24 kHz mono PCM16, both providers.
    public static let sampleRate: Double = 24_000

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format: AVAudioFormat
    /// Player-timeline sample count scheduled so far.  Gapless chaining is
    /// sample arithmetic, not clock conversion: each buffer starts where the
    /// last one ends, in the player's own timeline.
    private var nextSample: AVAudioFramePosition = 0
    /// Player-timeline sample where the current utterance started.  Played
    /// time is (now - utteranceStart) / rate; freezing it on stop() is what
    /// makes playedMs() report what was heard before a barge-in.
    private var utteranceStart: AVAudioFramePosition = 0
    private var hasUtterance = false
    /// Seconds heard, frozen at the last stopPlayback.  playedMs() reads
    /// this when no utterance is live, so a barge-in truncate still reports
    /// what the caller heard before the cut.
    private var frozenHeard: Double = 0
    private var running = false
    /// Buffers scheduled and not yet rendered.  Hitting zero is the natural
    /// end of an utterance.  stopPlayback bumps the generation so a late
    /// callback cannot clear the utterance that replaced it.
    private var pendingBuffers = 0
    private var scheduleGeneration = 0

    public init?() {
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: Self.sampleRate,
            channels: 1,
            interleaved: true
        ) else { return nil }
        self.format = format
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
    }

    /// Milliseconds of audio the caller has actually heard this utterance.
    /// Feeds the provider truncate call on barge-in.
    public var playedMs: Int {
        Int(max(0, playedSeconds) * 1000)
    }

    /// Whether audio is scheduled or sounding now.
    public var isPlaying: Bool {
        guard running, hasUtterance else { return false }
        return playedSeconds * Self.sampleRate < Double(nextSample - utteranceStart)
    }

    public func start() throws {
        if running { return }
        engine.prepare()
        try engine.start()
        player.play()
        running = true
    }

    /// Append one PCM16 chunk, scheduled gaplessly after what is queued.
    public func enqueue(_ pcm: Data) {
        guard running, pcm.count >= 2 else { return }
        let frames = pcm.count / MemoryLayout<Int16>.size
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return }
        buffer.frameLength = AVAudioFrameCount(frames)
        pcm.withUnsafeBytes { raw in
            guard let src = raw.baseAddress, let dst = buffer.int16ChannelData?[0] else { return }
            memcpy(dst, src, pcm.count)
        }
        let now = playerSampleNow ?? 0
        let anchor = nextPlaybackAnchor(
            hasUtterance: hasUtterance,
            nextSample: nextSample,
            utteranceStart: utteranceStart,
            now: now,
            frames: Int64(frames)
        )
        if anchor.utteranceStart != utteranceStart || !hasUtterance {
            // A new utterance.  The previous heard-time must not leak into it.
            frozenHeard = 0
        }
        hasUtterance = anchor.hasUtterance
        utteranceStart = anchor.utteranceStart
        nextSample = anchor.nextSample
        let at = anchor.scheduleAt.map {
            AVAudioTime(sampleTime: AVAudioFramePosition($0), atRate: Self.sampleRate)
        }
        pendingBuffers += 1
        let generation = scheduleGeneration
        // The completion runs on an engine queue, not the main actor.
        // assumeIsolated traps on the first buffer that finishes.
        player.scheduleBuffer(buffer, at: at, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.notePlayedThrough(generation: generation)
            }
        }
    }

    /// Stop everything now: drop the queue and silence the speaker.  The
    /// utterance anchor freezes where playback stopped, so `playedMs()`
    /// still reports what the caller heard before the interruption.
    public func stopPlayback() {
        scheduleGeneration += 1
        pendingBuffers = 0
        frozenHeard = playedSeconds
        player.stop()
        // Re-play to leave the node usable: a stopped player node needs
        // play() again before the next schedule.
        player.play()
        hasUtterance = false
        nextSample = 0
        utteranceStart = 0
    }

    public func stop() {
        scheduleGeneration += 1
        pendingBuffers = 0
        player.stop()
        engine.stop()
        running = false
        hasUtterance = false
        frozenHeard = 0
        nextSample = 0
        utteranceStart = 0
    }

    /// Player-timeline position in samples, or nil before the first render.
    private var playerSampleNow: AVAudioFramePosition? {
        guard let last = player.lastRenderTime,
              let playerTime = player.playerTime(forNodeTime: last)
        else { return nil }
        return playerTime.sampleTime
    }

    /// Seconds heard this utterance, clamped to what was scheduled.
    /// Once stopped, the frozen reading: the caller heard exactly that much
    /// before the cut, and the clock must not keep running.
    private var playedSeconds: Double {
        guard hasUtterance, let now = playerSampleNow else { return frozenHeard }
        return max(0, Double(now - utteranceStart) / Self.sampleRate)
    }

    /// A buffer finished rendering.  When the queue is empty the utterance
    /// is over: freeze what was heard and drop the anchor, or the next
    /// reply is scheduled on a timeline that has already passed.
    private func notePlayedThrough(generation: Int) {
        guard generation == scheduleGeneration else { return }
        let wasLive = hasUtterance
        let next = playbackAfterBufferFinished(
            PlaybackUtterance(
                hasUtterance: hasUtterance,
                nextSample: nextSample,
                utteranceStart: utteranceStart,
                pendingBuffers: pendingBuffers
            )
        )
        if wasLive, !next.hasUtterance {
            frozenHeard = playedSeconds
        }
        pendingBuffers = next.pendingBuffers
        hasUtterance = next.hasUtterance
        nextSample = next.nextSample
        utteranceStart = next.utteranceStart
    }
}
