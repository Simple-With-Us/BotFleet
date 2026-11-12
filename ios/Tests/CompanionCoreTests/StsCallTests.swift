// Transcript folding and spoken-approval rules for voice calls.
//
// These are ports of src/lib/sts/call-session.ts (`appendStsLine`,
// `spokenApprovalDecision`, `resolveStsApproval`).  Each test below pins the
// behavior the two clients must share: a "yes" that allows on one client and
// stalls on another is a permission system that disagrees with itself.
import Testing

@testable import CompanionCore

@Suite("Voice call transcript and approvals")
struct StsCallTests {

    // MARK: - appendStsLine

    @Test("final bot lines append")
    func finalBotLinesAppend() {
        let lines = appendStsLine([], line: StsTranscriptLine(text: "hello", from: .bot, final: true), key: "a")
        #expect(lines.count == 1)
        #expect(lines.first?.text == "hello")
        #expect(lines.first?.final == true)
    }

    @Test("provisional user lines replace rather than stack")
    func provisionalUserLinesReplace() {
        var lines: [StsLineView] = []
        lines = appendStsLine(lines, line: StsTranscriptLine(text: "hel", from: .user, final: false), key: "a")
        lines = appendStsLine(lines, line: StsTranscriptLine(text: "hello there", from: .user, final: false), key: "b")
        #expect(lines.count == 1)
        #expect(lines.first?.text == "hello there")
        #expect(lines.first?.final == false)
    }

    @Test("a final user line settles the open one")
    func finalUserLineSettles() {
        var lines = appendStsLine([], line: StsTranscriptLine(text: "hel", from: .user, final: false), key: "a")
        lines = appendStsLine(lines, line: StsTranscriptLine(text: "hello", from: .user, final: true), key: "b")
        #expect(lines.count == 1)
        #expect(lines.first?.text == "hello")
        #expect(lines.first?.final == true)
    }

    @Test("a blank line adds nothing")
    func blankLineAddsNothing() {
        let lines = appendStsLine([], line: StsTranscriptLine(text: "   ", from: .bot, final: true), key: "a")
        #expect(lines.isEmpty)
    }

    @Test("the bypass marker reads in the record")
    func bypassMarkerReads() {
        let line = StsLineView(key: "a", from: .bot, text: "done", final: true, engineBypassed: true)
        #expect(stsLineText(line) == "done (answered without the bot's engine)")
        let user = StsLineView(key: "b", from: .user, text: "go", final: true)
        #expect(stsLineText(user) == "You: go")
    }

    // MARK: - spokenApprovalDecision

    @Test("anchored yeses allow")
    func anchoredYesesAllow() {
        for word in ["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "go ahead", "do it",
                     "allow", "approve", "approved", "fine", "please do", "Yes, do it"] {
            #expect(spokenApprovalDecision(word) == .allow, "\(word) should allow")
        }
    }

    @Test("anchored noes deny")
    func anchoredNoesDeny() {
        for word in ["no", "nope", "don't", "do not", "stop", "deny", "denied",
                     "cancel", "never", "skip it", "No, stop"] {
            #expect(spokenApprovalDecision(word) == .deny, "\(word) should deny")
        }
    }

    @Test("merely containing the word is not consent")
    func containingIsNotConsent() {
        // The cases that matter: "I'm not sure" contains "sure" and must not
        // allow.  "not" must not deny (it is not in the pattern).
        #expect(spokenApprovalDecision("I'm not sure") == .unclear)
        #expect(spokenApprovalDecision("surely you jest") == .unclear)
        #expect(spokenApprovalDecision("not really") == .unclear)
        #expect(spokenApprovalDecision("") == .unclear)
        #expect(spokenApprovalDecision(nil) == .unclear)
    }

    // MARK: - resolveStsApproval

    private func waiting() -> [StsApprovalView] {
        [StsApprovalView(requestId: "r1", prompt: "Run the tests?", tool: "run_command")]
    }

    @Test("decide allow dispatches")
    func decideAllowDispatches() {
        let outcome = resolveStsApproval(action: .decide, requestId: "r1", answer: "yes", pending: waiting(), decided: [])
        #expect(outcome == .decided(requestId: "r1", decision: .allow))
    }

    @Test("decide unclear asks again and submits nothing")
    func decideUnclearAsksAgain() {
        let outcome = resolveStsApproval(action: .decide, requestId: "r1", answer: "maybe later", pending: waiting(), decided: [])
        guard case let .unclear(requestId, _) = outcome else {
            Issue.record("expected unclear, got \(outcome)")
            return
        }
        #expect(requestId == "r1")
    }

    @Test("deciding an already submitted request is stale")
    func decideSubmittedIsStale() {
        // The claim-before-dispatch latch: an id in `decided` is invisible,
        // so a re-render in the network gap cannot re-answer.
        let outcome = resolveStsApproval(action: .decide, requestId: "r1", answer: "yes", pending: waiting(), decided: ["r1"])
        guard case .stale = outcome else {
            Issue.record("expected stale, got \(outcome)")
            return
        }
    }

    @Test("a named request that is not waiting resolves to nothing")
    func namedAbsentResolvesToNothing() {
        // Falling back to the oldest would let the model answer a different
        // permission than the one it read out.
        let outcome = resolveStsApproval(action: .decide, requestId: "r9", answer: "yes", pending: waiting(), decided: [])
        guard case .stale = outcome else {
            Issue.record("expected stale, got \(outcome)")
            return
        }
    }

    @Test("an unnamed decide takes the oldest")
    func unnamedDecideTakesOldest() {
        let two = waiting() + [StsApprovalView(requestId: "r2", prompt: "Delete it?", tool: "rm")]
        let outcome = resolveStsApproval(action: .decide, requestId: nil, answer: "no", pending: two, decided: [])
        #expect(outcome == .decided(requestId: "r1", decision: .deny))
    }

    @Test("ask reads aloud without submitting")
    func askReadsAloud() {
        let outcome = resolveStsApproval(action: .ask, requestId: "r1", answer: nil, pending: waiting(), decided: [])
        guard case let .ask(requestId, text) = outcome else {
            Issue.record("expected ask, got \(outcome)")
            return
        }
        #expect(requestId == "r1")
        #expect(text.contains("Run the tests?"))
    }

    @Test("check reports without submitting")
    func checkReports() {
        let outcome = resolveStsApproval(action: .check, requestId: nil, answer: nil, pending: [], decided: [])
        guard case let .status(text) = outcome else {
            Issue.record("expected status, got \(outcome)")
            return
        }
        #expect(text.contains("Nothing is waiting"))
    }

    @Test("the denial message matches the desktop")
    func denialMessageMatchesDesktop() {
        #expect(stsVoiceDenialMessage == "Denied by the user, on a call.")
    }

    // MARK: - barge-in

    @Test("a barge-in truncates to what the caller actually heard")
    func bargeInTruncatesToHeard() {
        // The caller interrupts 250ms into a 400ms reply.  Telling the model
        // 400 would have it believe they heard the whole sentence; telling it
        // 0 would have it believe they heard none of one they were listening
        // to.  Its transcript has to land exactly where the room did.
        #expect(StsInterrupt.frames(itemId: "item_9", playedMs: 250) == [
            .truncate(itemId: "item_9", contentIndex: 0, audioEndMs: 250),
            .cancel,
        ])
    }

    @Test("a barge-in still cancels when no reply is in flight")
    func bargeInCancelsWithoutItem() {
        // Interrupting during silence, or just after a reply finished, still
        // means stop.  With no item there is nothing to truncate, and skipping
        // the cancel because of that would leave a response free to start at us
        // after the caller had already spoken over it.
        #expect(StsInterrupt.frames(itemId: "", playedMs: 900) == [.cancel])
    }

    @Test("the cancel is always last")
    func cancelIsAlwaysLast() {
        for played in [0, 120, 4000] {
            let frames = StsInterrupt.frames(itemId: "item_1", playedMs: played)
            #expect(frames.last == .cancel)
        }
    }

    @Test("a barge-in never claims more audio than was heard")
    func bargeInFloorsNegativePlayback() {
        // The playback clock is read across an actor hop, so it can come back
        // nonsensical.  A truncate claiming audio the caller did not hear
        // corrupts the model's transcript more durably than one that
        // under-claims, so it is floored.
        #expect(StsInterrupt.frames(itemId: "item_2", playedMs: -40) == [
            .truncate(itemId: "item_2", contentIndex: 0, audioEndMs: 0),
            .cancel,
        ])
    }
}
