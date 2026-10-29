// Which mode a voice call runs in, and why it could not run in the other one.
//
// A port of `decideCallMode` in src/lib/sts/call-session.ts.  The two clients
// must agree, because the mode is a property of the computer, not of the
// device: a phone that says "no provider" where the desktop would have said
// "chained" refuses a call that the desktop was always going to take.
import Foundation

/// How a call runs.  Chained is the shipped default and never regresses.
public enum CallMode: String, Hashable, Sendable {
    /// One duplex session with a speech-to-speech provider.
    case sts
    /// Capture, transcribe, synthesize: the separate-steps path.
    case chained
}

/// Why the call runs the way it does.  The chained fallbacks are deliberately
/// quiet -- nothing here is worth interrupting a person over -- and the reason
/// is for tests and diagnostics, not for narration.
public enum CallModeReason: String, Hashable, Sendable {
    case providerSelected
    case noKey
    case noBridge
    case noMicrophone
}

public struct CallModeDecision: Hashable, Sendable {
    public var mode: CallMode
    public var reason: CallModeReason
    public var provider: StsProviderKind?

    public init(mode: CallMode, reason: CallModeReason, provider: StsProviderKind? = nil) {
        self.mode = mode
        self.reason = reason
        self.provider = provider
    }
}

/// Choose the mode for a call.
///
/// STS needs the microphone.  Chained does not necessarily: Apple dictation
/// captures through the native speech helper and never opens an audio tap, so a
/// missing microphone disqualifies STS alone rather than the call.  Everything
/// else -- no key, no bridge, a computer too old to answer at all -- falls back
/// to the path that can still work, because a call that quietly degrades is
/// far better than a call that refuses.
///
/// This mirrors `decideCallMode`, including the order: the microphone is asked
/// first, so an absent mic is reported as such rather than as a missing key.
public func decideCallMode(
    keyStatus: StsStatus?,
    microphoneAvailable: Bool
) -> CallModeDecision {
    guard microphoneAvailable else {
        return CallModeDecision(mode: .chained, reason: .noMicrophone)
    }
    guard let keyStatus, keyStatus.isKnown else {
        // Nothing answered about keys at all -- a computer that predates the
        // routes, or an unreachable one.  "No provider" would be a lie about
        // what is known, so the chain reason stays distinct.
        return CallModeDecision(mode: .chained, reason: .noBridge)
    }
    guard let named = keyStatus.usableProvider, let provider = StsProviderKind(rawValue: named) else {
        // A provider name this build does not know is treated the way a missing
        // one is: take the path that does not need one.  The call still works,
        // which is the point of having a default.
        return CallModeDecision(mode: .chained, reason: .noKey)
    }
    return CallModeDecision(mode: .sts, reason: .providerSelected, provider: provider)
}