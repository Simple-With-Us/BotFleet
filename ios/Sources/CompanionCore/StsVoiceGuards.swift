// Decisions the voice call has to get right even when the audio objects
// themselves cannot be built in `swift test`.
//
// Playback anchoring is the desktop's `Math.max(currentTime, nextStart)`
// in sample counts: a buffer scheduled in the past is partly skipped by
// AVAudioPlayerNode, so a late reply would come out silent.  The speak
// exit is the chained call's "stop waiting" rule, including the stall
// where a partial reply never clears and the bot is no longer busy.
// Try Again is not a reconnect: resetting inside `run` would also wipe
// the transcript and the attempt count on a socket blip.
import Foundation

/// Where the next PCM buffer belongs on the player timeline.
public struct PlaybackAnchor: Equatable, Sendable {
    public var hasUtterance: Bool
    /// Sample the following buffer will end on.
    public var nextSample: Int64
    public var utteranceStart: Int64
    /// Nil means play immediately.  A number is a player-timeline sample.
    public var scheduleAt: Int64?

    public init(hasUtterance: Bool, nextSample: Int64, utteranceStart: Int64, scheduleAt: Int64?) {
        self.hasUtterance = hasUtterance
        self.nextSample = nextSample
        self.utteranceStart = utteranceStart
        self.scheduleAt = scheduleAt
    }
}

/// Anchor one more buffer.
///
/// `now` is the player timeline.  A `nextSample` behind `now` is already
/// in the past, and scheduling there skips audio.  Falling behind starts
/// a new utterance at `now` so heard-time does not keep growing through
/// the silence between replies.
public func nextPlaybackAnchor(
    hasUtterance: Bool,
    nextSample: Int64,
    utteranceStart: Int64,
    now: Int64,
    frames: Int64
) -> PlaybackAnchor {
    let behind = !hasUtterance || nextSample < now
    let start = behind ? now : utteranceStart
    let cursor = behind ? now : nextSample
    return PlaybackAnchor(
        hasUtterance: true,
        nextSample: cursor + frames,
        utteranceStart: start,
        scheduleAt: behind ? nil : cursor
    )
}

/// The utterance clock plus how many buffers are still queued.
public struct PlaybackUtterance: Equatable, Sendable {
    public var hasUtterance: Bool
    public var nextSample: Int64
    public var utteranceStart: Int64
    public var pendingBuffers: Int

    public init(hasUtterance: Bool, nextSample: Int64, utteranceStart: Int64, pendingBuffers: Int) {
        self.hasUtterance = hasUtterance
        self.nextSample = nextSample
        self.utteranceStart = utteranceStart
        self.pendingBuffers = pendingBuffers
    }
}

/// One scheduled buffer finished rendering.
///
/// The queue draining is the end of the utterance.  Leaving the anchor up
/// is what made the next reply schedule on a clock that had already passed.
public func playbackAfterBufferFinished(_ state: PlaybackUtterance) -> PlaybackUtterance {
    var next = state
    next.pendingBuffers = max(0, state.pendingBuffers - 1)
    if next.pendingBuffers == 0 {
        next.hasUtterance = false
        next.nextSample = 0
        next.utteranceStart = 0
    }
    return next
}

/// One poll of the chained call while it is reading a reply aloud.
public struct ChainedSpeakTick: Equatable, Sendable {
    public var streamingEmpty: Bool
    public var spokenEmpty: Bool
    public var busy: Bool
    public var stableFor: Int

    public init(streamingEmpty: Bool, spokenEmpty: Bool, busy: Bool, stableFor: Int) {
        self.streamingEmpty = streamingEmpty
        self.spokenEmpty = spokenEmpty
        self.busy = busy
        self.stableFor = stableFor
    }
}

/// Whether the chained call should stop waiting for more reply text.
///
/// The first two exits are the paths that already worked: the stream
/// cleared and the bot is idle, or nothing ever arrived.  The third is
/// the stall.  A partial reply that stopped growing while the bot is not
/// busy used to match neither exit, and the microphone never reopened.
/// A bot that is still busy is left alone.  A long tool call is not a stall.
public func chainedSpeakShouldStop(_ tick: ChainedSpeakTick) -> Bool {
    if tick.streamingEmpty, !tick.busy, tick.stableFor >= 2 { return true }
    if tick.spokenEmpty, tick.stableFor >= 6 { return true }
    if !tick.busy, tick.stableFor >= 20 { return true }
    return false
}

/// What Try Again does to the call's memory.
public struct CallTryAgain: Equatable, Sendable {
    public var clearTranscript: Bool
    public var reconnectAttempt: Int

    public init(clearTranscript: Bool, reconnectAttempt: Int) {
        self.clearTranscript = clearTranscript
        self.reconnectAttempt = reconnectAttempt
    }
}

/// Try Again after a failure starts clean.  Any other entry, including
/// the first start, keeps the attempt count.  Socket reconnect does not
/// come through here.
public func callTryAgain(fromFailedPhase: Bool, reconnectAttempt: Int) -> CallTryAgain {
    guard fromFailedPhase else {
        return CallTryAgain(clearTranscript: false, reconnectAttempt: reconnectAttempt)
    }
    return CallTryAgain(clearTranscript: true, reconnectAttempt: 0)
}

/// Whether a call-screen note still needs to be said.
///
/// Reconnect runs the start path again and keeps the transcript.  The
/// note is once per call, so a second landing must not stack another
/// copy of the same sentence.  A different note still belongs on screen.
public func shouldEmitCallNote(_ note: String, alreadyShown texts: [String]) -> Bool {
    !texts.contains(note)
}
