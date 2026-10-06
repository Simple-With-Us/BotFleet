import Foundation

/// Guards speech-turn completion against late delegate callbacks.
///
/// AVSpeechSynthesizer delivers didCancel for a stopped utterance
/// asynchronously, and that callback can land after the next speak() has
/// already installed a new finish continuation.  Without an identity
/// check it would complete - and clear - the new turn's continuation
/// prematurely, returning from speak() while audio is still playing.
public struct SpeechTurnGuard {
    public private(set) var activeUtteranceID: ObjectIdentifier?
    /// Identity of the speak() invocation that currently owns the synthesizer.
    /// stop() and the stop() at the start of a newer speak() both advance it,
    /// so a retry that was parked with no continuation cannot resume into the
    /// live turn or clear that turn's speaking state.
    public private(set) var invocation: UInt64 = 0

    public init() {}

    /// Mint the token for one speak() call.  Only that token may install a
    /// chunk continuation or clear isSpeaking when the call returns.
    public mutating func beginInvocation() -> UInt64 {
        invocation &+= 1
        return invocation
    }

    /// Drop the current invocation.  Late callbacks and a speak() that is
    /// between chunks no longer own the turn.  Also ends the utterance
    /// identity, matching stop().
    @discardableResult
    public mutating func supersedeInvocation() -> UInt64 {
        invocation &+= 1
        activeUtteranceID = nil
        return invocation
    }

    public func ownsInvocation(_ token: UInt64) -> Bool {
        token != 0 && token == invocation
    }

    /// Begin a turn for `utterance`.  Any previous turn is superseded;
    /// its late callbacks are rejected by `finish(utterance:)`.
    public mutating func begin(utterance: AnyObject) {
        activeUtteranceID = ObjectIdentifier(utterance)
    }

    /// End the current turn without a delegate callback (explicit stop).
    public mutating func stop() {
        activeUtteranceID = nil
    }

    /// A didFinish/didCancel callback.  Returns true only when it belongs
    /// to the current turn, which it then ends; callbacks for superseded
    /// or already-ended turns return false and change nothing.
    public mutating func finish(utterance: AnyObject) -> Bool {
        guard let id = activeUtteranceID, id == ObjectIdentifier(utterance) else { return false }
        activeUtteranceID = nil
        return true
    }
}
