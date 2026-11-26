import Foundation
import Testing
@testable import CompanionCore

@Suite("Engine Replay Catalog")
struct EngineReplayCatalogTests {
    @Test("A matrix engine id resolves to the family that drives its executable")
    func matrixIdsResolveThroughTheExecutable() async throws {
        // The mapping is derived from the tree:  a matrix id names an
        // executable, and the family whose corpus drives that executable is
        // the family behind the id.  So the same id always resolves the same
        // way, whether the caller writes the matrix spelling or the family
        // spelling.
        #expect(EngineReplayCatalog.family(forEngineId: "antigravity") == .antigravity)
        #expect(EngineReplayCatalog.family(forEngineId: "claude") == .claude)
        #expect(EngineReplayCatalog.family(forEngineId: "codex") == .codex)
        #expect(EngineReplayCatalog.family(forEngineId: "grok-acp") == .grok)
        #expect(EngineReplayCatalog.family(forEngineId: "mcode") == .mcode)
        #expect(EngineReplayCatalog.family(forEngineId: "muse") == .muse)

        // The family spellings are accepted too, because the bundle's
        // `engines` list is free text.
        #expect(EngineReplayCatalog.family(forEngineId: "grok") == .grok)
    }

    @Test("An engine no replay family drives resolves to nothing rather than to a guess")
    func unmeasurableEnginesResolveToNothing() {
        // Three of the thirteen matrix engines speak HTTPS and launch no CLI,
        // and four more launch a CLI the harness does not script.  None of
        // them has a corpus behind it, so none of them may resolve to one:
        // a producer that certified them would be certifying an engine
        // nobody replayed.
        for engineId in ["grok-api", "minimax-api", "gemini-api", "cursor", "gemini-cli", "dsh", "opencode"] {
            #expect(EngineReplayCatalog.family(forEngineId: engineId) == nil, "\(engineId) must not resolve to a family")
        }
        // An id the tree does not know at all resolves to nothing too.
        #expect(EngineReplayCatalog.family(forEngineId: "no-such-engine") == nil)
    }

    @Test("Coverage names the resolvable six and gives a reason for the rest")
    func coverageNamesResolutionsAndReasons() throws {
        let resolvable = EngineReplayCatalog.coverage(for: ["antigravity", "claude", "codex", "grok-acp", "mcode", "muse"])
        #expect(resolvable.allSatisfy { $0.resolves })
        #expect(resolvable.allSatisfy { $0.reason == nil })
        #expect(resolvable.compactMap(\.family) == [.antigravity, .claude, .codex, .grok, .mcode, .muse])

        // HTTPS engines launch no CLI; unscripted CLIs have an executable
        // no family drives; an unknown id names nothing.  Three different
        // refusals, three different reasons.
        let api = EngineReplayCatalog.coverage(forEngineId: "grok-api")
        #expect(!api.resolves && api.executable == nil)
        #expect(api.reason?.contains("launches no CLI") == true)
        let unscripted = EngineReplayCatalog.coverage(forEngineId: "cursor")
        #expect(!unscripted.resolves && unscripted.executable == "cursor-agent")
        #expect(unscripted.reason?.contains("cursor-agent") == true)
        let unknown = EngineReplayCatalog.coverage(forEngineId: "no-such-engine")
        #expect(!unknown.resolves && unknown.executable == nil)
        #expect(unknown.reason?.contains("names this id") == true)

        // A thirteen-engine packet can never go green, and coverage says
        // so before any fixture runs.
        let all = EngineReplayCatalog.coverage(for: EngineMatrixID.allCases.map(\.rawValue))
        #expect(all.filter { $0.resolves }.count == 6)
        #expect(all.count == 13)
    }

    @Test("The catalog carries the numbered corpus and the standalone protocol fixtures")
    func corpusCarriesEveryFixture() {
        let numbered = EngineReplayHarness.allFixtures()
        #expect(numbered.count == 120)

        var ids: [String] = []
        for family in EngineReplayFamily.allCases {
            let corpus = EngineReplayCatalog.corpus(for: family)
            #expect(corpus.count >= 20)
            ids.append(contentsOf: corpus.map(\.id))
        }
        // The standalone fixtures add nine more on top of the numbered corpus,
        // and no fixture id repeats:  a duplicate id would make one
        // fixture's result overwrite another's in the report.
        #expect(ids.count == 129)
        #expect(Set(ids).count == ids.count)
    }

    @Test("The refusal fixture is expected to be refused, and it is")
    func refusalFixtureIsMeasuredAsRefusal() async throws {
        let fixture = EngineReplayHarness.grokMismatchedToolOwnerFixture()
        #expect(EngineReplayCatalog.expectsRefusal(fixture))

        let outcome = await EngineReplayCatalog.measure(fixture)
        #expect(outcome.passed)
        #expect(outcome.failureReason == nil)
    }

    @Test("A fixture whose recorded event order differs from the replay is measured as failed")
    func eventOrderMismatchFailsTheVerdict() async throws {
        // The Claude corpus's first turn records sessionStarted, textDelta,
        // textDelta, completed.  The replay always produces that order, so a
        // fixture that RECORDS a different order is a recording the replay
        // does not reproduce, and the catalog must say so instead of
        // accepting it.
        let original = try #require(EngineReplayHarness.claudeFixtures().first)
        #expect(original.id == "claude-turn-01")
        try #require(original.expectedEvents.count == 4)
        guard case .sessionStarted = original.expectedEvents[0], case .textDelta = original.expectedEvents[1] else {
            Issue.record("claude-turn-01 no longer records a session start followed by a text delta")
            return
        }

        // The control:  the unmodified fixture holds on all three
        // comparisons, so a failure below can only come from the event order.
        let control = await EngineReplayCatalog.measure(original)
        #expect(control.passed)
        #expect(control.eventsMatched)
        #expect(control.spawnSpecMatched)
        #expect(control.stdinGuardHeld)
        #expect(control.failureReason == nil)

        // The same fixture, rebuilt through the public initializer with the
        // first two recorded events swapped.  Nothing else changes, so the
        // spawn spec and the scripted wire frames still match what the driver
        // does, and only the ordered event kinds differ from the recording.
        var swappedEvents = original.expectedEvents
        swappedEvents.swapAt(0, 1)
        let mutated = EngineReplayFixture(
            id: original.id,
            family: original.family,
            title: original.title,
            input: original.input,
            expectedSpawnSpec: original.expectedSpawnSpec,
            steps: original.steps,
            expectedEvents: swappedEvents
        )
        #expect(mutated != original)
        guard case .textDelta = mutated.expectedEvents[0], case .sessionStarted = mutated.expectedEvents[1] else {
            Issue.record("the mutated fixture does not record a text delta before the session start")
            return
        }

        let outcome = await EngineReplayCatalog.measure(mutated)
        #expect(outcome.fixtureId == original.id)
        #expect(outcome.passed == false)
        #expect(outcome.eventsMatched == false)
        #expect(outcome.spawnSpecMatched == true)
        #expect(outcome.stdinGuardHeld == true)
        #expect(outcome.failureReason == "the event sequence did not match the recorded one")
    }

    @Test("Every fixture behind the Grok family holds")
    func grokFamilyHolds() async throws {
        // The Grok family carries the numbered corpus and seven standalone
        // protocol fixtures, so this covers both the ordinary turns and the
        // auth, model-selection and refusal regressions.
        let outcomes = await EngineReplayCatalog.measureFamily(.grok)
        #expect(outcomes.count == 27)
        for outcome in outcomes {
            #expect(outcome.passed, "\(outcome.fixtureId) failed: \(outcome.failureReason ?? "no reason given")")
        }
    }

    @Test("A refusal with a different error is named as such, not as no refusal at all")
    func refusalWithAnotherErrorHasItsOwnReason() {
        // The driver refused for the wrong reason.  That is a different bug
        // from a driver that never refused, and the reason has to say which
        // one it was, or the report hides the wrong-error refusal behind the
        // plain no-refusal case.
        #expect(
            EngineReplayCatalog.refusalFailureReason(
                refused: false,
                refusedWithAnotherError: true,
                launched: false,
                wroteStdin: false
            ) == "the driver refused the mismatched tool owner with a different error"
        )
        #expect(
            EngineReplayCatalog.refusalFailureReason(
                refused: false,
                refusedWithAnotherError: false,
                launched: false,
                wroteStdin: false
            ) == "the driver did not refuse the mismatched tool owner"
        )
    }

    @Test("A driver that launched or wrote to stdin is named ahead of the refusal reason")
    func launchAndStdinReasonsComeFirst() {
        // A driver that launched the engine failed closed only after it had
        // already run, so that is the reason a report carries, whatever else
        // the driver did.
        #expect(
            EngineReplayCatalog.refusalFailureReason(
                refused: false,
                refusedWithAnotherError: true,
                launched: true,
                wroteStdin: true
            ) == "the driver launched the engine instead of refusing the mismatched tool owner"
        )
        #expect(
            EngineReplayCatalog.refusalFailureReason(
                refused: false,
                refusedWithAnotherError: true,
                launched: false,
                wroteStdin: true
            ) == "the driver wrote to the engine's stdin before refusing the mismatched tool owner"
        )
    }
}
