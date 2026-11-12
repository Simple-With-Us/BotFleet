// The voice-call decisions that do not need a microphone: playback is not
// scheduled in the past, a stalled chained reply gives the floor back, and
// Try Again does not pretend to be a reconnect.
import Testing

@testable import CompanionCore

@Suite("Voice call playback and retry guards")
struct StsVoiceGuardsTests {

    @Test("the first buffer plays now")
    func firstBufferPlaysNow() {
        let anchor = nextPlaybackAnchor(
            hasUtterance: false, nextSample: 0, utteranceStart: 0, now: 1_000, frames: 480
        )
        #expect(anchor.scheduleAt == nil)
        #expect(anchor.utteranceStart == 1_000)
        #expect(anchor.nextSample == 1_480)
        #expect(anchor.hasUtterance)
    }

    @Test("a buffer still ahead of the playhead stays gapless")
    func aheadStaysGapless() {
        let anchor = nextPlaybackAnchor(
            hasUtterance: true, nextSample: 5_000, utteranceStart: 1_000, now: 2_000, frames: 480
        )
        #expect(anchor.scheduleAt == 5_000)
        #expect(anchor.utteranceStart == 1_000)
        #expect(anchor.nextSample == 5_480)
    }

    @Test("a sample time in the past starts a new utterance instead of skipping")
    func pastSampleRestarts() {
        let anchor = nextPlaybackAnchor(
            hasUtterance: true, nextSample: 5_000, utteranceStart: 1_000, now: 80_000, frames: 480
        )
        #expect(anchor.scheduleAt == nil)
        #expect(anchor.utteranceStart == 80_000)
        #expect(anchor.nextSample == 80_480)
    }

    @Test("the utterance clock resets only when the queue drains")
    func queueDrainResetsClock() {
        let mid = playbackAfterBufferFinished(
            PlaybackUtterance(hasUtterance: true, nextSample: 5_000, utteranceStart: 1_000, pendingBuffers: 2)
        )
        #expect(mid.pendingBuffers == 1)
        #expect(mid.hasUtterance)
        #expect(mid.nextSample == 5_000)

        let done = playbackAfterBufferFinished(mid)
        #expect(done.pendingBuffers == 0)
        #expect(!done.hasUtterance)
        #expect(done.nextSample == 0)
        #expect(done.utteranceStart == 0)
    }

    @Test("a settled partial reply stops waiting once the bot is idle")
    func stalledReplyStops() {
        let spinning = ChainedSpeakTick(streamingEmpty: false, spokenEmpty: false, busy: false, stableFor: 19)
        #expect(!chainedSpeakShouldStop(spinning))
        let stalled = ChainedSpeakTick(streamingEmpty: false, spokenEmpty: false, busy: false, stableFor: 20)
        #expect(chainedSpeakShouldStop(stalled))
    }

    @Test("a busy bot is not cut off for being quiet between tokens")
    func busyBotKeepsGoing() {
        let thinking = ChainedSpeakTick(streamingEmpty: false, spokenEmpty: false, busy: true, stableFor: 40)
        #expect(!chainedSpeakShouldStop(thinking))
    }

    @Test("an empty idle stream still ends on the short timer")
    func emptyIdleStreamEnds() {
        let waiting = ChainedSpeakTick(streamingEmpty: true, spokenEmpty: true, busy: false, stableFor: 2)
        #expect(chainedSpeakShouldStop(waiting))
    }

    @Test("Try Again clears a failed call and leaves every other entry alone")
    func tryAgainResetsOnlyAFailure() {
        let failed = callTryAgain(fromFailedPhase: true, reconnectAttempt: 3)
        #expect(failed.clearTranscript)
        #expect(failed.reconnectAttempt == 0)
        let reconnect = callTryAgain(fromFailedPhase: false, reconnectAttempt: 3)
        #expect(!reconnect.clearTranscript)
        #expect(reconnect.reconnectAttempt == 3)
    }

    @Test("a call note is said once, and a different note still gets said")
    func callNoteIsSaidOnce() {
        let chained = "chained fallback"
        let engine = "no engine"
        #expect(shouldEmitCallNote(chained, alreadyShown: []))
        #expect(!shouldEmitCallNote(chained, alreadyShown: [chained]))
        #expect(shouldEmitCallNote(chained, alreadyShown: [engine]))
        #expect(!shouldEmitCallNote(chained, alreadyShown: [engine, chained]))
    }
}
