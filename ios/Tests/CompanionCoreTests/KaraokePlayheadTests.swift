import Foundation
import XCTest
@testable import CompanionCore

/// Timing and frames: the half of src/lib/karaoke-highlight.ts that does not
/// paint, and the hosted voice's clip clock (src/lib/tts/karaoke-feed.ts).
final class KaraokePlayheadTests: XCTestCase {
    private let words = KaraokeAlign.tokenize("one three seven nine")

    private func timeline(_ playhead: KaraokePlayhead) -> [Double] { playhead.timeline }

    // MARK: - Timeline mode

    func testTheCurrentWordRollsInOneGraphemeAtATime() {
        var playhead = KaraokePlayhead(words: words, reducedMotion: false)
        // "three" is 5 letters over 500 ms.
        playhead.setTimeline([0, 100, 100, 600, 600, 900, 900, 1200])
        XCTAssertEqual(playhead.frame(at: -1), .none)
        XCTAssertEqual(playhead.frame(at: 100).current, 1)
        XCTAssertEqual(playhead.frame(at: 100).lit, 1, "the first letter lights as the word starts")
        XCTAssertEqual(playhead.frame(at: 300).lit, 2)
        XCTAssertEqual(playhead.frame(at: 301).lit, 3)
        XCTAssertEqual(playhead.frame(at: 599).lit, 5)
        XCTAssertEqual(playhead.frame(at: 650).current, 2)
    }

    func testFinishedWordsTrailAndFade() {
        var playhead = KaraokePlayhead(words: words, reducedMotion: false)
        playhead.setTimeline([0, 100, 100, 600, 600, 900, 900, 1200])
        // 10 ms after "three" ended, "seven" is current and "three" trails strongly.
        let early = playhead.frame(at: 610)
        XCTAssertEqual(early.current, 2)
        XCTAssertEqual(early.trail, [KaraokeTrailWord(index: 1, level: 0)])
        XCTAssertEqual(playhead.frame(at: 600 + 100).trail, [KaraokeTrailWord(index: 1, level: 1)])
        XCTAssertEqual(playhead.frame(at: 600 + 200).trail, [KaraokeTrailWord(index: 1, level: 2)])
        XCTAssertEqual(playhead.frame(at: 600 + 220).trail, [], "gone after the trail time")
        // After the last word, it trails too, then everything is done.
        let after = playhead.frame(at: 1250)
        XCTAssertEqual(after.current, -1)
        XCTAssertEqual(after.trail.map(\.index), [3])
        XCTAssertFalse(playhead.finished(at: 1250))
        XCTAssertTrue(playhead.finished(at: 1420))
        XCTAssertTrue(playhead.idle(at: 1420))
    }

    func testReduceMotionStepsWholeWordsWithNoTrail() {
        var playhead = KaraokePlayhead(words: words, reducedMotion: true)
        playhead.setTimeline([0, 100, 100, 600, 600, 650, 650, 1200])
        let frame = playhead.frame(at: 120)
        XCTAssertEqual(frame.current, 1)
        XCTAssertEqual(frame.lit, 5, "the whole word at once")
        XCTAssertEqual(playhead.frame(at: 610).trail, [])
        // A word swept past in under 80 ms is not shown at all.
        XCTAssertEqual(playhead.frame(at: 620).current, -1)
    }

    func testAShortTimelineLeavesTheRestUnspoken() {
        var playhead = KaraokePlayhead(words: words, reducedMotion: false)
        playhead.setTimeline([0, 100])
        XCTAssertEqual(playhead.frame(at: 50).current, 0)
        XCTAssertEqual(playhead.frame(at: 5_000).current, -1)
        XCTAssertFalse(playhead.finished(at: 5_000))
    }

    func testGraphemeBoundariesAreUTF16() {
        XCTAssertEqual(KaraokePlayhead.graphemeBoundaries("ab"), [0, 1, 2])
        XCTAssertEqual(KaraokePlayhead.graphemeBoundaries("a🚀"), [0, 1, 3])
        XCTAssertEqual(KaraokePlayhead.graphemeBoundaries("é"), [0, 1])
        XCTAssertEqual(KaraokePlayhead.graphemeBoundaries(""), [0])
    }

    // MARK: - Live mode (Personal Voice)

    func testLiveCuesSweepSkippedWordsQuickly() {
        var playhead = KaraokePlayhead(words: words, reducedMotion: false)
        playhead.cue(0, durationMs: 200, atMs: 1_000, nowMs: 1_000)
        XCTAssertTrue(playhead.isLive)
        XCTAssertEqual(Array(timeline(playhead)[0..<2]), [1_000, 1_200])
        // The voice skipped "three" and "seven": swept in 2 x 40 ms before "nine".
        playhead.cue(3, durationMs: 300, atMs: 1_100, nowMs: 1_100)
        XCTAssertEqual(timeline(playhead), [1_000, 1_100, 1_100, 1_140, 1_140, 1_180, 1_180, 1_480])
        XCTAssertFalse(playhead.idle(at: 1_400))
        XCTAssertTrue(playhead.idle(at: 1_480 + 220))
        XCTAssertFalse(playhead.finished(at: 10_000), "the voice decides when a live read ends")
    }

    func testASecondCueForTheSameWordExtendsIt() {
        var playhead = KaraokePlayhead(words: words, reducedMotion: false)
        playhead.cue(1, durationMs: 100, atMs: 0, nowMs: 0)
        playhead.cue(1, durationMs: 300, atMs: 50, nowMs: 50)
        XCTAssertEqual(Array(timeline(playhead)[2..<4]), [40, 350])
    }

    func testAWordNeverStartsBeforeThePreviousOneOrInTheFuture() {
        var playhead = KaraokePlayhead(words: words, reducedMotion: false)
        playhead.cue(0, durationMs: 100, atMs: 500, nowMs: 500)
        playhead.cue(1, durationMs: 500, atMs: 400, nowMs: 600)
        XCTAssertEqual(timeline(playhead)[2], 500, "not before the previous word")
        XCTAssertEqual(timeline(playhead)[3], 1_000)
        playhead.cue(2, durationMs: 100, atMs: 9_000, nowMs: 700)
        XCTAssertEqual(timeline(playhead)[4], 700, "a time in the future is now")
        XCTAssertEqual(timeline(playhead)[3], 700, "the previous word is cut short")
    }

    func testACueForAnEarlierWordRestartsFromThere() {
        var playhead = KaraokePlayhead(words: words, reducedMotion: false)
        playhead.cue(2, durationMs: 100, atMs: 0, nowMs: 0)
        playhead.cue(1, durationMs: 100, atMs: 500, nowMs: 500)
        let t = timeline(playhead)
        XCTAssertEqual(Array(t[2..<4]), [500, 600])
        XCTAssertEqual(t[4], .infinity)
        XCTAssertEqual(t[6], .infinity)
        XCTAssertEqual(playhead.frame(at: 550).current, 1)
    }

    func testCuesOutOfRangeAreIgnored() {
        var playhead = KaraokePlayhead(words: words, reducedMotion: false)
        playhead.cue(-1, nowMs: 0)
        playhead.cue(9, nowMs: 0)
        XCTAssertFalse(playhead.isLive)
        XCTAssertEqual(playhead.frame(at: 0), .none)
    }

    // MARK: - Clip clock (hosted voice)

    private func clips() -> [KaraokeClip] {
        [
            KaraokeClip(spokenStart: 0, spokenEnd: 10, startMs: 0, durationMs: 1_000),
            KaraokeClip(spokenStart: 11, spokenEnd: 20, startMs: 1_000, durationMs: 1_000),
            KaraokeClip(spokenStart: 21, spokenEnd: 30, startMs: 2_000, durationMs: 1_000),
        ]
    }

    func testARealClipLengthShiftsTheWindowsAfterIt() {
        var clock = KaraokeClipClock(clips: clips())
        XCTAssertTrue(clock.attach(0, durationSeconds: 1.5))
        XCTAssertEqual(clock.clips.map(\.startMs), [0, 1_500, 2_500])
        XCTAssertFalse(clock.measure(0, seconds: 1.5), "the same length again changes nothing")
        XCTAssertFalse(clock.measure(1, seconds: .nan))
        XCTAssertFalse(clock.measure(7, seconds: 1))
    }

    func testTheClockFollowsThePlayerHoldsBetweenClipsAndNeverGoesBack() {
        var clock = KaraokeClipClock(clips: clips())
        XCTAssertEqual(clock.time(currentTime: nil), 0)
        clock.attach(0, durationSeconds: 1)
        XCTAssertEqual(clock.time(currentTime: 0.25), 250)
        XCTAssertEqual(clock.time(currentTime: 0.1), 250, "never backwards")
        XCTAssertEqual(clock.time(currentTime: 3), 1_000, "clamped to a measured clip")
        clock.detach(0, finished: true)
        XCTAssertEqual(clock.time(currentTime: 0.5), 1_000, "held between clips")
        clock.attach(1, durationSeconds: 2)
        XCTAssertEqual(clock.time(currentTime: 0.5), 1_500)
        XCTAssertEqual(clock.clips[2].startMs, 3_000)
    }

    func testAStoppedClipDoesNotJumpToItsEnd() {
        var clock = KaraokeClipClock(clips: clips())
        clock.attach(0, durationSeconds: 1)
        _ = clock.time(currentTime: 0.2)
        clock.detach(0, finished: false)
        XCTAssertEqual(clock.time(currentTime: nil), 200)
        clock.detach(2, finished: true)
        XCTAssertEqual(clock.time(currentTime: nil), 200, "only the attached clip detaches")
    }
}
