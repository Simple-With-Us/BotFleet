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

    public init() {}

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
