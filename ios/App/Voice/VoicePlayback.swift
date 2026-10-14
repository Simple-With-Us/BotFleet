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
        let at: AVAudioTime?
        if !hasUtterance {
            // Nothing queued: play now and anchor the utterance clock.
            hasUtterance = true
            utteranceStart = playerSampleNow ?? 0
            nextSample = utteranceStart
            at = nil
        } else {
            at = AVAudioTime(sampleTime: nextSample, atRate: Self.sampleRate)
        }
        nextSample += AVAudioFramePosition(frames)
        player.scheduleBuffer(buffer, at: at, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.notePlayedThrough()
            }
        }
    }

    /// Stop everything now: drop the queue and silence the speaker.  The
    /// utterance anchor freezes where playback stopped, so `playedMs()`
    /// still reports what the caller heard before the interruption.
    public func stopPlayback() {
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

    /// A buffer finished rendering: nothing to do (the anchor math in
    /// playedSeconds already accounts for it).  Kept as the hook where a
    /// future level meter or end-of-utterance signal would live.
    private func notePlayedThrough() {}
}
