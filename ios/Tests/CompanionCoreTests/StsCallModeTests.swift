// Call mode selection, ported from `decideCallMode` in
// src/lib/sts/call-session.ts.
//
// Each test below pins behaviour the two clients must share.  A phone that
// refuses a call the desktop would have taken is a bug in the rule, not a
// difference of opinion between devices: the mode is a property of the
// computer, not of the phone.
import Testing

@testable import CompanionCore

@Suite("Voice call mode")
struct StsCallModeTests {

    // MARK: - Chained is the default and never regresses

    @Test("an install that has never set a key stays on the chained path")
    func noKeyStaysChained() {
        let decision = decideCallMode(keyStatus: StsStatus(xai: false, gemini: false), microphoneAvailable: true)
        #expect(decision.mode == .chained)
        #expect(decision.reason == .noKey)
    }

    @Test("a computer that cannot answer is not told it has no key")
    func unknownIsNotNoKey() {
        // "I do not know" and "no key" send you to different places.  Drawing
        // an unknown as "no" would tell someone to add a key they already have.
        let decision = decideCallMode(keyStatus: StsStatus(), microphoneAvailable: true)
        #expect(decision.mode == .chained)
        #expect(decision.reason == .noBridge)
    }

    @Test("a missing microphone disqualifies STS alone")
    func missingMicrophoneStaysChained() {
        // Apple dictation captures through the native speech helper and never
        // opens a mic tap, so the chained path still works without one.
        let decision = decideCallMode(
            keyStatus: StsStatus(xai: true, gemini: true, provider: "xai"),
            microphoneAvailable: false
        )
        #expect(decision.mode == .chained)
        #expect(decision.reason == .noMicrophone)
    }

    @Test("the microphone is asked before the keys")
    func microphoneIsCheckedFirst() {
        // Both are wrong. Reporting "no key" would send someone to add a key
        // that is not the thing stopping the call.
        let decision = decideCallMode(keyStatus: StsStatus(xai: false, gemini: false), microphoneAvailable: false)
        #expect(decision.reason == .noMicrophone)
    }

    @Test("a provider this build does not know falls back rather than failing")
    func unknownProviderFallsBack() {
        // The computer may be newer than the phone.  The call still works; it
        // just does not run on a provider this build can name.
        let decision = decideCallMode(
            keyStatus: StsStatus(xai: false, gemini: false, provider: "some-future-provider"),
            microphoneAvailable: true
        )
        #expect(decision.mode == .chained)
        #expect(decision.reason == .noKey)
    }

    // MARK: - STS

    @Test("a configured provider runs the duplex session")
    func configuredProviderRunsSTS() {
        let decision = decideCallMode(
            keyStatus: StsStatus(xai: true, gemini: false, provider: "xai"),
            microphoneAvailable: true
        )
        #expect(decision.mode == .sts)
        #expect(decision.reason == .providerSelected)
        #expect(decision.provider == .xai)
    }

    @Test("the computer's own preference wins over the fallback order")
    func computerPreferenceWins() {
        // Both are configured and the computer said Gemini.  The phone takes
        // the computer's word for it rather than re-deciding, so the two can
        // never send a call to different providers.
        let decision = decideCallMode(
            keyStatus: StsStatus(xai: true, gemini: true, provider: "gemini"),
            microphoneAvailable: true
        )
        #expect(decision.mode == .sts)
        #expect(decision.provider == .gemini)
    }

    @Test("a stored preference naming an unconfigured provider falls back to the one that is")
    func stalePreferenceFallsBack() {
        let decision = decideCallMode(
            keyStatus: StsStatus(xai: true, gemini: false, provider: "gemini"),
            microphoneAvailable: true
        )
        #expect(decision.mode == .sts)
        #expect(decision.provider == .xai)
    }
}