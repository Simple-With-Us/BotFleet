import Foundation

/// The result of replaying one fixture through its native engine driver.
///
/// The harness's own `passed` flag is a conjunction of three comparisons, so
/// a report that carried only the boolean would not say WHICH comparison
/// failed.  This type carries the three separately, because a fixture that
/// failed is worth more with a reason than with a `false`.
public struct EngineReplayOutcome: Equatable, Sendable, Codable {
    public let fixtureId: String
    public let title: String
    public let family: EngineReplayFamily
    /// The harness's own verdict.
    public let passed: Bool
    /// Whether the spawn spec the driver used matched the recorded one.
    public let spawnSpecMatched: Bool
    /// Whether the event sequence the driver produced matched the recorded one.
    public let eventsMatched: Bool
    /// Whether the stdin guard held.  It only applies to one fixture;  for
    /// every other fixture this is true and carries no meaning.
    public let stdinGuardHeld: Bool
    /// Why the fixture failed, in words.  Nil when it passed.
    public let failureReason: String?
    /// The executable the driver launched.
    public let executable: String?

    public init(
        fixtureId: String,
        title: String,
        family: EngineReplayFamily,
        passed: Bool,
        spawnSpecMatched: Bool,
        eventsMatched: Bool,
        stdinGuardHeld: Bool,
        failureReason: String?,
        executable: String?
    ) {
        self.fixtureId = fixtureId
        self.title = title
        self.family = family
        self.passed = passed
        self.spawnSpecMatched = spawnSpecMatched
        self.eventsMatched = eventsMatched
        self.stdinGuardHeld = stdinGuardHeld
        self.failureReason = failureReason
        self.executable = executable
    }
}

/// The replay corpus, and the mapping from the engine ids a bundle request may
/// name onto the families that corpus covers.
///
/// **The mapping is derived, not written down.**  The thirteen engines in the
/// runtime matrix are NOT thirteen replay families:  three of them
/// (`grok-api`, `minimax-api`, `gemini-api`) speak HTTPS to a provider and
/// launch no CLI at all, and four more (`cursor`, `gemini-cli`, `dsh`,
/// `opencode`) launch a CLI the harness does not script.  So an engine id is
/// resolved by the executable its driver would launch — a fact the matrix
/// registry already states — and the family that drives that executable is
/// found in the corpus.  An engine whose executable no family drives resolves
/// to nothing, and a caller that certifies it would be certifying an engine
/// nobody replayed.
///
/// The family names the harness itself uses are accepted too, because the
/// bundle's `engines` list is free text and `grok` is a spelling of the same
/// engine the matrix calls `grok-acp`.
public enum EngineReplayCatalog {
    /// The fixtures that make up one engine family's replay corpus:  the
    /// twenty numbered turns, plus the standalone protocol fixtures that
    /// cover the regressions the numbered corpus does not.
    public static func corpus(for family: EngineReplayFamily) -> [EngineReplayFixture] {
        EngineReplayHarness.fixtures(for: family) + standaloneFixtures(for: family)
    }

    /// The executable one family's corpus drives.
    ///
    /// It is read out of the family's own fixtures, because the spawn spec
    /// they expect names the executable and that is the fact the mapping
    /// needs.
    public static func executable(for family: EngineReplayFamily) -> String? {
        corpus(for: family).first?.expectedSpawnSpec.executable
    }

    /// The family an engine id names, or nil when the corpus covers none.
    ///
    /// A matrix id is resolved through the matrix registry's own descriptor,
    /// so the executable comes from the tree rather than from a table written
    /// here.  A family name resolves to itself.
    public static func family(forEngineId engineId: String) -> EngineReplayFamily? {
        guard let executable = executable(forEngineId: engineId) else { return nil }
        let matches = EngineReplayFamily.allCases.filter { self.executable(for: $0) == executable }
        // Two families driving one executable would make the mapping
        // ambiguous, and an ambiguous mapping certifies nothing.
        return matches.count == 1 ? matches[0] : nil
    }

    /// The executable an engine id's driver would launch, or nil when the id
    /// names no engine the registry knows.
    private static func executable(forEngineId engineId: String) -> String? {
        if let family = EngineReplayFamily(rawValue: engineId) {
            return executable(for: family)
        }
        guard let matrixId = EngineMatrixID(rawValue: engineId) else { return nil }
        return EngineMatrixRegistry.descriptor(for: matrixId).executable
    }

    /// Whether the fixture is expected to be REFUSED rather than replayed.
    ///
    /// The ACP driver must reject tool preparation owned by another bot
    /// BEFORE it launches anything, so that fixture's expectation is an
    /// error rather than a turn.  A caller that treated the refusal as a
    /// failure would be measuring the wrong thing.
    public static func expectsRefusal(_ fixture: EngineReplayFixture) -> Bool {
        fixture.id == "grok-rejects-mismatched-prepared-tool-owner"
    }

    /// The ACP harness profile that drives a family, or nil for the families
    /// that are not ACP.
    ///
    /// It is read out of the same `AcpHarnessKind` the corpus is built from,
    /// so the refusal check drives the runner the corpus would have driven.
    public static func acpHarnessKind(for family: EngineReplayFamily) -> AcpHarnessKind? {
        switch family {
        case .grok: return .grok
        case .mcode: return .mcode
        case .muse: return .muse
        case .antigravity, .claude, .codex: return nil
        }
    }

    /// Replay one fixture and record what held.
    ///
    /// The three comparisons the harness makes are recomputed here, so a
    /// report says which one failed rather than only that something did.
    public static func measure(_ fixture: EngineReplayFixture) async -> EngineReplayOutcome {
        if expectsRefusal(fixture) {
            return await measureRefusal(fixture)
        }
        do {
            let result = try await EngineReplayHarness.runFixture(fixture)
            let specMatches = result.recordedSpawnSpec == fixture.expectedSpawnSpec
            let eventsMatch = result.actualEvents == fixture.expectedEvents
            // The one stdin guard the harness applies:  the Antigravity
            // fixture with the oversized prompt must have gone over stdin
            // rather than argv.
            let stdinGuardHeld = !(fixture.family == .antigravity && fixture.id == "agy-turn-16")
                || result.recordedClientStdinLines.contains(where: {
                    $0.utf8.count > AntigravityStreamRunner.maxArgvPromptUTF8Bytes
                })
            let passed = specMatches && eventsMatch && stdinGuardHeld
            var reasons: [String] = []
            if !specMatches { reasons.append("the spawn spec did not match the recorded one") }
            if !eventsMatch { reasons.append("the event sequence did not match the recorded one") }
            if !stdinGuardHeld { reasons.append("the oversized prompt did not travel over stdin") }
            return EngineReplayOutcome(
                fixtureId: fixture.id,
                title: fixture.title,
                family: fixture.family,
                passed: passed,
                spawnSpecMatched: specMatches,
                eventsMatched: eventsMatch,
                stdinGuardHeld: stdinGuardHeld,
                failureReason: reasons.isEmpty ? nil : reasons.joined(separator: "; "),
                executable: result.recordedSpawnSpec?.executable
            )
        } catch {
            // A fixture that throws did not replay, and the reason is the
            // error.
            return EngineReplayOutcome(
                fixtureId: fixture.id,
                title: fixture.title,
                family: fixture.family,
                passed: false,
                spawnSpecMatched: false,
                eventsMatched: false,
                stdinGuardHeld: false,
                failureReason: "the replay threw: \(error.localizedDescription)",
                executable: nil
            )
        }
    }

    /// Measure the fixture that is expected to be refused rather than
    /// replayed.
    ///
    /// Two things are checked, and both matter:  that the turn was refused
    /// with the identity error rather than by any other failure, and that
    /// nothing was launched.  A driver that refused AND launched would have
    /// failed closed only after running.
    private static func measureRefusal(_ fixture: EngineReplayFixture) async -> EngineReplayOutcome {
        guard let kind = acpHarnessKind(for: fixture.family) else {
            return EngineReplayOutcome(
                fixtureId: fixture.id,
                title: fixture.title,
                family: fixture.family,
                passed: false,
                spawnSpecMatched: false,
                eventsMatched: false,
                stdinGuardHeld: false,
                failureReason: "the family is not an ACP family, so the refusal could not be driven",
                executable: nil
            )
        }
        let launcher = ScriptedProcessLauncher(fixture: fixture)
        let runner = AcpProcessRunner(harnessKind: kind, launcher: launcher)
        var refused = false
        // A refusal with a different error is not the same as no refusal at
        // all, and the two are told apart here:  the driver that refused for
        // the wrong reason failed in a way the caller has to see, while the
        // driver that never refused did not guard the identity at all.
        var refusedWithAnotherError = false
        do {
            _ = try await runner.sendTurn(input: fixture.input)
        } catch let error as NativeTurnToolError {
            if error == .wrongIdentity {
                refused = true
            } else {
                refusedWithAnotherError = true
            }
        } catch {
            refusedWithAnotherError = true
        }
        let launched = await launcher.getCapturedSpawnSpec() != nil
        let wroteStdin = await launcher.getCapturedStdinLines().isEmpty == false
        let passed = refused && !launched && !wroteStdin
        let reason = passed ? nil : refusalFailureReason(
            refused: refused,
            refusedWithAnotherError: refusedWithAnotherError,
            launched: launched,
            wroteStdin: wroteStdin
        )
        return EngineReplayOutcome(
            fixtureId: fixture.id,
            title: fixture.title,
            family: fixture.family,
            passed: passed,
            spawnSpecMatched: !launched,
            eventsMatched: true,
            stdinGuardHeld: true,
            failureReason: reason,
            executable: nil
        )
    }

    /// Why a refusal measurement failed, in words.
    ///
    /// The three failures are told apart, because they are different bugs in
    /// the driver and a report that names only one of them hides the rest:
    /// a driver that launched the engine, a driver that wrote to the engine's
    /// stdin, and a driver that refused for a reason other than the identity
    /// error.  The last one is not the same as a driver that never refused,
    /// and the two carry different reasons.
    public static func refusalFailureReason(
        refused: Bool,
        refusedWithAnotherError: Bool,
        launched: Bool,
        wroteStdin: Bool
    ) -> String {
        if launched {
            return "the driver launched the engine instead of refusing the mismatched tool owner"
        }
        if wroteStdin {
            return "the driver wrote to the engine's stdin before refusing the mismatched tool owner"
        }
        if refusedWithAnotherError {
            return "the driver refused the mismatched tool owner with a different error"
        }
        if refused {
            return "the driver refused the mismatched tool owner and the fixture still failed"
        }
        return "the driver did not refuse the mismatched tool owner"
    }

    /// Measure every fixture behind one family.
    ///
    /// The numbered corpus comes first and the standalone protocol fixtures
    /// follow it, so a report reads in the order the corpus was built.
    public static func measureFamily(_ family: EngineReplayFamily) async -> [EngineReplayOutcome] {
        var outcomes: [EngineReplayOutcome] = []
        for fixture in EngineReplayHarness.fixtures(for: family) {
            outcomes.append(await measure(fixture))
        }
        for fixture in standaloneFixtures(for: family) {
            outcomes.append(await measure(fixture))
        }
        return outcomes
    }

    /// The standalone protocol fixtures that belong to one family.
    ///
    /// They are not in `allFixtures()`, because each one covers a regression
    /// the numbered corpus does not:  the auth-priority and model-selection
    /// rules, the mismatched tool owner, and the early tool before the
    /// turn-start acknowledgement.
    public static func standaloneFixtures(for family: EngineReplayFamily) -> [EngineReplayFixture] {
        switch family {
        case .antigravity, .claude, .muse:
            return []
        case .codex:
            return [EngineReplayHarness.codexEarlyToolBeforeTurnStartErrorFixture()]
        case .grok:
            return [
                EngineReplayHarness.grokAuthPriorityFixture(),
                EngineReplayHarness.grokAuthMethodFallbackFixture(),
                EngineReplayHarness.grokUnsupportedAuthMethodFixture(),
                EngineReplayHarness.grokAlreadySelectedModelFixture(),
                EngineReplayHarness.grokSelectsAdvertisedModelFixture(),
                EngineReplayHarness.grokRejectsUnadvertisedModelFixture(),
                EngineReplayHarness.grokMismatchedToolOwnerFixture(),
            ]
        case .mcode:
            return [EngineReplayHarness.mcodeIgnoresGrokAuthMethodsFixture()]
        }
    }
}
